import type { TicketSummary } from "./types.js";

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLocaleLowerCase("pt-BR");
}

export function matchesTicketSearch(
  ticket: TicketSummary,
  rawQuery: string,
): boolean {
  const query = normalizeSearchText(rawQuery);
  if (!query) return true;

  const searchableValues = [
    ticket.title,
    ticket.client.name,
    ticket.summary,
    ticket.group.subject,
    ticket.requester?.displayName,
    ticket.requester?.phoneE164,
    ticket.affectedStore?.name,
    ticket.productForwarding?.title,
    ticket.productForwarding?.externalReference,
    `#${ticket.number}`,
    ...ticket.categories.map((category) => category.label),
  ];

  return searchableValues.some(
    (value) => typeof value === "string" && normalizeSearchText(value).includes(query),
  );
}
