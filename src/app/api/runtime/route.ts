// The Colab notebook calls this on start and every ~30s (heartbeat) to announce its tunnel URL.
import { db } from "@/lib/db/client";
import { fail, json } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { secret, url, model, meta } = (await req.json()) as { secret?: string; url?: string; model?: string; meta?: unknown };
  if (!process.env.RUNTIME_SECRET || secret !== process.env.RUNTIME_SECRET) return json({ error: "unauthorized" }, 401);
  if (!url || !/^https:\/\//.test(url) || !model) return json({ error: "https url and model required" }, 400);
  try {
    const { error } = await db()
      .from("runtime_endpoints")
      .upsert({ name: "colab", url, model, last_seen_at: new Date().toISOString(), meta: meta ?? {} });
    if (error) throw new Error(error.message);
    return json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}
