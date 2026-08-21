"use client";

import { Link2, Sparkles, TicketPlus, X } from "lucide-react";
import { useMemo, useState } from "react";
import type {
  ClientSummary,
  TicketPriority,
  TicketSummary,
} from "@/app/lib/types";
import { priorityLabels, statusLabels } from "@/app/lib/format";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import { Input } from "@/app/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { Textarea } from "@/app/components/ui/textarea";
import { cn } from "@/app/lib/utils";

export type CreateTicketDraft = {
  title: string;
  summary: string;
  clientId: string | null;
  priority: TicketPriority;
};

type CreateDialogProps = {
  mode: "create";
  messageCount: number;
  initialDraft: CreateTicketDraft;
  clients: ClientSummary[];
  tickets: TicketSummary[];
  initialTicketId?: string | null;
  busy: boolean;
  onCancel: () => void;
  onCreate: (draft: CreateTicketDraft) => void;
  onAttach: (ticketId: string) => void;
};

type AttachDialogProps = Omit<CreateDialogProps, "mode"> & {
  mode: "attach";
};

export type ConversationActionDialogProps = CreateDialogProps | AttachDialogProps;

export function ConversationActionDialog(props: ConversationActionDialogProps) {
  const [draft, setDraft] = useState(props.initialDraft);
  const [ticketId, setTicketId] = useState(props.initialTicketId ?? "");
  const [ticketQuery, setTicketQuery] = useState("");

  const availableTickets = useMemo(() => {
    const normalized = ticketQuery.trim().toLocaleLowerCase("pt-BR");
    return props.tickets
      .filter((ticket) => ticket.status !== "archived")
      .filter((ticket) => {
        if (!normalized) return true;
        return [ticket.title, ticket.summary, ticket.client.name, `#${ticket.number}`]
          .some((value) => value.toLocaleLowerCase("pt-BR").includes(normalized));
      })
      .slice(0, 80);
  }, [props.tickets, ticketQuery]);

  const canSubmit =
    props.mode === "create"
      ? Boolean(draft.title.trim() && draft.summary.trim())
      : Boolean(ticketId);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !props.busy) props.onCancel();
      }}
    >
      <DialogContent
        className="flex max-h-[calc(100dvh-32px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl max-[760px]:top-auto max-[760px]:bottom-0 max-[760px]:max-h-[94dvh] max-[760px]:max-w-none max-[760px]:translate-y-0 max-[760px]:rounded-b-none"
        onEscapeKeyDown={(event) => {
          if (props.busy) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (props.busy) event.preventDefault();
        }}
        showCloseButton={false}
      >
      <form
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit || props.busy) return;
          if (props.mode === "create") {
            if (
              draft.clientId !== props.initialDraft.clientId &&
              !window.confirm(
                "Esta alteração vinculará toda a conversa à organização escolhida. Deseja continuar?",
              )
            ) return;
            props.onCreate(draft);
          }
          else props.onAttach(ticketId);
        }}
      >
        <DialogHeader className="flex-row items-start gap-3 border-b border-border p-4 text-left">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary max-[760px]:hidden">
            {props.mode === "create" ? <TicketPlus size={19} /> : <Link2 size={19} />}
          </span>
          <div className="min-w-0 flex-1">
            <span className="text-xs font-semibold text-primary uppercase">{props.messageCount} {props.messageCount === 1 ? "mensagem selecionada" : "mensagens selecionadas"}</span>
            <DialogTitle className="mt-1 text-lg font-semibold text-foreground max-[760px]:text-base">
              {props.mode === "create" ? "Criar ticket desta conversa" : "Anexar a um ticket existente"}
            </DialogTitle>
            <DialogDescription className="mt-1 text-sm leading-relaxed">
              {props.mode === "create"
                ? "Revise a leitura inicial antes de criar. Nada será enviado ao WhatsApp."
                : "As mensagens passam a compor o contexto do ticket escolhido. Tickets resolvidos continuam disponíveis até serem arquivados."}
            </DialogDescription>
          </div>
          <Button aria-label="Fechar" onClick={props.onCancel} size="icon" type="button" variant="ghost">
            <X size={17} />
          </Button>
        </DialogHeader>

        {props.mode === "create" ? (
          <div className="grid min-h-0 grid-cols-2 gap-3 overflow-y-auto p-4 max-[760px]:grid-cols-1 max-[760px]:p-3">
            <div className="col-span-2 flex min-h-12 items-center gap-2 rounded-lg border border-primary/15 bg-primary/5 px-3 py-2 text-primary max-[760px]:col-span-1">
              <Sparkles size={16} />
              <span className="flex flex-col">
                <strong className="text-xs">Rascunho assistido</strong>
                <small className="mt-1 text-xs text-primary/70">Título e resumo são apenas uma sugestão local e podem ser ajustados.</small>
              </span>
            </div>
            <label className="col-span-2 flex min-w-0 flex-col gap-1.5 max-[760px]:col-span-1">
              <span className="text-xs font-medium text-muted-foreground">Título do ticket</span>
              <Input
                autoFocus
                maxLength={140}
                onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
                value={draft.title}
              />
            </label>
            <label className="col-span-2 flex min-w-0 flex-col gap-1.5 max-[760px]:col-span-1">
              <span className="text-xs font-medium text-muted-foreground">Resumo do problema ou dúvida</span>
              <Textarea
                maxLength={1600}
                onChange={(event) => setDraft((current) => ({ ...current, summary: event.target.value }))}
                rows={5}
                value={draft.summary}
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Vincular esta conversa à organização</span>
              <Select
                onValueChange={(value) => {
                  const clientId = value === "__unidentified__" ? null : value;
                  setDraft((current) => ({
                    ...current,
                    clientId,
                  }));
                }}
                value={draft.clientId ?? "__unidentified__"}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {props.initialDraft.clientId === null ? (
                    <SelectItem value="__unidentified__">Organização não identificada</SelectItem>
                  ) : null}
                  {props.clients.map((client) => (
                    <SelectItem key={client.id} value={client.id}>{client.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <small className="text-xs leading-relaxed text-muted-foreground">
                Ao alterar, todo este grupo ou contato ficará vinculado à organização escolhida.
              </small>
            </label>
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Prioridade</span>
              <Select
                onValueChange={(value) =>
                  setDraft((current) => ({
                    ...current,
                    priority: value as TicketPriority,
                  }))
                }
                value={draft.priority}
              >
                <SelectTrigger aria-label="Prioridade do ticket" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">{priorityLabels.low}</SelectItem>
                  <SelectItem value="normal">{priorityLabels.normal}</SelectItem>
                  <SelectItem value="high">{priorityLabels.high}</SelectItem>
                  <SelectItem value="urgent">{priorityLabels.urgent}</SelectItem>
                </SelectContent>
              </Select>
            </label>
          </div>
        ) : (
          <div className="flex min-h-0 flex-col overflow-hidden p-4">
            <label className="flex min-w-0 shrink-0 flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Buscar por número, grupo, solicitante ou assunto</span>
              <Input
                autoFocus
                onChange={(event) => setTicketQuery(event.target.value)}
                placeholder="Ex.: #42 ou pedidos ausentes"
                value={ticketQuery}
              />
            </label>
            <div className="mt-2.5 min-h-44 overflow-y-auto rounded-lg border border-border" role="radiogroup" aria-label="Tickets disponíveis">
              {availableTickets.length ? availableTickets.map((ticket) => (
                <label
                  className={cn(
                    "flex min-h-14 cursor-pointer flex-row items-center gap-2.5 border-b border-border px-3 py-2 last:border-b-0",
                    ticketId === ticket.id && "bg-primary/10",
                  )}
                  key={ticket.id}
                >
                  <Input
                    className="size-4 min-h-0 w-auto shrink-0"
                    checked={ticketId === ticket.id}
                    name="ticketId"
                    onChange={() => setTicketId(ticket.id)}
                    type="radio"
                    value={ticket.id}
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex min-w-0 items-center gap-2">
                      <strong className="min-w-0 flex-1 truncate text-xs text-foreground">#{ticket.number} · {ticket.title}</strong>
                      <Badge className="h-5 shrink-0 px-1.5 text-[10px]" variant="secondary">
                        {statusLabels[ticket.status]}
                      </Badge>
                    </span>
                    <small className="mt-1 text-xs text-muted-foreground">{ticket.client.name}{ticket.affectedStore ? ` · ${ticket.affectedStore.name}` : ""}</small>
                  </span>
                </label>
              )) : (
                <p className="p-8 text-center text-sm text-muted-foreground">Nenhum ticket disponível corresponde à busca.</p>
              )}
            </div>
          </div>
        )}

        <footer className="flex items-center justify-between gap-3 border-t border-border bg-muted/20 p-4 max-[760px]:flex-col max-[760px]:items-stretch max-[760px]:pb-[max(12px,env(safe-area-inset-bottom))]">
          <span className="text-xs text-muted-foreground max-[760px]:text-center">Ação interna · WhatsApp somente leitura</span>
          <div className="flex gap-2">
            <Button className="flex-1 sm:flex-none" onClick={props.onCancel} type="button" variant="outline">Cancelar</Button>
            <Button className="flex-1 sm:flex-none" disabled={!canSubmit || props.busy} type="submit" variant="default">
              {props.busy ? "Salvando…" : props.mode === "create" ? "Criar ticket" : "Anexar mensagens"}
            </Button>
          </div>
        </footer>
      </form>
      </DialogContent>
    </Dialog>
  );
}
