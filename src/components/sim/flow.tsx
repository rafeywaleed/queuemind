"use client";
// The agent's path through one event, as a plain chain a non-engineer can follow:
// Event → AI model → Playbook → AI model → Tool → Database → … → Done.
// Nodes are appended as the stream arrives; the active one pulses, finished ones get a tick.
import { AnimatePresence, motion } from "motion/react";
import {
  BookOpen,
  Bot,
  Check,
  ChevronRight,
  Database,
  FlaskConical,
  Gauge,
  Hand,
  ListChecks,
  Loader2,
  MessageSquareText,
  MonitorSmartphone,
  ShieldCheck,
  Smartphone,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { STEP_META } from "@/components/qm/agent-console";
import type { Step, Turn } from "@/lib/client/use-agent";
import type { PatientMessageResult } from "@/lib/client/types";

export type FlowKind = "event" | "patient" | "staff" | "llm" | "plan" | "playbook" | "tool" | "rules" | "laya" | "db" | "sandbox" | "sms" | "views" | "done";
export interface FlowNode {
  id: string;
  kind: FlowKind;
  label: string;
  detail?: string;
  status: "done" | "active" | "error";
}

const KIND: Record<FlowKind, { icon: typeof Bot; tone: string; name: string }> = {
  event: { icon: Zap, tone: "bg-qm-appointment text-white", name: "Event" },
  patient: { icon: Smartphone, tone: "bg-qm-followup text-white", name: "Patient SMS" },
  staff: { icon: Hand, tone: "bg-foreground text-background", name: "Staff" },
  llm: { icon: Bot, tone: "bg-[oklch(0.55_0.17_295)] text-white", name: "AI model" },
  plan: { icon: ListChecks, tone: "bg-[oklch(0.55_0.17_295)]/15 text-[oklch(0.45_0.17_295)]", name: "Plan" },
  playbook: { icon: BookOpen, tone: "bg-qm-consult/15 text-qm-consult", name: "Playbook" },
  tool: { icon: Wrench, tone: "bg-qm-urgent/20 text-[oklch(0.45_0.12_65)]", name: "Tool" },
  rules: { icon: ShieldCheck, tone: "bg-foreground/10 text-foreground", name: "Rules" },
  laya: { icon: Gauge, tone: "bg-qm-appointment/15 text-qm-appointment", name: "Laya" },
  db: { icon: Database, tone: "bg-qm-good/15 text-qm-good", name: "Database" },
  sandbox: { icon: FlaskConical, tone: "bg-qm-consult/15 text-qm-consult", name: "Simulation" },
  sms: { icon: MessageSquareText, tone: "bg-qm-followup/15 text-qm-followup", name: "SMS" },
  views: { icon: MonitorSmartphone, tone: "bg-qm-good/15 text-qm-good", name: "Screens" },
  done: { icon: Check, tone: "bg-qm-good text-white", name: "Done" },
};

/** Downstream nodes a tool call touches, in plain words. */
function sinks(step: Step, i: number): FlowNode[] {
  const s = (kind: FlowKind, label: string): FlowNode => ({ id: `${step.id}-${kind}-${i}`, kind, label, status: "done" });
  switch (step.name) {
    case "read_file":
    case "write_todos":
      return [];
    case "simulate_options":
      return [s("sandbox", "What-if on a copy, nothing saved")];
    case "draft_patient_sms":
      return [s("sms", "Draft waits for staff approval")];
    case "register_walk_in":
      return [s("rules", "Red-flag check"), s("laya", "Laya triage (LLM if unsure)"), s("db", "Token issued, queue replanned")];
    case "get_queue_board":
    case "find_patient":
    case "visit_history":
    case "recent_activity":
      return [s("db", "Read")];
    default:
      return [s("db", "Saved and replanned")];
  }
}

export function agentFlow(turn: Turn, prefix: FlowNode[] = []): FlowNode[] {
  const nodes: FlowNode[] = [...prefix];
  if (!prefix.length) nodes.push({ id: `${turn.id}-ev`, kind: "event", label: turn.message.replace(/^\[EVENT\]\s*/, "").slice(0, 60), status: "done" });
  let lastWasModel = false;
  turn.steps.forEach((st, i) => {
    if (!lastWasModel) nodes.push({ id: `${st.id}-llm`, kind: "llm", label: "Decides the next step", status: "done" });
    lastWasModel = false;
    const meta = STEP_META[st.name];
    const kind: FlowKind = st.name === "read_file" ? "playbook" : st.name === "write_todos" ? "plan" : "tool";
    const label = kind === "playbook" ? `Reads ${String(st.args.file_path ?? "").split("/")[2] ?? "playbook"}` : kind === "plan" ? "Writes a plan" : (meta?.label(st.args) ?? st.name);
    const pending = st.result === undefined;
    nodes.push({ id: `${st.id}-t`, kind, label, detail: st.name, status: pending ? "active" : st.isError ? "error" : "done" });
    if (!pending && !st.isError) nodes.push(...sinks(st, i));
    // Consecutive calls returned in one model response share the same "AI model" node.
    const next = turn.steps[i + 1];
    if (next && next.result === undefined && st.result === undefined) lastWasModel = true;
  });
  if (turn.status === "running" && turn.steps.every((s) => s.result !== undefined)) {
    nodes.push({ id: `${turn.id}-thinking`, kind: "llm", label: turn.steps.length ? "Reads the results, decides" : "Reads the event", status: "active" });
  }
  if (turn.text && turn.status !== "running") {
    nodes.push({ id: `${turn.id}-brief`, kind: "llm", label: "Writes the briefing", status: "done" });
    nodes.push({ id: `${turn.id}-views`, kind: "views", label: "Every screen updates", status: "done" });
    nodes.push({ id: `${turn.id}-done`, kind: "done", label: `${turn.steps.length} tool calls`, status: "done" });
  }
  if (turn.status === "error") nodes.push({ id: `${turn.id}-err`, kind: "done", label: turn.error ?? "Failed", status: "error" });
  return nodes;
}

export function staffFlow(label: string, status: "running" | "done" | "error", affected: number): FlowNode[] {
  const st = (i: number): FlowNode["status"] => (status === "error" ? "error" : status === "running" && i === 1 ? "active" : "done");
  const nodes: FlowNode[] = [
    { id: "s0", kind: "staff", label, status: "done" },
    { id: "s1", kind: "rules", label: "Clinic rules check it", status: st(1) },
  ];
  if (status !== "running") {
    nodes.push({ id: "s2", kind: "db", label: affected ? `Replanned · ${affected} affected` : "Saved and replanned", status: st(2) });
    nodes.push({ id: "s3", kind: "views", label: "Every screen updates", status: st(3) });
    nodes.push({ id: "s4", kind: "done", label: "No AI used", status: st(4) });
  }
  return nodes;
}

export function patientFlow(text: string, result: PatientMessageResult | null, failed: boolean): FlowNode[] {
  const nodes: FlowNode[] = [{ id: "p0", kind: "patient", label: `"${text.slice(0, 48)}${text.length > 48 ? "…" : ""}"`, status: "done" }];
  if (!result) {
    nodes.push({ id: "p1", kind: "laya", label: "Laya reads the intent", status: failed ? "error" : "active" });
    return nodes;
  }
  nodes.push({ id: "p1", kind: "rules", label: "Red-flag check", status: "done" });
  nodes.push({
    id: "p2",
    kind: "laya",
    label: result.laya ? `Intent: ${result.intent?.replace(/_/g, " ") ?? "?"} (${result.confidence.toFixed(2)})` : "Laya offline",
    detail: result.laya ? `${result.laya.latencyMs} ms` : undefined,
    status: "done",
  });
  if (!result.handoff) {
    nodes.push({ id: "p3", kind: "db", label: result.outcome, status: "done" });
    nodes.push({ id: "p4", kind: "sms", label: "Instant reply, facts only", status: "done" });
    nodes.push({ id: "p5", kind: "done", label: "No LLM needed", status: "done" });
  } else {
    nodes.push({ id: "p3", kind: "llm", label: result.decidedBy.startsWith("red-flag") ? "Escalated to the agent" : "Not sure enough → agent", status: "done" });
  }
  return nodes;
}

export function FlowLine({ nodes }: { nodes: FlowNode[] }) {
  if (!nodes.length) {
    return <div className="rounded-2xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">Pick an action. Each step the system takes will appear here, in order.</div>;
  }
  return (
    <div className="flex flex-wrap items-center gap-y-2">
      <AnimatePresence initial={false}>
        {nodes.map((n, i) => {
          const k = KIND[n.kind];
          const Icon = n.status === "error" ? X : n.status === "active" ? Loader2 : k.icon;
          return (
            <motion.div
              key={n.id}
              layout="position"
              initial={{ opacity: 0, transform: "translateY(6px) scale(0.96)" }}
              animate={{ opacity: 1, transform: "translateY(0px) scale(1)" }}
              transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
              className="flex items-center"
            >
              {i > 0 && <ChevronRight className="mx-0.5 size-4 shrink-0 text-muted-foreground/60" />}
              <div
                className={cn(
                  "flex max-w-[260px] items-center gap-2 rounded-xl border px-2.5 py-1.5 transition-shadow duration-200",
                  n.status === "active" && "border-primary shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_20%,transparent)]",
                  n.status === "error" && "border-qm-emergency/50 bg-qm-emergency/5",
                )}
              >
                <span className={cn("grid size-6 shrink-0 place-items-center rounded-lg", n.status === "error" ? "bg-qm-emergency text-white" : k.tone)}>
                  <Icon className={cn("size-3.5", n.status === "active" && "animate-spin")} />
                </span>
                <span className="min-w-0 leading-tight">
                  <span className="block text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">{k.name}</span>
                  <span className="block truncate text-[12.5px] font-medium">{n.label}</span>
                </span>
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
