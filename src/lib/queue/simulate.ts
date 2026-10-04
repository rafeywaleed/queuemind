// What-if sandbox: apply hypothetical changes to an in-memory copy of the clinic and re-plan.
// Lets the agent compare options (wait vs. reassign) before touching real data.
import { computeQueue, diffSnapshots } from "./engine";
import type { ClinicState, Priority, Visit } from "./types";

export type Hypothetical =
  | { type: "doctor_delay"; doctorId: string; minutes: number }
  | { type: "doctor_available"; doctorId: string }
  | { type: "reassign"; visitId: string; doctorId: string }
  | { type: "cancel"; visitId: string }
  | { type: "set_priority"; visitId: string; priority: Priority }
  | { type: "add_walk_in"; doctorId: string; estMinutes: number; priority: Priority };

export function applyHypotheticals(state: ClinicState, changes: Hypothetical[], now: Date): ClinicState {
  const next: ClinicState = structuredClone(state);
  for (const change of changes) {
    switch (change.type) {
      case "doctor_delay": {
        const d = next.doctors.find((x) => x.id === change.doctorId);
        if (d) d.availableAt = new Date(now.getTime() + change.minutes * 60_000).toISOString();
        break;
      }
      case "doctor_available": {
        const d = next.doctors.find((x) => x.id === change.doctorId);
        if (d) {
          d.availableAt = null;
          d.status = "on_duty";
        }
        break;
      }
      case "reassign": {
        const v = next.visits.find((x) => x.id === change.visitId);
        if (v) v.doctorId = change.doctorId;
        break;
      }
      case "cancel": {
        const v = next.visits.find((x) => x.id === change.visitId);
        if (v) v.status = "cancelled";
        break;
      }
      case "set_priority": {
        const v = next.visits.find((x) => x.id === change.visitId);
        if (v) v.priority = change.priority;
        break;
      }
      case "add_walk_in": {
        const v: Visit = {
          id: `hypothetical-${next.visits.length}`,
          patientId: "hypothetical",
          patientName: "Hypothetical walk-in",
          patientLanguage: "en",
          doctorId: change.doctorId,
          kind: "walk_in",
          status: "waiting",
          priority: change.priority,
          token: null,
          scheduledAt: null,
          arrivedAt: now.toISOString(),
          consultStartedAt: null,
          consultEndedAt: null,
          estMinutes: change.estMinutes,
          reason: null,
        };
        next.visits.push(v);
        break;
      }
    }
  }
  return next;
}

export function simulate(state: ClinicState, changes: Hypothetical[], now = new Date()) {
  const before = computeQueue(state, now);
  const after = computeQueue(applyHypotheticals(state, changes, now), now);
  const changesForPatients = diffSnapshots(before, after);
  const totalWait = (s: typeof before) => s.doctors.flatMap((d) => d.queue).filter((q) => q.state === "waiting").reduce((sum, q) => sum + q.waitMin, 0);
  const maxWait = (s: typeof before) => Math.max(0, ...s.doctors.flatMap((d) => d.queue).map((q) => q.waitMin));
  return {
    summary: {
      totalWaitingRoomMinutesBefore: totalWait(before),
      totalWaitingRoomMinutesAfter: totalWait(after),
      longestWaitBefore: maxWait(before),
      longestWaitAfter: maxWait(after),
      alertsBefore: before.alerts.length,
      alertsAfter: after.alerts.length,
    },
    patientImpact: changesForPatients,
    after,
  };
}
