import {
  Archive,
  ArchiveRestore,
  CheckCircle2,
  Columns3,
  ListChecks,
  LoaderCircle,
  MoreHorizontal,
  RefreshCw,
  Search,
  TicketPlus,
  UserRoundCheck,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getArchivedTickets, getResolvedTickets } from "@/app/lib/api";
import type { TicketAssignee, TicketStatus, TicketSummary } from "@/app/lib/types";
import { matchesTicketSearch } from "@/app/lib/ticket-search";
import {
  KANBAN_BULK_SELECTION_LIMIT,
  toggleAllVisibleKanbanTickets,
  toggleKanbanSelection,
} from "@/app/lib/kanban-selection";
import { getNextKanbanTab, type KanbanTab } from "@/app/lib/kanban-tabs";
import { Button } from "@/app/components/ui/button";
import { Card } from "@/app/components/ui/card";
import { Input } from "@/app/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { EmptyState, LoadingState } from "@/app/components/shared/ui-states";
import { cn } from "@/app/lib/utils";
import { KanbanCard } from "./kanban-card";
import { getKanbanTicketTimestamp } from "../domain/kanban-ticket";

type KanbanColumn = {
  id: string;
  label: string;
  description: string;
  statuses: TicketStatus[];
  targetStatus: TicketStatus;
  accent: string;
};

type KanbanMode = KanbanTab;

const KANBAN_PAGE_SIZE = 5;

const columns: KanbanColumn[] = [
  {
    id: "todo",
    label: "A revisar",
    description: "Novas demandas e triagem",
    statuses: ["new", "triage"],
    targetStatus: "triage",
    accent: "violet",
  },
  {
    id: "progress",
    label: "Em andamento",
    description: "Investigação ou resposta",
    statuses: ["in_progress"],
    targetStatus: "in_progress",
    accent: "blue",
  },
  {
    id: "waiting",
    label: "Aguardando",
    description: "Solicitante ou time interno",
    statuses: ["waiting_customer", "blocked"],
    targetStatus: "waiting_customer",
    accent: "amber",
  },
  {
    id: "done",
    label: "Resolvidos",
    description: "Solução confirmada",
    statuses: ["resolved"],
    targetStatus: "resolved",
    accent: "green",
  },
];

const initialColumnLimits = Object.fromEntries(
  columns.map((column) => [column.id, KANBAN_PAGE_SIZE]),
) as Record<string, number>;

const columnAccentClasses: Record<string, string> = {
  violet: "bg-primary shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_20%,transparent)]",
  blue: "bg-blue-500 shadow-[0_0_0_3px_color-mix(in_oklch,var(--color-blue-500)_20%,transparent)]",
  amber: "bg-amber-500 shadow-[0_0_0_3px_color-mix(in_oklch,var(--color-amber-500)_20%,transparent)]",
  green: "bg-emerald-500 shadow-[0_0_0_3px_color-mix(in_oklch,var(--color-emerald-500)_20%,transparent)]",
};

function sortTickets(
  items: TicketSummary[],
  mode: KanbanMode,
  columnId?: string,
): TicketSummary[] {
  return items.toSorted(
    (left, right) =>
      new Date(getKanbanTicketTimestamp(right, mode, columnId)).getTime() -
      new Date(getKanbanTicketTimestamp(left, mode, columnId)).getTime(),
  );
}

function mergeTickets(
  current: TicketSummary[],
  incoming: TicketSummary[],
  prepend = false,
): TicketSummary[] {
  const incomingIds = new Set(incoming.map((ticket) => ticket.id));
  const uniqueCurrent = current.filter((ticket) => !incomingIds.has(ticket.id));
  return prepend ? [...incoming, ...uniqueCurrent] : [...uniqueCurrent, ...incoming];
}

export function KanbanView({
  tickets,
  loading,
  onOpenTicket,
  onCreateManualTicket,
  canCreateTicket,
  onMoveTicket,
  onBulkStatusChange,
  assignees,
  currentUserId,
  canAssignTicket,
  assigningTicketId,
  onAssignTicket,
}: {
  tickets: TicketSummary[];
  loading: boolean;
  onOpenTicket: (id: string) => void;
  onCreateManualTicket: () => void;
  canCreateTicket: boolean;
  onMoveTicket: (id: string, status: TicketStatus) => void;
  onBulkStatusChange: (
    ticketIds: string[],
    status: "archived" | "resolved",
  ) => Promise<TicketSummary[] | null>;
  assignees: TicketAssignee[];
  currentUserId: string | null;
  canAssignTicket: boolean;
  assigningTicketId: string | null;
  onAssignTicket: (
    ticketId: string,
    assigneeId: string | null,
  ) => Promise<boolean>;
}) {
  const [mode, setMode] = useState<KanbanMode>("active");
  const [query, setQuery] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState("all");
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  const [columnLimits, setColumnLimits] =
    useState<Record<string, number>>(initialColumnLimits);
  const [archivedVisibleCount, setArchivedVisibleCount] =
    useState(KANBAN_PAGE_SIZE);
  const [resolvedTickets, setResolvedTickets] = useState<TicketSummary[]>(() =>
    sortTickets(
      tickets.filter((ticket) => ticket.status === "resolved"),
      "active",
      "done",
    ),
  );
  const [resolvedTotal, setResolvedTotal] = useState(resolvedTickets.length);
  const [resolvedLoaded, setResolvedLoaded] = useState(false);
  const [resolvedLoading, setResolvedLoading] = useState(false);
  const [resolvedError, setResolvedError] = useState<string | null>(null);
  const resolvedRequestRef = useRef(0);
  const ticketStatusSnapshotRef = useRef(
    new Map(tickets.map((ticket) => [ticket.id, ticket.status] as const)),
  );
  const [archivedTickets, setArchivedTickets] = useState<TicketSummary[]>([]);
  const [archivedTotal, setArchivedTotal] = useState(0);
  const [archivedLoaded, setArchivedLoaded] = useState(false);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [archivedError, setArchivedError] = useState<string | null>(null);
  const archivedRequestRef = useRef(0);
  const activeTabRef = useRef<HTMLButtonElement>(null);
  const archivedTabRef = useRef<HTMLButtonElement>(null);

  const activeTickets = useMemo(
    () => tickets.filter(
      (ticket) => ticket.status !== "archived" && ticket.status !== "resolved",
    ),
    [tickets],
  );
  const matchesAssignee = useCallback(
    (ticket: TicketSummary) => {
      if (assigneeFilter === "all") return true;
      if (assigneeFilter === "mine") {
        return Boolean(currentUserId && ticket.assignee?.id === currentUserId);
      }
      if (assigneeFilter === "unassigned") return !ticket.assignee;
      return ticket.assignee?.id === assigneeFilter.replace(/^user:/u, "");
    },
    [assigneeFilter, currentUserId],
  );
  const hasActiveFilters = Boolean(query.trim()) || assigneeFilter !== "all";
  const filteredActiveTickets = useMemo(
    () => activeTickets.filter(
      (ticket) => matchesTicketSearch(ticket, query) && matchesAssignee(ticket),
    ),
    [activeTickets, matchesAssignee, query],
  );
  const filteredResolvedTickets = useMemo(
    () => hasActiveFilters
      ? sortTickets(
          tickets.filter(
            (ticket) =>
              ticket.status === "resolved" &&
              matchesTicketSearch(ticket, query) &&
              matchesAssignee(ticket),
          ),
          "active",
          "done",
        )
      : resolvedTickets.filter(matchesAssignee),
    [hasActiveFilters, matchesAssignee, query, resolvedTickets, tickets],
  );
  const filteredArchivedTickets = useMemo(
    () => archivedTickets.filter(
      (ticket) => matchesTicketSearch(ticket, query) && matchesAssignee(ticket),
    ),
    [archivedTickets, matchesAssignee, query],
  );
  const sortedArchivedTickets = useMemo(
    () => sortTickets(filteredArchivedTickets, "archived"),
    [filteredArchivedTickets],
  );
  const visibleResolvedTickets = filteredResolvedTickets.slice(
    0,
    columnLimits.done ?? KANBAN_PAGE_SIZE,
  );
  const visibleArchivedTickets = sortedArchivedTickets.slice(
    0,
    archivedVisibleCount,
  );
  const selectableTickets = mode === "active"
    ? visibleResolvedTickets
    : visibleArchivedTickets;
  const selectableIds = new Set(selectableTickets.map((ticket) => ticket.id));
  const selectedVisibleIds = [...selectedIds].filter((ticketId) => selectableIds.has(ticketId));
  const allVisibleSelected = selectableTickets.length > 0 &&
    selectableTickets.every((ticket) => selectedIds.has(ticket.id));

  const loadResolved = useCallback(async (reset: boolean) => {
    if (resolvedLoading && !reset) return;
    const requestId = resolvedRequestRef.current + 1;
    resolvedRequestRef.current = requestId;
    setResolvedLoading(true);
    setResolvedError(null);
    try {
      const offset = reset ? 0 : resolvedTickets.length;
      const response = await getResolvedTickets({
        offset,
        limit: KANBAN_PAGE_SIZE,
      });
      if (resolvedRequestRef.current !== requestId) return;
      setResolvedTickets((current) => reset
        ? response.items
        : mergeTickets(current, response.items));
      setResolvedTotal(response.total);
    } catch (error) {
      if (resolvedRequestRef.current !== requestId) return;
      setResolvedError(
        error instanceof Error
          ? error.message
          : "Não foi possível carregar os tickets resolvidos.",
      );
    } finally {
      if (resolvedRequestRef.current === requestId) {
        setResolvedLoaded(true);
        setResolvedLoading(false);
      }
    }
  }, [resolvedLoading, resolvedTickets.length]);

  useEffect(() => {
    if (loading || resolvedLoaded || resolvedLoading) return;
    const timer = window.setTimeout(() => void loadResolved(true), 0);
    return () => window.clearTimeout(timer);
  }, [loadResolved, loading, resolvedLoaded, resolvedLoading]);

  useEffect(() => {
    const previousStatuses = ticketStatusSnapshotRef.current;
    const newlyResolved = tickets.filter(
      (ticket) =>
        previousStatuses.has(ticket.id) &&
        previousStatuses.get(ticket.id) !== "resolved" &&
        ticket.status === "resolved",
    );
    const reopenedIds = new Set(
      tickets
        .filter(
          (ticket) =>
            previousStatuses.get(ticket.id) === "resolved" &&
            ticket.status !== "resolved",
        )
        .map((ticket) => ticket.id),
    );
    ticketStatusSnapshotRef.current = new Map(
      tickets.map((ticket) => [ticket.id, ticket.status] as const),
    );
    if (!newlyResolved.length && !reopenedIds.size) return;

    const timer = window.setTimeout(() => {
      setResolvedTickets((current) =>
        sortTickets(
          mergeTickets(
            current.filter((ticket) => !reopenedIds.has(ticket.id)),
            newlyResolved,
            true,
          ),
          "active",
          "done",
        )
      );
      setResolvedTotal((current) =>
        Math.max(0, current + newlyResolved.length - reopenedIds.size)
      );
      void loadResolved(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadResolved, tickets]);

  async function loadArchived(reset: boolean) {
    if (archivedLoading && !reset) return;
    const requestId = archivedRequestRef.current + 1;
    archivedRequestRef.current = requestId;
    setArchivedLoading(true);
    setArchivedError(null);
    try {
      const offset = reset ? 0 : archivedTickets.length;
      const response = await getArchivedTickets({
        offset,
        limit: KANBAN_PAGE_SIZE,
      });
      if (archivedRequestRef.current !== requestId) return;
      setArchivedTickets((current) => reset
        ? response.items
        : mergeTickets(current, response.items));
      setArchivedTotal(response.total);
      setArchivedLoaded(true);
    } catch (error) {
      if (archivedRequestRef.current !== requestId) return;
      setArchivedError(
        error instanceof Error
          ? error.message
          : "Não foi possível carregar os tickets arquivados.",
      );
    } finally {
      if (archivedRequestRef.current === requestId) {
        setArchivedLoading(false);
      }
    }
  }

  function updateQuery(nextQuery: string) {
    setQuery(nextQuery);
    setColumnLimits(initialColumnLimits);
    setArchivedVisibleCount(KANBAN_PAGE_SIZE);
    setSelectedIds(new Set());
    setBulkError(null);
    setSelectionNotice(null);
  }

  function updateAssigneeFilter(value: string) {
    setAssigneeFilter(value);
    setColumnLimits(initialColumnLimits);
    setArchivedVisibleCount(KANBAN_PAGE_SIZE);
    setSelectedIds(new Set());
  }

  function switchMode(nextMode: KanbanMode) {
    setMode(nextMode);
    setColumnLimits(initialColumnLimits);
    setArchivedVisibleCount(KANBAN_PAGE_SIZE);
    setSelectionMode(false);
    setSelectedIds(new Set());
    setBulkError(null);
    setSelectionNotice(null);
    if (nextMode === "archived") setAssigneeFilter("all");
    if (nextMode === "archived" && !archivedLoaded) void loadArchived(true);
  }

  function handleTabKeyDown(
    event: React.KeyboardEvent<HTMLButtonElement>,
    currentMode: KanbanMode,
  ) {
    const nextMode = getNextKanbanTab(currentMode, event.key);
    if (!nextMode) return;
    event.preventDefault();
    if (nextMode !== currentMode) switchMode(nextMode);
    (nextMode === "active" ? activeTabRef : archivedTabRef).current?.focus();
  }

  function toggleSelectionMode() {
    setSelectionMode((current) => !current);
    setSelectedIds(new Set());
    setBulkError(null);
    setSelectionNotice(null);
  }

  function toggleTicket(ticketId: string) {
    const result = toggleKanbanSelection(selectedIds, ticketId);
    setSelectedIds(result.selectedIds);
    setSelectionNotice(result.limitReached
      ? `O limite é de ${KANBAN_BULK_SELECTION_LIMIT} tickets por operação.`
      : null);
  }

  function toggleAllVisible() {
    const result = toggleAllVisibleKanbanTickets(
      selectedIds,
      selectableTickets.map((ticket) => ticket.id),
    );
    setSelectedIds(result.selectedIds);
    setSelectionNotice(result.limitReached
      ? `Foram selecionados os primeiros ${KANBAN_BULK_SELECTION_LIMIT} tickets visíveis. Esse é o limite por operação.`
      : null);
  }

  async function runBulkAction() {
    if (!selectedVisibleIds.length || bulkBusy) return;
    if (mode === "active" && (!resolvedLoaded || resolvedLoading)) {
      setSelectionNotice("Aguarde a atualização da coluna Resolvidos para continuar.");
      return;
    }
    if (mode === "archived" && archivedLoading) {
      setSelectionNotice("Aguarde a atualização dos tickets arquivados para continuar.");
      return;
    }
    if (selectedVisibleIds.length > KANBAN_BULK_SELECTION_LIMIT) {
      setSelectionNotice(
        `O limite é de ${KANBAN_BULK_SELECTION_LIMIT} tickets por operação.`,
      );
      return;
    }
    setBulkBusy(true);
    setBulkError(null);
    const targetStatus = mode === "active" ? "archived" : "resolved";
    try {
      const updated = await onBulkStatusChange(selectedVisibleIds, targetStatus);
      if (!updated) {
        setBulkError("A operação não foi concluída. Tente novamente.");
        return;
      }
      if (targetStatus === "archived") {
        const updatedIds = new Set(updated.map((ticket) => ticket.id));
        setResolvedTickets((current) =>
          current.filter((ticket) => !updatedIds.has(ticket.id))
        );
        setResolvedTotal((current) => Math.max(0, current - updated.length));
        if (archivedLoaded) {
          setArchivedTickets((current) => mergeTickets(current, updated, true));
          setArchivedTotal((current) => current + updated.length);
        }
      } else {
        const updatedIds = new Set(updated.map((ticket) => ticket.id));
        setArchivedTickets((current) => current.filter((ticket) => !updatedIds.has(ticket.id)));
        setArchivedTotal((current) => Math.max(0, current - updated.length));
        setResolvedTickets((current) =>
          sortTickets(mergeTickets(current, updated, true), "active", "done")
            .slice(0, KANBAN_PAGE_SIZE)
        );
        setResolvedTotal((current) => current + updated.length);
      }
      void loadResolved(true);
      void loadArchived(true);
      setSelectedIds(new Set());
      setSelectionMode(false);
      setSelectionNotice(null);
    } finally {
      setBulkBusy(false);
    }
  }

  if (loading) return <LoadingState label="Organizando o Kanban…" />;

  return (
    <div className="min-h-full w-full overflow-x-hidden px-4 py-4 sm:px-5 sm:py-5">
      <Card className="mb-4 grid gap-3 rounded-xl border border-border bg-card p-3 shadow-sm" variant="unstyled">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <Columns3 size={18} />
          </span>
          <p className="flex min-w-0 flex-col">
            <strong className="text-sm font-semibold text-foreground">Fluxo operacional</strong>
            <small className="mt-0.5 text-xs leading-relaxed text-muted-foreground">Arquivar organiza o Kanban sem excluir mensagens, anexos ou investigações.</small>
          </p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {canCreateTicket ? (
            <Button
              aria-label="Criar ticket manualmente"
              className="h-9 w-full text-xs sm:w-auto"
              onClick={onCreateManualTicket}
              size="default"
              type="button"
              variant="default"
            >
              <TicketPlus size={14} />
              Novo ticket
            </Button>
          ) : null}
          <div
            aria-label="Pesquisar cards por título, grupo ou solicitante"
            className="flex h-9 w-full min-w-0 items-center gap-2 rounded-lg border border-input bg-background px-2.5 text-muted-foreground transition-shadow focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30 sm:min-w-72 sm:flex-1"
            role="search"
          >
            <Search aria-hidden="true" className="shrink-0" size={15} />
            <Input
              className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-sm shadow-none focus-visible:border-transparent focus-visible:ring-0"
              aria-label="Pesquisar cards por título, grupo ou solicitante"
              onChange={(event) => updateQuery(event.target.value)}
              placeholder="Pesquisar por título, grupo ou solicitante"
              type="search"
              value={query}
            />
            {query ? (
              <Button
                aria-label="Limpar pesquisa do Kanban"
                className="size-7 shrink-0"
                onClick={() => updateQuery("")}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <X size={13} />
              </Button>
            ) : null}
          </div>
          {mode === "active" ? <Select onValueChange={updateAssigneeFilter} value={assigneeFilter}>
            <SelectTrigger
              aria-label="Filtrar tickets por responsável"
              className="h-9 w-full min-w-0 bg-background sm:w-56"
            >
              <UserRoundCheck size={14} />
              <SelectValue placeholder="Responsável" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os responsáveis</SelectItem>
              {currentUserId ? <SelectItem value="mine">Meus tickets</SelectItem> : null}
              <SelectItem value="unassigned">Não atribuídos</SelectItem>
              {assignees.map((assignee) => (
                <SelectItem key={assignee.id} value={`user:${assignee.id}`}>
                  {assignee.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select> : null}
          <div
            aria-label="Visão do Kanban"
            className="inline-flex h-9 w-full min-w-0 items-center gap-1 rounded-lg border border-border bg-muted p-1 sm:w-auto"
            role="tablist"
          >
            <Button
              aria-controls="kanban-active-panel"
              aria-selected={mode === "active"}
              className={cn(
                "h-7 min-w-0 flex-1 gap-1.5 px-2.5 text-xs sm:flex-none",
                mode === "active" && "bg-background text-primary shadow-sm hover:bg-background",
              )}
              id="kanban-active-tab"
              onClick={() => switchMode("active")}
              onKeyDown={(event) => handleTabKeyDown(event, "active")}
              ref={activeTabRef}
              role="tab"
              tabIndex={mode === "active" ? 0 : -1}
              type="button"
              variant="ghost"
            >
              Fluxo
              <span className="grid min-w-5 place-items-center rounded-full bg-primary/10 px-1.5 py-0.5 text-xs font-semibold text-primary">
                {activeTickets.length + resolvedTotal}
              </span>
            </Button>
            <Button
              aria-controls="kanban-archived-panel"
              aria-selected={mode === "archived"}
              className={cn(
                "h-7 min-w-0 flex-1 gap-1.5 px-2.5 text-xs sm:flex-none",
                mode === "archived" && "bg-background text-primary shadow-sm hover:bg-background",
              )}
              id="kanban-archived-tab"
              onClick={() => switchMode("archived")}
              onKeyDown={(event) => handleTabKeyDown(event, "archived")}
              ref={archivedTabRef}
              role="tab"
              tabIndex={mode === "archived" ? 0 : -1}
              type="button"
              variant="ghost"
            >
              <Archive size={13} /> Arquivados
              {archivedLoaded ? (
                <span className="grid min-w-5 place-items-center rounded-full bg-primary/10 px-1.5 py-0.5 text-xs font-semibold text-primary">
                  {archivedTotal}
                </span>
              ) : null}
            </Button>
          </div>
          <Button
            aria-pressed={selectionMode}
            className="h-9 w-full text-xs sm:w-auto"
            disabled={
              bulkBusy ||
              (mode === "active"
                ? !resolvedLoaded || resolvedLoading || !resolvedTickets.length
                : archivedLoading || !archivedTickets.length)
            }
            onClick={toggleSelectionMode}
            size="default"
            type="button"
            variant={selectionMode ? "secondary" : "outline"}
          >
            {selectionMode ? <X size={14} /> : <ListChecks size={14} />}
            {selectionMode
              ? "Cancelar seleção"
              : mode === "active"
                ? "Selecionar resolvidos"
                : "Selecionar para restaurar"}
          </Button>
        </div>
      </Card>

      {selectionMode ? (
        <Card
          aria-label="Ações para os tickets selecionados"
          className="mb-3 flex min-h-12 flex-wrap items-center justify-between gap-2 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 shadow-sm"
          role="region"
          variant="unstyled"
        >
          <span className="text-sm text-foreground">
            <b className="text-base text-primary">{selectedVisibleIds.length}</b>{" "}
            {selectedVisibleIds.length === 1 ? "selecionado" : "selecionados"}
            <small className="text-xs text-muted-foreground"> de {KANBAN_BULK_SELECTION_LIMIT}</small>
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              disabled={
                bulkBusy ||
                !selectableTickets.length ||
                (mode === "active" && resolvedLoading) ||
                (mode === "archived" && archivedLoading)
              }
              onClick={toggleAllVisible}
              size="sm"
              type="button"
              variant="outline"
            >
              {allVisibleSelected ? "Desmarcar todos" : "Selecionar todos os visíveis"}
            </Button>
            <Button
              disabled={
                bulkBusy ||
                !selectedVisibleIds.length ||
                (mode === "active" && (!resolvedLoaded || resolvedLoading)) ||
                (mode === "archived" && archivedLoading)
              }
              onClick={() => void runBulkAction()}
              size="sm"
              type="button"
              variant="default"
            >
              {bulkBusy ? <LoaderCircle className="animate-spin" size={14} /> : mode === "active" ? <Archive size={14} /> : <ArchiveRestore size={14} />}
              {bulkBusy
                ? "Atualizando…"
                : mode === "active"
                  ? `Arquivar ${selectedVisibleIds.length || ""}`
                  : `Restaurar ${selectedVisibleIds.length || ""}`}
            </Button>
          </div>
        </Card>
      ) : null}
      {selectionNotice ? (
        <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800" role="status">
          {selectionNotice}
        </p>
      ) : null}
      {bulkError ? (
        <p className="mb-3 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">
          {bulkError}
        </p>
      ) : null}

      {mode === "active" ? (
        <div
          aria-labelledby="kanban-active-tab"
          className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 xl:grid-cols-4"
          id="kanban-active-panel"
          role="tabpanel"
        >
          {columns.map((column) => {
            const columnTickets = column.id === "done"
              ? filteredResolvedTickets
              : sortTickets(
                  filteredActiveTickets.filter((ticket) => column.statuses.includes(ticket.status)),
                  "active",
                  column.id,
                );
            const visibleColumnTickets = columnTickets.slice(
              0,
              columnLimits[column.id] ?? KANBAN_PAGE_SIZE,
            );
            const hasLoadedColumnTickets =
              visibleColumnTickets.length < columnTickets.length;
            const hasRemoteResolvedTickets =
              column.id === "done" &&
              !hasActiveFilters &&
              resolvedLoaded &&
              resolvedTickets.length < resolvedTotal;
            const columnTotal =
              column.id === "done" && !hasActiveFilters
                ? resolvedTotal
                : columnTickets.length;
            return (
              <section
                className={cn(
                  "min-w-0 overflow-hidden rounded-xl border border-border bg-muted/70 transition-[border-color,box-shadow]",
                  dropTarget === column.id && "border-primary/50 shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_12%,transparent)]",
                )}
                key={column.id}
                onDragEnter={() => setDropTarget(column.id)}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setDropTarget(null);
                  }
                }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  setDropTarget(null);
                  const ticketId = event.dataTransfer.getData("text/support-ticket");
                  if (ticketId) onMoveTicket(ticketId, column.targetStatus);
                }}
              >
                <header className="border-b border-border px-3 py-3">
                  <div className="flex items-center gap-2">
                    <span className={cn("size-2 rounded-full", columnAccentClasses[column.accent])} />
                    <h2 className="text-sm font-semibold text-foreground">{column.label}</h2>
                    <b className="ml-auto grid min-w-5 place-items-center rounded-full border border-border bg-background px-1.5 py-0.5 text-xs font-semibold text-muted-foreground">
                      {column.id === "done" && !hasActiveFilters ? resolvedTotal : columnTickets.length}
                    </b>
                  </div>
                  <p className="mt-1.5 ml-4 text-xs text-muted-foreground">{column.description}</p>
                </header>
                <div className="grid min-h-40 gap-2 p-2">
                  {visibleColumnTickets.map((ticket) => (
                    <KanbanCard
                      assignees={assignees}
                      assigning={assigningTicketId === ticket.id}
                      busy={bulkBusy || (selectionMode && column.id === "done" && resolvedLoading)}
                      canAssign={canAssignTicket}
                      columnId={column.id}
                      currentUserId={currentUserId}
                      key={ticket.id}
                      mode="active"
                      onDragEnd={() => setDropTarget(null)}
                      onDragStart={ticket.status === "resolved" ? undefined : (event) => {
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/support-ticket", ticket.id);
                      }}
                      onOpen={() => onOpenTicket(ticket.id)}
                      onAssign={async (assigneeId) => {
                        const updated = await onAssignTicket(ticket.id, assigneeId);
                        if (updated && column.id === "done") void loadResolved(true);
                        return updated;
                      }}
                      onToggle={() => toggleTicket(ticket.id)}
                      selectable={selectionMode && column.id === "done"}
                      selected={selectedIds.has(ticket.id)}
                      ticket={ticket}
                    />
                  ))}
                  {!visibleColumnTickets.length ? (
                    column.id === "done" && resolvedLoading ? (
                      <div className="flex min-h-28 flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border text-xs text-muted-foreground"><LoaderCircle className="animate-spin" size={18} /><span>Carregando resolvidos…</span></div>
                    ) : (
                      <div className="flex min-h-28 flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border text-xs text-muted-foreground">
                        <MoreHorizontal size={20} />
                        <span>{query.trim() ? "Nenhum resultado nesta coluna" : "Nenhum ticket aqui"}</span>
                      </div>
                    )
                  ) : null}
                  {column.id === "done" && resolvedError ? (
                    <div className="grid gap-2 rounded-lg border border-destructive/20 bg-destructive/5 p-2 text-xs leading-relaxed text-destructive" role="alert">
                      <span>{resolvedError}</span>
                      <Button onClick={() => void loadResolved(true)} size="sm" type="button" variant="outline"><RefreshCw size={12} /> Tentar novamente</Button>
                    </div>
                  ) : null}
                  {hasLoadedColumnTickets || hasRemoteResolvedTickets ? (
                    <Button
                      className="w-full text-xs"
                      disabled={
                        bulkBusy ||
                        (column.id === "done" && resolvedLoading)
                      }
                      onClick={() => {
                        setColumnLimits((current) => ({
                          ...current,
                          [column.id]:
                            (current[column.id] ?? KANBAN_PAGE_SIZE) +
                            KANBAN_PAGE_SIZE,
                        }));
                        if (
                          column.id === "done" &&
                          !hasLoadedColumnTickets &&
                          hasRemoteResolvedTickets
                        ) {
                          void loadResolved(false);
                        }
                      }}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      {column.id === "done" && resolvedLoading ? <LoaderCircle className="animate-spin" size={13} /> : <CheckCircle2 size={13} />}
                      {column.id === "done" && resolvedLoading
                        ? "Carregando…"
                        : `Carregar mais (${visibleColumnTickets.length} de ${columnTotal})`}
                    </Button>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <section
          aria-labelledby="kanban-archived-tab"
          className="min-w-0 rounded-xl border border-border bg-card p-4 shadow-sm"
          id="kanban-archived-panel"
          role="tabpanel"
        >
          <header className="mb-4 flex min-w-0 items-center gap-3 border-b border-border pb-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><Archive size={18} /></span>
            <div className="flex min-w-0 flex-1 flex-col">
              <h2 className="text-sm font-semibold text-foreground">Tickets arquivados</h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Continuam salvos por completo e podem voltar para Resolvidos a qualquer momento.</p>
            </div>
            {archivedLoaded ? <b className="whitespace-nowrap rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">{archivedTotal} no total</b> : null}
          </header>
          {archivedError ? (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">
              <span>{archivedError}</span>
              <Button disabled={archivedLoading || bulkBusy} onClick={() => void loadArchived(true)} size="sm" type="button" variant="outline"><RefreshCw size={13} /> Tentar novamente</Button>
            </div>
          ) : null}
          {archivedLoading && !archivedLoaded ? <LoadingState label="Carregando arquivados…" /> : null}
          {archivedLoaded && !filteredArchivedTickets.length ? (
            <EmptyState
              title={query.trim() ? "Nenhum card encontrado" : "Nenhum ticket arquivado"}
              description={query.trim()
                ? `Nenhum título, grupo ou solicitante corresponde a “${query.trim()}” entre os arquivados carregados.`
                : "Selecione tickets da coluna Resolvidos para organizar o histórico sem apagar dados."}
            />
          ) : null}
          {filteredArchivedTickets.length ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(245px,1fr))] gap-3">
              {visibleArchivedTickets.map((ticket) => (
                <KanbanCard
                  assignees={assignees}
                  assigning={assigningTicketId === ticket.id}
                  busy={bulkBusy || (selectionMode && archivedLoading)}
                  canAssign={canAssignTicket}
                  currentUserId={currentUserId}
                  key={ticket.id}
                  mode="archived"
                  onOpen={() => onOpenTicket(ticket.id)}
                  onAssign={async (assigneeId) => {
                    const updated = await onAssignTicket(ticket.id, assigneeId);
                    if (updated) void loadArchived(true);
                    return updated;
                  }}
                  onToggle={() => toggleTicket(ticket.id)}
                  selectable={selectionMode}
                  selected={selectedIds.has(ticket.id)}
                  ticket={ticket}
                />
              ))}
            </div>
          ) : null}
          {archivedLoaded && (
            visibleArchivedTickets.length < sortedArchivedTickets.length ||
            archivedTickets.length < archivedTotal
          ) ? (
            <Button
              className="mx-auto mt-4 min-w-45"
              disabled={archivedLoading || bulkBusy}
              onClick={() => {
                setArchivedVisibleCount((current) => current + KANBAN_PAGE_SIZE);
                if (
                  visibleArchivedTickets.length >= sortedArchivedTickets.length &&
                  archivedTickets.length < archivedTotal
                ) {
                  void loadArchived(false);
                }
              }}
              size="default"
              type="button"
              variant="outline"
            >
              {archivedLoading ? <LoaderCircle className="animate-spin" size={14} /> : <Archive size={14} />}
              {archivedLoading ? "Carregando…" : `Carregar mais (${visibleArchivedTickets.length} de ${archivedTotal})`}
            </Button>
          ) : null}
        </section>
      )}
    </div>
  );
}
