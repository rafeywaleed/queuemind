// Outbox: list drafted SMS; approve (simulated send) or reject. Human-in-the-loop for every message.
import { decideNotification } from "@/lib/clinic/actions";
import { listNotifications } from "@/lib/db/repo";
import { fail, json } from "@/lib/http";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const status = new URL(req.url).searchParams.get("status") ?? undefined;
    return json(await listNotifications(status));
  } catch (err) {
    return fail(err);
  }
}

export async function POST(req: Request) {
  const { id, decision, body } = (await req.json()) as { id?: string; decision?: "sent" | "rejected"; body?: string };
  if (!id || (decision !== "sent" && decision !== "rejected")) return json({ error: "id and decision ('sent'|'rejected') required" }, 400);
  try {
    return json(await decideNotification(id, decision, body));
  } catch (err) {
    return fail(err);
  }
}
