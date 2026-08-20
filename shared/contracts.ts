export const TICKET_STATUSES = [
  "new",
  "triage",
  "in_progress",
  "waiting_customer",
  "blocked",
  "resolved",
  "archived",
] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_TITLE_MAX_LENGTH = 200;
export const TICKET_SUMMARY_MAX_LENGTH = 20_000;
export const TICKET_INTERNAL_NOTE_MAX_LENGTH = 4_000;
export const PRODUCT_FORWARDING_KINDS = ["bug"] as const;
export type ProductForwardingKind =
  (typeof PRODUCT_FORWARDING_KINDS)[number];
export const PRODUCT_FORWARDING_TITLE_MAX_LENGTH = 200;
export const PRODUCT_FORWARDING_DESCRIPTION_MAX_LENGTH = 20_000;
export const PRODUCT_FORWARDING_EXTERNAL_REFERENCE_MAX_LENGTH = 1_000;
export const CLIENT_KINDS = ["agency", "ecommerce"] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

export const TRIAGE_KINDS = [
  "unclassified",
  "demand",
  "uncertain",
  "continuation",
  "information",
  "social",
  "context",
] as const;
export type TriageKind = (typeof TRIAGE_KINDS)[number];

export const TRIAGE_STATES = [
  "unreviewed",
  "ticketed",
  "ignored",
  "context",
] as const;
export type TriageState = (typeof TRIAGE_STATES)[number];

export const TRIAGE_SUGGESTED_ACTIONS = ["create", "attach", "ignore"] as const;
export type TriageSuggestedAction =
  (typeof TRIAGE_SUGGESTED_ACTIONS)[number];

export const CATEGORY_FACETS = [
  "reason",
  "product",
  "platform",
  "symptom",
  "root_cause",
  "resolution",
] as const;

export type CategoryFacet = (typeof CATEGORY_FACETS)[number];

export interface CategoryDto {
  id: string;
  facet: CategoryFacet;
  slug: string;
  label: string;
  color: string | null;
}

export interface CategoryCatalogDto extends CategoryDto {
  /** Total de tickets vinculados à categoria. */
  ticketCount: number;
}

export interface CategoryListResponse {
  items: CategoryCatalogDto[];
  total: number;
}

export interface CreateCategoryInput {
  facet: CategoryFacet;
  label: string;
  color?: string | null;
}

export interface TicketCategoryAttachInput {
  categoryId: string;
  actor?: string;
}

export interface CreateManualTicketInput {
  clientRequestId: string;
  groupId: string;
  title: string;
  summary: string;
  priority?: TicketPriority;
}

export interface UpdateTicketMetadataInput {
  title: string;
  summary: string;
  priority: TicketPriority;
  /** Null restores automatic detection from the ticket messages. */
  requesterId: string | null;
}

export interface AffectedStoreDto {
  id: string;
  name: string;
  businessId: string | null;
  platform: string | null;
}

export interface TicketRequesterDto {
  id: string;
  displayName: string;
  phoneE164: string | null;
}

/** Minimal local user projection exposed to the support workflow. */
export interface TicketAssigneeDto {
  id: string;
  displayName: string;
  role: AuthRole;
}

export interface UpdateTicketAssigneeInput {
  /** Null leaves the ticket explicitly unassigned. */
  assigneeId: string | null;
}

export interface TicketSummaryDto {
  id: string;
  number: number;
  title: string;
  summary: string;
  status: TicketStatus;
  priority: TicketPriority;
  confidence: number | null;
  needsReview: boolean;
  relation:
    | "new"
    | "continuation"
    | "possible_reopen"
    | "informational"
    | "social"
    | "uncertain"
    | null;
  nextAction: string | null;
  client: {
    id: string;
    name: string;
    kind: ClientKind;
    isUnidentified: boolean;
  };
  group: {
    id: string;
    subject: string;
    externalJid: string;
  };
  requester: TicketRequesterDto | null;
  assignee: TicketAssigneeDto | null;
  affectedStore: AffectedStoreDto | null;
  productForwarding: TicketProductForwardingSummaryDto | null;
  categories: CategoryDto[];
  firstMessageAt: string;
  lastMessageAt: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  /** Present on current API responses; optional for backwards-compatible clients. */
  archivedAt?: string | null;
  messageCount: number;
  latestSuggestion: {
    id: string;
    confidence: number;
    status: "candidate" | "accepted" | "rejected" | "superseded";
  } | null;
}

export interface AttachmentDto {
  id: string;
  kind: "image" | "pdf" | "document" | "video" | "audio" | "other";
  mimeType: string;
  fileName: string | null;
  url: string | null;
  sizeBytes: number | null;
  sha256: string;
  extractedText: string | null;
  available: boolean;
  /** Omitted by older local APIs; current responses always include this field. */
  transcription?: AudioTranscriptionDto | null;
}

export type AudioTranscriptionStatus =
  | "queued"
  | "processing"
  | "completed"
  | "review"
  | "failed";

export interface AudioTranscriptionDto {
  status: AudioTranscriptionStatus;
  text: string | null;
  language: string;
  confidence: number | null;
  modelId: string;
  error: string | null;
  updatedAt: string;
}

export type LocalTranscriptionModelState =
  | "not_installed"
  | "downloading"
  | "installed"
  | "error";

export interface LocalTranscriptionModelDto {
  id: string;
  label: string;
  description: string;
  estimatedDiskBytes: number;
  estimatedRamBytes: number;
  recommended: boolean;
  state: LocalTranscriptionModelState;
  progress: number;
  cacheBytes: number;
  error: string | null;
  installedAt: string | null;
}

export interface AudioTranscriptionSettingsDto {
  enabled: boolean;
  modelId: string;
  language: string;
  autoTranscribeNew: boolean;
  updatedAt: string;
  queue: {
    queued: number;
    processing: number;
    review: number;
    failed: number;
  };
  runtime: {
    state: "idle" | "loading" | "ready" | "processing" | "error";
    activeModelId: string | null;
    totalMemoryBytes: number;
    freeMemoryBytes: number;
    availableDiskBytes: number | null;
    cacheBytes: number;
    unloadAfterSeconds: number;
    error: string | null;
  };
  models: LocalTranscriptionModelDto[];
}

export type ConversationScope = "group" | "direct";

export interface ConversationSummaryDto {
  id: string;
  subject: string;
  externalJid: string;
  scope: ConversationScope;
  monitored: boolean;
  suggestionsMuted: boolean;
  suggestionsMutedAt: string | null;
  client: {
    id: string;
    name: string;
    kind: ClientKind;
    isUnidentified: boolean;
  };
  pendingCount: number;
  ignoredCount: number;
  ticketCount: number;
  openTicketCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
}

export interface ConversationListResponse {
  items: ConversationSummaryDto[];
  total: number;
  pendingTotal: number;
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ConversationClearPendingResponse {
  contextualizedMessageCount: number;
  conversationCount: number;
  resolvedBlockCount: number;
}

export interface ConversationTriageDto {
  kind: TriageKind;
  state: TriageState;
  confidence: number | null;
  reason: string | null;
  suggestedAction: TriageSuggestedAction | null;
  suggestedTicketId: string | null;
  suggestionGroupId: string | null;
}

export interface ConversationTicketReferenceDto {
  id: string;
  number: number;
  title: string;
  status: TicketStatus;
}

export interface ConversationTicketListResponse {
  items: ConversationTicketReferenceDto[];
  total: number;
  summary: {
    all: number;
    active: number;
    resolved: number;
    archived: number;
  };
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ConversationReplyReferenceDto {
  providerMessageId: string;
  messageId: string | null;
  available: boolean;
  sender: {
    id: string;
    displayName: string;
    isStaff: boolean;
  } | null;
  text: string | null;
  messageType: string | null;
  occurredAt: string | null;
}

export interface ConversationReactionDto {
  emoji: string;
  count: number;
  reactors: Array<{
    id: string;
    displayName: string;
    isStaff: boolean;
  }>;
}

export interface ConversationReactionUpdateDto {
  messageId: string;
  reactions: ConversationReactionDto[];
}

export interface ConversationMessageDto {
  id: string;
  externalId: string;
  occurredAt: string;
  source: "legacy" | "history" | "realtime_append" | "realtime_notify";
  sender: {
    id: string;
    displayName: string;
    phoneE164: string | null;
    isStaff: boolean;
  };
  text: string | null;
  messageType: string;
  replyTo: ConversationReplyReferenceDto | null;
  reactions: ConversationReactionDto[];
  attachments: AttachmentDto[];
  triage: ConversationTriageDto;
  tickets: ConversationTicketReferenceDto[];
}

export interface TriageBlockDto {
  id: string;
  conversationId: string;
  messageIds: string[];
  title: string;
  summary: string;
  kind: TriageKind;
  state:
    | "pending"
    | "ticketed"
    | "attached"
    | "ignored"
    | "context"
    | "restored"
    | "superseded";
  confidence: number | null;
  suggestedAction: TriageSuggestedAction | null;
  suggestedTicketId: string | null;
  confirmedTicketId: string | null;
  affectedStoreId: string | null;
  reason: string | null;
  proposedCategories: {
    contactReason: string[];
    productArea: string[];
    platform: string[];
    symptom: string[];
  };
  ai: {
    model: string;
    promptVersion: string;
    fallbackUsed: boolean;
  } | null;
  firstMessageAt: string;
  lastMessageAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface TriageAiSettingsDto {
  enabled: boolean;
  model: string;
  silenceWindowSeconds: number;
  connectionId?: string | null;
  connectionLabel?: string | null;
  providerId?: "codex" | "openai" | "anthropic" | "openrouter" | "ollama" | null;
  updatedBy: string;
  updatedAt: string;
}

export interface UpdateTriageAiSettingsInput {
  enabled: boolean;
  model: string;
  silenceWindowSeconds?: number;
  actor?: string;
}

export type ConversationSuggestionAnalysisState =
  | "idle"
  | "waiting_for_silence"
  | "waiting_for_audio"
  | "waiting_for_context"
  | "queued"
  | "running";

export interface ConversationSuggestionAnalysisDto {
  state: ConversationSuggestionAnalysisState;
  pendingMessageCount: number;
  nextAnalysisAt: string | null;
}

export interface ConversationMessagesResponse {
  conversation: ConversationSummaryDto;
  items: ConversationMessageDto[];
  reactionUpdates: ConversationReactionUpdateDto[];
  suggestedBlocks: TriageBlockDto[];
  suggestionAnalysis: ConversationSuggestionAnalysisDto;
  nextCursor: string | null;
  hasMore: boolean;
}

export interface TriggerConversationAnalysisResponse {
  accepted: boolean;
  jobId: string | null;
  analysis: ConversationSuggestionAnalysisDto;
}

export interface ConversationTriageBlocksResponse {
  items: TriageBlockDto[];
}

export interface ConversationBatchActionInput {
  messageIds: string[];
  clientRequestId?: string;
  actor?: string;
  reason?: string | null;
}

export interface ConversationSuggestionSettingsInput {
  muted: boolean;
  actor?: string;
}

export interface ConversationSuggestionSettingsResponse {
  conversation: ConversationSummaryDto;
  contextualizedMessageCount: number;
  resolvedBlockCount: number;
}

export interface CreateConversationTicketInput
  extends ConversationBatchActionInput {
  title?: string;
  summary?: string;
  clientId?: string | null;
  affectedStoreId?: string | null;
  priority?: TicketPriority;
}

export interface AttachConversationMessagesInput
  extends ConversationBatchActionInput {
  ticketId: string;
}

export interface ConversationTriageActionResponse {
  blockId: string;
  conversationId: string;
  action: "create" | "attach" | "ignore" | "context" | "restore";
  messageIds: string[];
  ticket: TicketDetailDto | null;
  investigationJobId: string | null;
}

export interface MergeTicketsInput {
  sourceTicketIds: string[];
  targetTicketId: string;
  clientRequestId?: string;
  actor?: string;
  reason?: string | null;
}

export interface MergeTicketsResponse {
  target: TicketDetailDto;
  mergedTicketIds: string[];
  investigationJobId: string;
}

export interface TimelineMessageDto {
  type: "message";
  id: string;
  externalId: string;
  occurredAt: string;
  canDetach?: boolean;
  sender: {
    id: string;
    displayName: string;
    phoneE164: string | null;
    isStaff: boolean;
  };
  text: string | null;
  messageType: string;
  attachments: AttachmentDto[];
}

export interface TimelineEventDto {
  type: "event";
  id: string;
  occurredAt: string;
  eventType: string;
  description: string;
  actor: string;
  fromStatus: TicketStatus | null;
  toStatus: TicketStatus | null;
  metadata: Record<string, unknown>;
  /** @deprecated Use metadata. Kept for backwards compatibility with local clients. */
  data: Record<string, unknown>;
}

export type TimelineItemDto = TimelineMessageDto | TimelineEventDto;

export interface SuggestionDto {
  id: string;
  body: string;
  confidence: number;
  evidence: Array<{
    source: string;
    label: string;
    reference?: string;
  }>;
  missingInformation: string[];
  status: "candidate" | "accepted" | "rejected" | "superseded";
  model: string | null;
  promptVersion: string | null;
  createdAt: string;
}

export interface ResolutionDto {
  id: string;
  summary: string;
  rootCause: string | null;
  outcome: string | null;
  validatedBy: string;
  validatedAt: string;
}

export interface SentResponseDto {
  id: string;
  body: string;
  messageId: string | null;
  sentAt: string;
  capturedAt: string;
}

export interface AddTicketInternalNoteInput {
  body: string;
  clientNoteId: string;
}

export interface UpdateTicketInternalNoteInput {
  body: string;
  expectedUpdatedAt: string;
}

export interface TicketProductForwardingSummaryDto {
  kind: ProductForwardingKind;
  title: string;
  externalReference: string | null;
  updatedAt: string;
}

export interface TicketProductForwardingDto
  extends TicketProductForwardingSummaryDto {
  description: string;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
}

export interface UpsertTicketProductForwardingInput {
  kind: "bug";
  title: string;
  description: string;
  externalReference?: string | null;
  resolveTicket?: boolean;
}

export interface TicketDetailDto extends TicketSummaryDto {
  requesterOverrideId: string | null;
  requesterCandidates: TicketRequesterDto[];
  productForwarding: TicketProductForwardingDto | null;
  timeline: TimelineItemDto[];
  suggestions: SuggestionDto[];
  sentResponses: SentResponseDto[];
  resolution: ResolutionDto | null;
  latestInvestigation: LatestInvestigationDto | null;
  investigationThread: InvestigationThreadSummaryDto | null;
}

export const DOCUMENTATION_DRAFT_STATUSES = [
  "draft",
  "ready",
  "archived",
] as const;

export type DocumentationDraftStatus =
  (typeof DOCUMENTATION_DRAFT_STATUSES)[number];

export const DOCUMENTATION_GENERATION_STATES = [
  "queued",
  "running",
  "completed",
  "failed",
] as const;

export type DocumentationGenerationState =
  (typeof DOCUMENTATION_GENERATION_STATES)[number];

export interface DocumentationImagePlacementDto {
  attachmentId: string;
  messageId: string;
  fileName: string | null;
  mimeType: string;
  url: string;
  caption: string;
  afterHeading: string | null;
}

export interface DocumentationDraftDto {
  id: string;
  ticketId: string;
  ticketNumber: number;
  ticketTitle: string;
  status: DocumentationDraftStatus;
  generationState: DocumentationGenerationState | null;
  generationError: string | null;
  title: string;
  summary: string;
  audience: string;
  bodyMarkdown: string;
  prerequisites: string[];
  warnings: string[];
  sourceMessageIds: string[];
  images: DocumentationImagePlacementDto[];
  aiProviderId: string | null;
  aiModel: string | null;
  generatedAt: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentationDraftListResponse {
  items: DocumentationDraftDto[];
  total: number;
}

export interface DeleteDocumentationDraftResponse {
  id: string;
  ticketId: string;
  deleted: true;
}

export interface UpdateDocumentationDraftInput {
  title: string;
  summary: string;
  audience: string;
  bodyMarkdown: string;
  prerequisites: string[];
  status: DocumentationDraftStatus;
}

export interface TicketListResponse {
  items: TicketSummaryDto[];
  total: number;
  limit: number;
  offset: number;
}

export interface StatusCountDto {
  status: TicketStatus;
  count: number;
}

export interface DirectoryGroupDto {
  id: string;
  subject: string;
  externalJid: string;
  monitored: boolean;
  participantCount: number;
  ticketCount: number;
  openTicketCount: number;
  lastActivityAt: string | null;
}

export interface DirectoryPersonDto {
  id: string;
  displayName: string;
  phoneE164: string | null;
  externalJid: string;
  isStaff: boolean;
  activeGroupCount: number;
  lastActivityAt: string | null;
}

export interface DirectorySnapshotDto {
  groups: DirectoryGroupDto[];
  people: DirectoryPersonDto[];
  totals: {
    groups: number;
    people: number;
  };
}

export const DASHBOARD_TIME_ZONE = "America/Sao_Paulo" as const;

export interface DashboardPeriodInput {
  /** Inclusive calendar date interpreted in the configured workspace timezone. */
  from: string;
  /** Inclusive calendar date interpreted in the configured workspace timezone. */
  to: string;
}

export interface DashboardPeriodDto extends DashboardPeriodInput {
  timeZone: string;
  fromUtc: string;
  toUtcExclusive: string;
}

export interface DashboardExportRowDto {
  ticketId: string;
  ticketNumber: number;
  title: string;
  summary: string;
  clientName: string;
  clientKind: ClientKind;
  groupSubject: string;
  affectedStoreName: string | null;
  assigneeName: string | null;
  assigneeRole: AuthRole | null;
  status: TicketStatus;
  priority: TicketPriority;
  needsReview: boolean;
  categories: string[];
  createdAt: string;
  createdAtSaoPaulo: string;
  latestResolutionAt: string | null;
  latestResolutionAtSaoPaulo: string | null;
  createdInPeriod: boolean;
  resolvedInPeriod: boolean;
}

export interface DashboardAssigneeMetricDto {
  assignee: (TicketAssigneeDto & { active: boolean }) | null;
  /** Tickets created in the selected period and currently assigned to this user. */
  created: number;
  /** Non-terminal tickets among those created in the selected period. */
  open: number;
  /** Tickets resolved in the selected period and currently assigned to this user. */
  resolved: number;
}

export interface DashboardMetricComparisonDto {
  current: number | null;
  previous: number | null;
}

export interface DashboardComparisonDto {
  previousPeriod: DashboardPeriodDto;
  created: DashboardMetricComparisonDto;
  resolved: DashboardMetricComparisonDto;
  backlog: DashboardMetricComparisonDto;
  resolutionRatePercent: DashboardMetricComparisonDto;
  medianResolutionMinutes: DashboardMetricComparisonDto;
  reopened: DashboardMetricComparisonDto;
  unassignedBacklog: DashboardMetricComparisonDto;
}

export interface DashboardOperationalMetricsDto {
  /** Resolutions registered in the period divided by tickets created in it. */
  resolutionRatePercent: number | null;
  /** Median elapsed minutes in the latest resolution cycle of each resolved ticket. */
  medianResolutionMinutes: number | null;
  /** Tickets moved from resolved back to a non-terminal status in the period. */
  reopened: number;
  /** Unassigned tickets still open at the end of the period. */
  unassignedBacklog: number;
  /** All tickets still open at the end of the period. */
  backlog: number;
}

export type DashboardAgingBucketId =
  | "under_24h"
  | "one_to_three_days"
  | "three_to_seven_days"
  | "over_seven_days";

export interface DashboardAgingBucketDto {
  id: DashboardAgingBucketId;
  count: number;
}

export interface DashboardResponse {
  /** Present on current API responses; optional for backwards-compatible clients. */
  period?: DashboardPeriodDto | null;
  totals: {
    tickets: number;
    open: number;
    needsReview: number;
    resolved: number;
    orphanDemands: number;
    clients: number;
    /** Native WhatsApp groups represented in the current ticket period. */
    groups: number;
  };
  statusCounts: StatusCountDto[];
  priorityCounts: Array<{ priority: TicketPriority; count: number }>;
  ticketsByDay: Array<{ date: string; created: number; resolved: number }>;
  topCategories: Array<{ category: CategoryDto; count: number }>;
  topGroups: Array<{ groupId: string; groupSubject: string; count: number }>;
  /** @deprecated Use topGroups. */
  topClients: Array<{ clientId: string; clientName: string; count: number }>;
  /** Team breakdown always covers the selected period, independently of the assignee filter. */
  assigneeMetrics: DashboardAssigneeMetricDto[];
  operations: DashboardOperationalMetricsDto;
  aging: DashboardAgingBucketDto[];
  /** Null for the all-time view, which has no equivalent previous interval. */
  comparison: DashboardComparisonDto | null;
  recentTickets: TicketSummaryDto[];
}

export interface ClientSummaryDto {
  id: string;
  name: string;
  kind: ClientKind;
  isUnidentified: boolean;
  slug: string;
  notes: string | null;
  groups: Array<{ id: string; subject: string; externalJid: string }>;
  stores: AffectedStoreDto[];
  participantCount: number;
  ticketCount: number;
  openTicketCount: number;
  lastActivityAt: string | null;
}

export interface UpdateClientProfileInput {
  name: string;
  kind: ClientKind;
  notes?: string | null;
  stores: Array<{
    id?: string;
    name: string;
    businessId?: string | null;
    platform?: string | null;
  }>;
}

export interface UpdateTicketContextInput {
  clientId: string;
  affectedStoreId?: string | null;
  rememberForConversation: boolean;
  actor?: string;
}

export interface DeleteClientResponse {
  id: string;
  ignoredAt: string;
  alreadyIgnored: boolean;
  preserved: {
    groups: number;
    messages: number;
    attachments: number;
    tickets: number;
    openTickets: number;
  };
}

export interface DeleteTicketInput {
  actor?: string;
  reason?: string | null;
}

export interface DeleteTicketResponse {
  id: string;
  deletedAt: string;
  actor: string;
  reason: string | null;
  deleted: {
    ticketEvents: number;
    categories: number;
    suggestions: number;
    sentResponses: number;
    resolutions: number;
    evidenceQueries: number;
    investigationJobs: number;
    investigationThreads: number;
    investigationThreadMessages: number;
    investigationThreadJobs: number;
    investigationThreadToolExecutions: number;
  };
  preserved: {
    messages: number;
    attachments: number;
  };
}

export interface RuntimeStatusDto {
  state:
    | "offline"
    | "starting"
    | "waiting_qr"
    | "syncing"
    | "online"
    | "stopping"
    | "error";
  pid: number | null;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  lastSyncAt: string | null;
  connectedAccount: string | null;
  whatsappConnected: boolean;
  qrAvailable: boolean;
  groupsDiscovered: number;
  groupsSynced: number;
  privateConversations: number;
  messagesStored: number;
  ticketsCreated: number;
  monitoredGroups: number;
  lastError: string | null;
  whatsappEnabled?: boolean;
  agentEnabled?: boolean;
}

export interface OperationalGroupDto {
  id: string;
  subject: string;
  externalJid: string;
  client: {
    id: string;
    name: string;
    kind: ClientKind;
  };
  monitored: boolean;
  messageCount: number;
  openTicketCount: number;
  lastMessageAt: string | null;
  historyOldestAt: string | null;
  historyNewestAt: string | null;
  historyComplete: boolean;
}

export const INVESTIGATION_JOB_STATES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

export type InvestigationJobState = (typeof INVESTIGATION_JOB_STATES)[number];

export const INVESTIGATION_OUTCOMES = [
  "reply_ready",
  "already_answered",
  "needs_information",
  "technical_investigation_required",
] as const;

export type InvestigationOutcome = (typeof INVESTIGATION_OUTCOMES)[number];

export const INVESTIGATION_THREAD_MESSAGE_MAX_LENGTH = 24_000;

export interface InvestigationEvidenceDto {
  source: string;
  summary: string;
  reference: string | null;
}

export interface LatestInvestigationDto {
  id: string;
  state: InvestigationJobState;
  instructions: string | null;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  outcome: InvestigationOutcome | null;
  confidence: number | null;
  evidence: InvestigationEvidenceDto[];
  missingInformation: string[];
  nextAction: string | null;
  suggestedResponse: string | null;
}

export interface InvestigationJobSummaryDto {
  id: string;
  ticketId: string;
  ticketNumber: number;
  ticketTitle: string;
  clientName: string;
  state: InvestigationJobState;
  instructions: string | null;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  attemptCount: number;
  error: string | null;
}

export interface InvestigationJobListResponse {
  items: InvestigationJobSummaryDto[];
  counts: Array<{ state: InvestigationJobState; count: number }>;
}

export const INVESTIGATION_THREAD_STATUSES = ["active", "concluded"] as const;
export type InvestigationThreadStatus =
  (typeof INVESTIGATION_THREAD_STATUSES)[number];

export const INVESTIGATION_TURN_PHASES = [
  "analysis",
  "needs_information",
  "conclusion",
] as const;
export type InvestigationTurnPhase =
  (typeof INVESTIGATION_TURN_PHASES)[number];

export interface InvestigationThreadSummaryDto {
  id: string;
  status: InvestigationThreadStatus;
  updatedAt: string;
  /** Timestamp of the latest persisted assistant turn; opening the room alone keeps this null. */
  lastAssistantMessageAt: string | null;
  activeTurnState: InvestigationJobState | null;
}

export interface InvestigationToolExecutionDto {
  requestId: string;
  toolId: string;
  toolName: string;
  operation: string;
  argumentsJson: string;
  purpose: string;
  status: "success" | "error";
  summary: string;
  content: string;
  reference: string | null;
  executedAt: string;
}

export interface InvestigationThreadMessageDto {
  id: string;
  role: "operator" | "assistant";
  body: string;
  phase: InvestigationTurnPhase | null;
  evidence: InvestigationEvidenceDto[];
  suggestedResponse: string | null;
  nextAction: string | null;
  toolExecutions: InvestigationToolExecutionDto[];
  createdAt: string;
}

export interface InvestigationTurnResultDto {
  assistantMessage: string;
  phase: InvestigationTurnPhase;
  threadSummary: string;
  evidence: InvestigationEvidenceDto[];
  suggestedResponse: string | null;
  nextAction: string | null;
  confidence: number;
  toolExecutions: InvestigationToolExecutionDto[];
}

export interface InvestigationThreadTurnDto {
  id: string;
  state: InvestigationJobState;
  operatorMessageId: string;
  assistantMessageId: string | null;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  attemptCount: number;
  error: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  /** Append-only audit, available even when the model turn fails or is aborted. */
  toolExecutions: InvestigationToolExecutionDto[];
  result: InvestigationTurnResultDto | null;
}

export interface InvestigationThreadDto extends InvestigationThreadSummaryDto {
  ticketId: string;
  summary: string;
  createdAt: string;
  messages: InvestigationThreadMessageDto[];
  turns: InvestigationThreadTurnDto[];
}

export interface AddInvestigationThreadMessageInput {
  body: string;
  clientMessageId?: string;
}

export interface RuntimeQrResponse {
  available: boolean;
  qr: string | null;
}

export interface UpdateTicketStatusInput {
  status: TicketStatus;
  actor?: string;
  reason?: string;
  resolution?: {
    summary: string;
    rootCause?: string;
    outcome?: string;
    validatedBy?: string;
  };
}

export const TICKET_BATCH_ARCHIVE_ACTIONS = ["archive", "restore"] as const;
export type TicketBatchArchiveAction =
  (typeof TICKET_BATCH_ARCHIVE_ACTIONS)[number];

export interface TicketBulkStatusInput {
  ticketIds: string[];
  status: "archived" | "resolved";
  actor?: string;
  reason?: string | null;
}

export interface TicketBulkStatusResponse {
  batchId: string;
  action: TicketBatchArchiveAction;
  changedAt: string;
  tickets: TicketSummaryDto[];
}

export interface InvestigateTicketInput {
  instructions?: string;
}

export interface InvestigateTicketResponse {
  accepted: true;
  ticketId: string;
  jobId: string;
  state: "queued";
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export const AUTH_ROLES = ["owner", "admin", "operator", "viewer"] as const;
export type AuthRole = (typeof AUTH_ROLES)[number];

export const AUTH_USERNAME_MIN_LENGTH = 3;
export const AUTH_USERNAME_MAX_LENGTH = 64;
export const AUTH_DISPLAY_NAME_MAX_LENGTH = 120;
export const AUTH_ORGANIZATION_NAME_MAX_LENGTH = 160;
export const AUTH_WORKSPACE_NAME_MAX_LENGTH = 120;
export const AUTH_TIMEZONE_MAX_LENGTH = 100;
export const AUTH_PASSWORD_MIN_LENGTH = 12;
export const AUTH_PASSWORD_MAX_LENGTH = 256;

export interface AuthUserDto {
  id: string;
  username: string;
  displayName: string;
  role: AuthRole;
  active: boolean;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuthSetupStatusDto {
  required: boolean;
  organizationName: string | null;
  workspaceName: string | null;
  timezone: string | null;
  completedAt: string | null;
}

export interface BootstrapAuthSetupInput {
  organizationName: string;
  workspaceName: string;
  timezone: string;
  username: string;
  displayName: string;
  password: string;
}

export interface AuthLoginInput {
  username: string;
  password: string;
}

export interface AuthSessionDto {
  user: AuthUserDto;
  expiresAt: string;
}

export interface CreateAuthUserInput {
  username: string;
  displayName: string;
  role: AuthRole;
  password: string;
}

export interface UpdateAuthUserInput {
  username?: string;
  displayName?: string;
  role?: AuthRole;
  active?: boolean;
}

export interface ChangeAuthPasswordInput {
  currentPassword?: string;
  password: string;
}

export interface AuthUserListResponse {
  items: AuthUserDto[];
}

export type NotificationSourceType = "automation" | "investigation" | "system";
export type NotificationTone = "info" | "success" | "warning" | "urgent";

export interface NotificationDto {
  id: string;
  title: string;
  body: string;
  targetUrl: string | null;
  sourceType: NotificationSourceType;
  sourceId: string | null;
  tone: NotificationTone;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationListResponse {
  items: NotificationDto[];
  total: number;
  unread: number;
}

export interface NotificationReadResponse {
  updated: boolean;
  unread: number;
}

export const LOCAL_TOOL_TYPES = [
  "codebase",
  "knowledge",
  "debugger_skill",
  "postgres_readonly",
  "clickhouse_readonly",
  "aws_cloudwatch",
  "vercel",
] as const;

export type LocalToolType = (typeof LOCAL_TOOL_TYPES)[number];

export const LOCAL_TOOL_OPERATIONS = [
  "list_files",
  "search_files",
  "read_files",
  "read_skill",
  "describe_schema",
  "query_readonly",
  "query_logs",
  "read_metrics",
  "read_deployments",
  "read_logs",
] as const;

export type LocalToolOperation = (typeof LOCAL_TOOL_OPERATIONS)[number];

export interface CodebaseToolConfig {
  rootPath: string;
}

export interface KnowledgeToolConfig {
  rootPath: string;
}

export interface DebuggerSkillToolConfig {
  skillPath: string;
}

export interface PostgresReadonlyToolConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  sslMode: "disable" | "prefer" | "require" | "verify-full";
}

export interface ClickhouseReadonlyToolConfig {
  baseUrl: string;
  database: string;
  username: string;
}

export interface AwsCloudwatchToolConfig {
  region: string;
  authMode: "profile" | "access_key";
  profile: string | null;
  logGroupPrefixes: string[];
}

export interface VercelToolConfig {
  teamId: string | null;
  projectId: string | null;
}

export interface LocalToolConfigMap {
  codebase: CodebaseToolConfig;
  knowledge: KnowledgeToolConfig;
  debugger_skill: DebuggerSkillToolConfig;
  postgres_readonly: PostgresReadonlyToolConfig;
  clickhouse_readonly: ClickhouseReadonlyToolConfig;
  aws_cloudwatch: AwsCloudwatchToolConfig;
  vercel: VercelToolConfig;
}

export interface LocalToolSecretConfigMap {
  codebase: Record<string, never>;
  knowledge: Record<string, never>;
  debugger_skill: Record<string, never>;
  postgres_readonly: { password?: string };
  clickhouse_readonly: { password?: string };
  aws_cloudwatch: {
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
  };
  vercel: { token?: string };
}

export interface LocalToolDto<T extends LocalToolType = LocalToolType> {
  id: string;
  type: T;
  name: string;
  description: string | null;
  enabled: boolean;
  /** Tools are never exposed to triage or automatic analysis. */
  deepEnabled: boolean;
  allowedOperations: LocalToolOperation[];
  config: LocalToolConfigMap[T];
  secretFields: string[];
  lastTestedAt: string | null;
  lastTestStatus: "success" | "failed" | null;
  lastTestMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LocalToolResolvedConfig<T extends LocalToolType = LocalToolType>
  extends LocalToolDto<T> {
  /** Internal-only decrypted values. This shape must never be serialized by the API. */
  secrets: LocalToolSecretConfigMap[T];
}

export interface LocalToolWriteInput<T extends LocalToolType = LocalToolType> {
  type: T;
  name: string;
  description?: string | null;
  enabled?: boolean;
  deepEnabled?: boolean;
  allowedOperations?: LocalToolOperation[];
  config: LocalToolConfigMap[T];
  /** Write-only. Null removes a previously stored field. */
  secrets?: Partial<Record<keyof LocalToolSecretConfigMap[T], string | null>>;
}

export interface LocalToolTestResult {
  ok: boolean;
  message: string;
  checkedAt: string;
  mode: "filesystem" | "configuration" | "connection";
}

export type LegacyLocalToolSourceKey =
  | "SUPPORT_CODE_ROOTS"
  | "SUPPORT_VAULT_DIR";

export type LegacyLocalToolCandidateStatus =
  | "ready"
  | "already_imported"
  | "unavailable";

export interface LegacyLocalToolCandidateDto {
  id: string;
  sourceKey: LegacyLocalToolSourceKey;
  type: "codebase" | "knowledge";
  name: string;
  description: string;
  rootPath: string;
  status: LegacyLocalToolCandidateStatus;
  statusMessage: string;
  existingToolId: string | null;
}

export interface LegacyLocalToolImportResultDto {
  items: LegacyLocalToolCandidateDto[];
  importedTools: LocalToolDto[];
  importedCount: number;
  alreadyImportedCount: number;
}
