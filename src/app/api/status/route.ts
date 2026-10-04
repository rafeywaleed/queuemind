// Model router health: is self-hosted Llama (Colab) online, which providers are serving, latency.
import { routerStatus } from "@/lib/llm/router";
import { poolStatus } from "@/lib/llm/pool";
import { fail, json } from "@/lib/http";

export const runtime = "nodejs";

export async function GET() {
  try {
    const [router, pool] = await Promise.all([routerStatus(), poolStatus()]);
    return json({ ...router, reasoningPool: pool });
  } catch (err) {
    return fail(err);
  }
}
