// Two-lane model routing.
//  - Fast lane: small, frequent, structured tasks (intake parsing, triage second opinion, SMS drafts).
//    Tries self-hosted Llama on Colab -> Groq gpt-oss-20b -> Gemini Flash-Lite, with a circuit breaker.
//  - Reasoning lane: the deep agent itself (see models.ts).
// Every call is logged to llm_calls so the UI can show which provider is serving and how fast.
import { z } from "zod";
import { db } from "../db/client";

export type ProviderName = "colab" | "groq" | "gemini";

interface Provider {
  name: ProviderName;
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
}

const COLAB_FRESH_MS = 90_000;
const BREAKER_THRESHOLD = 2;
const BREAKER_COOLDOWN_MS = 60_000;

const breaker = new Map<ProviderName, { failures: number; openUntil: number }>();
let colabCache: { at: number; endpoint: { url: string; model: string; lastSeenAt: string } | null } | null = null;

/** The Colab notebook registers its tunnel URL + heartbeat in runtime_endpoints. */
export async function colabEndpoint() {
  if (colabCache && Date.now() - colabCache.at < 15_000) return colabCache.endpoint;
  let endpoint = null;
  try {
    const { data } = await db().from("runtime_endpoints").select("url, model, last_seen_at").eq("name", "colab").maybeSingle();
    if (data && Date.now() - new Date(data.last_seen_at).getTime() < COLAB_FRESH_MS) {
      endpoint = { url: data.url as string, model: data.model as string, lastSeenAt: data.last_seen_at as string };
    }
  } catch {
    endpoint = null;
  }
  colabCache = { at: Date.now(), endpoint };
  return endpoint;
}

async function fastProviders(): Promise<Provider[]> {
  const providers: Provider[] = [];
  const colab = await colabEndpoint();
  if (colab) providers.push({ name: "colab", baseUrl: `${colab.url.replace(/\/$/, "")}/v1`, model: colab.model, timeoutMs: 8_000 });
  if (process.env.GROQ_API_KEY) {
    providers.push({
      name: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: process.env.GROQ_API_KEY,
      model: process.env.GROQ_FAST_MODEL ?? "openai/gpt-oss-20b",
      timeoutMs: 10_000,
    });
  }
  if (process.env.GOOGLE_API_KEY) {
    providers.push({
      name: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: process.env.GOOGLE_API_KEY,
      model: process.env.GEMINI_FAST_MODEL ?? "gemini-3.5-flash-lite",
      timeoutMs: 15_000,
    });
  }
  return providers.filter((p) => (breaker.get(p.name)?.openUntil ?? 0) < Date.now());
}

function recordOutcome(name: ProviderName, ok: boolean) {
  if (ok) return breaker.delete(name);
  const state = breaker.get(name) ?? { failures: 0, openUntil: 0 };
  state.failures++;
  if (state.failures >= BREAKER_THRESHOLD) {
    state.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
    state.failures = 0;
  }
  breaker.set(name, state);
}

async function logCall(row: { lane: string; provider: string; model: string; purpose: string; ok: boolean; latency_ms: number; error?: string }) {
  try {
    await db().from("llm_calls").insert({ ...row, error: row.error?.slice(0, 300) ?? null });
  } catch {
    // telemetry must never break the request
  }
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  return JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw);
}

export interface FastResult<T> {
  data: T;
  provider: ProviderName;
  model: string;
  latencyMs: number;
}

/**
 * Run a small structured task on the fast lane. The output is validated with zod;
 * a provider that times out, errors, or returns invalid JSON is skipped for the next one.
 */
export async function fastJson<T>(opts: { purpose: string; system: string; user: string; schema: z.ZodType<T>; maxTokens?: number }): Promise<FastResult<T>> {
  const providers = await fastProviders();
  if (!providers.length) throw new Error("No fast-lane model available (set GROQ_API_KEY or GOOGLE_API_KEY, or start the Colab runtime)");
  const errors: string[] = [];
  for (const p of providers) {
    const started = Date.now();
    try {
      const res = await fetch(`${p.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}) },
        body: JSON.stringify({
          model: p.model,
          temperature: 0,
          max_tokens: opts.maxTokens ?? 400,
          response_format: { type: "json_object" },
          // gpt-oss models reason before answering; keep it short so the token budget goes to the answer.
          ...(p.model.includes("gpt-oss") ? { reasoning_effort: "low" } : {}),
          messages: [
            { role: "system", content: `${opts.system}\nRespond with a single JSON object only.` },
            { role: "user", content: opts.user },
          ],
        }),
        signal: AbortSignal.timeout(p.timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const body = await res.json();
      const data = opts.schema.parse(extractJson(body.choices?.[0]?.message?.content ?? ""));
      const latencyMs = Date.now() - started;
      recordOutcome(p.name, true);
      await logCall({ lane: "fast", provider: p.name, model: p.model, purpose: opts.purpose, ok: true, latency_ms: latencyMs });
      return { data, provider: p.name, model: p.model, latencyMs };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${p.name}: ${message}`);
      recordOutcome(p.name, false);
      await logCall({ lane: "fast", provider: p.name, model: p.model, purpose: opts.purpose, ok: false, latency_ms: Date.now() - started, error: message });
    }
  }
  throw new Error(`All fast-lane providers failed — ${errors.join(" | ")}`);
}

/** For the status pill: is self-hosted Llama up, and how is each provider performing? */
export async function routerStatus() {
  colabCache = null;
  const colab = await colabEndpoint();
  let colabHealthy = false;
  let colabPingMs: number | null = null;
  if (colab) {
    const started = Date.now();
    try {
      const res = await fetch(`${colab.url.replace(/\/$/, "")}/api/tags`, { signal: AbortSignal.timeout(4_000) });
      colabHealthy = res.ok;
      colabPingMs = Date.now() - started;
    } catch {
      colabHealthy = false;
    }
  }
  const since = new Date(Date.now() - 3_600_000).toISOString();
  const { data: calls } = await db().from("llm_calls").select("provider, ok, latency_ms, lane").eq("lane", "fast").gte("created_at", since).limit(1000);
  const stats: Record<string, { calls: number; ok: number; avgLatencyMs: number | null }> = {};
  for (const c of calls ?? []) {
    const s = (stats[c.provider] ??= { calls: 0, ok: 0, avgLatencyMs: null });
    s.calls++;
    if (c.ok) {
      s.avgLatencyMs = Math.round(((s.avgLatencyMs ?? 0) * s.ok + (c.latency_ms ?? 0)) / (s.ok + 1));
      s.ok++;
    }
  }
  return {
    selfHosted: { registered: !!colab, healthy: colabHealthy, pingMs: colabPingMs, model: colab?.model ?? null, lastSeenAt: colab?.lastSeenAt ?? null },
    fastLaneOrder: [...(colabHealthy ? ["colab"] : []), ...(process.env.GROQ_API_KEY ? ["groq"] : []), ...(process.env.GOOGLE_API_KEY ? ["gemini"] : [])],
    reasoning: { provider: process.env.MAIN_MODEL_PROVIDER ?? "gemini" },
    lastHour: stats,
  };
}
