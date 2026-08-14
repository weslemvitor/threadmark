import { Button } from "@/app/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import { Input } from "@/app/components/ui/input";
import { Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import {
  formatRelativeTime,
  getCategoryName,
  getClientName,
  getRequesterPresentation,
  getStoreName,
  getTicketTimestamp,
  statusLabels,
} from "@/app/lib/format";
import type { TicketSummary } from "@/app/lib/types";

type SupportSearchOverlayProps = {
  tickets: TicketSummary[];
  onClose: () => void;
  onOpenTicket: (ticketId: string) => void;
};

function matchesQuery(ticket: TicketSummary, query: string): boolean {
  if (!query) return true;
  const requester = getRequesterPresentation(ticket.requester);
  return [
    ticket.title,
    ticket.summary,
    getClientName(ticket),
    getStoreName(ticket),
    requester?.name,
    requester?.phone,
    ticket.requester?.phoneE164,
    `#${ticket.number}`,
    ...ticket.categories.map(getCategoryName),
  ]
    .filter(Boolean)
    .some((value) => value?.toLocaleLowerCase("pt-BR").includes(query));
}

export function SupportSearchOverlay({
  tickets,
  onClose,
  onOpenTicket,
}: SupportSearchOverlayProps) {
  const [query, setQuery] = useState("");
  const results = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("pt-BR");
    return tickets
      .filter((ticket) => ticket.status !== "archived")
      .filter((ticket) => matchesQuery(ticket, normalizedQuery))
      .sort(
        (left, right) =>
          new Date(getTicketTimestamp(right) ?? 0).getTime() -
          new Date(getTicketTimestamp(left) ?? 0).getTime(),
      )
      .slice(0, 12);
  }, [query, tickets]);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        aria-label="Buscar tickets"
        className="max-h-[min(720px,calc(100dvh-2rem))] max-w-xl gap-0 overflow-hidden p-0"
        data-support-search-overlay="true"
        showCloseButton={false}
      >
        <DialogHeader className="flex-row items-start justify-between gap-3 border-b border-border px-5 py-4 text-left">
          <div>
            <span className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">Busca global</span>
            <DialogTitle className="mt-1 text-lg">Buscar no suporte</DialogTitle>
            <DialogDescription className="sr-only">
              Localize e abra o contexto completo de um ticket.
            </DialogDescription>
          </div>
          <Button aria-label="Fechar busca" onClick={onClose} size="icon" type="button" variant="ghost">
            <X size={17} />
          </Button>
        </DialogHeader>
        <label className="relative mx-5 mt-4 block">
          <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={17} />
          <Input
            aria-keyshortcuts="Meta+K Control+K"
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Grupo, solicitante, assunto, categoria ou número"
            className="h-10 pl-10 pr-14"
            type="search"
            value={query}
          />
          <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border border-border bg-muted px-1.5 py-0.5 text-2xs font-semibold text-muted-foreground">ESC</kbd>
        </label>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4 pt-3">
          <div className="mb-2 text-xs font-medium text-muted-foreground">
            {query.trim() ? `${results.length} resultado(s)` : "Tickets recentes"}
          </div>
          {results.map((ticket) => {
            const requester = getRequesterPresentation(ticket.requester);
            return (
              <Button
                className="mb-2 grid h-auto w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-start gap-3 rounded-lg border border-border px-3 py-3 text-left hover:bg-muted/50"
                key={ticket.id}
                onClick={() => onOpenTicket(ticket.id)}
                size="unstyled"
                type="button"
                variant="unstyled"
              >
                <span className="min-w-0">
                  <small className="text-xs font-semibold text-primary">#{ticket.number}</small>
                  <strong className="mt-0.5 block truncate text-sm text-foreground">{ticket.title}</strong>
                  <em className="mt-1 block truncate text-xs not-italic text-muted-foreground">
                    {getClientName(ticket)}
                    {getStoreName(ticket) ? ` · ${getStoreName(ticket)}` : ""}
                    {requester ? ` · ${requester.compact}` : ""}
                  </em>
                </span>
                <span className="text-right">
                  <b className="block whitespace-nowrap text-xs font-semibold text-primary">{statusLabels[ticket.status]}</b>
                  <time className="mt-1 block whitespace-nowrap text-xs text-muted-foreground">{formatRelativeTime(getTicketTimestamp(ticket))}</time>
                </span>
              </Button>
            );
          })}
          {!results.length ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-xs text-muted-foreground">
              Nenhum ticket encontrado para “{query.trim()}”.
            </div>
          ) : null}
        </div>
        <footer className="border-t border-border bg-muted/40 px-5 py-3 text-center text-xs text-muted-foreground">
          O contexto permanece salvo no SQLite e será aberto em uma página isolada.
        </footer>
      </DialogContent>
    </Dialog>
  );
}
