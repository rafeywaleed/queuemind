"use client";
// Waiting-room display. Tokens only: no names, no symptoms, because the screen is public.
import { HeartPulse } from "lucide-react";
import { cn } from "@/lib/utils";
import { PoweredBy } from "@/components/qm/logo";
import { clock } from "@/lib/client/format";
import type { ClinicData } from "@/lib/client/use-clinic";

export function TvView({ data }: { data: ClinicData }) {
  const board = data.board!;
  const tz = board.clinic.timezone;
  const byId = new Map(board.visits.map((v) => [v.id, v]));
  const emergency = board.snapshot.doctors.some((d) => d.queue.some((q) => q.priority === "emergency") || (d.current && byId.get(d.current.visitId)?.priority === "emergency"));
  const notices = [
    `Follow-ups within ${board.clinic.freeFollowUpDays} days of your visit are free`,
    "Please keep your phone on: we text you if your time changes",
    "Booked patients more than 10 minutes late are seen in arrival order",
    "Emergencies are always seen first; thank you for your patience",
    "Ask the front desk if you need help with your token",
  ];

  return (
    <div className="dark overflow-hidden rounded-3xl bg-[oklch(0.15_0.02_230)] text-white shadow-2xl ring-1 ring-black/20">
      <div className="flex items-center justify-between border-b border-white/10 px-8 py-5">
        <div className="flex items-center gap-3">
          <HeartPulse className="size-7 text-[oklch(0.75_0.12_190)]" />
          <div>
            <div className="font-display text-3xl">{board.clinic.name}</div>
            <div className="flex items-center gap-3 text-sm text-white/50">
              Please wait for your token to be called <PoweredBy dark />
            </div>
          </div>
        </div>
        <div className="font-mono text-5xl font-semibold tabular">{clock(board.snapshot.computedAt, tz)}</div>
      </div>

      {emergency && (
        <div className="flex items-center justify-center gap-3 bg-[oklch(0.55_0.2_25)] px-8 py-3 text-lg font-semibold">
          <span className="size-3 animate-pulse rounded-full bg-white" /> A priority patient is being seen. Some waits may be longer. Thank you for understanding.
        </div>
      )}

      <div className="grid gap-px bg-white/10 md:grid-cols-3">
        {board.snapshot.doctors.map((d, i) => {
          const current = d.current ? byId.get(d.current.visitId) : null;
          const next = d.queue.filter((q) => q.state === "waiting").slice(0, 4);
          return (
            <div key={d.doctorId} className="bg-[oklch(0.15_0.02_230)] px-8 py-7">
              <div className="flex items-baseline justify-between">
                <div className="text-lg font-semibold">{d.name}</div>
                <div className="font-mono text-sm text-white/50">ROOM {i + 1}</div>
              </div>
              <div className="text-sm text-white/40">{d.specialty}</div>

              <div className="mt-6 text-xs font-semibold tracking-[0.2em] text-white/50 uppercase">Now serving</div>
              <div className={cn("font-mono text-[96px] leading-none font-bold tabular", current ? "text-[oklch(0.8_0.12_190)]" : "text-white/20")}>
                {current?.token ? String(current.token).padStart(2, "0") : "--"}
              </div>

              {d.status === "off_duty" ? (
                <div className="mt-4 rounded-xl bg-white/10 px-4 py-3 text-base">Not seeing patients. The front desk will guide you.</div>
              ) : d.delayMin > 0 ? (
                <div className="mt-4 rounded-xl bg-[oklch(0.75_0.14_70)]/20 px-4 py-3 text-base text-[oklch(0.85_0.12_75)]">Doctor back at about {clock(d.freeAt, tz)}. Sorry for the wait.</div>
              ) : d.current && d.current.overrunMin >= 10 ? (
                <div className="mt-4 rounded-xl bg-white/10 px-4 py-3 text-base text-white/70">Running a little behind</div>
              ) : null}

              <div className="mt-6 text-xs font-semibold tracking-[0.2em] text-white/50 uppercase">Next</div>
              <div className="mt-2 space-y-2">
                {next.length === 0 && <div className="text-white/30">—</div>}
                {next.map((q) => (
                  <div key={q.visitId} className="flex items-center justify-between rounded-xl bg-white/[0.06] px-4 py-2.5">
                    <span className={cn("font-mono text-3xl font-bold", q.priority === "emergency" && "text-[oklch(0.7_0.2_25)]")}>{q.token ? String(q.token).padStart(2, "0") : "--"}</span>
                    <span className="font-mono text-lg text-white/60">~{clock(q.etaStart, tz)}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="overflow-hidden border-t border-white/10 bg-black/20 py-3">
        <div className="qm-ticker flex w-max gap-16 text-base whitespace-nowrap text-white/60">
          {[...notices, ...notices].map((n, i) => (
            <span key={i}>• {n}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
