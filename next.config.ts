import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The agent stack (deepagents, langchain, langsmith) is ESM-only and is bundled into the route:
  // shipping it as traced external files broke on Vercel (a missing package.json made Node load ESM
  // as CommonJS). Only `pg`, plain CommonJS with an optional native addon, stays external.
  serverExternalPackages: ["pg"],
};

export default nextConfig;
