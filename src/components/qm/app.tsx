"use client";
// QueueMind shell: one live clinic, five ways to look at it.
import { useState } from "react";
import { BarChart3, ConciergeBell, FlaskConical, Gamepad2, HelpCircle, Loader2, MonitorPlay, Network, RotateCcw, Smartphone, Stethoscope } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatusPill } from "@/components/qm/status-pill";
import { FrontDeskView } from "@/components/views/front-desk";
import { DoctorView } from "@/components/views/doctor";
import { PatientView } from "@/components/views/patient";
import { TvView } from "@/components/views/tv";
import { ManagerView } from "@/components/views/manager";
import { LabView } from "@/components/views/lab";
import { HowItWorksView } from "@/components/views/how-it-works";
import { SimulationView } from "@/components/views/simulation";
import { LayaBanner } from "@/components/qm/laya-status";
import { cn } from "@/lib/utils";
import { clock } from "@/lib/client/format";
import { postJson, useClinic } from "@/lib/client/use-clinic";
import { useAgentSession } from "@/lib/client/use-agent";

type Persona = "sim" | "lab" | "how" | "desk" | "doctor" | "patient" | "tv" | "manager";

const PERSONAS: { id: Persona; label: string; who: string; icon: typeof ConciergeBell; group: "main" | "role" }[] = [
  { id: "sim", label: "Simulation", who: "The clinic as a game: make something happen and watch every step", icon: Gamepad2, group: "main" },
  { id: "lab", label: "Live Lab", who: "Make something happen, watch the harness route it, see the clinic change", icon: FlaskConical, group: "main" },
  { id: "how", label: "How it works", who: "The full agent harness: graph, specs, middleware, models, guardrails, tools", icon: Network, group: "main" },
  { id: "desk", label: "Front desk", who: "Amna, receptionist: runs the counter with the agent", icon: ConciergeBell, group: "role" },
  { id: "doctor", label: "Doctor", who: "Who's with me, who's next, one-tap delay & follow-up", icon: Stethoscope, group: "role" },
  { id: "patient", label: "Patient", who: "Their phone: place in line, honest time, approved SMS", icon: Smartphone, group: "role" },
  { id: "tv", label: "Waiting room", who: "Lobby screen: tokens only, no names", icon: MonitorPlay, group: "role" },
  { id: "manager", label: "Manager", who: "Shift metrics, audit trail, safety & model routing", icon: BarChart3, group: "role" },
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
  // Lab + Simulation: each event runs in a fresh thread so earlier patients never leak in.
  const eventAgent = useAgentSession(() => void data.refresh(), { ephemeral: true });
  const [persona, setPersona] = useState<Persona>(() => {
    const saved = readStorage(PERSONA_KEY) as Persona | null;
    return saved && PERSONAS.some((p) => p.id === saved) ? saved : "sim";
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
      eventAgent.reset();
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

          <nav className="order-3 flex w-full items-center gap-2 overflow-x-auto md:order-none md:w-auto">
            <div className="flex shrink-0 gap-1 rounded-xl bg-primary/10 p-1">
              {PERSONAS.filter((p) => p.group === "main").map((p) => (
                <NavButton key={p.id} active={persona === p.id} onClick={() => choose(p.id)} icon={p.icon} label={p.label} primary />
              ))}
            </div>
            <span className="shrink-0 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">View as</span>
            <div className="flex shrink-0 gap-1 rounded-xl bg-muted p-1">
              {PERSONAS.filter((p) => p.group === "role").map((p) => (
                <NavButton key={p.id} active={persona === p.id} onClick={() => choose(p.id)} icon={p.icon} label={p.label} />
              ))}
            </div>
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
        {active.group === "role" && (
          <div className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
            <active.icon className="size-4" />
            <span>
              Viewing as <b className="text-foreground">{active.label}</b> · {active.who}
            </span>
          </div>
        )}

        {persona !== "sim" && <LayaBanner status={data.status} onRefresh={data.refreshStatus} />}

        {!data.board ? (
          <div className="grid h-[60vh] place-items-center text-sm text-muted-foreground">
            {data.error ? <span className="text-qm-emergency">{data.error}</span> : <Loader2 className="size-5 animate-spin" />}
          </div>
        ) : persona === "sim" ? (
          <SimulationView data={data} agent={eventAgent} />
        ) : persona === "lab" ? (
          <LabView data={data} agent={eventAgent} />
        ) : persona === "how" ? (
          <HowItWorksView data={data} />
        ) : persona === "desk" ? (
          <FrontDeskView data={data} agent={agent} />
        ) : persona === "doctor" ? (
          <DoctorView data={data} doctorId={doctorId ?? data.board.doctors[0].id} onDoctor={setDoctorId} />
        ) : persona === "patient" ? (
          <PatientView data={data} visitId={patientVisit} onVisit={setPatientVisit} agent={eventAgent} />
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

function NavButton({ active, onClick, icon: Icon, label, primary }: { active: boolean; onClick: () => void; icon: typeof ConciergeBell; label: string; primary?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition",
        active ? (primary ? "bg-primary text-primary-foreground shadow-sm" : "bg-card text-foreground shadow-sm") : primary ? "text-primary hover:bg-primary/10" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="size-4" /> {label}
    </button>
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
    ["Start in the Simulation", "A 3-doctor clinic mid-shift: one consult running over, a likely no-show, patients slipping behind. Reset demo any time for a fresh shift."],
    ["Make something happen", "Ask the agent (doctor called away, chest-pain walk-in), send a patient text that Laya reads in milliseconds, or press a staff button. Patients walk on the floor; the flow line shows every step. Live Lab shows the full harness graph."],
    ["See it from every side", "Under 'View as': the front desk, the doctor, a patient's phone, the lobby TV and the manager all update live."],
    ["Humans stay in charge", "SMS wait in the outbox for approval. The agent can raise priority but never lower it. All times and fees come from tested code, not the model. 'How it works' shows the whole harness."],
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
