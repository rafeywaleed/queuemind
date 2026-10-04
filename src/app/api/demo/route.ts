// GET: one-click scenarios for the demo. POST: reset the demo clinic to a fresh afternoon.
import { resetDemo, SCENARIOS } from "@/lib/clinic/seed";
import { clientIp, fail, json, rateLimited } from "@/lib/http";

export const runtime = "nodejs";

export async function GET() {
  return json(SCENARIOS.map(({ id, title, event }) => ({ id, title, event })));
}

export async function POST(req: Request) {
  if (rateLimited(`reset:${clientIp(req)}`, 10, 10 * 60_000)) return json({ error: "Too many resets" }, 429);
  try {
    return json(await resetDemo());
  } catch (err) {
    return fail(err);
  }
}
