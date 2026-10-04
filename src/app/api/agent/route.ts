// POST: run one agent turn, streamed as NDJSON. GET ?threadId=: rehydrate a thread.
// The agent runtime is imported lazily inside try/catch so that, if it ever fails to load on a
// host, the client gets the real reason as JSON instead of a blank 500.
import { clientIp, json, rateLimited } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 300;

async function loadRuntime() {
  return import("@/lib/agent/run");
}

function loadError(err: unknown) {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error("[agent] runtime failed to load", err);
  return json({ error: `Agent runtime failed to load — ${message}`, node: process.version }, 500);
}

export async function POST(req: Request) {
  const { threadId, message } = (await req.json()) as { threadId?: string; message?: string };
  if (!threadId || !message?.trim()) return json({ error: "threadId and message are required" }, 400);
  if (rateLimited(`agent:${clientIp(req)}`, 30, 10 * 60_000)) return json({ error: "Too many agent runs — wait a few minutes." }, 429);

  let run: Awaited<ReturnType<typeof loadRuntime>>;
  try {
    run = await loadRuntime();
  } catch (err) {
    return loadError(err);
  }

  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      for await (const event of run.runAgentTurn(threadId, message.slice(0, 4000))) {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      }
      controller.close();
    },
  });
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}

export async function GET(req: Request) {
  const threadId = new URL(req.url).searchParams.get("threadId");
  if (!threadId) return json({ error: "threadId required" }, 400);
  let run: Awaited<ReturnType<typeof loadRuntime>>;
  try {
    run = await loadRuntime();
  } catch (err) {
    return loadError(err);
  }
  try {
    return json(await run.threadState(threadId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: message }, 500);
  }
}
