// Fast-lane tasks. Each one has a deterministic fallback so the clinic keeps working
// even when every model is down.
import { z } from "zod";
import { fastJson, type ProviderName } from "./router";
import type { Priority } from "../queue/types";

const IntakeSchema = z.object({
  specialty: z.string(),
  est_minutes: z.coerce.number().int().min(3).max(90),
  urgency: z.enum(["emergency", "urgent", "normal"]),
  summary: z.string().max(200),
});

export interface IntakeResult {
  specialty: string;
  estMinutes: number | null;
  urgency: Priority;
  summary: string;
  servedBy: ProviderName | "fallback";
}

/** Classify a walk-in complaint: which specialty, how long, how urgent (second opinion to the red-flag rules). */
export async function classifyIntake(complaint: string, specialties: string[]): Promise<IntakeResult> {
  try {
    const { data, provider } = await fastJson({
      purpose: "intake_triage",
      system: [
        "You are a clinic intake assistant. You do not diagnose.",
        `Pick the best specialty from this list exactly: ${specialties.join(", ")}.`,
        "Estimate consult minutes (5-40 typical).",
        "urgency: 'emergency' for life-threatening signs, 'urgent' for needs-to-be-seen-soon, else 'normal'. When unsure, choose the more urgent level.",
        'Return {"specialty": string, "est_minutes": number, "urgency": "emergency"|"urgent"|"normal", "summary": string (<=20 words, neutral)}.',
      ].join("\n"),
      user: `Patient's words: """${complaint.slice(0, 1000)}"""`,
      schema: IntakeSchema,
    });
    const specialty = specialties.find((s) => s.toLowerCase() === data.specialty.toLowerCase()) ?? specialties[0];
    return { specialty, estMinutes: data.est_minutes, urgency: data.urgency, summary: data.summary, servedBy: provider };
  } catch {
    return { specialty: specialties[0], estMinutes: null, urgency: "normal", summary: complaint.slice(0, 120), servedBy: "fallback" };
  }
}

export type MessagePurpose = "delay" | "turn_soon" | "follow_up_reminder" | "cancellation" | "no_show_check" | "reassigned" | "custom";

const TEMPLATES: Record<MessagePurpose, (f: Record<string, string | number>) => string> = {
  delay: (f) => `Hi ${f.patient}, ${f.doctor} is running behind today. Your expected time is now around ${f.eta} (about ${f.wait} min from now). Sorry for the wait — ${f.clinic}.`,
  turn_soon: (f) => `Hi ${f.patient}, you're next in about ${f.wait} min with ${f.doctor}. Please be in the waiting area. — ${f.clinic}`,
  follow_up_reminder: (f) => `Hi ${f.patient}, reminder of your follow-up with ${f.doctor} on ${f.date}. ${f.fee} — ${f.clinic}`,
  cancellation: (f) => `Hi ${f.patient}, your visit with ${f.doctor} has been cancelled. Reply to rebook. — ${f.clinic}`,
  no_show_check: (f) => `Hi ${f.patient}, we missed you for your ${f.time} visit with ${f.doctor}. Are you on your way? Reply YES or call us to rebook. — ${f.clinic}`,
  reassigned: (f) => `Hi ${f.patient}, to reduce your wait you'll now see ${f.doctor}. Expected time around ${f.eta}. — ${f.clinic}`,
  custom: (f) => `Hi ${f.patient}, ${f.note} — ${f.clinic}`,
};

/**
 * Draft an SMS in the patient's language. Code supplies every number (times, minutes, dates);
 * the model only writes the words. A draft that introduces a number not in the facts is rejected
 * and replaced by the template — patients are never told a made-up time.
 */
export async function draftPatientMessage(input: {
  purpose: MessagePurpose;
  language: string;
  facts: Record<string, string | number>;
  note?: string;
}): Promise<{ body: string; servedBy: ProviderName | "template"; guard: string | null }> {
  const facts = { ...input.facts, note: input.note ?? "" };
  const template = TEMPLATES[input.purpose](facts);
  try {
    const { data, provider } = await fastJson({
      purpose: `sms_${input.purpose}`,
      system: [
        "You write short, warm SMS messages from a clinic front desk to a patient.",
        `Write in this language: ${input.language} (if 'ur', use Roman Urdu in Latin script).`,
        "Use ONLY the facts given. Never invent times, numbers, diagnoses, or promises. Max 300 characters.",
        'Return {"message": string}.',
      ].join("\n"),
      user: `Purpose: ${input.purpose}\nFacts: ${JSON.stringify(facts)}\nReference wording: ${template}`,
      schema: z.object({ message: z.string().min(5).max(480) }),
    });
    const allowed = new Set(JSON.stringify(facts).match(/\d+/g) ?? []);
    const invented = (data.message.match(/\d+/g) ?? []).filter((n) => !allowed.has(n));
    if (invented.length) return { body: template, servedBy: "template", guard: `model introduced numbers not in facts (${invented.join(", ")}) — used template` };
    return { body: data.message, servedBy: provider, guard: null };
  } catch {
    return { body: template, servedBy: "template", guard: "fast lane unavailable — used template" };
  }
}
