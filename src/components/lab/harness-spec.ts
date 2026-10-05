// The QueueMind harness as data: nodes, edges, and which path each function call takes.
// Drives both the "How it works" explorer and the live graph in the Lab.

export type NodeId =
  | "event"
  | "staff"
  | "context"
  | "planner"
  | "skills"
  | "subagent"
  | "budget"
  | "pool"
  | "model"
  | "fast"
  | "decision"
  | "t_read"
  | "t_act"
  | "t_sim"
  | "t_comm"
  | "service"
  | "engine"
  | "sandbox"
  | "db"
  | "outbox"
  | "views";

export type Layer = "trigger" | "harness" | "models" | "tools" | "core";

export interface HarnessNode {
  id: NodeId;
  layer: Layer;
  title: string;
  subtitle: string;
  x: number;
  y: number;
  /** Long-form spec for the explorer panel. */
  spec: string[];
  code?: string;
}

export const LAYERS: { id: Layer; label: string; x: number }[] = [
  { id: "trigger", label: "1 · Trigger", x: 16 },
  { id: "harness", label: "2 · Agent harness", x: 262 },
  { id: "models", label: "3 · Model calls", x: 508 },
  { id: "tools", label: "4 · Tools", x: 754 },
  { id: "core", label: "5 · Clinic core", x: 1000 },
];

export const NODE_W = 214;
export const NODE_H = 58;
const col = (l: Layer) => LAYERS.find((x) => x.id === l)!.x;

export const NODES: HarnessNode[] = [
  {
    id: "event",
    layer: "trigger",
    title: "Clinic event / chat",
    subtitle: "Front desk types or clicks",
    x: col("trigger"),
    y: 70,
    spec: [
      "Free text from the receptionist, or an [EVENT] from the clinic floor (late doctor, walk-in, cancellation…).",
      "[EVENT] messages are handled end-to-end without questions, then reported.",
      "POST /api/agent streams NDJSON: plan, tool calls, results, final briefing.",
    ],
    code: "src/app/api/agent/route.ts",
  },
  {
    id: "staff",
    layer: "trigger",
    title: "Staff button",
    subtitle: "Direct action, no AI",
    x: col("trigger"),
    y: 330,
    spec: [
      "Check in, call next, finish consult, report a delay, reassign, lower priority.",
      "Goes straight to the same service layer the agent uses, with actor = staff.",
      "Only staff may lower a priority (the safety ratchet).",
    ],
    code: "src/app/api/actions/route.ts",
  },
  {
    id: "context",
    layer: "harness",
    title: "Prompt + live board",
    subtitle: "Policy, rules, board snapshot",
    x: col("harness"),
    y: 10,
    spec: [
      "System prompt carries the clinic policy (grace 10 min, no-show 20 min, max 2 overtakes, free follow-up 5 days).",
      "Every message gets the live board attached, so the agent starts informed (one fewer model call).",
      "Rules: numbers come from tools, never computed by the model; emergencies first line.",
    ],
    code: "src/lib/agent/prompt.ts · run.ts",
  },
  {
    id: "planner",
    layer: "harness",
    title: "Planner",
    subtitle: "write_todos checklist",
    x: col("harness"),
    y: 100,
    spec: ["Deep-agent planning tool. Used for 3+ step work; updated in the same step as other calls.", "Streams to the UI as the live plan checklist."],
    code: "langchain todoListMiddleware",
  },
  {
    id: "skills",
    layer: "harness",
    title: "Playbooks (skills)",
    subtitle: "5 files · read-only",
    x: col("harness"),
    y: 190,
    spec: [
      "doctor-delay · walk-in-triage · late-arrivals-and-no-shows · follow-ups · shift-report.",
      "Progressive disclosure: only names + descriptions are in the prompt; the agent opens a playbook with read_file when needed.",
      "Mounted in the virtual filesystem at /skills/ with write permission denied.",
    ],
    code: "src/lib/agent/skills.ts",
  },
  {
    id: "subagent",
    layer: "harness",
    title: "Subagent · ops-analyst",
    subtitle: "Isolated context, read-only",
    x: col("harness"),
    y: 280,
    spec: ["Delegated via the task tool for shift reports and bottleneck analysis.", "Has only read + simulate tools, cannot change the queue. Writes reports to /reports/."],
    code: "src/lib/agent/agent.ts",
  },
  {
    id: "budget",
    layer: "models",
    title: "Call budget",
    subtitle: "≤ 14 model calls / turn",
    x: col("models"),
    y: 10,
    spec: ["modelCallLimitMiddleware ends a turn that drifts.", "Keeps every turn well inside the 300 s serverless limit and the free quota."],
    code: "src/lib/agent/agent.ts",
  },
  {
    id: "pool",
    layer: "models",
    title: "Quota-aware pool",
    subtitle: "model × API key ledger",
    x: col("models"),
    y: 100,
    spec: [
      "Free tiers cap each (project, model): 5 req/min, 20/day on Flash.",
      "Each step goes to the first member with budget left, counted in a shared Supabase ledger so every server instance agrees.",
      "Order: Gemini Flash (×2 keys) → Mistral (free tier, high volume) → Gemini preview/lite → self-hosted Llama on Colab (no quota) → Gemma / Groq.",
      "429 → cool down for the provider's exact retry delay; 503/timeout → 15 s; per-call timeout 40 s.",
      "Hides generic file tools (ls/glob/grep) so smaller models stay on task.",
    ],
    code: "src/lib/llm/pool.ts",
  },
  {
    id: "model",
    layer: "models",
    title: "Reasoning model",
    subtitle: "Gemini · Mistral · own Llama",
    x: col("models"),
    y: 190,
    spec: [
      "Decides which tool to call next and writes the briefing.",
      "Never computes waits, times or fees; it quotes tool output, so a smaller model is enough.",
      "Gemini needs tool schemas converted to its subset; Mistral and Ollama (Llama) take standard JSON schema.",
    ],
    code: "src/lib/llm/models.ts",
  },
  {
    id: "fast",
    layer: "models",
    title: "Fast lane",
    subtitle: "Colab Llama → Groq → Gemini",
    x: col("models"),
    y: 330,
    spec: [
      "Small structured jobs: walk-in intake triage, SMS drafting in the patient's language.",
      "Self-hosted Llama (Colab) when its heartbeat is fresh; else Groq gpt-oss-20b; else Gemini Flash-Lite.",
      "Circuit breaker, zod-validated JSON, deterministic fallback (template) if all fail.",
      "Numbers guard: a draft that invents a number is replaced by the template.",
    ],
    code: "src/lib/llm/router.ts · tasks.ts",
  },
  {
    id: "decision",
    layer: "models",
    title: "Decision model · Laya",
    subtitle: "System 1 · typed answers, <1 s",
    x: col("models"),
    y: 420,
    spec: [
      "Laya (Convai Innovations, Apache-2.0): open-weight, non-autoregressive decision model, an open alternative to TypeSafe Jev.",
      "Patient texts: reads intent (on my way / late / cancel / wait time / medical) with calibrated confidence. Measured: 0.86–0.99 on real texts, so low-risk ones are handled with no LLM.",
      "Walk-in triage: a second opinion. Its emergency signal can only raise priority; specialty/urgency below the 0.75 gate go to the LLM (measured: Laya is weak there zero-shot).",
      "Runs on the official public Laya demo Space (free GPU, wakes itself) via its API; a local laya-serve, your own server or the Colab notebook can take over via Jev's /v1/systemone API, so Kev can be swapped in.",
      "Every decision is logged next to the outcome, ready to fine-tune Laya on this clinic later.",
    ],
    code: "src/lib/llm/decision.ts · tasks.ts (triageWalkIn)",
  },
  {
    id: "t_read",
    layer: "tools",
    title: "Read tools",
    subtitle: "board · patient · history · log",
    x: col("tools"),
    y: 10,
    spec: ["get_queue_board · find_patient · visit_history · recent_activity", "visit_history answers 'why did my position change?' from the audit log."],
  },
  {
    id: "t_act",
    layer: "tools",
    title: "Act tools",
    subtitle: "11 queue-changing actions",
    x: col("tools"),
    y: 100,
    spec: [
      "check_in_patient · register_walk_in · report_doctor_delay · mark_doctor_available · mark_doctor_off_duty",
      "start_consult · finish_consult · book_follow_up · cancel_visit · mark_no_show · raise_priority · reassign_visit",
      "Every action returns its impact: who moved, by how many minutes.",
    ],
  },
  {
    id: "t_sim",
    layer: "tools",
    title: "Simulate",
    subtitle: "what-if before acting",
    x: col("tools"),
    y: 190,
    spec: ["simulate_options compares up to 4 plans (wait vs move patients) on a copy of the clinic.", "Returns longest wait, total waiting-room minutes and per-patient impact. Nothing is saved."],
    code: "src/lib/queue/simulate.ts",
  },
  {
    id: "t_comm",
    layer: "tools",
    title: "Communicate",
    subtitle: "draft_patient_sms",
    x: col("tools"),
    y: 280,
    spec: ["Drafts SMS per patient, in their language. Times/waits filled in by code.", "Duplicates within 20 min skipped. Drafts go to the outbox: never auto-sent."],
  },
  {
    id: "service",
    layer: "core",
    title: "Service layer + guardrails",
    subtitle: "one rulebook for agent & staff",
    x: col("core"),
    y: 10,
    spec: [
      "Safety ratchet: automation can raise priority, never lower it.",
      "Contact before closing: agent can't mark a no-show before a check SMS.",
      "Free follow-up ≤ 5 days (clinic-local dates). Every change logged with actor + reason.",
    ],
    code: "src/lib/clinic/actions.ts",
  },
  {
    id: "engine",
    layer: "core",
    title: "Queue engine",
    subtitle: "pure TS · unit-tested",
    x: col("core"),
    y: 100,
    spec: [
      "Greedy per-doctor simulation: priority tiers → booking/arrival order.",
      "Grace period, no-show cutoff, overrun tail, doctor delay, fairness guard (max 2 overtakes).",
      "Produces waits, start times and alerts. 13 tests.",
    ],
    code: "src/lib/queue/engine.ts",
  },
  {
    id: "sandbox",
    layer: "core",
    title: "Sandbox copy",
    subtitle: "what-if · nothing saved",
    x: col("core"),
    y: 190,
    spec: ["structuredClone of the clinic + hypothetical changes, re-planned by the same engine."],
    code: "src/lib/queue/simulate.ts",
  },
  {
    id: "db",
    layer: "core",
    title: "Supabase",
    subtitle: "visits · events · checkpoints",
    x: col("core"),
    y: 280,
    spec: ["Postgres: doctors, patients, visits, events (audit), notifications (outbox), llm_calls, quota ledger.", "LangGraph checkpointer keeps agent threads. Realtime pushes changes to every view."],
    code: "supabase/schema.sql",
  },
  {
    id: "outbox",
    layer: "core",
    title: "Outbox",
    subtitle: "human approves every SMS",
    x: col("core"),
    y: 370,
    spec: ["Drafts wait for Approve / Edit / Reject at the front desk.", "Patients only ever see approved messages."],
  },
  {
    id: "views",
    layer: "core",
    title: "Live views",
    subtitle: "desk · doctor · patient · TV",
    x: col("core"),
    y: 460,
    spec: ["Every screen re-renders from Supabase Realtime: the board, the doctor's room, the patient's phone, the lobby TV."],
  },
];

export type EdgeId = `${NodeId}>${NodeId}`;

export const EDGES: EdgeId[] = [
  "event>context",
  "context>budget",
  "budget>pool",
  "pool>model",
  "model>planner",
  "model>skills",
  "model>subagent",
  "model>t_read",
  "model>t_act",
  "model>t_sim",
  "model>t_comm",
  "t_read>engine",
  "t_act>service",
  "t_act>fast",
  "t_act>decision",
  "t_sim>sandbox",
  "t_comm>fast",
  "fast>outbox",
  "service>engine",
  "engine>sandbox",
  "service>db",
  "db>views",
  "outbox>views",
  "staff>service",
];

const ACT: EdgeId[] = ["model>t_act", "t_act>service", "service>engine", "service>db", "db>views"];

/** Which edges a function call travels. */
export function flowFor(tool: string): EdgeId[] {
  switch (tool) {
    case "__turn_start":
      return ["event>context", "context>budget", "budget>pool", "pool>model"];
    case "write_todos":
      return ["model>planner"];
    case "read_file":
      return ["model>skills"];
    case "task":
      return ["model>subagent"];
    case "get_queue_board":
    case "find_patient":
    case "visit_history":
    case "recent_activity":
      return ["model>t_read", "t_read>engine"];
    case "simulate_options":
      return ["model>t_sim", "t_sim>sandbox", "engine>sandbox"];
    case "draft_patient_sms":
      return ["model>t_comm", "t_comm>fast", "fast>outbox", "outbox>views"];
    case "register_walk_in":
      return [...ACT, "t_act>decision", "t_act>fast"];
    case "book_follow_up":
    case "finish_consult":
      return [...ACT, "t_act>fast", "fast>outbox"];
    case "__staff":
      return ["staff>service", "service>engine", "service>db", "db>views"];
    default:
      return ACT;
  }
}

export const TOOL_CATALOG: { group: string; node: NodeId; tools: { name: string; does: string; guard?: string }[] }[] = [
  {
    group: "Read",
    node: "t_read",
    tools: [
      { name: "get_queue_board", does: "Live plan per doctor: who's in, who's next, waits, alerts" },
      { name: "find_patient", does: "Search by name/phone → recent visits" },
      { name: "visit_history", does: "Audit trail + current position and why" },
      { name: "recent_activity", does: "Clinic event log" },
    ],
  },
  {
    group: "Act",
    node: "t_act",
    tools: [
      { name: "register_walk_in", does: "Laya triage (LLM if unsure) + fastest doctor + token", guard: "Red flags → Laya → LLM; most severe wins" },
      { name: "check_in_patient", does: "Booked patient arrives", guard: ">10 min late → queued by arrival" },
      { name: "report_doctor_delay", does: "Doctor unavailable for N min; returns who slips" },
      { name: "mark_doctor_available", does: "Doctor back" },
      { name: "mark_doctor_off_duty", does: "Doctor leaves; lists stranded patients" },
      { name: "start_consult", does: "Call a patient in", guard: "Doctors call patients; agent only if asked" },
      { name: "finish_consult", does: "Complete + learn consult time + optional follow-up" },
      { name: "book_follow_up", does: "Follow-up N days later + reminder draft", guard: "Free ≤ 5 days, decided by code" },
      { name: "cancel_visit", does: "Cancel; returns who moves up" },
      { name: "mark_no_show", does: "Close a missed booking", guard: "Needs check SMS first + 20 min" },
      { name: "raise_priority", does: "normal → urgent → emergency", guard: "Can never lower" },
      { name: "reassign_visit", does: "Move a patient to another doctor" },
    ],
  },
  { group: "Simulate", node: "t_sim", tools: [{ name: "simulate_options", does: "Compare plans on a sandbox copy", guard: "Nothing saved" }] },
  { group: "Communicate", node: "t_comm", tools: [{ name: "draft_patient_sms", does: "Draft SMS in patient's language", guard: "Numbers guard + human approval" }] },
];
