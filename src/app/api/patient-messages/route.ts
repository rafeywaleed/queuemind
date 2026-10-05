// Patient SMS replies. POST runs the Laya-first pipeline; GET lists recent messages.
import { handlePatientMessage, listPatientMessages } from "@/lib/clinic/actions";
import { clientIp, fail, json, rateLimited } from "@/lib/http";

export const runtime = "nodejs";

export async function GET() {
  try {
    return json(await listPatientMessages());
  } catch (err) {
    return fail(err);
  }
}

export async function POST(req: Request) {
  const { visit, text } = (await req.json()) as { visit?: string; text?: string };
  if (!visit || !text?.trim()) return json({ error: "visit and text are required" }, 400);
  if (rateLimited(`pm:${clientIp(req)}`, 40, 10 * 60_000)) return json({ error: "Too many messages, slow down." }, 429);
  try {
    return json(await handlePatientMessage(visit, text));
  } catch (err) {
    return fail(err);
  }
}
