// Staff actions from UI buttons. Same service layer as the agent, but actor = "staff"
// (so staff — and only staff — may lower a priority).
import * as clinic from "@/lib/clinic/actions";
import { fail, json } from "@/lib/http";
import type { Priority } from "@/lib/queue/types";

export const runtime = "nodejs";

type Body = { action: string; visit?: string; doctor?: string; minutes?: number; reason?: string; priority?: Priority; days?: number };

export async function POST(req: Request) {
  const b = (await req.json()) as Body;
  const need = (v: string | undefined, name: string) => {
    if (!v) throw new clinic.ClinicError(`${name} is required`);
    return v;
  };
  try {
    switch (b.action) {
      case "check_in":
        return json(await clinic.checkIn(need(b.visit, "visit"), "staff"));
      case "start_consult":
        return json(await clinic.startConsult(need(b.visit, "visit"), "staff"));
      case "finish_consult":
        return json(await clinic.finishConsult(need(b.visit, "visit"), { followUpInDays: b.days ?? null }, "staff"));
      case "cancel":
        return json(await clinic.cancelVisit(need(b.visit, "visit"), b.reason ?? "staff cancelled", "staff"));
      case "no_show":
        return json(await clinic.markNoShow(need(b.visit, "visit"), "staff"));
      case "set_priority":
        return json(await clinic.setPriority(need(b.visit, "visit"), b.priority ?? "normal", b.reason ?? "staff decision", "staff"));
      case "reassign":
        return json(await clinic.reassign(need(b.visit, "visit"), need(b.doctor, "doctor"), b.reason ?? "staff decision", "staff"));
      case "doctor_delay":
        return json(await clinic.reportDoctorDelay(need(b.doctor, "doctor"), b.minutes ?? 15, b.reason ?? "delayed", "staff"));
      case "doctor_available":
        return json(await clinic.doctorAvailable(need(b.doctor, "doctor"), "staff"));
      default:
        return json({ error: `Unknown action ${b.action}` }, 400);
    }
  } catch (err) {
    return fail(err);
  }
}
