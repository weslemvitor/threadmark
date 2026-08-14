import { BrainCircuit } from "lucide-react";

import { Button } from "@/app/components/ui/button";
import type { TicketDetail as TicketDetailType } from "@/app/lib/types";

export function InvestigationRoomLauncher({
  ticket,
  onOpen,
}: {
  ticket: TicketDetailType;
  onOpen: () => void;
}) {
  return (
    <section className="border-b border-border px-3.5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-primary">
            <BrainCircuit size={13} /> Codex
          </span>
          <h3 className="mt-1 text-sm font-semibold text-foreground">Sala de investigação</h3>
        </div>
        <span className="rounded-full bg-muted px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Manual</span>
      </div>
      <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">
        Converse com o agente para investigar este caso em profundidade. A sala
        só é iniciada quando você abrir.
      </p>
      <Button className="mt-4 w-full gap-2" onClick={onOpen} size="sm" type="button" variant="outline">
        <BrainCircuit size={16} />
        {ticket.investigationThread
          ? "Abrir sala de investigação"
          : "Iniciar investigação profunda"}
      </Button>
    </section>
  );
}
