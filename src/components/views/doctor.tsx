"use client";
// Doctor's screen: who is with me, how long I've been, who's next and why they're here.
// Finishing a consult (with a follow-up) and reporting "I'm running late" are one tap each,
// and the rest of the clinic replans instantly.
import { useMemo, useState } from "react";
import { ArrowRight, CalendarCheck2, Check, Clock3, Hourglass, Stethoscope, TimerReset } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Timeline } from "@/components/qm/timeline";
import { staffAction } from "@/components/qm/visit-actions";
import { cn } from "@/lib/utils";
import { clock, initials, KIND_LABEL, tone } from "@/lib/client/format";
import type { ClinicData } from "@/lib/client/use-clinic";
import type { Board } from "@/lib/client/types";

export function DoctorView({ data, doctorId, onDoctor }: { data: ClinicData; doctorId: string; onDoctor: (id: string) => void }) {
  const board = data.board!;
  const plan = board.snapshot.doctors.find((d) => d.doctorId === doctorId) ?? board.snapshot.doctors[0];
  const doctor = board.doctors.find((d) => d.id === plan.doctorId)!;
  const tz = board.clinic.timezone;
  const current = plan.current ? board.visits.find((v) => v.id === plan.current!.visitId) : null;
  const next = plan.queue.find((q) => q.state === "waiting");
  const [followUp, setFollowUp] = useState<number | null>(null);
  const seen = board.visits.filter((v) => v.doctorId === doctor.id && v.status === "done");
  const ownBoard: Board = useMemo(() => ({ ...board, snapshot: { ...board.snapshot, doctors: [plan] } }), [board, plan]);
  const ref = (v: { token: number | null; id: string }) => (v.token ? `#${v.token}` : v.id);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {board.doctors.map((d) => (
          <button
            key={d.id}
            type="button"
            onClick={() => onDoctor(d.id)}
            className={cn("flex items-center gap-2 rounded-full border py-1 pr-3 pl-1 text-sm transition", d.id === doctor.id ? "border-primary bg-accent font-semibold" : "bg-card hover:bg-muted")}
          >
            <span className="grid size-7 place-items-center rounded-full bg-primary/15 text-[11px] font-bold text-primary">{initials(d.name)}</span>
            {d.name}
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        {/* Now */}
        <div className="relative overflow-hidden rounded-3xl border bg-card p-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              <Stethoscope className="size-4" /> Room {board.doctors.indexOf(doctor) + 1} · {doctor.specialty}
            </div>
            <StatusChip plan={plan} tz={tz} />
          </div>

          {current && plan.current ? (
            <div className="mt-5 flex flex-col gap-6 sm:flex-row sm:items-center">
              <ConsultRing elapsed={plan.current.elapsedMin} estimate={current.estMinutes ?? doctor.avgConsultMin} />
              <div className="min-w-0 flex-1">
                <div className="text-xs text-muted-foreground">With you now</div>
                <div className="font-display text-4xl leading-tight">{current.patientName}</div>
                <div className="mt-1 text-sm text-muted-foreground">
                  <span className="font-mono">#{current.token}</span> · {KIND_LABEL[current.kind]} · {current.reason}
                </div>
                <div className="mt-4">
                  <div className="mb-1.5 text-xs font-medium text-muted-foreground">Follow-up?</div>
                  <div className="flex flex-wrap gap-1.5">
                    {[null, 3, 5, 7, 14].map((d) => (
                      <button
                        key={String(d)}
                        type="button"
                        onClick={() => setFollowUp(d)}
                        className={cn("rounded-full border px-2.5 py-1 text-xs font-medium", followUp === d ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted")}
                      >
                        {d === null ? "None" : `${d} days`}
                        {d !== null && d <= board.clinic.freeFollowUpDays && <span className={cn("ml-1 text-[9px] font-bold", followUp === d ? "opacity-90" : "text-qm-good")}>FREE</span>}
                      </button>
                    ))}
                  </div>
                </div>
                <Button
                  className="mt-4"
                  size="lg"
                  onClick={() => {
                    void staffAction({ action: "finish_consult", visit: ref(current), days: followUp ?? undefined }, data.refresh, followUp ? `Done · follow-up in ${followUp} days booked` : "Consult finished");
                    setFollowUp(null);
                  }}
                >
                  <Check /> Finish consult{followUp ? ` + follow-up in ${followUp}d` : ""}
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-8 flex flex-col items-start gap-3">
              <div className="font-display text-4xl">Ready for the next patient</div>
              {next ? (
                <Button size="lg" onClick={() => staffAction({ action: "start_consult", visit: ref(next as never), doctor: doctor.id }, data.refresh, `${next.patientName} called in`)}>
                  <ArrowRight /> Call in #{next.token} {next.patientName}
                </Button>
              ) : (
                <div className="text-sm text-muted-foreground">No one is waiting for you.</div>
              )}
            </div>
          )}
        </div>

        {/* Controls + stats */}
        <div className="space-y-4">
          <div className="rounded-3xl border bg-card p-5">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <Hourglass className="size-4" /> Running behind?
            </div>
            <div className="flex flex-wrap gap-2">
              {[10, 20, 30].map((m) => (
                <Button key={m} variant="outline" onClick={() => staffAction({ action: "doctor_delay", doctor: doctor.id, minutes: m, reason: "Doctor reported delay" }, data.refresh, `Delay of ${m} min recorded — queue replanned`)}>
                  +{m} min
                </Button>
              ))}
              {plan.delayMin > 0 && (
                <Button variant="secondary" onClick={() => staffAction({ action: "doctor_available", doctor: doctor.id }, data.refresh, "Back — queue replanned")}>
                  <TimerReset /> I&apos;m back
                </Button>
              )}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">The front desk sees the impact at once, and the agent can tell affected patients.</p>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Seen today" value={seen.length} />
            <Stat label="Avg consult" value={`${doctor.avgConsultMin}m`} hint="learned today" />
            <Stat label="In line" value={plan.queue.length} />
          </div>
        </div>
      </div>

      {/* Up next */}
      <div className="rounded-3xl border bg-card">
        <div className="flex items-center justify-between border-b px-5 py-3">
          <div className="text-sm font-semibold">Up next</div>
          <div className="text-xs text-muted-foreground">Order set by the queue engine: priority, then booking time, with grace, no-show and fairness rules</div>
        </div>
        <ol className="divide-y">
          {plan.queue.map((q) => {
            const v = board.visits.find((x) => x.id === q.visitId);
            const t = tone(q.kind, q.priority);
            return (
              <li key={q.visitId} className="flex items-center gap-4 px-5 py-3">
                <span className="w-5 font-mono text-xs text-muted-foreground">{q.position}</span>
                <span className={cn("grid h-8 min-w-11 place-items-center rounded-lg font-mono text-sm font-bold", q.state === "expected" ? "border border-dashed" : cn(t.bar, "text-white"))}>{q.token ?? "—"}</span>
                <div className="min-w-0 flex-1">
                  <div className="font-medium">
                    {q.patientName}
                    {q.priority !== "normal" && <span className={cn("ml-2 text-xs font-bold", t.text)}>{q.priority.toUpperCase()}</span>}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {KIND_LABEL[q.kind]} · {v?.reason ?? "—"} {q.state === "expected" ? "· not arrived yet" : "· in waiting room"}
                  </div>
                  {q.flags.map((f) => (
                    <div key={f} className="text-[11px] text-qm-urgent">{f}</div>
                  ))}
                </div>
                <div className="text-right">
                  <div className="font-mono text-sm font-semibold">{clock(q.etaStart, tz)}</div>
                  <div className="text-[11px] text-muted-foreground">~{q.estMinutes}m consult</div>
                </div>
              </li>
            );
          })}
          {plan.queue.length === 0 && <li className="px-5 py-6 text-center text-sm text-muted-foreground">Queue is empty.</li>}
        </ol>
      </div>

      <Timeline board={ownBoard} />
    </div>
  );
}

function StatusChip({ plan, tz }: { plan: Board["snapshot"]["doctors"][number]; tz: string }) {
  if (plan.status === "off_duty") return <span className="rounded-full bg-foreground px-2.5 py-1 text-xs font-semibold text-background">Off duty</span>;
  if (plan.delayMin > 0)
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-qm-urgent/20 px-2.5 py-1 text-xs font-semibold">
        <Clock3 className="size-3.5" /> Away · back {clock(plan.freeAt, tz)}
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-qm-good/15 px-2.5 py-1 text-xs font-semibold text-qm-good">
      <CalendarCheck2 className="size-3.5" /> On duty
    </span>
  );
}

/** Elapsed vs estimate. The ring turns red once the consult runs over. */
function ConsultRing({ elapsed, estimate }: { elapsed: number; estimate: number }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const frac = Math.min(elapsed / Math.max(estimate, 1), 1);
  const over = elapsed > estimate;
  return (
    <div className="relative size-36 shrink-0">
      <svg viewBox="0 0 128 128" className="size-full -rotate-90">
        <circle cx="64" cy="64" r={r} fill="none" stroke="currentColor" strokeWidth="10" className="text-muted" />
        <circle
          cx="64"
          cy="64"
          r={r}
          fill="none"
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - frac)}
          className={cn("transition-all duration-700", over ? "stroke-qm-emergency" : "stroke-qm-consult")}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">
        <div>
          <div className={cn("font-mono text-3xl font-semibold tabular", over && "text-qm-emergency")}>{elapsed}m</div>
          <div className="text-[11px] text-muted-foreground">of ~{estimate}m{over ? ` · +${elapsed - estimate}` : ""}</div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-2xl border bg-card px-3 py-3">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="font-mono text-2xl font-semibold tabular">{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );
}
