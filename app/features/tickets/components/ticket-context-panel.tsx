import {
  ExternalLink,
  FolderTree,
  Link2,
  MessageSquareText,
  Plus,
  UserRound,
} from "lucide-react";

import { Button } from "@/app/components/ui/button";
import { getRequesterPresentation } from "@/app/lib/format";
import type { TicketDetail as TicketDetailType } from "@/app/lib/types";

export function ContextPanel({
  ticket,
  onEditContext,
  canCreateWithConnector,
  onCreateWithConnector,
}: {
  ticket: TicketDetailType;
  onEditContext: () => void;
  canCreateWithConnector: boolean;
  onCreateWithConnector: () => void;
}) {
  const requester = getRequesterPresentation(ticket.requester);
  return (
    <section className="border-b border-border px-3.5 py-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">
          Contexto do atendimento
        </h3>
        <Button
          className="shrink-0 gap-1.5"
          onClick={onEditContext}
          size="sm"
          type="button"
          variant="outline"
        >
          <Link2 size={13} /> Gerenciar
        </Button>
      </div>
      <dl className="mt-3 divide-y divide-border">
        <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] gap-3 py-2.5 first:pt-0">
          <dt className="flex items-center gap-2 text-xs text-muted-foreground">
            <UserRound size={14} /> Solicitante
          </dt>
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
          <dt className="flex items-center gap-2 text-xs text-muted-foreground">
            <MessageSquareText size={14} /> Grupo
          </dt>
          <dd className="min-w-0 break-words text-right text-sm font-semibold text-foreground">
            {ticket.group.subject}
            <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
              {ticket.messageCount} {ticket.messageCount === 1 ? "mensagem" : "mensagens"} no ticket
            </span>
          </dd>
        </div>
      </dl>
      <div className="mt-3 flex items-start justify-between gap-3 border-t border-border pt-3">
        <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <FolderTree size={13} /> Registros vinculados
        </span>
        {canCreateWithConnector ? (
          <Button
            onClick={onCreateWithConnector}
            size="xs"
            type="button"
            variant="ghost"
          >
            <Plus size={12} /> Criar via conector
          </Button>
        ) : (
          <small className="max-w-32 text-right text-xs leading-relaxed text-muted-foreground">
            Campos personalizados do Diretório
          </small>
        )}
      </div>
      {ticket.directoryContext.records.length ? (
        <div className="mt-2.5 grid gap-2.5">
          {ticket.directoryContext.records.map((record) => {
            const fields = record.fields.filter((field) => field.displayValue);
            return (
              <article className="rounded-lg border border-border bg-background p-2.5 shadow-sm" key={record.id}>
                <header className="flex items-start gap-2.5">
                  <i className="mt-1.5 size-2.5 shrink-0 rounded-full bg-primary" style={{ backgroundColor: record.type.color ?? undefined }} />
                  <span className="min-w-0">
                    <small className="block text-xs font-medium text-muted-foreground">{record.type.name}</small>
                    <strong className="block break-words text-sm text-foreground">{record.name}</strong>
                  </span>
                </header>
                {fields.length ? (
                  <dl className="mt-3 grid gap-2 border-t border-border pt-3">
                    {fields.map((field) => (
                      <div className="grid gap-0.5" key={field.id}>
                        <dt className="text-xs font-medium text-muted-foreground">{field.label}</dt>
                        <dd className="break-words text-xs text-foreground">
                          {field.type === "url" && typeof field.value === "string" ? (
                            <a className="inline-flex items-center gap-1 text-primary hover:underline" href={field.value} rel="noreferrer" target="_blank">
                              {field.displayValue} <ExternalLink size={10} />
                            </a>
                          ) : (
                            field.displayValue
                          )}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : record.description ? (
                  <p className="mt-3 break-words text-xs leading-relaxed text-muted-foreground">{record.description}</p>
                ) : null}
                <footer className="mt-3 border-t border-border pt-2 text-xs text-muted-foreground">
                  {record.sources.includes("ticket") ? "Específico deste ticket" : null}
                  {record.sources.includes("ticket") && record.sources.length > 1
                    ? " · "
                    : null}
                  {record.sources.includes("group") ? "Vinculado ao grupo" : null}
                  {record.sources.includes("group") && record.sources.includes("requester")
                    ? " · "
                    : null}
                  {record.sources.includes("requester")
                    ? "Vinculado ao solicitante"
                    : null}
                </footer>
              </article>
            );
          })}
        </div>
      ) : (
        <Button
          className="mt-2.5 h-auto w-full justify-start gap-2.5 whitespace-normal border-dashed px-3 py-3 text-left"
          onClick={onEditContext}
          type="button"
          variant="outline"
        >
          <FolderTree className="shrink-0 text-primary" size={16} />
          <span className="min-w-0">
            <strong className="block text-xs text-foreground">Nenhum registro personalizado vinculado</strong>
            <small className="mt-1 block text-xs leading-relaxed text-muted-foreground">Classifique este contexto com os tipos criados no Diretório.</small>
          </span>
        </Button>
      )}
    </section>
  );
}
