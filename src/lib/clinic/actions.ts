// Clinic service layer. The agent's tools and the staff UI both call these functions,
// so business rules (safety ratchet, follow-up fees, fairness) live in exactly one place.
// Every mutation returns its impact on the queue and is written to the event log.
import { computeQueue, diffSnapshots, findInSnapshot } from "../queue/engine";
import { followUpFee, isRaise, maxPriority, screenRedFlags } from "../queue/policies";
import { simulate, type Hypothetical } from "../queue/simulate";
import type { ClinicState, Priority } from "../queue/types";
import * as repo from "../db/repo";
import { db } from "../db/client";
import { draftPatientMessage, triageWalkIn, type MessagePurpose } from "../llm/tasks";
import { findDoctorByRef, findVisitByRef, fmtDate, fmtTime, greetingName, renderBoard, renderImpact, visitRef } from "./format";

export type Actor = "agent" | "staff" | "system";

export class ClinicError extends Error {}

const ACTIVE = new Set(["scheduled", "waiting", "in_consult"]);

async function stateAndBoard() {
  const state = await repo.loadClinicState();
  return { state, snapshot: computeQueue(state) };
}

function needVisit(state: ClinicState, ref: string) {
  const v = findVisitByRef(state, ref);
  if (!v) throw new ClinicError(`No visit matching "${ref}". Use a token like #12 or a visit id from the board.`);
  return v;
}

function needDoctor(state: ClinicState, ref: string) {
  const d = findDoctorByRef(state, ref);
  if (!d) throw new ClinicError(`No doctor matching "${ref}". Doctors: ${state.doctors.map((x) => x.name).join(", ")}`);
  return d;
}

/** Run a mutation and report who it affected (before/after diff of the computed queue). */
async function withImpact<T>(mutate: (state: ClinicState) => Promise<T>) {
  const { state, snapshot: before } = await stateAndBoard();
  const result = await mutate(state);
  const { state: afterState, snapshot: after } = await stateAndBoard();
  return {
    result,
    impact: renderImpact(diffSnapshots(before, after), afterState),
    alerts: after.alerts.map((a) => `[${a.severity}] ${a.message}`),
  };
}

export async function board() {
  const { state, snapshot } = await stateAndBoard();
  return renderBoard(state, snapshot);
}

export async function boardRaw() {
  const { state, snapshot } = await stateAndBoard();
  return { state, snapshot };
}

export async function checkIn(ref: string, actor: Actor) {
  return withImpact(async (state) => {
    const v = needVisit(state, ref);
    if (v.status !== "scheduled") throw new ClinicError(`${v.patientName} is already ${v.status}.`);
    const now = new Date();
    const token = v.token ?? (await repo.nextToken(state.clinic.timezone));
    await repo.updateVisit(v.id, { status: "waiting", arrived_at: now.toISOString(), token });
    const lateBy = v.scheduledAt ? Math.round((now.getTime() - new Date(v.scheduledAt).getTime()) / 60_000) : 0;
    const keepsSlot = lateBy <= state.clinic.graceMinutes;
    const summary = v.scheduledAt
      ? lateBy > 0
        ? `${v.patientName} checked in ${lateBy} min late — ${keepsSlot ? "within grace, keeps slot" : "outside grace, queued by arrival"}`
        : `${v.patientName} checked in on time`
      : `${v.patientName} checked in`;
    await repo.logEvent({ type: "check_in", actor, summary, visitId: v.id, doctorId: v.doctorId, payload: { lateBy, keepsSlot, token } });
    return { token: `#${token}`, summary };
  });
}

export async function registerWalkIn(
  input: { patientName: string; phone?: string | null; language?: string | null; complaint: string; preferredDoctor?: string | null },
  actor: Actor,
) {
  return withImpact(async (state) => {
    // 1. Deterministic red flags first; then Laya (System 1, calibrated) or the LLM (System 2)
    //    when Laya isn't confident. Take the most severe — automation never lowers priority.
    const redFlags = screenRedFlags(input.complaint);
    const specialties = [...new Set(state.doctors.filter((d) => d.status === "on_duty").map((d) => d.specialty))];
    const intake = await triageWalkIn(input.complaint, specialties.length ? specialties : ["General Medicine"]);
    const priority = maxPriority(redFlags.level, intake.urgency);

    // 2. Pick the doctor where this patient would be seen soonest (what-if per candidate doctor).
    let doctor = input.preferredDoctor ? needDoctor(state, input.preferredDoctor) : null;
    if (!doctor) {
      const pool = state.doctors.filter((d) => d.status === "on_duty" && d.specialty === intake.specialty);
      const candidates = pool.length ? pool : state.doctors.filter((d) => d.status === "on_duty");
      if (!candidates.length) throw new ClinicError("No doctor is on duty.");
      let best = { doctor: candidates[0], wait: Infinity };
      for (const d of candidates) {
        const sim = simulate(state, [{ type: "add_walk_in", doctorId: d.id, estMinutes: intake.estMinutes ?? d.avgConsultMin, priority }]);
        const mine = sim.after.doctors.find((x) => x.doctorId === d.id)?.queue.find((q) => q.visitId.startsWith("hypothetical"));
        if (mine && mine.waitMin < best.wait) best = { doctor: d, wait: mine.waitMin };
      }
      doctor = best.doctor;
    }

    const patient = await repo.findOrCreatePatient({ name: input.patientName, phone: input.phone, language: input.language });
    const token = await repo.nextToken(state.clinic.timezone);
    const visit = await repo.insertVisit({
      patientId: patient.id,
      doctorId: doctor.id,
      kind: "walk_in",
      status: "waiting",
      priority,
      prioritySource: redFlags.level !== "normal" ? "red_flag_rules" : intake.urgency !== "normal" ? (intake.decidedBy === "laya" ? "laya" : "intake_model") : "default",
      token,
      arrivedAt: new Date().toISOString(),
      estMinutes: intake.estMinutes,
      reason: intake.summary,
    });
    await repo.logEvent({
      type: priority === "emergency" ? "emergency_intake" : "walk_in",
      actor,
      summary: `Walk-in #${token} ${input.patientName} → ${doctor.name} (${priority}${redFlags.matches.length ? `; red flags: ${redFlags.matches.join(", ")}` : ""})`,
      visitId: visit.id,
      doctorId: doctor.id,
      payload: { redFlags, intake },
    });
    return {
      token: `#${token}`,
      doctor: doctor.name,
      priority,
      triage: {
        redFlagRules: redFlags.matches.length ? redFlags.matches : "none",
        decidedBy:
          intake.decidedBy === "laya"
            ? `Laya decision model (System 1, ${intake.laya?.latencyMs} ms, specialty ${intake.laya?.answers.specialty?.confidence.toFixed(2)}, urgency ${intake.laya?.answers.urgency?.confidence.toFixed(2)})`
            : intake.laya
              ? `LLM fast lane (System 2) — Laya below confidence gate`
              : `LLM fast lane (System 2) — Laya offline`,
        laya: intake.laya ? Object.fromEntries(Object.entries(intake.laya.answers).map(([k, d]) => [k, `${d.value} (${d.confidence.toFixed(2)})`])) : "offline",
        intake: { urgency: intake.urgency, specialty: intake.specialty, estMinutes: intake.estMinutes },
        rule: "final priority = most severe of (red-flag rules, Laya, LLM); automation never lowers it",
      },
      instruction:
        priority === "emergency"
          ? "EMERGENCY: tell the front desk to alert the doctor/nurse NOW. If life-threatening signs, direct to emergency services. Do not make the patient wait in line."
          : undefined,
    };
  });
}

export async function reportDoctorDelay(doctorRef: string, minutes: number, reason: string, actor: Actor) {
  return withImpact(async (state) => {
    const d = needDoctor(state, doctorRef);
    const availableAt = new Date(Date.now() + minutes * 60_000).toISOString();
    await repo.updateDoctor(d.id, { available_at: availableAt, status: "on_duty" });
    await repo.logEvent({ type: "doctor_delay", actor, summary: `${d.name} delayed ${minutes} min: ${reason}`, doctorId: d.id, payload: { minutes, reason } });
    return { doctor: d.name, availableAt: fmtTime(availableAt, state.clinic.timezone) };
  });
}

export async function doctorAvailable(doctorRef: string, actor: Actor) {
  return withImpact(async (state) => {
    const d = needDoctor(state, doctorRef);
    await repo.updateDoctor(d.id, { available_at: null, status: "on_duty" });
    await repo.logEvent({ type: "doctor_available", actor, summary: `${d.name} is available`, doctorId: d.id });
    return { doctor: d.name };
  });
}

export async function doctorOffDuty(doctorRef: string, reason: string, actor: Actor) {
  return withImpact(async (state) => {
    const d = needDoctor(state, doctorRef);
    await repo.updateDoctor(d.id, { status: "off_duty" });
    await repo.logEvent({ type: "doctor_off_duty", actor, summary: `${d.name} off duty: ${reason}`, doctorId: d.id, payload: { reason } });
    const stranded = state.visits.filter((v) => v.doctorId === d.id && (v.status === "waiting" || v.status === "scheduled"));
    return { doctor: d.name, patientsNeedingReassignment: stranded.map((v) => `${visitRef(v)} ${v.patientName}`) };
  });
}

export async function startConsult(ref: string, actor: Actor) {
  return withImpact(async (state) => {
    const v = needVisit(state, ref);
    if (v.status !== "waiting") throw new ClinicError(`${v.patientName} is ${v.status}, not waiting.`);
    const busy = state.visits.find((x) => x.doctorId === v.doctorId && x.status === "in_consult");
    if (busy) throw new ClinicError(`Doctor is still with ${busy.patientName} (${visitRef(busy)}). Finish that consult first.`);
    await repo.updateVisit(v.id, { status: "in_consult", consult_started_at: new Date().toISOString() });
    await repo.updateDoctor(v.doctorId, { available_at: null });
    await repo.logEvent({ type: "consult_start", actor, summary: `${v.patientName} called in`, visitId: v.id, doctorId: v.doctorId });
    return { started: `${visitRef(v)} ${v.patientName}` };
  });
}

export async function finishConsult(ref: string, opts: { followUpInDays?: number | null; notes?: string | null }, actor: Actor) {
  const out = await withImpact(async (state) => {
    const v = needVisit(state, ref);
    if (v.status !== "in_consult") throw new ClinicError(`${v.patientName} is ${v.status}, not in consult.`);
    const doctor = needDoctor(state, v.doctorId);
    const endedAt = new Date();
    const actualMin = v.consultStartedAt ? Math.round((endedAt.getTime() - new Date(v.consultStartedAt).getTime()) / 60_000) : null;
    await repo.updateVisit(v.id, { status: "done", consult_ended_at: endedAt.toISOString(), notes: opts.notes ?? null });
    const newAvg = actualMin !== null ? await repo.learnConsultTime(doctor, actualMin) : doctor.avgConsultMin;
    await repo.logEvent({
      type: "consult_end",
      actor,
      summary: `${v.patientName} done after ${actualMin ?? "?"} min (${doctor.name} avg now ${newAvg} min)`,
      visitId: v.id,
      doctorId: doctor.id,
      payload: { actualMin, newAvg },
    });
    return { finished: `${visitRef(v)} ${v.patientName}`, actualMin, doctorAvgNow: newAvg, visitId: v.id };
  });
  const followUp = opts.followUpInDays ? await bookFollowUp(out.result.visitId, opts.followUpInDays, actor) : null;
  return { ...out, followUp: followUp?.result ?? null };
}

export async function bookFollowUp(ref: string, inDays: number, actor: Actor) {
  return withImpact(async (state) => {
    const parent = needVisit(state, ref);
    const doctor = needDoctor(state, parent.doctorId);
    const consultEnded = parent.consultEndedAt ?? new Date().toISOString();
    const at = new Date(new Date(consultEnded).getTime() + inDays * 86_400_000);
    at.setUTCMinutes(Math.round(at.getUTCMinutes() / 15) * 15, 0, 0);
    const fee = followUpFee(consultEnded, at.toISOString(), state.clinic.freeFollowUpDays, state.clinic.timezone);
    const visit = await repo.insertVisit({
      patientId: parent.patientId,
      doctorId: doctor.id,
      kind: "follow_up",
      status: "scheduled",
      priority: "normal",
      prioritySource: "default",
      scheduledAt: at.toISOString(),
      parentVisitId: parent.id,
      feeWaived: fee.free,
      estMinutes: Math.max(5, Math.round(doctor.avgConsultMin * 0.6)),
      reason: `Follow-up of ${visitRef(parent)}`,
    });
    const when = fmtDate(at.toISOString(), state.clinic.timezone);
    // Reminder drafted now, to be sent the day before (human approves in the outbox).
    const draft = await draftPatientMessage({
      purpose: "follow_up_reminder",
      language: parent.patientLanguage,
      facts: {
        patient: greetingName(parent.patientName),
        doctor: doctor.name,
        clinic: state.clinic.name,
        date: when,
        fee: fee.free ? "This follow-up is free of charge." : "Standard consultation fee applies.",
      },
    });
    const sendAt = new Date(Math.max(Date.now(), at.getTime() - 86_400_000)).toISOString();
    await repo.insertNotification({ visitId: visit.id, patientId: parent.patientId, kind: "follow_up_reminder", body: draft.body, sendAt, draftedBy: draft.servedBy });
    await repo.logEvent({
      type: "follow_up_booked",
      actor,
      summary: `Follow-up for ${parent.patientName} with ${doctor.name} on ${when} — ${fee.free ? "FREE" : "fee applies"} (${fee.reason})`,
      visitId: visit.id,
      doctorId: doctor.id,
      payload: fee,
    });
    return { followUpId: visit.id, when, free: fee.free, feeRule: fee.reason, reminder: { sendAt: fmtDate(sendAt, state.clinic.timezone), status: "pending_approval" } };
  });
}

export async function cancelVisit(ref: string, reason: string, actor: Actor) {
  return withImpact(async (state) => {
    const v = needVisit(state, ref);
    if (!ACTIVE.has(v.status) || v.status === "in_consult") throw new ClinicError(`${v.patientName} is ${v.status}; cannot cancel.`);
    await repo.updateVisit(v.id, { status: "cancelled" });
    await repo.logEvent({ type: "cancelled", actor, summary: `${v.patientName} cancelled: ${reason}`, visitId: v.id, doctorId: v.doctorId, payload: { reason } });
    return { cancelled: `${visitRef(v)} ${v.patientName}` };
  });
}

export async function markNoShow(ref: string, actor: Actor) {
  return withImpact(async (state) => {
    const v = needVisit(state, ref);
    if (v.status !== "scheduled") throw new ClinicError(`${v.patientName} is ${v.status}; only not-yet-arrived bookings can be no-shows.`);
    const overdue = v.scheduledAt ? Math.round((Date.now() - new Date(v.scheduledAt).getTime()) / 60_000) : 0;
    if (overdue < state.clinic.noShowMinutes) {
      throw new ClinicError(`Only ${overdue} min past the slot; policy waits ${state.clinic.noShowMinutes} min before a no-show.`);
    }
    if (actor === "agent") {
      const contacted = await db().from("notifications").select("id").eq("visit_id", v.id).eq("kind", "no_show_check").limit(1);
      if (!contacted.data?.length) {
        throw new ClinicError(
          `Policy: contact ${v.patientName} before closing their visit — draft a no_show_check SMS first. Staff can mark the no-show directly if they already called.`,
        );
      }
    }
    await repo.updateVisit(v.id, { status: "no_show" });
    await repo.logEvent({ type: "no_show", actor, summary: `${v.patientName} marked no-show (${overdue} min overdue)`, visitId: v.id, doctorId: v.doctorId });
    return { noShow: `${visitRef(v)} ${v.patientName}`, overdueMin: overdue };
  });
}

/** Safety ratchet: the agent and system can only raise priority. Only staff can lower it. */
export async function setPriority(ref: string, level: Priority, reason: string, actor: Actor) {
  return withImpact(async (state) => {
    const v = needVisit(state, ref);
    if (v.priority === level) return { unchanged: true, priority: level };
    if (!isRaise(v.priority, level) && actor !== "staff") {
      throw new ClinicError(
        `Refused: lowering ${v.patientName} from ${v.priority} to ${level} requires a staff member. Automation can only raise priority. Ask the front desk to confirm.`,
      );
    }
    await repo.updateVisit(v.id, { priority: level, priority_source: actor });
    await repo.logEvent({ type: "priority_change", actor, summary: `${v.patientName}: ${v.priority} → ${level} (${reason})`, visitId: v.id, doctorId: v.doctorId, payload: { from: v.priority, to: level, reason } });
    return { patient: v.patientName, from: v.priority, to: level };
  });
}

export async function reassign(ref: string, doctorRef: string, reason: string, actor: Actor) {
  return withImpact(async (state) => {
    const v = needVisit(state, ref);
    const to = needDoctor(state, doctorRef);
    if (to.status !== "on_duty") throw new ClinicError(`${to.name} is off duty.`);
    if (v.doctorId === to.id) throw new ClinicError(`${v.patientName} is already with ${to.name}.`);
    if (!["waiting", "scheduled"].includes(v.status)) throw new ClinicError(`${v.patientName} is ${v.status}; cannot reassign.`);
    const from = state.doctors.find((d) => d.id === v.doctorId);
    await repo.updateVisit(v.id, { doctor_id: to.id });
    await repo.logEvent({ type: "reassigned", actor, summary: `${v.patientName}: ${from?.name} → ${to.name} (${reason})`, visitId: v.id, doctorId: to.id, payload: { from: from?.id, reason } });
    return { patient: v.patientName, from: from?.name, to: to.name };
  });
}

export interface OptionChange {
  type: "doctor_delay" | "doctor_available" | "reassign" | "cancel" | "set_priority" | "add_walk_in";
  doctor?: string;
  visit?: string;
  minutes?: number;
  priority?: Priority;
}

/** Compare alternative plans on a sandbox copy of the clinic. Nothing is saved. */
export async function simulateOptions(options: { label: string; changes: OptionChange[] }[]) {
  const { state } = await stateAndBoard();
  const toHypothetical = (c: OptionChange): Hypothetical => {
    const d = () => needDoctor(state, c.doctor ?? "").id;
    const v = () => needVisit(state, c.visit ?? "").id;
    switch (c.type) {
      case "doctor_delay":
        return { type: "doctor_delay", doctorId: d(), minutes: c.minutes ?? 15 };
      case "doctor_available":
        return { type: "doctor_available", doctorId: d() };
      case "reassign":
        return { type: "reassign", visitId: v(), doctorId: d() };
      case "cancel":
        return { type: "cancel", visitId: v() };
      case "set_priority":
        return { type: "set_priority", visitId: v(), priority: c.priority ?? "urgent" };
      case "add_walk_in":
        return { type: "add_walk_in", doctorId: d(), estMinutes: c.minutes ?? 10, priority: c.priority ?? "normal" };
    }
  };
  return options.map((o) => {
    const result = simulate(state, o.changes.map(toHypothetical));
    return {
      option: o.label,
      ...result.summary,
      patientImpact: renderImpact(result.patientImpact, state),
      alertsAfter: result.after.alerts.map((a) => a.message).slice(0, 6),
    };
  });
}

/** Draft patient SMS (outbox, pending staff approval). Numbers come from the engine, never the model. */
export async function draftNotifications(refs: string[], purpose: MessagePurpose, note: string | null, actor: Actor) {
  const { state, snapshot } = await stateAndBoard();
  const tz = state.clinic.timezone;
  const results = [];
  for (const ref of refs) {
    const v = findVisitByRef(state, ref);
    if (!v) {
      results.push({ ref, skipped: "no such visit" });
      continue;
    }
    const recent = await db()
      .from("notifications")
      .select("created_at, status")
      .eq("visit_id", v.id)
      .eq("kind", purpose)
      .neq("status", "rejected")
      .gte("created_at", new Date(Date.now() - 20 * 60_000).toISOString())
      .limit(1);
    if (recent.data?.length) {
      results.push({ ref: visitRef(v), skipped: `already drafted a '${purpose}' message in the last 20 min` });
      continue;
    }
    const doctor = state.doctors.find((d) => d.id === v.doctorId);
    const planned = findInSnapshot(snapshot, v.id)?.planned;
    if (["delay", "turn_soon", "reassigned"].includes(purpose) && !planned) {
      results.push({ ref: visitRef(v), skipped: "patient is not in the active queue" });
      continue;
    }
    const facts: Record<string, string | number> = {
      patient: greetingName(v.patientName),
      doctor: doctor?.name ?? "your doctor",
      clinic: state.clinic.name,
    };
    if (planned) {
      facts.eta = fmtTime(planned.etaStart, tz);
      facts.wait = planned.waitMin;
    }
    if (v.scheduledAt) facts.time = fmtTime(v.scheduledAt, tz);
    const draft = await draftPatientMessage({ purpose, language: v.patientLanguage, facts, note: note ?? undefined });
    const row = await repo.insertNotification({ visitId: v.id, patientId: v.patientId, kind: purpose, body: draft.body, draftedBy: draft.servedBy });
    await repo.logEvent({ type: "notification_drafted", actor, summary: `Drafted '${purpose}' SMS for ${v.patientName}`, visitId: v.id, payload: { notificationId: row.id, servedBy: draft.servedBy, guard: draft.guard } });
    results.push({ ref: visitRef(v), patient: v.patientName, language: v.patientLanguage, body: draft.body, writtenBy: draft.servedBy, guard: draft.guard, status: "pending_approval" });
  }
  return results;
}

export async function visitHistory(ref: string) {
  const { state, snapshot } = await stateAndBoard();
  const v = needVisit(state, ref);
  const planned = findInSnapshot(snapshot, v.id);
  const events = await repo.visitEvents(v.id);
  return {
    visit: { ref: visitRef(v), patient: v.patientName, kind: v.kind, status: v.status, priority: v.priority, reason: v.reason },
    now: planned
      ? { doctor: planned.doctor.name, position: planned.planned.position, waitMin: planned.planned.waitMin, startsAt: fmtTime(planned.planned.etaStart, state.clinic.timezone), why: planned.planned.flags }
      : null,
    timeline: events.map((e) => `${fmtTime(e.created_at, state.clinic.timezone)} [${e.actor}] ${e.summary}`),
  };
}

export async function decideNotification(id: string, decision: "sent" | "rejected", body?: string) {
  const row = await repo.decideNotification(id, decision, body);
  if (!row) throw new ClinicError("Notification not found or already decided.");
  await repo.logEvent({ type: `notification_${decision}`, actor: "staff", summary: `SMS ${decision === "sent" ? "approved & sent" : "rejected"}`, visitId: row.visit_id, payload: { notificationId: id } });
  return row;
}
