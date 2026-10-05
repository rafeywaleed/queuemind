// The live board: raw state + the engine's computed plan and alerts, at clinic time.
// After responding, it gives the autopilot a chance to advance the simulated clinic.
import { after } from "next/server";
import { boardRaw } from "@/lib/clinic/actions";
import { maybeTick } from "@/lib/clinic/autopilot";
import { getClock, simNow } from "@/lib/clinic/clock";
import { fail, json } from "@/lib/http";

export const runtime = "nodejs";

export async function GET() {
  try {
    const [{ state, snapshot }, clock] = await Promise.all([boardRaw(), getClock()]);
    after(() => maybeTick().catch((err) => console.error("[autopilot]", err)));
    return json({
      clinic: state.clinic,
      doctors: state.doctors,
      visits: state.visits,
      snapshot,
      clock: { speed: clock.speed, paused: clock.paused, now: new Date(simNow(clock)).toISOString() },
    });
  } catch (err) {
    return fail(err);
  }
}
