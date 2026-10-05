// QueueMind mark: a queue that gets shorter, and the person being called.
import { cn } from "@/lib/utils";

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-9", className)} aria-hidden>
      <rect width="32" height="32" rx="9" className="fill-primary" />
      <rect x="7" y="9" width="11" height="3.2" rx="1.6" fill="white" opacity="0.55" />
      <rect x="7" y="14.4" width="15" height="3.2" rx="1.6" fill="white" opacity="0.8" />
      <rect x="7" y="19.8" width="18" height="3.2" rx="1.6" fill="white" />
      <circle cx="23.5" cy="10.6" r="2.4" fill="white" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("font-display leading-none", className)}>
      Queue<span className="italic text-primary">Mind</span>
    </span>
  );
}

/** Small "via QueueMind" credit for patient- and lobby-facing screens. */
export function PoweredBy({ className, dark }: { className?: string; dark?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[10px]", dark ? "text-white/50" : "text-muted-foreground", className)}>
      <LogoMark className="size-3.5" /> via QueueMind
    </span>
  );
}
