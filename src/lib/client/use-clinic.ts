"use client";
// Live clinic data for every view: board (engine plan), outbox, event log, model status.
// Supabase Realtime pushes row changes; we debounce and refetch the computed board.
import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import type { AgentEvent, Board, ClinicEvent, Notification, PatientMessage, RouterStatus, Scenario } from "./types";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `Request failed: ${url}`);
  return body as T;
}

export async function postJson<T = unknown>(url: string, data: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `Request failed: ${url}`);
  return body as T;
}

const supabase =
  typeof window !== "undefined" && process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    ? createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } })
    : null;

export interface ClinicData {
  board: Board | null;
  notifications: Notification[];
  patientMessages: PatientMessage[];
  events: ClinicEvent[];
  status: RouterStatus | null;
  scenarios: Scenario[];
  error: string | null;
  live: boolean;
  lastUpdated: number;
  refresh: () => Promise<void>;
  refreshStatus: () => Promise<void>;
}

export function useClinic(): ClinicData {
  const [board, setBoard] = useState<Board | null>(null);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [patientMessages, setPatientMessages] = useState<PatientMessage[]>([]);
  const [events, setEvents] = useState<ClinicEvent[]>([]);
  const [status, setStatus] = useState<RouterStatus | null>(null);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [b, n, e, pm] = await Promise.all([
        getJson<Board>("/api/board"),
        getJson<Notification[]>("/api/notifications"),
        getJson<ClinicEvent[]>("/api/events?limit=80"),
        getJson<PatientMessage[]>("/api/patient-messages").catch(() => []),
      ]);
      setBoard(b);
      setNotifications(n);
      setPatientMessages(pm);
      setEvents(e);
      setError(null);
      setLastUpdated(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await getJson<RouterStatus>("/api/status"));
    } catch {
      // status is decorative; ignore failures
    }
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void refresh(), 350);
  }, [refresh]);

  useEffect(() => {
    // refresh() only sets state after its network round-trip resolves, not synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    void refreshStatus();
    void getJson<Scenario[]>("/api/demo").then(setScenarios).catch(() => undefined);
    const statusPoll = setInterval(() => void refreshStatus(), 20_000);
    let channel: ReturnType<NonNullable<typeof supabase>["channel"]> | null = null;
    if (supabase) {
      channel = supabase.channel("clinic-live");
      for (const table of ["visits", "doctors", "notifications", "events", "patient_messages"]) {
        channel.on("postgres_changes", { event: "*", schema: "public", table }, scheduleRefresh);
      }
      channel.subscribe((s) => setLive(s === "SUBSCRIBED"));
    }
    return () => {
      clearInterval(statusPoll);
      if (channel && supabase) void supabase.removeChannel(channel);
    };
  }, [refresh, refreshStatus, scheduleRefresh]);

  // Waits are time-dependent. While the clinic clock runs (default 6×), refresh every 3 s so the
  // floor moves smoothly and the autopilot gets its ticks; when paused, every 20 s is enough.
  const running = !!board?.clock && !board.clock.paused;
  useEffect(() => {
    const poll = setInterval(() => void refresh(), running ? 3_000 : 20_000);
    return () => clearInterval(poll);
  }, [running, refresh]);

  return { board, notifications, patientMessages, events, status, scenarios, error, live, lastUpdated, refresh, refreshStatus };
}

/** Stream one agent turn; calls onEvent for each NDJSON event. */
export async function streamAgent(threadId: string, message: string, onEvent: (e: AgentEvent) => void, signal?: AbortSignal) {
  const res = await fetch("/api/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadId, message }),
    signal,
  });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    onEvent({ type: "error", message: body?.error ?? `Agent request failed (${res.status})` });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
}
