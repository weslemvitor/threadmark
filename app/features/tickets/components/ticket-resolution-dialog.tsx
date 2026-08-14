"use client";

import { LoaderCircle } from "lucide-react";

import { Button } from "@/app/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import { Textarea } from "@/app/components/ui/textarea";

type TicketResolutionDialogProps = {
  busy: boolean;
  hasPreviousResolution: boolean;
  isSummaryChanged: boolean;
  summary: string;
  onCancel: () => void;
  onChange: (summary: string) => void;
  onSubmit: () => void;
};

export function TicketResolutionDialog({
  busy,
  hasPreviousResolution,
  isSummaryChanged,
  summary,
  onCancel,
  onChange,
  onSubmit,
}: TicketResolutionDialogProps) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] min-w-0 gap-0 overflow-hidden p-0 sm:max-w-lg"
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <form
          className="flex min-h-0 min-w-0 max-w-full flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (summary.trim() && !busy) onSubmit();
          }}
        >
          <DialogHeader className="border-b border-border px-5 py-4 pr-12 text-left">
            <span className="text-xs font-semibold tracking-wide text-emerald-700 uppercase">
              Finalizar ticket
            </span>
            <DialogTitle className="text-lg">
              Como este ticket foi concluído?
            </DialogTitle>
            <DialogDescription>
              {hasPreviousResolution
                ? "Você pode manter ou editar o último resumo. O Threadmark não criará uma resolução duplicada."
                : "A mensagem será exibida integralmente no Resumo do ticket e preservada no SQLite."}
            </DialogDescription>
          </DialogHeader>
          <div className="min-w-0 overflow-y-auto px-5 py-5">
            <Textarea
              autoFocus
              className="field-sizing-fixed min-h-32 min-w-0 max-w-full resize-y overflow-x-hidden whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
              onChange={(event) => onChange(event.target.value)}
              placeholder="Descreva o desfecho, o que foi feito e o resultado confirmado."
              rows={4}
              value={summary}
              wrap="soft"
            />
          </div>
          <DialogFooter className="m-0 min-w-0 shrink-0 flex-row rounded-none px-5 py-4 max-[480px]:flex-col-reverse">
            <Button
              className="max-[480px]:w-full"
              disabled={busy}
              onClick={onCancel}
              type="button"
              variant="outline"
            >
              Cancelar
            </Button>
            <Button
              className="max-[480px]:w-full"
              disabled={!summary.trim() || busy}
              type="submit"
            >
              {busy ? <LoaderCircle className="animate-spin" size={15} /> : null}
              {busy
                ? "Salvando…"
                : hasPreviousResolution && !isSummaryChanged
                  ? "Resolver mantendo resumo"
                  : hasPreviousResolution
                    ? "Resolver e atualizar resumo"
                    : "Resolver e salvar resumo"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
