"use client";
// What a patient sees on their phone: their place in line, an honest time, and the SMS the
// clinic actually sent them (only approved messages, never drafts).
import { useEffect, useMemo, useRef, useState } from "react";
import { BellRing, Clock3, Gauge, Lock, MapPin, MessageSquare, Send, ShieldCheck, Signal, Wifi } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { clock, KIND_LABEL, LANGUAGE_LABEL, minsBetween } from "@/lib/client/format";
import { postJson, type ClinicData } from "@/lib/client/use-clinic";
import { PoweredBy } from "@/components/qm/logo";
import type { AgentSession } from "@/lib/client/use-agent";
import type { BoardVisit, PatientMessageResult } from "@/lib/client/types";

export function PatientView({ data, visitId, onVisit, agent }: { data: ClinicData; visitId: string | null; onVisit: (id: string) => void; agent: AgentSession }) {
  const board = data.board!;
  const tz = board.clinic.timezone;
  const choices = useMemo(
    () =>
      board.visits
        .filter((v) => ["waiting", "scheduled", "in_consult"].includes(v.status))
        .sort((a, b) => (a.token ?? 999) - (b.token ?? 999)),
    [board.visits],
  );
  const visit = choices.find((v) => v.id === visitId) ?? choices.find((v) => v.status === "waiting") ?? choices[0];
  const planned = board.snapshot.doctors.flatMap((d) => d.queue.map((q) => ({ q, d }))).find((x) => x.q.visitId === visit?.id);
  const doctor = board.doctors.find((d) => d.id === visit?.doctorId);
  const doctorPlan = board.snapshot.doctors.find((d) => d.doctorId === visit?.doctorId);
  const messages = data.notifications.filter((n) => n.patient_id === visit?.patientId && n.status === "sent").sort((a, b) => a.created_at.localeCompare(b.created_at));
  const drafts = data.notifications.filter((n) => n.patient_id === visit?.patientId && n.status === "pending_approval").length;
  const inbound = data.patientMessages.filter((m) => m.patient_id === visit?.patientId);
  const thread = [
    ...messages.map((m) => ({ id: m.id, from: "clinic" as const, body: m.body, at: m.decided_at ?? m.created_at, note: m.drafted_by === "template (auto)" ? "instant reply" : null })),
    ...inbound.map((m) => ({ id: m.id, from: "patient" as const, body: m.body, at: m.created_at, note: m.decided_by })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const [draft, setDraft] = useState("");
  // Keep the newest message in view, like a real messaging app.
  const scroller = useRef<HTMLDivElement>(null);
  const lastMessage = thread[thread.length - 1]?.id;
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [lastMessage, visitId]);
  const [sending, setSending] = useState(false);
  const sendText = async (text: string) => {
    if (!visit || !text.trim()) return;
    setSending(true);
    try {
      const r = await postJson<PatientMessageResult>("/api/patient-messages", { visit: visit.token ? `#${visit.token}` : visit.id, text });
      toast[r.handoff ? "info" : "success"](`${r.decidedBy}: ${r.outcome}`);
      if (r.handoff && r.agentPrompt) void agent.send(r.agentPrompt);
      setDraft("");
      void data.refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  if (!visit) return <div className="text-sm text-muted-foreground">No active patients.</div>;

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_400px_1fr]">
      {/* Patient picker */}
      <div className="space-y-3 lg:pt-6">
        <div className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">View as patient</div>
        <div className="max-h-[560px] space-y-1 overflow-y-auto pr-1">
          {choices.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => onVisit(v.id)}
              className={cn("flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm transition", v.id === visit.id ? "border-primary bg-accent" : "bg-card hover:bg-muted")}
            >
              <span className="font-mono text-xs font-bold">#{v.token ?? "—"}</span>
              <span className="flex-1 truncate">{v.patientName}</span>
              <span className="text-[10px] text-muted-foreground">{v.status === "scheduled" ? "booked" : v.status === "in_consult" ? "with doctor" : "waiting"}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Phone */}
      <div className="mx-auto w-[360px]">
        <div className="relative rounded-[48px] border-[10px] border-foreground bg-foreground shadow-2xl">
          <div className="absolute top-2 left-1/2 z-10 h-6 w-28 -translate-x-1/2 rounded-full bg-foreground" />
          <div className="flex h-[700px] flex-col overflow-hidden rounded-[38px] bg-background">
            <div className="flex items-center justify-between px-7 pt-3 pb-1 text-[11px] font-semibold">
              <span>{clock(board.snapshot.computedAt, tz)}</span>
              <span className="flex items-center gap-1">
                <Signal className="size-3" /> <Wifi className="size-3" />
              </span>
            </div>
            <div ref={scroller} className="flex-1 space-y-3 overflow-y-auto px-4 pt-4 pb-4">
              <div className="text-center">
                <div className="text-[11px] font-medium text-muted-foreground">{board.clinic.name}</div>
                <PoweredBy className="mt-0.5" />
                <div className="text-xs text-muted-foreground">{LANGUAGE_LABEL[visit.patientLanguage] ?? visit.patientLanguage}</div>
              </div>
              <TokenCard visit={visit} planned={planned?.q} doctorName={doctor?.name ?? ""} room={board.doctors.findIndex((d) => d.id === doctor?.id) + 1} tz={tz} delayMin={doctorPlan?.delayMin ?? 0} now={board.snapshot.computedAt} />

              <div className="pt-2">
                <div className="mb-2 flex items-center gap-1.5 px-1 text-[11px] font-semibold text-muted-foreground">
                  <MessageSquare className="size-3.5" /> Messages with the clinic
                </div>
                <div className="space-y-2">
                  {thread.length === 0 && <div className="rounded-2xl bg-muted px-3 py-3 text-center text-xs text-muted-foreground">No messages yet. You&apos;ll get an SMS if your time changes. You can text the clinic below.</div>}
                  {thread.map((m) => (
                    <div key={m.id} className={cn("qm-in max-w-[88%] px-3 py-2 text-[13px] leading-snug", m.from === "patient" ? "ml-auto rounded-2xl rounded-br-md bg-primary text-primary-foreground" : "rounded-2xl rounded-bl-md bg-muted")}>
                      {m.body}
                      <div className={cn("mt-1 flex items-center justify-end gap-1 text-[10px]", m.from === "patient" ? "text-primary-foreground/75" : "text-muted-foreground")}>
                        {m.note && m.from === "patient" && <Gauge className="size-3" />}
                        {m.note && <span className="truncate">{m.note} ·</span>}
                        {clock(m.at, tz)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="border-t px-3 pt-2 pb-1">
              <div className="mb-1.5 flex gap-1 overflow-x-auto">
                {["On my way", "Running 15 min late", "How long is the wait?", "Please cancel"].map((q) => (
                  <button key={q} type="button" disabled={sending} onClick={() => void sendText(q)} className="shrink-0 rounded-full border px-2 py-0.5 text-[11px] transition-colors duration-150 hover:border-primary disabled:opacity-40">
                    {q}
                  </button>
                ))}
              </div>
              <form
                className="flex items-center gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  void sendText(draft);
                }}
              >
                <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Text the clinic…" className="min-w-0 flex-1 rounded-full border bg-background px-3 py-1.5 text-[13px] outline-none focus:ring-2 focus:ring-ring/40" />
                <button type="submit" disabled={sending || !draft.trim()} className="grid size-8 place-items-center rounded-full bg-primary text-primary-foreground disabled:opacity-40" aria-label="Send">
                  <Send className="size-3.5" />
                </button>
              </form>
            </div>
            <div className="mx-auto mb-2 h-1 w-28 rounded-full bg-foreground/80" />
          </div>
        </div>
      </div>

      {/* Explainer */}
      <div className="space-y-3 lg:pt-6">
        <div className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">Why this matters</div>
        <Explainer icon={Clock3} title="An honest time, not a guess">
          The time comes from the queue engine and updates live when a doctor is delayed or a consult runs over.
        </Explainer>
        <Explainer icon={BellRing} title="Told before they wait">
          Patients who haven&apos;t arrived get a delay SMS so they can come later instead of sitting in the room.
        </Explainer>
        <Explainer icon={ShieldCheck} title="Humans approve what the AI writes">
          {drafts > 0 ? `${drafts} draft${drafts > 1 ? "s" : ""} for this patient ${drafts > 1 ? "are" : "is"} waiting for front-desk approval and not shown here yet.` : "Anything the AI writes waits for a staff member. Only factual replies (times straight from the queue engine) go out instantly."}
        </Explainer>
        <Explainer icon={Lock} title="Private by design">
          Patients see only their own visit. The waiting-room screen shows tokens, never names or symptoms.
        </Explainer>
      </div>
    </div>
  );
}

function TokenCard({ visit, planned, doctorName, room, tz, delayMin, now }: { now: string; visit: BoardVisit; planned?: { position: number; etaStart: string; waitMin: number; projectedDelayMin: number | null; state: string }; doctorName: string; room: number; tz: string; delayMin: number }) {
  if (visit.status === "in_consult") {
    return (
      <div className="rounded-3xl bg-qm-consult p-5 text-white">
        <div className="text-xs opacity-80">Token</div>
        <div className="font-mono text-5xl font-bold">#{visit.token}</div>
        <div className="mt-3 text-lg font-semibold">You&apos;re with {doctorName}</div>
        <div className="text-sm opacity-80">Room {room}</div>
      </div>
    );
  }
  const behind = planned?.projectedDelayMin ?? 0;
  const notHere = visit.status === "scheduled";
  return (
    <div className={cn("rounded-3xl p-5", behind >= 15 ? "bg-qm-urgent/15" : "bg-accent")}>
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs text-muted-foreground">Your token</div>
          <div className="font-mono text-5xl font-bold">#{visit.token ?? "—"}</div>
        </div>
        <span className="rounded-full bg-background px-2.5 py-1 text-[11px] font-semibold">{KIND_LABEL[visit.kind]}</span>
      </div>
      {planned ? (
        <>
          <div className="mt-4 text-sm text-muted-foreground">{notHere ? "Expected start" : "You'll be called around"}</div>
          <div className="font-display text-5xl leading-none">{clock(planned.etaStart, tz)}</div>
          <div className="mt-1 text-sm">
            {notHere ? (
              <>
                Booked for {clock(visit.scheduledAt, tz)}
                {behind > 0 && <b className="text-qm-urgent"> · running {behind} min late</b>}
              </>
            ) : (
              <>
                <b>{planned.position === 1 ? "You're next" : `${planned.position - 1} ahead of you`}</b> · about {planned.waitMin} min
              </>
            )}
          </div>
          {!notHere && (
            <div className="mt-3 flex gap-1">
              {Array.from({ length: Math.min(planned.position, 8) }).map((_, i) => (
                <div key={i} className={cn("h-1.5 flex-1 rounded-full", i === planned.position - 1 ? "bg-primary" : "bg-foreground/15")} />
              ))}
            </div>
          )}
          <div className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground">
            <MapPin className="size-3.5" /> {doctorName} · Room {room}
          </div>
          {delayMin > 0 && <div className="mt-3 rounded-xl bg-background px-3 py-2 text-xs">Your doctor stepped out and is back in ~{delayMin} min. We&apos;re sorry for the wait.</div>}
          {notHere && behind >= 15 && <div className="mt-3 rounded-xl bg-background px-3 py-2 text-xs">No need to rush: you can arrive about {behind} min later than booked.</div>}
        </>
      ) : (
        <div className="mt-4 text-sm text-muted-foreground">
          {visit.status === "scheduled" && visit.scheduledAt && minsBetween(visit.scheduledAt, now) > 0 ? "We missed you at your booked time. Please call the clinic to rebook." : "Your visit is being arranged."}
        </div>
      )}
    </div>
  );
}

function Explainer({ icon: Icon, title, children }: { icon: typeof Clock3; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 rounded-2xl border bg-card p-3">
      <Icon className="mt-0.5 size-4 shrink-0 text-primary" />
      <div>
        <div className="text-sm font-semibold">{title}</div>
        <div className="text-xs text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}
