import type {
  DashboardResponse,
  InvestigationJobListResponse,
  OperationalGroupDto,
  RuntimeStatusDto,
  SuggestionDto,
  TicketDetailDto,
  TicketStatus,
  TicketSummaryDto,
} from "../shared/contracts.js";

export type LayoutMode = "wide" | "medium" | "compact";
export type TicketFilter = "attention" | "open" | "review" | "all";
export type CompactPane = "queue" | "detail";
export type Overlay = "help" | "operations" | null;

export interface OperationsSnapshot {
  runtime: RuntimeStatusDto;
  dashboard: DashboardResponse | null;
  tickets: TicketSummaryDto[];
  groups: OperationalGroupDto[];
  investigations: InvestigationJobListResponse;
  refreshedAt: string | null;
  apiOnline: boolean;
  error: string | null;
}

export interface TuiState extends OperationsSnapshot {
  selectedTicketId: string | null;
  selectedTicket: TicketDetailDto | null;
  selectedIndex: number;
  filter: TicketFilter;
  compactPane: CompactPane;
  overlay: Overlay;
  loading: boolean;
  notice: string | null;
}

export const EMPTY_INVESTIGATIONS: InvestigationJobListResponse = {
  items: [],
  counts: [
    { state: "queued", count: 0 },
    { state: "running", count: 0 },
    { state: "completed", count: 0 },
    { state: "failed", count: 0 },
  ],
};

export const STATUS_LABELS: Record<TicketStatus, string> = {
  new: "NOVO",
  triage: "TRIAGEM",
  in_progress: "EM ANDAMENTO",
  waiting_customer: "AGUARDANDO CLIENTE",
  blocked: "BLOQUEADO",
  resolved: "RESOLVIDO",
  archived: "ARQUIVADO",
};

export const FILTER_LABELS: Record<TicketFilter, string> = {
  attention: "ATENÇÃO",
  open: "ABERTOS",
  review: "REVISÃO",
  all: "TODOS",
};

const OPEN_STATUSES = new Set<TicketStatus>([
  "new",
  "triage",
  "in_progress",
  "waiting_customer",
  "blocked",
]);

export function getLayoutMode(width: number): LayoutMode {
  if (width >= 120) return "wide";
  if (width >= 80) return "medium";
  return "compact";
}

export function filterTickets(
  tickets: TicketSummaryDto[],
  filter: TicketFilter,
): TicketSummaryDto[] {
  if (filter === "all") return tickets;
  if (filter === "review") return tickets.filter((ticket) => ticket.needsReview);
  if (filter === "open") {
    return tickets.filter((ticket) => OPEN_STATUSES.has(ticket.status));
  }
  return tickets.filter(
    (ticket) =>
      OPEN_STATUSES.has(ticket.status) &&
      (ticket.needsReview ||
        ticket.priority === "urgent" ||
        ticket.priority === "high" ||
        ticket.status === "blocked"),
  );
}

export function nextFilter(filter: TicketFilter): TicketFilter {
  const order: TicketFilter[] = ["attention", "open", "review", "all"];
  return order[(order.indexOf(filter) + 1) % order.length] ?? "attention";
}

export function visibleTicketWindow<T>(
  tickets: T[],
  selectedIndex: number,
  capacity: number,
): { items: T[]; start: number } {
  if (!tickets.length || capacity < 1) return { items: [], start: 0 };
  const safeIndex = Math.max(0, Math.min(selectedIndex, tickets.length - 1));
  const start = Math.max(
    0,
    Math.min(safeIndex - Math.floor(capacity / 2), tickets.length - capacity),
  );
  return { items: tickets.slice(start, start + capacity), start };
}

export function investigationCount(
  investigations: InvestigationJobListResponse,
  state: "queued" | "running" | "completed" | "failed",
): number {
  return investigations.counts.find((item) => item.state === state)?.count ?? 0;
}

type SuggestionTicket = Pick<
  TicketDetailDto,
  "latestInvestigation" | "sentResponses" | "status" | "suggestions"
>;

function latestTimestamp(...values: Array<string | null>): string | null {
  return values.reduce<string | null>(
    (latest, value) => value && (!latest || value > latest) ? value : latest,
    null,
  );
}

function getLastSentResponseAt(ticket: SuggestionTicket): string | null {
  return ticket.sentResponses.reduce<string | null>((latest, response) => {
    return !latest || response.sentAt > latest ? response.sentAt : latest;
  }, null);
}

function getAlreadyAnsweredAt(ticket: SuggestionTicket): string | null {
  const investigation = ticket.latestInvestigation;
  if (investigation?.outcome !== "already_answered") return null;
  return investigation.finishedAt ?? investigation.startedAt ?? investigation.requestedAt;
}

export function getOperationalSuggestion(
  ticket: SuggestionTicket,
): SuggestionDto | null {
  if (ticket.status === "resolved" || ticket.status === "archived") return null;

  const validAfter = latestTimestamp(
    getLastSentResponseAt(ticket),
    getAlreadyAnsweredAt(ticket),
  );

  return ticket.suggestions.reduce<SuggestionDto | null>((newest, suggestion) => {
    if (suggestion.status !== "candidate") return newest;
    if (validAfter && suggestion.createdAt <= validAfter) return newest;
    if (!newest || suggestion.createdAt > newest.createdAt) return suggestion;
    return newest;
  }, null);
}

export function getOperationalNextAction(
  ticket: SuggestionTicket & Pick<TicketDetailDto, "lastMessageAt" | "nextAction">,
): string | null {
  if (ticket.status === "resolved" || ticket.status === "archived") return null;

  const suggestion = getOperationalSuggestion(ticket);
  const investigation = ticket.latestInvestigation;
  if (
    !suggestion &&
    (investigation?.state === "queued" || investigation?.state === "running")
  ) return null;

  if (!suggestion && investigation?.state === "completed") {
    const investigationAt =
      investigation.finishedAt ?? investigation.startedAt ?? investigation.requestedAt;
    const latestActivityAt = latestTimestamp(
      getLastSentResponseAt(ticket),
      ticket.lastMessageAt,
    );
    if (latestActivityAt && latestActivityAt > investigationAt) return null;
  }

  return ticket.nextAction;
}

export function formatRelativeTime(
  value: string | null,
  now = Date.now(),
): string {
  if (!value) return "—";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "—";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 10) return "agora";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function truncateText(value: string, width: number): string {
  if (width < 1) return "";
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= width) return normalized;
  if (width === 1) return "…";
  return `${normalized.slice(0, width - 1)}…`;
}

export function createOfflineRuntime(
  whatsappEnabled: boolean,
  agentEnabled: boolean,
): RuntimeStatusDto {
  return {
    state: "offline",
    pid: null,
    startedAt: null,
    lastHeartbeatAt: null,
    lastSyncAt: null,
    connectedAccount: null,
    whatsappConnected: false,
    qrAvailable: false,
    groupsDiscovered: 0,
    groupsSynced: 0,
    privateConversations: 0,
    messagesStored: 0,
    ticketsCreated: 0,
    monitoredGroups: 0,
    lastError: null,
    whatsappEnabled,
    agentEnabled,
  };
}
