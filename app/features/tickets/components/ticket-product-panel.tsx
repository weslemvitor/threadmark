import { Bug, ExternalLink, Pencil } from "lucide-react";

import { Button } from "@/app/components/ui/button";
import { formatFullDate } from "@/app/lib/format";
import type { TicketDetail as TicketDetailType } from "@/app/lib/types";

function safeExternalReferenceUrl(reference: string | null): string | null {
  if (!reference) return null;
  try {
    const url = new URL(reference);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function ProductForwardingPanel({
  ticket,
  onOpen,
}: {
  ticket: TicketDetailType;
  onOpen: () => void;
}) {
  const forwarding = ticket.productForwarding;
  if (!forwarding) return null;
  const referenceUrl = safeExternalReferenceUrl(forwarding.externalReference);

  return (
    <section
      aria-label="Bug encaminhado para Produto"
      className="border-b border-border px-3.5 py-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-rose-600">
            <Bug size={13} /> Produto
          </span>
          <h3 className="mt-1 text-sm font-semibold text-foreground">Bug encaminhado</h3>
        </div>
        <span className="rounded-full bg-rose-50 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-rose-700 ring-1 ring-inset ring-rose-200">Registrado</span>
      </div>
      <article className="mt-3 rounded-xl border border-rose-200 bg-rose-50/60 p-3">
        <header className="flex items-start gap-3">
          <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-lg bg-rose-100 text-rose-700">
            <Bug size={16} />
          </span>
          <div className="min-w-0">
            <small className="block text-xs font-semibold uppercase tracking-wide text-rose-700">Bug</small>
            <strong className="mt-0.5 block break-words text-sm text-foreground">{forwarding.title}</strong>
          </div>
        </header>
        <p className="mt-2.5 break-words text-xs leading-relaxed text-muted-foreground">{forwarding.description}</p>
        {forwarding.externalReference ? (
          <div className="mt-3 rounded-lg border border-rose-200/80 bg-background/70 p-2.5">
            <small className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Referência externa</small>
            {referenceUrl ? (
              <a className="mt-1 inline-flex max-w-full items-center gap-1 break-all text-xs font-medium text-primary hover:underline" href={referenceUrl} rel="noreferrer" target="_blank">
                {forwarding.externalReference} <ExternalLink size={11} />
              </a>
            ) : (
              <span className="mt-1 block break-all text-xs text-foreground">{forwarding.externalReference}</span>
            )}
          </div>
        ) : null}
        <footer className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-rose-200/80 pt-3">
          <span className="text-xs text-muted-foreground">
            Atualizado por {forwarding.updatedBy} · {formatFullDate(forwarding.updatedAt)}
          </span>
          <Button onClick={onOpen} size="sm" type="button" variant="outline">
            <Pencil size={13} /> Editar bug
          </Button>
        </footer>
      </article>
    </section>
  );
}
