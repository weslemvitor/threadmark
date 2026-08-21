import { formatRelativeTime } from "@/app/lib/format";
import type { TicketSummary } from "@/app/lib/types";
import type { KanbanTab } from "@/app/lib/kanban-tabs";

export function getKanbanTicketTimestamp(
  ticket: TicketSummary,
  mode: KanbanTab,
  columnId?: string,
): string {
  if (mode === "archived") return ticket.archivedAt ?? ticket.updatedAt;
  if (columnId === "done") return ticket.resolvedAt ?? ticket.updatedAt;
  if (columnId === "cancelled") return ticket.updatedAt;
  return ticket.lastMessageAt;
}

export function getKanbanTicketTimeLabel(
  ticket: TicketSummary,
  mode: KanbanTab,
  columnId?: string,
): string {
  const relative = formatRelativeTime(
    getKanbanTicketTimestamp(ticket, mode, columnId),
  );
  if (mode === "archived") return `Arquivado ${relative}`;
  if (columnId === "done") return `Resolvido ${relative}`;
  if (columnId === "cancelled") return `Cancelado ${relative}`;
  return relative;
}
