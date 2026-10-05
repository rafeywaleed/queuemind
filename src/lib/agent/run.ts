// Runs the agent for one turn and converts LangGraph's stream into simple NDJSON events
// the UI can render: tokens, plan (todos), tool calls/results, files, done/error.
import { AIMessage, AIMessageChunk, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { agentFiles, buildAgent } from "./agent";
import { loadClinicState } from "../db/repo";
import { board } from "../clinic/actions";

export type AgentEvent =
  | { type: "token"; text: string }
  | { type: "todos"; todos: { content: string; status: string }[] }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "tool_result"; id: string; name: string; content: string; isError: boolean }
  | { type: "files"; paths: string[] }
  | { type: "final"; text: string }
  | { type: "done"; threadId: string }
  | { type: "error"; message: string };

let agentCache: { key: string; agent: Awaited<ReturnType<typeof buildAgent>> } | null = null;

async function getAgent() {
  const { clinic } = await loadClinicState();
  const key = JSON.stringify(clinic);
  if (!agentCache || agentCache.key !== key) agentCache = { key, agent: await buildAgent(clinic) };
  return agentCache.agent;
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : p && typeof p === "object" && "text" in p && (p as { type?: string }).type !== "thinking" ? String((p as { text: unknown }).text) : ""))
      .join("");
  }
  return "";
}

function userFiles(files: Record<string, unknown> | undefined) {
  return Object.keys(files ?? {}).filter((p) => !p.startsWith("/skills/"));
}

/** Events that must end in a specific action. Checked after the turn by code, not by the model. */
const REQUIRED_ACTIONS: { when: RegExp; need: string[]; nudge: string }[] = [
  {
    when: /\bwalk-?in\b/i,
    need: ["register_walk_in", "check_in_patient"],
    nudge: "The walk-in in the previous message is not in the queue yet. Register them now with register_walk_in (include age if stated; use check_in_patient if they have a booking), then reply in two lines.",
  },
  {
    when: /\bDr\.?\s+\w+[^.]*\b(leaves?|leaving|left|off duty|won'?t see)\b/i,
    need: ["mark_doctor_off_duty", "report_doctor_delay"],
    nudge: "The doctor's absence from the previous message is not recorded yet. Record it now (mark_doctor_off_duty if they won't return today, else report_doctor_delay), then reply in two lines.",
  },
];

export async function* runAgentTurn(threadId: string, message: string): AsyncGenerator<AgentEvent> {
  const config = { configurable: { thread_id: threadId }, streamMode: ["updates", "messages"] as const, recursionLimit: 80 };
  const toolNames = new Map<string, string>();
  // Middleware nodes can re-emit the same messages in "updates"; emit each call/result once.
  const seen = new Set<string>();
  try {
    const agent = await getAgent();
    // Attach the live board so the agent starts informed — one fewer model step per turn.
    const snapshot = JSON.stringify(await board());
    const content = `${message}\n\n<board_at_message_time>\n${snapshot}\n</board_at_message_time>`;
    // Messages already in the thread belong to earlier turns; middleware can re-emit them in
    // "updates", and they must never be mistaken for this turn's tool calls or final answer.
    const prior = await (agent as unknown as { getState: (c: unknown) => Promise<{ values?: { messages?: BaseMessage[] } }> })
      .getState({ configurable: { thread_id: threadId } })
      .then((st) => new Set((st?.values?.messages ?? []).map((m) => m.id).filter(Boolean)))
      .catch(() => new Set<string | undefined>());
    const succeeded = new Set<string>();
    let emergencyLine: string | null = null;
    const pass = async function* (input: string): AsyncGenerator<AgentEvent> {
      const stream = await agent.stream({ messages: [{ role: "user", content: input }], files: agentFiles() } as never, config as never);
      for await (const item of stream as AsyncIterable<[string, unknown]>) {
        const [mode, chunk] = item;
        if (mode === "messages") {
          const [msg, meta] = chunk as [BaseMessage, Record<string, unknown>];
          // Only stream the top-level agent's words (not subagent internals).
          const ns = String(meta?.langgraph_checkpoint_ns ?? "");
          if (AIMessageChunk.isInstance(msg) && !ns.includes("tools:")) {
            const text = textOf(msg.content);
            if (text) yield { type: "token", text };
          }
          continue;
        }
        for (const update of Object.values((chunk ?? {}) as Record<string, unknown>)) {
          if (!update || typeof update !== "object") continue;
          const u = update as { messages?: unknown; todos?: unknown; files?: Record<string, unknown> };
          if (Array.isArray(u.todos)) yield { type: "todos", todos: u.todos as { content: string; status: string }[] };
          if (u.files && typeof u.files === "object") {
            const paths = userFiles(u.files);
            if (paths.length) yield { type: "files", paths };
          }
          const messages = Array.isArray(u.messages) ? (u.messages as BaseMessage[]) : [];
          for (const m of messages) {
            const key = ToolMessage.isInstance(m) ? `r:${m.tool_call_id}` : `m:${m.id ?? JSON.stringify((m as AIMessage).tool_calls ?? textOf(m.content)).slice(0, 200)}`;
            if (seen.has(key) || (m.id && prior.has(m.id))) continue;
            seen.add(key);
            if (AIMessage.isInstance(m) && !m.tool_calls?.length && textOf(m.content).trim()) {
              // Authoritative final answer (token streaming can be lossy across model fallbacks).
              // Safety, guaranteed by code: once a tool registered an emergency, the briefing opens with it.
              const text = textOf(m.content);
              yield { type: "final", text: emergencyLine && !/^\W*EMERGENCY/i.test(text) ? `${emergencyLine}\n\n${text}` : text };
            } else if (AIMessage.isInstance(m) && m.tool_calls?.length) {
              for (const call of m.tool_calls) {
                toolNames.set(call.id ?? "", call.name);
                yield { type: "tool_call", id: call.id ?? "", name: call.name, args: call.args };
              }
            } else if (ToolMessage.isInstance(m)) {
              const content = textOf(m.content);
              const failed = content.startsWith("ERROR") || m.status === "error";
              if (!failed) succeeded.add(m.name ?? toolNames.get(m.tool_call_id) ?? "tool");
              if (!failed && /"priority":\s*"emergency"/.test(content)) {
                const token = content.match(/"token":\s*"(#\d+)"/)?.[1] ?? "";
                const doctor = content.match(/"doctor":\s*"([^"]+)"/)?.[1] ?? "the doctor";
                emergencyLine = `**EMERGENCY — ${token ? `${token} ` : ""}needs to be seen now.** Alert ${doctor} or a nurse immediately; for chest pain, breathing trouble or stroke signs, call emergency services.`;
              }
              yield {
                type: "tool_result",
                id: m.tool_call_id,
                name: m.name ?? toolNames.get(m.tool_call_id) ?? "tool",
                content: content.length > 4000 ? `${content.slice(0, 4000)}…` : content,
                isError: failed,
              };
            }
          }
        }
      }
    };

    yield* pass(content);

    // Harness check after the turn: some events require an action, whatever the model decided.
    // If it skipped one (smaller fallback models sometimes answer without acting), nudge once.
    const missed = REQUIRED_ACTIONS.find((r) => r.when.test(message) && !r.need.some((n) => succeeded.has(n)));
    if (missed) {
      yield { type: "token", text: "" };
      yield* pass(`[HARNESS CHECK] ${missed.nudge}`);
    }
    yield { type: "done", threadId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    yield { type: "error", message: /\b429\b|quota|rate.?limit|RESOURCE_EXHAUSTED/i.test(message) ? `Model rate limit hit — try again in a minute. (${message.slice(0, 160)})` : message.slice(0, 1500) };
  }
}

/** Rehydrate a thread for the UI after reload. */
export async function threadState(threadId: string) {
  const agent = await getAgent();
  const snapshot = await (agent as unknown as { getState: (c: unknown) => Promise<{ values?: unknown }> }).getState({ configurable: { thread_id: threadId } });
  const values = (snapshot?.values ?? {}) as { messages?: BaseMessage[]; todos?: unknown; files?: Record<string, { content: unknown }> };
  const messages = (values.messages ?? []).flatMap((m) => {
    if (m.getType() === "human") return [{ role: "user", text: textOf(m.content).replace(/\s*<board_at_message_time>[\s\S]*$/, "") }];
    if (AIMessage.isInstance(m)) {
      const text = textOf(m.content);
      const tools = (m.tool_calls ?? []).map((c) => ({ id: c.id, name: c.name, args: c.args }));
      return text || tools.length ? [{ role: "assistant", text, tools }] : [];
    }
    if (ToolMessage.isInstance(m)) return [{ role: "tool", id: m.tool_call_id, name: m.name, text: textOf(m.content).slice(0, 4000) }];
    return [];
  });
  const files = Object.fromEntries(
    Object.entries(values.files ?? {})
      .filter(([p]) => !p.startsWith("/skills/"))
      .map(([p, f]) => [p, Array.isArray(f.content) ? f.content.join("\n") : String(f.content)]),
  );
  return { messages, todos: values.todos ?? [], files };
}
