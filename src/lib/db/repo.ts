// Data access: maps Supabase rows <-> engine types. All mutations go through here.
import { CLINIC_ID, db, must } from "./client";
import { clinicNow } from "../clinic/clock";
import { localDate } from "../queue/policies";
import type { ClinicPolicy, ClinicState, Doctor, Priority, Visit, VisitKind, VisitStatus } from "../queue/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const VISIT_SELECT = "*, patients(name, language, phone)";
/** Visits relevant to today's board: anything active, plus anything touched in the last day. */
const WINDOW_HOURS = 24;

export function toClinic(r: Row): ClinicPolicy {
  return {
    id: r.id,
    name: r.name,
    timezone: r.timezone,
    graceMinutes: r.grace_minutes,
    noShowMinutes: r.no_show_minutes,
    maxBumps: r.max_bumps,
    freeFollowUpDays: r.free_follow_up_days,
    delayNotifyThresholdMin: r.delay_notify_threshold_min,
  };
}

export function toDoctor(r: Row): Doctor {
  return {
    id: r.id,
    name: r.name,
    specialty: r.specialty,
    avgConsultMin: r.avg_consult_min,
    status: r.status,
    availableAt: r.available_at,
    shiftEnd: r.shift_end,
  };
}

export function toVisit(r: Row): Visit & { patientPhone: string | null; parentVisitId: string | null; feeWaived: boolean; notes: string | null } {
  return {
    id: r.id,
    patientId: r.patient_id,
    patientName: r.patients?.name ?? "Unknown",
    patientLanguage: r.patients?.language ?? "en",
    patientPhone: r.patients?.phone ?? null,
    doctorId: r.doctor_id,
    kind: r.kind,
    status: r.status,
    priority: r.priority,
    token: r.token,
    scheduledAt: r.scheduled_at,
    arrivedAt: r.arrived_at,
    consultStartedAt: r.consult_started_at,
    consultEndedAt: r.consult_ended_at,
    estMinutes: r.est_minutes,
    reason: r.reason,
    parentVisitId: r.parent_visit_id,
    feeWaived: r.fee_waived,
    notes: r.notes,
  };
}

export async function loadClinicState(clinicId = CLINIC_ID): Promise<ClinicState> {
  const now = (await clinicNow()).getTime();
  const since = new Date(now - WINDOW_HOURS * 3_600_000).toISOString();
  const until = new Date(now + WINDOW_HOURS * 3_600_000).toISOString();
  const [clinic, doctors, visits] = await Promise.all([
    db().from("clinics").select("*").eq("id", clinicId).single(),
    db().from("doctors").select("*").eq("clinic_id", clinicId).order("name"),
    db()
      .from("visits")
      .select(VISIT_SELECT)
      .eq("clinic_id", clinicId)
      .or(`status.in.(waiting,in_consult),and(scheduled_at.gte.${since},scheduled_at.lte.${until}),created_at.gte.${since}`),
  ]);
  return {
    clinic: toClinic(must(clinic, "load clinic")),
    doctors: must(doctors, "load doctors").map(toDoctor),
    visits: must(visits, "load visits").map(toVisit),
  };
}

/** Accepts a visit UUID or a token number like "17" / "#17" (today's tokens). */
export async function resolveVisit(ref: string, clinicId = CLINIC_ID) {
  const trimmed = ref.trim().replace(/^#/, "").replace(/^token\s*/i, "");
  if (/^\d+$/.test(trimmed)) {
    // Tokens reset daily; prefer the visit that is still active.
    const state = await loadClinicState(clinicId);
    const active = new Set(["scheduled", "waiting", "in_consult"]);
    const withToken = state.visits.filter((v) => v.token === Number(trimmed));
    const match = withToken.find((v) => active.has(v.status)) ?? withToken[0];
    if (!match) throw new Error(`No visit with token #${trimmed} today`);
    return getVisit(match.id);
  }
  return getVisit(trimmed);
}

export async function getVisit(id: string) {
  const row = must(await db().from("visits").select(VISIT_SELECT).eq("id", id).maybeSingle(), "get visit");
  if (!row) throw new Error(`Visit ${id} not found`);
  return toVisit(row);
}

/** Accepts a doctor UUID or (part of) a doctor's name. */
export async function resolveDoctor(ref: string, clinicId = CLINIC_ID): Promise<Doctor> {
  const doctors = must<Row[]>(await db().from("doctors").select("*").eq("clinic_id", clinicId), "load doctors").map(toDoctor);
  const needle = ref.trim().toLowerCase().replace(/^dr\.?\s*/, "");
  const found =
    doctors.find((d) => d.id === ref.trim()) ??
    doctors.find((d) => d.name.toLowerCase().replace(/^dr\.?\s*/, "") === needle) ??
    doctors.filter((d) => d.name.toLowerCase().includes(needle))[0];
  if (!found) throw new Error(`No doctor matching "${ref}". Doctors: ${doctors.map((d) => d.name).join(", ")}`);
  return found;
}

export async function updateVisit(id: string, patch: Row) {
  must(await db().from("visits").update(patch).eq("id", id).select("id"), "update visit");
}

export async function updateDoctor(id: string, patch: Row) {
  must(await db().from("doctors").update(patch).eq("id", id).select("id"), "update doctor");
}

export async function insertVisit(row: {
  patientId: string;
  doctorId: string;
  kind: VisitKind;
  status: VisitStatus;
  priority: Priority;
  prioritySource: string;
  token?: number | null;
  scheduledAt?: string | null;
  arrivedAt?: string | null;
  estMinutes?: number | null;
  reason?: string | null;
  parentVisitId?: string | null;
  feeWaived?: boolean;
  clinicId?: string;
}) {
  const data = must(
    await db()
      .from("visits")
      .insert({
        clinic_id: row.clinicId ?? CLINIC_ID,
        patient_id: row.patientId,
        doctor_id: row.doctorId,
        kind: row.kind,
        status: row.status,
        priority: row.priority,
        priority_source: row.prioritySource,
        token: row.token ?? null,
        scheduled_at: row.scheduledAt ?? null,
        arrived_at: row.arrivedAt ?? null,
        est_minutes: row.estMinutes ?? null,
        reason: row.reason ?? null,
        parent_visit_id: row.parentVisitId ?? null,
        fee_waived: row.feeWaived ?? false,
      })
      .select(VISIT_SELECT)
      .single(),
    "insert visit",
  );
  return toVisit(data);
}

export async function findOrCreatePatient(input: { name: string; phone?: string | null; language?: string | null }, clinicId = CLINIC_ID) {
  if (input.phone) {
    const existing = must<Row | null>(await db().from("patients").select("*").eq("clinic_id", clinicId).eq("phone", input.phone).maybeSingle(), "find patient");
    if (existing) return existing;
  }
  return must(
    await db()
      .from("patients")
      .insert({ clinic_id: clinicId, name: input.name, phone: input.phone ?? null, language: input.language ?? "en" })
      .select("*")
      .single(),
    "create patient",
  ) as Row;
}

export async function searchPatients(query: string, clinicId = CLINIC_ID) {
  const q = query.replace(/[%,()]/g, "");
  const patients = must(
    await db().from("patients").select("id, name, phone, language").eq("clinic_id", clinicId).or(`name.ilike.%${q}%,phone.ilike.%${q}%`).limit(8),
    "search patients",
  ) as Row[];
  if (!patients.length) return [];
  const visits = must<Row[]>(
    await db().from("visits").select(VISIT_SELECT).in("patient_id", patients.map((p) => p.id)).order("created_at", { ascending: false }).limit(30),
    "patient visits",
  ).map(toVisit);
  return patients.map((p) => ({ ...p, visits: visits.filter((v) => v.patientId === p.id).slice(0, 5) }));
}

export async function nextToken(timezone: string, clinicId = CLINIC_ID): Promise<number> {
  return must(await db().rpc("next_token", { p_clinic: clinicId, p_day: localDate(await clinicNow(), timezone) }), "next token") as number;
}

export async function logEvent(e: {
  type: string;
  actor: "agent" | "staff" | "system" | "patient";
  summary: string;
  visitId?: string | null;
  doctorId?: string | null;
  payload?: unknown;
  clinicId?: string;
}) {
  must(
    await db()
      .from("events")
      .insert({
        clinic_id: e.clinicId ?? CLINIC_ID,
        type: e.type,
        actor: e.actor,
        summary: e.summary,
        visit_id: e.visitId ?? null,
        doctor_id: e.doctorId ?? null,
        payload: e.payload ?? {},
        created_at: (await clinicNow()).toISOString(),
      })
      .select("id"),
    "log event",
  );
}

export async function visitEvents(visitId: string) {
  return must(
    await db().from("events").select("type, actor, summary, created_at").eq("visit_id", visitId).order("created_at"),
    "visit events",
  ) as Row[];
}

export async function recentEvents(limit = 50, clinicId = CLINIC_ID) {
  return must(
    await db().from("events").select("*").eq("clinic_id", clinicId).order("created_at", { ascending: false }).limit(limit),
    "recent events",
  ) as Row[];
}

export async function insertNotification(n: {
  visitId: string | null;
  patientId: string | null;
  kind: string;
  body: string;
  sendAt?: string | null;
  draftedBy: string;
  /** "sent" for factual template replies that go out immediately (no model wrote them). */
  status?: "pending_approval" | "sent";
  clinicId?: string;
}) {
  return must(
    await db()
      .from("notifications")
      .insert({
        clinic_id: n.clinicId ?? CLINIC_ID,
        visit_id: n.visitId,
        patient_id: n.patientId,
        kind: n.kind,
        body: n.body,
        send_at: n.sendAt ?? null,
        drafted_by: n.draftedBy,
        status: n.status ?? "pending_approval",
        created_at: (await clinicNow()).toISOString(),
        decided_at: n.status === "sent" ? (await clinicNow()).toISOString() : null,
      })
      .select("*")
      .single(),
    "insert notification",
  ) as Row;
}

export async function listNotifications(status?: string, clinicId = CLINIC_ID) {
  let q = db().from("notifications").select("*, patients(name, phone)").eq("clinic_id", clinicId).order("created_at", { ascending: false }).limit(100);
  if (status) q = q.eq("status", status);
  return must(await q, "list notifications") as Row[];
}

export async function decideNotification(id: string, decision: "sent" | "rejected", body?: string) {
  const patch: Row = { status: decision, decided_at: (await clinicNow()).toISOString() };
  if (body) patch.body = body;
  return must(
    await db().from("notifications").update(patch).eq("id", id).eq("status", "pending_approval").select("*").maybeSingle(),
    "decide notification",
  ) as Row | null;
}

/** Exponential moving average so each doctor's estimate learns from today's real consult lengths. */
export async function learnConsultTime(doctor: Doctor, actualMin: number) {
  const clamped = Math.min(Math.max(actualMin, 3), 90);
  const next = Math.round(0.7 * doctor.avgConsultMin + 0.3 * clamped);
  if (next !== doctor.avgConsultMin) await updateDoctor(doctor.id, { avg_consult_min: next });
  return next;
}
