# QueueMind — waiting-room operations agent for clinics

A LangGraph **Deep Agent** that runs a clinic's front-desk queue: doctor delays, walk-ins, late patients,
no-shows, emergencies, cancellations, follow-ups and patient SMS — replanning the queue whenever reality changes.

**Design principle — split brain:** a deterministic queue engine does all the math (waits, order, fees, fairness);
the agent does the judgment (reading messy input, choosing between options, explaining, drafting messages).
The agent never computes a wait time or a fee — it calls tools that call the engine.

## Architecture

```
Next.js (Vercel) ── /api/agent ── deepagents (TS) ─┬─ Reasoning lane: quota-aware pool of free Gemini/Gemma models
       │                 │                          └─ tools ─► clinic service layer ─► queue engine (pure TS, unit-tested)
       │                 │                                              │
       │                 └─ LangGraph checkpointer (Supabase Postgres)  └─ Supabase: visits, doctors, events, outbox
       └─ /api/board, /api/actions (staff), /api/notifications (approve SMS), /api/status (model router)
Fast lane (intake triage, SMS drafts): Colab Llama (self-hosted, if online) → Groq gpt-oss-20b → Gemini Flash-Lite
```

| Piece | Where | Why |
|---|---|---|
| Queue engine | `src/lib/queue/engine.ts` | Greedy simulation per doctor: priority tiers, grace period, no-show cutoff, overrun handling, fairness guard. Pure + tested. |
| Policies | `src/lib/queue/policies.ts` | Free follow-up window (clinic-local dates), red-flag symptom rules, safety ratchet. |
| What-if sandbox | `src/lib/queue/simulate.ts` | Agent compares options (wait vs. reassign) on a copy of the clinic before acting. |
| Service layer | `src/lib/clinic/actions.ts` | One set of actions used by both agent tools and staff buttons. Every mutation returns its queue impact and is event-logged. |
| Agent | `src/lib/agent/*` | `createDeepAgent` + 18 clinic tools + read-only playbook skills + `ops-analyst` subagent + Postgres checkpointer. |
| Model router | `src/lib/llm/router.ts` | Fast lane: fallback chain with circuit breaker, zod-validated JSON, per-call telemetry. |
| Reasoning pool | `src/lib/llm/pool.ts` | Agent middleware. Free tiers cap each model separately (Gemini Flash: 5 req/min, 20 req/day), so each agent step goes to the first model with budget left: local per-model RPM accounting, cooldown on 429 (hour-long for daily caps), 40 s per-call timeout, skip on Groq's 8k-TPM limit. |
| Gemini schema adapter | `src/lib/llm/models.ts` | Converts tool JSON schemas to the OpenAPI subset Gemini accepts (no type arrays / exclusive bounds). |
| Colab runtime | `colab/queuemind_llama.ipynb` | Ollama + Llama on free T4, Cloudflare tunnel, self-registers via heartbeat. |

### Safety & trust mechanisms
- **Safety ratchet** — red-flag rules and the intake model can only *raise* priority; the agent's tool refuses to lower it. Only staff can.
- **Numbers guard** — SMS times/waits are filled by code; a model draft that introduces a number not in the facts is replaced by a template.
- **Human-in-the-loop outbox** — every patient message is a draft until staff approve it.
- **Fairness guard** — no waiting patient is overtaken by more than N later arrivals.
- **Contact before closing** — the agent cannot mark a no-show until a "are you on your way?" SMS has been drafted (staff can).
- **Audit log** — every change records actor (agent/staff/system) and reason; `visit_history` answers "why did my position change?".

## Setup

1. Create a Supabase project → SQL editor → run [`supabase/schema.sql`](supabase/schema.sql).
2. Copy `.env.example` to `.env.local` and fill in Supabase keys, the **session pooler** connection string, `GOOGLE_API_KEY`, `GROQ_API_KEY`, `RUNTIME_SECRET`.
3. `npm install`
4. Seed + smoke test the agent from the CLI: `npm run smoke -- doctor-late` (scenario ids in `src/lib/clinic/seed.ts`).
5. `npm run dev`, or deploy to Vercel with the same env vars.
6. Optional: open `colab/queuemind_llama.ipynb` in Colab (T4), set secrets `APP_URL` + `RUNTIME_SECRET`, run all.

`npm test` runs the queue-engine and policy tests.

## API

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/agent` `{threadId, message}` | Run one agent turn. Streams NDJSON: `token`, `todos`, `tool_call`, `tool_result`, `files`, `done`, `error`. |
| GET | `/api/agent?threadId=` | Rehydrate a thread (messages, todos, files). |
| GET | `/api/board` | Clinic policy, doctors, visits, and the engine's computed plan + alerts. |
| POST | `/api/actions` `{action, visit?, doctor?, ...}` | Staff actions: `check_in`, `start_consult`, `finish_consult`, `cancel`, `no_show`, `set_priority`, `reassign`, `doctor_delay`, `doctor_available`. |
| GET/POST | `/api/notifications` | Outbox list / approve (`sent`) or reject a draft. |
| GET | `/api/events` | Event log (newest first). |
| GET | `/api/status` | Model router: self-hosted Llama online?, fast-lane order, last-hour stats per provider. |
| GET/POST | `/api/demo` | Scenario list / reset the demo clinic to a fresh afternoon. |
| POST | `/api/runtime` | Colab heartbeat registration (shared secret). |
