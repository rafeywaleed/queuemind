// Autopilot: the clinic lives on its own while the clock runs. Patients arrive (some late, a few
// never), consults end, doctors call the next patient, walk-ins drop in. Plain code — no model
// calls — and deterministic per visit (seeded by its id), so a replay behaves the same way.
// Runs at most once per window across all server instances (claimTick is atomic).
import { computeQueue } from "../queue/engine";
import * as repo from "../db/repo";
import { claimTick, releaseTick, simNow } from "./clock";
import { checkIn, doctorAvailable, finishConsult, markNoShow, startConsult } from "./actions";
import { visitRef } from "./format";

const TICK_GAP_MS = 2_500;
const ARRIVAL_WINDOW_MIN = 2;
const WALK_IN_EVERY_MIN = Number(process.env.SIM_WALKIN_MINUTES ?? 9);
const MIN = 60_000;

const WALK_IN_POOL = [
  { name: "Sadia Noor", complaint: "Sore throat and cough for three days", lang: "ur", child: false },
  { name: "Arjun Mehta", complaint: "Lower back pain after lifting boxes", lang: "en", child: false },
  { name: "Hassan Raza (child)", complaint: "My son has a fever and runny nose", lang: "ur", child: true },
  { name: "Priya Nair", complaint: "Needs a blood pressure check and repeat prescription", lang: "en", child: false },
  { name: "Bilal Siddiqui", complaint: "Rash on both arms since yesterday", lang: "ur", child: false },
  { name: "Ananya Rao (child)", complaint: "My daughter has an ear ache", lang: "en", child: true },
  { name: "Tariq Mahmood", complaint: "Diabetes follow-up, sugar readings high this week", lang: "ur", child: false },
  { name: "Neha Kapoor", complaint: "Migraine since this morning", lang: "en", child: false },
  { name: "Ayesha Farooq (child)", complaint: "Child has a cough at night", lang: "ur", child: true },
  { name: "Rohan Gupta", complaint: "Twisted ankle playing football", lang: "en", child: false },
];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return Math.abs(h);
}

/** When this booked patient actually walks in (ms), or null if they never come. */
function arrivalFor(visitId: string, scheduled: number): number | null {
  const h = hash(visitId) % 100;
  if (h < 10) return null; // no-show
  if (h < 28) return scheduled + (12 + (h % 14)) * MIN; // late, beyond the grace period
  return scheduled + ((h % 9) - 6) * MIN; // 6 min early … 2 min late
}

const first = (name: string) => name.replace(/\(child\)/i, "").trim().split(" ")[0];

export async function maybeTick(): Promise<string[]> {
  const { claimed, clock } = await claimTick(TICK_GAP_MS);
  if (!claimed) return [];
  try {
    if (clock.paused) return [];
    return await runTick(clock);
  } finally {
    await releaseTick();
  }
}

async function runTick(clock: Awaited<ReturnType<typeof claimTick>>["clock"]): Promise<string[]> {
  const now = simNow(clock);
  const happened: string[] = [];
  let state = await repo.loadClinicState();

  // 1. Doctors whose delay has run out are back.
  for (const d of state.doctors) {
    if (d.status === "on_duty" && d.availableAt && new Date(d.availableAt).getTime() <= now) {
      await doctorAvailable(d.id, "system");
      happened.push(`${d.name} is back`);
    }
  }

  // 2. Booked patients arrive (or don't).
  for (const v of state.visits) {
    if (v.status !== "scheduled" || !v.scheduledAt) continue;
    const scheduled = new Date(v.scheduledAt).getTime();
    if (scheduled - now > 3 * 3_600_000) continue; // a future day
    const arrival = arrivalFor(v.id, scheduled);
    // Anyone this far past their slot without arriving is closed as a no-show (whatever their profile).
    if (now - scheduled > (state.clinic.noShowMinutes + 25) * MIN) {
      const closed = await markNoShow(visitRef(v), "system").then(() => true, () => false);
      if (closed) happened.push(`${visitRef(v)} ${first(v.patientName)} never came (no-show)`);
      continue;
    }
    if (arrival === null) continue;
    // Arrive only around the arrival moment: someone already long overdue (e.g. the seeded
    // no-show, or a gap while paused) stays missing and becomes a real no-show.
    if (now >= arrival && now - arrival <= ARRIVAL_WINDOW_MIN * MIN) {
      const ok = await checkIn(visitRef(v), "system").then(() => true, () => false);
      if (!ok) continue;
      const late = Math.round((arrival - scheduled) / MIN);
      happened.push(`${visitRef(v)} ${first(v.patientName)} arrived${late > state.clinic.graceMinutes ? ` ${late} min late` : ""}`);
    }
  }

  // 3. Consults end after roughly their estimate (0.8–1.3×).
  for (const v of state.visits) {
    if (v.status !== "in_consult" || !v.consultStartedAt) continue;
    const doctor = state.doctors.find((d) => d.id === v.doctorId);
    const est = v.estMinutes ?? doctor?.avgConsultMin ?? 10;
    // Most consults take 0.8–1.3× the estimate; one tagged "sim:overrun" in the seed runs 2× so the
    // overrun story is visible for a while after a reset.
    const overrun = ((v as { notes?: string | null }).notes ?? "").includes("sim:overrun");
    const target = est * (overrun ? 2 : 0.8 + (hash(v.id) % 50) / 100);
    if ((now - new Date(v.consultStartedAt).getTime()) / MIN >= target) {
      const ok = await finishConsult(visitRef(v), {}, "system").then(() => true, () => false);
      if (ok) happened.push(`${doctor?.name ?? "Doctor"} finished with ${visitRef(v)} ${first(v.patientName)}`);
    }
  }

  // 4. Free doctors call the next patient in the engine's order.
  state = await repo.loadClinicState();
  const plan = computeQueue(state, new Date(now));
  for (const d of plan.doctors) {
    const doctor = state.doctors.find((x) => x.id === d.doctorId);
    const available = !doctor?.availableAt || new Date(doctor.availableAt).getTime() <= now;
    if (d.status !== "on_duty" || d.current || !available) continue;
    const next = d.queue.find((q) => q.state === "waiting");
    if (next && new Date(next.etaStart).getTime() <= now + MIN) {
      const ok = await startConsult(next.token ? `#${next.token}` : next.visitId, "system").then(() => true, () => false);
      if (ok) happened.push(`${d.name} called ${next.token ? `#${next.token} ` : ""}${first(next.patientName)}`);
    }
  }

  // 5. Now and then a walk-in comes through the door.
  const recent = await repo.recentEvents(30);
  const lastWalkIn = recent.find((e) => e.type === "walk_in" || e.type === "emergency_intake");
  const sinceWalkIn = lastWalkIn ? (now - new Date(lastWalkIn.created_at).getTime()) / MIN : Infinity;
  if (sinceWalkIn >= WALK_IN_EVERY_MIN) {
    const walkIns = recent.filter((e) => e.type === "walk_in").length;
    const pick = WALK_IN_POOL[(hash(String(Math.floor(now / (5 * MIN)))) + walkIns) % WALK_IN_POOL.length];
    // At most one new walk-in per tick, and only on a quiet tick, so the floor stays readable.
    if (!happened.length) {
      const added = await addWalkIn(pick, now, state, plan);
      if (added) happened.push(added);
    }
  }
  return happened;
}

async function addWalkIn(pick: (typeof WALK_IN_POOL)[number], now: number, state: Awaited<ReturnType<typeof repo.loadClinicState>>, plan: ReturnType<typeof computeQueue>) {
  const onDuty = plan.doctors.filter((d) => d.status === "on_duty");
  const wanted = onDuty.filter((d) => (pick.child ? /pediatric/i.test(d.specialty) : !/pediatric/i.test(d.specialty)));
  const doctor = (wanted.length ? wanted : onDuty).sort((a, b) => a.queue.length - b.queue.length)[0];
  if (!doctor) return null;
  const n = hash(pick.name + Math.floor(now / MIN)) % 900;
  const phone = n % 2 ? `+92300${String(100000 + n).slice(-6)}` : `+91980${String(1000000 + n).slice(-7)}`;
  const patient = await repo.findOrCreatePatient({ name: pick.name, phone, language: pick.lang });
  const token = await repo.nextToken(state.clinic.timezone);
  const visit = await repo.insertVisit({
    patientId: patient.id,
    doctorId: doctor.doctorId,
    kind: "walk_in",
    status: "waiting",
    priority: "normal",
    prioritySource: "default",
    token,
    arrivedAt: new Date(now).toISOString(),
    reason: pick.complaint,
  });
  await repo.logEvent({ type: "walk_in", actor: "system", summary: `Walk-in #${token} ${pick.name} → ${doctor.name}: ${pick.complaint}`, visitId: visit.id, doctorId: doctor.doctorId });
  return `Walk-in #${token} ${first(pick.name)} → ${doctor.name}`;
}
