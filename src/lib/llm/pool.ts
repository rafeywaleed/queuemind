// Quota-aware model pool for the reasoning lane, as LangChain agent middleware.
//
// Free tiers cap each (project, model) separately: Gemini Flash allows 5 requests/min and
// 20/day. Each agent step goes to the best pool member (model × API key) that still has budget.
// Budgets are read from a shared ledger in Supabase (llm_calls + model_cooldowns), so every
// serverless instance sees the same counts and we avoid the 429 instead of discovering it.
import { createMiddleware } from "langchain";
import { db } from "../db/client";
import { reasoningPool, type PoolMember } from "./models";
import { colabEndpoint } from "./router";

const RPM = Number(process.env.REASONING_RPM_PER_MODEL ?? 5);
const CALL_TIMEOUT_MS = Number(process.env.REASONING_CALL_TIMEOUT_MS ?? 40_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Generic filesystem tools the clinic agent never needs; hiding them stops weaker models wandering. */
const HIDDEN_TOOLS = new Set(["ls", "glob", "grep", "edit_file", "execute"]);

/** Google resets free-tier daily quotas at midnight Pacific time. */
function quotaDayStart(now = new Date()): Date {
  const pacific = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const offset = now.getTime() - pacific.getTime();
  pacific.setHours(0, 0, 0, 0);
  return new Date(pacific.getTime() + offset);
}

interface Ledger {
  at: number;
  minute: Map<string, number[]>; // member -> call timestamps in the last 60 s
  today: Map<string, number>; // member -> calls since quota-day start
  cooldown: Map<string, number>; // member -> until (ms)
}

let ledgerCache: Ledger | null = null;

async function loadLedger(): Promise<Ledger> {
  if (ledgerCache && Date.now() - ledgerCache.at < 2_000) return ledgerCache;
  const ledger: Ledger = { at: Date.now(), minute: new Map(), today: new Map(), cooldown: new Map() };
  try {
    const [calls, cooldowns] = await Promise.all([
      db().from("llm_calls").select("member, created_at").eq("lane", "reasoning").gte("created_at", quotaDayStart().toISOString()).limit(5000),
      db().from("model_cooldowns").select("member, until").gt("until", new Date().toISOString()),
    ]);
    const minuteAgo = Date.now() - 60_000;
    for (const c of calls.data ?? []) {
      if (!c.member) continue;
      ledger.today.set(c.member, (ledger.today.get(c.member) ?? 0) + 1);
      const t = new Date(c.created_at).getTime();
      if (t > minuteAgo) ledger.minute.set(c.member, [...(ledger.minute.get(c.member) ?? []), t]);
    }
    for (const c of cooldowns.data ?? []) ledger.cooldown.set(c.member, new Date(c.until).getTime());
  } catch {
    // Ledger unavailable: fall back to "everything has budget" and let 429 handling do the work.
  }
  ledgerCache = ledger;
  return ledger;
}

/** Record the attempt locally right away so parallel steps in this instance see it too. */
function noteLocally(member: string, t: number) {
  if (!ledgerCache) return;
  ledgerCache.minute.set(member, [...(ledgerCache.minute.get(member) ?? []), t]);
  ledgerCache.today.set(member, (ledgerCache.today.get(member) ?? 0) + 1);
}

function availableAt(m: PoolMember, ledger: Ledger, now: number): number {
  const cool = ledger.cooldown.get(m.id) ?? 0;
  if (m.dailyBudget !== null && (ledger.today.get(m.id) ?? 0) >= m.dailyBudget) return Infinity;
  const calls = [...(ledger.minute.get(m.id) ?? [])].sort((a, b) => a - b);
  const rpmFree = calls.length >= RPM ? calls[calls.length - RPM] + 60_000 : now;
  return Math.max(cool, rpmFree, now);
}

async function setCooldown(member: string, ms: number, reason: string) {
  const until = Date.now() + ms;
  ledgerCache?.cooldown.set(member, until);
  try {
    await db().from("model_cooldowns").upsert({ member, until: new Date(until).toISOString(), reason: reason.slice(0, 200) });
  } catch {
    // best effort
  }
}

async function logCall(m: PoolMember, ok: boolean, latencyMs: number, error?: string) {
  try {
    await db().from("llm_calls").insert({
      lane: "reasoning",
      provider: m.spec.provider,
      model: m.spec.model,
      member: m.id,
      purpose: "agent_step",
      ok,
      latency_ms: latencyMs,
      error: error?.slice(0, 300) ?? null,
    });
  } catch {
    // telemetry must never break the run
  }
}

function cooldownFor(message: string): number | null {
  // Google's retry hint is exact: for a daily cap it is the time until the quota resets.
  const hint = message.match(/retry(?:Delay)?["\s:]*(?:in\s*)?"?(\d+(?:\.\d+)?)s/i);
  const hinted = hint ? Math.ceil(Number(hint[1]) * 1000) + 500 : null;
  if (/PerDay|per day/i.test(message)) return hinted ?? 60 * 60_000;
  if (/\b429\b|RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(message)) return hinted ?? 60_000;
  if (/\b413\b|Request too large|context length|too many tokens/i.test(message)) return 10 * 60_000;
  if (/\b(500|502|503|504)\b|overloaded|UNAVAILABLE|timeout|ECONNRESET|fetch failed|socket hang up/i.test(message)) return 15_000;
  return null; // a real bug (bad request) — surface it, don't mask it by switching models
}

export function quotaAwarePoolMiddleware() {
  const pool = reasoningPool();
  return createMiddleware({
    name: "QuotaAwareModelPool",
    wrapModelCall: async (request, handler) => {
      let lastError: unknown;
      const tried = new Set<string>();
      for (let attempt = 0; attempt < pool.length + 1; attempt++) {
        const ledger = await loadLedger();
        const now = Date.now();
        const candidates = pool.filter((m) => !tried.has(m.id)).map((m) => ({ m, at: availableAt(m, ledger, now) }));
        const ready = candidates.find((c) => c.at <= now);
        if (!ready) {
          const soonest = candidates.filter((c) => Number.isFinite(c.at)).sort((a, b) => a.at - b.at)[0];
          if (!soonest || soonest.at - now > 30_000) break;
          await sleep(soonest.at - now);
          ledgerCache = null;
          continue;
        }
        const member = ready.m;
        tried.add(member.id);
        const model = await member.resolve();
        if (!model) continue; // e.g. Colab notebook not running: skip without penalty
        const started = Date.now();
        noteLocally(member.id, started);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          // A hung stream is as bad as an error on a 300 s serverless budget: cap each call.
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`timeout: ${member.id} took over ${CALL_TIMEOUT_MS / 1000}s`)), CALL_TIMEOUT_MS);
          });
          const tools = (request.tools ?? []).filter((t) => !HIDDEN_TOOLS.has((t as { name?: string }).name ?? ""));
          const result = await Promise.race([handler({ ...request, tools, model: model as never }), timeout]);
          await logCall(member, true, Date.now() - started);
          return result;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          lastError = err;
          await logCall(member, false, Date.now() - started, message);
          // A self-hosted endpoint that answers oddly (wrong server behind the tunnel, model not
          // loaded) is skipped for a while rather than failing the clinic's turn.
          const cool = cooldownFor(message) ?? (member.spec.provider === "colab" ? 5 * 60_000 : null);
          if (cool === null) throw err;
          await setCooldown(member.id, cool, message);
        } finally {
          clearTimeout(timer);
        }
      }
      throw lastError ?? new Error("All reasoning models are at their free-tier limit — try again in a minute.");
    },
  });
}

/** Remaining free budget per pool member, for the status panel. */
export async function poolStatus() {
  ledgerCache = null;
  const ledger = await loadLedger();
  const now = Date.now();
  const colabUp = !!(await colabEndpoint());
  return reasoningPool().map((m) => {
    if (m.spec.provider === "colab" && !colabUp) {
      return { member: m.id, usedToday: ledger.today.get(m.id) ?? 0, dailyBudget: null, lastMinute: 0, state: "offline" as const, readyInSec: null };
    }
    const at = availableAt(m, ledger, now);
    return {
      member: m.id,
      usedToday: ledger.today.get(m.id) ?? 0,
      dailyBudget: m.dailyBudget,
      lastMinute: ledger.minute.get(m.id)?.length ?? 0,
      state: at <= now ? "ready" : Number.isFinite(at) ? "cooling" : "exhausted",
      readyInSec: at <= now ? 0 : Number.isFinite(at) ? Math.ceil((at - now) / 1000) : null,
    };
  });
}
