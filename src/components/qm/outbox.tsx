"use client";
// Human-in-the-loop outbox: every patient SMS the agent drafts waits here for a person.
import { useState } from "react";
import { Check, Pencil, Send, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ago, LANGUAGE_LABEL } from "@/lib/client/format";
import { postJson } from "@/lib/client/use-clinic";
import type { Board, Notification } from "@/lib/client/types";

const KIND_LABEL: Record<string, string> = {
  delay: "Delay notice",
  turn_soon: "Come in soon",
  follow_up_reminder: "Follow-up reminder",
  cancellation: "Cancellation",
  no_show_check: "Are you on your way?",
  reassigned: "Doctor changed",
  custom: "Message",
};

export function Outbox({ notifications, board, onChange, compact }: { notifications: Notification[]; board: Board | null; onChange: () => void; compact?: boolean }) {
  const pending = notifications.filter((n) => n.status === "pending_approval");
  const sent = notifications.filter((n) => n.status === "sent").slice(0, compact ? 3 : 12);

  const approveAll = async () => {
    await Promise.all(pending.map((n) => postJson("/api/notifications", { id: n.id, decision: "sent" })));
    toast.success(`${pending.length} messages sent`);
    onChange();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold">Awaiting approval</div>
          <div className="text-xs text-muted-foreground">Drafted by the agent. Nothing reaches a patient until you approve it.</div>
        </div>
        {pending.length > 1 && (
          <Button size="sm" onClick={approveAll}>
            <Send /> Send all {pending.length}
          </Button>
        )}
      </div>
      {pending.length === 0 && <div className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">No drafts waiting.</div>}
      <div className="space-y-2">
        {pending.map((n) => (
          <DraftCard key={n.id} n={n} board={board} onChange={onChange} />
        ))}
      </div>
      {sent.length > 0 && (
        <div className="space-y-2">
          <div className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Recently sent</div>
          {sent.map((n) => (
            <div key={n.id} className="rounded-lg border bg-muted/30 px-3 py-2 text-xs">
              <div className="mb-0.5 flex justify-between text-muted-foreground">
                <span>
                  {n.patients?.name} · {KIND_LABEL[n.kind] ?? n.kind}
                </span>
                <span>{n.decided_at ? ago(n.decided_at) : ""}</span>
              </div>
              <div className="line-clamp-2">{n.body}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DraftCard({ n, board, onChange }: { n: Notification; board: Board | null; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(n.body);
  const [busy, setBusy] = useState(false);
  const visit = board?.visits.find((v) => v.id === n.visit_id);

  const decide = async (decision: "sent" | "rejected") => {
    setBusy(true);
    try {
      await postJson("/api/notifications", { id: n.id, decision, body: editing ? body : undefined });
      toast.success(decision === "sent" ? `Sent to ${n.patients?.name}` : "Draft rejected");
      onChange();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="qm-in rounded-xl border bg-card p-3 shadow-xs">
      <div className="mb-1.5 flex items-center gap-2 text-xs">
        <span className="font-semibold">{n.patients?.name ?? "Patient"}</span>
        {visit?.token && <span className="font-mono text-muted-foreground">#{visit.token}</span>}
        <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-medium text-accent-foreground">{KIND_LABEL[n.kind] ?? n.kind}</span>
        <span className="ml-auto text-[10px] text-muted-foreground">
          {LANGUAGE_LABEL[visit?.patientLanguage ?? ""] ?? ""} · by {n.drafted_by}
        </span>
      </div>
      {editing ? (
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} className="w-full rounded-lg border bg-background p-2 text-sm outline-none focus:ring-2 focus:ring-ring/40" />
      ) : (
        <p className="rounded-lg bg-muted/50 px-2.5 py-2 text-sm leading-snug">{n.body}</p>
      )}
      <div className="mt-2 flex items-center gap-1.5">
        <span className="font-mono text-[10px] text-muted-foreground">{n.patients?.phone}</span>
        <div className="ml-auto flex gap-1.5">
          <Button variant="ghost" size="xs" onClick={() => setEditing((e) => !e)} disabled={busy}>
            <Pencil /> {editing ? "Preview" : "Edit"}
          </Button>
          <Button variant="ghost" size="xs" onClick={() => decide("rejected")} disabled={busy} className={cn("text-muted-foreground")}>
            <X /> Reject
          </Button>
          <Button size="xs" onClick={() => decide("sent")} disabled={busy}>
            <Check /> Approve & send
          </Button>
        </div>
      </div>
    </div>
  );
}
