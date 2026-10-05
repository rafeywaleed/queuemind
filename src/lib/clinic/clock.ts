// The clinic clock. The simulation runs faster than real time (default 6×: 10 real seconds = 1
// clinic minute) and can be paused. State lives on the clinic row so every serverless instance and
// every screen agrees on "now". Model-quota code keeps using real time on purpose.
import { CLINIC_ID, db } from "../db/client";

export interface ClockState {
  /** Clinic minutes per real minute. 1 = real time, 6 = 10 s per clinic minute. */
  speed: number;
  /** Real epoch ms at the last re-anchor. */
  anchorReal: number;
  /** Clinic epoch ms at the last re-anchor. */
  anchorSim: number;
  paused: boolean;
}

export const DEFAULT_SPEED = Number(process.env.SIM_SPEED ?? 6);
const IDLE_MS = 60_000;

let cache: { at: number; clock: ClockState; lastTickReal: number | null } | null = null;

export function simNow(c: ClockState, real = Date.now()): number {
  return c.paused ? c.anchorSim : c.anchorSim + (real - c.anchorReal) * c.speed;
}

function fresh(real = Date.now()): ClockState {
  return { speed: DEFAULT_SPEED, anchorReal: real, anchorSim: real, paused: false };
}

async function load(force = false) {
  if (!force && cache && Date.now() - cache.at < 1_000) return cache;
  const { data } = await db().from("clinics").select("clock, last_tick_real").eq("id", CLINIC_ID).maybeSingle();
  const clock = (data?.clock as ClockState | null) ?? fresh();
  cache = { at: Date.now(), clock, lastTickReal: data?.last_tick_real ? new Date(data.last_tick_real).getTime() : null };
  return cache;
}

export async function getClock(): Promise<ClockState> {
  return (await load()).clock;
}

/** "Now" inside the clinic (simulated). */
export async function clinicNow(): Promise<Date> {
  return new Date(simNow(await getClock()));
}

export async function saveClock(clock: ClockState) {
  await db().from("clinics").update({ clock }).eq("id", CLINIC_ID);
  cache = { at: Date.now(), clock, lastTickReal: cache?.lastTickReal ?? null };
  return clock;
}

export async function resetClock() {
  return saveClock(fresh());
}

/** Play / pause / change speed / jump ahead — always re-anchored so time never jumps backwards. */
export async function controlClock(cmd: { action: "play" | "pause" | "speed" | "skip"; speed?: number; minutes?: number }) {
  const c = await getClock();
  const real = Date.now();
  const now = simNow(c, real);
  const next: ClockState = { ...c, anchorReal: real, anchorSim: now };
  if (cmd.action === "pause") next.paused = true;
  if (cmd.action === "play") next.paused = false;
  if (cmd.action === "speed" && cmd.speed) next.speed = Math.min(Math.max(cmd.speed, 1), 30);
  if (cmd.action === "skip") next.anchorSim = now + Math.min(Math.max(cmd.minutes ?? 5, 1), 60) * 60_000;
  return saveClock(next);
}

/**
 * Claim the autopilot tick (atomic: only one instance wins per window). If nobody has looked at
 * the clinic for a while, freeze time across the gap so an idle night doesn't turn into a day of
 * overrun consults and no-shows.
 */
export async function claimTick(minGapMs: number): Promise<{ claimed: boolean; clock: ClockState }> {
  const { clock, lastTickReal } = await load(true);
  const real = Date.now();
  let current = clock;
  if (lastTickReal && real - lastTickReal > IDLE_MS && !clock.paused) {
    current = await saveClock({ ...clock, anchorSim: simNow(clock, lastTickReal), anchorReal: real });
  }
  const threshold = new Date(real - minGapMs).toISOString();
  const { data } = await db()
    .from("clinics")
    .update({ last_tick_real: new Date(real).toISOString() })
    .eq("id", CLINIC_ID)
    .or(`last_tick_real.is.null,last_tick_real.lt.${threshold}`)
    .select("id");
  if (cache) cache.lastTickReal = real;
  return { claimed: !!data?.length, clock: current };
}
