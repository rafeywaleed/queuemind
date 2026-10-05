"use client";
// Simulation: the clinic as a little game. Make something happen on the right, watch patients
// move on the floor, and follow the system's path (event → AI → tools → database → …) below.
import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowRight, Bot, Check, Hand, LogIn, Send, Smartphone, Timer, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ClinicScene } from "@/components/sim/scene";
import { agentFlow, FlowLine, patientFlow, staffFlow, type FlowNode } from "@/components/sim/flow";
import { ImpactChip, parseResult, STEP_META } from "@/components/qm/agent-console";
import { LayaChip } from "@/components/qm/laya-status";
import { ClockControls, LiveFeed, Stats } from "@/components/sim/hud";
import { cn } from "@/lib/utils";
import { clock, KIND_LABEL, LANGUAGE_LABEL } from "@/lib/client/format";
import { postJson, type ClinicData } from "@/lib/client/use-clinic";
import type { AgentSession } from "@/lib/client/use-agent";
import type { Board, PatientMessageResult } from "@/lib/client/types";

type Run =
  | { source: "agent"; label: string; at: number }
  | { source: "staff"; label: string; at: number; status: "running" | "done" | "error"; impact: string[]; error?: string }
  | { source: "patient"; label: string; at: number; text: string; visit: string; result: PatientMessageResult | null; failed: boolean };

const EVENTS: { id: string; title: string; hint: string; danger?: boolean }[] = [
  { id: "doctor-late", title: "Doctor called away", hint: "Delay playbook → what-if → SMS" },
  { id: "chest-pain", title: "Chest-pain walk-in", hint: "Red flags → emergency first", danger: true },
  { id: "arrived-ill", title: "Booked patient arrives ill", hint: "Check in → emergency → first free doctor", danger: true },
  { id: "routine-walk-in", title: "Routine walk-in", hint: "Laya triage → fastest doctor" },
  { id: "doctor-leaves", title: "Doctor leaves early", hint: "Move a whole queue" },
  { id: "sweep", title: "Monitoring sweep", hint: "No-shows, overruns" },
  { id: "finish-follow-up", title: "Consult done + follow-up", hint: "Free ≤ 5 days" },
];

const QUICK_TEXTS = ["I'm on my way, 10 minutes", "Running about 15 minutes late, sorry", "How long is the wait?", "Please cancel my appointment today", "My son's fever is getting worse, what should I do?"];

export function SimulationView({ data, agent }: { data: ClinicData; agent: AgentSession }) {
  const board = data.board!;
  const [tab, setTab] = useState<"agent" | "patient" | "staff">("agent");
  const [run, setRun] = useState<Run | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const turn = agent.turns[agent.turns.length - 1];
  const agentTurn = turn && run && turn.startedAt >= run.at ? turn : undefined;
  const busy = agent.running || (run?.source === "staff" && run.status === "running") || (run?.source === "patient" && !run.result && !run.failed);

  const nodes: FlowNode[] = useMemo(() => {
    if (!run) return [];
    if (run.source === "staff") return staffFlow(run.label, run.status, run.impact.length);
    if (run.source === "patient") {
      const pre = patientFlow(run.text, run.result, run.failed);
      return run.result?.handoff && agentTurn ? agentFlow(agentTurn, pre) : pre;
    }
    return agentTurn ? agentFlow(agentTurn) : [{ id: "ev", kind: "event", label: run.label, status: "active" }];
  }, [run, agentTurn]);

  const active = nodes.find((n) => n.status === "active");
  const speech = active
    ? { who: active.kind === "laya" ? ("laya" as const) : active.kind === "staff" || active.kind === "rules" ? ("staff" as const) : ("agent" as const), text: active.label }
    : run && !busy
      ? { who: run.source === "staff" ? ("staff" as const) : run.source === "patient" && !run.result?.handoff ? ("laya" as const) : ("agent" as const), text: "Done. See what changed below." }
      : null;

  const sendAgent = (label: string, message: string) => {
    setRun({ source: "agent", label, at: Date.now() });
    void agent.send(message);
  };

  const staff = async (label: string, body: Record<string, unknown>) => {
    const at = Date.now();
    setRun({ source: "staff", label, at, status: "running", impact: [] });
    try {
      const res = await postJson<{ impact?: string[] }>("/api/actions", body);
      setRun({ source: "staff", label, at, status: "done", impact: res.impact ?? [] });
    } catch (err) {
      setRun({ source: "staff", label, at, status: "error", impact: [], error: (err as Error).message });
      toast.error((err as Error).message);
    }
    void data.refresh();
  };

  const patientText = async (visit: string, text: string) => {
    const at = Date.now();
    const base = { source: "patient" as const, label: text, at, text, visit, result: null, failed: false };
    setRun(base);
    try {
      const result = await postJson<PatientMessageResult>("/api/patient-messages", { visit, text });
      setRun({ ...base, result });
      void data.refresh();
      if (result.handoff && result.agentPrompt) void agent.send(result.agentPrompt);
    } catch (err) {
      setRun({ ...base, failed: true });
      toast.error((err as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-4xl leading-none">Clinic simulation</h1>
          <p className="mt-1 text-sm text-muted-foreground">The clinic runs by itself (10 real seconds = 1 clinic minute). Make something happen on the right, watch the floor react, and follow every step below.</p>
        </div>
        <LayaChip status={data.status} onRefresh={data.refreshStatus} />
      </div>

      <div className="flex flex-wrap items-stretch gap-3">
        <ClockControls board={board} onChange={() => void data.refresh()} />
        <Stats board={board} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-3">
          <ClinicScene board={board} notifications={data.notifications} speech={busy || run ? speech : null} selected={selected} onSelect={setSelected} />
          <LiveFeed events={data.events} timeZone={board.clinic.timezone} />
          <Legend />
        </div>

        <aside className="rounded-3xl border bg-card p-3">
          <div className="mb-3 grid grid-cols-3 gap-1 rounded-xl bg-muted p-1">
            {(
              [
                ["agent", "Agent", Bot],
                ["patient", "Patient SMS", Smartphone],
                ["staff", "Staff", Hand],
              ] as const
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={cn("flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[12.5px] font-medium transition-colors duration-150", tab === id ? "bg-card shadow-sm" : "text-muted-foreground hover:text-foreground")}
              >
                <Icon className="size-3.5" /> {label}
              </button>
            ))}
          </div>
          {tab === "agent" && <AgentTab data={data} busy={busy} onSend={sendAgent} />}
          {tab === "patient" && <PatientTab board={board} busy={busy} onSend={patientText} />}
          {tab === "staff" && <StaffTab board={board} busy={busy} onRun={staff} />}
        </aside>
      </div>

      <section className="rounded-3xl border bg-card p-4">
        <div className="mb-3 flex flex-wrap items-baseline gap-x-3">
          <h2 className="text-sm font-semibold">How the system handled it</h2>
          <span className="text-xs text-muted-foreground">Purple = AI model · Blue = Laya · Amber = tool · Green = database</span>
        </div>
        <FlowLine nodes={nodes} />
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <WhatHappened run={run} turn={agentTurn} />
        <Inspector board={board} visitId={selected} onClose={() => setSelected(null)} />
      </div>
    </div>
  );
}

function AgentTab({ data, busy, onSend }: { data: ClinicData; busy: boolean; onSend: (label: string, message: string) => void }) {
  const [text, setText] = useState("");
  return (
    <div className="space-y-1.5">
      {EVENTS.map((e) => {
        const s = data.scenarios.find((x) => x.id === e.id);
        return (
          <button
            key={e.id}
            type="button"
            disabled={busy || !s}
            onClick={() => s && onSend(e.title, s.event)}
            className={cn(
              "w-full rounded-xl border px-3 py-2 text-left transition-colors duration-150 hover:border-primary disabled:opacity-40",
              e.danger && "border-qm-emergency/30 hover:border-qm-emergency",
            )}
          >
            <div className={cn("text-[13px] font-medium", e.danger && "text-qm-emergency")}>{e.title}</div>
            <div className="text-[11px] text-muted-foreground">{e.hint}</div>
          </button>
        );
      })}
      <form
        className="flex gap-1.5 pt-1"
        onSubmit={(ev) => {
          ev.preventDefault();
          if (text.trim()) onSend(text.trim().slice(0, 40), text.trim());
          setText("");
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. Walk-in: Amir, 45, feeling dizzy"
          className="min-w-0 flex-1 rounded-lg border bg-background px-2.5 py-1.5 text-[13px] outline-none focus:ring-2 focus:ring-ring/40"
        />
        <Button size="icon-sm" type="submit" disabled={busy || !text.trim()}>
          <Send />
        </Button>
      </form>
    </div>
  );
}

function PatientTab({ board, busy, onSend }: { board: Board; busy: boolean; onSend: (visit: string, text: string) => void }) {
  const choices = board.visits.filter((v) => v.status === "scheduled" || v.status === "waiting").sort((a, b) => (a.token ?? 99) - (b.token ?? 99));
  const [visit, setVisit] = useState(choices.find((v) => v.status === "scheduled")?.id ?? choices[0]?.id ?? "");
  const [text, setText] = useState("");
  const v = choices.find((x) => x.id === visit);
  const send = (t: string) => v && onSend(v.token ? `#${v.token}` : v.id, t);
  return (
    <div className="space-y-2.5">
      <p className="text-[12px] text-muted-foreground">A patient replies by SMS. Laya, the decision model, reads it in milliseconds. If it&apos;s sure, the clinic answers instantly; if not, the agent takes over.</p>
      <select value={visit} onChange={(e) => setVisit(e.target.value)} className="w-full rounded-lg border bg-background px-2.5 py-1.5 text-[13px] outline-none">
        {choices.map((c) => (
          <option key={c.id} value={c.id}>
            #{c.token} {c.patientName} · {c.status === "scheduled" ? "booked" : "waiting"}
          </option>
        ))}
      </select>
      {v && <div className="text-[11px] text-muted-foreground">Replies in {LANGUAGE_LABEL[v.patientLanguage] ?? v.patientLanguage}</div>}
      <div className="flex flex-wrap gap-1.5">
        {QUICK_TEXTS.map((t) => (
          <button key={t} type="button" disabled={busy || !v} onClick={() => send(t)} className="rounded-full border bg-card px-2.5 py-1 text-[12px] transition-colors duration-150 hover:border-primary disabled:opacity-40">
            {t}
          </button>
        ))}
      </div>
      <form
        className="flex gap-1.5"
        onSubmit={(ev) => {
          ev.preventDefault();
          if (text.trim()) send(text.trim());
          setText("");
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type the patient's message…" className="min-w-0 flex-1 rounded-lg border bg-background px-2.5 py-1.5 text-[13px] outline-none focus:ring-2 focus:ring-ring/40" />
        <Button size="icon-sm" type="submit" disabled={busy || !text.trim() || !v}>
          <Send />
        </Button>
      </form>
    </div>
  );
}

function StaffTab({ board, busy, onRun }: { board: Board; busy: boolean; onRun: (label: string, body: Record<string, unknown>) => void }) {
  const byId = new Map(board.visits.map((v) => [v.id, v]));
  const nextArrival = board.snapshot.doctors
    .flatMap((d) => d.queue.filter((q) => q.state === "expected"))
    .map((q) => byId.get(q.visitId)!)
    .sort((a, b) => (a.scheduledAt ?? "").localeCompare(b.scheduledAt ?? ""))[0];
  return (
    <div className="space-y-2">
      <p className="text-[12px] text-muted-foreground">Direct actions, no AI. The same clinic rules apply.</p>
      <button
        type="button"
        disabled={busy || !nextArrival}
        onClick={() => nextArrival && onRun(`#${nextArrival.token} arrives`, { action: "check_in", visit: `#${nextArrival.token}` })}
        className="flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left text-[13px] font-medium transition-colors duration-150 hover:border-primary disabled:opacity-40"
      >
        <LogIn className="size-4 text-primary" /> {nextArrival ? `#${nextArrival.token} ${nextArrival.patientName.split(" ")[0]} walks in` : "No one due"}
      </button>
      {board.snapshot.doctors.map((d) => {
        const current = d.current ? byId.get(d.current.visitId) : null;
        const next = d.queue.find((q) => q.state === "waiting");
        const short = d.name.replace("Dr. ", "");
        const btn = "inline-flex items-center gap-1 rounded-lg border bg-card px-2 py-1 text-[12px] font-medium transition-colors duration-150 hover:border-primary disabled:opacity-40 [&_svg]:size-3.5";
        return (
          <div key={d.doctorId} className="rounded-xl bg-muted/50 p-2">
            <div className="mb-1.5 text-[11px] font-semibold text-muted-foreground">{d.name}</div>
            <div className="flex flex-wrap gap-1">
              {current ? (
                <button type="button" className={btn} disabled={busy} onClick={() => onRun(`${short} finishes #${current.token}`, { action: "finish_consult", visit: `#${current.token}` })}>
                  <Check /> Finish #{current.token}
                </button>
              ) : next ? (
                <button type="button" className={btn} disabled={busy || d.status === "off_duty"} onClick={() => onRun(`${short} calls #${next.token}`, { action: "start_consult", visit: `#${next.token}`, doctor: d.doctorId })}>
                  <ArrowRight /> Call #{next.token}
                </button>
              ) : null}
              {d.delayMin > 0 ? (
                <button type="button" className={btn} disabled={busy} onClick={() => onRun(`${short} is back`, { action: "doctor_available", doctor: d.doctorId })}>
                  <Timer /> Back now
                </button>
              ) : (
                <button type="button" className={btn} disabled={busy || d.status === "off_duty"} onClick={() => onRun(`${short} +15 min late`, { action: "doctor_delay", doctor: d.doctorId, minutes: 15, reason: "Simulation" })}>
                  <Timer /> +15 min late
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Legend() {
  const items = [
    ["bg-qm-appointment", "Appointment"],
    ["bg-qm-walkin", "Walk-in"],
    ["bg-qm-followup", "Follow-up"],
    ["bg-qm-urgent", "Urgent"],
    ["bg-qm-emergency", "Emergency"],
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px] text-muted-foreground">
      {items.map(([c, l]) => (
        <span key={l} className="flex items-center gap-1.5">
          <span className={cn("size-2.5 rounded-full", c)} /> {l}
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-full border border-dashed border-foreground/50" /> Not arrived yet
      </span>
      <span>· Click a patient for details</span>
    </div>
  );
}

function WhatHappened({ run, turn }: { run: Run | null; turn?: AgentSession["turns"][number] }) {
  const items: { text: string; impact?: string[]; tone?: "good" | "warn" | "bad" }[] = [];
  if (run?.source === "staff") {
    items.push({ text: run.status === "error" ? `Refused: ${run.error}` : `${run.label}`, impact: run.impact, tone: run.status === "error" ? "bad" : "good" });
  }
  if (run?.source === "patient" && run.result) {
    const r = run.result;
    items.push({ text: `Laya read it as "${r.intent?.replace(/_/g, " ") ?? "unknown"}" (confidence ${r.confidence.toFixed(2)})${r.laya ? ` in ${r.laya.latencyMs} ms` : ""}` });
    items.push({ text: r.outcome, impact: r.impact, tone: r.handoff ? "warn" : "good" });
    if (r.reply) items.push({ text: `Replied instantly: “${r.reply}”`, tone: "good" });
  }
  if (turn) {
    for (const s of turn.steps) {
      if (s.name === "write_todos") continue;
      const parsed = parseResult(s.result) as { impact?: string[] } | unknown[] | null;
      const impact = parsed && !Array.isArray(parsed) ? parsed.impact : undefined;
      const label = STEP_META[s.name]?.label(s.args) ?? s.name;
      items.push({ text: s.isError ? `${label}: ${s.result?.replace(/^ERROR:\s*/, "")}` : label, impact, tone: s.isError ? "warn" : undefined });
    }
  }
  return (
    <section className="rounded-3xl border bg-card p-4">
      <h2 className="mb-2 text-sm font-semibold">What happened</h2>
      {!items.length && !turn?.text && <p className="text-sm text-muted-foreground">Nothing yet. Try “Doctor called away”, or send a patient text.</p>}
      <ul className="space-y-2">
        {items.map((it, i) => (
          <li key={i} className="flex gap-2.5 text-[13px]">
            <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", it.tone === "good" ? "bg-qm-good" : it.tone === "warn" ? "bg-qm-urgent" : it.tone === "bad" ? "bg-qm-emergency" : "bg-primary")} />
            <div className="min-w-0">
              <div>{it.text}</div>
              {it.impact && it.impact.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {it.impact.slice(0, 6).map((l) => (
                    <ImpactChip key={l} line={l} />
                  ))}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
      {turn?.text && (
        <div className="prose-qm mt-3 rounded-2xl bg-muted/50 px-3.5 py-3 text-[13px]">
          <div className="mb-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">Agent&apos;s briefing</div>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{turn.text}</ReactMarkdown>
        </div>
      )}
      {turn?.status === "error" && <div className="mt-2 rounded-xl bg-qm-emergency/10 px-3 py-2 text-[12px] text-qm-emergency">{turn.error}</div>}
    </section>
  );
}

function Inspector({ board, visitId, onClose }: { board: Board; visitId: string | null; onClose: () => void }) {
  const v = board.visits.find((x) => x.id === visitId);
  const planned = board.snapshot.doctors.flatMap((d) => d.queue.map((q) => ({ q, d }))).find((x) => x.q.visitId === visitId);
  const doctor = board.doctors.find((d) => d.id === v?.doctorId);
  const tz = board.clinic.timezone;
  return (
    <section className="rounded-3xl border bg-card p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Patient</h2>
        {v && (
          <button type="button" onClick={onClose} className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted" aria-label="Close">
            <X className="size-3.5" />
          </button>
        )}
      </div>
      {!v ? (
        <p className="text-sm text-muted-foreground">Click a patient on the floor to see who they are and why they&apos;re where they are.</p>
      ) : (
        <div className="space-y-2 text-[13px]">
          <div>
            <div className="font-mono text-xs text-muted-foreground">#{v.token ?? "—"}</div>
            <div className="text-lg font-semibold">{v.patientName}</div>
            <div className="text-muted-foreground">
              {KIND_LABEL[v.kind]} · {doctor?.name} · {v.priority !== "normal" ? <b className="text-qm-emergency">{v.priority}</b> : "normal priority"}
            </div>
          </div>
          {v.reason && <div className="rounded-lg bg-muted/50 px-2.5 py-1.5">{v.reason}</div>}
          {planned ? (
            <div>
              Position <b>{planned.q.position}</b> · starts ~<b>{clock(planned.q.etaStart, tz)}</b> · wait <b>{planned.q.waitMin} min</b>
              {planned.q.projectedDelayMin ? <span className="text-qm-urgent"> · {planned.q.projectedDelayMin} min behind booking</span> : null}
            </div>
          ) : (
            <div className="text-muted-foreground">Status: {v.status.replace("_", " ")}</div>
          )}
          {planned?.q.flags.map((f) => (
            <div key={f} className="text-[12px] text-qm-urgent">
              {f}
            </div>
          ))}
          <div className="text-[11px] text-muted-foreground">
            {v.patientPhone} · {LANGUAGE_LABEL[v.patientLanguage] ?? v.patientLanguage}
          </div>
        </div>
      )}
    </section>
  );
}
