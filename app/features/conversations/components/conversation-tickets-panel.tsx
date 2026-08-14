"use client";

import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  LoaderCircle,
  Search,
  TicketCheck,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/app/components/ui/sheet";
import { getConversationTickets } from "@/app/lib/api";
import { activeStatuses, statusLabels } from "@/app/lib/format";
import {
  TICKET_STATUSES,
  type ConversationTicketListResponse,
  type ConversationTicketReferenceDto,
  type TicketStatus,
} from "@/shared/contracts";

const PREVIEW_LIMIT = 3;
const PAGE_LIMIT = 10;
const ALL_STATUSES = "all";
const HISTORY_STATUSES = "history";
type StatusFilter =
  | TicketStatus
  | typeof ALL_STATUSES
  | typeof HISTORY_STATUSES;

const EMPTY_SUMMARY: ConversationTicketListResponse["summary"] = {
  all: 0,
  active: 0,
  resolved: 0,
  archived: 0,
};

function ticketCountLabel(count: number): string {
  return `${count} ${count === 1 ? "ticket" : "tickets"}`;
}

function linkedTicketsLabel(count: number): string {
  return `${ticketCountLabel(count)} ${count === 1 ? "vinculado" : "vinculados"} ao histórico`;
}

function displayedTicketsLabel(count: number): string {
  return `${ticketCountLabel(count)} ${count === 1 ? "exibido" : "exibidos"}`;
}

function displayedTicketsProgressLabel(count: number, total: number): string {
  if (count >= total) return displayedTicketsLabel(count);
  return `${count} de ${ticketCountLabel(total)} exibidos`;
}

function statusesForFilter(filter: StatusFilter): TicketStatus[] | undefined {
  if (filter === ALL_STATUSES) return undefined;
  if (filter === HISTORY_STATUSES) return ["resolved", "archived"];
  return [filter];
}

function TicketLink({
  ticket,
  onOpen,
}: {
  ticket: ConversationTicketReferenceDto;
  onOpen: (ticketId: string) => void;
}) {
  return (
    <Button
      className="flex h-auto w-full min-w-0 items-center justify-start gap-2 p-2 text-left"
      onClick={() => onOpen(ticket.id)}
      type="button"
      variant="outline"
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <b className="text-xs text-primary">#{ticket.number}</b>
        <strong className="mt-0.5 truncate text-xs text-foreground">
          {ticket.title}
        </strong>
      </span>
      <Badge className="max-w-32" variant="secondary">
        <span className="truncate">{statusLabels[ticket.status]}</span>
      </Badge>
    </Button>
  );
}

export function ConversationTicketsPanel({
  conversationId,
  refreshVersion,
  onOpenTicket,
}: {
  conversationId: string;
  refreshVersion: number;
  onOpenTicket: (ticketId: string) => void;
}) {
  const listRequestRef = useRef(0);
  const [preview, setPreview] = useState<ConversationTicketReferenceDto[]>([]);
  const [summary, setSummary] = useState(EMPTY_SUMMARY);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewRetryVersion, setPreviewRetryVersion] = useState(0);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState<StatusFilter>(ALL_STATUSES);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [items, setItems] = useState<ConversationTicketReferenceDto[]>([]);
  const [listTotal, setListTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      setPreviewLoading(true);
      setPreviewError(null);
      void getConversationTickets(conversationId, {
        limit: PREVIEW_LIMIT,
        statuses: activeStatuses,
      })
        .then((response) => {
          if (!active) return;
          setPreview(response.items);
          setSummary(response.summary);
        })
        .catch((error) => {
          if (!active) return;
          setPreviewError(
            error instanceof Error
              ? error.message
              : "Não foi possível carregar os tickets desta conversa.",
          );
        })
        .finally(() => {
          if (active) setPreviewLoading(false);
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [conversationId, previewRetryVersion, refreshVersion]);

  useEffect(() => {
    if (!sheetOpen) return;
    const timer = window.setTimeout(() => {
      const requestId = ++listRequestRef.current;
      setListLoading(true);
      setListError(null);
      setItems([]);
      setListTotal(0);
      setNextCursor(null);
      setHasMore(false);
      void getConversationTickets(conversationId, {
        limit: PAGE_LIMIT,
        query: debouncedQuery,
        statuses: statusesForFilter(selectedStatus),
      })
        .then((response) => {
          if (listRequestRef.current !== requestId) return;
          setItems(response.items);
          setListTotal(response.total);
          setSummary(response.summary);
          setNextCursor(response.nextCursor);
          setHasMore(response.hasMore);
        })
        .catch((error) => {
          if (listRequestRef.current !== requestId) return;
          setListError(
            error instanceof Error
              ? error.message
              : "Não foi possível carregar o histórico de tickets.",
          );
        })
        .finally(() => {
          if (listRequestRef.current === requestId) setListLoading(false);
        });
    }, 0);
    return () => {
      window.clearTimeout(timer);
      listRequestRef.current += 1;
    };
  }, [conversationId, debouncedQuery, refreshVersion, selectedStatus, sheetOpen]);

  const openSheet = useCallback((status: StatusFilter) => {
    setSelectedStatus(status);
    setQuery("");
    setDebouncedQuery("");
    setSheetOpen(true);
  }, []);

  const openTicket = useCallback((ticketId: string) => {
    setSheetOpen(false);
    onOpenTicket(ticketId);
  }, [onOpenTicket]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    const requestId = listRequestRef.current;
    setLoadingMore(true);
    setListError(null);
    try {
      const response = await getConversationTickets(conversationId, {
        cursor: nextCursor,
        limit: PAGE_LIMIT,
        query: debouncedQuery,
        statuses: statusesForFilter(selectedStatus),
      });
      if (listRequestRef.current !== requestId) return;
      setItems((current) => {
        const byId = new Map(current.map((ticket) => [ticket.id, ticket]));
        for (const ticket of response.items) byId.set(ticket.id, ticket);
        return [...byId.values()];
      });
      setNextCursor(response.nextCursor);
      setHasMore(response.hasMore);
      setListTotal(response.total);
    } catch (error) {
      if (listRequestRef.current !== requestId) return;
      setListError(
        error instanceof Error
          ? error.message
          : "Não foi possível carregar mais tickets.",
      );
    } finally {
      if (listRequestRef.current === requestId) setLoadingMore(false);
    }
  }, [conversationId, debouncedQuery, loadingMore, nextCursor, selectedStatus]);

  const historyTotal = summary.resolved + summary.archived;
  if (!previewLoading && !previewError && summary.all === 0) return null;

  return (
    <section className="border-b border-border bg-card p-3.5 max-[1050px]:p-3">
      <div className="flex items-start gap-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <TicketCheck size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">
            Tickets nesta conversa
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {previewLoading ? "Carregando vínculos…" : linkedTicketsLabel(summary.all)}
          </p>
        </div>
      </div>

      {previewError ? (
        <div className="mt-3 rounded-lg border border-destructive/20 bg-destructive/5 p-2.5 text-xs text-destructive">
          <span className="flex items-start gap-2">
            <CircleAlert className="mt-0.5 shrink-0" size={14} />
            <span className="min-w-0 break-words">{previewError}</span>
          </span>
          <Button
            className="mt-2 w-full"
            onClick={() => setPreviewRetryVersion((current) => current + 1)}
            size="sm"
            type="button"
            variant="outline"
          >
            Tentar novamente
          </Button>
        </div>
      ) : previewLoading ? (
        <div className="mt-3 flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground">
          <LoaderCircle className="animate-spin" size={14} /> Carregando tickets
        </div>
      ) : (
        <>
          <div className="mt-3 flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-foreground">Ativos</span>
            <span className="text-xs text-muted-foreground">{summary.active}</span>
          </div>
          <div className="mt-2 grid gap-2">
            {preview.length ? (
              preview.map((ticket) => (
                <TicketLink key={ticket.id} onOpen={openTicket} ticket={ticket} />
              ))
            ) : (
              <p className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                Nenhum ticket ativo nesta conversa.
              </p>
            )}
          </div>
          {summary.active > preview.length ? (
            <p className="mt-2 text-center text-xs text-muted-foreground">
              Mais {summary.active - preview.length}{" "}
              {summary.active - preview.length === 1 ? "ativo" : "ativos"} no histórico
            </p>
          ) : null}
          <div className="mt-3 grid gap-2">
            {historyTotal ? (
              <Button
                className="w-full justify-between"
                onClick={() => openSheet(HISTORY_STATUSES)}
                size="sm"
                type="button"
                variant="ghost"
              >
                Histórico concluído ({historyTotal})
                <ChevronRight size={14} />
              </Button>
            ) : null}
            <Button
              className="w-full"
              onClick={() => openSheet(ALL_STATUSES)}
              size="sm"
              type="button"
              variant="outline"
            >
              {summary.all === 1
                ? "Ver o ticket"
                : `Ver todos os ${ticketCountLabel(summary.all)}`}
              <ChevronRight size={14} />
            </Button>
          </div>
        </>
      )}

      <Sheet onOpenChange={setSheetOpen} open={sheetOpen}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Tickets desta conversa</SheetTitle>
            <SheetDescription>
              Pesquise e filtre o histórico sem aumentar a lateral da triagem.
            </SheetDescription>
          </SheetHeader>

          <div className="grid shrink-0 gap-2 border-b border-border p-4">
            <label className="relative block">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" size={14} />
              <Input
                aria-label="Buscar tickets desta conversa"
                className="pl-8"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Buscar por número ou título"
                value={query}
              />
            </label>
            <Select
              onValueChange={(value) => setSelectedStatus(value as StatusFilter)}
              value={selectedStatus}
            >
              <SelectTrigger aria-label="Filtrar tickets por status" className="w-full">
                <SelectValue placeholder="Todos os status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_STATUSES}>Todos os status</SelectItem>
                <SelectItem value={HISTORY_STATUSES}>Resolvidos e arquivados</SelectItem>
                {TICKET_STATUSES.map((status) => (
                  <SelectItem key={status} value={status}>
                    {statusLabels[status]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {listLoading ? (
              <div className="flex h-32 items-center justify-center gap-2 text-xs text-muted-foreground">
                <LoaderCircle className="animate-spin" size={15} /> Carregando histórico
              </div>
            ) : items.length ? (
              <div className="grid gap-2">
                <p className="mb-1 text-xs text-muted-foreground">
                  {displayedTicketsProgressLabel(items.length, listTotal)}
                </p>
                {items.map((ticket) => (
                  <TicketLink key={ticket.id} onOpen={openTicket} ticket={ticket} />
                ))}
                {hasMore ? (
                  <div className="flex justify-center pt-2">
                    <Button
                      disabled={loadingMore}
                      onClick={() => void loadMore()}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      {loadingMore ? (
                        <LoaderCircle className="animate-spin" size={14} />
                      ) : (
                        <ChevronDown size={14} />
                      )}
                      Carregar mais tickets
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="flex h-32 items-center justify-center rounded-lg border border-dashed border-border px-6 text-center text-xs text-muted-foreground">
                Nenhum ticket encontrado para estes filtros.
              </div>
            )}
            {listError ? (
              <p className="mt-3 rounded-lg border border-destructive/20 bg-destructive/5 p-2.5 text-xs text-destructive">
                {listError}
              </p>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </section>
  );
}
