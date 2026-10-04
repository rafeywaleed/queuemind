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

export async function* runAgentTurn(threadId: string, message: string): AsyncGenerator<AgentEvent> {
  const agent = await getAgent();
  const config = { configurable: { thread_id: threadId }, streamMode: ["updates", "messages"] as const, recursionLimit: 80 };
  const toolNames = new Map<string, string>();
  try {
    // Attach the live board so the agent starts informed — one fewer model step per turn.
    const snapshot = JSON.stringify(await board());
    const content = `${message}\n\n<board_at_message_time>\n${snapshot}\n</board_at_message_time>`;
    const stream = await agent.stream({ messages: [{ role: "user", content }], files: agentFiles() } as never, config as never);
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
          if (AIMessage.isInstance(m) && !m.tool_calls?.length && textOf(m.content).trim()) {
            // Authoritative final answer (token streaming can be lossy across model fallbacks).
            yield { type: "final", text: textOf(m.content) };
          } else if (AIMessage.isInstance(m) && m.tool_calls?.length) {
            for (const call of m.tool_calls) {
              toolNames.set(call.id ?? "", call.name);
              yield { type: "tool_call", id: call.id ?? "", name: call.name, args: call.args };
            }
          } else if (ToolMessage.isInstance(m)) {
            const content = textOf(m.content);
            yield {
              type: "tool_result",
              id: m.tool_call_id,
              name: m.name ?? toolNames.get(m.tool_call_id) ?? "tool",
              content: content.length > 4000 ? `${content.slice(0, 4000)}…` : content,
              isError: content.startsWith("ERROR") || m.status === "error",
            };
          }
        }
      }
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
