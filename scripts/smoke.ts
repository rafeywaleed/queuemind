// End-to-end smoke test without the UI: reset the demo clinic, show the board, run one agent turn.
// Usage: npx tsx --env-file=.env.local scripts/smoke.ts [scenario-id | "free text message"]
import { resetDemo, SCENARIOS } from "../src/lib/clinic/seed";
import { board } from "../src/lib/clinic/actions";
import { runAgentTurn } from "../src/lib/agent/run";

async function main() {
  const arg = process.argv[2] ?? "doctor-late";
  const message = SCENARIOS.find((s) => s.id === arg)?.event ?? arg;
  if (!process.argv.includes("--no-reset")) {
    console.log("reset:", await resetDemo());
  }
  console.log(JSON.stringify(await board(), null, 1));
  console.log(`\n>>> ${message}\n`);
  const threadId = `smoke-${Date.now()}`;
  for await (const e of runAgentTurn(threadId, message)) {
    if (e.type === "token") process.stdout.write(e.text);
    else if (e.type === "tool_call") console.log(`\n[tool] ${e.name} ${JSON.stringify(e.args)}`);
    else if (e.type === "tool_result") console.log(`[result:${e.name}] ${e.content.slice(0, 600)}`);
    else if (e.type === "todos") console.log(`[plan] ${e.todos.map((t) => `${t.status === "completed" ? "✓" : "·"} ${t.content}`).join(" | ")}`);
    else console.log(`\n[${e.type}]`, JSON.stringify(e));
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
