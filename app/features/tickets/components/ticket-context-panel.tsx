import { MessageSquareText, UserRound } from "lucide-react";

import { getRequesterPresentation } from "@/app/lib/format";
import type { TicketDetail as TicketDetailType } from "@/app/lib/types";

export function ContextPanel({ ticket }: { ticket: TicketDetailType }) {
  const requester = getRequesterPresentation(ticket.requester);
  return (
    <section className="border-b border-border px-3.5 py-4">
      <h3 className="text-sm font-semibold text-foreground">Contexto do atendimento</h3>
      <dl className="mt-3 divide-y divide-border">
        <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] gap-3 py-2.5 first:pt-0">
          <dt className="flex items-center gap-2 text-xs text-muted-foreground"><UserRound size={14} /> Solicitante</dt>
          <dd className={`min-w-0 text-right text-sm font-semibold ${requester ? "text-foreground" : "text-amber-700"}`}>
            {requester?.name ?? "Ainda não identificado"}
            <span className="mt-0.5 block break-words text-xs font-normal leading-relaxed text-muted-foreground">
              {requester?.phone && requester.phone !== requester.name
                ? requester.phone
                : requester
                  ? "Contato identificado pelo WhatsApp"
                  : "Aguardando identificação do remetente"}
            </span>
          </dd>
        </div>
        <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] gap-3 py-2.5">
          <dt className="flex items-center gap-2 text-xs text-muted-foreground"><MessageSquareText size={14} /> Grupo</dt>
          <dd className="min-w-0 break-words text-right text-sm font-semibold text-foreground">
            {ticket.group.subject}
            <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
              {ticket.messageCount} {ticket.messageCount === 1 ? "mensagem" : "mensagens"} no ticket
            </span>
          </dd>
        </div>
      </dl>
    </section>
  );
}
