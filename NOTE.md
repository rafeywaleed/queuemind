# QueueMind: an AI agent that runs a clinic waiting room

**Live app:** https://queuemind-demo.vercel.app (no login; press **Reset demo** any time)
**Repo:** https://github.com/rafeywaleed/queuemind
**Demo video:** *(link)*, 4:54

---

## In one paragraph

QueueMind is an AI agent that works next to a clinic receptionist and runs the waiting room. When a doctor is called away, a walk-in arrives with chest pain, a patient texts "running late", or a booked patient doesn't show, the agent works out what changes, updates the queue, and drafts messages to the right patients in their own language. Every wait time and position is calculated by plain code, never guessed by the AI. Every message the AI writes waits for a person to approve it. It is built on a LangGraph Deep Agent, Supabase and Next.js, and runs entirely on free tiers.

---

## 1. The problem

If you have sat in a clinic waiting room in India or Pakistan, you know the feeling: you were booked for 10:30, it's almost 12, and nobody can tell you why.

The person in the middle is the **front-desk receptionist**. In a small clinic with two or three doctors, one receptionist handles:

- **bookings** arriving on time, early, late, or not at all,
- **walk-ins** who need to be triaged and sent to the right doctor,
- **doctors running late** or called away, which pushes back everyone in their queue,
- **no-shows**, where someone has to decide when a slot is really lost,
- **follow-ups**, which are free within a few days of the first visit,
- and now and then, **a real emergency** that must jump the queue.

Today this runs on paper, memory and WhatsApp. Patients get no honest estimate, so they either wait for hours or leave. The receptionist spends the day recalculating and apologising.

**The job I picked for the agent:** keep the queue honest and do the busywork (re-planning, triage, telling patients) so the receptionist only makes the decisions that need a human.

---

## 2. What it does

The app shows one simulated clinic (City Care Family Clinic): three doctors (Dr. Ayesha Khan and Dr. Bilal Ahmed in General Medicine, Dr. Sara Malik in Pediatrics) and 17 seeded visits. Patients have +91 and +92 numbers and speak English or Roman Urdu. A clinic clock runs at 6× (10 real seconds = 1 clinic minute), so patients arrive, run late, get called in and finish while you watch.

### Workflows the agent handles

| Situation | What happens |
|---|---|
| **Doctor delayed or called away** | The agent records the delay. The engine re-plans every queue and shows exactly whose wait changed and by how much. If moving patients would help, the agent compares options on a sandbox copy first. It then drafts delay texts for affected patients. |
| **Walk-in** | Triage runs in three layers: red-flag rules in code first, then the Laya decision model, then an LLM if Laya isn't confident. The most severe answer wins. Children go to Pediatrics. The patient goes to the doctor who can see them soonest and gets a token. |
| **Emergency** | It goes to **whichever doctor frees up first**, whatever their specialty. The agent's briefing must start with "EMERGENCY". |
| **Booked patient arrives** | Up to 10 minutes late keeps the slot (grace period). Later than that, they are seen in arrival order. A patient who hasn't checked in can't be raised to emergency, because they aren't in any queue yet. |
| **No-show** | The agent first sends an "are you on your way?" check. It can only close the visit after that message and 20 minutes overdue. |
| **Doctor leaves for the day** | Their patients are moved automatically to the least-loaded doctor of the same specialty. |
| **Follow-up** | Free within 5 days of the consult, decided by code using clinic-local dates. A reminder is drafted. |
| **Patient texts the clinic** | Laya reads the intent (on my way / running late / cancel / wait time / medical concern) in under a second. Routine messages it is confident about get an instant factual reply. Anything else goes to the agent and a person. |
| **Fairness** | Nobody is overtaken by later arrivals more than 2 times. |
| **Shift report** | A read-only sub-agent analyses the day and writes a report. |

### Screens

- **Simulation:** the clinic as a small 2D floor (entrance, reception, three rooms, waiting room). Click an event, watch patients move, and see a step-by-step strip of how the system handled it.
- **Live Lab:** trigger an event and watch the harness graph light up, call by call, with the clinic floor below.
- **How it works:** the full system map, the agent harness, middleware, model lanes, guardrails and all 18 tools.
- **Persona views:** Front desk (queue, alerts, agent chat, SMS outbox), Doctor (who's with me, who's next, "running late" in one tap), Patient (their phone: token, honest time, messages), Waiting room TV (tokens only, never names), Manager (metrics, audit trail, live safety counters, model routing).

Every screen updates live through Supabase Realtime.

---

## 3. How the harness is designed

### The core idea: split the brain

An LLM is good at reading a messy situation, choosing what to do, and writing a kind message. It is bad at arithmetic and at following rules every single time. So QueueMind splits the work:

- **Code** owns everything that must be correct: waits, start times, order, fees, priority rules, who may do what. A pure TypeScript **queue engine** recomputes the whole plan from the database on every change. It is unit-tested.
- **The AI** decides which action to take and writes the words. It quotes numbers from tool results and never computes them.
- **A person** approves every message the AI writes before a patient sees it.

### The agent (LangGraph Deep Agents, `deepagents` 1.14)

- **Context:** a system prompt with the clinic policy (grace 10 min, no-show 20 min, max 2 overtakes, free follow-up 5 days) and honesty rules. Every message gets the **live board attached**, so the agent starts informed and saves a model call.
- **Planner:** a `write_todos` checklist for multi-step work, streamed to the UI as a live plan.
- **Playbooks (skills):** five read-only files on the agent's virtual filesystem (`doctor-delay`, `walk-in-triage`, `late-arrivals-and-no-shows`, `follow-ups`, `shift-report`). Only their names sit in the prompt. The agent opens one when it needs it.
- **Sub-agent:** `ops-analyst`, with its own context and read-only tools, for reports and bottleneck analysis.
- **Memory:** conversation threads checkpointed in Supabase Postgres (`PostgresSaver`).
- **Middleware:** a call budget (at most 14 model calls per turn) and a custom quota-aware model pool. Generic file tools (ls, glob, grep, edit) are hidden so smaller models stay on task.

### 18 clinic tools, one rulebook

- **Read:** `get_queue_board`, `find_patient`, `visit_history` (answers "why did my position change?"), `recent_activity`
- **Act:** `check_in_patient`, `register_walk_in`, `report_doctor_delay`, `mark_doctor_available`, `mark_doctor_off_duty`, `start_consult`, `finish_consult`, `book_follow_up`, `cancel_visit`, `mark_no_show`, `raise_priority`, `reassign_visit`
- **Simulate:** `simulate_options` compares up to four plans on a copy of the clinic and saves nothing.
- **Communicate:** `draft_patient_sms` writes in the patient's language, with times filled in by code.

Every tool calls the **same service layer as the staff buttons**, so the agent and the receptionist follow the same rules. Every action returns its impact (who moved, by how many minutes) and is logged with who did it and why.

### Guardrails in code, not in the prompt

1. **Safety ratchet:** automation can only raise priority. Only staff can lower it.
2. **Red flags before any model:** chest pain, breathing trouble, stroke signs, fainting, heavy bleeding, allergic swelling, self-harm, high fever, pregnancy with pain or bleeding. These are matched in English and Roman Urdu (*seene mein dard*, *saans*, *behosh*, *tez bukhar*).
3. **Numbers guard:** if a drafted SMS contains a number that isn't in the facts, it is replaced by a template.
4. **Names guard:** if a draft names a doctor other than the patient's own, it is replaced by a template.
5. **"You've been moved" texts** need a real reassignment on record.
6. **Human approval:** drafts wait in an outbox (Approve & send / Edit / Reject).
7. **Contact before closing:** no no-show without a check message first.
8. **No double registration:** a booked patient can't be registered again as a walk-in.
9. **Emergencies aren't tied to one doctor**, so reassigning one is refused and the real route is returned instead.
10. **Race safety:** a unique index allows one consult per doctor, and status changes use compare-and-set, so two people can't call the same patient at once.
11. **Post-turn verifier:** after each turn, code checks that the event got its required action (an arrival must end in a check-in, a walk-in in a registration, a doctor leaving in a recorded absence, a delay in patient texts). If not, the agent is nudged once. Separately, a briefing that registered an emergency always opens with an EMERGENCY line.

### Three model lanes, all free

- **Reasoning lane (the agent):** a quota-aware pool of model × API-key members. Order: Gemini 3.5 / 3.8 Flash (2 keys) → Mistral ministral-14b / 8b → Gemini Flash preview / Flash-Lite → self-hosted Llama on Colab → Gemma 4 → Groq gpt-oss-120b. Free tiers allow about 5 requests a minute and 20 a day per Flash model, so every call is counted in a **shared ledger in Supabase** that all server instances read. On a 429 the pool waits out the provider's exact retry delay. Each call has a 40-second timeout.
- **Fast lane (small structured jobs, such as triage and SMS drafts):** Colab Llama → Groq gpt-oss-20b → Mistral ministral-8b → Gemini Flash-Lite, with a circuit breaker, zod-validated JSON, and a template if everything fails.
- **Decision lane (Laya):** an open-weight decision model from Convai Innovations (Apache-2.0), an open alternative to TypeSafe Jev. It answers typed questions with calibrated confidence.
  - **Patient texts:** auto-replies only when the intent is routine, confidence is at least 0.5, and its "needs a human" score is below 0.7.
  - **Walk-in triage:** its answer stands at 0.75 confidence or more, otherwise the LLM decides. It can only raise priority.
  - **Where it runs:** the official public Laya Space, so reviewers don't need to start anything. A Colab notebook or a private Space can take over.

### Data and deployment

- **Supabase Postgres tables:** clinics (policy and clock), doctors, patients, visits, events (audit log), notifications (outbox), patient_messages, token_counters, llm_calls and model_cooldowns (quota ledger), runtime_endpoints (Colab/Laya heartbeat). Agent checkpoints live in their own schema.
- **Realtime:** Supabase Realtime pushes changes to every screen.
- **The simulated clock:** an "autopilot" advances the clinic after each board request. A database lease makes sure only one server ticks at a time. If nobody has watched for 45 minutes, the next visitor gets a fresh morning.
- **Hosting:** Next.js 16 (App Router) on Vercel, Node 24, functions up to 300 seconds, agent replies streamed as NDJSON. The UI uses Tailwind 4, shadcn on Base UI, and Motion for animation.

---

## 4. How it was tested, and what broke

**Tests**
- **21 unit tests** for the queue engine: grace period, no-shows, fairness, delays, emergency routing, future-day bookings.
- **51 end-to-end checks** run against the live URL (`npm run test:e2e https://queuemind-demo.vercel.app`): every staff action, API validation, guardrails, a concurrent call-in race, the outbox, Laya patient texts, the clock, and autopilot invariants with three clients at 30× speed. **51/51 pass on the live site.**
- **Agent scenario suite** (`npm run test:agent`): runs every demo scenario through the real agent, then checks that nobody is stranded and no doctor has two consults.

**What broke, and what it became.** Most of the design above came from something going wrong:

| What broke | What I changed |
|---|---|
| Free-tier limits ran out within minutes | Quota-aware pool, a second key, Mistral, and a shared ledger |
| Gemini rejected the tool schemas | A schema sanitiser for Gemini's subset of JSON Schema |
| Two servers ticking the clinic at once created duplicate patients | Tick lease, unique index, compare-and-set updates |
| A doctor left and their patients were stranded | Automatic reassignment |
| The agent registered a booked patient as a new walk-in | Refused in code: use check-in |
| A weaker fallback model answered without registering an emergency | Post-turn verifier and a code-enforced EMERGENCY line |
| An emergency waited for its "own" doctor while another was free | Emergencies float to the first free doctor |
| The agent reassigned an emergency and its briefing named the wrong doctor | Tools return the real route; reassigning an emergency is refused |
| While recording the video, the agent drafted "your appointment moved to Dr. Bilal" for patients it never moved | "Moved" texts need a real reassignment, plus the names guard |
| A fallback model recorded a delay but drafted no texts | The verifier now requires texts after a delay event |
| Reviewers could open the demo hours later to an empty clinic at 4 PM | The demo starts a fresh shift after 45 minutes idle |

**Known limits**
- **Model quality depends on free quota.** When the strong Gemini models are used up for the day, fallback models are weaker. They skip optional steps, such as the what-if, and the verifier covers only the required ones.
- **Laya may need a moment to wake up.** It runs on a public Space; if the Space is asleep, triage falls back to the LLM.
- **The clinic is simulated.** SMS go to an in-app phone and outbox, not a real gateway. It is one clinic, with no login.

---

## 5. How long it took

About **20 hours of building**, from the first commit on the evening of **4 October** to the final tested deploy on the afternoon of **5 October** (21 commits). That came after time spent choosing the problem.

I built it with an AI pair programmer (Claude Code), as the brief encourages. The product choices, the split between code and AI, and the guardrails are decisions I can walk through in detail.

---

## 6. What I'd build next

1. **A real messaging channel:** an SMS or WhatsApp Business gateway, so approved texts reach real phones and replies come back into the same thread.
2. **A one-tap mobile view for doctors:** "running 10 minutes late", "call next" and "follow-up in 5 days" from the consult room.
3. **Fine-tune Laya on the clinic's own decisions:** every triage and intent decision is already logged next to what staff actually did, which is ready-made training data.
4. **Booking intake:** let patients book or reschedule by text, with the agent offering real free slots from the engine.
5. **Multi-clinic and roles:** logins for receptionist, doctor and manager, and per-clinic policies.
6. **Learning consult times:** per-doctor and per-reason durations from history, for even more honest estimates.
7. **Evals in CI:** run the agent scenario suite on every deploy against a pinned model, and track pass rate over time.

---

## Try it in two minutes

1. Open https://queuemind-demo.vercel.app and press **Reset demo**.
2. On **Simulation**, click **Chest-pain walk-in**. Watch the red patient on the floor and the steps underneath.
3. Open **Live Lab** and click **Doctor called away**. Watch the harness graph light up.
4. Open **Front desk** → **Outbox** and approve a draft. Then open **Patient**, pick that patient, and tap **Running 15 min late** or **On my way**.
5. Open **How it works** for the full system map, guardrails and tools.
