"use client";
// Game HUD for the simulation: the clinic clock and its controls, live stats, and a feed of what
// just happened on the floor (arrivals, consults, walk-ins, agent and staff actions).
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Bot, FastForward, Hand, Pause, Play, Smartphone, Timer, UserRound } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { clock } from "@/lib/client/format";
import { postJson } from "@/lib/client/use-clinic";
import type { Board, ClinicClock, ClinicEvent } from "@/lib/client/types";

const SPEEDS = [
  { speed: 1, label: "1×", hint: "real time" },
  { speed: 6, label: "6×", hint: "10 s = 1 min" },
  { speed: 12, label: "12×", hint: "5 s = 1 min" },
];

export function ClockControls({ board, onChange }: { board: Board; onChange: () => void }) {
  const c: ClinicClock = board.clock ?? { speed: 1, paused: false, now: board.snapshot.computedAt };
  const [busy, setBusy] = useState(false);
  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await postJson("/api/sim/clock", body);
      onChange();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const speed = SPEEDS.find((s) => s.speed === c.speed);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border bg-card px-3 py-2">
      <div className="leading-none">
        <div className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">Clinic time</div>
        <div className="mt-1 font-mono text-2xl font-semibold tabular">{clock(c.now, board.clinic.timezone)}</div>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={() => send({ action: c.paused ? "play" : "pause" })}
        className={cn(
          "grid size-10 place-items-center rounded-xl transition-transform duration-150 active:scale-[0.96] disabled:opacity-50",
          c.paused ? "bg-primary text-primary-foreground" : "bg-foreground text-background",
        )}
        aria-label={c.paused ? "Play" : "Pause"}
      >
        {c.paused ? <Play className="size-4" /> : <Pause className="size-4" />}
      </button>
      <div className="flex rounded-xl bg-muted p-1">
        {SPEEDS.map((s) => (
          <button
            key={s.speed}
            type="button"
            disabled={busy}
            onClick={() => send({ action: "speed", speed: s.speed })}
            title={s.hint}
            className={cn("rounded-lg px-2.5 py-1 font-mono text-[12px] font-semibold transition-colors duration-150", c.speed === s.speed ? "bg-card shadow-sm" : "text-muted-foreground hover:text-foreground")}
          >
            {s.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={() => send({ action: "skip", minutes: 5 })}
        className="inline-flex items-center gap-1 rounded-xl border px-2.5 py-1.5 text-[12px] font-medium transition-colors duration-150 hover:border-primary disabled:opacity-50"
      >
        <FastForward className="size-3.5" /> +5 min
      </button>
      <div className="text-[11px] text-muted-foreground">{c.paused ? "Paused: nothing moves" : (speed?.hint ?? `${c.speed}×`)}</div>
    </div>
  );
}

export function Stats({ board }: { board: Board }) {
  const planned = board.snapshot.doctors.flatMap((d) => d.queue);
  const waiting = planned.filter((q) => q.state === "waiting");
  const items = [
    { label: "Waiting", value: waiting.length },
    { label: "Longest wait", value: `${Math.max(0, ...waiting.map((q) => q.waitMin))}m` },
    { label: "With doctors", value: board.snapshot.doctors.filter((d) => d.current).length },
    { label: "Seen today", value: board.visits.filter((v) => v.status === "done").length },
  ];
  return (
    <div className="flex divide-x rounded-2xl border bg-card">
      {items.map((it) => (
        <div key={it.label} className="px-4 py-2">
          <div className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">{it.label}</div>
          <div className="font-mono text-xl font-semibold tabular">{it.value}</div>
        </div>
      ))}
    </div>
  );
}

const ACTOR_ICON = { system: Timer, agent: Bot, staff: Hand, patient: Smartphone } as const;

export function LiveFeed({ events, timeZone }: { events: ClinicEvent[]; timeZone: string }) {
  const recent = events.filter((e) => e.type !== "demo_reset").slice(0, 5);
  return (
    <div className="rounded-2xl border bg-card px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
        <span className="size-1.5 animate-pulse rounded-full bg-qm-good" /> Live on the floor
      </div>
      <ul className="space-y-0.5">
        <AnimatePresence initial={false}>
          {recent.map((e) => {
            const Icon = ACTOR_ICON[e.actor] ?? UserRound;
            return (
              <motion.li
                key={e.id}
                layout="position"
                initial={{ opacity: 0, transform: "translateY(-4px)" }}
                animate={{ opacity: 1, transform: "translateY(0px)" }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
                className="flex items-center gap-2 text-[12.5px]"
              >
                <span className="w-14 shrink-0 font-mono text-[11px] text-muted-foreground">{clock(e.created_at, timeZone)}</span>
                <Icon className={cn("size-3.5 shrink-0", e.actor === "agent" ? "text-primary" : e.actor === "patient" ? "text-qm-followup" : "text-muted-foreground")} />
                <span className="truncate">{e.summary}</span>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
    </div>
  );
}
