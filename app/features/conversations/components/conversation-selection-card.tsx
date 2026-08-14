import {
  ArchiveRestore,
  Inbox,
  Link2,
  MessageCircleMore,
  TicketPlus,
} from "lucide-react";

import { Button } from "@/app/components/ui/button";
import { cn } from "@/app/lib/utils";

export function ConversationSelectionCard({
  selectedCount,
  hasExternalSelection,
  hasTicketedSelection,
  canRestoreSelection,
  busy,
  onClear,
  onCreate,
  onAttach,
  onKeepContext,
  onRestore,
}: {
  selectedCount: number;
  hasExternalSelection: boolean;
  hasTicketedSelection: boolean;
  canRestoreSelection: boolean;
  busy: boolean;
  onClear: () => void;
  onCreate: () => void;
  onAttach: () => void;
  onKeepContext: () => void;
  onRestore: () => void;
}) {
  return (
    <section className="border-b border-border bg-card p-3.5 max-[1050px]:p-3">
      <div className="flex items-start gap-2">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <Inbox size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">
            Triagem da conversa
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Selecione mensagens que pertencem à mesma demanda.
          </p>
        </div>
      </div>
      <div
        className={cn(
          "mt-3 grid min-h-12 grid-cols-[auto_1fr_auto] items-center gap-2 rounded-lg border border-dashed border-border bg-muted/40 px-2.5 py-2 text-muted-foreground",
          selectedCount &&
            "border-solid border-primary/30 bg-primary/10 text-primary",
        )}
      >
        <strong className="text-lg">{selectedCount}</strong>
        <span className="text-xs">
          {selectedCount === 1
            ? "mensagem selecionada"
            : "mensagens selecionadas"}
        </span>
        {selectedCount ? (
          <Button onClick={onClear} size="xs" type="button" variant="outline">
            Limpar
          </Button>
        ) : null}
      </div>
      {!selectedCount ? (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Escolha um bloco sugerido ou selecione manualmente apenas as mensagens
          do mesmo assunto.
        </p>
      ) : null}
      <div className="mt-2.5 grid gap-1.5">
        <Button
          className="h-auto min-h-11 justify-start px-2.5 py-2 text-left"
          disabled={
            !selectedCount ||
            !hasExternalSelection ||
            hasTicketedSelection ||
            busy
          }
          onClick={onCreate}
          title={
            hasTicketedSelection
              ? "A seleção contém mensagem já vinculada a ticket"
              : undefined
          }
          type="button"
          variant="default"
        >
          <TicketPlus size={16} />
          <span className="flex min-w-0 flex-col items-start">
            <strong className="text-xs">Criar ticket</strong>
            <small className="mt-0.5 text-xs text-primary-foreground/70">
              Nova demanda separada
            </small>
          </span>
        </Button>
        <Button
          className="h-auto min-h-11 justify-start px-2.5 py-2 text-left"
          disabled={!selectedCount || busy}
          onClick={onAttach}
          type="button"
          variant="secondary"
        >
          <Link2 size={16} />
          <span className="flex min-w-0 flex-col items-start">
            <strong className="text-xs">Anexar a ticket</strong>
            <small className="mt-0.5 text-xs text-muted-foreground">
              Continuar atendimento existente
            </small>
          </span>
        </Button>
      </div>
      <div className="mt-2 grid gap-1.5">
        <Button
          disabled={!selectedCount || hasTicketedSelection || busy}
          onClick={onKeepContext}
          title={
            hasTicketedSelection
              ? "A seleção contém mensagem já vinculada a ticket"
              : undefined
          }
          size="sm"
          type="button"
          variant="outline"
        >
          <MessageCircleMore size={14} /> Manter contexto
        </Button>
        <Button
          disabled={!canRestoreSelection || busy}
          onClick={onRestore}
          size="sm"
          type="button"
          variant="outline"
        >
          <ArchiveRestore size={14} /> Restaurar
        </Button>
      </div>
      <small className="mt-2.5 block text-center text-xs text-muted-foreground">
        Dica: Shift + clique seleciona um intervalo.
      </small>
    </section>
  );
}
