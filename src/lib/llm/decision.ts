// Decision lane ("System 1"): Laya, an open-weight non-autoregressive decision model.
// It answers typed questions (choice / score / yes-no) about a piece of text with calibrated
// probabilities. Confident answers are used directly; anything below the confidence gate goes to
// the LLM fast lane ("System 2"). Every call is logged so Laya can later be fine-tuned here.
//
// Where Laya runs, in order of preference:
//   1. LAYA_URL        — a laya-serve on this machine (local development)
//   2. LAYA_SPACE_URL  — your own laya-serve Space (Jev-compatible /v1/systemone)
//   3. Colab notebook  — registered by heartbeat in runtime_endpoints
//   4. The official public demo Space (convaiinnovations/laya-demo, free ZeroGPU) via its Gradio
//      API — always reachable, wakes itself, nothing to host. Disable with LAYA_PUBLIC_DEMO=0.
import { db } from "../db/client";

const FRESH_MS = 90_000;
const PUBLIC_DEMO = process.env.LAYA_GRADIO_URL ?? "https://convaiinnovations-laya-demo.hf.space";
const PUBLIC_DEMO_ID = process.env.LAYA_GRADIO_SPACE ?? "convaiinnovations/laya-demo";
const publicDemoEnabled = () => process.env.LAYA_PUBLIC_DEMO !== "0";

type Transport = "systemone" | "gradio";
export interface DecisionEndpoint {
  url: string;
  model: string;
  lastSeenAt: string;
  transport: Transport;
  host: "local" | "huggingface" | "colab" | "laya-demo";
}

let cache: { at: number; endpoint: DecisionEndpoint | null } | null = null;

async function colabLaya(): Promise<DecisionEndpoint | null> {
  if (cache && Date.now() - cache.at < 15_000) return cache.endpoint;
  let endpoint: DecisionEndpoint | null = null;
  try {
    const { data } = await db().from("runtime_endpoints").select("url, model, last_seen_at").eq("name", "laya").maybeSingle();
    if (data && Date.now() - new Date(data.last_seen_at).getTime() < FRESH_MS) {
      endpoint = { url: data.url as string, model: data.model as string, lastSeenAt: data.last_seen_at as string, transport: "systemone", host: "colab" };
    }
  } catch {
    endpoint = null;
  }
  cache = { at: Date.now(), endpoint };
  return endpoint;
}

export async function decisionEndpoint(): Promise<DecisionEndpoint | null> {
  const now = new Date().toISOString();
  if (process.env.LAYA_URL) return { url: process.env.LAYA_URL, model: "laya (local)", lastSeenAt: now, transport: "systemone", host: "local" };
  if (process.env.LAYA_SPACE_URL) return { url: process.env.LAYA_SPACE_URL, model: "laya (own Space)", lastSeenAt: now, transport: "systemone", host: "huggingface" };
  const colab = await colabLaya();
  if (colab) return colab;
  if (publicDemoEnabled()) return { url: PUBLIC_DEMO, model: "laya (official demo)", lastSeenAt: now, transport: "gradio", host: "laya-demo" };
  return null;
}

export type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string };

export interface Decision {
  /** The chosen option / scale label, or "yes"/"no" for noul questions. */
  value: string;
  /** Laya's confidence in that answer (for noul: P(yes)). */
  confidence: number;
  /** Per-option probabilities (choice: by label; score: by level label). */
  probabilities?: Record<string, number>;
}

// Response shapes (laya 0.3, Jev wire format):
//   choice → { choice, probabilities: {label: p}, confidence }
//   score  → { score: expected level index (float), probabilities: {"0": p, ...}, legend, confidence }
//   noul   → { noul: P(true), confidence?: max(p, 1-p) }
function parseAnswer(q: Question, raw: Record<string, unknown> | undefined): Decision | null {
  if (!raw) return null;
  const probs = (raw.probabilities ?? {}) as Record<string, number>;
  if (q.type === "noul") {
    const p = Number(raw.noul);
    if (Number.isNaN(p)) return null;
    return { value: p >= 0.5 ? "yes" : "no", confidence: p };
  }
  if (q.type === "score") {
    // Most likely level (argmax), not the rounded expectation: "50% routine / 50% emergency"
    // must not average out to "soon".
    const entries = Object.entries(probs).map(([i, p]) => [Number(i), Number(p)] as const);
    if (!entries.length) return null;
    const [best, p] = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
    const byLabel = Object.fromEntries(entries.map(([i, v]) => [q.criteria[i] ?? String(i), v]));
    return { value: q.criteria[best] ?? String(best), confidence: p, probabilities: byLabel };
  }
  const choice = raw.choice;
  const confidence = Number(raw.confidence);
  if (typeof choice !== "string" || Number.isNaN(confidence)) return null;
  return { value: choice, confidence, probabilities: probs };
}

type RawAnswers = { answers?: Record<string, Record<string, unknown>>; routing?: { model?: string }; model?: string };

/** laya-serve / Jev wire protocol. */
async function callSystemOne(ep: DecisionEndpoint, state: string, questions: Record<string, Question>): Promise<RawAnswers> {
  const res = await fetch(`${ep.url.replace(/\/$/, "")}/v1/systemone`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(process.env.LAYA_API_KEY ? { Authorization: `Bearer ${process.env.LAYA_API_KEY}` } : {}) },
    // typed-decisions: the checkpoint fine-tuned for workflow questions.
    body: JSON.stringify({ state, questions, model: process.env.LAYA_CHECKPOINT ?? "typed-decisions" }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as RawAnswers;
}

/**
 * The official demo Space's "playground" endpoint (Gradio queue API): POST starts a job and
 * returns an event id; GET streams server-sent events until `complete`, whose data is
 * [answersTable, rawResponseJson]. An optional HF_TOKEN raises the free ZeroGPU quota.
 */
async function callGradio(ep: DecisionEndpoint, state: string, questions: Record<string, Question>): Promise<RawAnswers> {
  const base = `${ep.url.replace(/\/$/, "")}/gradio_api/call/run_playground`;
  const auth: Record<string, string> = process.env.HF_TOKEN ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : {};
  const start = await fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({ data: [state, JSON.stringify(questions)] }),
    signal: AbortSignal.timeout(6_000),
  });
  if (!start.ok) throw new Error(`HTTP ${start.status}: ${(await start.text()).slice(0, 200)}`);
  const { event_id: eventId } = (await start.json()) as { event_id?: string };
  if (!eventId) throw new Error("no event id from demo Space");
  const stream = await fetch(`${base}/${eventId}`, { headers: auth, signal: AbortSignal.timeout(9_000) });
  const text = await stream.text();
  const complete = text.match(/event:\s*complete\s*\ndata:\s*(.+)/);
  if (!complete) throw new Error(`demo Space returned no result: ${text.slice(0, 160)}`);
  const payload = JSON.parse(complete[1]) as unknown[];
  const raw = payload.find((p) => typeof p === "string" && p.trim().startsWith("{"));
  if (typeof raw !== "string") throw new Error("demo Space result had no raw response");
  return JSON.parse(raw) as RawAnswers;
}

export interface DecideResult {
  answers: Record<string, Decision>;
  model: string;
  latencyMs: number;
}

/** Ask the decision model. Returns null when it's offline or errors — callers fall back to the LLM. */
export async function decide(purpose: string, state: string, questions: Record<string, Question>): Promise<DecideResult | null> {
  const ep = await decisionEndpoint();
  if (!ep) return null;
  const started = Date.now();
  try {
    const body = ep.transport === "gradio" ? await callGradio(ep, state, questions) : await callSystemOne(ep, state, questions);
    const answers: Record<string, Decision> = {};
    for (const [key, q] of Object.entries(questions)) {
      const parsed = parseAnswer(q, body.answers?.[key]);
      if (parsed) answers[key] = parsed;
    }
    const latencyMs = Date.now() - started;
    await log(purpose, true, latencyMs, ep.model);
    return { answers, model: ep.model, latencyMs };
  } catch (err) {
    await log(purpose, false, Date.now() - started, ep.model, err instanceof Error ? err.message : String(err));
    return null;
  }
}

export interface DecisionHealth {
  online: boolean;
  /** The host is asleep or booting; the check we just sent is waking it. */
  waking: boolean;
  host: "local" | "huggingface" | "colab" | "laya-demo" | null;
  model: string | null;
  lastSeenAt: string | null;
}

let healthCache: { at: number; value: DecisionHealth } | null = null;

/** Is Laya answering right now? Checking a sleeping Space also wakes it. */
export async function decisionHealth(): Promise<DecisionHealth> {
  if (healthCache && Date.now() - healthCache.at < 15_000) return healthCache.value;
  const ep = await decisionEndpoint();
  let value: DecisionHealth;
  if (!ep) {
    value = { online: false, waking: false, host: null, model: null, lastSeenAt: null };
  } else if (ep.host === "colab") {
    value = { online: true, waking: false, host: "colab", model: ep.model, lastSeenAt: ep.lastSeenAt };
  } else if (ep.host === "laya-demo") {
    // Ask the Hub for the Space's runtime stage; requesting the Space page wakes it if it sleeps.
    try {
      const res = await fetch(`https://huggingface.co/api/spaces/${PUBLIC_DEMO_ID}`, { signal: AbortSignal.timeout(4_000), cache: "no-store" });
      const stage = ((await res.json()) as { runtime?: { stage?: string } }).runtime?.stage ?? "UNKNOWN";
      const online = stage === "RUNNING";
      if (!online) void fetch(ep.url, { signal: AbortSignal.timeout(4_000) }).catch(() => undefined);
      value = { online, waking: !online && stage !== "RUNTIME_ERROR", host: "laya-demo", model: ep.model, lastSeenAt: online ? new Date().toISOString() : null };
    } catch {
      value = { online: false, waking: true, host: "laya-demo", model: ep.model, lastSeenAt: null };
    }
  } else {
    try {
      const res = await fetch(`${ep.url.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(4_000), cache: "no-store" });
      const ok = res.ok && /"status"\s*:\s*"ok"/.test(await res.text());
      value = { online: ok, waking: !ok && ep.host === "huggingface", host: ep.host, model: ep.model, lastSeenAt: ok ? new Date().toISOString() : null };
    } catch {
      value = { online: false, waking: ep.host === "huggingface", host: ep.host, model: ep.model, lastSeenAt: null };
    }
  }
  healthCache = { at: Date.now(), value };
  return value;
}

async function log(purpose: string, ok: boolean, latencyMs: number, model: string, error?: string) {
  try {
    await db().from("llm_calls").insert({ lane: "decision", provider: "laya", model, purpose, ok, latency_ms: latencyMs, error: error?.slice(0, 300) ?? null });
  } catch {
    // telemetry must never break the request
  }
}
