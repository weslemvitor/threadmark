"use client";

import { FilePlus2, LoaderCircle, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { ClientSummary, TicketPriority } from "@/app/lib/types";
import { Button } from "@/app/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import { Input } from "@/app/components/ui/input";
import { NativeSelect } from "@/app/components/ui/native-select";
import { Textarea } from "@/app/components/ui/textarea";

export type ManualTicketDraft = {
  groupId: string;
  title: string;
  summary: string;
  priority: TicketPriority;
};

export function ManualTicketDialog({
  clients,
  busy,
  error,
  onCancel,
  onCreate,
}: {
  clients: ClientSummary[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onCreate: (draft: ManualTicketDraft) => void;
}) {
  const groups = useMemo(
    () => clients.flatMap((client) =>
      client.groups.map((group) => ({
        ...group,
        clientName: client.name,
      }))),
    [clients],
  );
  const [draft, setDraft] = useState<ManualTicketDraft>({
    groupId: "",
    title: "",
    summary: "",
    priority: "normal",
  });
  const canSubmit = Boolean(
    draft.groupId && draft.title.trim() && draft.summary.trim(),
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <DialogContent
        className="flex max-h-[calc(100dvh-32px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl max-[760px]:top-auto max-[760px]:bottom-0 max-[760px]:max-h-[94dvh] max-[760px]:max-w-none max-[760px]:translate-y-0 max-[760px]:rounded-b-none"
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault();
        }}
        showCloseButton={false}
      >
      <form
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit || busy) return;
          onCreate({
            ...draft,
            title: draft.title.trim(),
            summary: draft.summary.trim(),
          });
        }}
      >
        <DialogHeader className="flex-row items-start gap-3 border-b border-border p-4 text-left">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary max-[760px]:hidden"><FilePlus2 size={19} /></span>
          <div className="min-w-0 flex-1">
            <span className="text-xs font-semibold text-primary uppercase">Criação manual</span>
            <DialogTitle className="mt-1 text-lg font-semibold text-foreground max-[760px]:text-base">Criar ticket sem selecionar mensagens</DialogTitle>
            <DialogDescription className="mt-1 text-sm leading-relaxed">
              Use para demandas isoladas. O ticket ficará no SQLite e nada será
              enviado ao WhatsApp.
            </DialogDescription>
          </div>
          <Button
            aria-label="Fechar"
            disabled={busy}
            onClick={onCancel}
            size="icon"
            type="button"
            variant="ghost"
          >
            <X size={17} />
          </Button>
        </DialogHeader>

        <div className="grid min-h-0 grid-cols-2 gap-3 overflow-y-auto p-4 max-[760px]:grid-cols-1 max-[760px]:p-3">
          <div className="col-span-2 flex min-h-12 items-center gap-2 rounded-lg border border-primary/15 bg-primary/5 px-3 py-2 text-primary max-[760px]:col-span-1">
            <FilePlus2 size={16} />
            <span className="flex flex-col">
              <strong className="text-xs">Sem mensagem de origem</strong>
              <small className="mt-1 text-xs text-primary/70">Depois você pode adicionar notas e categorias.</small>
            </span>
          </div>

          <label className="col-span-2 flex min-w-0 flex-col gap-1.5 max-[760px]:col-span-1">
            <span className="text-xs font-medium text-muted-foreground">Grupo ou conversa relacionada</span>
            <NativeSelect
              autoFocus
              disabled={!groups.length}
              onChange={(event) => setDraft((current) => ({
                ...current,
                groupId: event.target.value,
              }))}
              required
              value={draft.groupId}
              wrapperClassName="w-full"
            >
              <option value="">Selecione o contexto do ticket…</option>
              {clients.map((client) => client.groups.length ? (
                <optgroup key={client.id} label={client.name}>
                  {client.groups.map((group) => (
                    <option key={group.id} value={group.id}>{group.subject}</option>
                  ))}
                </optgroup>
              ) : null)}
            </NativeSelect>
            {!groups.length ? (
              <small className="text-xs leading-relaxed text-amber-700">
                Nenhum grupo ou conversa está disponível para vincular o ticket.
              </small>
            ) : null}
          </label>

          <label className="col-span-2 flex min-w-0 flex-col gap-1.5 max-[760px]:col-span-1">
            <span className="text-xs font-medium text-muted-foreground">Título do ticket</span>
            <Input
              maxLength={200}
              onChange={(event) => setDraft((current) => ({
                ...current,
                title: event.target.value,
              }))}
              placeholder="Ex.: Divergência no total de clientes"
              required
              value={draft.title}
            />
          </label>

          <label className="col-span-2 flex min-w-0 flex-col gap-1.5 max-[760px]:col-span-1">
            <span className="text-xs font-medium text-muted-foreground">Resumo do problema ou dúvida</span>
            <Textarea
              maxLength={20_000}
              onChange={(event) => setDraft((current) => ({
                ...current,
                summary: event.target.value,
              }))}
              placeholder="Descreva o contexto conhecido e o resultado esperado."
              required
              rows={6}
              value={draft.summary}
            />
          </label>

          <label className="flex min-w-0 flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Prioridade</span>
            <NativeSelect
              onChange={(event) => setDraft((current) => ({
                ...current,
                priority: event.target.value as TicketPriority,
              }))}
              value={draft.priority}
              wrapperClassName="w-full"
            >
              <option value="low">Baixa</option>
              <option value="normal">Normal</option>
              <option value="high">Alta</option>
              <option value="urgent">Urgente</option>
            </NativeSelect>
          </label>

          {error ? <p className="col-span-2 m-0 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm leading-relaxed text-destructive max-[760px]:col-span-1" role="alert">{error}</p> : null}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-border bg-muted/20 p-4 max-[760px]:flex-col max-[760px]:items-stretch max-[760px]:pb-[max(12px,env(safe-area-inset-bottom))]">
          <span className="text-xs text-muted-foreground max-[760px]:text-center">Ação interna · criação auditada</span>
          <div className="flex gap-2">
            <Button
              className="flex-1 sm:flex-none"
              disabled={busy}
              onClick={onCancel}
              type="button"
              variant="outline"
            >
              Cancelar
            </Button>
            <Button className="flex-1 sm:flex-none" disabled={!canSubmit || busy} type="submit" variant="default">
              {busy ? <LoaderCircle className="animate-spin" size={15} /> : <FilePlus2 size={15} />}
              {busy ? "Criando…" : "Criar ticket"}
            </Button>
          </div>
        </footer>
      </form>
      </DialogContent>
    </Dialog>
  );
}
