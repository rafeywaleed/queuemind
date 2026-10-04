// The QueueMind deep agent: planning (todos), a virtual filesystem with read-only clinic
// playbooks (skills), custom clinic tools, and an analyst subagent. Conversation state is
// checkpointed to Supabase Postgres so a thread survives across serverless invocations.
import { createDeepAgent, type SubAgent } from "deepagents";
import { modelCallLimitMiddleware, todoListMiddleware } from "langchain";
import { MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { reasoningPool } from "../llm/models";
import { quotaAwarePoolMiddleware } from "../llm/pool";
import { analystTools, operationsTools } from "./tools";
import { systemPrompt } from "./prompt";
import { skillFiles } from "./skills";
import type { ClinicPolicy } from "../queue/types";

let checkpointerPromise: Promise<BaseCheckpointSaver> | null = null;

function checkpointer(): Promise<BaseCheckpointSaver> {
  checkpointerPromise ??= (async () => {
    const url = process.env.DATABASE_URL;
    if (!url) return new MemorySaver();
    const saver = PostgresSaver.fromConnString(url, { schema: "agent" });
    await saver.setup();
    return saver;
  })();
  return checkpointerPromise;
}

const opsAnalyst: SubAgent = {
  name: "ops-analyst",
  description:
    "Analyses the clinic's day from the board and event log: end-of-shift reports, bottlenecks, which doctor is overloaded, what-if comparisons. Read-only — it never changes the queue.",
  systemPrompt: `You are a clinic operations analyst. Use only numbers that appear in tool outputs.
Gather data with get_queue_board and recent_activity, use simulate_options for what-ifs.
Write the full report to /reports/ and return a 5-line summary to the caller.`,
  tools: analystTools,
  middleware: [quotaAwarePoolMiddleware()],
};

export async function buildAgent(clinic: ClinicPolicy) {
  return createDeepAgent({
    name: "queuemind",
    // Default model for the graph; the pool middleware picks the actual member per call.
    model: (await reasoningPool().find((m) => m.spec.provider !== "colab")!.resolve())!,
    // Per-turn budget: a turn can't drift toward the 300 s serverless limit or drain the free quota.
    middleware: [todoListMiddleware(), modelCallLimitMiddleware({ runLimit: 14, exitBehavior: "end" }), quotaAwarePoolMiddleware()],
    systemPrompt: systemPrompt(clinic),
    tools: operationsTools,
    subagents: [opsAnalyst],
    skills: ["/skills/"],
    permissions: [{ operations: ["write"], paths: ["/skills/**"], mode: "deny" }],
    checkpointer: await checkpointer(),
  });
}

/** Seed files merged into the thread's virtual filesystem on every run (idempotent). */
export function agentFiles() {
  return skillFiles();
}
