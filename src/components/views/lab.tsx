"use client";
// Live Lab: make something happen → watch the harness route it → see the clinic change.
import { useMemo, useState } from "react";
import { Activity, ArrowRight, Bot, Check, ChevronDown, CircleDashed, Hand, Loader2, LogIn, Search, Send, Siren, Sparkles, Timer, UserPlus, Users, X, Zap } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { ClinicFloor } from "@/components/lab/clinic-floor";
import { HarnessGraph } from "@/components/lab/harness-graph";
import { flowFor, type EdgeId, type NodeId } from "@/components/lab/harness-spec";
import { ImpactChip, parseResult, STEP_META } from "@/components/qm/agent-console";
import { cn } from "@/lib/utils";
import { postJson, type ClinicData } from "@/lib/client/use-clinic";
import type { AgentSession, Step } from "@/lib/client/use-agent";
import type { Board, RouterStatus } from "@/lib/client/types";

interface StaffRun {
  id: string;
  label: string;
  fn: string;
  status: "running" | "done" | "error";
  impact: string[];
  error?: string;
  at: number;
}

const AGENT_EVENTS: { id: string; title: string; tests: string; icon: typeof Siren; danger?: boolean }[] = [
  { id: "doctor-late", title: "Doctor called away", tests: "Delay playbook → simulate → SMS", icon: Activity },
  { id: "chest-pain", title: "Chest-pain walk-in", tests: "Red flags → emergency jump", icon: Siren, danger: true },
  { id: "routine-walk-in", title: "Routine walk-in", tests: "Triage → fastest doctor", icon: UserPlus },
  { id: "cancellation", title: "Patient cancels", tests: "Who moves up → tell them", icon: X },
  { id: "doctor-leaves", title: "Doctor leaves early", tests: "Reassign a whole queue", icon: Users },
  { id: "sweep", title: "Monitoring sweep", tests: "No-shows, overruns, idle doctors", icon: Search },
  { id: "finish-follow-up", title: "Consult done + follow-up", tests: "Free ≤ 5 days rule", icon: Check },
];

export function LabView({ data, agent }: { data: ClinicData; agent: AgentSession }) {
  const board = data.board!;
  const [staffRun, setStaffRun] = useState<StaffRun | null>(null);
  const [text, setText] = useState("");
  const turn = agent.turns[agent.turns.length - 1];
  // Whichever happened last is what the graph and trace show.
  const focus: "agent" | "staff" | null = !turn && !staffRun ? null : !staffRun ? "agent" : !turn ? "staff" : staffRun.at > turn.startedAt ? "staff" : "agent";
  const busy = agent.running || staffRun?.status === "running";

  const { visited, active } = useMemo(() => graphState(focus, turn?.steps ?? [], turn?.status === "running", staffRun), [focus, turn, staffRun]);

  const runStaff = async (label: string, fn: string, body: Record<string, unknown>) => {
    const run: StaffRun = { id: `s${Date.now()}`, label, fn, status: "running", impact: [], at: Date.now() };
    setStaffRun(run);
    try {
      const res = await postJson<{ impact?: string[] }>("/api/actions", body);
      setStaffRun({ ...run, status: "done", impact: res.impact ?? [] });
    } catch (err) {
      setStaffRun({ ...run, status: "error", error: (err as Error).message });
    }
    void data.refresh();
  };

  const send = (message: string) => {
    setStaffRun(null);
    void agent.send(message);
  };

  const phase = busy ? 2 : focus ? 3 : 1;

  return (
    <div className="space-y-4">
      <Steps phase={phase} />

      <div className="grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
        {/* 1. Actions */}
        <div className="space-y-3">
          <Card title="Ask the agent" icon={Bot} hint="Goes through the AI harness">
            <div className="space-y-1.5">
              {AGENT_EVENTS.map((e) => {
                const scenario = data.scenarios.find((s) => s.id === e.id);
                return (
                  <button
                    key={e.id}
                    type="button"
                    disabled={busy || !scenario}
                    onClick={() => scenario && send(scenario.event)}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-xl border bg-card px-3 py-2 text-left transition hover:border-primary disabled:opacity-40",
                      e.danger && "border-qm-emergency/30 hover:border-qm-emergency",
                    )}
                  >
                    <e.icon className={cn("size-4 shrink-0", e.danger ? "text-qm-emergency" : "text-primary")} />
                    <span className="min-w-0">
                      <span className="block text-[13px] font-medium">{e.title}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">{e.tests}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            <form
              className="mt-2 flex gap-1.5"
              onSubmit={(ev) => {
                ev.preventDefault();
                if (text.trim()) send(text.trim());
                setText("");
              }}
            >
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Or type: Dr. Sara is 20 min late"
                className="min-w-0 flex-1 rounded-lg border bg-background px-2.5 py-1.5 text-[13px] outline-none focus:ring-2 focus:ring-ring/40"
              />
              <Button size="icon-sm" type="submit" disabled={busy || !text.trim()}>
                <Send />
              </Button>
            </form>
          </Card>

          <Card title="Do it yourself" icon={Hand} hint="Staff buttons: no AI involved">
            <StaffControls board={board} busy={busy} run={runStaff} />
          </Card>
        </div>

        {/* 2. Harness + 3. Trace */}
        <div className="min-w-0 space-y-4">
          <div className="rounded-2xl border bg-card p-3">
            <div className="mb-1 flex flex-wrap items-center gap-x-4 gap-y-1 px-1">
              <div className="text-sm font-semibold">The harness, live</div>
              <Legend />
              <span className="ml-auto text-[11px] text-muted-foreground">Open “How it works” for the spec of every box</span>
            </div>
            <HarnessGraph mode="live" visited={visited} active={active} badges={liveBadges(data.status, data)} />
          </div>
          <TracePanel focus={focus} turn={turn} staffRun={staffRun} running={agent.running} />
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-baseline gap-2">
          <h2 className="text-sm font-semibold">The clinic floor</h2>
          <span className="text-xs text-muted-foreground">Patients move as the queue replans · chips show whose wait just changed</span>
        </div>
        <ClinicFloor board={board} />
      </div>
    </div>
  );
}

function Steps({ phase }: { phase: number }) {
  const steps = ["Make something happen", "Watch the harness route it", "See the clinic change"];
  return (
    <ol className="flex flex-wrap gap-2">
      {steps.map((s, i) => {
        const n = i + 1;
        const on = phase === n;
        const past = phase > n;
        return (
          <li key={s} className={cn("flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition", on ? "border-primary bg-accent font-semibold" : past ? "text-foreground" : "text-muted-foreground")}>
            <span className={cn("grid size-5 place-items-center rounded-full font-mono text-[11px] font-bold", on || past ? "bg-primary text-primary-foreground" : "bg-muted")}>{past ? "✓" : n}</span>
            {s}
            {on && n === 2 && <Loader2 className="size-3.5 animate-spin text-primary" />}
            {i < steps.length - 1 && <ArrowRight className="ml-1 size-3.5 text-muted-foreground" />}
          </li>
        );
      })}
    </ol>
  );
}

function Card({ title, icon: Icon, hint, children }: { title: string; icon: typeof Bot; hint: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border bg-card p-3">
      <div className="mb-2.5">
        <div className="flex items-center gap-1.5 text-sm font-semibold">
          <Icon className="size-4 text-primary" /> {title}
        </div>
        <div className="text-[11px] text-muted-foreground">{hint}</div>
      </div>
      {children}
    </section>
  );
}

function StaffControls({ board, busy, run }: { board: Board; busy: boolean; run: (label: string, fn: string, body: Record<string, unknown>) => void }) {
  const byId = new Map(board.visits.map((v) => [v.id, v]));
  const nextArrival = board.snapshot.doctors
    .flatMap((d) => d.queue.filter((q) => q.state === "expected"))
    .map((q) => byId.get(q.visitId)!)
    .sort((a, b) => (a.scheduledAt ?? "").localeCompare(b.scheduledAt ?? ""))[0];
  const ref = (v: { token: number | null; id: string }) => (v.token ? `#${v.token}` : v.id);

  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={busy || !nextArrival}
        onClick={() => nextArrival && run(`${nextArrival.patientName} arrives`, `checkIn("${ref(nextArrival)}")`, { action: "check_in", visit: ref(nextArrival) })}
        className="flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left text-[13px] font-medium transition hover:border-primary disabled:opacity-40"
      >
        <LogIn className="size-4 text-primary" />
        <span className="flex-1">{nextArrival ? `#${nextArrival.token} ${nextArrival.patientName.split(" ")[0]} walks in` : "No one due"}</span>
      </button>
      {board.snapshot.doctors.map((d) => {
        const current = d.current ? byId.get(d.current.visitId) : null;
        const next = d.queue.find((q) => q.state === "waiting");
        const short = d.name.replace("Dr. ", "");
        return (
          <div key={d.doctorId} className="rounded-xl bg-muted/40 p-2">
            <div className="mb-1.5 text-[11px] font-semibold text-muted-foreground">{d.name}</div>
            <div className="flex flex-wrap gap-1">
              {current ? (
                <MiniBtn disabled={busy} onClick={() => run(`${short} finishes #${current.token}`, `finishConsult("${ref(current)}")`, { action: "finish_consult", visit: ref(current) })}>
                  <Check /> Finish #{current.token}
                </MiniBtn>
              ) : next ? (
                <MiniBtn disabled={busy || d.status === "off_duty"} onClick={() => run(`${short} calls #${next.token}`, `startConsult("#${next.token}")`, { action: "start_consult", visit: `#${next.token}`, doctor: d.doctorId })}>
                  <ArrowRight /> Call #{next.token}
                </MiniBtn>
              ) : null}
              {d.delayMin > 0 ? (
                <MiniBtn disabled={busy} onClick={() => run(`${short} is back`, `doctorAvailable("${d.name}")`, { action: "doctor_available", doctor: d.doctorId })}>
                  <Timer /> Back now
                </MiniBtn>
              ) : (
                <MiniBtn disabled={busy || d.status === "off_duty"} onClick={() => run(`${short} +15 min late`, `reportDoctorDelay("${d.name}", 15)`, { action: "doctor_delay", doctor: d.doctorId, minutes: 15, reason: "Lab: staff reported delay" })}>
                  <Timer /> +15 min late
                </MiniBtn>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MiniBtn({ children, ...props }: React.ComponentProps<"button">) {
  return (
    <button type="button" {...props} className="inline-flex items-center gap-1 rounded-lg border bg-card px-2 py-1 text-[12px] font-medium transition hover:border-primary disabled:opacity-40 [&_svg]:size-3.5">
      {children}
    </button>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1">
        <span className="h-2 w-5 rounded-full bg-primary" /> running now
      </span>
      <span className="flex items-center gap-1">
        <span className="h-0.5 w-5 bg-primary/70" /> used in this run
      </span>
      <span className="flex items-center gap-1">
        <span className="h-0.5 w-5 bg-foreground/20" /> not needed this time
      </span>
    </div>
  );
}

function graphState(focus: "agent" | "staff" | null, steps: Step[], running: boolean, staffRun: StaffRun | null) {
  const visited = new Set<EdgeId>();
  const active = new Set<EdgeId>();
  if (focus === "staff" && staffRun) {
    for (const e of flowFor("__staff")) (staffRun.status === "running" ? active : visited).add(e);
    return { visited, active };
  }
  if (focus === "agent") {
    for (const e of flowFor("__turn_start")) visited.add(e);
    for (const s of steps) for (const e of flowFor(s.name)) visited.add(e);
    const pending = steps.find((s) => s.result === undefined);
    if (running) {
      for (const e of pending ? flowFor(pending.name) : ["context>budget", "budget>pool", "pool>model"] as EdgeId[]) active.add(e);
    }
  }
  return { visited, active };
}

function liveBadges(status: RouterStatus | null, data: ClinicData): Partial<Record<NodeId, { text: string; tone?: "good" | "warn" | "bad" | "muted" }>> {
  const ready = status?.reasoningPool.filter((m) => m.state === "ready").length ?? 0;
  const total = status?.reasoningPool.length ?? 0;
  const pending = data.notifications.filter((n) => n.status === "pending_approval").length;
  return {
    pool: { text: `${ready}/${total} ready`, tone: ready > 2 ? "good" : ready > 0 ? "warn" : "bad" },
    fast: status?.selfHosted.healthy ? { text: "Llama online", tone: "good" } : { text: "Groq", tone: "muted" },
    decision: status?.decision?.online ? { text: "Laya online", tone: "good" } : { text: "offline", tone: "muted" },
    db: { text: data.live ? "realtime" : "polling", tone: data.live ? "good" : "muted" },
    outbox: pending ? { text: `${pending} to approve`, tone: "warn" } : { text: "empty", tone: "muted" },
    engine: { text: "13 tests", tone: "muted" },
    skills: { text: "5", tone: "muted" },
    t_act: { text: "11", tone: "muted" },
  };
}

function TracePanel({ focus, turn, staffRun, running }: { focus: "agent" | "staff" | null; turn?: AgentSession["turns"][number]; staffRun: StaffRun | null; running: boolean }) {
  const [showBrief, setShowBrief] = useState(true);
  return (
    <section className="flex flex-col rounded-2xl border bg-card">
      <div className="border-b px-4 py-3">
        <div className="text-sm font-semibold">Function calls</div>
        <div className="text-[11px] text-muted-foreground">Every call the harness made, in order, with what it changed</div>
      </div>
      <div className="max-h-[520px] space-y-3 overflow-y-auto px-4 py-3">
        {!focus && (
          <div className="flex items-center gap-3 py-4 text-sm text-muted-foreground">
            <Zap className="size-5 shrink-0 text-primary" />
            Pick an action on the left. Each function call appears here, in order, as the graph lights up.
          </div>
        )}

        {focus === "staff" && staffRun && (
          <div className="space-y-2">
            <Badge>Staff action · no AI</Badge>
            <Call n={1} fn={staffRun.fn} path="Staff → Service layer → Queue engine → Supabase → Views" status={staffRun.status} error={staffRun.error} impact={staffRun.impact} />
          </div>
        )}

        {focus === "agent" && turn && (
          <div className="space-y-2">
            <Badge>{turn.message.startsWith("[EVENT]") ? "Clinic event → agent" : "Message → agent"}</Badge>
            <div className="rounded-lg bg-muted/50 px-2.5 py-1.5 text-[12px]">{turn.message.replace(/^\[EVENT\]\s*/, "")}</div>
            {turn.todos.length > 0 && (
              <div className="rounded-lg border px-2.5 py-2">
                <div className="mb-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">Plan (write_todos)</div>
                {turn.todos.map((t, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-[12px]">
                    {t.status === "completed" ? <Check className="mt-0.5 size-3 text-qm-good" /> : t.status === "in_progress" ? <Loader2 className="mt-0.5 size-3 animate-spin text-primary" /> : <CircleDashed className="mt-0.5 size-3 text-muted-foreground" />}
                    <span className={cn(t.status === "completed" && "text-muted-foreground")}>{t.content}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="grid gap-2 lg:grid-cols-2">
              {turn.steps.map((s, i) => (
                <AgentCall key={s.id} n={i + 1} step={s} />
              ))}
            </div>
            {running && turn.status === "running" && (
              <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> model deciding the next call…
              </div>
            )}
            {turn.status === "error" && <div className="rounded-lg bg-qm-emergency/10 px-2.5 py-2 text-[12px] text-qm-emergency">{turn.error}</div>}
            {turn.text && (
              <div className="rounded-xl border">
                <button type="button" onClick={() => setShowBrief((b) => !b)} className="flex w-full items-center gap-1.5 px-3 py-2 text-[12px] font-semibold">
                  <Sparkles className="size-3.5 text-primary" /> Agent&apos;s briefing to the front desk
                  <ChevronDown className={cn("ml-auto size-3.5 transition", showBrief && "rotate-180")} />
                </button>
                {showBrief && (
                  <div className="prose-qm border-t px-3 py-2 text-[12.5px]">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{turn.text}</ReactMarkdown>
                  </div>
                )}
              </div>
            )}
            {turn.status === "done" && turn.endedAt && (
              <div className="text-[10.5px] text-muted-foreground">
                {turn.steps.length} function calls · {Math.round((turn.endedAt - turn.startedAt) / 1000)}s
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex rounded-full bg-accent px-2 py-0.5 text-[10.5px] font-semibold text-accent-foreground">{children}</span>;
}

const PATH_LABEL: Record<string, string> = {
  read_file: "Model → Playbooks (virtual filesystem)",
  write_todos: "Model → Planner",
  task: "Model → Subagent (isolated context)",
  simulate_options: "Model → Simulate → Sandbox copy (nothing saved)",
  draft_patient_sms: "Model → Communicate → Fast lane → Outbox",
  register_walk_in: "Model → Act → red flags → Laya decision (LLM if unsure) → Service → Engine → DB",
  get_queue_board: "Model → Read → Engine",
  find_patient: "Model → Read → DB",
  visit_history: "Model → Read → Audit log",
  recent_activity: "Model → Read → Audit log",
};

function AgentCall({ n, step }: { n: number; step: Step }) {
  const status = step.result === undefined ? "running" : step.isError ? "error" : "done";
  const parsed = parseResult(step.result) as { impact?: string[] } | unknown[] | null;
  const impact = parsed && !Array.isArray(parsed) ? parsed.impact ?? [] : [];
  const args = Object.entries(step.args)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? `"${v.length > 26 ? `${v.slice(0, 26)}…` : v}"` : Array.isArray(v) ? `[${v.length}]` : JSON.stringify(v)}`)
    .join(", ");
  const meta = STEP_META[step.name];
  return (
    <Call
      n={n}
      fn={`${step.name}(${args})`}
      human={meta?.label(step.args)}
      path={PATH_LABEL[step.name] ?? "Model → Act → Service (guardrails) → Engine → DB → Views"}
      status={status}
      error={step.isError ? step.result?.replace(/^ERROR:\s*/, "") : undefined}
      impact={impact}
    />
  );
}

function Call({ n, fn, human, path, status, error, impact }: { n: number; fn: string; human?: string; path: string; status: "running" | "done" | "error"; error?: string; impact: string[] }) {
  const guardrail = error && /Refused|Policy/i.test(error);
  return (
    <div className="qm-in rounded-xl border px-3 py-2">
      <div className="flex items-start gap-2">
        <span className={cn("mt-0.5 grid size-5 shrink-0 place-items-center rounded-full font-mono text-[10px] font-bold", status === "running" ? "bg-primary/20 text-primary" : status === "error" ? (guardrail ? "bg-qm-urgent text-white" : "bg-qm-emergency text-white") : "bg-qm-good text-white")}>
          {status === "running" ? <Loader2 className="size-3 animate-spin" /> : n}
        </span>
        <div className="min-w-0 flex-1">
          {human && <div className="text-[12.5px] font-medium">{human}</div>}
          <code className="block font-mono text-[11px] break-all text-muted-foreground">{fn}</code>
          <div className="mt-0.5 text-[10.5px] text-primary">{path}</div>
        </div>
      </div>
      {error && <div className={cn("mt-1.5 rounded-md px-2 py-1 text-[11.5px]", guardrail ? "bg-qm-urgent/15" : "bg-qm-emergency/10 text-qm-emergency")}>{guardrail ? "🛡 Guardrail: " : ""}{error}</div>}
      {impact.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {impact.slice(0, 6).map((l) => (
            <ImpactChip key={l} line={l} />
          ))}
          {impact.length > 6 && <span className="text-[10.5px] text-muted-foreground">+{impact.length - 6}</span>}
        </div>
      )}
    </div>
  );
}
