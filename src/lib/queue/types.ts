// Domain types shared by the queue engine, the database layer and the agent tools.
// Timestamps are ISO strings at the boundaries; the engine converts to epoch ms internally.

export type Priority = "emergency" | "urgent" | "normal";
export type VisitKind = "appointment" | "walk_in" | "follow_up";
export type VisitStatus =
  | "scheduled" // booked, patient not here yet
  | "waiting" // checked in, in the waiting room
  | "in_consult"
  | "done"
  | "no_show"
  | "cancelled";
export type DoctorStatus = "on_duty" | "off_duty";

export interface ClinicPolicy {
  id: string;
  name: string;
  timezone: string;
  /** Minutes after the scheduled time an appointment patient can arrive and keep their slot. */
  graceMinutes: number;
  /** Minutes after the scheduled time a no-show is suspected. */
  noShowMinutes: number;
  /** Max number of later arrivals allowed to overtake a waiting patient (fairness guard). */
  maxBumps: number;
  /** Follow-ups booked within this many days of the original consult are free. */
  freeFollowUpDays: number;
  /** Projected delay (minutes) at which a patient should be told they are running late. */
  delayNotifyThresholdMin: number;
}

export interface Doctor {
  id: string;
  name: string;
  specialty: string;
  avgConsultMin: number;
  status: DoctorStatus;
  /** When the doctor becomes available (late arrival / stepped out). null = available now. */
  availableAt: string | null;
  shiftEnd: string | null;
}

export interface Visit {
  id: string;
  patientId: string;
  patientName: string;
  patientLanguage: string;
  doctorId: string;
  kind: VisitKind;
  status: VisitStatus;
  priority: Priority;
  token: number | null;
  scheduledAt: string | null;
  arrivedAt: string | null;
  consultStartedAt: string | null;
  consultEndedAt: string | null;
  estMinutes: number | null;
  reason: string | null;
}

export interface ClinicState {
  clinic: ClinicPolicy;
  doctors: Doctor[];
  visits: Visit[];
}

export type PlanState = "waiting" | "expected";

export interface PlannedVisit {
  visitId: string;
  token: number | null;
  patientName: string;
  kind: VisitKind;
  priority: Priority;
  state: PlanState;
  position: number;
  etaStart: string;
  waitMin: number;
  /** For booked visits: minutes between scheduled time and projected start. */
  projectedDelayMin: number | null;
  estMinutes: number;
  /** Human-readable reasons explaining this visit's placement. */
  flags: string[];
}

export interface DoctorPlan {
  doctorId: string;
  name: string;
  specialty: string;
  status: DoctorStatus;
  freeAt: string;
  delayMin: number;
  current: {
    visitId: string;
    patientName: string;
    startedAt: string;
    elapsedMin: number;
    overrunMin: number;
  } | null;
  queue: PlannedVisit[];
}

export type AlertType =
  | "emergency_waiting"
  | "delay_notify"
  | "likely_no_show"
  | "running_late"
  | "overrun"
  | "idle_doctor"
  | "beyond_shift"
  | "doctor_off_duty";

export interface Alert {
  type: AlertType;
  severity: "critical" | "warning" | "info";
  visitId?: string;
  doctorId?: string;
  message: string;
}

export interface QueueSnapshot {
  computedAt: string;
  doctors: DoctorPlan[];
  alerts: Alert[];
}
