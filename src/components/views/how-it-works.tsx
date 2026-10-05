"use client";
// "How it works": the whole harness on one page. Click any node for its spec.
import { useState } from "react";
import { FileCode2, ShieldCheck } from "lucide-react";
import { HarnessGraph } from "@/components/lab/harness-graph";
import { NODES, TOOL_CATALOG, type NodeId } from "@/components/lab/harness-spec";
import { StatusDetail } from "@/components/qm/status-pill";
import { SystemMap } from "@/components/views/system-map";
import { cn } from "@/lib/utils";
import type { ClinicData } from "@/lib/client/use-clinic";

const TURN = [
  ["Trigger", "A clinic event or message arrives at POST /api/agent with a thread id."],
  ["Context", "The live board (computed by the engine) is attached; the thread's history is loaded from the Postgres checkpointer."],
  ["Model call", "Middleware runs in order: planner, call budget, quota-aware pool. The pool picks a model × key with budget left."],
  ["Decide", "The model either answers or calls tools. It may open a playbook first (read_file on /skills/…)."],
  ["Act", "Tools call the service layer. Guardrails run here, then the engine replans and the change is logged with actor + reason."],
  ["Impact", "Each action returns who moved and by how much; the model reads it and decides who to tell."],
  ["Communicate", "SMS drafts are written by the fast lane in the patient's language; code fills the numbers; drafts wait in the outbox."],
  ["Report", "A short briefing streams back. Supabase Realtime updates every view: desk, doctor, patient phone, lobby TV."],
];

const MIDDLEWARE = [
  ["todoListMiddleware", "Planning tool + live checklist"],
  ["modelCallLimitMiddleware", "≤ 14 model calls per turn, then end"],
  ["QuotaAwareModelPool", "Picks a model × key with budget; hides ls/glob/grep; 40 s per call"],
  ["deepagents: filesystem", "Virtual FS; /skills/ is write-denied"],
  ["deepagents: skills", "Playbook names in prompt, bodies on demand"],
  ["deepagents: subagents", "task tool → ops-analyst (isolated context)"],
  ["deepagents: summarization", "Compacts long threads automatically"],
];

const GUARDRAILS = [
  ["Code does the numbers", "Waits, start times, positions and fees come from the queue engine (13 unit tests). The model only quotes them."],
  ["Safety ratchet", "Red-flag rules and the triage model can only raise priority. The agent's tool refuses to lower it; only staff can."],
  ["Red flags before any model", "Chest pain, breathing, stroke signs… matched in English and Roman Urdu before the LLM sees the text."],
  ["Numbers guard", "If an SMS draft contains a number not in the facts, it's replaced by a template."],
  ["Human-approved messages", "Nothing reaches a patient until staff approve it in the outbox."],
  ["Contact before closing", "The agent can't mark a no-show until a 'are you on your way?' SMS exists."],
  ["Fairness", "No patient is overtaken by later arrivals more than 2 times."],
  ["System 1 / System 2", "Laya answers triage in milliseconds with a calibrated probability; below 0.75 confidence the LLM decides instead."],
  ["Bounded turns", "Call budget + per-call timeout keep every turn inside the 300 s serverless limit."],
];

export function HowItWorksView({ data }: { data: ClinicData }) {
  const [selected, setSelected] = useState<NodeId>("pool");
  const node = NODES.find((n) => n.id === selected)!;
  const tools = TOOL_CATALOG.find((g) => g.node === selected);

  return (
    <div className="space-y-6">
      <div className="max-w-3xl">
        <h1 className="font-display text-4xl leading-tight">A deep agent, wrapped in rules it can&apos;t break.</h1>
        <p className="mt-2 text-muted-foreground">
          The LLM reads situations, picks tools and writes messages. Everything that must be correct (waits, order, fees, priority) is deterministic code. Click any box to see how it works.
        </p>
      </div>

      <SystemMap />

      <h2 className="pt-2 text-lg font-semibold">Inside the agent harness</h2>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="rounded-2xl border bg-card p-3">
          <HarnessGraph mode="explore" selected={selected} onSelect={setSelected} />
        </div>
        <aside className="rounded-2xl border bg-card p-4">
          <div className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{node.layer}</div>
          <h2 className="text-xl font-semibold">{node.title}</h2>
          <div className="text-sm text-muted-foreground">{node.subtitle}</div>
          <ul className="mt-3 space-y-2">
            {node.spec.map((s) => (
              <li key={s} className="flex gap-2 text-sm">
                <span className="mt-2 size-1.5 shrink-0 rounded-full bg-primary" /> {s}
              </li>
            ))}
          </ul>
          {tools && (
            <div className="mt-4 space-y-1.5">
              {tools.tools.map((t) => (
                <div key={t.name} className="rounded-lg bg-muted/50 px-2.5 py-1.5">
                  <code className="font-mono text-[12px] font-semibold">{t.name}</code>
                  <div className="text-[12px] text-muted-foreground">{t.does}</div>
                  {t.guard && <div className="text-[11.5px] text-qm-followup">🛡 {t.guard}</div>}
                </div>
              ))}
            </div>
          )}
          {node.code && (
            <div className="mt-4 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
              <FileCode2 className="size-3.5" /> {node.code}
            </div>
          )}
        </aside>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="One turn, step by step">
          <ol className="space-y-2.5">
            {TURN.map(([t, d], i) => (
              <li key={t} className="flex gap-3">
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary font-mono text-[11px] font-bold text-primary-foreground">{i + 1}</span>
                <div>
                  <div className="text-sm font-semibold">{t}</div>
                  <div className="text-[13px] text-muted-foreground">{d}</div>
                </div>
              </li>
            ))}
          </ol>
        </Section>
        <Section title="Middleware chain (runs around every model call, in order)">
          <ol className="space-y-1.5">
            {MIDDLEWARE.map(([name, what], i) => (
              <li key={name} className="flex items-center gap-3 rounded-lg border px-3 py-2">
                <span className="font-mono text-[11px] text-muted-foreground">{i + 1}</span>
                <code className="w-56 shrink-0 font-mono text-[12px] font-semibold">{name}</code>
                <span className="text-[13px] text-muted-foreground">{what}</span>
              </li>
            ))}
          </ol>
        </Section>
      </div>

      <Section title="Model lanes (live)">{data.status ? <StatusDetail status={data.status} /> : <div className="text-sm text-muted-foreground">Loading…</div>}</Section>

      <Section title="Guardrails: enforced in code, not in the prompt" icon>
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
          {GUARDRAILS.map(([t, d]) => (
            <div key={t} className="rounded-xl border bg-background p-3">
              <div className="text-sm font-semibold">{t}</div>
              <div className="mt-0.5 text-[12.5px] text-muted-foreground">{d}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="All 18 clinic tools">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {TOOL_CATALOG.map((g) => (
            <div key={g.group}>
              <div className="mb-1.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{g.group}</div>
              <div className="space-y-1">
                {g.tools.map((t) => (
                  <div key={t.name} className={cn("rounded-lg border px-2.5 py-1.5")}>
                    <code className="font-mono text-[11.5px] font-semibold">{t.name}</code>
                    <div className="text-[11.5px] text-muted-foreground">{t.does}</div>
                    {t.guard && <div className="text-[11px] text-qm-followup">🛡 {t.guard}</div>}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children, icon }: { title: string; children: React.ReactNode; icon?: boolean }) {
  return (
    <section className="rounded-2xl border bg-card p-4">
      <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold">
        {icon && <ShieldCheck className="size-4 text-primary" />} {title}
      </h3>
      {children}
    </section>
  );
}
