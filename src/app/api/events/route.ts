import { recentEvents } from "@/lib/db/repo";
import { fail, json } from "@/lib/http";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const limit = Number(new URL(req.url).searchParams.get("limit") ?? 50);
    return json(await recentEvents(Math.min(Math.max(limit, 1), 200)));
  } catch (err) {
    return fail(err);
  }
}
