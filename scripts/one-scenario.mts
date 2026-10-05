// Run one demo scenario through the real agent and print tools + briefing (dev helper).
// Usage: npx tsx --env-file=.env.local scripts/one-scenario.mts chest-pain
import { runAgentTurn } from "../src/lib/agent/run";
import { SCENARIOS } from "../src/lib/clinic/seed";
const s = SCENARIOS.find((x) => x.id === process.argv[2])!;
for await (const e of runAgentTurn(`one-${s.id}-${Date.now()}`, s.event)) {
  if (e.type === "tool_call") console.log("→", e.name, JSON.stringify(e.args).slice(0, 160));
  if (e.type === "tool_result") console.log("  ←", e.isError ? "ERR" : "ok", e.content.slice(0, 260).replace(/\s+/g, " "));
  if (e.type === "final") console.log("\nFINAL:\n" + e.text);
  if (e.type === "error") console.log("ERROR", e.message);
}
process.exit(0);
