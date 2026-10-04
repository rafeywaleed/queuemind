// The live board: raw state + the engine's computed plan and alerts.
import { boardRaw } from "@/lib/clinic/actions";
import { fail, json } from "@/lib/http";

export const runtime = "nodejs";

export async function GET() {
  try {
    const { state, snapshot } = await boardRaw();
    return json({ clinic: state.clinic, doctors: state.doctors, visits: state.visits, snapshot });
  } catch (err) {
    return fail(err);
  }
}
