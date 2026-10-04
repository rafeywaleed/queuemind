// Display helpers shared by all views.
import type { Priority, VisitKind } from "./types";

export function clock(iso: string | null | undefined, timeZone?: string) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

export function minsBetween(a: string | number, b: string | number) {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60_000);
}

export function ago(iso: string) {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

export function initials(name: string) {
  return name
    .replace(/\(.*?\)/g, "")
    .replace(/^Dr\.?\s*/i, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
}

export const KIND_LABEL: Record<VisitKind, string> = { appointment: "Appointment", walk_in: "Walk-in", follow_up: "Follow-up" };

/** Tailwind classes per visit kind / priority — one colour language across every view. */
export function tone(kind: VisitKind, priority: Priority) {
  if (priority === "emergency") return { bar: "bg-qm-emergency", soft: "bg-qm-emergency/12 text-qm-emergency", text: "text-qm-emergency" };
  if (priority === "urgent") return { bar: "bg-qm-urgent", soft: "bg-qm-urgent/15 text-qm-urgent", text: "text-qm-urgent" };
  if (kind === "appointment") return { bar: "bg-qm-appointment", soft: "bg-qm-appointment/12 text-qm-appointment", text: "text-qm-appointment" };
  if (kind === "follow_up") return { bar: "bg-qm-followup", soft: "bg-qm-followup/12 text-qm-followup", text: "text-qm-followup" };
  return { bar: "bg-qm-walkin", soft: "bg-qm-walkin/12 text-qm-walkin", text: "text-qm-walkin" };
}

export const LANGUAGE_LABEL: Record<string, string> = { en: "English", ur: "Urdu (Roman)", ar: "Arabic" };
