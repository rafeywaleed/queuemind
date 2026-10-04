"use client";
// QueueMind shell: one live clinic, five ways to look at it.
import { useState } from "react";
import { BarChart3, ConciergeBell, HelpCircle, Loader2, MonitorPlay, RotateCcw, Smartphone, Stethoscope } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatusPill } from "@/components/qm/status-pill";
import { FrontDeskView } from "@/components/views/front-desk";
import { DoctorView } from "@/components/views/doctor";
import { PatientView } from "@/components/views/patient";
import { TvView } from "@/components/views/tv";
import { ManagerView } from "@/components/views/manager";
import { cn } from "@/lib/utils";
import { clock } from "@/lib/client/format";
import { postJson, useClinic } from "@/lib/client/use-clinic";
import { useAgentSession } from "@/lib/client/use-agent";

type Persona = "desk" | "doctor" | "patient" | "tv" | "manager";

const PERSONAS: { id: Persona; label: string; who: string; icon: typeof ConciergeBell }[] = [
  { id: "desk", label: "Front desk", who: "Amna, receptionist: runs the counter with the agent", icon: ConciergeBell },
  { id: "doctor", label: "Doctor", who: "Who's with me, who's next, one-tap delay & follow-up", icon: Stethoscope },
  { id: "patient", label: "Patient", who: "Their phone: place in line, honest time, approved SMS", icon: Smartphone },
  { id: "tv", label: "Waiting room", who: "Lobby screen: tokens only, no names", icon: MonitorPlay },
  { id: "manager", label: "Manager", who: "Shift metrics, audit trail, safety & model routing", icon: BarChart3 },
];

const PERSONA_KEY = "queuemind.persona";
const INTRO_KEY = "queuemind.intro-seen";

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function QueueMindApp() {
  const data = useClinic();
  const agent = useAgentSession(() => void data.refresh());
  const [persona, setPersona] = useState<Persona>(() => {
    const saved = readStorage(PERSONA_KEY) as Persona | null;
    return saved && PERSONAS.some((p) => p.id === saved) ? saved : "desk";
  });
  const [doctorId, setDoctorId] = useState<string | null>(null);
  const [patientVisit, setPatientVisit] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [intro, setIntro] = useState(() => !readStorage(INTRO_KEY));

  const choose = (p: Persona) => {
    setPersona(p);
    try {
      localStorage.setItem(PERSONA_KEY, p);
    } catch {
      // storage unavailable
    }
  };

  const closeIntro = () => {
    setIntro(false);
    try {
      localStorage.setItem(INTRO_KEY, "1");
    } catch {
      // storage unavailable
    }
  };

  const reset = async () => {
    setResetting(true);
    try {
      await postJson("/api/demo", {});
      agent.reset();
      await data.refresh();
      toast.success("Fresh afternoon shift loaded");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setResetting(false);
    }
  };

  const active = PERSONAS.find((p) => p.id === persona)!;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-[1680px] flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5 md:px-6">
          <div className="flex items-center gap-2.5">
            <Logo />
            <div className="leading-tight">
              <div className="font-display text-2xl leading-none">
                Queue<span className="italic text-primary">Mind</span>
              </div>
              <div className="text-[11px] text-muted-foreground">{data.board?.clinic.name ?? "…"}</div>
            </div>
          </div>

          <nav className="order-3 flex w-full gap-1 overflow-x-auto rounded-xl bg-muted p-1 md:order-none md:w-auto">
            {PERSONAS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => choose(p.id)}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition",
                  persona === p.id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <p.icon className="size-4" /> {p.label}
              </button>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <span className="hidden items-center gap-1.5 text-xs text-muted-foreground lg:flex">
              <span className={cn("size-2 rounded-full", data.live ? "bg-qm-good" : "bg-muted-foreground/50")} />
              {data.live ? "Live" : "Polling"} · <span className="font-mono">{clock(data.board?.snapshot.computedAt, data.board?.clinic.timezone)}</span>
            </span>
            <StatusPill status={data.status} />
            <Button variant="ghost" size="icon-sm" onClick={() => setIntro(true)} aria-label="How to demo">
              <HelpCircle />
            </Button>
            <Button variant="outline" size="sm" onClick={reset} disabled={resetting}>
              {resetting ? <Loader2 className="animate-spin" /> : <RotateCcw />} Reset demo
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1680px] px-4 py-4 md:px-6">
        <div className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
          <active.icon className="size-4" />
          <span>
            Viewing as <b className="text-foreground">{active.label}</b> · {active.who}
          </span>
        </div>

        {!data.board ? (
          <div className="grid h-[60vh] place-items-center text-sm text-muted-foreground">
            {data.error ? <span className="text-qm-emergency">{data.error}</span> : <Loader2 className="size-5 animate-spin" />}
          </div>
        ) : persona === "desk" ? (
          <FrontDeskView data={data} agent={agent} />
        ) : persona === "doctor" ? (
          <DoctorView data={data} doctorId={doctorId ?? data.board.doctors[0].id} onDoctor={setDoctorId} />
        ) : persona === "patient" ? (
          <PatientView data={data} visitId={patientVisit} onVisit={setPatientVisit} />
        ) : persona === "tv" ? (
          <TvView data={data} />
        ) : (
          <ManagerView data={data} />
        )}
      </main>

      <IntroDialog open={intro} onClose={closeIntro} />
    </div>
  );
}

function Logo() {
  return (
    <svg viewBox="0 0 32 32" className="size-9" aria-hidden>
      <rect width="32" height="32" rx="9" className="fill-primary" />
      <rect x="7" y="9" width="11" height="3.2" rx="1.6" fill="white" opacity="0.55" />
      <rect x="7" y="14.4" width="15" height="3.2" rx="1.6" fill="white" opacity="0.8" />
      <rect x="7" y="19.8" width="18" height="3.2" rx="1.6" fill="white" />
      <circle cx="23.5" cy="10.6" r="2.4" fill="white" />
    </svg>
  );
}

function IntroDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const steps = [
    ["The clinic is live", "A 3-doctor clinic mid-afternoon: a consult running over, a likely no-show, patients slipping behind. Reset demo any time for a fresh shift."],
    ["Throw something at it", "In Front desk, click an event (late doctor, chest-pain walk-in, doctor leaves). The agent plans, opens the right playbook, simulates options, acts, and drafts patient SMS."],
    ["Watch it everywhere", "Switch views: the Doctor's screen, a Patient's phone, the waiting-room TV and the Manager's audit trail all update in real time."],
    ["Humans stay in charge", "SMS wait in the Outbox for approval. The agent can raise a patient's priority but never lower it. All times and fees come from tested code, not the model."],
  ];
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display text-3xl font-normal">
            Queue<span className="italic text-primary">Mind</span>
          </DialogTitle>
          <DialogDescription>An AI operations agent for the clinic waiting room: delays, walk-ins, emergencies, no-shows and patient messages, replanned live.</DialogDescription>
        </DialogHeader>
        <ol className="space-y-3">
          {steps.map(([title, body], i) => (
            <li key={title} className="flex gap-3">
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary font-mono text-xs font-bold text-primary-foreground">{i + 1}</span>
              <div>
                <div className="text-sm font-semibold">{title}</div>
                <div className="text-sm text-muted-foreground">{body}</div>
              </div>
            </li>
          ))}
        </ol>
        <Button onClick={onClose} className="mt-2 w-full">
          Open the clinic
        </Button>
      </DialogContent>
    </Dialog>
  );
}
