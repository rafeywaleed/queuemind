// Shapes returned by the API routes, as consumed by the UI.
import type { ClinicPolicy, Doctor, QueueSnapshot, Visit } from "@/lib/queue/types";

export type { ClinicPolicy, Doctor, QueueSnapshot, Visit };
export type { DoctorPlan, PlannedVisit, Alert, Priority, VisitKind } from "@/lib/queue/types";

export type BoardVisit = Visit & { patientPhone: string | null; parentVisitId: string | null; feeWaived: boolean; notes: string | null };

export interface ClinicClock {
  /** Clinic minutes per real minute (6 = 10 real seconds per clinic minute). */
  speed: number;
  paused: boolean;
  now: string;
}

export interface Board {
  clinic: ClinicPolicy;
  doctors: Doctor[];
  visits: BoardVisit[];
  snapshot: QueueSnapshot;
  clock?: ClinicClock;
}

export interface Notification {
  id: string;
  visit_id: string | null;
  patient_id: string | null;
  kind: string;
  body: string;
  status: "pending_approval" | "sent" | "rejected";
  send_at: string | null;
  drafted_by: string | null;
  created_at: string;
  decided_at: string | null;
  patients?: { name: string; phone: string | null } | null;
}

export interface ClinicEvent {
  id: number;
  type: string;
  actor: "agent" | "staff" | "system" | "patient";
  summary: string;
  visit_id: string | null;
  doctor_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface PatientMessage {
  id: string;
  patient_id: string | null;
  visit_id: string | null;
  body: string;
  intent: string | null;
  confidence: number | null;
  decided_by: string | null;
  outcome: string | null;
  created_at: string;
}

export interface PatientMessageResult {
  visit: string;
  patient: string;
  intent: string | null;
  confidence: number;
  needsHuman: number;
  decidedBy: string;
  outcome: string;
  reply: string | null;
  impact: string[];
  handoff: boolean;
  laya: { latencyMs: number; model: string } | null;
  agentPrompt: string | null;
}

export interface PoolMemberStatus {
  member: string;
  usedToday: number;
  dailyBudget: number | null;
  lastMinute: number;
  state: "ready" | "cooling" | "exhausted" | "offline";
  readyInSec: number | null;
}

export interface RouterStatus {
  selfHosted: { registered: boolean; healthy: boolean; pingMs: number | null; model: string | null; lastSeenAt: string | null };
  fastLaneOrder: string[];
  reasoning: { provider: string };
  decision?: { online: boolean; waking?: boolean; host?: "local" | "huggingface" | "colab" | "laya-demo" | null; model: string | null; lastSeenAt: string | null };
  lastHour: Record<string, { calls: number; ok: number; avgLatencyMs: number | null }>;
  reasoningPool: PoolMemberStatus[];
}

export interface Scenario {
  id: string;
  title: string;
  event: string;
}

export type AgentEvent =
  | { type: "token"; text: string }
  | { type: "todos"; todos: { content: string; status: string }[] }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; content: string; isError: boolean }
  | { type: "files"; paths: string[] }
  | { type: "final"; text: string }
  | { type: "done"; threadId: string }
  | { type: "error"; message: string };
