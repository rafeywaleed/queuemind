"use client";
// The clinic as a little game board. Patients are tokens that physically move:
// arriving → waiting room (in queue order per doctor) → consult room → done.
// When the queue replans, a chip pops on each patient whose wait changed.
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { Clock3, DoorClosed, DoorOpen, Lock, LogIn, LogOut, Siren } from "lucide-react";
import { cn } from "@/lib/utils";
import { clock, initials, tone } from "@/lib/client/format";
import type { Board, BoardVisit, PlannedVisit } from "@/lib/client/types";

interface Delta {
  value: number;
  at: number;
}

export function ClinicFloor({ board }: { board: Board }) {
  const tz = board.clinic.timezone;
  const byId = useMemo(() => new Map(board.visits.map((v) => [v.id, v])), [board.visits]);
  const deltas = useWaitDeltas(board);

  const plans = board.snapshot.doctors;
  const expected = plans
    .flatMap((d) => d.queue.filter((q) => q.state === "expected").map((q) => ({ q, d })))
    .sort((a, b) => new Date(byId.get(a.q.visitId)?.scheduledAt ?? 0).getTime() - new Date(byId.get(b.q.visitId)?.scheduledAt ?? 0).getTime());
  const missing = board.snapshot.alerts.filter((a) => a.type === "likely_no_show" || a.type === "running_late").map((a) => ({ alert: a, visit: a.visitId ? byId.get(a.visitId) : undefined }));
  const done = board.visits.filter((v) => v.status === "done").sort((a, b) => (b.consultEndedAt ?? "").localeCompare(a.consultEndedAt ?? ""));

  return (
    <LayoutGroup>
      <div className="grid gap-3 lg:grid-cols-[220px_minmax(0,1fr)_minmax(0,1.05fr)_120px]">
        {/* Arriving */}
        <Zone icon={LogIn} title="Arriving" hint="Booked, not here yet">
          <div className="space-y-1.5">
            {expected.slice(0, 7).map(({ q }) => {
              const v = byId.get(q.visitId)!;
              return (
                <motion.div key={q.visitId} layout className="flex items-center gap-2">
                  <Token visit={v} planned={q} dashed delta={deltas.get(q.visitId)} />
                  <div className="min-w-0 text-[11px] leading-tight">
                    <div className="truncate font-medium">{v.patientName.split(" ")[0]}</div>
                    <div className="text-muted-foreground">
                      due {clock(v.scheduledAt, tz)}
                      {q.projectedDelayMin ? <span className="text-qm-urgent"> · +{q.projectedDelayMin}m</span> : null}
                    </div>
                  </div>
                </motion.div>
              );
            })}
            {missing.map(({ alert, visit }) =>
              visit ? (
                <motion.div key={visit.id} layout className="flex items-center gap-2 opacity-70">
                  <Token visit={visit} dashed ghost />
                  <div className="text-[11px] leading-tight">
                    <div className="font-medium">{visit.patientName.split(" ")[0]}</div>
                    <div className="text-qm-emergency">{alert.type === "likely_no_show" ? "likely no-show" : "late · slot released"}</div>
                  </div>
                </motion.div>
              ) : null,
            )}
            {expected.length === 0 && missing.length === 0 && <Empty>No one due</Empty>}
          </div>
        </Zone>

        {/* Waiting room */}
        <Zone icon={Clock3} title="Waiting room" hint="Seats in queue order, per doctor">
          <div className="space-y-2.5">
            {plans.map((d) => {
              const seats = d.queue.filter((q) => q.state === "waiting");
              return (
                <div key={d.doctorId} className="rounded-xl bg-muted/40 px-2.5 py-2">
                  <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                    <span className="grid size-5 place-items-center rounded-full bg-card text-[9px] font-bold text-foreground">{initials(d.name)}</span>
                    for {d.name}
                    <span className="ml-auto font-mono">{seats.length}</span>
                  </div>
                  <div className="flex min-h-[52px] flex-wrap gap-2">
                    <AnimatePresence mode="popLayout">
                      {seats.map((q) => (
                        <Token key={q.visitId} visit={byId.get(q.visitId)!} planned={q} delta={deltas.get(q.visitId)} showWait />
                      ))}
                    </AnimatePresence>
                    {seats.length === 0 && <span className="self-center text-[11px] text-muted-foreground">empty</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </Zone>

        {/* Consult rooms */}
        <Zone icon={DoorOpen} title="Consult rooms" hint="Who's with the doctor">
          <div className="space-y-2.5">
            {plans.map((d, i) => {
              const current = d.current ? byId.get(d.current.visitId) : null;
              const est = current?.estMinutes ?? board.doctors.find((x) => x.id === d.doctorId)?.avgConsultMin ?? 10;
              const away = d.delayMin > 0 && !d.current;
              return (
                <div
                  key={d.doctorId}
                  className={cn(
                    "relative flex min-h-[78px] items-center gap-3 overflow-hidden rounded-xl border px-3 py-2",
                    d.status === "off_duty" ? "bg-muted" : away ? "hatch border-qm-delay/50" : current ? "border-qm-consult/40 bg-qm-consult/[0.06]" : "border-qm-good/40 bg-qm-good/[0.05]",
                  )}
                >
                  <div className="w-24 shrink-0 text-[11px] leading-tight">
                    <div className="font-mono text-[10px] text-muted-foreground">ROOM {i + 1}</div>
                    <div className="font-semibold">{d.name.replace("Dr. ", "Dr ")}</div>
                    <div className="text-muted-foreground">{d.specialty}</div>
                  </div>
                  {d.status === "off_duty" ? (
                    <div className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
                      <DoorClosed className="size-4" /> Closed: off duty
                    </div>
                  ) : current && d.current ? (
                    <div className="flex flex-1 items-center gap-3">
                      <Token visit={current} big />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12px] font-medium">{current.patientName}</div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-foreground/10">
                          <motion.div
                            className={cn("h-full rounded-full", d.current.overrunMin > 0 ? "bg-qm-emergency" : "bg-qm-consult")}
                            animate={{ width: `${Math.min(100, (d.current.elapsedMin / Math.max(est, 1)) * 100)}%` }}
                          />
                        </div>
                        <div className={cn("mt-0.5 text-[10.5px]", d.current.overrunMin > 0 ? "text-qm-emergency" : "text-muted-foreground")}>
                          {d.current.elapsedMin}m of ~{est}m{d.current.overrunMin > 0 ? ` · ${d.current.overrunMin}m over` : ""}
                        </div>
                      </div>
                    </div>
                  ) : away ? (
                    <div className="rounded-lg bg-card/90 px-2.5 py-1.5 text-[12px] font-semibold">
                      Doctor away · back {clock(d.freeAt, tz)}
                    </div>
                  ) : (
                    <div className="text-[12px] font-medium text-qm-good">Free: ready for next patient</div>
                  )}
                </div>
              );
            })}
          </div>
        </Zone>

        {/* Done */}
        <Zone icon={LogOut} title="Done" hint="today">
          <div className="font-mono text-3xl font-semibold">{done.length}</div>
          <div className="mt-2 flex flex-wrap gap-1">
            {done.slice(0, 8).map((v) => (
              <motion.span key={v.id} layoutId={v.id} className="grid size-7 place-items-center rounded-full bg-foreground/10 font-mono text-[10px] font-semibold text-muted-foreground">
                {v.token ?? "·"}
              </motion.span>
            ))}
          </div>
        </Zone>
      </div>
    </LayoutGroup>
  );
}

function Zone({ icon: Icon, title, hint, children }: { icon: typeof Clock3; title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border bg-card p-3">
      <div className="mb-2.5 flex items-baseline gap-1.5">
        <Icon className="size-3.5 translate-y-0.5 text-muted-foreground" />
        <span className="text-[13px] font-semibold">{title}</span>
        <span className="truncate text-[11px] text-muted-foreground">{hint}</span>
      </div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="py-2 text-[11px] text-muted-foreground">{children}</div>;
}

/** A patient. Same layoutId everywhere, so moving between zones animates. */
function Token({
  visit,
  planned,
  dashed,
  ghost,
  big,
  showWait,
  delta,
}: {
  visit: BoardVisit;
  planned?: PlannedVisit;
  dashed?: boolean;
  ghost?: boolean;
  big?: boolean;
  showWait?: boolean;
  delta?: Delta;
}) {
  const t = tone(visit.kind, visit.priority);
  const fairness = planned?.flags.some((f) => f.startsWith("Fairness"));
  const lateFlag = planned?.flags.some((f) => f.startsWith("Arrived"));
  return (
    <motion.div
      layoutId={visit.id}
      initial={{ opacity: 0, scale: 0.6 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.6 }}
      transition={{ type: "spring", stiffness: 380, damping: 30 }}
      className="relative flex flex-col items-center"
      title={`${visit.token ? `#${visit.token} ` : ""}${visit.patientName} · ${visit.kind.replace("_", "-")}${visit.priority !== "normal" ? ` · ${visit.priority}` : ""}`}
    >
      <div
        className={cn(
          "grid place-items-center rounded-full font-mono font-bold",
          big ? "size-12 text-base" : "size-10 text-[13px]",
          dashed ? cn("border-2 border-dashed bg-card", ghost ? "border-muted-foreground/40 text-muted-foreground" : "border-foreground/30") : cn(t.bar, "text-white shadow-sm"),
          visit.priority === "emergency" && !dashed && "qm-pulse",
        )}
      >
        {visit.priority === "emergency" && !dashed ? <Siren className="size-4" /> : visit.token ?? "·"}
      </div>
      {visit.priority === "emergency" && !dashed && <span className="mt-0.5 font-mono text-[10px] font-bold text-qm-emergency">#{visit.token}</span>}
      {showWait && planned && visit.priority !== "emergency" && <span className="mt-0.5 font-mono text-[10px] text-muted-foreground">{planned.waitMin}m</span>}
      {fairness && <Lock className="absolute -top-1 -left-1 size-3.5 rounded-full bg-card p-0.5 text-qm-followup" />}
      {lateFlag && <Clock3 className="absolute -top-1 -left-1 size-3.5 rounded-full bg-card p-0.5 text-qm-urgent" />}
      <AnimatePresence>
        {delta && delta.value !== 0 && (
          <motion.span
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: -2 }}
            exit={{ opacity: 0 }}
            className={cn(
              "absolute -top-3 -right-4 z-10 rounded-full px-1.5 font-mono text-[10px] font-bold text-white shadow",
              delta.value > 0 ? "bg-qm-emergency" : "bg-qm-good",
            )}
          >
            {delta.value > 0 ? `+${delta.value}` : delta.value}m
          </motion.span>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/**
 * Compare each patient's wait with the previous board and remember changes for a few seconds.
 * Time passing alone (waits shrink by the elapsed minutes) is ignored: only replans show up.
 */
function useWaitDeltas(board: Board) {
  const prev = useRef<{ at: number; waits: Map<string, number> } | null>(null);
  const [deltas, setDeltas] = useState<Map<string, Delta>>(new Map());

  useEffect(() => {
    const at = new Date(board.snapshot.computedAt).getTime();
    const waits = new Map(board.snapshot.doctors.flatMap((d) => d.queue.map((q) => [q.visitId, q.waitMin] as const)));
    const before = prev.current;
    prev.current = { at, waits };
    if (!before) return;
    const elapsed = Math.round((at - before.at) / 60_000);
    const next = new Map<string, Delta>();
    for (const [id, w] of waits) {
      const old = before.waits.get(id);
      if (old === undefined) continue;
      const change = w - (old - elapsed);
      if (Math.abs(change) >= 3) next.set(id, { value: change, at: Date.now() });
    }
    if (next.size) {
      // Deferred so the highlight lands after this render commits.
      const timer = setTimeout(() => setDeltas(next), 0);
      const clear = setTimeout(() => setDeltas(new Map()), 6500);
      return () => {
        clearTimeout(timer);
        clearTimeout(clear);
      };
    }
  }, [board]);

  return deltas;
}
