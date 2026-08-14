"use client";

import { LoaderCircle } from "lucide-react";
import type { RefObject } from "react";

import { Button } from "@/app/components/ui/button";
import { Checkbox } from "@/app/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import { Input } from "@/app/components/ui/input";
import { Textarea } from "@/app/components/ui/textarea";
import {
  PRODUCT_FORWARDING_DESCRIPTION_MAX_LENGTH,
  PRODUCT_FORWARDING_EXTERNAL_REFERENCE_MAX_LENGTH,
  PRODUCT_FORWARDING_TITLE_MAX_LENGTH,
} from "@/shared/contracts";

export type ProductForwardingDraft = {
  ticketId: string;
  title: string;
  description: string;
  externalReference: string;
  resolveTicket: boolean;
  isEditing: boolean;
  canResolve: boolean;
};

type ProductForwardingDialogProps = {
  busy: boolean;
  draft: ProductForwardingDraft;
  returnFocusRef: RefObject<HTMLElement | null>;
  onCancel: () => void;
  onChange: (draft: ProductForwardingDraft) => void;
  onSubmit: () => void;
};

export function ProductForwardingDialog({
  busy,
  draft,
  returnFocusRef,
  onCancel,
  onChange,
  onSubmit,
}: ProductForwardingDialogProps) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] gap-0 overflow-hidden p-0 sm:max-w-xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const previousFocus = returnFocusRef.current;
          if (previousFocus?.isConnected) {
            previousFocus.focus({ preventScroll: true });
          }
          returnFocusRef.current = null;
        }}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy && draft.title.trim() && draft.description.trim()) {
              onSubmit();
            }
          }}
        >
          <DialogHeader className="border-b border-border px-5 py-4 pr-12 text-left">
            <span className="text-xs font-semibold tracking-wide text-rose-600 uppercase">
              Produto
            </span>
            <DialogTitle className="text-lg">
              {draft.isEditing
                ? "Editar bug encaminhado"
                : "Encaminhar bug para Produto"}
            </DialogTitle>
            <DialogDescription>
              Registre o problema e, se houver, o link do card externo. Tudo fica
              persistido no histórico deste ticket.
            </DialogDescription>
          </DialogHeader>

          <section className="grid min-h-0 gap-3 overflow-y-auto px-5 py-5">
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Título do bug
              </span>
              <Input
                maxLength={PRODUCT_FORWARDING_TITLE_MAX_LENGTH}
                onChange={(event) =>
                  onChange({ ...draft, title: event.target.value })
                }
                placeholder="Ex.: Métrica de clientes diverge no dashboard"
                required
                value={draft.title}
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Descrição para o time de Produto
              </span>
              <Textarea
                maxLength={PRODUCT_FORWARDING_DESCRIPTION_MAX_LENGTH}
                onChange={(event) =>
                  onChange({ ...draft, description: event.target.value })
                }
                placeholder="Descreva o comportamento observado, o impacto e as evidências disponíveis."
                required
                rows={6}
                value={draft.description}
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Referência externa (opcional)
              </span>
              <Input
                maxLength={PRODUCT_FORWARDING_EXTERNAL_REFERENCE_MAX_LENGTH}
                onChange={(event) =>
                  onChange({ ...draft, externalReference: event.target.value })
                }
                placeholder="Link ou código do card no Linear, Jira, GitHub…"
                value={draft.externalReference}
              />
            </label>

            {draft.canResolve ? (
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-muted/40 p-3 text-sm text-foreground">
                <Checkbox
                  checked={draft.resolveTicket}
                  className="mt-0.5"
                  onCheckedChange={(checked) =>
                    onChange({ ...draft, resolveTicket: checked === true })
                  }
                />
                <span>
                  <strong className="block text-xs">
                    Finalizar este atendimento
                  </strong>
                  <small className="mt-1 block text-xs leading-4 text-muted-foreground">
                    Marque quando o encaminhamento ao Produto concluir o trabalho
                    do suporte neste ticket.
                  </small>
                </span>
              </label>
            ) : (
              <aside className="rounded-lg border border-border bg-muted/40 p-3 text-xs leading-5 text-muted-foreground">
                Este atendimento já está encerrado. O encaminhamento será salvo
                sem alterar o status.
              </aside>
            )}
          </section>

          <DialogFooter className="m-0 flex-row rounded-none px-5 py-4 max-[520px]:flex-col-reverse">
            <Button
              className="max-[520px]:w-full"
              disabled={busy}
              onClick={onCancel}
              type="button"
              variant="outline"
            >
              Cancelar
            </Button>
            <Button
              className="max-[520px]:w-full"
              disabled={
                busy || !draft.title.trim() || !draft.description.trim()
              }
              type="submit"
            >
              {busy ? <LoaderCircle className="animate-spin" size={15} /> : null}
              {draft.isEditing
                ? "Salvar encaminhamento"
                : draft.resolveTicket
                  ? "Encaminhar e finalizar atendimento"
                  : "Encaminhar para Produto"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
