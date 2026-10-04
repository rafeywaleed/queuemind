"use client";
// Front desk: the receptionist's cockpit. Live plan on a timeline, queue per doctor with
// one-click staff actions, alerts the agent can take over, and the agent console.
import { useMemo, useState } from "react";
import { AlertTriangle, BellRing, Clock, Footprints, Inbox, Siren, Sparkles, Timer, Users } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { AgentConsole } from "@/components/qm/agent-console";
import { Outbox } from "@/components/qm/outbox";
import { Timeline } from "@/components/qm/timeline";
import { VisitActions } from "@/components/qm/visit-actions";
import { cn } from "@/lib/utils";
import { ago, clock, KIND_LABEL, tone } from "@/lib/client/format";
import type { AgentSession } from "@/lib/client/use-agent";
import type { ClinicData } from "@/lib/client/use-clinic";
import type { Alert, Board } from "@/lib/client/types";

export function FrontDeskView({ data, agent }: { data: ClinicData; agent: AgentSession }) {
  const board = data.board!;
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<"queue" | "log">("queue");
  const pending = data.notifications.filter((n) => n.status === "pending_approval").length;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_440px]">
      <div className="min-w-0 space-y-4">
        <Kpis board={board} pending={pending} />
        <AlertsBar alerts={board.snapshot.alerts} onDelegate={(a) => agent.send(`Handle this alert from the board: ${a.message}`)} busy={agent.running} />
        <Timeline board={board} highlightVisitId={selected} onSelect={setSelected} />

        <div className="rounded-2xl border bg-card">
          <div className="flex items-center gap-1 border-b px-3 pt-2">
            {(["queue", "log"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={cn("-mb-px border-b-2 px-3 py-2 text-sm font-medium", tab === t ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
              >
                {t === "queue" ? "Queue by doctor" : "Activity log"}
              </button>
            ))}
            <div className="ml-auto pb-1">
              <Sheet>
                <SheetTrigger
                  render={
                    <button type="button" className="relative inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-sm font-medium hover:bg-muted" />
                  }
                >
                  <Inbox className="size-4" /> Outbox
                  {pending > 0 && <span className="grid min-w-5 place-items-center rounded-full bg-qm-emergency px-1 text-[11px] font-bold text-white">{pending}</span>}
                </SheetTrigger>
                <SheetContent className="w-full overflow-y-auto sm:max-w-md">
                  <SheetHeader>
                    <SheetTitle>Patient messages</SheetTitle>
                    <SheetDescription>SMS drafted by the agent in each patient&apos;s language. Times are filled in by the queue engine.</SheetDescription>
                  </SheetHeader>
                  <div className="px-4 pb-6">
                    <Outbox notifications={data.notifications} board={board} onChange={data.refresh} />
                  </div>
                </SheetContent>
              </Sheet>
            </div>
          </div>
          {tab === "queue" ? <QueueColumns board={board} selected={selected} onSelect={setSelected} onDone={data.refresh} /> : <ActivityLog data={data} />}
        </div>
      </div>

      <AgentConsole session={agent} scenarios={data.scenarios} className="xl:sticky xl:top-[76px] xl:h-[calc(100vh-92px)]" />
    </div>
  );
}

function Kpis({ board, pending }: { board: Board; pending: number }) {
  const stats = useMemo(() => {
    const planned = board.snapshot.doctors.flatMap((d) => d.queue);
    const waiting = planned.filter((q) => q.state === "waiting");
    const longest = Math.max(0, ...waiting.map((q) => q.waitMin));
    const avg = waiting.length ? Math.round(waiting.reduce((s, q) => s + q.waitMin, 0) / waiting.length) : 0;
    const behind = board.snapshot.alerts.filter((a) => a.type === "delay_notify").length;
    const emergencies = planned.filter((q) => q.priority === "emergency").length;
    const seen = board.visits.filter((v) => v.status === "done").length;
    return { waiting: waiting.length, longest, avg, behind, emergencies, seen };
  }, [board]);

  const items = [
    { label: "In waiting room", value: stats.waiting, icon: Users },
    { label: "Longest wait", value: `${stats.longest}m`, icon: Timer, warn: stats.longest >= 45 },
    { label: "Average wait", value: `${stats.avg}m`, icon: Clock },
    { label: "Behind schedule", value: stats.behind, icon: AlertTriangle, warn: stats.behind > 0 },
    { label: "Emergencies", value: stats.emergencies, icon: Siren, danger: stats.emergencies > 0 },
    { label: "SMS to approve", value: pending, icon: BellRing, warn: pending > 0 },
    { label: "Seen today", value: stats.seen, icon: Footprints },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
      {items.map((it) => (
        <div
          key={it.label}
          className={cn(
            "rounded-xl border bg-card px-3 py-2.5",
            it.danger && "border-qm-emergency/50 bg-qm-emergency/[0.06]",
            it.warn && !it.danger && "border-qm-urgent/50 bg-qm-urgent/[0.06]",
          )}
        >
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <it.icon className="size-3.5" /> {it.label}
          </div>
          <div className={cn("mt-0.5 font-mono text-2xl font-semibold tabular", it.danger && "text-qm-emergency")}>{it.value}</div>
        </div>
      ))}
    </div>
  );
}

function AlertsBar({ alerts, onDelegate, busy }: { alerts: Alert[]; onDelegate: (a: Alert) => void; busy: boolean }) {
  if (!alerts.length) {
    return <div className="rounded-xl border border-qm-good/30 bg-qm-good/[0.06] px-4 py-2.5 text-sm text-qm-good">All clear: no delays, overruns or no-shows right now.</div>;
  }
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {alerts.slice(0, 8).map((a, i) => (
        <div
          key={i}
          className={cn(
            "flex w-72 shrink-0 flex-col justify-between rounded-xl border px-3 py-2",
            a.severity === "critical" ? "border-qm-emergency/50 bg-qm-emergency/[0.07]" : a.severity === "warning" ? "border-qm-urgent/40 bg-qm-urgent/[0.07]" : "bg-card",
          )}
        >
          <div className="flex gap-2 text-[12.5px] leading-snug">
            {a.severity === "critical" ? <Siren className="mt-0.5 size-4 shrink-0 text-qm-emergency" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-qm-urgent" />}
            <span className="line-clamp-3">{a.message}</span>
          </div>
          <button type="button" disabled={busy} onClick={() => onDelegate(a)} className="mt-1.5 inline-flex items-center gap-1 self-end text-[11px] font-semibold text-primary hover:underline disabled:opacity-40">
            <Sparkles className="size-3" /> Let the agent handle it
          </button>
        </div>
      ))}
    </div>
  );
}

function QueueColumns({ board, selected, onSelect, onDone }: { board: Board; selected: string | null; onSelect: (id: string) => void; onDone: () => void }) {
  const tz = board.clinic.timezone;
  const byId = new Map(board.visits.map((v) => [v.id, v]));
  return (
    <div className="grid gap-px bg-border md:grid-cols-3">
      {board.snapshot.doctors.map((d) => {
        const current = d.current ? byId.get(d.current.visitId) : null;
        return (
          <div key={d.doctorId} className="bg-card p-3">
            <div className="mb-2 flex items-baseline justify-between">
              <div className="text-sm font-semibold">{d.name}</div>
              <div className="text-[11px] text-muted-foreground">{d.queue.length} in line</div>
            </div>
            {current && (
              <div className="mb-2 flex items-center gap-2 rounded-lg bg-qm-consult/10 px-2 py-1.5 text-[12.5px]">
                <span className="size-2 animate-pulse rounded-full bg-qm-consult" />
                <span className="flex-1 truncate">
                  <b>#{current.token}</b> {current.patientName} · {d.current!.elapsedMin}m
                  {d.current!.overrunMin > 0 && <span className="text-qm-emergency"> (+{d.current!.overrunMin} over)</span>}
                </span>
                <VisitActions visit={current} board={board} onDone={onDone} />
              </div>
            )}
            <ul className="space-y-1">
              {d.queue.map((q) => {
                const v = byId.get(q.visitId);
                const t = tone(q.kind, q.priority);
                return (
                  <li
                    key={q.visitId}
                    onClick={() => onSelect(q.visitId)}
                    className={cn("group flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 transition hover:bg-muted/60", selected === q.visitId && "bg-accent")}
                  >
                    <span className={cn("grid h-6 min-w-8 place-items-center rounded-md px-1 font-mono text-[11px] font-bold", q.state === "expected" ? "border border-dashed" : cn(t.bar, "text-white"))}>
                      {q.token ?? "—"}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium">{q.patientName}</div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {q.priority !== "normal" ? <b className={t.text}>{q.priority.toUpperCase()} · </b> : null}
                        {KIND_LABEL[q.kind]}
                        {q.state === "expected" ? ` · due ${clock(v?.scheduledAt, tz)}` : " · here"}
                        {q.projectedDelayMin ? <span className="text-qm-urgent"> · {q.projectedDelayMin}m late</span> : null}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono text-[12px] font-semibold tabular">{clock(q.etaStart, tz)}</div>
                      <div className="text-[10px] text-muted-foreground">{q.waitMin}m</div>
                    </div>
                    {v && <VisitActions visit={v} board={board} onDone={onDone} />}
                  </li>
                );
              })}
              {d.queue.length === 0 && <li className="px-1.5 py-3 text-center text-xs text-muted-foreground">No one waiting</li>}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

const ACTOR_STYLE: Record<string, string> = {
  agent: "bg-primary/12 text-primary",
  staff: "bg-qm-appointment/12 text-qm-appointment",
  system: "bg-muted text-muted-foreground",
  patient: "bg-qm-followup/12 text-qm-followup",
};

export function ActivityLog({ data, limit = 40 }: { data: ClinicData; limit?: number }) {
  return (
    <ul className="max-h-[420px] divide-y overflow-y-auto">
      {data.events.slice(0, limit).map((e) => (
        <li key={e.id} className="flex items-start gap-3 px-4 py-2 text-[13px]">
          <span className="w-16 shrink-0 pt-0.5 font-mono text-[11px] text-muted-foreground">{ago(e.created_at)}</span>
          <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase", ACTOR_STYLE[e.actor])}>{e.actor}</span>
          <span className="flex-1">{e.summary}</span>
        </li>
      ))}
    </ul>
  );
}
