"use client";
// The whole system on one page. Pick a journey and it plays: each hop lights up in order with a
// plain-language caption, so you can follow a request from a screen, through the brains and the
// rules, into the database, and back to every screen.
import { useEffect, useMemo, useState } from "react";
import { Bot, Hand, Pause, Play, Smartphone, Timer } from "lucide-react";
import { cn } from "@/lib/utils";

type Col = "screens" | "api" | "brains" | "models" | "core" | "data";
interface MapNode {
  id: string;
  col: Col;
  row: number;
  title: string;
  sub: string;
}

const COLS: { id: Col; label: string }[] = [
  { id: "screens", label: "Screens (Next.js)" },
  { id: "api", label: "API routes (Vercel)" },
  { id: "brains", label: "Decides" },
  { id: "models", label: "Models" },
  { id: "core", label: "Rules & engine" },
  { id: "data", label: "Data (Supabase)" },
];

const W = 196;
const H = 54;
const GAP = 36;
const TOP = 46;
const ROW = 74;
const colX = (c: Col) => 14 + COLS.findIndex((x) => x.id === c) * (W + GAP);
const WIDTH = 14 + COLS.length * (W + GAP);
const HEIGHT = TOP + 6 * ROW + 10;

const NODES: MapNode[] = [
  { id: "desk", col: "screens", row: 0, title: "Front desk / Simulation", sub: "events, chat, staff buttons" },
  { id: "doctor", col: "screens", row: 1, title: "Doctor screen", sub: "finish, call next, I'm late" },
  { id: "phone", col: "screens", row: 2, title: "Patient phone", sub: "SMS in / out" },
  { id: "tv", col: "screens", row: 3, title: "Lobby TV · Manager", sub: "tokens only · audit" },
  { id: "approve", col: "screens", row: 4, title: "Outbox", sub: "human approves SMS" },

  { id: "a_agent", col: "api", row: 0, title: "/api/agent", sub: "streams the agent's steps" },
  { id: "a_actions", col: "api", row: 1, title: "/api/actions", sub: "staff actions" },
  { id: "a_pm", col: "api", row: 2, title: "/api/patient-messages", sub: "inbound SMS" },
  { id: "a_board", col: "api", row: 3, title: "/api/board", sub: "plan + autopilot tick" },
  { id: "a_clock", col: "api", row: 4, title: "/api/sim/clock · /status", sub: "play/pause · model health" },

  { id: "harness", col: "brains", row: 0, title: "Deep agent harness", sub: "plan · playbooks · 18 tools" },
  { id: "flags", col: "brains", row: 2, title: "Red-flag rules", sub: "code, runs first" },
  { id: "laya", col: "brains", row: 3, title: "Laya decision model", sub: "typed answers ~0.3 s" },
  { id: "autopilot", col: "brains", row: 4, title: "Autopilot", sub: "arrivals, consults, walk-ins" },

  { id: "pool", col: "models", row: 0, title: "Reasoning pool", sub: "Gemini ×2 · Mistral · Llama" },
  { id: "fast", col: "models", row: 2, title: "Fast lane", sub: "Groq · Mistral · Gemini" },
  { id: "space", col: "models", row: 3, title: "Laya host", sub: "official demo Space · Colab" },

  { id: "service", col: "core", row: 0, title: "Service layer", sub: "guardrails, one rulebook" },
  { id: "engine", col: "core", row: 1, title: "Queue engine", sub: "waits, order, fees · tested" },
  { id: "clock", col: "core", row: 4, title: "Clinic clock", sub: "6× · shared by all servers" },

  { id: "db", col: "data", row: 0, title: "Postgres tables", sub: "visits · events · outbox · SMS" },
  { id: "ckpt", col: "data", row: 1, title: "Agent memory", sub: "LangGraph checkpoints" },
  { id: "ledger", col: "data", row: 2, title: "Quota ledger", sub: "per model × key" },
  { id: "rt", col: "data", row: 3, title: "Realtime", sub: "pushes changes to screens" },
];

interface Step {
  from: string;
  to: string;
  caption: string;
}

const JOURNEYS: { id: string; title: string; icon: typeof Bot; blurb: string; steps: Step[] }[] = [
  {
    id: "agent",
    title: "Agent event",
    icon: Bot,
    blurb: '"Dr. Ayesha is called away for 35 min"',
    steps: [
      { from: "desk", to: "a_agent", caption: "The front desk sends the event; the server attaches the live board." },
      { from: "a_agent", to: "harness", caption: "The deep agent loads the thread from memory and reads its playbook." },
      { from: "harness", to: "ckpt", caption: "Conversation state is checkpointed in Postgres." },
      { from: "harness", to: "pool", caption: "Each step asks a model; the pool picks one with free quota." },
      { from: "pool", to: "ledger", caption: "The call is counted in the shared quota ledger." },
      { from: "harness", to: "service", caption: "The model calls a tool: report_doctor_delay." },
      { from: "service", to: "engine", caption: "Rules check it; the engine replans every doctor's queue." },
      { from: "engine", to: "db", caption: "The change and who it affected are saved and logged." },
      { from: "harness", to: "fast", caption: "SMS drafts for delayed patients are written in their language." },
      { from: "fast", to: "db", caption: "Drafts land in the outbox: nothing is sent yet." },
      { from: "db", to: "rt", caption: "Realtime notices the change…" },
      { from: "rt", to: "desk", caption: "…and every screen updates; the briefing streams back." },
      { from: "approve", to: "db", caption: "A person approves each SMS before a patient sees it." },
    ],
  },
  {
    id: "sms",
    title: "Patient SMS",
    icon: Smartphone,
    blurb: '"Running 15 min late, sorry"',
    steps: [
      { from: "phone", to: "a_pm", caption: "A patient texts the clinic." },
      { from: "a_pm", to: "flags", caption: "Red-flag rules run first: chest pain etc. always escalate." },
      { from: "flags", to: "laya", caption: "Laya answers typed questions: what does the patient want? needs a human?" },
      { from: "laya", to: "space", caption: "Laya runs on the official public Laya Space (free GPU), or Colab / a local server." },
      { from: "laya", to: "service", caption: "Confident & low-risk → code acts directly. No LLM." },
      { from: "service", to: "engine", caption: "Wait-time answers come from the engine, never a model." },
      { from: "engine", to: "db", caption: "The message, Laya's read and the outcome are logged." },
      { from: "db", to: "rt", caption: "Realtime pushes it…" },
      { from: "rt", to: "phone", caption: "…the patient gets an instant factual reply in their language." },
      { from: "laya", to: "harness", caption: "Unsure, medical or cancel → handed to the agent with Laya's read." },
    ],
  },
  {
    id: "staff",
    title: "Staff button",
    icon: Hand,
    blurb: '"Finish consult + follow-up in 4 days"',
    steps: [
      { from: "doctor", to: "a_actions", caption: "A doctor taps a button. No AI involved." },
      { from: "a_actions", to: "service", caption: "The same rulebook the agent uses (staff may lower priority; the agent can't)." },
      { from: "service", to: "engine", caption: "Follow-up fee rule (free ≤ 5 days) and replanning run in code." },
      { from: "engine", to: "db", caption: "Saved with actor = staff in the audit log." },
      { from: "db", to: "rt", caption: "Realtime…" },
      { from: "rt", to: "tv", caption: "…the lobby TV calls the next token; the manager sees it in the audit trail." },
    ],
  },
  {
    id: "tick",
    title: "Clock tick",
    icon: Timer,
    blurb: "every few seconds while the clinic runs",
    steps: [
      { from: "desk", to: "a_board", caption: "Any open screen asks for the board every 3 s." },
      { from: "a_board", to: "clock", caption: "Clinic time = real time × speed (6×: 10 s = 1 min)." },
      { from: "a_board", to: "engine", caption: "The engine computes waits and alerts at clinic time." },
      { from: "a_board", to: "autopilot", caption: "After responding, one server claims the tick (atomic)." },
      { from: "autopilot", to: "service", caption: "Patients arrive, consults end, doctors call the next patient, walk-ins appear." },
      { from: "service", to: "db", caption: "Every move is logged as actor = system." },
      { from: "db", to: "rt", caption: "Realtime…" },
      { from: "rt", to: "desk", caption: "…patients walk across the simulation floor." },
      { from: "a_clock", to: "space", caption: "The status check also checks Laya's Space and wakes it if it's asleep." },
    ],
  },
];

const byId = new Map(NODES.map((n) => [n.id, n]));
const pos = (n: MapNode) => ({ x: colX(n.col), y: TOP + n.row * ROW });

function path(from: string, to: string) {
  const a = pos(byId.get(from)!);
  const b = pos(byId.get(to)!);
  if (a.x === b.x) {
    const x = a.x + W / 2;
    const down = b.y > a.y;
    return `M ${x} ${down ? a.y + H : a.y} L ${x} ${down ? b.y : b.y + H}`;
  }
  const fwd = b.x > a.x;
  const x1 = fwd ? a.x + W : a.x;
  const x2 = fwd ? b.x : b.x + W;
  const y1 = a.y + H / 2;
  const y2 = b.y + H / 2;
  const dx = Math.max(30, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + (fwd ? dx : -dx)} ${y1}, ${x2 - (fwd ? dx : -dx)} ${y2}, ${x2} ${y2}`;
}

export function SystemMap() {
  const [journey, setJourney] = useState(JOURNEYS[0].id);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(true);
  const j = JOURNEYS.find((x) => x.id === journey)!;

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setStep((s) => (s + 1) % (j.steps.length + 2)), 1300);
    return () => clearInterval(t);
  }, [playing, j.steps.length]);

  const allEdges = useMemo(() => {
    const seen = new Map<string, Step>();
    for (const jj of JOURNEYS) for (const s of jj.steps) seen.set(`${s.from}>${s.to}`, s);
    return [...seen.keys()];
  }, []);
  const shown = Math.min(step, j.steps.length);
  const lit = new Set(j.steps.slice(0, shown).map((s) => `${s.from}>${s.to}`));
  const current = shown > 0 && step <= j.steps.length ? j.steps[shown - 1] : null;
  const curKey = current ? `${current.from}>${current.to}` : null;
  const litNodes = new Set(j.steps.slice(0, shown).flatMap((s) => [s.from, s.to]));

  return (
    <section className="rounded-3xl border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="mr-2 text-lg font-semibold">System map</h2>
        {JOURNEYS.map((x) => (
          <button
            key={x.id}
            type="button"
            onClick={() => {
              setJourney(x.id);
              setStep(0);
              setPlaying(true);
            }}
            className={cn("inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors duration-150", journey === x.id ? "border-primary bg-primary text-primary-foreground" : "hover:border-primary")}
          >
            <x.icon className="size-4" /> {x.title}
          </button>
        ))}
        <button type="button" onClick={() => setPlaying((p) => !p)} className="ml-auto inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px]">
          {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />} {playing ? "Pause" : "Play"}
        </button>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-auto w-full" role="img" aria-label="QueueMind system map">
          <defs>
            <marker id="sm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
            </marker>
          </defs>
          {COLS.map((c) => (
            <g key={c.id}>
              <rect x={colX(c.id) - 7} y={TOP - 12} width={W + 14} height={HEIGHT - TOP + 6} rx={14} className="fill-foreground/[0.025]" />
              <text x={colX(c.id)} y={22} className="fill-muted-foreground text-[12px] font-semibold tracking-wider uppercase">
                {c.label}
              </text>
            </g>
          ))}
          {allEdges.map((k) => {
            const [from, to] = k.split(">");
            const on = lit.has(k);
            const cur = k === curKey;
            return (
              <g key={k} className={cn(cur ? "text-primary" : on ? "text-primary/60" : "text-foreground/15")}>
                <path d={path(from, to)} fill="none" stroke="currentColor" strokeWidth={cur ? 3 : on ? 2 : 1.2} markerEnd="url(#sm-arrow)" strokeDasharray={cur ? "8 6" : undefined} className={cn(cur && "qm-flow")} />
                {cur && (
                  <circle r={5} className="fill-primary">
                    <animateMotion dur="1.1s" repeatCount="indefinite" path={path(from, to)} />
                  </circle>
                )}
              </g>
            );
          })}
          {NODES.map((n) => {
            const p = pos(n);
            const on = litNodes.has(n.id);
            const cur = current && (current.from === n.id || current.to === n.id);
            return (
              <g key={n.id} transform={`translate(${p.x} ${p.y})`} className={cn("transition-opacity duration-300", shown > 0 && !on && "opacity-40")}>
                <rect width={W} height={H} rx={12} className={cn("stroke-[1.5]", cur ? "fill-primary stroke-primary" : on ? "fill-card stroke-primary" : "fill-card stroke-border")} />
                <text x={12} y={22} className={cn("text-[13.5px] font-semibold", cur ? "fill-primary-foreground" : "fill-foreground")}>
                  {n.title}
                </text>
                <text x={12} y={40} className={cn("text-[11px]", cur ? "fill-primary-foreground/85" : "fill-muted-foreground")}>
                  {n.sub}
                </text>
              </g>
            );
          })}
        </svg>

        <div>
          <div className="mb-2 rounded-2xl bg-muted/60 px-3 py-2 text-[13px]">
            <span className="font-semibold">{j.title}</span> <span className="text-muted-foreground">{j.blurb}</span>
          </div>
          <ol className="space-y-1">
            {j.steps.map((s, i) => (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => {
                    setStep(i + 1);
                    setPlaying(false);
                  }}
                  className={cn(
                    "flex w-full gap-2 rounded-xl px-2 py-1.5 text-left text-[12.5px] transition-colors duration-150",
                    i + 1 === shown && step <= j.steps.length ? "bg-accent font-medium" : i < shown ? "text-foreground" : "text-muted-foreground hover:bg-muted/60",
                  )}
                >
                  <span className={cn("grid size-5 shrink-0 place-items-center rounded-full font-mono text-[10px] font-bold", i < shown ? "bg-primary text-primary-foreground" : "bg-muted")}>{i + 1}</span>
                  {s.caption}
                </button>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
