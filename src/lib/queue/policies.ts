// Deterministic clinic policies: follow-up fee rule, emergency red flags, safety ratchet.
import { PRIORITY_RANK } from "./engine";
import type { Priority } from "./types";

/** YYYY-MM-DD of an instant in the clinic's timezone. */
export function localDate(at: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
}

function daysBetween(fromYmd: string, toYmd: string): number {
  return Math.round((Date.parse(`${toYmd}T00:00:00Z`) - Date.parse(`${fromYmd}T00:00:00Z`)) / 86_400_000);
}

export interface FollowUpDecision {
  free: boolean;
  daysAfterConsult: number;
  freeUntil: string; // YYYY-MM-DD, last free day in clinic timezone
  reason: string;
}

/** Follow-ups within N calendar days of the original consult are free (counted in clinic-local dates). */
export function followUpFee(consultEndedAt: string, followUpAt: string, freeDays: number, timeZone: string): FollowUpDecision {
  const consultDay = localDate(consultEndedAt, timeZone);
  const followDay = localDate(followUpAt, timeZone);
  const days = daysBetween(consultDay, followDay);
  const freeUntilMs = Date.parse(`${consultDay}T00:00:00Z`) + freeDays * 86_400_000;
  const freeUntil = new Date(freeUntilMs).toISOString().slice(0, 10);
  if (days < 0) return { free: false, daysAfterConsult: days, freeUntil, reason: "Follow-up cannot be before the original consult." };
  const free = days <= freeDays;
  return {
    free,
    daysAfterConsult: days,
    freeUntil,
    reason: free
      ? `Day ${days} after consult — within the ${freeDays}-day free follow-up window (free until ${freeUntil}).`
      : `Day ${days} after consult — outside the ${freeDays}-day free window (ended ${freeUntil}); normal fee applies.`,
  };
}

// Red flags are matched before any model sees the text. Matching can only raise priority.
const RED_FLAGS: { level: Priority; label: string; patterns: RegExp[] }[] = [
  {
    level: "emergency",
    label: "possible cardiac event",
    patterns: [/chest (pain|tightness|pressure)/i, /chest (feels |is |getting )?(tight|heavy)/i, /heart attack/i, /pain.*(left arm|jaw)/i, /seene (mein|me) dard/i],
  },
  {
    level: "emergency",
    label: "breathing difficulty",
    patterns: [/(can'?t|cannot|difficulty|trouble|hard to) breath/i, /short(ness)? of breath/i, /choking/i, /saans/i, /blue lips/i],
  },
  {
    level: "emergency",
    label: "possible stroke",
    patterns: [/stroke/i, /face (droop|drooping)/i, /slurred speech/i, /(sudden )?(weakness|numbness) (on|in) one side/i],
  },
  {
    level: "emergency",
    label: "loss of consciousness / seizure",
    patterns: [/unconscious/i, /faint(ed|ing)/i, /passed out/i, /seizure/i, /\b(having|had|getting) (a )?fits?\b/i, /behosh/i],
  },
  {
    level: "emergency",
    label: "severe bleeding / trauma",
    patterns: [/(heavy|severe|won'?t stop|uncontrolled) bleed/i, /bleeding heavily/i, /head injury/i, /accident/i],
  },
  {
    level: "emergency",
    label: "severe allergic reaction",
    patterns: [/anaphyla/i, /(throat|tongue|lips?) (swelling|swollen)/i, /swollen (throat|tongue)/i],
  },
  {
    level: "emergency",
    label: "self-harm risk",
    patterns: [/suicid/i, /kill (myself|himself|herself)/i, /self[- ]harm/i, /overdose/i],
  },
  {
    level: "urgent",
    label: "high fever",
    patterns: [/(high|very high) fever/i, /fever (of )?(10[3-9]|39\.[5-9]|4\d)/i, /tez bukhar/i],
  },
  {
    level: "urgent",
    label: "pregnancy concern",
    patterns: [/pregnan.*(bleed|pain)/i, /(bleed|pain).*pregnan/i],
  },
  {
    level: "urgent",
    label: "severe pain",
    patterns: [/severe pain/i, /unbearable/i, /(10|ten) out of (10|ten)/i, /worst pain/i],
  },
  {
    level: "urgent",
    label: "infant / young child unwell",
    patterns: [/(infant|newborn|baby).*(fever|not feeding|lethargic|vomit)/i],
  },
];

export interface RedFlagResult {
  level: Priority;
  matches: string[];
}

export function screenRedFlags(text: string): RedFlagResult {
  const matches: string[] = [];
  let level: Priority = "normal";
  for (const flag of RED_FLAGS) {
    if (flag.patterns.some((p) => p.test(text))) {
      matches.push(flag.label);
      if (PRIORITY_RANK[flag.level] < PRIORITY_RANK[level]) level = flag.level;
    }
  }
  return { level, matches };
}

/** Safety ratchet: combine signals by taking the most severe. Automation can never lower a priority. */
export function maxPriority(...levels: (Priority | null | undefined)[]): Priority {
  return levels.reduce<Priority>(
    (acc, l) => (l && PRIORITY_RANK[l] < PRIORITY_RANK[acc] ? l : acc),
    "normal",
  );
}

export function isRaise(from: Priority, to: Priority): boolean {
  return PRIORITY_RANK[to] < PRIORITY_RANK[from];
}
