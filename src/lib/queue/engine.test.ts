import { describe, expect, it } from "vitest";
import { computeQueue, diffSnapshots, findInSnapshot } from "./engine";
import { followUpFee, maxPriority, screenRedFlags } from "./policies";
import { simulate } from "./simulate";
import type { ClinicState, Doctor, Visit } from "./types";

const NOW = new Date("2026-10-04T11:00:00.000Z");
const at = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();

const clinic: ClinicState["clinic"] = {
  id: "c1",
  name: "Test Clinic",
  timezone: "Asia/Karachi",
  graceMinutes: 10,
  noShowMinutes: 20,
  maxBumps: 2,
  freeFollowUpDays: 5,
  delayNotifyThresholdMin: 15,
};

const doctor = (id: string, over: Partial<Doctor> = {}): Doctor => ({
  id,
  name: `Dr. ${id.toUpperCase()}`,
  specialty: "General",
  avgConsultMin: 10,
  status: "on_duty",
  availableAt: null,
  shiftEnd: null,
  ...over,
});

let seq = 0;
const visit = (over: Partial<Visit>): Visit => ({
  id: `v${++seq}`,
  patientId: `p${seq}`,
  patientName: `Patient ${seq}`,
  patientLanguage: "en",
  doctorId: "a",
  kind: "walk_in",
  status: "waiting",
  priority: "normal",
  token: seq,
  scheduledAt: null,
  arrivedAt: at(-5),
  consultStartedAt: null,
  consultEndedAt: null,
  estMinutes: null,
  reason: null,
  ...over,
});

const state = (visits: Visit[], doctors: Doctor[] = [doctor("a")]): ClinicState => ({ clinic, doctors, visits });
const order = (s: ReturnType<typeof computeQueue>, doctorId = "a") => s.doctors.find((d) => d.doctorId === doctorId)!.queue.map((q) => q.patientName);

describe("queue engine", () => {
  it("propagates a doctor delay into projected waits and raises a delay notification", () => {
    const appt = visit({ patientName: "Booked 11:20", kind: "appointment", status: "scheduled", scheduledAt: at(20), arrivedAt: null });
    const snap = computeQueue(state([appt], [doctor("a", { availableAt: at(38) })]), NOW);
    const planned = findInSnapshot(snap, appt.id)!.planned;
    expect(planned.waitMin).toBe(38);
    expect(planned.projectedDelayMin).toBe(18);
    expect(snap.alerts.some((a) => a.type === "delay_notify" && a.visitId === appt.id)).toBe(true);
  });

  it("puts an emergency ahead of everyone", () => {
    const early = visit({ patientName: "Early walk-in", arrivedAt: at(-40) });
    const emergency = visit({ patientName: "Chest pain", priority: "emergency", arrivedAt: at(-1) });
    const snap = computeQueue(state([early, emergency]), NOW);
    expect(order(snap)).toEqual(["Chest pain", "Early walk-in"]);
    expect(snap.alerts[0].type).toBe("emergency_waiting");
  });

  it("keeps the slot for an on-time appointment but not for a late one", () => {
    const walkIn = visit({ patientName: "Walk-in", arrivedAt: at(-20) });
    const onTime = visit({ patientName: "On time", kind: "appointment", scheduledAt: at(-25), arrivedAt: at(-30) });
    const late = visit({ patientName: "Late", kind: "appointment", scheduledAt: at(-30), arrivedAt: at(-5) });
    const snap = computeQueue(state([walkIn, onTime, late]), NOW);
    expect(order(snap)).toEqual(["On time", "Walk-in", "Late"]);
    expect(findInSnapshot(snap, late.id)!.planned.flags[0]).toMatch(/lost appointment slot/);
  });

  it("fairness guard stops a walk-in from being overtaken more than maxBumps times", () => {
    const walkIn = visit({ patientName: "Patient walk-in", arrivedAt: at(-30) });
    // Booked before the walk-in arrived, checked in after them but within grace — each one overtakes the walk-in.
    const appts = [0, 1, 2, 3].map((i) =>
      visit({ patientName: `Appt ${i}`, kind: "appointment", status: "waiting", scheduledAt: at(-38 + i), arrivedAt: at(-29) }),
    );
    const snap = computeQueue(state([walkIn, ...appts]), NOW);
    expect(order(snap)).toEqual(["Appt 0", "Appt 1", "Patient walk-in", "Appt 2", "Appt 3"]);
    expect(findInSnapshot(snap, walkIn.id)!.planned.flags.join()).toMatch(/Fairness guard/);
  });

  it("detects a consult overrun and assumes a short tail", () => {
    const current = visit({ patientName: "Long consult", status: "in_consult", consultStartedAt: at(-30), estMinutes: 15 });
    const next = visit({ patientName: "Next" });
    const snap = computeQueue(state([current, next]), NOW);
    expect(snap.doctors[0].current?.overrunMin).toBe(15);
    expect(findInSnapshot(snap, next.id)!.planned.waitMin).toBe(3);
    expect(snap.alerts.some((a) => a.type === "overrun")).toBe(true);
  });

  it("flags likely no-shows and drops them from the plan", () => {
    const ghost = visit({ patientName: "Ghost", kind: "appointment", status: "scheduled", scheduledAt: at(-25), arrivedAt: null });
    const snap = computeQueue(state([ghost]), NOW);
    expect(order(snap)).toEqual([]);
    expect(snap.alerts.some((a) => a.type === "likely_no_show" && a.visitId === ghost.id)).toBe(true);
  });

  it("suggests moving work to an idle doctor of the same specialty", () => {
    const visits = [visit({ doctorId: "a" }), visit({ doctorId: "a" }), visit({ doctorId: "a" })];
    const snap = computeQueue(state(visits, [doctor("a"), doctor("b")]), NOW);
    expect(snap.alerts.some((a) => a.type === "idle_doctor" && a.doctorId === "b")).toBe(true);
  });

  it("asks for reassignment when a doctor is off duty", () => {
    const v = visit({ doctorId: "a" });
    const snap = computeQueue(state([v], [doctor("a", { status: "off_duty" })]), NOW);
    expect(snap.alerts.some((a) => a.type === "doctor_off_duty" && a.visitId === v.id)).toBe(true);
  });
});

describe("emergencies go to whichever doctor is free first", () => {
  // Dr. A just started a 15-min consult; Dr. B is 2 min from finishing hers.
  const doctors = () => [doctor("a", { avgConsultMin: 15 }), doctor("b", { avgConsultMin: 10 })];
  const busy = () => [
    visit({ doctorId: "a", status: "in_consult", consultStartedAt: at(-1), estMinutes: 15, patientName: "A current" }),
    visit({ doctorId: "b", status: "in_consult", consultStartedAt: at(-8), estMinutes: 10, patientName: "B current" }),
  ];

  it("moves an emergency registered with a busy doctor to the doctor who frees up first", () => {
    const e = visit({ doctorId: "a", priority: "emergency", patientName: "Chest pain", arrivedAt: at(0) });
    const snap = computeQueue(state([...busy(), e], doctors()), NOW);
    const placed = findInSnapshot(snap, e.id)!;
    expect(placed.doctor.doctorId).toBe("b");
    expect(placed.planned.waitMin).toBe(2);
    expect(placed.planned.flags.join()).toMatch(/free first/);
  });

  it("spreads two emergencies across doctors instead of stacking them on one", () => {
    const e1 = visit({ doctorId: "a", priority: "emergency", patientName: "E1", arrivedAt: at(-2) });
    const e2 = visit({ doctorId: "a", priority: "emergency", patientName: "E2", arrivedAt: at(-1) });
    const snap = computeQueue(state([...busy(), e1, e2], doctors()), NOW);
    expect(findInSnapshot(snap, e1.id)!.doctor.doctorId).toBe("b"); // B free in 2 min
    expect(findInSnapshot(snap, e2.id)!.doctor.doctorId).toBe("b"); // B free again at 12, A at 14
    const e3 = visit({ doctorId: "b", priority: "emergency", patientName: "E3", arrivedAt: at(0) });
    const snap3 = computeQueue(state([...busy(), e1, e2, e3], doctors()), NOW);
    expect(findInSnapshot(snap3, e3.id)!.doctor.doctorId).toBe("a"); // A (14) now beats B (22)
  });

  it("keeps the assigned doctor on a near-tie (no flapping)", () => {
    const e = visit({ doctorId: "a", priority: "emergency", arrivedAt: at(0) });
    const tie = [
      visit({ doctorId: "a", status: "in_consult", consultStartedAt: at(-5), estMinutes: 10 }),
      visit({ doctorId: "b", status: "in_consult", consultStartedAt: at(-5.5), estMinutes: 10 }),
    ];
    expect(findInSnapshot(computeQueue(state([...tie, e], doctors()), NOW), e.id)!.doctor.doctorId).toBe("a");
  });

  it("never sends an emergency to an off-duty doctor", () => {
    const e = visit({ doctorId: "a", priority: "emergency", arrivedAt: at(0) });
    const ds = [doctor("a"), doctor("b", { status: "off_duty" })];
    expect(findInSnapshot(computeQueue(state([e], ds), NOW), e.id)!.doctor.doctorId).toBe("a");
  });
});

describe("what-if simulation", () => {
  it("shows that reassigning to an idle doctor cuts the wait", () => {
    const visits = [visit({ doctorId: "a" }), visit({ doctorId: "a" }), visit({ doctorId: "a", patientName: "Third" })];
    const s = state(visits, [doctor("a"), doctor("b")]);
    const result = simulate(s, [{ type: "reassign", visitId: visits[2].id, doctorId: "b" }], NOW);
    expect(result.summary.longestWaitAfter).toBeLessThan(result.summary.longestWaitBefore);
    expect(result.patientImpact.find((c) => c.patientName === "Third")?.waitDeltaMin).toBe(-20);
  });

  it("diff reports patients whose wait moved", () => {
    const visits = [visit({}), visit({})];
    const before = computeQueue(state(visits), NOW);
    const after = computeQueue(state(visits, [doctor("a", { availableAt: at(30) })]), NOW);
    expect(diffSnapshots(before, after).every((c) => c.waitDeltaMin === 30)).toBe(true);
  });
});

describe("policies", () => {
  it("follow-up is free through day 5 and charged on day 6 (clinic-local dates)", () => {
    const consult = "2026-10-04T10:00:00Z";
    expect(followUpFee(consult, "2026-10-09T09:00:00Z", 5, "Asia/Karachi").free).toBe(true);
    expect(followUpFee(consult, "2026-10-10T09:00:00Z", 5, "Asia/Karachi").free).toBe(false);
  });

  it("red flags escalate, ordinary words do not", () => {
    expect(screenRedFlags("crushing chest pain since morning").level).toBe("emergency");
    expect(screenRedFlags("baby has fever and is not feeding").level).toBe("urgent");
    expect(screenRedFlags("I'm fit, just need a prescription refill").level).toBe("normal");
  });

  it("safety ratchet only ever takes the most severe signal", () => {
    expect(maxPriority("normal", "urgent", null)).toBe("urgent");
    expect(maxPriority("emergency", "normal")).toBe("emergency");
  });
});
