// Domain knowledge as deep-agent skills: the agent sees each skill's name + description up front
// and reads the full playbook only when a situation calls for it (progressive disclosure).
// Mounted read-only at /skills/ in the agent's virtual filesystem.

const SKILLS: Record<string, string> = {
  "doctor-delay": `---
name: doctor-delay
description: Playbook for when a doctor is late, stuck, called away, or a consult is overrunning — impact analysis, rebalancing, and patient communication.
---
# Doctor delay playbook

Front-desk reality: a late doctor creates a silent waiting room. Patients get angry because nobody tells them anything, not because of the delay itself.

## Steps
1. Record the delay with \`report_doctor_delay\` (use the best estimate; "30-40 min" → 35). If the message says the doctor will not come at all, use \`mark_doctor_off_duty\` instead.
2. Read the impact list returned. Identify patients whose wait grew by 15+ minutes and booked patients now projected 15+ min behind their booking.
3. Is another doctor of the same specialty free or lightly loaded? If so, \`simulate_options\` comparing:
   - "wait for the delayed doctor" (no changes)
   - "move the next 1-2 walk-ins to Dr. X"
   Prefer the option with lower longest-wait without pushing anyone else past the notify threshold.
   Booked appointment patients chose their doctor — move them only if the delay is long (45+ min) and say so.
4. Apply the chosen reassignments with \`reassign_visit\`.
5. \`draft_patient_sms\` purpose=delay for affected patients still expected (not yet arrived) so they can come later, and for long-waiting patients in the room. Purpose=reassigned ONLY for patients you actually moved with reassign_visit (everyone else whose time changed gets purpose=delay).
6. Summarise: delay, who is affected, what you changed, drafts waiting for approval.

## Never
- Never promise an exact time beyond what the board says.
- Never move an EMERGENCY patient away from the first available doctor.
`,
  "walk-in-triage": `---
name: walk-in-triage
description: How to register walk-ins safely — red flags, emergency escalation, choosing a doctor, and what you must never do (diagnose, lower priority).
---
# Walk-in intake & triage

## Registering
- Use \`register_walk_in\` with the patient's own words as the complaint. Do not paraphrase symptoms away ("chest tightness" must stay in).
- The tool runs deterministic red-flag rules AND a fast intake model; the final priority is the most severe of the two. You may additionally \`raise_priority\` if the conversation reveals more.

## Emergencies
If the result is EMERGENCY:
1. Tell the front desk immediately, first line of your reply, in plain words: "EMERGENCY — alert Dr./nurse now".
2. For chest pain, breathing difficulty, stroke signs, unconsciousness, severe bleeding, anaphylaxis: advise calling emergency services / ER transfer — a GP clinic queue is not the place.
3. Do not ask the patient to wait in line.

## Never
- Never diagnose or give medical advice. You manage the queue, not the patient.
- Never lower a priority. If staff think it was over-triaged, they lower it themselves (the tool refuses you).
- Never put a patient's symptoms in an SMS.
`,
  "late-arrivals-and-no-shows": `---
name: late-arrivals-and-no-shows
description: Rules for patients who arrive late, never arrive, or cancel — grace period, slot release, no-show handling and filling gaps.
---
# Late arrivals, no-shows, cancellations

Clinic policy values are in the system prompt (grace minutes, no-show minutes).

## Late arrival
- Within grace: keeps their appointment slot. Check them in normally.
- Beyond grace: still seen today, but queued by arrival time (the engine does this automatically on check-in). Tell the front desk so they can explain it kindly to the patient.

## Likely no-show (alert on the board)
1. Do not mark no-show immediately — first \`draft_patient_sms\` purpose=no_show_check.
2. If the policy window has passed and staff confirm, \`mark_no_show\`. The tool refuses if it is too early.

## Cancellation
1. \`cancel_visit\`, read the impact: who moves up.
2. Patients whose wait dropped 15+ min and who are not yet in the room: \`draft_patient_sms\` purpose=turn_soon so they can come in earlier.
`,
  "follow-ups": `---
name: follow-ups
description: Booking follow-ups and the free follow-up rule — when it is free, how reminders work, how to explain the fee.
---
# Follow-ups

- Clinic rule: a follow-up within the free window (see system prompt, default 5 days) after the original consult is FREE. Day counting uses clinic-local calendar dates. After that, the normal fee applies.
- The fee decision is made by code in \`book_follow_up\` / \`finish_consult(follow_up_in_days)\`. Quote its "feeRule" text; never decide the fee yourself.
- If staff ask for a follow-up on a day that would be outside the window, tell them the last free day so they can choose.
- A reminder SMS is drafted automatically, scheduled for the day before, pending approval.
`,
  "shift-report": `---
name: shift-report
description: How to produce an end-of-shift or bottleneck report from the board and event log.
---
# Shift report

Delegate to the \`ops-analyst\` subagent when asked for a report, or do it yourself for a quick answer.

Report sections (write to /reports/shift-<date>.md):
1. Throughput: consults completed per doctor; learned average consult time per doctor.
2. Waits: current longest wait; who waited longest today.
3. Disruptions: delays, overruns, no-shows, emergencies — with times.
4. Communication: SMS drafted / approved / rejected.
5. One or two concrete suggestions (e.g. "Dr. X's average is 18 min vs 12 booked — widen their slots").
Only use numbers that appear in tool outputs.
`,
};

export function skillFiles() {
  const now = new Date().toISOString();
  return Object.fromEntries(
    Object.entries(SKILLS).map(([name, content]) => [
      `/skills/${name}/SKILL.md`,
      { content, mimeType: "text/markdown", created_at: now, modified_at: now },
    ]),
  );
}
