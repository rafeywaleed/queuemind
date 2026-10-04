// POST: run one agent turn, streamed as NDJSON. GET ?threadId=: rehydrate a thread.
import { runAgentTurn, threadState } from "@/lib/agent/run";
import { clientIp, fail, json, rateLimited } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request) {
  const { threadId, message } = (await req.json()) as { threadId?: string; message?: string };
  if (!threadId || !message?.trim()) return json({ error: "threadId and message are required" }, 400);
  if (rateLimited(`agent:${clientIp(req)}`, 30, 10 * 60_000)) return json({ error: "Too many agent runs — wait a few minutes." }, 429);

  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      for await (const event of runAgentTurn(threadId, message.slice(0, 4000))) {
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
  try {
    return json(await threadState(threadId));
  } catch (err) {
    return fail(err);
  }
}
