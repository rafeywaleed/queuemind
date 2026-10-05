/* eslint-disable @typescript-eslint/no-explicit-any -- a test client reading loosely-typed JSON responses */
// End-to-end checks against a running app (npm run dev) + the service layer directly.
// Usage: npx tsx --env-file=.env.local scripts/e2e.mts [baseUrl]
// Resets the demo clinic. Agent-actor guardrails are exercised through the service layer; the
// rest goes over HTTP like a real client. Exits non-zero if anything fails.
import * as clinic from "../src/lib/clinic/actions";
import { db } from "../src/lib/db/client";

const BASE = process.argv[2] ?? "http://localhost:3000";
const results: { name: string; ok: boolean; detail?: string }[] = [];

async function check(name: string, fn: () => Promise<unknown>) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: typeof detail === "string" ? detail : undefined });
  } catch (err) {
    results.push({ name, ok: false, detail: (err as Error).message.slice(0, 220) });
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
async function http(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}
const action = (body: Record<string, unknown>) => http("POST", "/api/actions", body);
async function board() {
  const r = await http("GET", "/api/board");
  assert(r.status === 200, `board ${r.status}`);
  return r.json;
}
const visit = (b: any, token: number) => b.visits.find((v: any) => v.token === token && ["scheduled", "waiting", "in_consult"].includes(v.status)) ?? b.visits.find((v: any) => v.token === token);
const doctorByName = (b: any, part: string) => b.doctors.find((d: any) => d.name.includes(part));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function refused(fn: () => Promise<unknown>, pattern: RegExp) {
  try {
    await fn();
  } catch (err) {
    assert(pattern.test((err as Error).message), `refused with unexpected message: ${(err as Error).message}`);
    return (err as Error).message.slice(0, 90);
  }
  throw new Error("expected a refusal, but the action succeeded");
}

// ---------------------------------------------------------------- setup
await check("reset demo", async () => {
  const r = await http("POST", "/api/demo");
  assert(r.status === 200 && r.json.ok, JSON.stringify(r.json));
});
await check("pause clinic clock for deterministic checks", async () => {
  const r = await http("POST", "/api/sim/clock", { action: "pause" });
  assert(r.status === 200 && r.json.paused === true, JSON.stringify(r.json));
});

// ---------------------------------------------------------------- API surface
for (const path of ["/api/board", "/api/status", "/api/events?limit=5", "/api/notifications", "/api/patient-messages", "/api/demo", "/api/sim/clock", "/api/agent?threadId=e2e-empty"]) {
  await check(`GET ${path} → 200`, async () => {
    const r = await http("GET", path);
    assert(r.status === 200, `status ${r.status}: ${JSON.stringify(r.json).slice(0, 120)}`);
  });
}
await check("validation: unknown staff action → 400", async () => assert((await action({ action: "nope" })).status === 400, "not 400"));
await check("validation: agent without message → 400", async () => assert((await http("POST", "/api/agent", { threadId: "x" })).status === 400, "not 400"));
await check("validation: patient message without text → 400", async () => assert((await http("POST", "/api/patient-messages", { visit: "#8" })).status === 400, "not 400"));
await check("validation: runtime registration with wrong secret → 401", async () => assert((await http("POST", "/api/runtime", { secret: "wrong", url: "https://x.y", model: "m" })).status === 401, "not 401"));
await check("validation: bad clock action → 400", async () => assert((await http("POST", "/api/sim/clock", { action: "rewind" })).status === 400, "not 400"));

// ---------------------------------------------------------------- clock
await check("clock: paused time does not move", async () => {
  const a = (await http("GET", "/api/sim/clock")).json.now;
  await sleep(1500);
  const b = (await http("GET", "/api/sim/clock")).json.now;
  assert(a === b, `${a} → ${b}`);
});
await check("clock: +10 min skip", async () => {
  const a = Date.parse((await http("GET", "/api/sim/clock")).json.now);
  const b = Date.parse((await http("POST", "/api/sim/clock", { action: "skip", minutes: 10 })).json.now);
  assert(Math.round((b - a) / 60_000) === 10, `moved ${(b - a) / 60_000} min`);
});
await check("clock: 12× speed advances ~12 s per real second", async () => {
  await http("POST", "/api/sim/clock", { action: "speed", speed: 12 });
  const a = Date.parse((await http("POST", "/api/sim/clock", { action: "play" })).json.now);
  await sleep(2000);
  const b = Date.parse((await http("POST", "/api/sim/clock", { action: "pause" })).json.now);
  const ratio = (b - a) / 2000;
  assert(ratio > 9 && ratio < 16, `ratio ${ratio.toFixed(1)}`);
  await http("POST", "/api/sim/clock", { action: "speed", speed: 6 });
  return `ratio ${ratio.toFixed(1)}×`;
});

// ---------------------------------------------------------------- staff actions (no AI)
await check("staff: check in a booked patient", async () => {
  const r = await action({ action: "check_in", visit: "#13" });
  assert(r.status === 200, JSON.stringify(r.json));
  assert(visit(await board(), 13).status === "waiting", "not waiting");
});
await check("staff: checking in twice is refused", async () => assert((await action({ action: "check_in", visit: "#13" })).status === 400, "second check-in accepted"));
await check("staff: calling in while the doctor is busy is refused", async () => {
  const r = await action({ action: "start_consult", visit: "#6" });
  assert(r.status === 400, `status ${r.status}`);
  return String(r.json.error).slice(0, 80);
});
await check("staff: finish consult + follow-up in 4 days is FREE", async () => {
  const r = await action({ action: "finish_consult", visit: "#3", days: 4 });
  assert(r.status === 200, JSON.stringify(r.json));
  assert(r.json.followUp?.free === true, `follow-up: ${JSON.stringify(r.json.followUp)}`);
  return r.json.followUp.feeRule;
});
await check("staff: follow-up in 7 days charges the fee", async () => {
  const r = await action({ action: "finish_consult", visit: "#5", days: 7 });
  assert(r.status === 200, JSON.stringify(r.json));
  assert(r.json.followUp?.free === false, `follow-up: ${JSON.stringify(r.json.followUp)}`);
});
await check("staff: finishing twice is refused", async () => assert((await action({ action: "finish_consult", visit: "#3" })).status === 400, "accepted"));
await check("staff: call the next patient once the doctor is free", async () => {
  const r = await action({ action: "start_consult", visit: "#6" });
  assert(r.status === 200, JSON.stringify(r.json));
  assert(visit(await board(), 6).status === "in_consult", "not in consult");
});
await check("staff: raise then lower priority (staff may lower)", async () => {
  assert((await action({ action: "set_priority", visit: "#7", priority: "urgent", reason: "e2e" })).status === 200, "raise failed");
  assert((await action({ action: "set_priority", visit: "#7", priority: "normal", reason: "e2e" })).status === 200, "lower failed");
});
await check("staff: cancel, and cancelling twice is refused", async () => {
  assert((await action({ action: "cancel", visit: "#14" })).status === 200, "cancel failed");
  assert((await action({ action: "cancel", visit: "#14" })).status === 400, "second cancel accepted");
});
await check("staff: reassign moves the patient", async () => {
  const b = await board();
  const ayesha = doctorByName(b, "Ayesha");
  assert((await action({ action: "reassign", visit: "#9", doctor: ayesha.id })).status === 200, "reassign failed");
  assert(visit(await board(), 9).doctorId === ayesha.id, "doctor unchanged");
});
await check("staff: doctor delay is planned, then cleared", async () => {
  const sara = doctorByName(await board(), "Sara");
  assert((await action({ action: "doctor_delay", doctor: sara.id, minutes: 20 })).status === 200, "delay failed");
  const plan = (await board()).snapshot.doctors.find((d: any) => d.doctorId === sara.id);
  assert(plan.delayMin >= 19 && plan.delayMin <= 21, `delayMin ${plan.delayMin}`);
  assert((await action({ action: "doctor_available", doctor: sara.id })).status === 200, "back failed");
  assert((await board()).snapshot.doctors.find((d: any) => d.doctorId === sara.id).delayMin === 0, "still delayed");
});
await check("staff: no-show allowed once overdue", async () => assert((await action({ action: "no_show", visit: "#15" })).status === 200, "refused"));
await check("staff: no-show refused before the cutoff", async () => assert((await action({ action: "no_show", visit: "#17" })).status === 400, "accepted"));

// ---------------------------------------------------------------- guardrails (acting as the agent)
await check("guardrail: the agent cannot lower a priority", async () => {
  await clinic.setPriority("#8", "urgent", "e2e raise", "agent");
  return refused(() => clinic.setPriority("#8", "normal", "e2e lower", "agent"), /Refused|only raise/i);
});
await check("guardrail: the agent cannot close a no-show before contacting", async () => refused(() => clinic.markNoShow("#16", "agent"), /contact|no_show_check/i));
await check("guardrail: a booked patient can't be registered as a walk-in", async () =>
  refused(() => clinic.registerWalkIn({ patientName: "Zoya Imran", complaint: "here for her appointment" }, "agent"), /already has a booking/i));
await check("guardrail: tokens with names resolve ('#8 Hina Shah')", async () => {
  const h = await clinic.visitHistory("#8 Hina Shah");
  assert(h.visit.patient.includes("Hina"), h.visit.patient);
});
await check("guardrail: one consult per doctor under a race", async () => {
  const b = await board();
  const bilal = doctorByName(b, "Bilal");
  // Free Dr. Bilal, then fire two call-ins for his patients at once.
  const cur = b.visits.find((v: any) => v.doctorId === bilal.id && v.status === "in_consult");
  if (cur) await action({ action: "finish_consult", visit: `#${cur.token}` });
  const waiting = (await board()).visits.filter((v: any) => v.doctorId === bilal.id && v.status === "waiting").slice(0, 2);
  assert(waiting.length === 2, "need two waiting patients");
  const rs = await Promise.all(waiting.map((v: any) => action({ action: "start_consult", visit: `#${v.token}` })));
  const ok = rs.filter((r) => r.status === 200).length;
  const inConsult = (await board()).visits.filter((v: any) => v.doctorId === bilal.id && v.status === "in_consult").length;
  assert(ok === 1 && inConsult === 1, `succeeded ${ok}, in consult ${inConsult}`);
});

// ---------------------------------------------------------------- outbox (human in the loop)
await check("outbox: draft → pending, approve → sent, reject → rejected", async () => {
  const drafts = await clinic.draftNotifications(["#8", "#11"], "delay", null, "agent");
  assert(drafts.every((d: any) => d.status === "pending_approval" || d.skipped), JSON.stringify(drafts).slice(0, 200));
  const pending = (await http("GET", "/api/notifications?status=pending_approval")).json;
  assert(pending.length >= 2, `pending ${pending.length}`);
  assert((await http("POST", "/api/notifications", { id: pending[0].id, decision: "sent" })).json.status === "sent", "approve failed");
  assert((await http("POST", "/api/notifications", { id: pending[1].id, decision: "rejected" })).json.status === "rejected", "reject failed");
  assert((await http("POST", "/api/notifications", { id: pending[0].id, decision: "sent" })).status !== 200, "double approve accepted");
});
await check("outbox: a duplicate draft within 20 min is skipped", async () => {
  const again = await clinic.draftNotifications(["#11"], "delay", null, "agent");
  assert((again[0] as any).skipped, JSON.stringify(again));
});
await check("numbers guard: drafts only contain numbers from the facts", async () => {
  const pending = (await http("GET", "/api/notifications")).json.filter((n: any) => n.kind === "delay");
  const ok = pending.every((n: any) => /\d/.test(n.body));
  assert(ok, "a delay SMS has no time in it");
});

// ---------------------------------------------------------------- patient texts (Laya first)
const texts: [string, string, (r: any) => boolean][] = [
  ["#8", "How long is the wait?", (r) => r.intent === "wait_time"],
  ["#10", "We are on our way, 10 minutes", (r) => r.intent === "on_my_way"],
  ["#12", "Running about 15 minutes late, sorry", (r) => r.intent === "running_late"],
  ["#11", "Please cancel my appointment today", (r) => r.handoff === true],
  ["#9", "my chest feels tight since the morning", (r) => r.handoff === true && /red-flag/.test(r.decidedBy)],
];
for (const [v, t, ok] of texts) {
  await check(`patient text: "${t}"`, async () => {
    const r = await http("POST", "/api/patient-messages", { visit: v, text: t });
    assert(r.status === 200, JSON.stringify(r.json).slice(0, 200));
    assert(ok(r.json), `${r.json.decidedBy} → ${r.json.outcome}`);
    return `${r.json.decidedBy} → ${r.json.outcome}`;
  });
}
await check("patient text: confident replies were sent instantly (not drafts)", async () => {
  const sent = (await http("GET", "/api/notifications")).json.filter((n: any) => String(n.kind).startsWith("reply_"));
  assert(sent.length >= 1 && sent.every((n: any) => n.status === "sent"), `replies: ${sent.map((n: any) => n.status).join(",")}`);
});

// ---------------------------------------------------------------- doctor leaves (auto-reassign)
await check("doctor leaves: nobody is stranded", async () => {
  const r = await clinic.doctorOffDuty("Dr. Ayesha Khan", "e2e", "staff");
  const b = await board();
  const ayesha = doctorByName(b, "Ayesha");
  const stranded = b.visits.filter((v: any) => v.doctorId === ayesha.id && ["waiting", "scheduled"].includes(v.status));
  assert(stranded.length === 0, `${stranded.length} stranded`);
  return `${(r.result as any).reassigned.length} moved`;
});

// ---------------------------------------------------------------- autopilot invariants
await check("autopilot: 25 s at 30× with 3 clients keeps every invariant", async () => {
  await http("POST", "/api/sim/clock", { action: "speed", speed: 30 });
  await http("POST", "/api/sim/clock", { action: "play" });
  const end = Date.now() + 25_000;
  while (Date.now() < end) {
    await Promise.all([board(), board(), board()]);
    await sleep(2500);
  }
  await http("POST", "/api/sim/clock", { action: "pause" });
  await sleep(3000); // let a running tick finish
  const b = await board();
  const today = b.visits;
  const perDoctor = new Map<string, number>();
  for (const v of today.filter((x: any) => x.status === "in_consult")) perDoctor.set(v.doctorId, (perDoctor.get(v.doctorId) ?? 0) + 1);
  assert([...perDoctor.values()].every((n) => n <= 1), "a doctor has two patients in consult");
  const offDuty = new Set(b.doctors.filter((d: any) => d.status === "off_duty").map((d: any) => d.id));
  assert(!today.some((v: any) => offDuty.has(v.doctorId) && ["waiting", "scheduled"].includes(v.status)), "patients stranded with an off-duty doctor");
  const tokens = today.filter((v: any) => v.token && ["waiting", "in_consult", "scheduled"].includes(v.status)).map((v: any) => v.token);
  assert(new Set(tokens).size === tokens.length, "duplicate active tokens");
  assert(!today.some((v: any) => v.status === "waiting" && !v.arrivedAt), "waiting without arrival time");
  assert(!today.some((v: any) => v.consultEndedAt && v.consultStartedAt && Date.parse(v.consultEndedAt) < Date.parse(v.consultStartedAt)), "consult ended before it started");
  assert(b.snapshot.doctors.every((d: any) => d.queue.every((q: any) => q.waitMin >= 0)), "negative wait");
  const { data: ev } = await db().from("events").select("summary, created_at").eq("actor", "system");
  const keys = (ev ?? []).map((e) => `${e.summary}@${e.created_at}`);
  assert(new Set(keys).size === keys.length, "duplicate system events");
  await http("POST", "/api/sim/clock", { action: "speed", speed: 6 });
  return `${(ev ?? []).length} autopilot events, ${today.filter((v: any) => v.status === "done").length} seen`;
});

// ---------------------------------------------------------------- report
await http("POST", "/api/sim/clock", { action: "play" });
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  — ${r.detail}` : ""}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
