export const KANBAN_BULK_SELECTION_LIMIT = 500;

export type KanbanSelectionResult = {
  selectedIds: Set<string>;
  limitReached: boolean;
};

export function toggleKanbanSelection(
  current: ReadonlySet<string>,
  ticketId: string,
  limit = KANBAN_BULK_SELECTION_LIMIT,
): KanbanSelectionResult {
  const selectedIds = new Set(current);
  if (selectedIds.has(ticketId)) {
    selectedIds.delete(ticketId);
    return { selectedIds, limitReached: false };
  }
  if (selectedIds.size >= limit) {
    return { selectedIds, limitReached: true };
  }
  selectedIds.add(ticketId);
  return { selectedIds, limitReached: false };
}

export function toggleAllVisibleKanbanTickets(
  current: ReadonlySet<string>,
  visibleTicketIds: Iterable<string>,
  limit = KANBAN_BULK_SELECTION_LIMIT,
): KanbanSelectionResult {
  const visibleIds = [...new Set(visibleTicketIds)];
  const selectedIds = new Set(current);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((ticketId) => selectedIds.has(ticketId));

  if (allVisibleSelected) {
    for (const ticketId of visibleIds) selectedIds.delete(ticketId);
    return { selectedIds, limitReached: false };
  }

  let limitReached = false;
  for (const ticketId of visibleIds) {
    if (selectedIds.has(ticketId)) continue;
    if (selectedIds.size >= limit) {
      limitReached = true;
      continue;
    }
    selectedIds.add(ticketId);
  }
  return { selectedIds, limitReached };
}
