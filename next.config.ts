import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Agent runtime packages are loaded by Node at runtime instead of bundled
  // (they have optional native/ws dependencies the bundler can't resolve).
  serverExternalPackages: ["deepagents", "langsmith", "@langchain/langgraph-checkpoint-postgres", "pg"],
};

export default nextConfig;
