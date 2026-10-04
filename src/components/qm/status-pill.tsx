"use client";
// Which models are serving right now: self-hosted Llama (Colab) for the fast lane when it's up,
// and the quota-aware Gemini pool for the agent's reasoning.
import { Cpu, Server } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { RouterStatus } from "@/lib/client/types";

export function StatusPill({ status }: { status: RouterStatus | null }) {
  const selfHosted = status?.selfHosted.healthy;
  const laya = status?.decision?.online;
  const fast = status?.fastLaneOrder[0] ?? "—";
  const ready = status?.reasoningPool.filter((m) => m.state === "ready").length ?? 0;
  const total = status?.reasoningPool.length ?? 0;
  return (
    <Dialog>
      <DialogTrigger
        render={
          <button
            type="button"
            className="flex items-center gap-2 rounded-full border bg-card py-1 pr-3 pl-1.5 text-xs transition hover:bg-muted"
          />
        }
      >
        <span className={cn("flex items-center gap-1 rounded-full px-2 py-0.5 font-medium", laya ? "bg-qm-good/15 text-qm-good" : "bg-muted text-muted-foreground")}>
          <span className={cn("size-1.5 rounded-full", laya ? "bg-qm-good" : "bg-muted-foreground/60")} />
          {laya ? "Laya decisions" : "Laya offline"}
        </span>
        <span className="hidden text-muted-foreground sm:inline">
          Fast lane <b className="text-foreground">{selfHosted ? "Llama" : fast === "groq" ? "Groq" : fast}</b>
        </span>
        <span className="text-muted-foreground">
          Reasoning pool <b className="font-mono text-foreground">{ready}</b>/{total}
        </span>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Model routing</DialogTitle>
          <DialogDescription>Two lanes. Code does every calculation; models only read, decide and write.</DialogDescription>
        </DialogHeader>
        {status ? <StatusDetail status={status} /> : <div className="text-sm text-muted-foreground">Loading…</div>}
      </DialogContent>
    </Dialog>
  );
}

export function StatusDetail({ status }: { status: RouterStatus }) {
  const fastChain = [
    { id: "colab", name: "Llama (self-hosted, Colab T4)", note: status.selfHosted.healthy ? `online · ${status.selfHosted.pingMs}ms · ${status.selfHosted.model}` : "offline — start the notebook" },
    { id: "groq", name: "Groq · gpt-oss-20b", note: "always-on fallback" },
    { id: "mistral", name: "Mistral · ministral-8b", note: "free tier, 188 req/min" },
    { id: "gemini", name: "Gemini Flash-Lite", note: "last resort" },
  ];
  const active = status.fastLaneOrder[0];
  return (
    <div className="space-y-5">
      <div className={cn("rounded-xl border px-4 py-3", status.decision?.online ? "border-qm-good/40 bg-qm-good/[0.05]" : "bg-muted/40")}>
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold">Decision lane: Laya (System 1)</div>
          <span className={cn("text-[11px] font-semibold", status.decision?.online ? "text-qm-good" : "text-muted-foreground")}>{status.decision?.online ? "ONLINE · Colab T4" : "OFFLINE · start the notebook"}</span>
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          Walk-in triage as typed questions with calibrated probabilities (~33 ms). Confidence ≥ 0.75 → decided without an LLM; otherwise the fast-lane LLM decides. Can only raise priority.
          {status.lastHour.laya && ` Last hour: ${status.lastHour.laya.ok}/${status.lastHour.laya.calls} ok · avg ${status.lastHour.laya.avgLatencyMs ?? "—"} ms.`}
        </div>
      </div>
    <div className="grid gap-5 md:grid-cols-2">
      <div>
        <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
          <Server className="size-3.5" /> Fast lane — triage, SMS drafts
        </div>
        <ol className="space-y-1.5">
          {fastChain.map((p, i) => (
            <li key={p.id} className={cn("rounded-lg border px-3 py-2", p.id === active && "border-primary bg-accent/50")}>
              <div className="flex items-center justify-between text-sm font-medium">
                <span>
                  {i + 1}. {p.name}
                </span>
                {p.id === active && <span className="text-[10px] font-semibold text-primary">SERVING</span>}
              </div>
              <div className="text-xs text-muted-foreground">{p.note}</div>
              {status.lastHour[p.id] && (
                <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                  last hour: {status.lastHour[p.id].ok}/{status.lastHour[p.id].calls} ok · avg {status.lastHour[p.id].avgLatencyMs ?? "—"}ms
                </div>
              )}
            </li>
          ))}
        </ol>
        <p className="mt-2 text-xs text-muted-foreground">Circuit breaker skips a failing provider for 60s. Every draft is checked by the numbers guard.</p>
      </div>
      <div>
        <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
          <Cpu className="size-3.5" /> Reasoning pool — the agent
        </div>
        <div className="space-y-1">
          {status.reasoningPool.map((m) => (
            <div key={m.member} className="flex items-center gap-2 text-xs">
              <span className={cn("size-1.5 shrink-0 rounded-full", m.state === "ready" ? "bg-qm-good" : m.state === "cooling" ? "bg-qm-urgent" : m.state === "offline" ? "bg-muted-foreground/40" : "bg-qm-emergency")} />
              <span className="w-44 truncate font-mono">{m.member}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                {m.dailyBudget && <div className="h-full bg-primary" style={{ width: `${Math.min(100, (m.usedToday / m.dailyBudget) * 100)}%` }} />}
              </div>
              <span className="w-16 text-right font-mono text-muted-foreground">
                {m.state === "offline" ? "offline" : `${m.usedToday}${m.dailyBudget ? `/${m.dailyBudget}` : ""}`}
              </span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Free tiers cap each model per project (5/min, 20/day on Flash). A shared ledger in Supabase routes each step to a member with budget left. Mistral&apos;s free tier carries volume; the self-hosted Llama on Colab is the last resort when every cloud quota is spent.
        </p>
      </div>
    </div>
    </div>
  );
}
