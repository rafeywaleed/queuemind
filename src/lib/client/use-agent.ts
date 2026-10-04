"use client";
// Agent session state: turns (user message → plan, tool steps, streamed answer), persisted
// server-side by the LangGraph checkpointer and rehydrated by thread id.
import { useCallback, useEffect, useRef, useState } from "react";
import { streamAgent } from "./use-clinic";
import type { AgentEvent } from "./types";

export interface Step {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

export interface Turn {
  id: string;
  message: string;
  todos: { content: string; status: string }[];
  steps: Step[];
  text: string;
  status: "running" | "done" | "error";
  error?: string;
  startedAt: number;
  endedAt?: number;
}

const THREAD_KEY = "queuemind.thread";

function newThreadId() {
  return `desk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function readThread(): string {
  try {
    const saved = localStorage.getItem(THREAD_KEY);
    if (saved) return saved;
  } catch {
    // storage unavailable
  }
  const id = newThreadId();
  try {
    localStorage.setItem(THREAD_KEY, id);
  } catch {
    // storage unavailable
  }
  return id;
}

type HistoryMessage = { role: "user" | "assistant" | "tool"; text: string; id?: string; name?: string; tools?: { id: string; name: string; args: Record<string, unknown> }[] };

function turnsFromHistory(messages: HistoryMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      turns.push({ id: `h${turns.length}`, message: m.text, todos: [], steps: [], text: "", status: "done", startedAt: 0 });
      continue;
    }
    const turn = turns[turns.length - 1];
    if (!turn) continue;
    if (m.role === "assistant") {
      for (const t of m.tools ?? []) {
        if (t.name === "write_todos") turn.todos = (t.args.todos as Turn["todos"]) ?? turn.todos;
        else turn.steps.push({ id: t.id, name: t.name, args: t.args });
      }
      if (m.text) turn.text = m.text;
    } else if (m.role === "tool") {
      const step = turn.steps.find((s) => s.id === m.id);
      if (step) {
        step.result = m.text;
        step.isError = m.text.startsWith("ERROR");
      }
    }
  }
  return turns;
}

export function useAgentSession(onActivity?: () => void) {
  const [threadId, setThreadId] = useState<string>(() => readThread());
  const [turns, setTurns] = useState<Turn[]>([]);
  const [running, setRunning] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const activity = useRef(onActivity);
  useEffect(() => {
    activity.current = onActivity;
  });

  // Rehydrate the thread from the server-side checkpointer.
  useEffect(() => {
    fetch(`/api/agent?threadId=${encodeURIComponent(threadId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => data?.messages && setTurns(turnsFromHistory(data.messages)))
      .catch(() => undefined);
    // Only on mount: later turns are appended locally as they stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = (turnId: string, fn: (t: Turn) => Turn) => setTurns((all) => all.map((t) => (t.id === turnId ? fn(t) : t)));

  const send = useCallback(
    async (message: string) => {
      if (!threadId || running || !message.trim()) return;
      const turnId = `t${Date.now()}`;
      setTurns((all) => [...all, { id: turnId, message, todos: [], steps: [], text: "", status: "running", startedAt: Date.now() }]);
      setRunning(true);
      abort.current = new AbortController();
      const onEvent = (e: AgentEvent) => {
        switch (e.type) {
          case "token":
            update(turnId, (t) => ({ ...t, text: t.text + e.text }));
            break;
          case "final":
            update(turnId, (t) => ({ ...t, text: e.text }));
            break;
          case "todos":
            update(turnId, (t) => ({ ...t, todos: e.todos }));
            break;
          case "tool_call":
            if (e.name === "write_todos") {
              update(turnId, (t) => ({ ...t, todos: (e.args.todos as Turn["todos"]) ?? t.todos }));
              break;
            }
            update(turnId, (t) => (t.steps.some((s) => s.id === e.id) ? t : { ...t, steps: [...t.steps, { id: e.id, name: e.name, args: e.args }] }));
            break;
          case "tool_result":
            update(turnId, (t) => ({ ...t, steps: t.steps.map((s) => (s.id === e.id ? { ...s, result: e.content, isError: e.isError } : s)) }));
            activity.current?.();
            break;
          case "error":
            update(turnId, (t) => ({ ...t, status: "error", error: e.message, endedAt: Date.now() }));
            break;
          case "done":
            update(turnId, (t) => ({ ...t, status: t.status === "error" ? "error" : "done", endedAt: Date.now() }));
            break;
        }
      };
      try {
        await streamAgent(threadId, message, onEvent, abort.current.signal);
      } catch (err) {
        if ((err as Error).name !== "AbortError") onEvent({ type: "error", message: (err as Error).message });
      } finally {
        update(turnId, (t) => (t.status === "running" ? { ...t, status: "done", endedAt: Date.now() } : t));
        setRunning(false);
        activity.current?.();
      }
    },
    [threadId, running],
  );

  const reset = useCallback(() => {
    abort.current?.abort();
    const id = newThreadId();
    try {
      localStorage.setItem(THREAD_KEY, id);
    } catch {
      // storage unavailable
    }
    setThreadId(id);
    setTurns([]);
    setRunning(false);
  }, []);

  return { threadId, turns, running, send, reset };
}

export type AgentSession = ReturnType<typeof useAgentSession>;
