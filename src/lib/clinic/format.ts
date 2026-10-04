// Token-light renderings of clinic state for the agent (and readable text for the UI/event log).
import type { ClinicState, Doctor, PlannedVisit, QueueSnapshot, Visit } from "../queue/types";
import type { QueueChange } from "../queue/engine";

export function fmtTime(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

export function fmtDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

/** SMS salutation: first name, or "parent of <first name>" for paediatric patients. */
export function greetingName(patientName: string): string {
  const child = /\(child\)/i.test(patientName);
  const first = patientName.replace(/\(child\)/i, "").trim().split(/\s+/)[0];
  return child ? `parent of ${first}` : first;
}

/** How the agent refers to a visit: today's token if it has one, else its id. */
export function visitRef(v: Pick<Visit, "token" | "id">): string {
  return v.token ? `#${v.token}` : v.id;
}

export function findVisitByRef(state: ClinicState, ref: string): Visit | undefined {
  const r = ref.trim().replace(/^token\s*/i, "");
  const num = r.replace(/^#/, "");
  if (/^\d+$/.test(num)) {
    const active = new Set(["scheduled", "waiting", "in_consult"]);
    const matches = state.visits.filter((v) => v.token === Number(num));
    return matches.find((v) => active.has(v.status)) ?? matches[0];
  }
  return state.visits.find((v) => v.id === r);
}

export function findDoctorByRef(state: ClinicState, ref: string): Doctor | undefined {
  const needle = ref.trim().toLowerCase().replace(/^dr\.?\s*/, "");
  return (
    state.doctors.find((d) => d.id === ref.trim()) ??
    state.doctors.find((d) => d.name.toLowerCase().replace(/^dr\.?\s*/, "") === needle) ??
    state.doctors.find((d) => d.name.toLowerCase().includes(needle))
  );
}

function plannedLine(q: PlannedVisit, tz: string): string {
  const parts = [
    `${q.token ? `#${q.token}` : q.visitId} ${q.patientName}`,
    q.kind.replace("_", "-"),
    q.priority !== "normal" ? q.priority.toUpperCase() : null,
    q.state === "expected" ? "not arrived yet" : "in waiting room",
    `starts ~${fmtTime(q.etaStart, tz)} (wait ${q.waitMin}m)`,
    q.projectedDelayMin ? `${q.projectedDelayMin}m behind booking` : null,
    ...q.flags,
  ];
  return parts.filter(Boolean).join(" · ");
}

export function renderBoard(state: ClinicState, snapshot: QueueSnapshot) {
  const tz = state.clinic.timezone;
  return {
    clinic: state.clinic.name,
    now: fmtTime(snapshot.computedAt, tz),
    doctors: snapshot.doctors.map((d) => ({
      doctor: `${d.name} (${d.specialty})`,
      status: d.status === "off_duty" ? "OFF DUTY" : d.delayMin ? `running ${d.delayMin} min late` : "on duty",
      with_patient: d.current
        ? `${d.current.patientName} — ${d.current.elapsedMin} min in${d.current.overrunMin ? `, ${d.current.overrunMin} min over estimate` : ""}`
        : null,
      free_at: fmtTime(d.freeAt, tz),
      queue: d.queue.map((q) => plannedLine(q, tz)),
    })),
    alerts: snapshot.alerts.map((a) => `[${a.severity}] ${a.message}`),
  };
}

export function renderImpact(changes: QueueChange[], state: ClinicState): string[] {
  const doctorName = (id: string) => state.doctors.find((d) => d.id === id)?.name ?? id;
  const tokenOf = (id: string) => {
    const v = state.visits.find((x) => x.id === id);
    return v ? visitRef(v) : id;
  };
  return changes.slice(0, 15).map((c) => {
    if (!c.before) return `${tokenOf(c.visitId)} ${c.patientName}: joined ${doctorName(c.after!.doctorId)}'s queue at position ${c.after!.position}, wait ${c.after!.waitMin}m`;
    if (!c.after) return `${tokenOf(c.visitId)} ${c.patientName}: left the queue`;
    const moved = c.before.doctorId !== c.after.doctorId ? ` (moved ${doctorName(c.before.doctorId)} → ${doctorName(c.after.doctorId)})` : "";
    const sign = c.waitDeltaMin > 0 ? "+" : "";
    return `${tokenOf(c.visitId)} ${c.patientName}: wait ${c.before.waitMin}m → ${c.after.waitMin}m (${sign}${c.waitDeltaMin}m), position ${c.before.position} → ${c.after.position}${moved}`;
  });
}
