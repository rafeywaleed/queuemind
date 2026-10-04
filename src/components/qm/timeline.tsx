"use client";
// The clinic on a time axis. One lane per doctor: completed consults, the consult in progress
// (overrun shown in red), the doctor's unavailable window (hatched), and the engine's plan for
// everyone waiting. A thin "slip line" connects each booking to its projected start.
import { useMemo } from "react";
import { AlertTriangle, Clock3 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { clock, initials, KIND_LABEL, tone } from "@/lib/client/format";
import type { Board, BoardVisit, DoctorPlan, PlannedVisit } from "@/lib/client/types";

const PAST_MIN = 30;
const MIN = 60_000;
const LABEL_W = "15rem";

export function Timeline({ board, highlightVisitId, onSelect }: { board: Board; highlightVisitId?: string | null; onSelect?: (visitId: string) => void }) {
  const now = new Date(board.snapshot.computedAt).getTime();
  // Zoom to the work that exists: from 30 min ago to just past the last planned consult.
  const lastEnd = Math.max(
    now,
    ...board.snapshot.doctors.flatMap((d) => [new Date(d.freeAt).getTime(), ...d.queue.map((q) => new Date(q.etaStart).getTime() + q.estMinutes * MIN)]),
  );
  const futureMin = Math.min(Math.max(Math.ceil((lastEnd - now) / MIN) + 10, 75), 200);
  const start = now - PAST_MIN * MIN;
  const end = now + futureMin * MIN;
  const tickStep = futureMin > 120 ? 15 : 10;
  const tz = board.clinic.timezone;
  const pct = (t: number) => ((Math.min(Math.max(t, start), end) - start) / (end - start)) * 100;
  const visitsById = useMemo(() => new Map(board.visits.map((v) => [v.id, v])), [board.visits]);

  const ticks = useMemo(() => {
    const out: number[] = [];
    const first = Math.ceil(start / (tickStep * MIN)) * tickStep * MIN;
    for (let t = first; t <= end; t += tickStep * MIN) out.push(t);
    return out;
  }, [start, end, tickStep]);

  return (
    <div className="relative overflow-hidden rounded-2xl border bg-card">
      {/* Time ruler */}
      <div className="flex border-b bg-muted/40">
        <div className="shrink-0 px-4 py-2 text-[11px] font-medium tracking-wider text-muted-foreground uppercase" style={{ width: LABEL_W }}>Doctors</div>
        <div className="relative h-8 flex-1">
          {ticks.map((t) => (
            <div key={t} className="absolute top-0 h-full" style={{ left: `${pct(t)}%` }}>
              <div className={cn("h-full border-l", new Date(t).getMinutes() % (tickStep === 10 ? 20 : 30) === 0 ? "border-border" : "border-border/40")} />
              {new Date(t).getMinutes() % (tickStep === 10 ? 20 : 30) === 0 && (
                <span className="absolute top-1.5 left-1.5 font-mono text-[10px] whitespace-nowrap text-muted-foreground">{clock(new Date(t).toISOString(), tz)}</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Lanes */}
      <div className="relative">
        {board.snapshot.doctors.map((plan) => (
          <Lane
            key={plan.doctorId}
            plan={plan}
            board={board}
            visitsById={visitsById}
            pct={pct}
            now={now}
            start={start}
            end={end}
            tickStep={tickStep}
            highlightVisitId={highlightVisitId}
            onSelect={onSelect}
          />
        ))}
        {/* Now line spans every lane */}
        <div className="pointer-events-none absolute inset-y-0 z-20" style={{ left: `calc(${LABEL_W} + (100% - ${LABEL_W}) * ${pct(now) / 100})` }}>
          <div className="h-full w-px bg-qm-emergency/80" />
          <div className="absolute -top-0 -left-[19px] rounded-b-md bg-qm-emergency px-1.5 py-0.5 font-mono text-[10px] font-semibold text-white">NOW</div>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-2 text-[11px] text-muted-foreground">
        <Legend className="bg-qm-consult" label="In consult" />
        <Legend className="bg-qm-appointment" label="Appointment" />
        <Legend className="bg-qm-walkin" label="Walk-in" />
        <Legend className="bg-qm-followup" label="Follow-up" />
        <Legend className="bg-qm-urgent" label="Urgent" />
        <Legend className="bg-qm-emergency" label="Emergency" />
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-sm border border-dashed border-foreground/40" /> Not arrived yet</span>
        <span className="flex items-center gap-1.5"><span className="hatch h-2.5 w-4 rounded-sm" /> Doctor away</span>
        <span className="flex items-center gap-1.5"><span className="h-px w-4 border-t border-dashed border-qm-delay" /> Slip from booking</span>
      </div>
    </div>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn("h-2.5 w-2.5 rounded-sm", className)} /> {label}
    </span>
  );
}

function Lane({
  plan,
  board,
  visitsById,
  pct,
  now,
  start,
  end,
  tickStep,
  highlightVisitId,
  onSelect,
}: {
  plan: DoctorPlan;
  board: Board;
  visitsById: Map<string, BoardVisit>;
  pct: (t: number) => number;
  now: number;
  start: number;
  end: number;
  tickStep: number;
  highlightVisitId?: string | null;
  onSelect?: (id: string) => void;
}) {
  const tz = board.clinic.timezone;
  const doctor = board.doctors.find((d) => d.id === plan.doctorId);
  const done = board.visits.filter((v) => v.doctorId === plan.doctorId && v.status === "done" && v.consultStartedAt && v.consultEndedAt && new Date(v.consultEndedAt).getTime() > start);
  const offDuty = plan.status === "off_duty";
  const current = plan.current ? visitsById.get(plan.current.visitId) : null;
  const shiftEnd = doctor?.shiftEnd ? new Date(doctor.shiftEnd).getTime() : null;

  return (
    <div className={cn("flex border-b last:border-b-0", offDuty && "bg-muted/50")}>
      <div className="flex shrink-0 items-center gap-3 border-r px-4 py-3" style={{ width: LABEL_W }}>
        <div className={cn("grid size-9 place-items-center rounded-full text-xs font-semibold", offDuty ? "bg-muted text-muted-foreground" : "bg-accent text-accent-foreground")}>
          {initials(plan.name)}
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{plan.name}</div>
          <div className="truncate text-[11px] text-muted-foreground">{plan.specialty}</div>
          <div className="font-mono text-[10px] text-muted-foreground">~{doctor?.avgConsultMin ?? "?"} min / consult</div>
          {offDuty ? (
            <span className="mt-0.5 inline-flex rounded bg-foreground/80 px-1.5 text-[10px] font-medium text-background">OFF DUTY</span>
          ) : plan.delayMin > 0 ? (
            <span className="mt-0.5 inline-flex items-center gap-1 rounded bg-qm-delay/20 px-1.5 text-[10px] font-semibold text-foreground">
              <Clock3 className="size-3" /> away · back {clock(plan.freeAt, tz)}
            </span>
          ) : null}
        </div>
      </div>

      <div className="paper-grid relative h-[76px] flex-1" style={{ backgroundSize: `${(tickStep * MIN * 100) / (end - start)}% 100%`, backgroundPosition: `${pct(Math.ceil(start / (tickStep * MIN)) * tickStep * MIN)}% 0` }}>
        {offDuty && (
          <div className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">
            Off duty — {plan.queue.length ? "patients need reassignment" : "no patients assigned"}
          </div>
        )}

        {/* Completed consults today */}
        {done.map((v) => (
          <div
            key={v.id}
            className="absolute top-[22px] h-8 rounded-md bg-foreground/[0.06] ring-1 ring-foreground/10 ring-inset"
            style={{ left: `${pct(new Date(v.consultStartedAt!).getTime())}%`, width: `${Math.max(0.4, pct(new Date(v.consultEndedAt!).getTime()) - pct(new Date(v.consultStartedAt!).getTime()))}%` }}
            title={`${v.patientName} — done`}
          />
        ))}

        {/* Doctor away window */}
        {plan.delayMin > 0 && !plan.current && (
          <div className="hatch absolute top-[14px] flex h-12 items-center overflow-hidden rounded-md ring-1 ring-qm-delay/50 ring-inset" style={{ left: `${pct(now)}%`, width: `${pct(new Date(plan.freeAt).getTime()) - pct(now)}%` }}>
            <span className="truncate px-2 text-[11px] font-semibold">Away {plan.delayMin}m</span>
          </div>
        )}

        {/* Consult in progress */}
        {plan.current && current && (
          <CurrentBlock plan={plan} visit={current} pct={pct} tz={tz} />
        )}

        {/* Planned queue */}
        {plan.queue.map((q) => (
          <PlannedBlock key={q.visitId} q={q} visit={visitsById.get(q.visitId)} pct={pct} tz={tz} highlighted={q.visitId === highlightVisitId} onSelect={onSelect} />
        ))}

        {shiftEnd && shiftEnd < end && (
          <div className="absolute inset-y-0 border-l-2 border-dashed border-foreground/30" style={{ left: `${pct(shiftEnd)}%` }}>
            <span className="absolute bottom-1 left-1 text-[10px] whitespace-nowrap text-muted-foreground">shift ends</span>
          </div>
        )}
      </div>
    </div>
  );
}

function CurrentBlock({ plan, visit, pct, tz }: { plan: DoctorPlan; visit: BoardVisit; pct: (t: number) => number; tz: string }) {
  const startedAt = new Date(plan.current!.startedAt).getTime();
  const est = (visit.estMinutes ?? 10) * MIN;
  const freeAt = new Date(plan.freeAt).getTime();
  const left = pct(startedAt);
  const width = pct(freeAt) - left;
  const overrunFrom = pct(startedAt + est);
  const overrun = plan.current!.overrunMin > 0;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className="absolute top-[14px] flex h-12 items-center overflow-hidden rounded-md bg-qm-consult text-white shadow-sm"
            style={{ left: `${left}%`, width: `${Math.max(width, 1)}%` }}
          />
        }
      >
        {overrun && <div className="absolute inset-y-0 right-0 bg-qm-emergency/85" style={{ left: `${((overrunFrom - left) / Math.max(width, 0.001)) * 100}%` }} />}
        <div className="relative min-w-0 px-2 leading-tight">
          <div className="truncate text-[12px] font-semibold">{visit.token ? `#${visit.token} ` : ""}{visit.patientName}</div>
          <div className="truncate text-[10px] opacity-90">
            in consult · {plan.current!.elapsedMin}m{overrun ? ` · +${plan.current!.overrunMin}m over` : ""}
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent className="block max-w-xs p-3 text-left">
        <div className="font-semibold">{visit.patientName}</div>
        <div className="opacity-80">Started {clock(plan.current!.startedAt, tz)} · estimate {visit.estMinutes ?? "avg"}m</div>
        {overrun && <div className="mt-1 text-qm-urgent">Running {plan.current!.overrunMin} min over — everyone behind slips.</div>}
      </TooltipContent>
    </Tooltip>
  );
}

function PlannedBlock({ q, visit, pct, tz, highlighted, onSelect }: { q: PlannedVisit; visit?: BoardVisit; pct: (t: number) => number; tz: string; highlighted: boolean; onSelect?: (id: string) => void }) {
  const startT = new Date(q.etaStart).getTime();
  const left = pct(startT);
  const width = pct(startT + q.estMinutes * MIN) - left;
  const t = tone(q.kind, q.priority);
  const expected = q.state === "expected";
  const scheduled = visit?.scheduledAt ? new Date(visit.scheduledAt).getTime() : null;
  const slip = scheduled !== null && (q.projectedDelayMin ?? 0) >= 5;
  return (
    <>
      {slip && (
        <>
          <div className="absolute top-[64px] h-0 border-t border-dashed border-qm-delay" style={{ left: `${pct(scheduled!)}%`, width: `${left - pct(scheduled!)}%` }} />
          <div className="absolute top-[60px] size-2 -translate-x-1/2 rounded-full border-2 border-qm-delay bg-card" style={{ left: `${pct(scheduled!)}%` }} />
        </>
      )}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={() => onSelect?.(q.visitId)}
              className={cn(
                "absolute top-[14px] flex h-12 items-center overflow-hidden rounded-md text-left transition-[left,width] duration-700 ease-out",
                expected ? "border border-dashed border-foreground/35 bg-card" : cn(t.bar, "text-white shadow-sm"),
                q.priority === "emergency" && "qm-pulse",
                highlighted && "ring-2 ring-foreground ring-offset-2 ring-offset-card",
              )}
              style={{ left: `${left}%`, width: `${Math.max(width, 0.8)}%` }}
            />
          }
        >
          {expected && <div className={cn("absolute inset-y-0 left-0 w-1", t.bar)} />}
          <div className={cn("relative min-w-0 px-2 leading-tight", expected && "pl-2.5")}>
            <div className="truncate text-[12px] font-semibold">
              {q.token ? `#${q.token} ` : ""}
              {q.patientName.split(" ")[0]}
            </div>
            <div className={cn("truncate text-[10px]", expected ? "text-muted-foreground" : "opacity-90")}>
              {q.priority !== "normal" ? q.priority.toUpperCase() : KIND_LABEL[q.kind]} · {q.waitMin}m
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent className="block max-w-xs space-y-1 p-3 text-left">
          <div className="font-semibold">
            {q.token ? `#${q.token} ` : ""}
            {q.patientName}
          </div>
          <div className="opacity-80">
            {KIND_LABEL[q.kind]} · {expected ? "not arrived yet" : "in waiting room"} · position {q.position}
          </div>
          <div>
            Starts ~{clock(q.etaStart, tz)} · wait {q.waitMin} min · {q.estMinutes} min consult
          </div>
          {scheduled !== null && (
            <div className={cn(slip && "text-qm-urgent")}>
              Booked {clock(visit!.scheduledAt, tz)}
              {q.projectedDelayMin ? ` · ${q.projectedDelayMin} min behind` : " · on time"}
            </div>
          )}
          {visit?.reason && <div className="opacity-80">Reason: {visit.reason}</div>}
          {q.flags.map((f) => (
            <div key={f} className="flex gap-1 text-qm-urgent">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" /> {f}
            </div>
          ))}
        </TooltipContent>
      </Tooltip>
    </>
  );
}
