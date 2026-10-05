// The queue engine: a pure, deterministic function from clinic state to a plan.
// The LLM never computes waits or orderings — it calls tools that call this.
import type {
  Alert,
  ClinicState,
  Doctor,
  DoctorPlan,
  PlannedVisit,
  PlanState,
  Priority,
  QueueSnapshot,
  Visit,
} from "./types";

const MIN = 60_000;
/** When a consult runs past its estimate, assume this many more minutes. */
const OVERRUN_TAIL_MIN = 3;
const OVERRUN_ALERT_MIN = 10;
/** How far ahead bookings count as "today's queue". */
const PLAN_HORIZON_MIN = 12 * 60;

export const PRIORITY_RANK: Record<Priority, number> = { emergency: 0, urgent: 1, normal: 2 };

const ms = (iso: string) => new Date(iso).getTime();
const iso = (t: number) => new Date(t).toISOString();
const minutes = (delta: number) => Math.round(delta / MIN);
/** "#12 Name" — alerts carry the token so the agent can act on them without a lookup. */
const who = (v: Visit) => (v.token ? `#${v.token} ${v.patientName}` : v.patientName);

interface Candidate {
  visit: Visit;
  state: PlanState;
  /** Earliest moment the doctor could start this visit. */
  readyAt: number;
  /** Ordering key within the same priority tier. */
  sortKey: number;
  /** When the patient joined the line — used by the fairness guard. */
  arrivalKey: number;
  est: number;
  flags: string[];
  bumps: number;
}

export function estimateMinutes(visit: Visit, doctor: Doctor): number {
  return visit.estMinutes ?? doctor.avgConsultMin;
}

/** When this doctor can start their next patient: after any delay and the consult in progress. */
function freeAtFor(doctor: Doctor, visits: Visit[], now: number): number {
  const availableFrom = doctor.availableAt ? Math.max(now, ms(doctor.availableAt)) : now;
  const inConsult = visits.find((v) => v.doctorId === doctor.id && v.status === "in_consult");
  if (!inConsult?.consultStartedAt) return availableFrom;
  const est = estimateMinutes(inConsult, doctor);
  const elapsed = (now - ms(inConsult.consultStartedAt)) / MIN;
  const remaining = elapsed < est ? est - elapsed : OVERRUN_TAIL_MIN;
  return Math.max(availableFrom, now + remaining * MIN);
}

export function computeQueue(state: ClinicState, nowInput: Date | string = new Date()): QueueSnapshot {
  const now = typeof nowInput === "string" ? ms(nowInput) : nowInput.getTime();
  const { clinic } = state;
  const alerts: Alert[] = [];
  const plans: DoctorPlan[] = [];

  // Emergencies don't belong to one doctor. Each waiting emergency (in arrival order) goes to
  // whichever on-duty doctor will be free first; each placement pushes that doctor's free time back
  // so a second emergency goes to the next-free doctor. Near-ties keep the assigned doctor (no flapping).
  const effectiveDoctor = new Map<string, string>();
  const floatFlag = new Map<string, string>();
  const nextFree = new Map(state.doctors.filter((d) => d.status === "on_duty").map((d) => [d.id, freeAtFor(d, state.visits, now)]));
  const emergencies = state.visits
    .filter((v) => v.status === "waiting" && v.priority === "emergency")
    .sort((a, b) => ms(a.arrivedAt ?? iso(now)) - ms(b.arrivedAt ?? iso(now)));
  for (const e of emergencies) {
    let best = nextFree.has(e.doctorId) ? e.doctorId : null;
    for (const [id, t] of nextFree) {
      if (best === null || t < nextFree.get(best)! - MIN) best = id;
    }
    if (!best) continue;
    const doc = state.doctors.find((d) => d.id === best)!;
    effectiveDoctor.set(e.id, best);
    nextFree.set(best, nextFree.get(best)! + estimateMinutes(e, doc) * MIN);
    if (best !== e.doctorId) floatFlag.set(e.id, `Emergency: ${doc.name} is free first, so they'll see this patient`);
  }

  for (const doctor of state.doctors) {
    const visits = state.visits.filter((v) => (effectiveDoctor.get(v.id) ?? v.doctorId) === doctor.id);
    const availableFrom = doctor.availableAt ? Math.max(now, ms(doctor.availableAt)) : now;

    // 1. Who is with the doctor right now, and when will the doctor be free?
    let current: DoctorPlan["current"] = null;
    let freeAt = availableFrom;
    const inConsult = visits.find((v) => v.status === "in_consult");
    if (inConsult?.consultStartedAt) {
      const est = estimateMinutes(inConsult, doctor);
      const elapsed = (now - ms(inConsult.consultStartedAt)) / MIN;
      const overrun = Math.max(0, elapsed - est);
      const remaining = elapsed < est ? est - elapsed : OVERRUN_TAIL_MIN;
      freeAt = Math.max(availableFrom, now + remaining * MIN);
      current = {
        visitId: inConsult.id,
        patientName: inConsult.patientName,
        startedAt: inConsult.consultStartedAt,
        elapsedMin: Math.round(elapsed),
        overrunMin: Math.round(overrun),
      };
      if (overrun >= OVERRUN_ALERT_MIN) {
        alerts.push({
          type: "overrun",
          severity: "warning",
          doctorId: doctor.id,
          visitId: inConsult.id,
          message: `${doctor.name}'s consult with ${who(inConsult)} is ${Math.round(overrun)} min over its ${est} min estimate; everyone behind is slipping.`,
        });
      }
    }

    // 2. Build candidates from waiting + expected visits, applying arrival policy.
    const candidates: Candidate[] = [];
    for (const visit of visits) {
      const est = estimateMinutes(visit, doctor);
      if (visit.status === "waiting") {
        const arrived = visit.arrivedAt ? ms(visit.arrivedAt) : now;
        const flags: string[] = floatFlag.has(visit.id) ? [floatFlag.get(visit.id)!] : [];
        let sortKey = arrived;
        if (visit.scheduledAt) {
          const lateBy = minutes(arrived - ms(visit.scheduledAt));
          if (lateBy > clinic.graceMinutes) {
            flags.push(`Arrived ${lateBy} min late (grace ${clinic.graceMinutes}) — lost appointment slot, queued by arrival time`);
          } else {
            sortKey = ms(visit.scheduledAt);
          }
        }
        candidates.push({ visit, state: "waiting", readyAt: now, sortKey, arrivalKey: arrived, est, flags, bumps: 0 });
      } else if (visit.status === "scheduled" && visit.scheduledAt) {
        const scheduled = ms(visit.scheduledAt);
        // Bookings for a later day (e.g. a follow-up next week) are not part of today's queue.
        if (scheduled - now > PLAN_HORIZON_MIN * MIN) continue;
        const overdue = minutes(now - scheduled);
        if (overdue > clinic.noShowMinutes) {
          alerts.push({
            type: "likely_no_show",
            severity: "warning",
            visitId: visit.id,
            doctorId: doctor.id,
            message: `${who(visit)} (booked ${doctor.name}) is ${overdue} min past their slot and not checked in — likely no-show.`,
          });
          continue;
        }
        if (overdue > clinic.graceMinutes) {
          alerts.push({
            type: "running_late",
            severity: "info",
            visitId: visit.id,
            doctorId: doctor.id,
            message: `${who(visit)} is ${overdue} min late for ${doctor.name}; their slot is released and they will queue by arrival time.`,
          });
          continue;
        }
        candidates.push({
          visit,
          state: "expected",
          readyAt: Math.max(scheduled, now),
          sortKey: scheduled,
          arrivalKey: scheduled,
          est,
          flags: [],
          bumps: 0,
        });
      }
    }

    if (doctor.status === "off_duty") {
      for (const c of candidates) {
        alerts.push({
          type: "doctor_off_duty",
          severity: "critical",
          visitId: c.visit.id,
          doctorId: doctor.id,
          message: `${who(c.visit)} is assigned to ${doctor.name}, who is off duty — reassign.`,
        });
      }
      plans.push(doctorPlan(doctor, now, freeAt, availableFrom, current, []));
      continue;
    }

    // 3. Greedy simulation: whenever the doctor is free, pick the best ready candidate.
    const queue: PlannedVisit[] = [];
    let t = freeAt;
    const pending = [...candidates];
    while (pending.length) {
      const ready = pending.filter((c) => c.readyAt <= t);
      if (!ready.length) {
        t = Math.min(...pending.map((c) => c.readyAt));
        continue;
      }
      const pick = choose(ready, clinic.maxBumps);
      for (const other of ready) {
        if (other !== pick && other.visit.priority === "normal" && pick.visit.priority === "normal" && other.arrivalKey < pick.arrivalKey) {
          other.bumps++;
        }
      }
      const scheduled = pick.visit.scheduledAt ? ms(pick.visit.scheduledAt) : null;
      const projectedDelayMin = scheduled !== null ? Math.max(0, minutes(t - scheduled)) : null;
      queue.push({
        visitId: pick.visit.id,
        token: pick.visit.token,
        patientName: pick.visit.patientName,
        kind: pick.visit.kind,
        priority: pick.visit.priority,
        state: pick.state,
        position: queue.length + 1,
        etaStart: iso(t),
        waitMin: Math.max(0, minutes(t - now)),
        projectedDelayMin,
        estMinutes: pick.est,
        flags: pick.flags,
      });

      if (projectedDelayMin !== null && projectedDelayMin >= clinic.delayNotifyThresholdMin) {
        alerts.push({
          type: "delay_notify",
          severity: "warning",
          visitId: pick.visit.id,
          doctorId: doctor.id,
          message: `${who(pick.visit)}'s ${pick.visit.kind.replace("_", "-")} with ${doctor.name} is projected to start ~${projectedDelayMin} min late.`,
        });
      }
      if (doctor.shiftEnd && t >= ms(doctor.shiftEnd)) {
        alerts.push({
          type: "beyond_shift",
          severity: "warning",
          visitId: pick.visit.id,
          doctorId: doctor.id,
          message: `${who(pick.visit)} would only be seen after ${doctor.name}'s shift ends — reassign or reschedule.`,
        });
      }
      if (pick.visit.priority === "emergency" && pick.state === "waiting") {
        alerts.push({
          type: "emergency_waiting",
          severity: "critical",
          visitId: pick.visit.id,
          doctorId: doctor.id,
          message: `EMERGENCY: ${who(pick.visit)} is waiting for ${doctor.name} (next in ${Math.max(0, minutes(t - now))} min).`,
        });
      }
      t += pick.est * MIN;
      pending.splice(pending.indexOf(pick), 1);
    }

    plans.push(doctorPlan(doctor, now, freeAt, availableFrom, current, queue));
  }

  alerts.push(...idleDoctorAlerts(plans, now));
  const severityRank = { critical: 0, warning: 1, info: 2 };
  alerts.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
  return { computedAt: iso(now), doctors: plans, alerts };
}

/** Highest priority first, then booking/arrival order — unless the fairness guard trips. */
function choose(ready: Candidate[], maxBumps: number): Candidate {
  const sorted = [...ready].sort(
    (a, b) =>
      PRIORITY_RANK[a.visit.priority] - PRIORITY_RANK[b.visit.priority] ||
      a.sortKey - b.sortKey ||
      (a.visit.token ?? Infinity) - (b.visit.token ?? Infinity),
  );
  const top = sorted[0];
  if (top.visit.priority !== "normal") return top;

  const starved = sorted
    .filter((c) => c.visit.priority === "normal" && c.bumps >= maxBumps && c.arrivalKey < top.arrivalKey)
    .sort((a, b) => a.arrivalKey - b.arrivalKey)[0];
  if (starved) {
    starved.flags.push(`Fairness guard: already overtaken ${starved.bumps} times (max ${maxBumps}) — locked in`);
    return starved;
  }
  return top;
}

function doctorPlan(
  doctor: Doctor,
  now: number,
  freeAt: number,
  availableFrom: number,
  current: DoctorPlan["current"],
  queue: PlannedVisit[],
): DoctorPlan {
  return {
    doctorId: doctor.id,
    name: doctor.name,
    specialty: doctor.specialty,
    status: doctor.status,
    freeAt: iso(freeAt),
    delayMin: Math.max(0, minutes(availableFrom - now)),
    current,
    queue,
  };
}

function idleDoctorAlerts(plans: DoctorPlan[], now: number): Alert[] {
  const alerts: Alert[] = [];
  for (const idle of plans) {
    if (idle.status !== "on_duty" || idle.current || idle.queue.length || ms(idle.freeAt) > now + 5 * MIN) continue;
    const busy = plans
      .filter((p) => p !== idle && p.specialty === idle.specialty && p.queue.filter((q) => q.state === "waiting").length >= 2)
      .sort((a, b) => b.queue.length - a.queue.length)[0];
    if (busy) {
      const next = busy.queue.find((q) => q.state === "waiting" && q.kind === "walk_in") ?? busy.queue.find((q) => q.state === "waiting");
      alerts.push({
        type: "idle_doctor",
        severity: "info",
        doctorId: idle.doctorId,
        visitId: next?.visitId,
        message: `${idle.name} is free with no queue while ${busy.name} has ${busy.queue.length} waiting — consider moving ${next ? `${next.token ? `#${next.token} ` : ""}${next.patientName}` : "the next patient"}.`,
      });
    }
  }
  return alerts;
}

export interface QueueChange {
  visitId: string;
  patientName: string;
  before: { doctorId: string; position: number; waitMin: number } | null;
  after: { doctorId: string; position: number; waitMin: number } | null;
  waitDeltaMin: number;
}

/** What changed for each patient between two snapshots (used for impact reports and notifications). */
export function diffSnapshots(before: QueueSnapshot, after: QueueSnapshot, minDeltaMin = 5): QueueChange[] {
  const index = (s: QueueSnapshot) => {
    const map = new Map<string, { doctorId: string; position: number; waitMin: number; patientName: string }>();
    for (const d of s.doctors) for (const q of d.queue) map.set(q.visitId, { doctorId: d.doctorId, position: q.position, waitMin: q.waitMin, patientName: q.patientName });
    return map;
  };
  const a = index(before);
  const b = index(after);
  const changes: QueueChange[] = [];
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(id) ?? null;
    const y = b.get(id) ?? null;
    const waitDeltaMin = (y?.waitMin ?? 0) - (x?.waitMin ?? 0);
    const moved = !x || !y || x.doctorId !== y.doctorId || x.position !== y.position;
    if (moved || Math.abs(waitDeltaMin) >= minDeltaMin) {
      changes.push({
        visitId: id,
        patientName: (y ?? x)!.patientName,
        before: x && { doctorId: x.doctorId, position: x.position, waitMin: x.waitMin },
        after: y && { doctorId: y.doctorId, position: y.position, waitMin: y.waitMin },
        waitDeltaMin,
      });
    }
  }
  return changes.sort((p, q) => Math.abs(q.waitDeltaMin) - Math.abs(p.waitDeltaMin));
}

/** Where a single visit sits in a snapshot. */
export function findInSnapshot(snapshot: QueueSnapshot, visitId: string) {
  for (const d of snapshot.doctors) {
    const q = d.queue.find((x) => x.visitId === visitId);
    if (q) return { doctor: d, planned: q };
  }
  return null;
}
