"use client";
// The clinic as a small 2D game board. Every patient is a sprite with a fixed identity (visit id),
// so when the queue replans they walk: entrance → waiting chairs → consult room → exit.
// Motion: transform/opacity only, strong ease-in-out for on-screen movement (explanatory, so a
// little slower than UI motion), springs nowhere it matters, reduced motion respected.
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Bot, DoorOpen, MessageSquareText, Siren, Stethoscope, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { clock, initials } from "@/lib/client/format";
import type { Board, BoardVisit, Notification, PlannedVisit } from "@/lib/client/types";

export const STAGE_W = 1000;
export const STAGE_H = 620;
const SPRITE = 42;
const EASE_MOVE = [0.77, 0, 0.175, 1] as const;
const ROOM_X = [300, 532, 764];
const ROOM_W = 216;
const SEAT_X0 = 236;
const SEAT_GAP = 58;
const SEATS = 12;
const ROW_Y = [384, 460, 536];
const WAIT_LEFT = 176;
const DOOR = { x: 70, y: 600 };
const EXIT = { x: 985, y: 600 };

type Place = { x: number; y: number; kind: "arriving" | "missing" | "seat" | "room" };

export interface SceneProps {
  board: Board;
  notifications: Notification[];
  speech: { who: "agent" | "laya" | "staff" | "patient"; text: string } | null;
  selected: string | null;
  onSelect: (visitId: string | null) => void;
}

export function ClinicScene({ board, notifications, speech, selected, onSelect }: SceneProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const reduce = useReducedMotion();
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setScale(e.contentRect.width / STAGE_W));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const tz = board.clinic.timezone;
  const byId = useMemo(() => new Map(board.visits.map((v) => [v.id, v])), [board.visits]);
  const planById = useMemo(() => new Map(board.snapshot.doctors.flatMap((d) => d.queue.map((q) => [q.visitId, q] as const))), [board.snapshot]);
  const places = useMemo(() => layout(board), [board]);
  const pings = usePings(notifications);
  const deltas = useWaitDeltas(board);

  return (
    <div ref={wrap} className="relative w-full overflow-hidden rounded-3xl border bg-[oklch(0.975_0.006_95)] shadow-sm" style={{ height: STAGE_H * scale }}>
      <div className="absolute top-0 left-0 origin-top-left" style={{ width: STAGE_W, height: STAGE_H, transform: `scale(${scale})` }}>
        <Floor board={board} tz={tz} />

        {/* Reception: receptionist + the agent, with what the agent is doing right now */}
        <div className="absolute" style={{ left: 40, top: 150, width: 220 }}>
          <div className="relative h-[70px] rounded-2xl border-2 border-[oklch(0.8_0.03_60)] bg-[oklch(0.93_0.03_70)] shadow-sm">
            <div className="absolute -top-6 left-6 flex flex-col items-center">
              <div className="grid size-11 place-items-center rounded-full border-2 border-white bg-[oklch(0.75_0.08_30)] text-white shadow">
                <UserRound className="size-5" />
              </div>
            </div>
            <div className="absolute -top-6 right-6 flex flex-col items-center">
              <motion.div
                className={cn("grid size-11 place-items-center rounded-full border-2 border-white text-white shadow", speech?.who === "laya" ? "bg-qm-appointment" : "bg-primary")}
                animate={speech ? { transform: "translateY(-3px)" } : { transform: "translateY(0px)" }}
                transition={{ duration: 0.6, repeat: speech ? Infinity : 0, repeatType: "reverse", ease: "easeInOut" }}
              >
                <Bot className="size-5" />
              </motion.div>
            </div>
            <div className="absolute bottom-1.5 w-full text-center text-[11px] font-semibold text-[oklch(0.45_0.05_60)]">Reception · Amna + agent</div>
          </div>
        </div>
        <AnimatePresence>
          {speech && (
            <motion.div
              key={speech.text}
              initial={{ opacity: 0, transform: "translateY(6px) scale(0.97)" }}
              animate={{ opacity: 1, transform: "translateY(0px) scale(1)" }}
              exit={{ opacity: 0, transform: "translateY(-4px) scale(0.98)" }}
              transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
              className={cn(
                "absolute rounded-2xl rounded-br-sm px-3 py-2 text-[13px] leading-snug font-medium text-white shadow-lg",
                speech.who === "laya" ? "bg-qm-appointment" : speech.who === "staff" ? "bg-foreground" : speech.who === "patient" ? "bg-qm-followup" : "bg-primary",
              )}
              style={{ left: 28, top: 22, width: 250 }}
            >
              <div className="text-[10px] font-semibold tracking-wider uppercase opacity-80">
                {speech.who === "laya" ? "Laya · decision model" : speech.who === "staff" ? "Staff" : speech.who === "patient" ? "Patient SMS" : "QueueMind agent"}
              </div>
              {speech.text}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Patients */}
        <AnimatePresence initial={false}>
          {[...places.entries()].map(([id, place]) => {
            const v = byId.get(id);
            if (!v) return null;
            return (
              <Sprite
                key={id}
                visit={v}
                planned={planById.get(id)}
                place={place}
                selected={selected === id}
                ping={pings.has(id)}
                delta={deltas.get(id)}
                reduce={!!reduce}
                onClick={() => onSelect(selected === id ? null : id)}
              />
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}

/** Static scenery: walls, rooms with doctors, chairs, entrance and exit. */
function Floor({ board, tz }: { board: Board; tz: string }) {
  const byId = new Map(board.visits.map((v) => [v.id, v]));
  return (
    <>
      <div className="absolute inset-0 [background-image:radial-gradient(oklch(0.85_0.01_95)_1px,transparent_1px)] [background-size:22px_22px]" />
      {/* Entrance */}
      <div className="absolute flex flex-col items-center" style={{ left: 16, top: 262, width: 120 }}>
        <div className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Arriving</div>
      </div>
      <div className="absolute flex items-center gap-1.5 rounded-t-xl border-x-2 border-t-2 border-[oklch(0.75_0.03_220)] bg-card px-3 py-1 text-[11px] font-semibold" style={{ left: 30, top: 584 }}>
        <DoorOpen className="size-3.5" /> Entrance
      </div>
      <div className="absolute rounded-t-xl border-x-2 border-t-2 border-[oklch(0.75_0.03_220)] bg-card px-3 py-1 text-[11px] font-semibold" style={{ left: 922, top: 584 }}>
        Exit
      </div>

      {/* Waiting area */}
      <div className="absolute rounded-3xl border border-dashed border-[oklch(0.82_0.02_220)] bg-white/50" style={{ left: WAIT_LEFT, top: 334, width: 980 - WAIT_LEFT, height: 240 }} />
      <div className="absolute text-[11px] font-semibold tracking-wider text-muted-foreground uppercase" style={{ left: WAIT_LEFT + 16, top: 340 }}>
        Waiting room
      </div>
      {board.snapshot.doctors.map((d, r) => (
        <div key={d.doctorId}>
          <div className="absolute grid size-7 place-items-center rounded-full bg-accent text-[10px] font-bold text-accent-foreground" style={{ left: WAIT_LEFT + 14, top: ROW_Y[r] - 18 }} title={`Row for ${d.name}`}>
            {initials(d.name)}
          </div>
          {Array.from({ length: SEATS }).map((_, j) => (
            <div key={j} className="absolute rounded-[10px] bg-[oklch(0.9_0.012_220)]" style={{ left: SEAT_X0 + j * SEAT_GAP - 18, top: ROW_Y[r] + 12, width: 36, height: 12 }} />
          ))}
        </div>
      ))}

      {/* Consult rooms */}
      {board.snapshot.doctors.map((d, i) => {
        const current = d.current ? byId.get(d.current.visitId) : null;
        const est = current?.estMinutes ?? board.doctors.find((x) => x.id === d.doctorId)?.avgConsultMin ?? 10;
        const away = d.delayMin > 0 && !d.current;
        const off = d.status === "off_duty";
        return (
          <div
            key={d.doctorId}
            className={cn("absolute rounded-3xl border-2 bg-card shadow-sm transition-colors duration-300", off ? "border-foreground/20 bg-muted" : away ? "border-qm-delay" : current ? "border-qm-consult/50" : "border-qm-good/50")}
            style={{ left: ROOM_X[i], top: 18, width: ROOM_W, height: 210 }}
          >
            <div className="flex items-start justify-between px-3 pt-2">
              <div className="leading-tight">
                <div className="font-mono text-[10px] text-muted-foreground">ROOM {i + 1}</div>
                <div className="text-[13px] font-semibold">{d.name}</div>
                <div className="text-[11px] text-muted-foreground">{d.specialty}</div>
              </div>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[10px] font-bold",
                  off ? "bg-foreground text-background" : away ? "bg-qm-delay text-foreground" : current ? "bg-qm-consult text-white" : "bg-qm-good text-white",
                )}
              >
                {off ? (current ? "LAST PATIENT" : "CLOSED") : away ? `BACK ${clock(d.freeAt, tz)}` : current ? "IN CONSULT" : "FREE"}
              </span>
            </div>
            {/* doctor at desk */}
            <div className="absolute flex flex-col items-center" style={{ left: 28, top: 82 }}>
              <div className={cn("grid size-12 place-items-center rounded-full border-2 border-white text-white shadow", off || away ? "bg-muted-foreground/50" : "bg-qm-consult")}>
                <Stethoscope className="size-5" />
              </div>
              <div className="mt-1 h-3 w-16 rounded-md bg-[oklch(0.86_0.03_70)]" />
            </div>
            {/* patient chair */}
            <div className="absolute rounded-[10px] bg-[oklch(0.9_0.012_220)]" style={{ left: 122, top: 128, width: 40, height: 12 }} />
            {away && <div className="hatch absolute inset-x-3 bottom-3 grid h-9 place-items-center rounded-xl text-[11px] font-semibold">Doctor stepped out · back {clock(d.freeAt, tz)}</div>}
            {current && d.current && (
              <div className="absolute inset-x-3 bottom-3">
                <div className="h-1.5 overflow-hidden rounded-full bg-foreground/10">
                  <div
                    className={cn("h-full origin-left rounded-full transition-transform duration-700", d.current.overrunMin > 0 ? "bg-qm-emergency" : "bg-qm-consult")}
                    style={{ transform: `scaleX(${Math.min(1, d.current.elapsedMin / Math.max(est, 1))})` }}
                  />
                </div>
                <div className={cn("mt-0.5 text-[10.5px]", d.current.overrunMin > 0 ? "font-semibold text-qm-emergency" : "text-muted-foreground")}>
                  {d.current.elapsedMin}m of ~{est}m{d.current.overrunMin > 0 ? ` · ${d.current.overrunMin}m over` : ""}
                </div>
              </div>
            )}
            {/* door gap */}
            <div className="absolute -bottom-[3px] left-1/2 h-[5px] w-12 -translate-x-1/2 bg-[oklch(0.975_0.006_95)]" />
          </div>
        );
      })}
    </>
  );
}

function Sprite({
  visit,
  planned,
  place,
  selected,
  ping,
  delta,
  reduce,
  onClick,
}: {
  visit: BoardVisit;
  planned?: PlannedVisit;
  place: Place;
  selected: boolean;
  ping: boolean;
  delta?: number;
  reduce: boolean;
  onClick: () => void;
}) {
  const emergency = visit.priority === "emergency";
  const child = /\(child\)/i.test(visit.patientName);
  const ghost = place.kind === "missing";
  const dashed = place.kind === "arriving" || ghost;
  const color = emergency
    ? "bg-qm-emergency"
    : visit.priority === "urgent"
      ? "bg-qm-urgent"
      : visit.kind === "appointment"
        ? "bg-qm-appointment"
        : visit.kind === "follow_up"
          ? "bg-qm-followup"
          : "bg-qm-walkin";
  const size = child ? SPRITE - 8 : SPRITE;
  const t = (x: number, y: number) => `translate(${x - size / 2}px, ${y - size / 2}px)`;
  return (
    <motion.button
      type="button"
      onClick={onClick}
      title={`${visit.token ? `#${visit.token} ` : ""}${visit.patientName}`}
      className="absolute top-0 left-0 z-10 flex flex-col items-center outline-none"
      initial={{ transform: t(DOOR.x, DOOR.y), opacity: 0 }}
      animate={{ transform: t(place.x, place.y), opacity: ghost ? 0.55 : 1 }}
      exit={{ transform: t(EXIT.x, EXIT.y), opacity: 0 }}
      transition={{ duration: reduce ? 0 : 0.95, ease: EASE_MOVE }}
    >
      <div
        className={cn(
          "relative grid place-items-center rounded-full font-mono text-[12px] font-bold shadow-md ring-2 transition-shadow duration-200",
          dashed ? "border-2 border-dashed border-foreground/35 bg-card text-foreground ring-transparent" : cn(color, "text-white ring-white"),
          emergency && !dashed && "qm-pulse",
          selected && "ring-4 ring-foreground",
        )}
        style={{ width: size, height: size }}
      >
        {emergency && !dashed ? <Siren className="size-4" /> : (visit.token ?? "·")}
        <AnimatePresence>
          {ping && (
            <motion.span
              initial={{ opacity: 0, transform: "translateY(4px) scale(0.9)" }}
              animate={{ opacity: 1, transform: "translateY(0px) scale(1)" }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
              className="absolute -top-4 -left-3 grid size-6 place-items-center rounded-full bg-qm-followup text-white shadow"
            >
              <MessageSquareText className="size-3.5" />
            </motion.span>
          )}
          {delta !== undefined && delta !== 0 && (
            <motion.span
              initial={{ opacity: 0, transform: "translateY(4px)" }}
              animate={{ opacity: 1, transform: "translateY(0px)" }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
              className={cn("absolute -top-4 -right-6 rounded-full px-1.5 font-mono text-[10px] font-bold text-white shadow", delta > 0 ? "bg-qm-emergency" : "bg-qm-good")}
            >
              {delta > 0 ? `+${delta}` : delta}m
            </motion.span>
          )}
        </AnimatePresence>
      </div>
      {place.kind === "seat" && planned && !emergency && <span className="mt-0.5 font-mono text-[10px] text-muted-foreground">{planned.waitMin}m</span>}
      {(place.kind === "arriving" || ghost) && (
        <span className="absolute text-left leading-tight whitespace-nowrap" style={{ left: size + 8, top: size / 2, transform: "translateY(-50%)" }}>
          <span className="block text-[11px] font-medium text-foreground">{visit.patientName.split(" ")[0]}</span>
          <span className={cn("block text-[10px]", ghost ? "font-semibold text-qm-emergency" : "text-muted-foreground")}>{ghost ? "no-show?" : "on the way"}</span>
        </span>
      )}
    </motion.button>
  );
}

/** Where every visible patient stands. */
function layout(board: Board): Map<string, Place> {
  const places = new Map<string, Place>();
  board.snapshot.doctors.forEach((d, i) => {
    if (d.current) places.set(d.current.visitId, { x: ROOM_X[i] + 142, y: 118, kind: "room" });
    d.queue
      .filter((q) => q.state === "waiting")
      .slice(0, SEATS)
      .forEach((q, j) => places.set(q.visitId, { x: SEAT_X0 + j * SEAT_GAP, y: ROW_Y[i] - 4, kind: "seat" }));
  });
  const byId = new Map(board.visits.map((v) => [v.id, v]));
  const expected = board.snapshot.doctors
    .flatMap((d) => d.queue.filter((q) => q.state === "expected"))
    .sort((a, b) => (byId.get(a.visitId)?.scheduledAt ?? "").localeCompare(byId.get(b.visitId)?.scheduledAt ?? ""));
  const missing = board.snapshot.alerts.filter((a) => a.type === "likely_no_show" && a.visitId).map((a) => a.visitId!);
  [...missing.map((id) => ({ id, kind: "missing" as const })), ...expected.map((q) => ({ id: q.visitId, kind: "arriving" as const }))]
    .slice(0, 6)
    .forEach((p, k) => places.set(p.id, { x: 44, y: 300 + k * 48, kind: p.kind }));
  return places;
}

/** Visits that just got an SMS (drafted or sent) show a message bubble for a few seconds. */
function usePings(notifications: Notification[]) {
  const seen = useRef<Set<string> | null>(null);
  const [pings, setPings] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!seen.current) {
      seen.current = new Set(notifications.map((n) => n.id));
      return;
    }
    const fresh = notifications.filter((n) => !seen.current!.has(n.id) && n.visit_id);
    fresh.forEach((n) => seen.current!.add(n.id));
    if (!fresh.length) return;
    const ids = new Set(fresh.map((n) => n.visit_id!));
    const show = setTimeout(() => setPings(ids), 0);
    const hide = setTimeout(() => setPings(new Set()), 5000);
    return () => {
      clearTimeout(show);
      clearTimeout(hide);
    };
  }, [notifications]);
  return pings;
}

/** Wait changes caused by a replan (time passing alone is ignored), shown for a few seconds. */
function useWaitDeltas(board: Board) {
  const prev = useRef<{ at: number; waits: Map<string, number> } | null>(null);
  const [deltas, setDeltas] = useState<Map<string, number>>(new Map());
  useEffect(() => {
    const at = new Date(board.snapshot.computedAt).getTime();
    const waits = new Map(board.snapshot.doctors.flatMap((d) => d.queue.map((q) => [q.visitId, q.waitMin] as const)));
    const before = prev.current;
    prev.current = { at, waits };
    if (!before) return;
    const elapsed = Math.round((at - before.at) / 60_000);
    const next = new Map<string, number>();
    for (const [id, w] of waits) {
      const old = before.waits.get(id);
      if (old !== undefined && Math.abs(w - (old - elapsed)) >= 3) next.set(id, w - (old - elapsed));
    }
    if (!next.size) return;
    const show = setTimeout(() => setDeltas(next), 0);
    const hide = setTimeout(() => setDeltas(new Map()), 6500);
    return () => {
      clearTimeout(show);
      clearTimeout(hide);
    };
  }, [board]);
  return deltas;
}
