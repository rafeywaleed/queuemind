"use client";
// Laya runs on a Colab notebook. Colab can't be started by an API, so the app does the next best
// thing: one click opens the notebook, then the app watches for Laya's heartbeat and says so.
import { useEffect, useState } from "react";
import { Gauge, Loader2, Rocket, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { RouterStatus } from "@/lib/client/types";

export const COLAB_URL =
  process.env.NEXT_PUBLIC_COLAB_URL ?? "https://colab.research.google.com/github/rafeywaleed/queuemind/blob/master/colab/queuemind_selfhosted.ipynb";

const WAIT_KEY = "queuemind.laya-wait";

function readWait(): number | null {
  try {
    const v = Number(sessionStorage.getItem(WAIT_KEY));
    return v && Date.now() - v < 10 * 60_000 ? v : null;
  } catch {
    return null;
  }
}

/** Shared "starting Laya" state: opens Colab, polls status every 5 s until the heartbeat arrives. */
export function useLayaStarter(status: RouterStatus | null, refresh: () => Promise<void>) {
  const online = !!status?.decision?.online;
  const [since, setSince] = useState<number | null>(() => readWait());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!since || online) return;
    const poll = setInterval(() => void refresh(), 5_000);
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [since, online, refresh]);

  useEffect(() => {
    if (!since || !online) return;
    const done = setTimeout(() => {
      toast.success("Laya is online: patient texts and triage now use the decision model");
      setSince(null);
      try {
        sessionStorage.removeItem(WAIT_KEY);
      } catch {
        // storage unavailable
      }
    }, 0);
    return () => clearTimeout(done);
  }, [since, online]);

  const start = () => {
    window.open(COLAB_URL, "_blank", "noopener");
    const t = Date.now();
    setSince(t);
    setNow(t);
    try {
      sessionStorage.setItem(WAIT_KEY, String(t));
    } catch {
      // storage unavailable
    }
  };

  const elapsed = since ? Math.max(0, Math.round((now - since) / 1000)) : 0;
  return { online, waiting: !!since && !online, elapsed, start };
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export function LayaChip({ status, onRefresh }: { status: RouterStatus | null; onRefresh: () => Promise<void> }) {
  const { online, waiting, elapsed, start } = useLayaStarter(status, onRefresh);
  if (!online && status?.decision?.waking) {
    return (
      <span className="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[12.5px]">
        <Loader2 className="size-4 animate-spin text-primary" /> Waking Laya on Hugging Face…
        <span className="text-muted-foreground">usually 1–3 min; the LLM decides meanwhile</span>
      </span>
    );
  }
  if (online) {
    return (
      <span className="inline-flex items-center gap-2 rounded-full border border-qm-good/40 bg-qm-good/10 px-3 py-1.5 text-[12.5px] font-medium text-qm-good">
        <Gauge className="size-4" /> Laya decision model online
      </span>
    );
  }
  if (waiting) {
    return (
      <span className="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[12.5px]">
        <Loader2 className="size-4 animate-spin text-primary" /> Waiting for Laya on Colab… <b className="font-mono">{fmt(elapsed)}</b>
        <span className="text-muted-foreground">usually 1–3 min</span>
      </span>
    );
  }
  return (
    <button type="button" onClick={start} className="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[12.5px] font-medium transition-colors duration-150 hover:border-primary">
      <Rocket className="size-4 text-primary" /> Start Laya on Colab
      <span className="font-normal text-muted-foreground">offline: the LLM decides for now</span>
    </button>
  );
}

/** App-wide hint while Laya is offline. Dismissible for the session. */
export function LayaBanner({ status, onRefresh }: { status: RouterStatus | null; onRefresh: () => Promise<void> }) {
  const { online, waiting, elapsed, start } = useLayaStarter(status, onRefresh);
  const [hidden, setHidden] = useState(() => {
    try {
      return sessionStorage.getItem("queuemind.laya-banner") === "hidden";
    } catch {
      return false;
    }
  });
  if (!status || online || hidden) return null;
  if (status.decision?.waking) {
    return (
      <div className="mb-3 flex items-center gap-3 rounded-2xl border border-primary/30 bg-accent/40 px-4 py-2.5 text-sm">
        <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
        <span className="flex-1">
          <b>Waking Laya</b>, the decision model, on Hugging Face (usually 1–3 min). Everything works meanwhile; the LLM decides until it&apos;s up.
        </span>
      </div>
    );
  }
  return (
    <div className={cn("mb-3 flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-2.5 text-sm", waiting ? "border-primary/40 bg-accent/40" : "bg-card")}>
      <Gauge className="size-4 shrink-0 text-qm-appointment" />
      <span className="flex-1">
        {waiting ? (
          <>
            Starting Laya on Colab… <b className="font-mono">{fmt(elapsed)}</b>. In the Colab tab: <b>Runtime → Run all</b>. It usually takes 1–3 minutes; this page updates by itself.
          </>
        ) : (
          <>
            <b>Laya</b>, the decision model for triage and patient texts, is offline. Everything still works; the LLM decides instead.
          </>
        )}
      </span>
      {!waiting && (
        <button type="button" onClick={start} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground transition-transform duration-150 active:scale-[0.97]">
          <Rocket className="size-3.5" /> Start Laya on Colab
        </button>
      )}
      <button
        type="button"
        onClick={() => {
          setHidden(true);
          try {
            sessionStorage.setItem("queuemind.laya-banner", "hidden");
          } catch {
            // storage unavailable
          }
        }}
        className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted"
        aria-label="Dismiss"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
