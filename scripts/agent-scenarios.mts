// Runs every demo scenario through the real agent (fresh thread each) and checks the outcome.
// Usage: npx tsx --env-file=.env.local scripts/agent-scenarios.mts
// Uses model quota (~5 calls per scenario). The clinic clock is paused so the autopilot can't move
// patients while the agent works.
import { runAgentTurn } from "../src/lib/agent/run";
import { resetDemo, SCENARIOS } from "../src/lib/clinic/seed";
import { boardRaw } from "../src/lib/clinic/actions";
import { controlClock } from "../src/lib/clinic/clock";

const EXPECT: Record<string, string[]> = {
  "doctor-late": ["report_doctor_delay"],
  "chest-pain": ["register_walk_in"],
  "routine-walk-in": ["register_walk_in"],
  sweep: [],
  cancellation: ["cancel_visit"],
  "finish-follow-up": ["finish_consult|book_follow_up"],
  "doctor-leaves": ["mark_doctor_off_duty"],
  report: [],
};

const rows: string[] = [];
let failures = 0;
await resetDemo();
await controlClock({ action: "pause" });

for (const s of SCENARIOS) {
  const started = Date.now();
  const tools: string[] = [];
  const toolErrors: string[] = [];
  let final = "";
  let error = "";
  for await (const e of runAgentTurn(`scenario-${s.id}-${Date.now()}`, s.event)) {
    if (e.type === "tool_call") tools.push(e.name);
    if (e.type === "tool_result" && e.isError && !/Refused|Policy|already|could not be called/i.test(e.content)) toolErrors.push(`${e.name}: ${e.content.slice(0, 100)}`);
    if (e.type === "final") final = e.text;
    if (e.type === "error") error = e.message;
  }
  const missing = (EXPECT[s.id] ?? []).filter((want) => !want.split("|").some((w) => tools.includes(w)));
  const emergencyFirst = s.id !== "chest-pain" || /^\W*EMERGENCY/i.test(final.trim());
  const ok = !error && final.length > 0 && missing.length === 0 && emergencyFirst;
  if (!ok) failures++;
  rows.push(
    `${ok ? "PASS" : "FAIL"}  ${s.id.padEnd(17)} ${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s  tools: ${tools.join(", ") || "—"}` +
      (missing.length ? `\n      missing: ${missing.join(", ")}` : "") +
      (toolErrors.length ? `\n      tool errors: ${toolErrors.join(" | ")}` : "") +
      (!emergencyFirst ? "\n      EMERGENCY was not the first line" : "") +
      (error ? `\n      error: ${error.slice(0, 200)}` : ""),
  );
}

// Invariants after the whole run.
const { state, snapshot } = await boardRaw();
const offDuty = new Set(state.doctors.filter((d) => d.status === "off_duty").map((d) => d.id));
const stranded = state.visits.filter((v) => offDuty.has(v.doctorId) && ["waiting", "scheduled"].includes(v.status)).length;
const twoConsults = state.doctors.some((d) => state.visits.filter((v) => v.doctorId === d.id && v.status === "in_consult").length > 1);
const pending = snapshot.alerts.length;
rows.push(`\nafter all scenarios: stranded=${stranded} two-consults=${twoConsults} alerts=${pending}`);
if (stranded || twoConsults) failures++;

await controlClock({ action: "play" });
console.log(rows.join("\n"));
console.log(`\n${SCENARIOS.length + 1 - failures}/${SCENARIOS.length + 1} passed`);
process.exit(failures ? 1 : 0);
