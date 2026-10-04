import { NextResponse } from "next/server";
import { ClinicError } from "./clinic/actions";

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return json({ error: message }, err instanceof ClinicError ? 400 : 500);
}

// Simple per-instance limiter so a public demo can't burn the free model quota in one go.
const hits = new Map<string, number[]>();
export function rateLimited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
  return recent.length > max;
}

export function clientIp(req: Request) {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
}
