import { Button } from "@/app/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import { Input } from "@/app/components/ui/input";
import {
  AlertTriangle,
  LoaderCircle,
  MessageSquareText,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import {
  type FormEvent,
  useEffect,
  useRef,
  useState,
} from "react";

import type { TicketDetail } from "@/app/lib/types";

const DELETE_CONFIRMATION = "EXCLUIR";

export type TicketDeleteDialogProps = {
  ticket: TicketDetail;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: (ticketId: string) => Promise<boolean>;
};

export function TicketDeleteDialog({
  ticket,
  deleting,
  onCancel,
  onConfirm,
}: TicketDeleteDialogProps) {
  const [confirmation, setConfirmation] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmed =
    confirmation.trim().toLocaleUpperCase("pt-BR") === DELETE_CONFIRMATION;

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const focusFrame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });

    return () => {
      window.cancelAnimationFrame(focusFrame);
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    function handleEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape" || deleting) return;
      event.preventDefault();
      onCancel();
    }

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [deleting, onCancel]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirmed || deleting) return;
    void onConfirm(ticket.id);
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !deleting) onCancel(); }}>
      <DialogContent
        aria-busy={deleting}
        className="max-h-[calc(100dvh-2rem)] max-w-lg gap-0 overflow-hidden p-0"
        onEscapeKeyDown={(event) => { if (deleting) event.preventDefault(); }}
        onInteractOutside={(event) => { if (deleting) event.preventDefault(); }}
        showCloseButton={false}
      >
        <DialogHeader className="relative flex-row items-start gap-3 border-b border-destructive/20 bg-destructive/5 px-5 py-4 pr-14 text-left">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-destructive/10 text-destructive" aria-hidden="true">
            <AlertTriangle size={21} />
          </span>
          <div className="min-w-0">
            <span className="text-xs font-semibold uppercase tracking-wide text-destructive">Ação irreversível</span>
            <DialogTitle className="mt-1 text-lg leading-snug">
              Excluir o ticket #{ticket.number} permanentemente?
            </DialogTitle>
            <DialogDescription className="mt-1">
              Esta ação não pode ser desfeita e remove os dados derivados deste
              atendimento do SQLite.
            </DialogDescription>
          </div>
          <Button
            aria-label="Fechar confirmação de exclusão do ticket"
            className="absolute right-4 top-4"
            disabled={deleting}
            onClick={onCancel}
            size="icon"
            type="button"
            variant="ghost"
          >
            <X size={18} />
          </Button>
        </DialogHeader>

        <form onSubmit={submit}>
          <div className="max-h-[calc(100dvh-14rem)] space-y-3 overflow-y-auto px-5 py-5">
            <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 p-3">
              <span className="rounded-md bg-primary/10 px-2 py-1 text-xs font-bold text-primary">#{ticket.number}</span>
              <div className="min-w-0">
                <strong className="block break-words text-sm text-foreground">{ticket.title}</strong>
                <small className="mt-1 block break-words text-xs text-muted-foreground">{ticket.client.name} · {ticket.group.subject}</small>
              </div>
            </div>

            <section className="flex gap-3 rounded-lg border border-destructive/20 bg-destructive/5 p-3">
              <Trash2 className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" size={18} />
              <div>
                <strong className="block text-xs text-foreground">O ticket e todo o trabalho gerado serão apagados</strong>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Status, categorias, análises automáticas, sugestões, resolução,
                  eventos internos e as investigações legadas vinculadas deixarão de
                  existir.
                </p>
              </div>
            </section>

            <section className="flex gap-3 rounded-lg border border-emerald-200 bg-emerald-50/70 p-3">
              <ShieldCheck className="mt-0.5 shrink-0 text-emerald-700" aria-hidden="true" size={18} />
              <div>
                <strong className="block text-xs text-emerald-950">A conversa original do WhatsApp permanece</strong>
                <p className="mt-1 text-xs leading-relaxed text-emerald-900/75">
                  Mensagens e anexos capturados continuam no histórico bruto. A
                  exclusão remove somente o ticket e seus resultados derivados.
                </p>
              </div>
            </section>

            <label className="grid gap-1.5 text-xs text-foreground">
              <span>
                Para confirmar, digite <strong>{DELETE_CONFIRMATION}</strong>
              </span>
              <Input
                autoComplete="off"
                disabled={deleting}
                onChange={(event) => setConfirmation(event.target.value)}
                placeholder={DELETE_CONFIRMATION}
                ref={inputRef}
                spellCheck={false}
                value={confirmation}
              />
            </label>

            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <MessageSquareText className="shrink-0" aria-hidden="true" size={15} />
              <span>A captura do WhatsApp continua operando normalmente.</span>
            </div>
          </div>

          <DialogFooter className="m-0 flex-row px-5 py-4 max-[520px]:flex-col-reverse">
            <Button
              className="max-[520px]:w-full"
              disabled={deleting}
              onClick={onCancel}
              type="button"
              variant="outline"
            >
              Cancelar
            </Button>
            <Button
              className="max-[520px]:w-full"
              disabled={!confirmed || deleting}
              type="submit"
              variant="destructive"
            >
              {deleting ? (
                <LoaderCircle className="animate-spin" size={16} />
              ) : (
                <Trash2 size={16} />
              )}
              <span aria-live="polite">
                {deleting ? "Excluindo…" : "Excluir ticket permanentemente"}
              </span>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
