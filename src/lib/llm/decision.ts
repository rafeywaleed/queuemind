// Decision lane ("System 1"): Laya, an open-weight non-autoregressive decision model.
// It answers typed questions (choice / score / yes-no) about a piece of text with calibrated
// probabilities in ~33 ms on a T4. Served by `laya-serve` on the Colab notebook, which speaks
// TypeSafe Jev's /v1/systemone contract, so Kev (or Jev itself) can be swapped in by URL.
// Confident answers are used directly; anything below the confidence gate goes to the LLM
// fast lane ("System 2"). Every call is logged so Laya can later be fine-tuned on this clinic.
import { db } from "../db/client";

const FRESH_MS = 90_000;
let cache: { at: number; endpoint: { url: string; model: string; lastSeenAt: string } | null } | null = null;

export async function decisionEndpoint() {
  if (cache && Date.now() - cache.at < 15_000) return cache.endpoint;
  let endpoint = null;
  try {
    const { data } = await db().from("runtime_endpoints").select("url, model, last_seen_at").eq("name", "laya").maybeSingle();
    if (data && Date.now() - new Date(data.last_seen_at).getTime() < FRESH_MS) {
      endpoint = { url: data.url as string, model: data.model as string, lastSeenAt: data.last_seen_at as string };
    }
  } catch {
    endpoint = null;
  }
  cache = { at: Date.now(), endpoint };
  return endpoint;
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
//   noul   → { noul: P(true), confidence: max(p, 1-p) }
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
    const res = await fetch(`${ep.url.replace(/\/$/, "")}/v1/systemone`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // typed-decisions: the checkpoint fine-tuned for workflow questions (base checkpoints are near chance zero-shot).
      body: JSON.stringify({ state, questions, model: process.env.LAYA_CHECKPOINT ?? "typed-decisions" }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { answers?: Record<string, Record<string, unknown>>; routing?: { model?: string } };
    const answers: Record<string, Decision> = {};
    for (const [key, q] of Object.entries(questions)) {
      const parsed = parseAnswer(q, body.answers?.[key]);
      if (parsed) answers[key] = parsed;
    }
    const latencyMs = Date.now() - started;
    await log(purpose, true, latencyMs, ep.model);
    return { answers, model: body.routing?.model ?? ep.model, latencyMs };
  } catch (err) {
    await log(purpose, false, Date.now() - started, ep.model, err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function log(purpose: string, ok: boolean, latencyMs: number, model: string, error?: string) {
  try {
    await db().from("llm_calls").insert({ lane: "decision", provider: "laya", model, purpose, ok, latency_ms: latencyMs, error: error?.slice(0, 300) ?? null });
  } catch {
    // telemetry must never break the request
  }
}
