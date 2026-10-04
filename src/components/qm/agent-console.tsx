"use client";
// The agent, made visible: inject an event, then watch the plan, every tool call (with its
// queue impact), what-if comparisons, guardrail refusals, and the final briefing stream in.
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Activity,
  ArrowRight,
  BookOpen,
  Bot,
  CalendarPlus,
  Check,
  ChevronDown,
  CircleDashed,
  FlaskConical,
  Loader2,
  MessageSquareText,
  RotateCcw,
  Search,
  Send,
  ShieldAlert,
  Siren,
  Sparkles,
  UserPlus,
  Users,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AgentSession, Step, Turn } from "@/lib/client/use-agent";
import type { Scenario } from "@/lib/client/types";

const SCENARIO_ICON: Record<string, typeof Siren> = {
  "doctor-late": Activity,
  "chest-pain": Siren,
  "routine-walk-in": UserPlus,
  sweep: Search,
  cancellation: CalendarPlus,
  "finish-follow-up": Check,
  "doctor-leaves": Users,
  report: Sparkles,
};

export function AgentConsole({ session, scenarios, className }: { session: AgentSession; scenarios: Scenario[]; className?: string }) {
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const lastTurn = session.turns[session.turns.length - 1];

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [session.turns, lastTurn?.steps.length, lastTurn?.text.length]);

  const submit = () => {
    if (!draft.trim()) return;
    void session.send(draft.trim());
    setDraft("");
  };

  return (
    <section className={cn("flex min-h-0 flex-col overflow-hidden rounded-2xl border bg-card", className)}>
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <div className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
          <Bot className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">QueueMind agent</div>
          <div className="text-[11px] text-muted-foreground">Deep agent · plans · playbooks · 18 clinic tools · what-if sandbox</div>
        </div>
        <Button variant="ghost" size="sm" onClick={session.reset} disabled={session.running}>
          <RotateCcw /> New thread
        </Button>
      </header>

      {/* Event injection */}
      <div className="border-b bg-muted/30 px-4 py-2.5">
        <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
          <Zap className="size-3" /> Something just happened at the clinic
        </div>
        <div className="flex flex-wrap gap-1.5">
          {scenarios.map((s) => {
            const Icon = SCENARIO_ICON[s.id] ?? Zap;
            return (
              <button
                key={s.id}
                type="button"
                disabled={session.running}
                onClick={() => void session.send(s.event)}
                title={s.event}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-[12px] font-medium transition hover:border-primary hover:text-primary disabled:opacity-40",
                  s.id === "chest-pain" && "border-qm-emergency/40 text-qm-emergency hover:border-qm-emergency hover:text-qm-emergency",
                )}
              >
                <Icon className="size-3.5" /> {s.title}
              </button>
            );
          })}
        </div>
      </div>

      {/* Transcript */}
      <div ref={scroller} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {session.turns.length === 0 && <EmptyState />}
        {session.turns.map((turn) => (
          <TurnView key={turn.id} turn={turn} />
        ))}
      </div>

      {/* Composer */}
      <div className="border-t p-3">
        <div className="flex items-end gap-2 rounded-xl border bg-background px-3 py-2 focus-within:ring-2 focus-within:ring-ring/40">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={2}
            placeholder='Tell the agent what happened… e.g. "Dr. Sara is running 20 minutes late" or "Why did #9 move?"'
            className="max-h-32 min-h-[40px] flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <Button size="icon" onClick={submit} disabled={session.running || !draft.trim()}>
            {session.running ? <Loader2 className="animate-spin" /> : <Send />}
          </Button>
        </div>
      </div>
    </section>
  );
}

function EmptyState() {
  return (
    <div className="grid h-full place-items-center py-10 text-center">
      <div className="max-w-xs space-y-2">
        <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-accent text-accent-foreground">
          <Sparkles className="size-5" />
        </div>
        <div className="font-display text-2xl">The waiting room, handled.</div>
        <p className="text-sm text-muted-foreground">
          Click an event above, like a late doctor or a chest-pain walk-in, and watch the agent plan, simulate, act and draft messages. Every number comes from the queue engine, not the model.
        </p>
      </div>
    </div>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  const isEvent = turn.message.startsWith("[EVENT]");
  const message = turn.message.replace(/^\[EVENT\]\s*/, "");
  const seconds = turn.endedAt && turn.startedAt ? Math.round((turn.endedAt - turn.startedAt) / 1000) : null;
  return (
    <div className="qm-in space-y-3">
      {isEvent ? (
        <div className="rounded-xl border border-dashed border-primary/40 bg-accent/40 px-3 py-2">
          <div className="mb-0.5 flex items-center gap-1.5 text-[10px] font-semibold tracking-wider text-primary uppercase">
            <Zap className="size-3" /> Clinic event
          </div>
          <div className="text-sm">{message}</div>
        </div>
      ) : (
        <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-foreground px-3.5 py-2 text-sm text-background">{message}</div>
      )}

      {turn.todos.length > 0 && <PlanCard todos={turn.todos} />}

      {turn.steps.length > 0 && (
        <ol className="relative space-y-1.5 border-l pl-4">
          {turn.steps.map((s) => (
            <StepView key={s.id} step={s} />
          ))}
        </ol>
      )}

      {turn.status === "running" && !turn.text && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> {turn.steps.length ? "Working through the plan…" : "Reading the board…"}
        </div>
      )}

      {turn.text && (
        <div className="prose-qm rounded-xl bg-muted/50 px-3.5 py-3 text-sm">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{turn.text}</ReactMarkdown>
        </div>
      )}

      {turn.status === "error" && (
        <div className="rounded-xl border border-qm-emergency/30 bg-qm-emergency/8 px-3 py-2 text-xs text-qm-emergency">{turn.error}</div>
      )}

      {turn.status === "done" && seconds !== null && (
        <div className="text-[10px] text-muted-foreground">
          {turn.steps.length} tool calls · {seconds}s
        </div>
      )}
    </div>
  );
}

function PlanCard({ todos }: { todos: Turn["todos"] }) {
  const done = todos.filter((t) => t.status === "completed").length;
  return (
    <div className="rounded-xl border bg-background px-3 py-2.5">
      <div className="mb-1.5 flex items-center justify-between text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
        <span>Agent plan</span>
        <span className="font-mono">
          {done}/{todos.length}
        </span>
      </div>
      <ul className="space-y-1">
        {todos.map((t, i) => (
          <li key={i} className="flex items-start gap-2 text-[13px]">
            {t.status === "completed" ? (
              <Check className="mt-0.5 size-3.5 shrink-0 text-qm-good" />
            ) : t.status === "in_progress" ? (
              <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-primary" />
            ) : (
              <CircleDashed className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className={cn(t.status === "completed" && "text-muted-foreground line-through decoration-muted-foreground/40")}>{t.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const STEP_META: Record<string, { icon: typeof Bot; label: (a: Record<string, unknown>) => string }> = {
  get_queue_board: { icon: Activity, label: () => "Re-checked the live board" },
  read_file: { icon: BookOpen, label: (a) => `Opened playbook · ${String(a.file_path ?? "").split("/").filter(Boolean)[1] ?? a.file_path}` },
  report_doctor_delay: { icon: Activity, label: (a) => `Recorded delay · ${a.doctor} +${a.minutes}m` },
  mark_doctor_available: { icon: Check, label: (a) => `${a.doctor} is back` },
  mark_doctor_off_duty: { icon: Users, label: (a) => `${a.doctor} off duty` },
  register_walk_in: { icon: UserPlus, label: (a) => `Registered walk-in · ${a.patient_name}` },
  check_in_patient: { icon: Check, label: (a) => `Checked in ${a.visit}` },
  simulate_options: { icon: FlaskConical, label: (a) => `What-if simulation · ${(a.options as unknown[] | undefined)?.length ?? 1} option(s)` },
  reassign_visit: { icon: ArrowRight, label: (a) => `Moved ${a.visit} → ${a.doctor}` },
  draft_patient_sms: { icon: MessageSquareText, label: (a) => `Drafted ${(a.visits as unknown[] | undefined)?.length ?? 1} SMS · ${a.purpose}` },
  raise_priority: { icon: ShieldAlert, label: (a) => `Raised ${a.visit} → ${a.to}` },
  cancel_visit: { icon: CalendarPlus, label: (a) => `Cancelled ${a.visit}` },
  mark_no_show: { icon: CircleDashed, label: (a) => `No-show ${a.visit}` },
  start_consult: { icon: ArrowRight, label: (a) => `Called in ${a.visit}` },
  finish_consult: { icon: Check, label: (a) => `Finished ${a.visit}${a.follow_up_in_days ? ` · follow-up in ${a.follow_up_in_days}d` : ""}` },
  book_follow_up: { icon: CalendarPlus, label: (a) => `Follow-up for ${a.visit} in ${a.in_days}d` },
  visit_history: { icon: Search, label: (a) => `Audit trail for ${a.visit}` },
  recent_activity: { icon: Search, label: () => "Read the event log" },
  find_patient: { icon: Search, label: (a) => `Looked up "${a.query}"` },
  task: { icon: Bot, label: (a) => `Delegated to ${a.subagent_type ?? "subagent"}` },
};

function parseResult(result?: string): unknown {
  if (!result || result.startsWith("ERROR")) return null;
  try {
    return JSON.parse(result);
  } catch {
    return null;
  }
}

function StepView({ step }: { step: Step }) {
  const [open, setOpen] = useState(false);
  const meta = STEP_META[step.name] ?? { icon: Bot, label: () => step.name.replace(/_/g, " ") };
  const Icon = meta.icon;
  const pending = step.result === undefined;
  const guardrail = step.isError && /Refused|Policy/i.test(step.result ?? "");
  const parsed = parseResult(step.result) as { impact?: string[]; result?: Record<string, unknown> } | unknown[] | null;
  const impact = parsed && !Array.isArray(parsed) ? parsed.impact ?? [] : [];

  return (
    <li className="qm-in relative">
      <span
        className={cn(
          "absolute top-1 -left-[23px] grid size-3.5 place-items-center rounded-full border-2 border-card",
          pending ? "bg-primary/40" : step.isError ? (guardrail ? "bg-qm-urgent" : "bg-qm-emergency") : "bg-qm-good",
        )}
      />
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 text-left text-[13px]">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate font-medium">{meta.label(step.args)}</span>
        {pending && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        {guardrail && <span className="rounded bg-qm-urgent/20 px-1.5 text-[10px] font-semibold">GUARDRAIL</span>}
        {!pending && <ChevronDown className={cn("size-3.5 text-muted-foreground transition", open && "rotate-180")} />}
      </button>

      {step.isError && <div className={cn("mt-1 rounded-md px-2 py-1 text-[12px]", guardrail ? "bg-qm-urgent/12" : "bg-qm-emergency/8 text-qm-emergency")}>{step.result?.replace(/^ERROR:\s*/, "")}</div>}

      {step.name === "simulate_options" && Array.isArray(parsed) && <SimulationView options={parsed as SimOption[]} />}

      {impact.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {impact.slice(0, 8).map((line) => (
            <ImpactChip key={line} line={line} />
          ))}
          {impact.length > 8 && <span className="text-[11px] text-muted-foreground">+{impact.length - 8} more</span>}
        </div>
      )}

      {step.name === "draft_patient_sms" && Array.isArray(parsed) && (
        <div className="mt-1.5 space-y-1">
          {(parsed as { ref?: string; body?: string; skipped?: string; writtenBy?: string }[]).slice(0, 3).map((d, i) => (
            <div key={i} className="rounded-lg bg-muted/60 px-2 py-1 text-[12px]">
              <span className="font-mono text-[10px] text-muted-foreground">{d.ref} · {d.writtenBy ?? "skipped"}</span>
              <div className="line-clamp-2">{d.body ?? d.skipped}</div>
            </div>
          ))}
        </div>
      )}

      {open && !pending && (
        <pre className="mt-1.5 max-h-56 overflow-auto rounded-lg bg-foreground/[0.04] p-2 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap">
          <span className="text-muted-foreground">args </span>
          {JSON.stringify(step.args, null, 1)}
          {"\n\n"}
          <span className="text-muted-foreground">result </span>
          {step.result}
        </pre>
      )}
    </li>
  );
}

/** "#6 Usman Tariq: wait 6m → 35m (+29m), position 1 → 1" → a coloured chip. */
function ImpactChip({ line }: { line: string }) {
  const delta = line.match(/\(([+-]?\d+)m\)/);
  const n = delta ? Number(delta[1]) : 0;
  const who = line.split(":")[0];
  const moved = line.match(/\(moved (.+?)\)/);
  return (
    <span
      title={line}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[11px]",
        n > 0 ? "bg-qm-emergency/10 text-qm-emergency" : n < 0 ? "bg-qm-good/12 text-qm-good" : "bg-muted text-muted-foreground",
      )}
    >
      {who}
      {delta && <b>{n > 0 ? `+${n}m` : `${n}m`}</b>}
      {moved && <span className="opacity-70">→ {moved[1].split("→")[1]?.trim()}</span>}
      {!delta && !moved && <span className="opacity-70">{line.split(":")[1]?.trim().slice(0, 28)}</span>}
    </span>
  );
}

interface SimOption {
  option: string;
  longestWaitBefore: number;
  longestWaitAfter: number;
  totalWaitingRoomMinutesBefore: number;
  totalWaitingRoomMinutesAfter: number;
}

function SimulationView({ options }: { options: SimOption[] }) {
  return (
    <div className="mt-1.5 overflow-hidden rounded-lg border">
      <table className="w-full text-[11.5px]">
        <thead className="bg-muted/50 text-[10px] text-muted-foreground uppercase">
          <tr>
            <th className="px-2 py-1 text-left font-medium">Option</th>
            <th className="px-2 py-1 text-right font-medium">Longest wait</th>
            <th className="px-2 py-1 text-right font-medium">Room minutes</th>
          </tr>
        </thead>
        <tbody>
          {options.map((o) => {
            const better = o.longestWaitAfter < o.longestWaitBefore;
            return (
              <tr key={o.option} className="border-t">
                <td className="px-2 py-1">{o.option}</td>
                <td className={cn("px-2 py-1 text-right font-mono", better ? "text-qm-good" : o.longestWaitAfter > o.longestWaitBefore && "text-qm-emergency")}>
                  {o.longestWaitBefore}→{o.longestWaitAfter}m
                </td>
                <td className="px-2 py-1 text-right font-mono">
                  {o.totalWaitingRoomMinutesBefore}→{o.totalWaitingRoomMinutesAfter}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
