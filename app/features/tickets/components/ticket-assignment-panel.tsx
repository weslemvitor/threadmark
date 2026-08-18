import { ShieldCheck, UserRoundCheck } from "lucide-react";

import { PriorityPill } from "@/app/components/shared/status-pill";
import type { TicketAssignee, TicketDetail } from "@/app/lib/types";
import { TicketAssigneeControl } from "@/app/components/shared/ticket-assignee-control";

export function TicketAssignmentPanel({
  ticket,
  assignees,
  currentUserId,
  canManage,
  updating,
  onChange,
}: {
  ticket: TicketDetail;
  assignees: TicketAssignee[];
  currentUserId: string | null;
  canManage: boolean;
  updating: boolean;
  onChange: (assigneeId: string | null) => Promise<boolean>;
}) {
  return (
    <section className="border-b border-border bg-card p-3.5" aria-label="Organização do ticket">
      <div className="flex items-center gap-2">
        <UserRoundCheck className="text-primary" size={15} />
        <h3 className="text-sm font-semibold text-foreground">Responsável e prioridade</h3>
        <PriorityPill priority={ticket.priority} />
      </div>
      <div className="mt-3">
        <TicketAssigneeControl
          assignee={ticket.assignee}
          assignees={assignees}
          canManage={canManage}
          currentUserId={currentUserId}
          disabled={updating}
          onChange={onChange}
        />
      </div>
      {!assignees.length && canManage ? (
        <p className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
          <ShieldCheck className="mt-0.5 shrink-0" size={12} />
          Adicione integrantes em Configurações → Usuários para distribuir tickets.
        </p>
      ) : null}
    </section>
  );
}
