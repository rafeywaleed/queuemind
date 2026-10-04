"use client";
// Staff actions on a single visit (no AI involved — these go straight to the service layer as "staff").
import { MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { postJson } from "@/lib/client/use-clinic";
import type { Board, BoardVisit } from "@/lib/client/types";

export async function staffAction(body: Record<string, unknown>, onDone: () => void, success: string) {
  try {
    const res = await postJson<{ impact?: string[] }>("/api/actions", body);
    const moved = res.impact?.length ? ` · ${res.impact.length} patient(s) affected` : "";
    toast.success(`${success}${moved}`);
    onDone();
  } catch (err) {
    toast.error((err as Error).message);
  }
}

export function VisitActions({ visit, board, onDone }: { visit: BoardVisit; board: Board; onDone: () => void }) {
  const others = board.doctors.filter((d) => d.id !== visit.doctorId && d.status === "on_duty");
  const ref = visit.token ? `#${visit.token}` : visit.id;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<button type="button" className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Visit actions" />}
      >
        <MoreHorizontal className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            {ref} {visit.patientName}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {visit.status === "scheduled" && <DropdownMenuItem onClick={() => staffAction({ action: "check_in", visit: ref }, onDone, `${visit.patientName} checked in`)}>Check in (arrived)</DropdownMenuItem>}
        {visit.status === "waiting" && <DropdownMenuItem onClick={() => staffAction({ action: "start_consult", visit: ref }, onDone, `${visit.patientName} called in`)}>Call in now</DropdownMenuItem>}
        {visit.status === "in_consult" && <DropdownMenuItem onClick={() => staffAction({ action: "finish_consult", visit: ref }, onDone, `${visit.patientName} done`)}>Finish consult</DropdownMenuItem>}
        {visit.status === "scheduled" && <DropdownMenuItem onClick={() => staffAction({ action: "no_show", visit: ref }, onDone, `${visit.patientName} marked no-show`)}>Mark no-show</DropdownMenuItem>}
        {visit.priority !== "normal" && (
          <DropdownMenuItem onClick={() => staffAction({ action: "set_priority", visit: ref, priority: "normal", reason: "Staff re-triage" }, onDone, "Priority lowered by staff")}>
            Lower to normal (staff only)
          </DropdownMenuItem>
        )}
        {visit.priority === "normal" && (
          <DropdownMenuItem onClick={() => staffAction({ action: "set_priority", visit: ref, priority: "urgent", reason: "Staff triage" }, onDone, "Marked urgent")}>Mark urgent</DropdownMenuItem>
        )}
        {(visit.status === "waiting" || visit.status === "scheduled") && others.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-xs text-muted-foreground">Move to</DropdownMenuLabel>
              {others.map((d) => (
                <DropdownMenuItem key={d.id} onClick={() => staffAction({ action: "reassign", visit: ref, doctor: d.id, reason: "Staff rebalanced" }, onDone, `Moved to ${d.name}`)}>
                  {d.name} <span className="ml-auto text-[10px] text-muted-foreground">{d.specialty}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}
        {(visit.status === "waiting" || visit.status === "scheduled") && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => staffAction({ action: "cancel", visit: ref, reason: "Cancelled at desk" }, onDone, "Visit cancelled")}>
              Cancel visit
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
