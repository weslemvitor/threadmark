import type { TicketDetail, TicketSummary } from "./types";

type TicketPayload = TicketSummary | TicketDetail;

function stableTicketJson(value: TicketPayload): string {
  return JSON.stringify(value, (_key, nestedValue: unknown) => {
    if (
      !nestedValue ||
      typeof nestedValue !== "object" ||
      Array.isArray(nestedValue)
    ) {
      return nestedValue;
    }
    return Object.fromEntries(
      Object.entries(nestedValue).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
  });
}

export function hasSameTicketPayload(
  current: TicketPayload | null | undefined,
  incoming: TicketPayload,
): boolean {
  return current ? stableTicketJson(current) === stableTicketJson(incoming) : false;
}

export function ticketSummaryFromDetail(detail: TicketDetail): TicketSummary {
  return {
    id: detail.id,
    number: detail.number,
    title: detail.title,
    summary: detail.summary,
    status: detail.status,
    priority: detail.priority,
    confidence: detail.confidence,
    needsReview: detail.needsReview,
    relation: detail.relation,
    nextAction: detail.nextAction,
    client: detail.client,
    group: detail.group,
    requester: detail.requester,
    affectedStore: detail.affectedStore,
    productForwarding: detail.productForwarding
      ? {
          kind: detail.productForwarding.kind,
          title: detail.productForwarding.title,
          externalReference: detail.productForwarding.externalReference,
          updatedAt: detail.productForwarding.updatedAt,
        }
      : null,
    categories: detail.categories,
    firstMessageAt: detail.firstMessageAt,
    lastMessageAt: detail.lastMessageAt,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    resolvedAt: detail.resolvedAt,
    archivedAt: detail.archivedAt,
    messageCount: detail.messageCount,
    latestSuggestion: detail.latestSuggestion,
  };
}
