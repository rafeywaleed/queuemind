"use client";
// Clinic manager: how the shift is going, who's overloaded, what the agent did and why,
// which safety mechanisms fired, and how the models are being used.
import { useMemo, useState } from "react";
import { Bot, Gauge, ShieldCheck, Siren, UserCog } from "lucide-react";
import { StatusDetail } from "@/components/qm/status-pill";
import { cn } from "@/lib/utils";
import { ago, minsBetween } from "@/lib/client/format";
import type { ClinicData } from "@/lib/client/use-clinic";

export function ManagerView({ data }: { data: ClinicData }) {
  const board = data.board!;
  const [actor, setActor] = useState<"all" | "agent" | "staff" | "system">("all");

  const metrics = useMemo(() => {
    const started = board.visits.filter((v) => v.consultStartedAt && v.arrivedAt);
    const waits = started.map((v) => Math.max(0, minsBetween(v.arrivedAt!, v.consultStartedAt!)));
    const done = board.visits.filter((v) => v.status === "done");
    const sent = data.notifications.filter((n) => n.status === "sent").length;
    const agentActions = data.events.filter((e) => e.actor === "agent").length;
    return {
      seen: done.length,
      avgWait: waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : 0,
      noShows: board.visits.filter((v) => v.status === "no_show").length,
      sent,
      agentActions,
      inClinic: board.visits.filter((v) => v.status === "waiting" || v.status === "in_consult").length,
    };
  }, [board, data.notifications, data.events]);

  const safety = useMemo(() => {
    const ev = data.events;
    return [
      { label: "Emergencies fast-tracked", value: ev.filter((e) => e.type === "emergency_intake").length, note: "Red-flag rules + intake model, most severe wins" },
      { label: "Priority changes", value: ev.filter((e) => e.type === "priority_change").length, note: "Agent can only raise; lowering is staff-only" },
      { label: "SMS held for approval", value: data.notifications.filter((n) => n.status === "pending_approval").length, note: "No message reaches a patient unapproved" },
      { label: "Numbers-guard fallbacks", value: ev.filter((e) => e.type === "notification_drafted" && (e.payload as { guard?: string | null }).guard).length, note: "Model drafts with invented numbers replaced" },
      {
        label: "Fairness locks active",
        value: board.snapshot.doctors.flatMap((d) => d.queue).filter((q) => q.flags.some((f) => f.startsWith("Fairness"))).length,
        note: `No one overtaken more than ${board.clinic.maxBumps}×`,
      },
      { label: "Rejected drafts", value: data.notifications.filter((n) => n.status === "rejected").length, note: "Humans overruled the agent" },
    ];
  }, [data.events, data.notifications, board]);

  const events = data.events.filter((e) => actor === "all" || e.actor === actor);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
        <Metric label="Seen today" value={metrics.seen} />
        <Metric label="In clinic now" value={metrics.inClinic} />
        <Metric label="Avg wait (arrival → doctor)" value={`${metrics.avgWait}m`} />
        <Metric label="No-shows" value={metrics.noShows} />
        <Metric label="SMS sent" value={metrics.sent} />
        <Metric label="Agent actions" value={metrics.agentActions} accent />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <Panel icon={Gauge} title="Doctors right now">
          <table className="w-full text-sm">
            <thead className="text-left text-[11px] text-muted-foreground uppercase">
              <tr>
                <th className="py-2 font-medium">Doctor</th>
                <th className="py-2 text-right font-medium">Seen</th>
                <th className="py-2 text-right font-medium">Learned avg</th>
                <th className="py-2 text-right font-medium">In line</th>
                <th className="py-2 text-right font-medium">Clears at</th>
                <th className="py-2 pl-4 font-medium">Load</th>
              </tr>
            </thead>
            <tbody>
              {board.snapshot.doctors.map((d) => {
                const doc = board.doctors.find((x) => x.id === d.doctorId)!;
                const seen = board.visits.filter((v) => v.doctorId === d.doctorId && v.status === "done").length;
                const last = d.queue[d.queue.length - 1];
                const clearsIn = last ? minsBetween(board.snapshot.computedAt, last.etaStart) + last.estMinutes : 0;
                return (
                  <tr key={d.doctorId} className="border-t">
                    <td className="py-2.5">
                      <div className="font-medium">{d.name}</div>
                      <div className="text-[11px] text-muted-foreground">{d.status === "off_duty" ? "Off duty" : d.delayMin ? `Away ${d.delayMin}m` : d.specialty}</div>
                    </td>
                    <td className="py-2.5 text-right font-mono">{seen}</td>
                    <td className="py-2.5 text-right font-mono">{doc.avgConsultMin}m</td>
                    <td className="py-2.5 text-right font-mono">{d.queue.length}</td>
                    <td className="py-2.5 text-right font-mono">{clearsIn ? `+${clearsIn}m` : "now"}</td>
                    <td className="py-2.5 pl-4">
                      <div className="h-2 w-28 overflow-hidden rounded-full bg-muted">
                        <div className={cn("h-full rounded-full", clearsIn > 120 ? "bg-qm-emergency" : clearsIn > 60 ? "bg-qm-urgent" : "bg-qm-good")} style={{ width: `${Math.min(100, (clearsIn / 180) * 100)}%` }} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>

        <Panel icon={ShieldCheck} title="Safety mechanisms (live counters)">
          <div className="grid grid-cols-2 gap-2">
            {safety.map((s) => (
              <div key={s.label} className="rounded-xl border bg-background px-3 py-2">
                <div className="font-mono text-xl font-semibold">{s.value}</div>
                <div className="text-[12px] font-medium">{s.label}</div>
                <div className="text-[10.5px] text-muted-foreground">{s.note}</div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <Panel
          icon={UserCog}
          title="Audit trail: who changed what, and why"
          action={
            <div className="flex gap-1">
              {(["all", "agent", "staff", "system"] as const).map((a) => (
                <button key={a} type="button" onClick={() => setActor(a)} className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium capitalize", actor === a ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted")}>
                  {a}
                </button>
              ))}
            </div>
          }
        >
          <ul className="max-h-[420px] divide-y overflow-y-auto">
            {events.map((e) => (
              <li key={e.id} className="flex items-start gap-2.5 py-2 text-[13px]">
                {e.actor === "agent" ? <Bot className="mt-0.5 size-4 shrink-0 text-primary" /> : e.type.includes("emergency") ? <Siren className="mt-0.5 size-4 shrink-0 text-qm-emergency" /> : <UserCog className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
                <div className="flex-1">
                  <div>{e.summary}</div>
                  <div className="font-mono text-[10px] text-muted-foreground">
                    {e.type} · {e.actor} · {ago(e.created_at)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel icon={Bot} title="Model routing">
          {data.status ? <StatusDetail status={data.status} /> : <div className="text-sm text-muted-foreground">Loading…</div>}
        </Panel>
      </div>
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div className={cn("rounded-2xl border bg-card px-4 py-3", accent && "border-primary/40 bg-accent/40")}>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="font-mono text-3xl font-semibold tabular">{value}</div>
    </div>
  );
}

function Panel({ icon: Icon, title, children, action }: { icon: typeof Bot; title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="rounded-2xl border bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <Icon className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">{title}</h3>
        <div className="ml-auto">{action}</div>
      </div>
      {children}
    </section>
  );
}
