# QueueMind: an operations agent for the clinic waiting room

**Live:** https://queuemind-demo.vercel.app · **Stack:** Next.js + Tailwind + shadcn · Supabase · LangGraph Deep Agents (`deepagents`)

A doctor is called away, a consult runs long, a booked patient doesn't show, a walk-in has chest pain, a doctor has to leave early. Small clinics run their waiting room on paper tokens, so nobody replans and nobody tells the patients. QueueMind is a deep agent for the front desk that **replans the queue when reality changes, tells the right patients, and keeps humans in charge** of anything it writes.

## Try it in two minutes
1. Open the live link. **Simulation** shows a 3-doctor clinic that runs by itself (10 real seconds = 1 clinic minute): patients arrive, consults end, walk-ins come in.
2. Click **Agent → Doctor called away** or **Chest-pain walk-in**. Watch patients move on the floor and every step appear in the flow line (*Event → AI model → Tool → Database → …*).
3. Click **Patient SMS → "How long is the wait?"**. Laya, a decision model, reads the intent in under a second and the clinic replies instantly with the engine's real numbers, without an LLM.
4. Use **View as** to see the same moment as the front desk, a doctor, a patient's phone, the lobby TV and the manager.
5. **How it works** has the system map (pick a journey and it plays step by step) and the full agent harness.

**Reset demo** (top right) starts a fresh shift at any time.

## Design in one line
**The models read and decide; deterministic code owns every number and every rule.** Waits, order, fees and priority come from a tested queue engine. The agent calls tools that call the engine, and the guardrails live in code, not in the prompt.

## Architecture
```
Screens (Next.js) ─► API routes (Vercel) ─┬─► Deep agent harness ─► Reasoning pool (Gemini ×2 keys · Mistral · Llama · Groq)
   desk · doctor ·        /api/agent       │     plan · 5 playbooks · 18 tools · subagent · Postgres memory
   patient phone ·        /api/actions     ├─► Red-flag rules ─► Laya decision model (patient texts, triage 2nd opinion)
   lobby TV · manager     /api/patient-…   ├─► Autopilot (arrivals, consults, walk-ins) on a shared clinic clock
                          /api/board       └─► Service layer + guardrails ─► Queue engine (pure TS) ─► Supabase ─► Realtime ─► every screen
```

| Part | Where | What it does |
|---|---|---|
| Queue engine | `src/lib/queue/engine.ts` | Per-doctor plan: priority tiers, grace period, no-show cutoff, overruns, doctor delays, fairness (max 2 overtakes). Pure and unit-tested. |
| What-if sandbox | `src/lib/queue/simulate.ts` | The agent compares options (wait vs. move patients) on a copy of the clinic before acting. |
| Service layer | `src/lib/clinic/actions.ts` | One rulebook for agent, staff and autopilot. Every change returns its impact and is audit-logged with actor and reason. |
| Agent harness | `src/lib/agent/*` | `createDeepAgent` with planning, read-only playbook skills, 18 clinic tools, an `ops-analyst` subagent, a per-turn call budget, a post-turn verifier and Postgres checkpoints. |
| Reasoning pool | `src/lib/llm/pool.ts` | Free tiers cap each model separately, so each step goes to a model×key with budget left, counted in a shared Supabase ledger. 429s cool down for the provider's exact retry delay; 40 s per-call timeout. |
| Fast lane | `src/lib/llm/router.ts`, `tasks.ts` | SMS drafts in the patient's language and intake classification: Colab Llama → Groq → Mistral → Gemini, with circuit breaker and template fallback. |
| Decision lane (Laya) | `src/lib/llm/decision.ts` | Typed questions with calibrated probabilities. Uses the official public Laya demo Space by default; local / own server / Colab via Jev's `/v1/systemone` API. |
| Clinic clock + autopilot | `src/lib/clinic/clock.ts`, `autopilot.ts` | Shared simulated time (6×), play/pause/skip. While it runs, the clinic lives on its own; a database lease ensures only one server advances it at a time. |

### Guardrails, enforced in code
- **Code does the numbers.** The model quotes waits and fees; it never computes them.
- **Safety ratchet.** Red-flag rules run before any model; automation can raise priority, never lower it (staff can).
- **EMERGENCY first.** If a tool registered an emergency, the briefing starts with it, even if the model forgot.
- **Humans approve AI-written SMS.** Drafts wait in the outbox. Only factual replies built from engine numbers go out instantly, and a draft that invents a number is replaced by a template.
- **Contact before closing.** The agent can't mark a no-show until the patient has been texted.
- **No double registration.** A booked patient who arrives is checked in, never registered again as a walk-in.
- **Nobody stranded.** When a doctor leaves, their patients move to the least-busy doctor of the same specialty.
- **Post-turn verifier.** If an event needed an action (register a walk-in, record a doctor leaving) and the model skipped it, the harness re-prompts once.
- **One consult per doctor.** A unique index plus compare-and-set status changes make races fail safely.

### Laya: where a decision model beats an LLM
Measured on this clinic's messages, Laya reads patient-text intent with 0.86–0.99 confidence in about 0.6 s, so low-risk texts ("on my way", "running late", "how long?") are answered with no LLM call. On walk-in triage it is weak zero-shot (correct specialty, low confidence), so it acts only as an emergency second opinion and the LLM decides. Every decision is logged next to the outcome, ready for fine-tuning.

## Run it locally
1. Create a Supabase project and run [`supabase/schema.sql`](supabase/schema.sql) in the SQL editor.
2. `cp .env.example .env.local` and fill in Supabase, `DATABASE_URL` (session pooler), `GOOGLE_API_KEY` and `GROQ_API_KEY`. Everything else is optional; see the comments.
3. `npm install` and `npm run dev`, then open http://localhost:3000.
4. Optional: `colab/queuemind_selfhosted.ipynb` runs Laya (and optionally Llama) on a free Colab GPU and registers itself with the app.

Deploying is the same on Vercel: import the repo, Next.js preset, paste the env vars. `next build --webpack` is used on purpose: Turbopack's hashed external packages break the agent runtime on Vercel.

## Testing
| Command | What it checks |
|---|---|
| `npm test` | Unit tests: queue engine (ordering, grace, fairness, overruns, no-shows), follow-up fees, red flags, age → specialty rule |
| `npm run test:e2e` | 47 end-to-end checks against a running app: API validation, the clinic clock, every staff action, agent guardrails, a concurrent call-in race, outbox approve/reject, Laya patient texts, doctor-leaves auto-reassign, autopilot invariants at 30× with 3 clients |
| `npm run test:agent` | Every demo scenario through the real agent: expected tools called, no tool errors, EMERGENCY first for red-flag walk-ins, nobody stranded afterwards (uses model quota) |
| `npm run test:ui` | Every screen in a headless browser with the key controls clicked; fails on any console or page error |

## Known limitations and what's next
- **SMS is simulated.** Next: Twilio / WhatsApp Business behind the same outbox.
- **One demo clinic, no login.** Next: Supabase Auth, a `clinic_id` on every query with row-level security, and staff roles.
- **Free model tiers.** Gemini Flash allows about 20 requests/day per model per project, so busy days fall back to smaller models. The verifier and code guardrails catch what they miss. A paid tier would remove this.
- **Laya zero-shot triage is weak.** Next: fine-tune it on the logged decisions.
- **Red-flag rules are keyword-based** and tuned to over-escalate; they need clinical review before real use.
