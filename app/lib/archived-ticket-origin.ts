export type ArchivedTicketOrigin = "resolved" | "cancelled";

export function getArchivedTicketOrigin(ticket: {
  archivedFromStatus?: ArchivedTicketOrigin | null;
  resolvedAt: string | null;
}): ArchivedTicketOrigin {
  if (ticket.archivedFromStatus) return ticket.archivedFromStatus;
  return ticket.resolvedAt ? "resolved" : "cancelled";
}
