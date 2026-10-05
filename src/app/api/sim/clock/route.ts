// Clinic clock controls: play, pause, speed (1–30×), skip ahead N clinic minutes.
import { controlClock, getClock, simNow } from "@/lib/clinic/clock";
import { fail, json } from "@/lib/http";

export const runtime = "nodejs";

const view = (c: Awaited<ReturnType<typeof getClock>>) => ({ speed: c.speed, paused: c.paused, now: new Date(simNow(c)).toISOString() });

export async function GET() {
  try {
    return json(view(await getClock()));
  } catch (err) {
    return fail(err);
  }
}

export async function POST(req: Request) {
  const body = (await req.json()) as { action?: "play" | "pause" | "speed" | "skip"; speed?: number; minutes?: number };
  if (!body.action || !["play", "pause", "speed", "skip"].includes(body.action)) return json({ error: "action must be play | pause | speed | skip" }, 400);
  try {
    return json(view(await controlClock({ action: body.action, speed: body.speed, minutes: body.minutes })));
  } catch (err) {
    return fail(err);
  }
}
