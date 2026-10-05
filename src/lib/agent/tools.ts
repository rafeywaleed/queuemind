// Agent tools: thin wrappers over the clinic service layer. Errors are returned as text
// (not thrown) so the agent can read the rule it hit and recover.
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import * as clinic from "../clinic/actions";
import { recentEvents, searchPatients } from "../db/repo";
import { fmtTime } from "../clinic/format";

const AGENT = "agent" as const;

function wrap<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return JSON.stringify(await fn(args), null, 1);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `ERROR: ${message}`;
    }
  };
}

const visitRef = z.string().describe('Token like "#12" (or "12"), or a visit id from the board');
const doctorRef = z.string().describe('Doctor name (e.g. "Dr. Ahmed" or "Ahmed") or id');
const priority = z.enum(["emergency", "urgent", "normal"]);

export const getQueueBoard = tool(wrap(() => clinic.board()), {
  name: "get_queue_board",
  description:
    "Live clinic board computed by the deterministic queue engine: each doctor's status, who is with them, the planned queue with start times and waits, and active alerts. Call this before deciding anything about the queue.",
  schema: z.object({}),
});

export const findPatient = tool(
  wrap(({ query }: { query: string }) => searchPatients(query)),
  {
    name: "find_patient",
    description: "Search patients by (part of) name or phone. Returns recent visits with their tokens and statuses.",
    schema: z.object({ query: z.string() }),
  },
);

export const checkInPatient = tool(wrap(({ visit }: { visit: string }) => clinic.checkIn(visit, AGENT)), {
  name: "check_in_patient",
  description: "Mark a booked patient (appointment or follow-up) as arrived. Applies the grace-period rule: late beyond grace loses their slot and queues by arrival.",
  schema: z.object({ visit: visitRef }),
});

export const registerWalkIn = tool(
  wrap((a: { patient_name: string; phone?: string; language?: string; complaint: string; age?: number; preferred_doctor?: string }) =>
    clinic.registerWalkIn(
      { patientName: a.patient_name, phone: a.phone, language: a.language, complaint: a.complaint, age: a.age, preferredDoctor: a.preferred_doctor },
      AGENT,
    ),
  ),
  {
    name: "register_walk_in",
    description:
      "Register a walk-in patient. Runs red-flag rules + intake model on the complaint (most severe wins), picks the doctor with the shortest projected wait, issues a token.",
    schema: z.object({
      patient_name: z.string().describe("Exactly as written in the CURRENT message. Never reuse a name from earlier messages."),
      age: z.number().int().min(0).max(120).optional().describe("Age in years if stated. Under 16 goes to Pediatrics, adults never do."),
      phone: z.string().optional(),
      language: z.string().optional().describe('ISO code: "en", "ur" (Roman Urdu), "ar", ...'),
      complaint: z.string().describe("The patient's reason for visit, in their own words"),
      preferred_doctor: z.string().optional(),
    }),
  },
);

export const reportDoctorDelay = tool(
  wrap(({ doctor, minutes, reason }: { doctor: string; minutes: number; reason: string }) => clinic.reportDoctorDelay(doctor, minutes, reason, AGENT)),
  {
    name: "report_doctor_delay",
    description: "Record that a doctor will be unavailable for N more minutes (late arrival, emergency, stepped out). Returns which patients' waits changed.",
    schema: z.object({ doctor: doctorRef, minutes: z.number().int().min(1).max(480), reason: z.string() }),
  },
);

export const markDoctorAvailable = tool(wrap(({ doctor }: { doctor: string }) => clinic.doctorAvailable(doctor, AGENT)), {
  name: "mark_doctor_available",
  description: "Doctor has arrived / is back and available now.",
  schema: z.object({ doctor: doctorRef }),
});

export const markDoctorOffDuty = tool(
  wrap(({ doctor, reason }: { doctor: string; reason: string }) => clinic.doctorOffDuty(doctor, reason, AGENT)),
  {
    name: "mark_doctor_off_duty",
    description: "Doctor has left / will not see more patients today. Returns patients who now need reassignment.",
    schema: z.object({ doctor: doctorRef, reason: z.string() }),
  },
);

export const startConsult = tool(wrap(({ visit }: { visit: string }) => clinic.startConsult(visit, AGENT)), {
  name: "start_consult",
  description: "Call a waiting patient in to their doctor.",
  schema: z.object({ visit: visitRef }),
});

export const finishConsult = tool(
  wrap(({ visit, follow_up_in_days, notes }: { visit: string; follow_up_in_days?: number; notes?: string }) =>
    clinic.finishConsult(visit, { followUpInDays: follow_up_in_days, notes }, AGENT),
  ),
  {
    name: "finish_consult",
    description:
      "Complete a consult. Updates the doctor's learned average consult time. Optionally books a follow-up N days later (fee rule applied automatically, reminder drafted).",
    schema: z.object({ visit: visitRef, follow_up_in_days: z.number().int().min(1).max(60).optional(), notes: z.string().optional() }),
  },
);

export const bookFollowUp = tool(
  wrap(({ visit, in_days }: { visit: string; in_days: number }) => clinic.bookFollowUp(visit, in_days, AGENT)),
  {
    name: "book_follow_up",
    description: "Book a follow-up for a completed visit N days after the consult. The free-follow-up window is checked by code; a reminder SMS is drafted for approval.",
    schema: z.object({ visit: visitRef, in_days: z.number().int().min(1).max(60) }),
  },
);

export const cancelVisit = tool(
  wrap(({ visit, reason }: { visit: string; reason: string }) => clinic.cancelVisit(visit, reason, AGENT)),
  {
    name: "cancel_visit",
    description: "Cancel a booked or waiting visit. Returns who moves up as a result.",
    schema: z.object({ visit: visitRef, reason: z.string() }),
  },
);

export const markNoShow = tool(wrap(({ visit }: { visit: string }) => clinic.markNoShow(visit, AGENT)), {
  name: "mark_no_show",
  description: "Mark a booked patient as a no-show. Policy: only after a no_show_check SMS was drafted for them and enough time has passed since their slot (both enforced).",
  schema: z.object({ visit: visitRef }),
});

export const raisePriority = tool(
  wrap(({ visit, to, reason }: { visit: string; to: "emergency" | "urgent" | "normal"; reason: string }) => clinic.setPriority(visit, to, reason, AGENT)),
  {
    name: "raise_priority",
    description: "Raise a patient's priority (normal → urgent → emergency). You cannot lower priority — that is refused and must be done by staff.",
    schema: z.object({ visit: visitRef, to: priority, reason: z.string() }),
  },
);

export const reassignVisit = tool(
  wrap(({ visit, doctor, reason }: { visit: string; doctor: string; reason: string }) => clinic.reassign(visit, doctor, reason, AGENT)),
  {
    name: "reassign_visit",
    description: "Move a waiting or booked patient to another on-duty doctor. Simulate first if unsure it helps.",
    schema: z.object({ visit: visitRef, doctor: doctorRef, reason: z.string() }),
  },
);

const change = z.object({
  type: z.enum(["doctor_delay", "doctor_available", "reassign", "cancel", "set_priority", "add_walk_in"]),
  doctor: z.string().optional(),
  visit: z.string().optional(),
  minutes: z.number().optional().describe("delay minutes, or est minutes for add_walk_in"),
  priority: priority.optional(),
});

export const simulateOptions = tool(wrap(({ options }: { options: { label: string; changes: z.infer<typeof change>[] }[] }) => clinic.simulateOptions(options)), {
  name: "simulate_options",
  description:
    "What-if sandbox. Compare one or more alternative plans on a copy of the clinic without saving anything. Returns total waiting-room minutes, longest wait and per-patient impact for each option.",
  schema: z.object({ options: z.array(z.object({ label: z.string(), changes: z.array(change) })).min(1).max(4) }),
});

export const draftNotifications = tool(
  wrap(({ visits, purpose, note }: { visits: string[]; purpose: "delay" | "turn_soon" | "cancellation" | "no_show_check" | "reassigned" | "custom"; note?: string }) =>
    clinic.draftNotifications(visits, purpose, note ?? null, AGENT),
  ),
  {
    name: "draft_patient_sms",
    description:
      "Draft SMS messages to patients (in each patient's language). Times and waits are filled in by code from the live queue. Drafts go to the outbox for staff approval; nothing is sent automatically. Duplicate drafts within 20 min are skipped.",
    schema: z.object({
      visits: z.array(visitRef).min(1).max(20),
      purpose: z.enum(["delay", "turn_soon", "cancellation", "no_show_check", "reassigned", "custom"]),
      note: z.string().optional().describe("Only for purpose=custom: the message content"),
    }),
  },
);

export const visitHistory = tool(wrap(({ visit }: { visit: string }) => clinic.visitHistory(visit)), {
  name: "visit_history",
  description: "Full audit trail for one visit plus where it sits in the queue now and why. Use to answer 'why did my position change?'.",
  schema: z.object({ visit: visitRef }),
});

export const recentActivity = tool(
  wrap(async ({ limit }: { limit?: number }) => {
    const { state } = await clinic.boardRaw();
    const events = await recentEvents(limit ?? 40);
    return events.map((e) => `${fmtTime(e.created_at, state.clinic.timezone)} [${e.actor}] ${e.type}: ${e.summary}`);
  }),
  {
    name: "recent_activity",
    description: "The clinic's event log (newest first): check-ins, delays, triage, reassignments, notifications.",
    schema: z.object({ limit: z.number().int().min(5).max(200).optional() }),
  },
);

export const operationsTools = [
  getQueueBoard,
  findPatient,
  checkInPatient,
  registerWalkIn,
  reportDoctorDelay,
  markDoctorAvailable,
  markDoctorOffDuty,
  startConsult,
  finishConsult,
  bookFollowUp,
  cancelVisit,
  markNoShow,
  raisePriority,
  reassignVisit,
  simulateOptions,
  draftNotifications,
  visitHistory,
  recentActivity,
];

export const analystTools = [getQueueBoard, recentActivity, visitHistory, simulateOptions];
