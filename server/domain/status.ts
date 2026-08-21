import type { TicketStatus } from "../../shared/contracts.js";

import { ConflictError } from "./errors.js";

const ALLOWED_TRANSITIONS: Record<TicketStatus, ReadonlySet<TicketStatus>> = {
  new: new Set(["triage", "in_progress", "resolved", "cancelled"]),
  triage: new Set(["new", "in_progress", "resolved", "cancelled"]),
  in_progress: new Set(["triage", "waiting_customer", "blocked", "resolved", "cancelled"]),
  waiting_customer: new Set(["in_progress", "blocked", "resolved", "cancelled"]),
  blocked: new Set(["in_progress", "waiting_customer", "resolved", "cancelled"]),
  resolved: new Set(["in_progress", "archived"]),
  cancelled: new Set(["in_progress", "archived"]),
  archived: new Set(["resolved", "cancelled"]),
};

export function assertStatusTransition(
  current: TicketStatus,
  next: TicketStatus,
): void {
  if (current === next) {
    return;
  }

  if (!ALLOWED_TRANSITIONS[current].has(next)) {
    throw new ConflictError(
      `Transição de status inválida: ${current} -> ${next}`,
      { current, next },
    );
  }
}

export function allowedStatusTransitions(status: TicketStatus): TicketStatus[] {
  return [...ALLOWED_TRANSITIONS[status]];
}
