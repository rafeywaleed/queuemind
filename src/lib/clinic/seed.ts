// Demo seed: a realistic mid-afternoon at a 3-doctor clinic, generated relative to "now"
// so reviewers always land in a live, slightly chaotic shift with real alerts to handle.
import { CLINIC_ID, db, must } from "../db/client";
import { localDate } from "../queue/policies";

const DOCTORS = {
  ayesha: "00000000-0000-0000-0000-0000000000d1",
  bilal: "00000000-0000-0000-0000-0000000000d2",
  sara: "00000000-0000-0000-0000-0000000000d3",
};

const TIMEZONE = process.env.CLINIC_TIMEZONE ?? "Asia/Karachi";

interface SeedVisit {
  token: number | null;
  patient: string;
  phone: string;
  language: string;
  doctor: keyof typeof DOCTORS;
  kind: "appointment" | "walk_in" | "follow_up";
  status: "scheduled" | "waiting" | "in_consult" | "done";
  scheduled?: number; // minutes from now
  arrived?: number;
  started?: number;
  ended?: number;
  est?: number;
  reason: string;
  priority?: "normal" | "urgent";
}

const VISITS: SeedVisit[] = [
  // Earlier today
  { token: 1, patient: "Hamza Qureshi", phone: "+92300000101", language: "en", doctor: "ayesha", kind: "appointment", status: "done", scheduled: -95, arrived: -100, started: -94, ended: -82, reason: "Blood pressure review" },
  { token: 2, patient: "Nadia Hussain", phone: "+919800000102", language: "ur", doctor: "ayesha", kind: "walk_in", status: "done", arrived: -80, started: -55, ended: -40, reason: "Persistent cough, 2 weeks" },

  // Dr. Ayesha Khan — General: steady, mid-consult
  { token: 3, patient: "Omar Farooq", phone: "+92300000103", language: "en", doctor: "ayesha", kind: "appointment", status: "in_consult", scheduled: -10, arrived: -18, started: -6, reason: "Diabetes medication review" },
  { token: 4, patient: "Zainab Ali", phone: "+919800000104", language: "ur", doctor: "ayesha", kind: "appointment", status: "waiting", scheduled: 5, arrived: -12, reason: "Follow-up on lab results" },
  { token: 6, patient: "Usman Tariq", phone: "+92300000106", language: "ur", doctor: "ayesha", kind: "walk_in", status: "waiting", arrived: -15, reason: "Sore throat and mild fever" },
  { token: 11, patient: "Fatima Siddiqui", phone: "+919800000111", language: "en", doctor: "ayesha", kind: "appointment", status: "scheduled", scheduled: 30, reason: "Annual check-up" },
  { token: 12, patient: "Ali Raza", phone: "+92300000112", language: "ur", doctor: "ayesha", kind: "appointment", status: "scheduled", scheduled: 45, reason: "Back pain" },

  // Dr. Bilal Ahmed — General: consult badly overrunning, queue piling up
  { token: 5, patient: "Saima Javed", phone: "+919800000105", language: "ur", doctor: "bilal", kind: "appointment", status: "in_consult", scheduled: -30, arrived: -35, started: -26, est: 12, reason: "Multiple chronic conditions review" },
  { token: 7, patient: "Bilal Akhtar", phone: "+92300000107", language: "en", doctor: "bilal", kind: "walk_in", status: "waiting", arrived: -22, reason: "Sprained ankle" },
  { token: 8, patient: "Hina Shah", phone: "+919800000108", language: "ur", doctor: "bilal", kind: "appointment", status: "waiting", scheduled: -15, arrived: -20, reason: "Thyroid follow-up" },
  { token: 9, patient: "Kamran Iqbal", phone: "+92300000109", language: "en", doctor: "bilal", kind: "appointment", status: "waiting", scheduled: 0, arrived: -4, reason: "Skin rash" },
  { token: 13, patient: "Maryam Butt", phone: "+919800000113", language: "ur", doctor: "bilal", kind: "appointment", status: "scheduled", scheduled: 15, reason: "Migraine" },
  { token: 14, patient: "Daniyal Mirza", phone: "+92300000114", language: "en", doctor: "bilal", kind: "appointment", status: "scheduled", scheduled: 30, reason: "Vaccination record" },

  // Dr. Sara Malik — Pediatrics: one likely no-show, one running late
  { token: 10, patient: "Ayaan Rehman (child)", phone: "+919800000110", language: "ur", doctor: "sara", kind: "walk_in", status: "waiting", arrived: -9, reason: "Child with ear pain" },
  { token: 15, patient: "Inaya Khalid (child)", phone: "+92300000115", language: "en", doctor: "sara", kind: "appointment", status: "scheduled", scheduled: -26, reason: "Growth check" },
  { token: 16, patient: "Rayan Abbasi (child)", phone: "+919800000116", language: "ur", doctor: "sara", kind: "appointment", status: "scheduled", scheduled: -14, reason: "Vaccination" },
  { token: 17, patient: "Zoya Imran (child)", phone: "+92300000117", language: "en", doctor: "sara", kind: "appointment", status: "scheduled", scheduled: 20, reason: "Allergy review" },
];

export async function resetDemo() {
  const now = Date.now();
  const at = (min?: number) => (min === undefined ? null : new Date(now + min * 60_000).toISOString());

  // Clear the clinic's operational data (agent checkpoints are per-thread and left alone).
  for (const table of ["notifications", "events", "visits", "patients", "token_counters"]) {
    must(await db().from(table).delete().eq("clinic_id", CLINIC_ID).select("clinic_id"), `clear ${table}`);
  }
  must(
    await db().from("clinics").upsert({
      id: CLINIC_ID,
      name: "City Care Family Clinic",
      timezone: TIMEZONE,
      grace_minutes: 10,
      no_show_minutes: 20,
      max_bumps: 2,
      free_follow_up_days: 5,
      delay_notify_threshold_min: 15,
    }).select("id"),
    "upsert clinic",
  );
  const shiftEnd = at(240);
  must(
    await db().from("doctors").upsert([
      { id: DOCTORS.ayesha, clinic_id: CLINIC_ID, name: "Dr. Ayesha Khan", specialty: "General Medicine", avg_consult_min: 12, status: "on_duty", available_at: null, shift_end: shiftEnd },
      { id: DOCTORS.bilal, clinic_id: CLINIC_ID, name: "Dr. Bilal Ahmed", specialty: "General Medicine", avg_consult_min: 10, status: "on_duty", available_at: null, shift_end: shiftEnd },
      { id: DOCTORS.sara, clinic_id: CLINIC_ID, name: "Dr. Sara Malik", specialty: "Pediatrics", avg_consult_min: 15, status: "on_duty", available_at: null, shift_end: shiftEnd },
    ]).select("id"),
    "upsert doctors",
  );

  const patients = must(
    await db()
      .from("patients")
      .insert(VISITS.map((v) => ({ clinic_id: CLINIC_ID, name: v.patient, phone: v.phone, language: v.language })))
      .select("id, phone"),
    "insert patients",
  ) as { id: string; phone: string }[];
  const patientId = new Map(patients.map((p) => [p.phone, p.id]));

  must(
    await db()
      .from("visits")
      .insert(
        VISITS.map((v) => ({
          clinic_id: CLINIC_ID,
          patient_id: patientId.get(v.phone),
          doctor_id: DOCTORS[v.doctor],
          kind: v.kind,
          status: v.status,
          priority: v.priority ?? "normal",
          token: v.token,
          scheduled_at: at(v.scheduled),
          arrived_at: at(v.arrived),
          consult_started_at: at(v.started),
          consult_ended_at: at(v.ended),
          est_minutes: v.est ?? null,
          reason: v.reason,
        })),
      )
      .select("id"),
    "insert visits",
  );

  const maxToken = Math.max(...VISITS.map((v) => v.token ?? 0));
  must(
    await db().from("token_counters").upsert({ clinic_id: CLINIC_ID, day: localDate(new Date(now), TIMEZONE), last: maxToken }).select("last"),
    "token counter",
  );
  must(
    await db().from("events").insert({ clinic_id: CLINIC_ID, type: "demo_reset", actor: "system", summary: "Demo clinic reset to a fresh afternoon shift" }).select("id"),
    "log reset",
  );
  return { ok: true, visits: VISITS.length };
}

/** One-click scenarios for the demo: each is sent to the agent as an [EVENT] from the clinic floor. */
export const SCENARIOS = [
  {
    id: "doctor-late",
    title: "Doctor stuck in traffic",
    event: "[EVENT] Front desk: Dr. Ayesha Khan just called — she had to step out for a hospital call and will be back in about 35-40 minutes.",
  },
  {
    id: "chest-pain",
    title: "Walk-in with chest pain",
    event:
      "[EVENT] Walk-in at the counter: Imran Shah, 58, phone +92300000199, speaks Urdu. He says: \"seene mein dard hai aur paseena aa raha hai, 20 minute se\" (chest pain and sweating for 20 minutes).",
  },
  {
    id: "routine-walk-in",
    title: "Routine walk-in",
    event: "[EVENT] Walk-in: Sana Tariq, phone +9198000000198, English. Needs a repeat prescription for her asthma inhaler, no other complaints.",
  },
  {
    id: "sweep",
    title: "Monitoring sweep",
    event: "[EVENT] Monitoring: run your routine sweep — check the board for no-shows, late patients, overruns and idle doctors, and handle what you can.",
  },
  {
    id: "cancellation",
    title: "Patient cancels",
    event: "[EVENT] Phone call: Maryam Butt (#13, Dr. Bilal) is cancelling today's appointment — family emergency.",
  },
  {
    id: "finish-follow-up",
    title: "Consult done + follow-up",
    event: "[EVENT] Dr. Ayesha Khan finished with #3 Omar Farooq and wants to see him again in 4 days.",
  },
  {
    id: "doctor-leaves",
    title: "Doctor leaves early",
    event: "[EVENT] Dr. Bilal Ahmed has to leave now for a family emergency and won't see any more patients today.",
  },
  {
    id: "report",
    title: "Shift report",
    event: "Give me a short shift report: how the afternoon is going, bottlenecks, and one suggestion.",
  },
];
