import { createHash, randomUUID } from "node:crypto";

import type {
  AddTicketInternalNoteInput,
  AddInvestigationThreadMessageInput,
  AttachmentDto,
  AuthRole,
  AttachConversationMessagesInput,
  CategoryDto,
  CategoryCatalogDto,
  CategoryFacet,
  ClientKind,
  ClientSummaryDto,
  ConversationBatchActionInput,
  ConversationClearPendingResponse,
  ConversationListResponse,
  ConversationMessageDto,
  ConversationMessagesResponse,
  ConversationReactionDto,
  ConversationReplyReferenceDto,
  ConversationSuggestionSettingsInput,
  ConversationSuggestionAnalysisDto,
  ConversationSuggestionSettingsResponse,
  ConversationSummaryDto,
  ConversationTicketListResponse,
  ConversationTriageActionResponse,
  ConversationTriageBlocksResponse,
  CreateConversationTicketInput,
  DashboardExportRowDto,
  DashboardPeriodInput,
  DashboardResponse,
  DeleteClientResponse,
  DeleteTicketInput,
  DeleteTicketResponse,
  DirectoryFieldType,
  DirectoryFieldValue,
  InvestigationJobListResponse,
  InvestigationJobState,
  InvestigationOutcome,
  InvestigationToolExecutionDto,
  InvestigationThreadDto,
  InvestigationThreadMessageDto,
  InvestigationThreadSummaryDto,
  InvestigationThreadTurnDto,
  InvestigationTurnResultDto,
  InvestigateTicketResponse,
  LatestInvestigationDto,
  OperationalGroupDto,
  ResolutionDto,
  RuntimeStatusDto,
  SentResponseDto,
  SuggestionDto,
  TicketDetailDto,
  TicketDirectoryContextDto,
  TicketDirectoryContextRecordDto,
  TicketDirectoryContextSource,
  TicketBulkStatusInput,
  TicketBulkStatusResponse,
  TicketListResponse,
  TicketPriority,
  TicketProductForwardingDto,
  ProductForwardingKind,
  TicketProductForwardingSummaryDto,
  TicketAssigneeDto,
  TicketRequesterDto,
  TicketStatus,
  TicketSummaryDto,
  TriageBlockDto,
  TriageAiSettingsDto,
  TriageKind,
  TriageState,
  TriageSuggestedAction,
  TimelineEventDto,
  TimelineItemDto,
  TimelineMessageDto,
  UpdateClientProfileInput,
  UpdateTicketContextInput,
  UpdateTicketDirectoryContextInput,
  UpdateTicketInternalNoteInput,
  UpdateTicketMetadataInput,
  UpdateTicketStatusInput,
  UpdateTriageAiSettingsInput,
  UpsertTicketProductForwardingInput,
} from "../../shared/contracts.js";
import {
  DASHBOARD_TIME_ZONE,
  INVESTIGATION_OUTCOMES,
  INVESTIGATION_JOB_STATES,
  INVESTIGATION_THREAD_MESSAGE_MAX_LENGTH,
  INVESTIGATION_TURN_PHASES,
  PRODUCT_FORWARDING_DESCRIPTION_MAX_LENGTH,
  PRODUCT_FORWARDING_EXTERNAL_REFERENCE_MAX_LENGTH,
  PRODUCT_FORWARDING_TITLE_MAX_LENGTH,
  TICKET_INTERNAL_NOTE_MAX_LENGTH,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_SUMMARY_MAX_LENGTH,
  TICKET_TITLE_MAX_LENGTH,
} from "../../shared/contracts.js";
import type { SupportDatabase } from "../db/index.js";
import type {
  AnalysisCategoryCatalog,
  DirectoryAnalysisRecord,
  InvestigationThreadInput,
  InvestigationToolResult,
  InvestigationTurnResult,
  SupportAnalysis,
  SupportAnalysisInput,
  TriageAnalysis,
  TriageAnalysisInput,
} from "../agent/types.js";
import type {
  QuotedTicketReference,
  TopicTicketCandidate,
} from "../triage/topic-router.js";
import { readRuntimeCounts } from "../runtime/runtime-counts.js";

import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import {
  DEFAULT_ANALYSIS_CATEGORY_CATALOG,
  normalizeAnalysisCategories,
  normalizeCatalogCategory,
  normalizeCategoriesForAnalysis,
} from "./category-policy.js";
import {
  isDirectConversationJid,
  normalizeConversationSubject,
} from "./conversation-subject.js";
import {
  dashboardCalendarDates,
  dashboardDateInTimeZone,
  dashboardDateTimeInTimeZone,
  recentDashboardPeriod,
  resolveDashboardPeriod,
} from "./dashboard-period.js";
import {
  isHumanParticipantDisplayName,
  preferredParticipantDisplayName,
} from "./participant-identity.js";
import { assertStatusTransition } from "./status.js";

const DEFAULT_TRIAGE_AI_MODEL = "gpt-5.4-mini";
const DEFAULT_TRIAGE_SILENCE_WINDOW_SECONDS = 180;
const MIN_VISIBLE_TICKET_SUGGESTION_CONFIDENCE = 0.9;

function normalizeTriageSilenceWindowSeconds(value: number): number {
  if (!Number.isInteger(value) || value < 30 || value > 1_800) {
    throw new ValidationError(
      "A janela de silêncio deve ser um número inteiro entre 30 e 1800 segundos",
    );
  }
  return value;
}

export interface UpsertAccountInput {
  id?: string;
  phoneNumber: string;
  displayName: string;
}

export interface UpsertClientInput {
  id?: string;
  name: string;
  slug: string;
  kind: ClientKind;
  notes?: string | null;
}

export interface UpsertStoreInput {
  id?: string;
  clientId: string;
  name: string;
  businessId?: string | null;
  platform?: string | null;
}

export interface UpsertGroupInput {
  id?: string;
  accountId: string;
  clientId: string;
  externalJid: string;
  subject: string;
  monitored?: boolean;
  historyOldestAt?: string | null;
  historyNewestAt?: string | null;
  historyComplete?: boolean;
  clientLinkSource?: "fallback" | "participant_match" | "manual";
}

export interface UpsertParticipantInput {
  id?: string;
  externalJid: string;
  phoneE164?: string | null;
  displayName: string;
}

export interface UpsertMessageInput {
  id?: string;
  externalId: string;
  providerMessageId?: string | null;
  groupId: string;
  senderId: string;
  occurredAt: string;
  text?: string | null;
  messageType: string;
  quotedExternalId?: string | null;
  triageKind?: TriageKind;
  triageState?: TriageState;
  ingestionSource?: "legacy" | "history" | "realtime_append" | "realtime_notify";
  raw?: unknown;
  ingestedAt?: string;
}

export interface UpsertMessageResult {
  id: string;
  inserted: boolean;
}

export interface UpsertMessageReactionEventInput {
  id?: string;
  externalId: string;
  groupId: string;
  reactorId: string;
  targetProviderMessageId: string;
  emoji?: string | null;
  occurredAt: string;
  observedAt?: string;
  raw?: unknown;
}

export interface UpsertAttachmentInput {
  id?: string;
  messageId: string;
  kind: AttachmentDto["kind"];
  mimeType: string;
  fileName?: string | null;
  localPath: string;
  sizeBytes?: number | null;
  sha256: string;
  sourceKey?: string | null;
  extractedText?: string | null;
  available?: boolean;
}

interface AttachmentMaterialState {
  id: string;
  kind: AttachmentDto["kind"];
  mime_type: string;
  file_name: string | null;
  local_path: string;
  size_bytes: number | null;
  sha256: string;
  extracted_text: string | null;
  available: number;
  updated_at: string;
}

export interface CreateTicketInput {
  id?: string;
  groupId: string;
  sourceMessageId?: string | null;
  messageIds?: string[];
  affectedStoreId?: string | null;
  title: string;
  summary: string;
  status?: Exclude<TicketStatus, "archived">;
  priority?: TicketPriority;
  confidence?: number | null;
  needsReview?: boolean;
  categories?: Array<{
    categoryId: string;
    source?: "ai" | "manual" | "rule";
    confidence?: number | null;
  }>;
  actor?: string;
  createdAt?: string;
}

export interface CreateManualTicketInput {
  clientRequestId: string;
  groupId: string;
  title: string;
  summary: string;
  priority?: TicketPriority;
  actor?: string;
}

export interface CategoryListFilters {
  query?: string;
  facet?: CategoryFacet;
  includeEmpty?: boolean;
}

export interface TicketListFilters {
  statuses?: TicketStatus[];
  clientId?: string;
  query?: string;
  includeArchived?: boolean;
  productForwardingKind?: ProductForwardingKind;
  createdFromUtc?: string;
  createdToUtcExclusive?: string;
  order?: "operational" | "created_desc" | "resolved_desc" | "archived_desc";
  limit?: number;
  offset?: number;
}

export interface InvestigationJobListFilters {
  states?: InvestigationJobState[];
  limit?: number;
}

export interface QueueInvestigationOptions {
  actor?: string;
  trigger?: "manual" | "ticket_created" | "new_customer_message" | "context_changed";
}

export interface HistoricalStaffResponseCaptureResult {
  ticketId: string;
  responseCaptured: boolean;
  reanalysisRequired: boolean;
}

export interface CancelInvestigationThreadResult {
  thread: InvestigationThreadDto;
  cancelledJobId: string | null;
  newlyCancelled: boolean;
}

export interface TriageCandidate {
  id: string;
  externalId: string;
  quotedExternalId: string | null;
  occurredAt: string;
  text: string | null;
  messageType: string;
  triageKind: TriageKind;
  group: {
    id: string;
    externalJid: string;
    subject: string;
  };
  client: {
    id: string;
    name: string;
    kind: ClientKind;
  };
  sender: {
    id: string;
    displayName: string;
    phoneE164: string | null;
    isStaff: boolean;
  };
  attachments: AttachmentDto[];
}

export interface RecordTriageSuggestionInput {
  kind: TriageKind;
  suggestedAction: TriageSuggestedAction;
  suggestedTicketId?: string | null;
  title: string;
  summary: string;
  confidence: number;
  reason: string;
  affectedStoreId?: string | null;
  actor?: string;
  suggestionGroupId?: string;
  proposedCategories?: TriageAnalysis["groups"][number]["categories"];
  aiModel?: string | null;
  aiPromptVersion?: string | null;
  triageAiJobId?: string | null;
  aiFallbackUsed?: boolean;
  forceNewBlock?: boolean;
}

export interface ConversationTriageCursor {
  enabledAt: string;
  watermarkAt: string | null;
}

export interface ConversationListFilters {
  limit?: number;
  cursor?: string;
  attention?: "pending" | "all";
  scope?: "group" | "direct";
  query?: string;
}

export interface ConversationMessageFilters {
  limit?: number;
  before?: string;
}

export interface ConversationTicketListFilters {
  limit?: number;
  cursor?: string;
  statuses?: TicketStatus[];
  query?: string;
}

export interface ParticipantClientMatch {
  id: string;
  name: string;
  kind: ClientKind;
  lastSeenAt: string;
}

interface ConversationReplyRow {
  id: string;
  occurred_at: string;
  text: string | null;
  message_type: string;
  sender_id: string;
  display_name: string;
  is_staff: number;
}

interface ConversationReactionRow {
  target_provider_message_id: string;
  target_message_id: string | null;
  emoji: string | null;
  reactor_id: string;
  display_name: string;
  is_staff: number;
}

interface StaffResponseMessageRow {
  id: string;
  group_id: string;
  text: string | null;
  occurred_at: string;
  quoted_external_id: string | null;
  sender_external_jid: string;
  is_staff: number;
}

interface AttachedStaffCaptureResult {
  responseCaptured: boolean;
  newlyCaptured: boolean;
}

export interface UpsertIdentityLinkInput {
  phoneJid: string;
  lidJid: string;
  source: string;
  observedAt: string;
}

export interface ClaimedInvestigationJob {
  id: string;
  ticketId: string;
  instructions: string | null;
}

export interface ClaimedInvestigationThreadJob {
  id: string;
  threadId: string;
  ticketId: string;
  operatorMessageId: string;
}

export type ClaimedAgentJob =
  | ({ kind: "automatic" } & ClaimedInvestigationJob)
  | ({ kind: "thread_turn" } & ClaimedInvestigationThreadJob)
  | {
      kind: "triage";
      id: string;
      groupId: string;
      model: string;
      attemptCount: number;
    };

interface EntityRecord {
  id: string;
}

interface TicketStatusRow {
  id: string;
  status: TicketStatus;
}

interface TriageBlockRow {
  id: string;
  group_id: string;
  state: TriageBlockDto["state"];
  triage_kind: TriageKind;
  suggested_action: TriageSuggestedAction | null;
  suggested_ticket_id: string | null;
  confirmed_ticket_id: string | null;
  affected_store_id: string | null;
  title: string;
  summary: string;
  confidence: number | null;
  reason: string | null;
  proposed_categories_json: string | null;
  ai_model: string | null;
  ai_prompt_version: string | null;
  triage_ai_job_id: string | null;
  ai_fallback_used: number;
  first_message_at: string;
  last_message_at: string;
  created_at: string;
  updated_at: string;
}

interface ConversationActionMessageRow {
  id: string;
  group_id: string;
  sender_id: string;
  occurred_at: string;
  text: string | null;
  message_type: string;
  triage_kind: TriageKind;
  triage_state: TriageState;
  is_staff: number;
}

const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  new: "Novo",
  triage: "Em triagem",
  in_progress: "Em andamento",
  waiting_customer: "Aguardando cliente",
  blocked: "Bloqueado",
  resolved: "Resolvido",
  archived: "Arquivado",
};

function describeTicketEvent(input: {
  eventType: string;
  actor: string;
  fromStatus: TicketStatus | null;
  toStatus: TicketStatus | null;
}): string {
  switch (input.eventType) {
    case "ticket_created":
      return `Ticket criado${input.toStatus ? ` com status ${TICKET_STATUS_LABELS[input.toStatus]}` : ""}.`;
    case "message_attached":
      return "Nova mensagem do WhatsApp vinculada ao ticket.";
    case "message_detached":
      return "Mensagem removida do contexto deste ticket.";
    case "status_changed":
      return input.fromStatus && input.toStatus
        ? `Status alterado de ${TICKET_STATUS_LABELS[input.fromStatus]} para ${TICKET_STATUS_LABELS[input.toStatus]} por ${input.actor}.`
        : "Status do ticket alterado.";
    case "ticket_context_changed":
      return "Cliente e ecommerce do ticket atualizados.";
    case "ticket_directory_context_changed":
      return "Registros do Diretório vinculados ao ticket foram atualizados.";
    case "internal_note_added":
      return `Nota interna adicionada por ${input.actor}.`;
    case "internal_note_updated":
      return `Nota interna editada por ${input.actor}.`;
    case "internal_note_deleted":
      return `Nota interna excluída por ${input.actor}.`;
    case "ticket_forwarded_to_product":
      return `Bug encaminhado ao Produto por ${input.actor}.`;
    case "ticket_product_forwarding_updated":
      return `Encaminhamento ao Produto atualizado por ${input.actor}.`;
    case "investigation_queued":
      return "Investigação automática da IA enfileirada.";
    case "investigation_queue_updated":
      return "Instruções adicionadas à investigação automática já enfileirada.";
    case "investigation_rerun_requested":
      return "Nova investigação automática solicitada porque o contexto mudou durante a execução.";
    case "investigation_started":
      return "A IA iniciou a investigação automática.";
    case "investigation_completed":
      return "A IA concluiu a investigação automática.";
    case "investigation_failed":
      return "A investigação automática da IA falhou.";
    case "investigation_thread_created":
      return "Sala de investigação aprofundada criada.";
    case "investigation_thread_message_queued":
      return "Mensagem do operador enviada à IA para investigação aprofundada.";
    case "investigation_thread_turn_started":
      return "A IA iniciou a investigação aprofundada.";
    case "investigation_thread_turn_completed":
      return "A IA concluiu a investigação aprofundada.";
    case "investigation_thread_turn_failed":
      return "A investigação aprofundada da IA falhou.";
    case "investigation_thread_turn_cancelled":
      return `A investigação aprofundada foi interrompida por ${input.actor}.`;
    case "ticket_category_added":
      return "Categoria vinculada ao ticket.";
    case "ticket_category_removed":
      return "Categoria removida do ticket.";
    case "ticket_assigned":
      return `Ticket atribuído por ${input.actor}.`;
    case "ticket_unassigned":
      return `Atribuição removida por ${input.actor}.`;
    default:
      return `Atualização interna registrada por ${input.actor}.`;
  }
}

interface TicketSummaryRow {
  id: string;
  number: number;
  title: string;
  summary: string;
  status: TicketStatus;
  priority: TicketPriority;
  confidence: number | null;
  needs_review: number;
  ai_relation: TicketSummaryDto["relation"];
  next_action: string | null;
  first_message_at: string;
  last_message_at: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  archived_at: string | null;
  client_id: string;
  client_name: string;
  client_kind: ClientKind;
  client_identification_pending: number;
  group_id: string;
  group_subject: string;
  group_external_jid: string;
  requester_id: string | null;
  requester_display_name: string | null;
  requester_phone_e164: string | null;
  requester_override_id: string | null;
  assignee_user_id: string | null;
  assignee_display_name: string | null;
  assignee_role: AuthRole | null;
  store_id: string | null;
  store_name: string | null;
  store_business_id: string | null;
  store_platform: string | null;
  message_count: number;
  suggestion_id: string | null;
  suggestion_confidence: number | null;
  suggestion_status: SuggestionDto["status"] | null;
}

interface CategoryRow {
  id: string;
  facet: CategoryFacet;
  slug: string;
  label: string;
  color: string | null;
}

interface CategoryCatalogRow extends CategoryRow {
  ticket_count: number;
}

function ticketSelect(
  requesterOverrideAvailable: boolean,
  assigneeColumnAvailable: boolean,
): string {
  const requesterOverride = requesterOverrideAvailable
    ? "t.requester_id"
    : "NULL";
  const assigneeSelect = assigneeColumnAvailable
    ? `assignee.id AS assignee_user_id,
    assignee.display_name AS assignee_display_name,
    assignee.role AS assignee_role,`
    : `NULL AS assignee_user_id,
    NULL AS assignee_display_name,
    NULL AS assignee_role,`;
  const assigneeJoin = assigneeColumnAvailable
    ? "LEFT JOIN local_users assignee ON assignee.id = t.assignee_user_id"
    : "";
  return `
  SELECT
    t.id,
    t.number,
    t.title,
    t.summary,
    t.status,
    t.priority,
    t.confidence,
    t.needs_review,
    t.ai_relation,
    t.next_action,
    t.first_message_at,
    t.last_message_at,
    t.created_at,
    t.updated_at,
    t.resolved_at,
    t.archived_at,
    c.id AS client_id,
    c.name AS client_name,
    c.kind AS client_kind,
    c.identification_pending AS client_identification_pending,
    g.id AS group_id,
    g.subject AS group_subject,
    g.external_jid AS group_external_jid,
    ${requesterOverride} AS requester_override_id,
    requester.id AS requester_id,
    requester.display_name AS requester_display_name,
    requester.phone_e164 AS requester_phone_e164,
    ${assigneeSelect}
    s.id AS store_id,
    s.name AS store_name,
    s.business_id AS store_business_id,
    s.platform AS store_platform,
    (SELECT COUNT(*) FROM ticket_messages tm WHERE tm.ticket_id = t.id) AS message_count,
    latest_suggestion.id AS suggestion_id,
    latest_suggestion.confidence AS suggestion_confidence,
    latest_suggestion.status AS suggestion_status
  FROM tickets t
  JOIN clients c ON c.id = t.client_id
  JOIN whatsapp_groups g ON g.id = t.group_id
  LEFT JOIN participants requester
    ON requester.id = COALESCE(${requesterOverride}, (
      SELECT requester_message.sender_id
      FROM ticket_messages requester_ticket_message
      JOIN messages requester_message
        ON requester_message.id = requester_ticket_message.message_id
      LEFT JOIN staff_members requester_staff
        ON requester_staff.participant_id = requester_message.sender_id
       AND requester_staff.active = 1
      WHERE requester_ticket_message.ticket_id = t.id
        AND requester_staff.participant_id IS NULL
      ORDER BY requester_message.occurred_at, requester_message.id
      LIMIT 1
    ))
  LEFT JOIN client_stores s ON s.id = t.affected_store_id
  ${assigneeJoin}
  LEFT JOIN suggestions latest_suggestion
    ON latest_suggestion.id = (
      SELECT suggestion.id
      FROM suggestions suggestion
      WHERE suggestion.ticket_id = t.id
      ORDER BY suggestion.created_at DESC, suggestion.id DESC
      LIMIT 1
    )
`;
}

function nowUtc(): string {
  return new Date().toISOString();
}

function isTerminalTicketStatus(status: TicketStatus): boolean {
  return status === "resolved" || status === "archived";
}

function attachmentMateriallyDiffers(
  existing: AttachmentMaterialState,
  input: UpsertAttachmentInput,
  normalized: { mimeType: string; localPath: string; sha256: string },
): boolean {
  return (
    existing.kind !== input.kind ||
    existing.mime_type !== normalized.mimeType ||
    existing.file_name !== (input.fileName ?? existing.file_name) ||
    existing.local_path !== normalized.localPath ||
    existing.size_bytes !== (input.sizeBytes ?? existing.size_bytes) ||
    existing.sha256 !== normalized.sha256 ||
    existing.extracted_text !==
      (input.extractedText ?? existing.extracted_text) ||
    existing.available !== (input.available === false ? 0 : 1)
  );
}

function includesInvestigationInstruction(
  existing: string | null,
  candidate: string | null,
): boolean {
  if (!candidate) return true;
  return (existing ?? "")
    .split(/\n{2,}/u)
    .some((instruction) => instruction.trim() === candidate);
}

function nextUtcTimestampAfter(value: string): string {
  const previousTimestamp = Date.parse(value);
  return new Date(
    Number.isNaN(previousTimestamp)
      ? Date.now()
      : Math.max(Date.now(), previousTimestamp + 1),
  ).toISOString();
}

function normalizedText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ValidationError(`${field} é obrigatório`);
  }
  return normalized;
}

function normalizedBoundedText(
  value: string,
  field: string,
  maxLength: number,
): string {
  const normalized = normalizedText(value, field);
  if (normalized.length > maxLength) {
    throw new ValidationError(
      `${field} deve ter no máximo ${maxLength.toLocaleString("pt-BR")} caracteres`,
      { field, maxLength, actualLength: normalized.length },
    );
  }
  return normalized;
}

function normalizedNullableText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function mapConversationReply(
  providerMessageId: string | null,
  value: unknown,
): ConversationReplyReferenceDto | null {
  if (!providerMessageId) return null;
  const target = value as ConversationReplyRow | undefined;
  if (!target) {
    return {
      providerMessageId,
      messageId: null,
      available: false,
      sender: null,
      text: null,
      messageType: null,
      occurredAt: null,
    };
  }
  return {
    providerMessageId,
    messageId: target.id,
    available: true,
    sender: {
      id: target.sender_id,
      displayName: target.display_name,
      isStaff: Boolean(target.is_staff),
    },
    text: target.text,
    messageType: target.message_type,
    occurredAt: target.occurred_at,
  };
}

function mapConversationReactions(value: unknown): ConversationReactionDto[] {
  const rows = value as ConversationReactionRow[];
  const grouped = new Map<string, ConversationReactionDto>();
  for (const row of rows) {
    if (!row.emoji) continue;
    const current = grouped.get(row.emoji) ?? {
      emoji: row.emoji,
      count: 0,
      reactors: [],
    };
    current.count += 1;
    current.reactors.push({
      id: row.reactor_id,
      displayName: row.display_name,
      isStaff: Boolean(row.is_staff),
    });
    grouped.set(row.emoji, current);
  }
  return [...grouped.values()];
}

function normalizedRoutingText(value: string | null): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function containsRoutingPhrase(text: string, phrase: string): boolean {
  return Boolean(phrase && ` ${text} `.includes(` ${phrase} `));
}

function triageDecisionHasExplicitTopicSwitch(
  decision: TriageAnalysis["groups"][number],
  input: TriageAnalysisInput,
): boolean {
  const candidateIds = new Set(decision.messageIds);
  const text = normalizedRoutingText(
    input.messages
      .filter((message) => candidateIds.has(message.id))
      .map((message) => message.text)
      .filter((value): value is string => Boolean(value))
      .join("\n"),
  );
  return [
    "outro problema",
    "outra coisa",
    "outro ponto",
    "alem disso",
    "tambem estou com",
  ].some((phrase) => containsRoutingPhrase(text, phrase));
}

function isSqliteConstraint(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      String((error as { code?: unknown }).code).startsWith("SQLITE_CONSTRAINT"),
  );
}

function clampConfidence(value: number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new ValidationError("Confiança deve estar entre 0 e 1", { value });
  }
  return value;
}

function triageActionRank(action: TriageSuggestedAction | null): number {
  if (action === "create") return 3;
  if (action === "attach") return 2;
  if (action === "ignore") return 1;
  return 0;
}

function triageKindRank(kind: TriageKind): number {
  if (kind === "demand") return 7;
  if (kind === "uncertain") return 6;
  if (kind === "continuation") return 5;
  if (kind === "information") return 4;
  if (kind === "social") return 3;
  if (kind === "context") return 2;
  return 1;
}

function parseJson<T>(json: string | null, fallback: T): T {
  if (!json) {
    return fallback;
  }
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

function databaseHasTable(database: SupportDatabase, table: string): boolean {
  return Boolean(
    database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      )
      .get(table),
  );
}

function extractMentionedJids(rawJson: string | null): string[] {
  const mentions = new Set<string>();
  collectMentionedJids(parseJson<unknown>(rawJson, null), mentions, 0);
  return [...mentions];
}

function collectMentionedJids(
  value: unknown,
  mentions: Set<string>,
  depth: number,
): void {
  if (depth > 12 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectMentionedJids(item, mentions, depth + 1);
    return;
  }

  const record = value as Record<string, unknown>;
  if (Array.isArray(record.mentionedJid)) {
    for (const jid of record.mentionedJid) {
      if (typeof jid === "string" && jid.trim()) mentions.add(jid.trim());
    }
  }
  for (const nested of Object.values(record)) {
    collectMentionedJids(nested, mentions, depth + 1);
  }
}

function presentMessageText(
  text: string | null,
  rawJson: string | null,
  mentionNames: ReadonlyMap<string, string>,
): string | null {
  if (!text || !mentionNames.size) return text;

  let presented = text;
  for (const jid of extractMentionedJids(rawJson)) {
    const name = mentionNames.get(jid);
    const mentionId = jid.split("@", 1)[0]?.trim();
    if (!name || !mentionId) continue;
    presented = presented.replaceAll(`@${mentionId}`, `@${name}`);
  }
  return presented;
}

function isDirectoryFieldValue(value: unknown): value is DirectoryFieldValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}

function directoryFieldDisplayValue(
  value: DirectoryFieldValue,
  type: DirectoryFieldType,
  recordNames: ReadonlyMap<string, string>,
): string {
  if (value === null) return "Não informado";
  if (type === "boolean" && typeof value === "boolean") {
    return value ? "Sim" : "Não";
  }
  if (type === "number" && typeof value === "number") {
    return value.toLocaleString("pt-BR");
  }
  const values = Array.isArray(value) ? value : [String(value)];
  if (type === "relation") {
    return values.map((item) => recordNames.get(item) ?? item).join(", ");
  }
  return values.join(", ");
}

function emptyTriageCategories(): TriageAnalysis["groups"][number]["categories"] {
  return {
    contactReason: [],
    productArea: [],
    platform: [],
    symptom: [],
  };
}

function mergeTriageCategories(
  next: TriageAnalysis["groups"][number]["categories"],
  previous: TriageAnalysis["groups"][number]["categories"],
): TriageAnalysis["groups"][number]["categories"] {
  const normalizedPrevious = normalizeAnalysisCategories(previous);
  return {
    contactReason: next.contactReason.length
      ? next.contactReason
      : normalizedPrevious.contactReason,
    productArea: next.productArea.length
      ? next.productArea
      : normalizedPrevious.productArea,
    platform: next.platform.length ? next.platform : normalizedPrevious.platform,
    symptom: next.symptom.length ? next.symptom : normalizedPrevious.symptom,
  };
}

function analysisAttachmentKind(
  kind: AttachmentDto["kind"],
): TriageAnalysisInput["messages"][number]["attachments"][number]["kind"] {
  if (kind === "image") return "image";
  if (kind === "document" || kind === "pdf") return "document";
  if (kind === "video") return "video";
  return "other";
}

function assertTriageAnalysisCoverage(
  input: TriageAnalysisInput,
  analysis: TriageAnalysis,
): void {
  const candidateIds = input.candidateMessageIds;
  const expected = new Set(candidateIds);
  const observed = new Set<string>();
  const allowedContext = new Set(
    input.messages
      .filter((message) => message.role === "staff" || message.role === "self")
      .map((message) => message.id),
  );
  const observedContext = new Set<string>();
  for (const decision of analysis.groups) {
    for (const messageId of decision.contextMessageIds ?? []) {
      if (!allowedContext.has(messageId)) {
        throw new ValidationError(
          "Resultado de triagem contém contexto interno fora do job",
          { messageId },
        );
      }
      if (expected.has(messageId) || observedContext.has(messageId)) {
        throw new ValidationError(
          "Resultado de triagem repete ou mistura mensagem de contexto",
          { messageId },
        );
      }
      if (
        decision.suggestedAction === "ignore" ||
        decision.suggestedAction === "wait"
      ) {
        throw new ValidationError(
          "Conteúdo ignorado ou em espera não pode incorporar resposta interna",
          { messageId },
        );
      }
      observedContext.add(messageId);
    }
    for (const messageId of decision.messageIds) {
      if (!expected.has(messageId)) {
        throw new ValidationError(
          "Resultado de triagem contém mensagem fora do job",
          { messageId },
        );
      }
      if (observed.has(messageId)) {
        throw new ValidationError(
          "Resultado de triagem repete a mesma mensagem",
          { messageId },
        );
      }
      observed.add(messageId);
    }
  }
  const missing = candidateIds.filter((messageId) => !observed.has(messageId));
  if (missing.length) {
    throw new ValidationError("Resultado de triagem omitiu mensagens do job", {
      messageIds: missing,
    });
  }
}

function encodePageCursor(
  occurredAt: string,
  id: string,
  filterKey?: string,
): string {
  return Buffer.from(
    JSON.stringify({ occurredAt, id, ...(filterKey ? { filterKey } : {}) }),
    "utf8",
  ).toString(
    "base64url",
  );
}

function decodePageCursor(
  cursor: string | undefined,
  field: string,
): { occurredAt: string; id: string; filterKey: string | null } | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { occurredAt?: unknown; id?: unknown; filterKey?: unknown };
    if (typeof value.occurredAt !== "string" || typeof value.id !== "string") {
      throw new Error("cursor incompleto");
    }
    return {
      occurredAt: value.occurredAt,
      id: value.id,
      filterKey: typeof value.filterKey === "string" ? value.filterKey : null,
    };
  } catch {
    throw new ValidationError(`${field} inválido`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function trimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return value.trim() || null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => trimmedString(item))
    .filter((item): item is string => item !== null);
}

function investigationOutcome(value: unknown): InvestigationOutcome | null {
  return typeof value === "string" &&
    INVESTIGATION_OUTCOMES.includes(value as InvestigationOutcome)
    ? (value as InvestigationOutcome)
    : null;
}

const THREAD_PROMPT_MESSAGE_LIMIT = 16;
const THREAD_PROMPT_CHARACTER_LIMIT = 24_000;
const THREAD_PROMPT_TICKET_MESSAGE_LIMIT = 100;
const TOOL_AUDIT_REQUEST_ID_MAX_LENGTH = 200;
const TOOL_AUDIT_IDENTITY_MAX_LENGTH = 500;
const TOOL_AUDIT_ARGUMENTS_MAX_LENGTH = 20_000;
const TOOL_AUDIT_PURPOSE_MAX_LENGTH = 4_000;
const TOOL_AUDIT_SUMMARY_MAX_LENGTH = 4_000;
const TOOL_AUDIT_CONTENT_MAX_LENGTH = 50_000;
const SUPPORT_PROMPT_CHARACTER_LIMIT = 64_000;
const SUPPORT_PROMPT_MESSAGE_TEXT_LIMIT = 8_000;
const SUPPORT_PROMPT_ATTACHMENT_TEXT_LIMIT = 8_000;
const SUPPORT_PROMPT_SENT_RESPONSE_LIMIT = 8;
const SUPPORT_PROMPT_RESOLVED_PRECEDENT_LIMIT = 5;
const SENT_RESPONSE_DEDUPLICATION_LIMIT = 50;
const AUTOMATIC_INVESTIGATION_PROMPT_VERSION = "support-analysis-v3";
const DEEP_INVESTIGATION_PROMPT_VERSION = "investigation-thread-v2";

function truncatePromptText(value: string, limit: number): string {
  if (limit <= 0) return "";
  if (value.length <= limit) return value;
  const marker = "\n[… conteúdo intermediário omitido do prompt; original preservado no SQLite …]\n";
  if (limit <= marker.length) return value.slice(0, limit);
  const available = Math.max(0, limit - marker.length);
  const beginning = Math.ceil(available * 0.6);
  const ending = available - beginning;
  return `${value.slice(0, beginning)}${marker}${ending > 0 ? value.slice(-ending) : ""}`;
}

function limitSupportPromptMessages(
  messages: SupportAnalysisInput["messages"],
): SupportAnalysisInput["messages"] {
  const selected: SupportAnalysisInput["messages"] = [];
  let remaining = SUPPORT_PROMPT_CHARACTER_LIMIT;

  for (const message of messages.toReversed()) {
    const text = message.text && remaining > 0
      ? truncatePromptText(
          message.text,
          Math.min(SUPPORT_PROMPT_MESSAGE_TEXT_LIMIT, remaining),
        )
      : null;
    remaining -= text?.length ?? 0;

    const attachments = message.attachments.map((attachment) => {
      if (!attachment.extractedText || remaining <= 0) {
        return { ...attachment, extractedText: null };
      }
      const extractedText = truncatePromptText(
        attachment.extractedText,
        Math.min(SUPPORT_PROMPT_ATTACHMENT_TEXT_LIMIT, remaining),
      );
      remaining -= extractedText.length;
      return { ...attachment, extractedText };
    });
    selected.push({ ...message, text, attachments });
  }

  return selected.reverse();
}

function responsesAreEquivalent(left: string, right: string): boolean {
  const normalizedLeft = normalizedRoutingText(left);
  const normalizedRight = normalizedRoutingText(right);
  return Boolean(normalizedLeft && normalizedLeft === normalizedRight);
}

function exactResponseBodiesMatch(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase("pt-BR") === right.trim().toLocaleLowerCase("pt-BR");
}

function limitRecentThreadMessages(
  messages: InvestigationThreadInput["recentMessages"],
): InvestigationThreadInput["recentMessages"] {
  const selected: InvestigationThreadInput["recentMessages"] = [];
  let characterCount = 0;

  for (const message of messages.toReversed()) {
    if (selected.length >= THREAD_PROMPT_MESSAGE_LIMIT) break;
    const available = THREAD_PROMPT_CHARACTER_LIMIT - characterCount;
    if (available <= 0) break;
    const body = message.body.slice(-available);
    if (!body) continue;
    selected.push({ ...message, body });
    characterCount += body.length;
  }

  return selected.reverse();
}

function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

export class SupportStore {
  private productForwardingSchemaAvailable = false;
  private triageAiJobSchemaAvailable = false;
  private triageContextWaitSchemaAvailable = false;

  private readonly requesterOverrideAvailable: boolean;
  private readonly assigneeColumnAvailable: boolean;

  constructor(readonly database: SupportDatabase) {
    this.requesterOverrideAvailable = Boolean(
      this.database
        .prepare(
          `SELECT 1
           FROM pragma_table_info('tickets')
           WHERE name = 'requester_id'
           LIMIT 1`,
        )
        .get(),
    );
    this.assigneeColumnAvailable = Boolean(
      this.database
        .prepare(
          `SELECT 1
           FROM pragma_table_info('tickets')
           WHERE name = 'assignee_user_id'
           LIMIT 1`,
        )
        .get(),
    );
  }

  private ticketSelect(): string {
    return ticketSelect(
      this.requesterOverrideAvailable,
      this.assigneeColumnAvailable,
    );
  }

  upsertAccount(input: UpsertAccountInput): EntityRecord {
    const id = input.id ?? randomUUID();
    const timestamp = nowUtc();
    return this.database
      .prepare(
        `INSERT INTO whatsapp_accounts
          (id, phone_number, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(phone_number) DO UPDATE SET
          display_name = excluded.display_name,
          updated_at = excluded.updated_at
         RETURNING id`,
      )
      .get(
        id,
        normalizedText(input.phoneNumber, "Número da conta"),
        normalizedText(input.displayName, "Nome da conta"),
        timestamp,
        timestamp,
      ) as EntityRecord;
  }

  upsertClient(input: UpsertClientInput): EntityRecord {
    const id = input.id ?? randomUUID();
    const timestamp = nowUtc();
    return this.database
      .prepare(
        `INSERT INTO clients
          (id, name, slug, kind, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET
          name = CASE WHEN clients.manual_override = 1 THEN clients.name ELSE excluded.name END,
          kind = CASE WHEN clients.manual_override = 1 THEN clients.kind ELSE excluded.kind END,
          notes = CASE WHEN clients.manual_override = 1 THEN clients.notes ELSE excluded.notes END,
          updated_at = excluded.updated_at
         RETURNING id`,
      )
      .get(
        id,
        normalizedText(input.name, "Nome do cliente"),
        normalizedText(input.slug, "Slug do cliente"),
        input.kind,
        input.notes ?? null,
        timestamp,
        timestamp,
      ) as EntityRecord;
  }

  markClientIdentificationPending(clientId: string): boolean {
    this.assertEntityExists("Cliente", "clients", clientId);
    const result = this.database
      .prepare(
        `UPDATE clients
         SET name = 'Cliente não identificado',
             notes = COALESCE(
               notes,
               'Contato privado criado automaticamente; associe uma agência ou ecommerce antes de concluir a revisão.'
             ),
             identification_pending = 1,
             updated_at = ?
         WHERE id = ?
           AND manual_override = 0
           AND ignored_at IS NULL`,
      )
      .run(nowUtc(), clientId);
    return result.changes > 0;
  }

  upsertStore(input: UpsertStoreInput): EntityRecord {
    this.assertEntityExists("Cliente", "clients", input.clientId);
    const timestamp = nowUtc();
    const existing = this.database
      .prepare(
        `SELECT id FROM client_stores
         WHERE client_id = ?
           AND (name = ? OR (? IS NOT NULL AND business_id = ?))
         ORDER BY CASE WHEN business_id = ? THEN 0 ELSE 1 END
         LIMIT 1`,
      )
      .get(
        input.clientId,
        input.name,
        input.businessId ?? null,
        input.businessId ?? null,
        input.businessId ?? null,
      ) as EntityRecord | undefined;
    const id = existing?.id ?? input.id ?? randomUUID();

    if (existing) {
      this.database
        .prepare(
          `UPDATE client_stores
           SET name = ?, business_id = ?, platform = ?, active = 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          normalizedText(input.name, "Nome da loja"),
          input.businessId ?? null,
          input.platform ?? null,
          timestamp,
          id,
        );
      return { id };
    }

    this.database
      .prepare(
        `INSERT INTO client_stores
          (id, client_id, name, business_id, platform, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.clientId,
        normalizedText(input.name, "Nome da loja"),
        input.businessId ?? null,
        input.platform ?? null,
        timestamp,
        timestamp,
      );
    return { id };
  }

  updateClientProfile(
    clientId: string,
    input: UpdateClientProfileInput,
  ): ClientSummaryDto {
    this.assertEntityExists("Cliente", "clients", clientId);
    const clientState = this.database
      .prepare("SELECT ignored_at FROM clients WHERE id = ?")
      .get(clientId) as { ignored_at: string | null };
    if (clientState.ignored_at) {
      throw new ConflictError(
        "O cliente foi excluído da operação e não pode ser editado",
        { clientId },
      );
    }
    const name = normalizedText(input.name, "Nome do cliente");
    const notes = normalizedNullableText(input.notes);
    const stores = input.stores.map((store, index) => ({
      id: store.id?.trim() || undefined,
      name: normalizedText(store.name, `Nome do ecommerce ${index + 1}`),
      businessId: normalizedNullableText(store.businessId),
      platform: normalizedNullableText(store.platform),
    }));

    const storeIds = stores.flatMap((store) => (store.id ? [store.id] : []));
    if (new Set(storeIds).size !== storeIds.length) {
      throw new ValidationError("O mesmo ecommerce foi informado mais de uma vez");
    }
    const normalizedNames = stores.map((store) => store.name.toLocaleLowerCase("pt-BR"));
    if (new Set(normalizedNames).size !== normalizedNames.length) {
      throw new ValidationError("Os nomes dos ecommerces não podem se repetir");
    }
    const businessIds = stores
      .map((store) => store.businessId?.toLocaleLowerCase("pt-BR"))
      .filter((value): value is string => Boolean(value));
    if (new Set(businessIds).size !== businessIds.length) {
      throw new ValidationError("Os business IDs dos ecommerces não podem se repetir");
    }

    const save = this.database.transaction(() => {
      const timestamp = nowUtc();
      this.database
        .prepare(
          `UPDATE clients
           SET name = ?, kind = ?, notes = ?, manual_override = 1,
               identification_pending = 0, updated_at = ?
           WHERE id = ?`,
        )
        .run(name, input.kind, notes, timestamp, clientId);

      const existingRows = this.database
        .prepare(
          `SELECT id, name, business_id
           FROM client_stores
           WHERE client_id = ?`,
        )
        .all(clientId) as Array<{
        id: string;
        name: string;
        business_id: string | null;
      }>;
      const existingById = new Map(existingRows.map((store) => [store.id, store]));
      const retainedIds = new Set<string>();

      for (const store of stores) {
        let storeId = store.id;
        if (storeId) {
          const ownedStore = this.database
            .prepare("SELECT client_id FROM client_stores WHERE id = ?")
            .get(storeId) as { client_id: string } | undefined;
          if (!ownedStore) throw new NotFoundError("Loja", storeId);
          if (ownedStore.client_id !== clientId) {
            throw new ValidationError("O ecommerce não pertence a este cliente", {
              clientId,
              storeId,
            });
          }
        } else {
          const reusable = existingRows.find(
            (existing) =>
              !retainedIds.has(existing.id) &&
              (existing.name.toLocaleLowerCase("pt-BR") ===
                store.name.toLocaleLowerCase("pt-BR") ||
                (store.businessId &&
                  existing.business_id?.toLocaleLowerCase("pt-BR") ===
                    store.businessId.toLocaleLowerCase("pt-BR"))),
          );
          storeId = reusable?.id ?? randomUUID();
        }

        if (existingById.has(storeId)) {
          this.database
            .prepare(
              `UPDATE client_stores
               SET name = ?, business_id = ?, platform = ?, active = 1, updated_at = ?
               WHERE id = ?`,
            )
            .run(
              store.name,
              store.businessId,
              store.platform,
              timestamp,
              storeId,
            );
        } else {
          this.database
            .prepare(
              `INSERT INTO client_stores
                (id, client_id, name, business_id, platform, active, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
            )
            .run(
              storeId,
              clientId,
              store.name,
              store.businessId,
              store.platform,
              timestamp,
              timestamp,
            );
        }
        retainedIds.add(storeId);
      }

      const retained = [...retainedIds];
      const archiveSql = retained.length
        ? `UPDATE client_stores
           SET active = 0, updated_at = ?
           WHERE client_id = ? AND id NOT IN (${retained.map(() => "?").join(", ")})`
        : `UPDATE client_stores
           SET active = 0, updated_at = ?
           WHERE client_id = ?`;
      this.database.prepare(archiveSql).run(timestamp, clientId, ...retained);
    });

    try {
      save();
    } catch (error) {
      if (error instanceof ConflictError || error instanceof ValidationError || error instanceof NotFoundError) {
        throw error;
      }
      if (isSqliteConstraint(error)) {
        throw new ConflictError(
          "Já existe um ecommerce com esse nome ou business ID para o cliente",
        );
      }
      throw error;
    }

    const updated = this.listClients().find((client) => client.id === clientId);
    if (!updated) throw new NotFoundError("Cliente", clientId);
    return updated;
  }

  ignoreClient(
    clientId: string,
    input: { actor?: string; reason?: string | null } = {},
  ): DeleteClientResponse {
    const client = this.database
      .prepare("SELECT id, ignored_at FROM clients WHERE id = ?")
      .get(clientId) as { id: string; ignored_at: string | null } | undefined;
    if (!client) throw new NotFoundError("Cliente", clientId);

    const preserved = this.database
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM whatsapp_groups g WHERE g.client_id = ?) AS groups,
          (SELECT COUNT(*) FROM messages m
           JOIN whatsapp_groups g ON g.id = m.group_id
           WHERE g.client_id = ?) AS messages,
          (SELECT COUNT(*) FROM attachments a
           JOIN messages m ON m.id = a.message_id
           JOIN whatsapp_groups g ON g.id = m.group_id
           WHERE g.client_id = ?) AS attachments,
          (SELECT COUNT(*) FROM tickets t WHERE t.client_id = ?) AS tickets,
          (SELECT COUNT(*) FROM tickets t
           WHERE t.client_id = ? AND t.status NOT IN ('resolved', 'archived')) AS open_tickets`,
      )
      .get(clientId, clientId, clientId, clientId, clientId) as {
      groups: number;
      messages: number;
      attachments: number;
      tickets: number;
      open_tickets: number;
    };

    if (client.ignored_at) {
      return {
        id: clientId,
        ignoredAt: client.ignored_at,
        alreadyIgnored: true,
        preserved: {
          groups: preserved.groups,
          messages: preserved.messages,
          attachments: preserved.attachments,
          tickets: preserved.tickets,
          openTickets: preserved.open_tickets,
        },
      };
    }

    const ignoredAt = nowUtc();
    const actor = normalizedNullableText(input.actor) ?? "Operador local";
    const reason = normalizedNullableText(input.reason);
    this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE clients
           SET ignored_at = ?, ignored_by = ?, ignore_reason = ?,
               identification_pending = 0, updated_at = ?
           WHERE id = ? AND ignored_at IS NULL`,
        )
        .run(ignoredAt, actor, reason, ignoredAt, clientId);
      this.database
        .prepare(
          `UPDATE whatsapp_groups
           SET monitored = 0, updated_at = ?
           WHERE client_id = ?`,
        )
        .run(ignoredAt, clientId);
      this.database
        .prepare(
          `UPDATE messages
           SET triage_kind = 'context', triage_state = 'context', updated_at = ?
           WHERE triage_state = 'unreviewed'
             AND group_id IN (
               SELECT id FROM whatsapp_groups WHERE client_id = ?
             )`,
        )
        .run(ignoredAt, clientId);
    })();

    return {
      id: clientId,
      ignoredAt,
      alreadyIgnored: false,
      preserved: {
        groups: preserved.groups,
        messages: preserved.messages,
        attachments: preserved.attachments,
        tickets: preserved.tickets,
        openTickets: preserved.open_tickets,
      },
    };
  }

  updateTicketContext(
    ticketId: string,
    input: UpdateTicketContextInput,
  ): TicketDetailDto {
    return this.database.transaction(() => {
      const ticket = this.database
        .prepare(
          `SELECT t.id, t.client_id, t.group_id, t.affected_store_id,
                  g.client_id AS conversation_client_id,
                  c.name AS current_client_name
           FROM tickets t
           JOIN whatsapp_groups g ON g.id = t.group_id
           JOIN clients c ON c.id = t.client_id
           WHERE t.id = ?`,
        )
        .get(ticketId) as
        | {
            id: string;
            client_id: string;
            group_id: string;
            affected_store_id: string | null;
            conversation_client_id: string;
            current_client_name: string;
          }
        | undefined;
      if (!ticket) throw new NotFoundError("Ticket", ticketId);

      const targetClient = this.database
        .prepare(
          `SELECT id, name, kind
           FROM clients
           WHERE id = ? AND ignored_at IS NULL`,
        )
        .get(input.clientId) as
        | { id: string; name: string; kind: ClientKind }
        | undefined;
      if (!targetClient) {
        throw new NotFoundError("Cliente ativo", input.clientId);
      }

      const affectedStoreId = normalizedNullableText(input.affectedStoreId);
      let affectedStoreName: string | null = null;
      if (affectedStoreId) {
        const store = this.database
          .prepare(
            `SELECT name
             FROM client_stores
             WHERE id = ? AND client_id = ? AND active = 1`,
          )
          .get(affectedStoreId, targetClient.id) as { name: string } | undefined;
        if (!store) {
          throw new ValidationError(
            "O ecommerce não pertence ao cliente selecionado ou está inativo",
            { clientId: targetClient.id, affectedStoreId },
          );
        }
        affectedStoreName = store.name;
      }

      const rememberForConversation = input.rememberForConversation === true;
      const ticketChanged =
        ticket.client_id !== targetClient.id ||
        ticket.affected_store_id !== affectedStoreId;
      const conversationChanged =
        rememberForConversation &&
        ticket.conversation_client_id !== targetClient.id;
      if (!ticketChanged && !conversationChanged) {
        return this.getTicketDetail(ticketId);
      }

      const timestamp = nowUtc();
      this.database
        .prepare(
          `UPDATE tickets
           SET client_id = ?, affected_store_id = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(targetClient.id, affectedStoreId, timestamp, ticketId);
      this.invalidateLegacyAutomaticGuidance(ticketId, timestamp);

      if (rememberForConversation) {
        this.database
          .prepare(
          `UPDATE whatsapp_groups
             SET client_id = ?, client_link_source = 'manual', updated_at = ?
             WHERE id = ?`,
          )
          .run(targetClient.id, timestamp, ticket.group_id);
      }

      this.insertTicketEvent({
        ticketId,
        eventType: "ticket_context_changed",
        actor: normalizedNullableText(input.actor) ?? "Operador local",
        fromStatus: null,
        toStatus: null,
        data: {
          previousClientId: ticket.client_id,
          previousClientName: ticket.current_client_name,
          clientId: targetClient.id,
          clientName: targetClient.name,
          affectedStoreId,
          affectedStoreName,
          rememberForConversation,
          description: `Ticket associado a ${targetClient.name}${
            affectedStoreName ? ` · ${affectedStoreName}` : ""
          }.`,
        },
        occurredAt: timestamp,
      });

      if (rememberForConversation && ticket.client_id !== targetClient.id) {
        this.database
          .prepare(
            `UPDATE clients
             SET ignored_at = ?, ignored_by = 'system',
                 ignore_reason = 'Cadastro provisório substituído por associação manual',
                 identification_pending = 0, updated_at = ?
             WHERE id = ?
               AND identification_pending = 1
               AND NOT EXISTS (
                 SELECT 1 FROM whatsapp_groups g WHERE g.client_id = clients.id
               )
               AND NOT EXISTS (
                 SELECT 1 FROM tickets t WHERE t.client_id = clients.id
               )`,
          )
          .run(timestamp, timestamp, ticket.client_id);
      }

      return this.getTicketDetail(ticketId);
    })();
  }

  updateTicketMetadata(
    ticketId: string,
    input: UpdateTicketMetadataInput,
    actor = "Operador local",
  ): TicketDetailDto {
    const title = normalizedBoundedText(
      input.title,
      "Título do ticket",
      TICKET_TITLE_MAX_LENGTH,
    );
    const summary = normalizedBoundedText(
      input.summary,
      "Descrição do ticket",
      TICKET_SUMMARY_MAX_LENGTH,
    );
    if (!TICKET_PRIORITIES.includes(input.priority)) {
      throw new ValidationError("Prioridade do ticket inválida", {
        priority: input.priority,
      });
    }
    const requesterId = normalizedNullableText(input.requesterId);
    const responsible = normalizedBoundedText(actor, "Responsável", 200);

    return this.database.transaction(() => {
      const current = this.database
        .prepare(
          `SELECT id, title, summary, priority, requester_id
           FROM tickets
           WHERE id = ?`,
        )
        .get(ticketId) as
        | {
            id: string;
            title: string;
            summary: string;
            priority: TicketPriority;
            requester_id: string | null;
          }
        | undefined;
      if (!current) throw new NotFoundError("Ticket", ticketId);

      const requesterCandidates = this.getTicketRequesterCandidates(ticketId);
      const requester = requesterId
        ? requesterCandidates.find((candidate) => candidate.id === requesterId)
        : null;
      if (requesterId && !requester) {
        throw new ValidationError(
          "O solicitante deve ser um participante ativo desta conversa e não pode fazer parte da equipe",
          { ticketId, requesterId },
        );
      }

      const changedFields = [
        current.title !== title ? "title" : null,
        current.summary !== summary ? "summary" : null,
        current.priority !== input.priority ? "priority" : null,
        current.requester_id !== requesterId ? "requester" : null,
      ].filter((field): field is string => Boolean(field));
      if (!changedFields.length) return this.getTicketDetail(ticketId);

      const timestamp = nowUtc();
      this.database
        .prepare(
          `UPDATE tickets
           SET title = ?, summary = ?, priority = ?, requester_id = ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(title, summary, input.priority, requesterId, timestamp, ticketId);
      this.invalidateLegacyAutomaticGuidance(ticketId, timestamp);

      const fieldLabels: Record<string, string> = {
        title: "título",
        summary: "descrição",
        priority: "prioridade",
        requester: "solicitante",
      };
      this.insertTicketEvent({
        ticketId,
        eventType: "ticket_metadata_updated",
        actor: responsible,
        fromStatus: null,
        toStatus: null,
        data: {
          changedFields,
          previousTitle: current.title,
          previousSummary: current.summary,
          previousPriority: current.priority,
          previousRequesterId: current.requester_id,
          title,
          summary,
          priority: input.priority,
          requesterId,
          requesterName: requester?.displayName ?? null,
          description: `${responsible} atualizou ${changedFields
            .map((field) => fieldLabels[field])
            .join(", ")} do ticket.`,
        },
        occurredAt: timestamp,
      });

      return this.getTicketDetail(ticketId);
    })();
  }

  listTicketAssignees(): TicketAssigneeDto[] {
    return (
      this.database
        .prepare(
          `SELECT id, display_name, role
           FROM local_users
           WHERE active = 1
             AND role IN ('owner', 'admin', 'operator')
           ORDER BY display_name COLLATE NOCASE, id`,
        )
        .all() as Array<{
        id: string;
        display_name: string;
        role: AuthRole;
      }>
    ).map((user) => ({
      id: user.id,
      displayName: user.display_name,
      role: user.role,
    }));
  }

  updateTicketAssignee(
    ticketId: string,
    assigneeId: string | null,
    actor = "Operador local",
  ): TicketDetailDto {
    const normalizedAssigneeId = normalizedNullableText(assigneeId);
    const responsible = normalizedBoundedText(actor, "Responsável", 200);

    return this.database.transaction(() => {
      const current = this.database
        .prepare(
          `SELECT t.id, t.assignee_user_id,
                  current_assignee.display_name AS assignee_display_name
           FROM tickets t
           LEFT JOIN local_users current_assignee
             ON current_assignee.id = t.assignee_user_id
           WHERE t.id = ?`,
        )
        .get(ticketId) as
        | {
            id: string;
            assignee_user_id: string | null;
            assignee_display_name: string | null;
          }
        | undefined;
      if (!current) throw new NotFoundError("Ticket", ticketId);

      const nextAssignee = normalizedAssigneeId
        ? (this.database
            .prepare(
              `SELECT id, display_name, role
               FROM local_users
               WHERE id = ? AND active = 1
                 AND role IN ('owner', 'admin', 'operator')`,
            )
            .get(normalizedAssigneeId) as
            | { id: string; display_name: string; role: AuthRole }
            | undefined)
        : null;
      if (normalizedAssigneeId && !nextAssignee) {
        throw new ValidationError(
          "O responsável deve ser um usuário ativo da equipe de suporte",
          { ticketId, assigneeId: normalizedAssigneeId },
        );
      }
      if (current.assignee_user_id === normalizedAssigneeId) {
        return this.getTicketDetail(ticketId);
      }

      const timestamp = nowUtc();
      this.database
        .prepare(
          `UPDATE tickets
           SET assignee_user_id = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(normalizedAssigneeId, timestamp, ticketId);

      const nextName = nextAssignee?.display_name ?? null;
      this.insertTicketEvent({
        ticketId,
        eventType: nextAssignee ? "ticket_assigned" : "ticket_unassigned",
        actor: responsible,
        fromStatus: null,
        toStatus: null,
        data: {
          previousAssigneeId: current.assignee_user_id,
          previousAssigneeName: current.assignee_display_name,
          assigneeId: nextAssignee?.id ?? null,
          assigneeName: nextName,
          description: nextAssignee
            ? `${responsible} atribuiu o ticket a ${nextName}.`
            : `${responsible} deixou o ticket sem responsável.`,
        },
        occurredAt: timestamp,
      });

      return this.getTicketDetail(ticketId);
    })();
  }

  updateTicketDirectoryContext(
    ticketId: string,
    input: UpdateTicketDirectoryContextInput,
    actor = "Operador local",
  ): TicketDetailDto {
    if (!Array.isArray(input.recordIds)) {
      throw new ValidationError("Informe os registros do Diretório selecionados");
    }
    if (input.recordIds.length > 500) {
      throw new ValidationError(
        "Vincule no máximo 500 registros do Diretório por ticket",
      );
    }
    const recordIds = input.recordIds.map((recordId) =>
      normalizedBoundedText(recordId, "ID do registro", 200),
    );
    if (new Set(recordIds).size !== recordIds.length) {
      throw new ValidationError("A seleção contém registros duplicados");
    }
    const responsible = normalizedBoundedText(actor, "Responsável", 200);

    return this.database.transaction(() => {
      this.assertEntityExists("Ticket", "tickets", ticketId);
      const selectedRecords = recordIds.length
        ? (this.database
            .prepare(
              `SELECT record.id, record.name
               FROM directory_records record
               JOIN directory_record_types record_type
                 ON record_type.id = record.record_type_id
                AND record_type.archived_at IS NULL
               WHERE record.archived_at IS NULL
                 AND record.id IN (${recordIds.map(() => "?").join(", ")})`,
            )
            .all(...recordIds) as Array<{ id: string; name: string }>)
        : [];
      const selectedIds = new Set(selectedRecords.map((record) => record.id));
      const missingRecordIds = recordIds.filter(
        (recordId) => !selectedIds.has(recordId),
      );
      if (missingRecordIds.length) {
        throw new ValidationError(
          "Somente registros ativos do Diretório podem ser vinculados ao ticket",
          { recordIds: missingRecordIds },
        );
      }

      const currentLinks = this.database
        .prepare(
          `SELECT record_id, relationship_key
           FROM ticket_record_links
           WHERE ticket_id = ? AND archived_at IS NULL
           ORDER BY record_id, relationship_key`,
        )
        .all(ticketId) as Array<{
        record_id: string;
        relationship_key: string;
      }>;
      const currentRecordIds = [
        ...new Set(currentLinks.map((link) => link.record_id)),
      ].toSorted();
      const nextRecordIds = [...recordIds].toSorted();
      const alreadyCanonical =
        currentLinks.length === nextRecordIds.length &&
        currentLinks.every((link) => link.relationship_key === "context") &&
        currentRecordIds.length === nextRecordIds.length &&
        currentRecordIds.every(
          (recordId, index) => recordId === nextRecordIds[index],
        );
      if (alreadyCanonical) return this.getTicketDetail(ticketId);

      const timestamp = nowUtc();
      this.database
        .prepare(
          `UPDATE ticket_record_links
           SET archived_at = ?, archived_by = ?, updated_by = ?, updated_at = ?
           WHERE ticket_id = ? AND archived_at IS NULL`,
        )
        .run(timestamp, responsible, responsible, timestamp, ticketId);
      const insert = this.database.prepare(
        `INSERT INTO ticket_record_links (
           ticket_id, record_id, relationship_key, archived_at, archived_by,
           created_by, updated_by, created_at, updated_at
         ) VALUES (?, ?, 'context', NULL, NULL, ?, ?, ?, ?)
         ON CONFLICT(ticket_id, record_id, relationship_key) DO UPDATE SET
           archived_at = NULL,
           archived_by = NULL,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      );
      for (const recordId of recordIds) {
        insert.run(
          ticketId,
          recordId,
          responsible,
          responsible,
          timestamp,
          timestamp,
        );
      }
      this.database
        .prepare("UPDATE tickets SET updated_at = ? WHERE id = ?")
        .run(timestamp, ticketId);
      this.invalidateLegacyAutomaticGuidance(ticketId, timestamp);
      this.insertTicketEvent({
        ticketId,
        eventType: "ticket_directory_context_changed",
        actor: responsible,
        fromStatus: null,
        toStatus: null,
        data: {
          previousRecordIds: currentRecordIds,
          recordIds: nextRecordIds,
          recordNames: selectedRecords.map((record) => record.name),
          description: nextRecordIds.length
            ? `${nextRecordIds.length} ${
                nextRecordIds.length === 1 ? "registro vinculado" : "registros vinculados"
              } ao contexto do ticket por ${responsible}.`
            : `Registros específicos removidos do contexto do ticket por ${responsible}.`,
        },
        occurredAt: timestamp,
      });
      return this.getTicketDetail(ticketId);
    })();
  }

  addTicketInternalNote(
    ticketId: string,
    input: AddTicketInternalNoteInput,
    actor = "Operador local",
  ): TicketDetailDto {
    const body = normalizedBoundedText(
      input.body,
      "Nota interna",
      TICKET_INTERNAL_NOTE_MAX_LENGTH,
    );
    const clientNoteId = normalizedBoundedText(
      input.clientNoteId,
      "ID idempotente da nota",
      200,
    );
    const responsible = normalizedBoundedText(actor, "Responsável", 200);
    const eventId = `ticket-note-${createHash("sha256")
      .update(`${ticketId}\u0000${clientNoteId}`)
      .digest("hex")}`;

    return this.database.transaction(() => {
      this.assertEntityExists("Ticket", "tickets", ticketId);
      const timestamp = nowUtc();
      const inserted = this.insertTicketEvent({
        id: eventId,
        ticketId,
        eventType: "internal_note_added",
        actor: responsible,
        fromStatus: null,
        toStatus: null,
        data: {
          body,
          clientNoteId,
          description: `Nota interna adicionada por ${responsible}.`,
        },
        occurredAt: timestamp,
      });
      if (inserted) {
        this.database
          .prepare("UPDATE tickets SET updated_at = ? WHERE id = ?")
          .run(timestamp, ticketId);
      }
      return this.getTicketDetail(ticketId);
    })();
  }

  updateTicketInternalNote(
    ticketId: string,
    noteId: string,
    input: UpdateTicketInternalNoteInput,
    actor = "Operador local",
  ): TicketDetailDto {
    const body = normalizedBoundedText(
      input.body,
      "Nota interna",
      TICKET_INTERNAL_NOTE_MAX_LENGTH,
    );
    const normalizedNoteId = normalizedBoundedText(
      noteId,
      "ID da nota interna",
      200,
    );
    const responsible = normalizedBoundedText(actor, "Responsável", 200);
    const expectedUpdatedAt = normalizedBoundedText(
      input.expectedUpdatedAt,
      "Versão esperada da nota interna",
      100,
    );
    if (Number.isNaN(Date.parse(expectedUpdatedAt))) {
      throw new ValidationError("Versão esperada da nota interna inválida", {
        expectedUpdatedAt,
      });
    }

    return this.database.transaction(() => {
      this.assertEntityExists("Ticket", "tickets", ticketId);
      const note = this.requireTicketInternalNoteEvent(
        ticketId,
        normalizedNoteId,
      );
      const currentData = parseJson<Record<string, unknown>>(
        note.data_json,
        {},
      );
      if (typeof currentData.deletedAt === "string") {
        throw new ConflictError("A nota interna já foi excluída", {
          ticketId,
          noteId: normalizedNoteId,
        });
      }
      const currentUpdatedAt =
        typeof currentData.updatedAt === "string"
          ? currentData.updatedAt
          : note.occurred_at;
      if (currentUpdatedAt !== expectedUpdatedAt) {
        throw new ConflictError(
          "A nota interna foi alterada por outro operador. Recarregue o ticket antes de salvar novamente.",
          {
            ticketId,
            noteId: normalizedNoteId,
            expectedUpdatedAt,
            currentUpdatedAt,
          },
        );
      }
      const previousBody =
        typeof currentData.body === "string" ? currentData.body : "";
      if (previousBody === body) return this.getTicketDetail(ticketId);

      const timestamp = nextUtcTimestampAfter(currentUpdatedAt);
      this.database
        .prepare(
          `UPDATE ticket_events
           SET data_json = ?
           WHERE id = ? AND ticket_id = ? AND event_type = 'internal_note_added'`,
        )
        .run(
          JSON.stringify({
            ...currentData,
            body,
            updatedAt: timestamp,
            updatedBy: responsible,
          }),
          normalizedNoteId,
          ticketId,
        );
      this.insertTicketEvent({
        ticketId,
        eventType: "internal_note_updated",
        actor: responsible,
        fromStatus: null,
        toStatus: null,
        data: {
          noteId: normalizedNoteId,
          previousBody,
          body,
          description: `Nota interna editada por ${responsible}.`,
        },
        occurredAt: timestamp,
      });
      this.database
        .prepare("UPDATE tickets SET updated_at = ? WHERE id = ?")
        .run(timestamp, ticketId);
      return this.getTicketDetail(ticketId);
    })();
  }

  deleteTicketInternalNote(
    ticketId: string,
    noteId: string,
    actor = "Operador local",
  ): TicketDetailDto {
    const normalizedNoteId = normalizedBoundedText(
      noteId,
      "ID da nota interna",
      200,
    );
    const responsible = normalizedBoundedText(actor, "Responsável", 200);

    return this.database.transaction(() => {
      this.assertEntityExists("Ticket", "tickets", ticketId);
      const note = this.requireTicketInternalNoteEvent(
        ticketId,
        normalizedNoteId,
      );
      const currentData = parseJson<Record<string, unknown>>(
        note.data_json,
        {},
      );
      if (typeof currentData.deletedAt === "string") {
        throw new ConflictError("A nota interna já foi excluída", {
          ticketId,
          noteId: normalizedNoteId,
        });
      }

      const currentUpdatedAt =
        typeof currentData.updatedAt === "string"
          ? currentData.updatedAt
          : note.occurred_at;
      const timestamp = nextUtcTimestampAfter(currentUpdatedAt);
      const redactedData = { ...currentData };
      delete redactedData.body;
      this.database
        .prepare(
          `UPDATE ticket_events
           SET data_json = ?
           WHERE id = ? AND ticket_id = ? AND event_type = 'internal_note_added'`,
        )
        .run(
          JSON.stringify({
            ...redactedData,
            deletedAt: timestamp,
            deletedBy: responsible,
          }),
          normalizedNoteId,
          ticketId,
        );
      const editAuditRows = this.database
        .prepare(
          `SELECT id, data_json
           FROM ticket_events
           WHERE ticket_id = ? AND event_type = 'internal_note_updated'`,
        )
        .all(ticketId) as Array<{ id: string; data_json: string }>;
      const updateAuditEvent = this.database.prepare(
        "UPDATE ticket_events SET data_json = ? WHERE id = ?",
      );
      for (const editAuditRow of editAuditRows) {
        const auditData = parseJson<Record<string, unknown>>(
          editAuditRow.data_json,
          {},
        );
        if (auditData.noteId !== normalizedNoteId) continue;
        delete auditData.previousBody;
        delete auditData.body;
        updateAuditEvent.run(
          JSON.stringify({ ...auditData, contentPurgedAt: timestamp }),
          editAuditRow.id,
        );
      }
      this.insertTicketEvent({
        ticketId,
        eventType: "internal_note_deleted",
        actor: responsible,
        fromStatus: null,
        toStatus: null,
        data: {
          noteId: normalizedNoteId,
          noteOccurredAt: note.occurred_at,
          description: `Nota interna excluída por ${responsible}.`,
        },
        occurredAt: timestamp,
      });
      this.database
        .prepare("UPDATE tickets SET updated_at = ? WHERE id = ?")
        .run(timestamp, ticketId);
      return this.getTicketDetail(ticketId);
    })();
  }

  upsertTicketProductForwarding(
    ticketId: string,
    input: UpsertTicketProductForwardingInput,
    actor = "Operador local",
  ): TicketDetailDto {
    if (input.kind !== "bug") {
      throw new ValidationError("Tipo de encaminhamento ao Produto inválido", {
        kind: input.kind,
        allowed: ["bug"],
      });
    }
    const title = normalizedBoundedText(
      input.title,
      "Título do bug",
      PRODUCT_FORWARDING_TITLE_MAX_LENGTH,
    );
    const description = normalizedBoundedText(
      input.description,
      "Descrição do bug",
      PRODUCT_FORWARDING_DESCRIPTION_MAX_LENGTH,
    );
    const externalReference =
      input.externalReference === undefined || input.externalReference === null
        ? null
        : normalizedBoundedText(
          input.externalReference,
          "Referência externa",
          PRODUCT_FORWARDING_EXTERNAL_REFERENCE_MAX_LENGTH,
        );
    const responsible = normalizedBoundedText(actor, "Responsável", 200);

    return this.database.transaction(() => {
      const ticket = this.database
        .prepare("SELECT id, status FROM tickets WHERE id = ?")
        .get(ticketId) as TicketStatusRow | undefined;
      if (!ticket) throw new NotFoundError("Ticket", ticketId);
      if (input.resolveTicket === true && ticket.status === "archived") {
        throw new ConflictError(
          "Ticket arquivado não pode ser finalizado pelo encaminhamento ao Produto",
          { ticketId, status: ticket.status },
        );
      }
      const existing = this.getTicketProductForwarding(ticketId);
      const forwardingChanged =
        !existing ||
        existing.kind !== input.kind ||
        existing.title !== title ||
        existing.description !== description ||
        existing.externalReference !== externalReference;
      const shouldResolve =
        input.resolveTicket === true &&
        ticket.status !== "resolved" &&
        ticket.status !== "archived";
      if (!forwardingChanged && !shouldResolve) {
        return this.getTicketDetail(ticketId);
      }

      const timestamp = nowUtc();
      if (forwardingChanged) {
        this.database
          .prepare(
            `INSERT INTO ticket_product_forwardings (
               ticket_id, kind, title, description, external_reference,
               created_by, updated_by, created_at, updated_at
             ) VALUES (?, 'bug', ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(ticket_id) DO UPDATE SET
               kind = excluded.kind,
               title = excluded.title,
               description = excluded.description,
               external_reference = excluded.external_reference,
               updated_by = excluded.updated_by,
               updated_at = excluded.updated_at`,
          )
          .run(
            ticketId,
            title,
            description,
            externalReference,
            responsible,
            responsible,
            timestamp,
            timestamp,
          );
        this.insertTicketEvent({
          ticketId,
          eventType: existing
            ? "ticket_product_forwarding_updated"
            : "ticket_forwarded_to_product",
          actor: responsible,
          fromStatus: null,
          toStatus: null,
          data: {
            action: existing ? "updated" : "created",
            kind: "bug",
            title,
            bugDescription: description,
            externalReference,
            previous: existing
              ? {
                  title: existing.title,
                  description: existing.description,
                  externalReference: existing.externalReference,
                }
              : null,
            description: existing
              ? `Encaminhamento do bug “${title}” atualizado por ${responsible}.`
              : `Ticket encaminhado ao Produto como bug “${title}” por ${responsible}.`,
          },
          occurredAt: timestamp,
        });
      }

      if (shouldResolve) {
        assertStatusTransition(ticket.status, "resolved");
        this.database
          .prepare(
            `UPDATE tickets
             SET status = 'resolved', needs_review = 0,
                 resolved_at = COALESCE(resolved_at, ?),
                 archived_at = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .run(timestamp, timestamp, ticketId);
        this.insertTicketEvent({
          ticketId,
          eventType: "status_changed",
          actor: responsible,
          fromStatus: ticket.status,
          toStatus: "resolved",
          data: {
            reason: "forwarded_to_product_as_bug",
            productForwardingKind: "bug",
            description: `Ticket resolvido após encaminhamento ao Produto como bug por ${responsible}.`,
          },
          occurredAt: timestamp,
        });
      } else if (forwardingChanged) {
        this.database
          .prepare("UPDATE tickets SET updated_at = ? WHERE id = ?")
          .run(timestamp, ticketId);
      }

      return this.getTicketDetail(ticketId);
    })();
  }

  upsertGroup(input: UpsertGroupInput): EntityRecord {
    this.assertEntityExists("Conta WhatsApp", "whatsapp_accounts", input.accountId);
    this.assertEntityExists("Cliente", "clients", input.clientId);
    const id = input.id ?? randomUUID();
    const timestamp = nowUtc();
    const externalJid = normalizedText(input.externalJid, "JID do grupo");
    const subject = normalizeConversationSubject(
      normalizedText(input.subject, "Nome do grupo"),
      externalJid,
    );
    return this.database
      .prepare(
        `INSERT INTO whatsapp_groups
          (id, account_id, client_id, external_jid, subject, monitored,
           history_oldest_at, history_newest_at, history_complete,
           client_link_source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(external_jid) DO UPDATE SET
          account_id = excluded.account_id,
          client_id = whatsapp_groups.client_id,
          subject = excluded.subject,
          monitored = excluded.monitored,
          history_oldest_at = CASE
            WHEN whatsapp_groups.history_oldest_at IS NULL THEN excluded.history_oldest_at
            WHEN excluded.history_oldest_at IS NULL THEN whatsapp_groups.history_oldest_at
            WHEN excluded.history_oldest_at < whatsapp_groups.history_oldest_at
              THEN excluded.history_oldest_at
            ELSE whatsapp_groups.history_oldest_at
          END,
          history_newest_at = CASE
            WHEN whatsapp_groups.history_newest_at IS NULL THEN excluded.history_newest_at
            WHEN excluded.history_newest_at IS NULL THEN whatsapp_groups.history_newest_at
            WHEN excluded.history_newest_at > whatsapp_groups.history_newest_at
              THEN excluded.history_newest_at
            ELSE whatsapp_groups.history_newest_at
          END,
          history_complete = CASE
            WHEN whatsapp_groups.history_complete = 1 OR excluded.history_complete = 1 THEN 1
            ELSE 0
          END,
          updated_at = excluded.updated_at
         RETURNING id`,
      )
      .get(
        id,
        input.accountId,
        input.clientId,
        externalJid,
        subject,
        input.monitored === false ? 0 : 1,
        input.historyOldestAt ?? null,
        input.historyNewestAt ?? null,
        input.historyComplete ? 1 : 0,
        input.clientLinkSource ?? "fallback",
        timestamp,
        timestamp,
      ) as EntityRecord;
  }

  getConversationTriageCursor(groupId: string): ConversationTriageCursor | null {
    this.assertEntityExists("Conversa", "whatsapp_groups", groupId);
    const row = this.database
      .prepare(
        `SELECT triage_enabled_at, triage_watermark_at
         FROM whatsapp_groups WHERE id = ?`,
      )
      .get(groupId) as {
      triage_enabled_at: string | null;
      triage_watermark_at: string | null;
    };
    if (!row.triage_enabled_at) return null;
    return {
      enabledAt: row.triage_enabled_at,
      watermarkAt: row.triage_watermark_at,
    };
  }

  advanceConversationTriageWatermark(
    groupId: string,
    occurredAt: string,
    enabledAt = nowUtc(),
  ): ConversationTriageCursor {
    this.assertEntityExists("Conversa", "whatsapp_groups", groupId);
    const normalizedOccurredAt = normalizedText(occurredAt, "Data da mensagem");
    const normalizedEnabledAt = normalizedText(enabledAt, "Início da triagem");
    this.database
      .prepare(
        `UPDATE whatsapp_groups
         SET triage_enabled_at = COALESCE(triage_enabled_at, ?),
             triage_watermark_at = CASE
               WHEN triage_watermark_at IS NULL OR triage_watermark_at < ? THEN ?
               ELSE triage_watermark_at
             END,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        normalizedEnabledAt,
        normalizedOccurredAt,
        normalizedOccurredAt,
        nowUtc(),
        groupId,
      );
    return this.getConversationTriageCursor(groupId) as ConversationTriageCursor;
  }

  setConversationSuggestionsMuted(
    groupId: string,
    input: ConversationSuggestionSettingsInput,
  ): ConversationSuggestionSettingsResponse {
    return this.database.transaction(() => {
      this.assertEntityExists("Conversa", "whatsapp_groups", groupId);
      const actor = normalizedNullableText(input.actor) ?? "Operador local";
      const timestamp = nowUtc();
      let contextualizedMessageCount = 0;
      let resolvedBlockCount = 0;

      if (input.muted) {
        this.database
          .prepare(
            `UPDATE whatsapp_groups
             SET suggestions_muted_at = COALESCE(suggestions_muted_at, ?),
                 suggestions_muted_by = ?,
                 updated_at = ?
             WHERE id = ?`,
          )
          .run(timestamp, actor, timestamp, groupId);
        const pendingBlocks = this.database
          .prepare(
            `SELECT id FROM triage_blocks
             WHERE group_id = ? AND state = 'pending'
             ORDER BY first_message_at, id`,
          )
          .all(groupId) as EntityRecord[];
        const blockMessageIds = this.database.prepare(
          `SELECT message_id
           FROM triage_block_messages
           WHERE block_id = ? AND active = 1
           ORDER BY added_at, message_id`,
        );
        const pendingBlockMessages = new Map(
          pendingBlocks.map((block) => [
            block.id,
            (
              blockMessageIds.all(block.id) as Array<{ message_id: string }>
            ).map((row) => row.message_id),
          ]),
        );

        const messageUpdate = this.database
          .prepare(
            `UPDATE messages
             SET triage_kind = 'context', triage_state = 'context', updated_at = ?
             WHERE group_id = ?
               AND triage_state = 'unreviewed'
               AND NOT EXISTS (
                 SELECT 1 FROM ticket_messages
                 WHERE ticket_messages.message_id = messages.id
               )`,
          )
          .run(timestamp, groupId);
        contextualizedMessageCount = messageUpdate.changes;

        if (pendingBlocks.length) {
          this.database
            .prepare(
              `UPDATE triage_block_messages
               SET active = 0, updated_at = ?
               WHERE active = 1
                 AND block_id IN (
                   SELECT id FROM triage_blocks
                   WHERE group_id = ? AND state = 'pending'
                 )`,
            )
            .run(timestamp, groupId);
          resolvedBlockCount = this.database
            .prepare(
              `UPDATE triage_blocks
               SET state = 'context', resolved_at = ?, updated_at = ?
               WHERE group_id = ? AND state = 'pending'`,
            )
            .run(timestamp, timestamp, groupId).changes;
          for (const block of pendingBlocks) {
            this.insertTriageBlockEvent({
              blockId: block.id,
              eventType: "conversation_suggestions_muted",
              actor,
              messageIds: pendingBlockMessages.get(block.id) ?? [],
              data: { conversationId: groupId },
              occurredAt: timestamp,
            });
          }
        }
      } else {
        this.database
          .prepare(
            `UPDATE whatsapp_groups
             SET suggestions_muted_at = NULL,
                 suggestions_muted_by = NULL,
                 triage_enabled_at = ?,
                 triage_watermark_at = COALESCE(
                   (SELECT MAX(message.occurred_at)
                    FROM messages message
                    WHERE message.group_id = whatsapp_groups.id),
                   ?
                 ),
                 updated_at = ?
             WHERE id = ?`,
          )
          .run(timestamp, timestamp, timestamp, groupId);
      }

      return {
        conversation: this.getConversationSummary(groupId),
        contextualizedMessageCount,
        resolvedBlockCount,
      };
    }).immediate();
  }

  contextualizePendingMessages(
    input: { actor?: string; conversationId?: string } = {},
  ): ConversationClearPendingResponse {
    return this.database.transaction(() => {
      const actor = normalizedNullableText(input.actor) ?? "Operador local";
      const conversationId = normalizedNullableText(input.conversationId);
      if (conversationId) this.getConversationSummary(conversationId);
      const timestamp = nowUtc();
      const messages = this.database
        .prepare(
          `SELECT message.id, message.group_id, message.sender_id,
                  message.occurred_at, message.text, message.message_type,
                  message.triage_kind, message.triage_state,
                  CASE WHEN staff.participant_id IS NULL THEN 0 ELSE 1 END AS is_staff
           FROM messages message
           JOIN whatsapp_groups conversation ON conversation.id = message.group_id
           JOIN clients client ON client.id = conversation.client_id
           LEFT JOIN staff_members staff
             ON staff.participant_id = message.sender_id AND staff.active = 1
           WHERE client.ignored_at IS NULL
             AND message.triage_state = 'unreviewed'
             AND message.message_type NOT IN ('reactionMessage', 'protocolMessage')
             AND (
               trim(COALESCE(message.text, '')) <> ''
               OR message.message_type <> 'system'
               OR EXISTS (
                 SELECT 1 FROM attachments pending_attachment
                 WHERE pending_attachment.message_id = message.id
               )
             )
             AND NOT EXISTS (
               SELECT 1 FROM ticket_messages ticket_message
               WHERE ticket_message.message_id = message.id
             )
             ${conversationId ? "AND message.group_id = ?" : ""}
           ORDER BY message.group_id, message.occurred_at, message.id`,
        )
        .all(...(conversationId ? [conversationId] : [])) as ConversationActionMessageRow[];
      if (!messages.length) {
        return {
          contextualizedMessageCount: 0,
          conversationCount: 0,
          resolvedBlockCount: 0,
        };
      }

      const pendingBlocksBefore = (
        this.database
          .prepare("SELECT COUNT(*) AS count FROM triage_blocks WHERE state = 'pending'")
          .get() as { count: number }
      ).count;
      const grouped = new Map<string, ConversationActionMessageRow[]>();
      for (const message of messages) {
        const current = grouped.get(message.group_id) ?? [];
        current.push(message);
        grouped.set(message.group_id, current);
      }
      const updateMessage = this.database.prepare(
        `UPDATE messages
         SET triage_kind = 'context', triage_state = 'context', updated_at = ?
         WHERE id = ? AND triage_state = 'unreviewed'`,
      );

      for (const [groupId, groupMessages] of grouped) {
        for (let offset = 0; offset < groupMessages.length; offset += 500) {
          const batch = groupMessages.slice(offset, offset + 500);
          for (const message of batch) updateMessage.run(timestamp, message.id);
          this.createConversationActionBlock({
            groupId,
            messages: batch,
            state: "context",
            action: "context",
            requestKey: null,
            actor,
            reason: conversationId
              ? "Pendências da conversa mantidas como contexto"
              : "Pendências globais mantidas como contexto",
            title: "Pendências mantidas como contexto",
            summary: `${batch.length} ${batch.length === 1 ? "mensagem pendente mantida" : "mensagens pendentes mantidas"} como contexto pelo operador.`,
          });
        }

        if (this.hasTriageAiJobSchema()) {
          this.database
            .prepare(
              `UPDATE triage_ai_jobs
               SET state = 'failed',
                   error = 'Pendências mantidas como contexto pelo operador',
                   finished_at = ?, claimed_at = NULL, lease_expires_at = NULL,
                   updated_at = ?
               WHERE group_id = ? AND state IN ('queued', 'running')`,
            )
            .run(timestamp, timestamp, groupId);
          this.database
            .prepare(
              `UPDATE triage_ai_job_messages
               SET active = 0, updated_at = ?
               WHERE active = 1
                 AND job_id IN (
                   SELECT id FROM triage_ai_jobs WHERE group_id = ?
                 )`,
            )
            .run(timestamp, groupId);
        }
      }

      const pendingBlocksAfter = (
        this.database
          .prepare("SELECT COUNT(*) AS count FROM triage_blocks WHERE state = 'pending'")
          .get() as { count: number }
      ).count;
      return {
        contextualizedMessageCount: messages.length,
        conversationCount: grouped.size,
        resolvedBlockCount: Math.max(0, pendingBlocksBefore - pendingBlocksAfter),
      };
    }).immediate();
  }

  listConversations(
    filters: ConversationListFilters = {},
  ): ConversationListResponse {
    const requestedLimit = filters.limit ?? 50;
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
      throw new ValidationError("Limite de conversas inválido");
    }
    const limit = Math.min(requestedLimit, 200);
    const attention = filters.attention ?? "all";
    const scope = filters.scope ?? null;
    const query = normalizedNullableText(filters.query)?.toLocaleLowerCase("pt-BR") ?? null;
    const filterKey = JSON.stringify({ attention, scope, query });
    const cursor = decodePageCursor(filters.cursor, "Cursor de conversas");
    if (cursor && cursor.filterKey !== filterKey) {
      throw new ValidationError(
        "O cursor de conversas não pertence aos filtros informados",
      );
    }
    const clauses = [
      "client.ignored_at IS NULL",
      `( NOT (
          conversation.external_jid LIKE '%@s.whatsapp.net'
          OR conversation.external_jid LIKE '%@lid'
        )
        OR EXISTS (
          SELECT 1
          FROM messages visible_message
          WHERE visible_message.group_id = conversation.id
            AND (
              trim(COALESCE(visible_message.text, '')) <> ''
              OR visible_message.message_type NOT IN (
                'system', 'protocolMessage', 'reactionMessage'
              )
              OR EXISTS (
                SELECT 1
                FROM attachments visible_attachment
                WHERE visible_attachment.message_id = visible_message.id
              )
            )
        )
      )`,
    ];
    const parameters: Array<string | number> = [];
    if (attention === "pending") {
      clauses.push(
        `EXISTS (
          SELECT 1 FROM messages pending_message
          WHERE pending_message.group_id = conversation.id
            AND pending_message.triage_state = 'unreviewed'
            AND (
              trim(COALESCE(pending_message.text, '')) <> ''
              OR pending_message.message_type NOT IN (
                'system', 'protocolMessage', 'reactionMessage'
              )
              OR EXISTS (
                SELECT 1 FROM attachments pending_attachment
                WHERE pending_attachment.message_id = pending_message.id
              )
            )
        )`,
      );
    }
    if (scope === "group") {
      clauses.push("conversation.external_jid LIKE '%@g.us'");
    } else if (scope === "direct") {
      clauses.push(
        `(conversation.external_jid LIKE '%@s.whatsapp.net'
          OR conversation.external_jid LIKE '%@lid')`,
      );
    }
    if (query) {
      const pattern = `%${query}%`;
      clauses.push(
        `(lower(conversation.subject) LIKE ?
          OR lower(client.name) LIKE ?
          OR EXISTS (
            SELECT 1 FROM messages searched_message
            WHERE searched_message.group_id = conversation.id
              AND lower(COALESCE(searched_message.text, '')) LIKE ?
          )
          OR EXISTS (
            SELECT 1
            FROM group_participants searched_membership
            JOIN participants searched_participant
              ON searched_participant.id = searched_membership.participant_id
            WHERE searched_membership.group_id = conversation.id
              AND (
                lower(searched_participant.display_name) LIKE ?
                OR lower(COALESCE(searched_participant.phone_e164, '')) LIKE ?
              )
          ))`,
      );
      parameters.push(pattern, pattern, pattern, pattern, pattern);
    }
    const rankedSql = `
      SELECT conversation.id,
             COALESCE(MAX(message.occurred_at), conversation.created_at) AS sort_at
      FROM whatsapp_groups conversation
      JOIN clients client ON client.id = conversation.client_id
      LEFT JOIN messages message
        ON message.group_id = conversation.id
       AND message.message_type NOT IN ('reactionMessage', 'protocolMessage')
       AND (
         trim(COALESCE(message.text, '')) <> ''
         OR message.message_type <> 'system'
         OR EXISTS (
           SELECT 1 FROM attachments ranked_attachment
           WHERE ranked_attachment.message_id = message.id
         )
       )
      WHERE ${clauses.join(" AND ")}
      GROUP BY conversation.id
    `;
    const rows = this.database
      .prepare(
        `SELECT ranked.id, ranked.sort_at
         FROM (${rankedSql}) ranked
         WHERE (? IS NULL OR ranked.sort_at < ? OR (ranked.sort_at = ? AND ranked.id < ?))
         ORDER BY ranked.sort_at DESC, ranked.id DESC
         LIMIT ?`,
      )
      .all(
        ...parameters,
        cursor?.occurredAt ?? null,
        cursor?.occurredAt ?? null,
        cursor?.occurredAt ?? null,
        cursor?.id ?? null,
        limit + 1,
      ) as Array<{ id: string; sort_at: string }>;
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const last = selected.at(-1);
    const total = (
      this.database
        .prepare(`SELECT COUNT(*) AS count FROM (${rankedSql}) ranked`)
        .get(...parameters) as { count: number }
    ).count;
    const pendingTotal = (
      this.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM messages message
           JOIN whatsapp_groups conversation ON conversation.id = message.group_id
           JOIN clients client ON client.id = conversation.client_id
           WHERE client.ignored_at IS NULL
             AND message.triage_state = 'unreviewed'
             AND message.message_type NOT IN ('reactionMessage', 'protocolMessage')
             AND (
               trim(COALESCE(message.text, '')) <> ''
               OR message.message_type <> 'system'
               OR EXISTS (
                 SELECT 1 FROM attachments pending_attachment
                 WHERE pending_attachment.message_id = message.id
               )
             )`,
        )
        .get() as { count: number }
    ).count;
    return {
      items: selected.map((row) => this.getConversationSummary(row.id)),
      total,
      pendingTotal,
      nextCursor:
        hasMore && last
          ? encodePageCursor(last.sort_at, last.id, filterKey)
          : null,
      hasMore,
    };
  }

  getConversationMessages(
    groupId: string,
    filters: ConversationMessageFilters = {},
  ): ConversationMessagesResponse {
    const conversation = this.getConversationSummary(groupId);
    const requestedLimit = filters.limit ?? 50;
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
      throw new ValidationError("Limite de mensagens inválido");
    }
    const limit = Math.min(requestedLimit, 200);
    const cursor = decodePageCursor(filters.before, "Cursor de mensagens");
    const rows = this.database
      .prepare(
        `SELECT
           message.id, message.external_id, message.provider_message_id,
           message.quoted_external_id, message.occurred_at,
           message.ingestion_source, message.text, message.message_type,
           message.raw_json,
           message.triage_kind, message.triage_state,
           participant.id AS sender_id, participant.display_name,
           participant.phone_e164,
           CASE WHEN staff.participant_id IS NULL THEN 0 ELSE 1 END AS is_staff,
           block.id AS suggestion_group_id,
           block.confidence AS suggestion_confidence,
           block.reason AS suggestion_reason,
           block.suggested_action,
           block.suggested_ticket_id
         FROM messages message
         JOIN participants participant ON participant.id = message.sender_id
         LEFT JOIN staff_members staff
           ON staff.participant_id = participant.id AND staff.active = 1
         LEFT JOIN triage_block_messages block_message
           ON block_message.message_id = message.id AND block_message.active = 1
         LEFT JOIN triage_blocks block
           ON block.id = block_message.block_id AND block.state = 'pending'
         WHERE message.group_id = ?
           AND message.message_type NOT IN ('reactionMessage', 'protocolMessage')
           AND (
             trim(COALESCE(message.text, '')) <> ''
             OR message.message_type <> 'system'
             OR EXISTS (
               SELECT 1 FROM attachments visible_attachment
               WHERE visible_attachment.message_id = message.id
             )
           )
           AND (? IS NULL OR message.occurred_at < ?
             OR (message.occurred_at = ? AND message.id < ?))
         ORDER BY message.occurred_at DESC, message.id DESC
         LIMIT ?`,
      )
      .all(
        groupId,
        cursor?.occurredAt ?? null,
        cursor?.occurredAt ?? null,
        cursor?.occurredAt ?? null,
        cursor?.id ?? null,
        limit + 1,
      ) as Array<{
      id: string;
      external_id: string;
      provider_message_id: string | null;
      quoted_external_id: string | null;
      occurred_at: string;
      ingestion_source: ConversationMessageDto["source"];
      text: string | null;
      message_type: string;
      raw_json: string | null;
      triage_kind: TriageKind;
      triage_state: TriageState;
      sender_id: string;
      display_name: string;
      phone_e164: string | null;
      is_staff: number;
      suggestion_group_id: string | null;
      suggestion_confidence: number | null;
      suggestion_reason: string | null;
      suggested_action: TriageSuggestedAction | null;
      suggested_ticket_id: string | null;
    }>;
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const oldest = selected.at(-1);
    const hasAudioTranscriptions = databaseHasTable(
      this.database,
      "audio_transcriptions",
    );
    const attachments = this.database.prepare(
      `SELECT attachment.id, attachment.kind, attachment.mime_type,
              attachment.file_name, attachment.size_bytes, attachment.sha256,
              attachment.extracted_text, attachment.available,
              ${hasAudioTranscriptions
                ? `transcription.status AS transcription_status,
                   transcription.text AS transcription_text,
                   transcription.language AS transcription_language,
                   transcription.confidence AS transcription_confidence,
                   transcription.model_id AS transcription_model_id,
                   transcription.error AS transcription_error,
                   transcription.updated_at AS transcription_updated_at`
                : `NULL AS transcription_status,
                   NULL AS transcription_text,
                   NULL AS transcription_language,
                   NULL AS transcription_confidence,
                   NULL AS transcription_model_id,
                   NULL AS transcription_error,
                   NULL AS transcription_updated_at`}
       FROM attachments attachment
       ${hasAudioTranscriptions
         ? `LEFT JOIN audio_transcriptions transcription
              ON transcription.attachment_id = attachment.id`
         : ""}
       WHERE attachment.message_id = ?
       ORDER BY attachment.created_at, attachment.id`,
    );
    const ticketReferences = this.database.prepare(
      `SELECT ticket.id, ticket.number, ticket.title, ticket.status
       FROM ticket_messages ticket_message
       JOIN tickets ticket ON ticket.id = ticket_message.ticket_id
       WHERE ticket_message.message_id = ?
       ORDER BY ticket.number`,
    );
    const quotedMessage = this.database.prepare(
      `SELECT
         quoted.id, quoted.occurred_at, quoted.text, quoted.message_type,
         sender.id AS sender_id, sender.display_name,
         CASE WHEN staff.participant_id IS NULL THEN 0 ELSE 1 END AS is_staff
       FROM messages quoted
       JOIN participants sender ON sender.id = quoted.sender_id
       LEFT JOIN staff_members staff
         ON staff.participant_id = sender.id AND staff.active = 1
       WHERE quoted.group_id = ? AND quoted.provider_message_id = ?
       ORDER BY quoted.occurred_at DESC, quoted.id DESC
       LIMIT 1`,
    );
    const reactionRows = this.database
      .prepare(
        `WITH ranked_reactions AS (
           SELECT
             reaction.group_id,
             reaction.target_provider_message_id,
             reaction.emoji,
             reaction.occurred_at,
             reaction.rowid AS event_rowid,
             reactor.id AS reactor_id,
             reactor.display_name,
             CASE WHEN staff.participant_id IS NULL THEN 0 ELSE 1 END AS is_staff,
             ROW_NUMBER() OVER (
               PARTITION BY
                 reaction.group_id,
                 reaction.target_provider_message_id,
                 COALESCE(identity_link.phone_jid, reactor.external_jid)
               ORDER BY
                 reaction.occurred_at DESC,
                 reaction.observed_at DESC,
                 reaction.rowid DESC
             ) AS state_rank
           FROM message_reaction_events reaction
           JOIN participants reactor ON reactor.id = reaction.reactor_id
           LEFT JOIN whatsapp_identity_links identity_link
             ON identity_link.phone_jid = reactor.external_jid
             OR identity_link.lid_jid = reactor.external_jid
           LEFT JOIN staff_members staff
             ON staff.participant_id = reactor.id AND staff.active = 1
           WHERE reaction.group_id = ?
         )
         SELECT
           reaction.target_provider_message_id,
           (
             SELECT target.id
             FROM messages target
             WHERE target.group_id = reaction.group_id
               AND target.provider_message_id = reaction.target_provider_message_id
             ORDER BY target.occurred_at DESC, target.id DESC
             LIMIT 1
           ) AS target_message_id,
           reaction.emoji,
           reaction.occurred_at,
           reaction.event_rowid,
           reaction.reactor_id,
           reaction.display_name,
           reaction.is_staff
         FROM ranked_reactions reaction
         WHERE reaction.state_rank = 1
         ORDER BY reaction.target_provider_message_id,
                  reaction.occurred_at,
                  reaction.event_rowid`,
      )
      .all(groupId) as ConversationReactionRow[];
    const reactionsByProviderMessageId = new Map<
      string,
      ConversationReactionRow[]
    >();
    for (const reaction of reactionRows) {
      const current =
        reactionsByProviderMessageId.get(reaction.target_provider_message_id) ?? [];
      current.push(reaction);
      reactionsByProviderMessageId.set(reaction.target_provider_message_id, current);
    }
    const mentionNames = this.resolveMentionDisplayNames(
      groupId,
      selected.map((row) => row.raw_json),
    );
    const items = selected.toReversed().map<ConversationMessageDto>((row) => ({
      id: row.id,
      externalId: row.external_id,
      occurredAt: row.occurred_at,
      source: row.ingestion_source,
      sender: {
        id: row.sender_id,
        displayName: row.display_name,
        phoneE164: row.phone_e164,
        isStaff: Boolean(row.is_staff),
      },
      text: presentMessageText(row.text, row.raw_json, mentionNames),
      messageType: row.message_type,
      replyTo: mapConversationReply(
        row.quoted_external_id,
        row.quoted_external_id
          ? quotedMessage.get(groupId, row.quoted_external_id)
          : undefined,
      ),
      reactions: row.provider_message_id
        ? mapConversationReactions(
            reactionsByProviderMessageId.get(row.provider_message_id) ?? [],
          )
        : [],
      attachments: (attachments.all(row.id) as Array<{
        id: string;
        kind: AttachmentDto["kind"];
        mime_type: string;
        file_name: string | null;
        size_bytes: number | null;
        sha256: string;
        extracted_text: string | null;
        available: number;
        transcription_status: NonNullable<AttachmentDto["transcription"]>["status"] | null;
        transcription_text: string | null;
        transcription_language: string | null;
        transcription_confidence: number | null;
        transcription_model_id: string | null;
        transcription_error: string | null;
        transcription_updated_at: string | null;
      }>).map((attachment) => ({
        id: attachment.id,
        kind: attachment.kind,
        mimeType: attachment.mime_type,
        fileName: attachment.file_name,
        url: attachment.available ? `/api/attachments/${attachment.id}` : null,
        sizeBytes: attachment.size_bytes,
        sha256: attachment.sha256,
        extractedText: attachment.extracted_text,
        available: Boolean(attachment.available),
        transcription:
          attachment.transcription_status &&
          attachment.transcription_language &&
          attachment.transcription_model_id &&
          attachment.transcription_updated_at
            ? {
                status: attachment.transcription_status,
                text: attachment.transcription_text,
                language: attachment.transcription_language,
                confidence: attachment.transcription_confidence,
                modelId: attachment.transcription_model_id,
                error: attachment.transcription_error,
                updatedAt: attachment.transcription_updated_at,
              }
            : null,
      })),
      triage: {
        kind: row.triage_kind,
        state: row.triage_state,
        confidence: row.suggestion_confidence,
        reason: row.suggestion_reason,
        suggestedAction: row.suggested_action,
        suggestedTicketId: row.suggested_ticket_id,
        suggestionGroupId: row.suggestion_group_id,
      },
      tickets: ticketReferences.all(row.id) as ConversationMessageDto["tickets"],
    }));
    return {
      conversation,
      items,
      reactionUpdates: [...reactionsByProviderMessageId.values()]
        .map((reactions) => ({
          messageId: reactions[0]?.target_message_id ?? "",
          reactions: mapConversationReactions(reactions),
        }))
        .filter((update) => update.messageId),
      suggestedBlocks: this.listConversationTriageBlocks(groupId).items,
      suggestionAnalysis: this.getConversationSuggestionAnalysis(groupId),
      nextCursor:
        hasMore && oldest
          ? encodePageCursor(oldest.occurred_at, oldest.id)
          : null,
      hasMore,
    };
  }

  listConversationTriageBlocks(
    groupId: string,
    includeResolved = false,
  ): ConversationTriageBlocksResponse {
    this.assertEntityExists("Conversa", "whatsapp_groups", groupId);
    const rows = this.database
      .prepare(
        `SELECT id FROM triage_blocks
         WHERE group_id = ? AND (? = 1 OR state = 'pending')
           AND (
             state != 'pending'
             OR confidence >= ?
           )
         ORDER BY first_message_at, id`,
      )
      .all(
        groupId,
        includeResolved ? 1 : 0,
        MIN_VISIBLE_TICKET_SUGGESTION_CONFIDENCE,
      ) as EntityRecord[];
    return { items: rows.map((row) => this.getTriageBlock(row.id)) };
  }

  createTicketFromConversation(
    groupId: string,
    input: CreateConversationTicketInput,
  ): ConversationTriageActionResponse {
    return this.database.transaction((): ConversationTriageActionResponse => {
      const requestKey = this.conversationRequestKey(
        groupId,
        "create",
        input.clientRequestId,
      );
      const repeated = this.getConversationActionByRequestKey(requestKey);
      if (repeated) return repeated;

      if (input.clientId) {
        this.assertEntityExists("Cliente", "clients", input.clientId);
        this.reassignGroupClient(groupId, input.clientId, "manual");
      }
      const messages = this.loadConversationActionMessages(groupId, input.messageIds);
      const externalMessages = messages.filter((message) => !message.is_staff);
      if (!externalMessages.length) {
        throw new ValidationError(
          "Selecione ao menos uma mensagem externa para criar o ticket",
        );
      }
      this.assertMessagesHaveNoTicket(messages.map((message) => message.id));
      const proposedCategories = this.proposedCategoriesForExactSelection(
        groupId,
        messages.map((message) => message.id),
      );

      const title =
        normalizedNullableText(input.title) ??
        this.deriveConversationActionTitle(externalMessages);
      const summary =
        normalizedNullableText(input.summary) ??
        this.deriveConversationActionSummary(messages);
      const actor = normalizedNullableText(input.actor) ?? "Operador local";
      const ticket = this.createTicket({
        groupId,
        sourceMessageId: externalMessages[0]!.id,
        messageIds: messages.map((message) => message.id),
        affectedStoreId: input.affectedStoreId ?? null,
        title,
        summary,
        status: "triage",
        priority: input.priority ?? "normal",
        confidence: null,
        needsReview: false,
        actor,
        createdAt: externalMessages[0]!.occurred_at,
      });
      if (proposedCategories) {
        this.promoteTriageCategories(
          ticket.id,
          proposedCategories.categories,
          proposedCategories.confidence,
        );
      }
      const block = this.createConversationActionBlock({
        groupId,
        messages,
        state: "ticketed",
        action: "create" as const,
        requestKey,
        actor,
        reason: normalizedNullableText(input.reason),
        ticketId: ticket.id,
        affectedStoreId: input.affectedStoreId ?? null,
        title,
        summary,
      });
      return {
        blockId: block.id,
        conversationId: groupId,
        action: "create",
        messageIds: messages.map((message) => message.id),
        ticket: this.getTicketDetail(ticket.id),
        investigationJobId: null,
      };
    })();
  }

  attachConversationMessages(
    groupId: string,
    input: AttachConversationMessagesInput,
  ): ConversationTriageActionResponse {
    return this.database.transaction((): ConversationTriageActionResponse => {
      const requestKey = this.conversationRequestKey(
        groupId,
        "attach",
        input.clientRequestId,
      );
      const repeated = this.getConversationActionByRequestKey(requestKey);
      if (repeated) return repeated;
      const ticket = this.database
        .prepare("SELECT id, group_id, status FROM tickets WHERE id = ?")
        .get(input.ticketId) as
        | { id: string; group_id: string; status: TicketStatus }
        | undefined;
      if (!ticket) throw new NotFoundError("Ticket", input.ticketId);
      if (ticket.group_id !== groupId) {
        throw new ValidationError("O ticket pertence a outra conversa");
      }
      if (ticket.status === "resolved" || ticket.status === "archived") {
        throw new ConflictError("Não é possível anexar mensagens a um ticket encerrado");
      }
      const messages = this.loadConversationActionMessages(groupId, input.messageIds);
      this.assertMessagesBelongOnlyToTicket(
        messages.map((message) => message.id),
        ticket.id,
      );
      const actor = normalizedNullableText(input.actor) ?? "Operador local";
      let attached = 0;
      for (const message of messages) {
        const attachedAt = nowUtc();
        if (this.attachMessageToTicketInternal(ticket.id, message.id, attachedAt)) {
          attached += 1;
          this.captureAttachedStaffMessage(
            ticket.id,
            message.id,
            attachedAt,
          );
        }
      }
      if (attached > 0) {
        this.insertTicketEvent({
          ticketId: ticket.id,
          eventType: "messages_attached_batch",
          actor,
          fromStatus: null,
          toStatus: null,
          data: { messageIds: messages.map((message) => message.id) },
          occurredAt: nowUtc(),
        });
      }
      const block = this.createConversationActionBlock({
        groupId,
        messages,
        state: "attached",
        action: "attach" as const,
        requestKey,
        actor,
        reason: normalizedNullableText(input.reason),
        ticketId: ticket.id,
        title: `Mensagens anexadas ao ticket #${this.getTicketDetail(ticket.id).number}`,
        summary: this.deriveConversationActionSummary(messages),
      });
      return {
        blockId: block.id,
        conversationId: groupId,
        action: "attach",
        messageIds: messages.map((message) => message.id),
        ticket: this.getTicketDetail(ticket.id),
        investigationJobId: null,
      };
    })();
  }

  ignoreConversationMessages(
    groupId: string,
    input: ConversationBatchActionInput,
  ): ConversationTriageActionResponse {
    return this.applyConversationMessageState(groupId, "ignore", input);
  }

  contextualizeConversationMessages(
    groupId: string,
    input: ConversationBatchActionInput,
  ): ConversationTriageActionResponse {
    return this.applyConversationMessageState(groupId, "context", input);
  }

  restoreConversationMessages(
    groupId: string,
    input: ConversationBatchActionInput,
  ): ConversationTriageActionResponse {
    return this.applyConversationMessageState(groupId, "restore", input);
  }

  upsertParticipant(input: UpsertParticipantInput): EntityRecord {
    const id = input.id ?? randomUUID();
    const timestamp = nowUtc();
    const externalJid = normalizedText(
      input.externalJid,
      "JID do participante",
    );
    const incomingDisplayName = normalizedText(
      input.displayName,
      "Nome do participante",
    );
    const existing = this.database
      .prepare(
        `SELECT display_name
         FROM participants
         WHERE external_jid = ?`,
      )
      .get(externalJid) as { display_name: string } | undefined;
    const displayName = preferredParticipantDisplayName({
      externalJid,
      phoneE164: input.phoneE164,
      incoming: incomingDisplayName,
      existing: existing?.display_name,
    });
    return this.database
      .prepare(
        `INSERT INTO participants
          (id, external_jid, phone_e164, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(external_jid) DO UPDATE SET
          phone_e164 = COALESCE(excluded.phone_e164, participants.phone_e164),
          display_name = excluded.display_name,
          updated_at = excluded.updated_at
         RETURNING id`,
      )
      .get(
        id,
        externalJid,
        input.phoneE164 ?? null,
        displayName,
        timestamp,
        timestamp,
      ) as EntityRecord;
  }

  addGroupParticipant(
    groupId: string,
    participantId: string,
    role: "member" | "admin" | "owner" = "member",
    source: "message" | "group_roster" | "group_participant_update" = "message",
    confirmedAt = nowUtc(),
  ): void {
    this.assertEntityExists("Grupo", "whatsapp_groups", groupId);
    this.assertEntityExists("Participante", "participants", participantId);
    const timestamp = nowUtc();
    this.database
      .prepare(
        `INSERT INTO group_participants
          (group_id, participant_id, role, first_seen_at, last_seen_at,
           active, source, last_confirmed_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(group_id, participant_id) DO UPDATE SET
          role = excluded.role,
          last_seen_at = CASE
            WHEN excluded.last_seen_at > group_participants.last_seen_at
              THEN excluded.last_seen_at
            ELSE group_participants.last_seen_at
          END,
          active = 1,
          source = excluded.source,
          last_confirmed_at = excluded.last_confirmed_at`,
      )
      .run(groupId, participantId, role, timestamp, timestamp, source, confirmedAt);
  }

  upsertIdentityLink(input: UpsertIdentityLinkInput): void {
    const phoneJid = normalizedText(input.phoneJid, "JID telefônico");
    const lidJid = normalizedText(input.lidJid, "LID do WhatsApp");
    if (!phoneJid.endsWith("@s.whatsapp.net") || !lidJid.endsWith("@lid")) {
      throw new ValidationError("Mapeamento de identidade WhatsApp inválido", {
        phoneJid,
        lidJid,
      });
    }
    const observedAt = normalizedText(input.observedAt, "Data do mapeamento");
    const existing = this.database
      .prepare(
        `SELECT MIN(first_seen_at) AS first_seen_at
         FROM whatsapp_identity_links
         WHERE phone_jid = ? OR lid_jid = ?`,
      )
      .get(phoneJid, lidJid) as { first_seen_at: string | null };
    const firstSeenAt = existing.first_seen_at && existing.first_seen_at < observedAt
      ? existing.first_seen_at
      : observedAt;

    this.database
      .prepare(
        `DELETE FROM whatsapp_identity_links
         WHERE (phone_jid = ? OR lid_jid = ?)
           AND NOT (phone_jid = ? AND lid_jid = ?)`,
      )
      .run(phoneJid, lidJid, phoneJid, lidJid);
    this.database
      .prepare(
        `INSERT INTO whatsapp_identity_links
          (phone_jid, lid_jid, source, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(phone_jid, lid_jid) DO UPDATE SET
          source = excluded.source,
          first_seen_at = CASE
            WHEN whatsapp_identity_links.first_seen_at < excluded.first_seen_at
              THEN whatsapp_identity_links.first_seen_at
            ELSE excluded.first_seen_at
          END,
          last_seen_at = CASE
            WHEN whatsapp_identity_links.last_seen_at > excluded.last_seen_at
              THEN whatsapp_identity_links.last_seen_at
            ELSE excluded.last_seen_at
          END`,
      )
      .run(phoneJid, lidJid, normalizedText(input.source, "Origem do mapeamento"), firstSeenAt, observedAt);
  }

  findParticipantIds(input: {
    externalJids: readonly string[];
    phoneE164s?: readonly string[];
  }): string[] {
    const externalJids = this.expandIdentityJids(input.externalJids);
    const phoneE164s = [...new Set((input.phoneE164s ?? []).map((value) => value.trim()).filter(Boolean))];
    const clauses: string[] = [];
    const parameters: string[] = [];
    if (externalJids.length) {
      clauses.push(`external_jid IN (${externalJids.map(() => "?").join(", ")})`);
      parameters.push(...externalJids);
    }
    if (phoneE164s.length) {
      clauses.push(`phone_e164 IN (${phoneE164s.map(() => "?").join(", ")})`);
      parameters.push(...phoneE164s);
    }
    if (!clauses.length) return [];
    return (
      this.database
        .prepare(`SELECT id FROM participants WHERE ${clauses.join(" OR ")}`)
        .all(...parameters) as EntityRecord[]
    ).map((row) => row.id);
  }

  replaceActiveGroupRoster(
    groupId: string,
    activeParticipantIds: readonly string[],
    confirmedAt: string,
  ): void {
    this.assertEntityExists("Grupo", "whatsapp_groups", groupId);
    const active = [...new Set(activeParticipantIds)];
    const clause = active.length
      ? `AND participant_id NOT IN (${active.map(() => "?").join(", ")})`
      : "";
    this.database
      .prepare(
        `UPDATE group_participants
         SET active = 0, last_confirmed_at = ?
         WHERE group_id = ? AND active = 1 ${clause}`,
      )
      .run(confirmedAt, groupId, ...active);
  }

  deactivateGroupParticipants(
    groupId: string,
    participantIds: readonly string[],
    confirmedAt: string,
  ): void {
    const ids = [...new Set(participantIds)];
    if (!ids.length) return;
    this.database
      .prepare(
        `UPDATE group_participants
         SET active = 0, source = 'group_participant_update', last_confirmed_at = ?
         WHERE group_id = ?
           AND participant_id IN (${ids.map(() => "?").join(", ")})`,
      )
      .run(confirmedAt, groupId, ...ids);
  }

  findParticipantClientMatches(input: {
    externalJids: readonly string[];
    phoneE164s?: readonly string[];
  }): ParticipantClientMatch[] {
    const externalJids = this.expandIdentityJids(input.externalJids);
    const phoneE164s = [...new Set((input.phoneE164s ?? []).map((value) => value.trim()).filter(Boolean))];
    const identityClauses: string[] = [];
    const parameters: string[] = [];

    if (externalJids.length) {
      identityClauses.push(`p.external_jid IN (${externalJids.map(() => "?").join(", ")})`);
      parameters.push(...externalJids);
    }
    if (phoneE164s.length) {
      identityClauses.push(`p.phone_e164 IN (${phoneE164s.map(() => "?").join(", ")})`);
      parameters.push(...phoneE164s);
    }
    if (!identityClauses.length) return [];

    const rows = this.database
      .prepare(
        `SELECT c.id, c.name, c.kind, MAX(gp.last_seen_at) AS last_seen_at
         FROM participants p
         JOIN group_participants gp ON gp.participant_id = p.id
         JOIN whatsapp_groups g ON g.id = gp.group_id
         JOIN clients c ON c.id = g.client_id
         WHERE g.external_jid LIKE '%@g.us'
           AND gp.active = 1
           AND c.ignored_at IS NULL
           AND (${identityClauses.join(" OR ")})
         GROUP BY c.id, c.name, c.kind
         ORDER BY last_seen_at DESC, c.name`,
      )
      .all(...parameters) as Array<{
      id: string;
      name: string;
      kind: ClientKind;
      last_seen_at: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      lastSeenAt: row.last_seen_at,
    }));
  }

  private expandIdentityJids(input: readonly string[]): string[] {
    const identities = new Set(input.map((value) => value.trim()).filter(Boolean));
    if (!identities.size) return [];
    const values = [...identities];
    const placeholders = values.map(() => "?").join(", ");
    const links = this.database
      .prepare(
        `SELECT phone_jid, lid_jid
         FROM whatsapp_identity_links
         WHERE phone_jid IN (${placeholders}) OR lid_jid IN (${placeholders})`,
      )
      .all(...values, ...values) as Array<{ phone_jid: string; lid_jid: string }>;
    for (const link of links) {
      identities.add(link.phone_jid);
      identities.add(link.lid_jid);
    }
    return [...identities];
  }

  reassignGroupClient(
    groupId: string,
    clientId: string,
    source: "participant_match" | "manual" | "fallback" = "participant_match",
  ): void {
    const client = this.database
      .prepare("SELECT id FROM clients WHERE id = ? AND ignored_at IS NULL")
      .get(clientId) as EntityRecord | undefined;
    if (!client) throw new NotFoundError("Cliente ativo", clientId);

    const result = this.database
      .prepare(
        `UPDATE whatsapp_groups
         SET client_id = ?, client_link_source = ?, updated_at = ?
         WHERE id = ? AND (client_id != ? OR client_link_source != ?)`,
      )
      .run(clientId, source, nowUtc(), groupId, clientId, source);
    if (!result.changes) this.assertEntityExists("Conversa", "whatsapp_groups", groupId);
  }

  deactivateStaffMember(participantId: string): void {
    this.database
      .prepare(
        `UPDATE staff_members
         SET active = 0, updated_at = ?
         WHERE participant_id = ? AND active = 1`,
      )
      .run(nowUtc(), participantId);
  }

  reconcileStaffMembers(participantIds: readonly string[]): {
    activated: number;
    deactivated: number;
    active: number;
    restoredMessages: number;
  } {
    const configuredIds = [...new Set(participantIds)];
    return this.database.transaction(() => {
      const selfIds = (
        this.database
          .prepare("SELECT id FROM participants WHERE external_jid LIKE 'self:%'")
          .all() as EntityRecord[]
      ).map((participant) => participant.id);
      const desiredIds = [...new Set([...configuredIds, ...selfIds])];
      const staleIds = (
        this.database
          .prepare(
            `SELECT participant_id AS id
             FROM staff_members
             WHERE active = 1
               ${desiredIds.length
                 ? `AND participant_id NOT IN (${desiredIds.map(() => "?").join(", ")})`
                 : ""}`,
          )
          .all(...desiredIds) as EntityRecord[]
      ).map((participant) => participant.id);
      const deactivated = staleIds.length
        ? this.database
            .prepare(
              `UPDATE staff_members
               SET active = 0, updated_at = ?
               WHERE active = 1
                 AND participant_id IN (${staleIds.map(() => "?").join(", ")})`,
            )
            .run(nowUtc(), ...staleIds).changes
        : 0;
      const restoredMessages = staleIds.length
        ? this.database
            .prepare(
              `UPDATE messages AS message
               SET triage_kind = 'unclassified',
                   triage_state = 'unreviewed',
                   updated_at = ?
               WHERE message.sender_id IN (${staleIds.map(() => "?").join(", ")})
                 AND message.ingestion_source = 'realtime_notify'
                 AND message.triage_state = 'context'
                 AND EXISTS (
                   SELECT 1 FROM whatsapp_groups conversation
                   WHERE conversation.id = message.group_id
                     AND conversation.monitored = 1
                     AND conversation.suggestions_muted_at IS NULL
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM ticket_messages ticket_message
                   WHERE ticket_message.message_id = message.id
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM triage_block_messages block_message
                   WHERE block_message.message_id = message.id
                 )`,
            )
            .run(nowUtc(), ...staleIds).changes
        : 0;

      let activated = 0;
      for (const participantId of desiredIds) {
        const participant = this.database
          .prepare(
            `SELECT participant.id, participant.display_name,
                    COALESCE(staff.active, 0) AS active
             FROM participants participant
             LEFT JOIN staff_members staff ON staff.participant_id = participant.id
             WHERE participant.id = ?`,
          )
          .get(participantId) as
          | { id: string; display_name: string; active: number }
          | undefined;
        if (!participant) continue;
        if (!participant.active) activated += 1;
        this.setStaffMember(participant.id, participant.display_name);
      }

      return {
        activated,
        deactivated,
        active: desiredIds.length,
        restoredMessages,
      };
    })();
  }

  getParticipantExternalJids(participantIds: readonly string[]): string[] {
    const ids = [...new Set(participantIds)];
    if (!ids.length) return [];
    return (
      this.database
        .prepare(
          `SELECT external_jid
           FROM participants
           WHERE id IN (${ids.map(() => "?").join(", ")})
           ORDER BY external_jid`,
        )
        .all(...ids) as Array<{ external_jid: string }>
    ).map((participant) => participant.external_jid);
  }

  setStaffMember(
    participantId: string,
    displayName: string,
    active = true,
  ): void {
    this.assertEntityExists("Participante", "participants", participantId);
    const timestamp = nowUtc();
    this.database
      .prepare(
        `INSERT INTO staff_members
          (participant_id, display_name, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(participant_id) DO UPDATE SET
          display_name = excluded.display_name,
          active = excluded.active,
          updated_at = excluded.updated_at`,
      )
      .run(
        participantId,
        normalizedText(displayName, "Nome do funcionário"),
        active ? 1 : 0,
        timestamp,
        timestamp,
      );
  }

  upsertMessage(input: UpsertMessageInput): UpsertMessageResult {
    this.assertEntityExists("Grupo", "whatsapp_groups", input.groupId);
    this.assertEntityExists("Participante", "participants", input.senderId);
    const existing = this.database
      .prepare(
        `SELECT id, ingestion_source, triage_state
         FROM messages WHERE group_id = ? AND external_id = ?`,
      )
      .get(input.groupId, input.externalId) as
      | {
          id: string;
          ingestion_source: ConversationMessageDto["source"];
          triage_state: TriageState;
        }
      | undefined;
    const isStaff = this.isActiveStaff(input.senderId);
    const timestamp = nowUtc();
    const id = existing?.id ?? input.id ?? randomUUID();
    const triageKind = isStaff ? "context" : (input.triageKind ?? "unclassified");
    const triageState = isStaff ? "context" : (input.triageState ?? "unreviewed");

    this.database
      .prepare(
        `INSERT INTO messages
          (id, external_id, provider_message_id, group_id, sender_id, occurred_at, ingested_at, text,
           message_type, quoted_external_id, triage_kind, triage_state, ingestion_source,
           raw_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(group_id, external_id) DO UPDATE SET
          sender_id = excluded.sender_id,
          provider_message_id = COALESCE(excluded.provider_message_id, messages.provider_message_id),
          occurred_at = excluded.occurred_at,
          text = COALESCE(excluded.text, messages.text),
          message_type = excluded.message_type,
          quoted_external_id = COALESCE(excluded.quoted_external_id, messages.quoted_external_id),
          ingestion_source = CASE
            WHEN messages.ingestion_source = 'realtime_notify' THEN messages.ingestion_source
            WHEN excluded.ingestion_source = 'realtime_notify' THEN excluded.ingestion_source
            WHEN messages.ingestion_source = 'legacy' THEN excluded.ingestion_source
            ELSE messages.ingestion_source
          END,
          triage_kind = CASE
            WHEN messages.triage_state IN ('ticketed', 'ignored') THEN messages.triage_kind
            WHEN messages.ingestion_source = 'realtime_notify'
              AND messages.triage_state = 'unreviewed' THEN messages.triage_kind
            WHEN excluded.ingestion_source = 'realtime_notify'
              AND excluded.triage_state = 'unreviewed'
              AND messages.ingestion_source = 'history' THEN excluded.triage_kind
            WHEN messages.triage_state = 'context' THEN messages.triage_kind
            ELSE excluded.triage_kind
          END,
          triage_state = CASE
            WHEN messages.triage_state IN ('ticketed', 'ignored') THEN messages.triage_state
            WHEN messages.ingestion_source = 'realtime_notify'
              AND messages.triage_state = 'unreviewed' THEN messages.triage_state
            WHEN excluded.ingestion_source = 'realtime_notify'
              AND excluded.triage_state = 'unreviewed'
              AND messages.ingestion_source = 'history' THEN excluded.triage_state
            WHEN messages.triage_state = 'context' THEN messages.triage_state
            ELSE excluded.triage_state
          END,
          raw_json = COALESCE(excluded.raw_json, messages.raw_json),
          updated_at = CASE
            WHEN messages.sender_id IS NOT excluded.sender_id
              OR messages.occurred_at IS NOT excluded.occurred_at
              OR messages.text IS NOT COALESCE(excluded.text, messages.text)
              OR messages.message_type IS NOT excluded.message_type
              OR messages.quoted_external_id IS NOT COALESCE(
                excluded.quoted_external_id,
                messages.quoted_external_id
              )
            THEN excluded.updated_at
            ELSE messages.updated_at
          END`,
      )
      .run(
        id,
        normalizedText(input.externalId, "ID externo da mensagem"),
        input.providerMessageId ?? null,
        input.groupId,
        input.senderId,
        input.occurredAt,
        input.ingestedAt ?? timestamp,
        input.text ?? null,
        normalizedText(input.messageType, "Tipo da mensagem"),
        input.quotedExternalId ?? null,
        triageKind,
        triageState,
        input.ingestionSource ?? "legacy",
        input.raw === undefined ? null : JSON.stringify(input.raw),
        timestamp,
        timestamp,
      );

    this.database
      .prepare(
        `UPDATE group_participants
         SET last_seen_at = CASE WHEN last_seen_at < ? THEN ? ELSE last_seen_at END
         WHERE group_id = ? AND participant_id = ?`,
      )
      .run(input.occurredAt, input.occurredAt, input.groupId, input.senderId);

    const becameExternalCandidate =
      !isStaff &&
      triageState === "unreviewed" &&
      (!existing ||
        (existing.ingestion_source === "history" &&
          input.ingestionSource === "realtime_notify" &&
          existing.triage_state !== "unreviewed" &&
          existing.triage_state !== "ticketed" &&
          existing.triage_state !== "ignored"));
    if (becameExternalCandidate) {
      this.invalidateTriageJobsForNewExternalMessage(input.groupId);
    } else if (
      isStaff &&
      !existing &&
      (input.ingestionSource === "realtime_notify" ||
        input.ingestionSource === "realtime_append")
    ) {
      this.invalidateTriageJobsForNewStaffContext(input.groupId);
    }

    return { id, inserted: !existing };
  }

  private invalidateTriageJobsForNewExternalMessage(groupId: string): void {
    if (!this.hasTriageAiJobSchema()) return;
    const timestamp = nowUtc();
    if (this.hasTriageContextWaitSchema()) {
      this.releaseTriageContextWaitMessages(groupId, timestamp);
      this.database
        .prepare("DELETE FROM triage_context_waits WHERE group_id = ?")
        .run(groupId);
    }
    this.database
      .prepare(
        `UPDATE triage_ai_job_messages
         SET active = 0, updated_at = ?
         WHERE active = 1
           AND job_id IN (
             SELECT id FROM triage_ai_jobs
             WHERE group_id = ? AND state IN ('queued', 'running')
           )`,
      )
      .run(timestamp, groupId);
    this.database
      .prepare(
        `UPDATE triage_ai_jobs
         SET state = 'failed',
             error = 'Nova mensagem recebida; contexto reagendado',
             finished_at = ?, claimed_at = NULL, lease_expires_at = NULL,
             updated_at = ?
         WHERE group_id = ? AND state IN ('queued', 'running')`,
      )
      .run(timestamp, timestamp, groupId);
  }

  private invalidateTriageJobsForNewStaffContext(groupId: string): void {
    if (!this.hasTriageAiJobSchema()) return;
    const timestamp = nowUtc();
    this.database
      .prepare(
        `UPDATE triage_ai_job_messages
         SET active = 0, updated_at = ?
         WHERE active = 1
           AND job_id IN (
             SELECT id FROM triage_ai_jobs
             WHERE group_id = ? AND state IN ('queued', 'running')
           )`,
      )
      .run(timestamp, groupId);
    this.database
      .prepare(
        `UPDATE triage_ai_jobs
         SET state = 'failed',
             error = 'Nova resposta da equipe recebida; contexto reagendado',
             finished_at = ?, claimed_at = NULL, lease_expires_at = NULL,
             updated_at = ?
         WHERE group_id = ? AND state IN ('queued', 'running')`,
      )
      .run(timestamp, timestamp, groupId);
  }

  private hasTriageAiJobSchema(): boolean {
    if (!this.triageAiJobSchemaAvailable) {
      this.triageAiJobSchemaAvailable = Boolean(
        this.database
          .prepare(
            `SELECT 1 FROM sqlite_master
             WHERE type = 'table' AND name = 'triage_ai_job_messages'`,
          )
          .get(),
      );
    }
    return this.triageAiJobSchemaAvailable;
  }

  private hasTriageContextWaitSchema(): boolean {
    if (!this.triageContextWaitSchemaAvailable) {
      this.triageContextWaitSchemaAvailable = Boolean(
        this.database
          .prepare(
            `SELECT 1 FROM sqlite_master
             WHERE type = 'table' AND name = 'triage_context_waits'`,
          )
          .get(),
      );
    }
    return this.triageContextWaitSchemaAvailable;
  }

  private releaseTriageContextWaitMessages(
    groupId: string,
    timestamp = nowUtc(),
  ): number {
    return this.database
      .prepare(
        `UPDATE triage_ai_job_messages
         SET active = 0, updated_at = ?
         WHERE active = 1
           AND message_id IN (
             SELECT json_each.value
             FROM triage_context_waits wait_state,
                  json_each(wait_state.message_ids_json)
             WHERE wait_state.group_id = ?
           )`,
      )
      .run(timestamp, groupId).changes;
  }

  private removeMessagesFromTriageContextWait(
    groupId: string,
    messageIds: readonly string[],
    timestamp = nowUtc(),
  ): number {
    if (!messageIds.length || !this.hasTriageContextWaitSchema()) return 0;
    const row = this.database
      .prepare(
        `SELECT message_ids_json
         FROM triage_context_waits
         WHERE group_id = ?`,
      )
      .get(groupId) as { message_ids_json: string } | undefined;
    if (!row) return 0;

    const selectedIds = new Set(messageIds);
    const waitingIds = [
      ...new Set(parseJson<string[]>(row.message_ids_json, [])),
    ];
    const remainingIds = waitingIds.filter(
      (messageId) => !selectedIds.has(messageId),
    );
    const removed = waitingIds.length - remainingIds.length;
    if (!removed) return 0;

    if (remainingIds.length) {
      this.database
        .prepare(
          `UPDATE triage_context_waits
           SET message_ids_json = ?, updated_at = ?
           WHERE group_id = ?`,
        )
        .run(JSON.stringify(remainingIds), timestamp, groupId);
    } else {
      this.database
        .prepare("DELETE FROM triage_context_waits WHERE group_id = ?")
        .run(groupId);
    }
    return removed;
  }

  upsertMessageReactionEvent(
    input: UpsertMessageReactionEventInput,
  ): EntityRecord {
    this.assertEntityExists("Conversa", "whatsapp_groups", input.groupId);
    this.assertEntityExists("Participante", "participants", input.reactorId);
    const externalId = normalizedText(
      input.externalId,
      "ID externo da reação",
    );
    const targetProviderMessageId = normalizedText(
      input.targetProviderMessageId,
      "Mensagem reagida",
    );
    const occurredAt = normalizedText(input.occurredAt, "Data da reação");
    const observedAt = input.observedAt ?? nowUtc();
    const timestamp = nowUtc();
    const existing = this.database
      .prepare(
        "SELECT id FROM message_reaction_events WHERE event_external_id = ?",
      )
      .get(externalId) as EntityRecord | undefined;
    const id = existing?.id ?? input.id ?? randomUUID();

    this.database
      .prepare(
        `INSERT INTO message_reaction_events
          (id, event_external_id, group_id, target_provider_message_id,
           reactor_id, emoji, occurred_at, observed_at, raw_json,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_external_id) DO UPDATE SET
           group_id = excluded.group_id,
           target_provider_message_id = excluded.target_provider_message_id,
           reactor_id = excluded.reactor_id,
           emoji = excluded.emoji,
           occurred_at = excluded.occurred_at,
           observed_at = message_reaction_events.observed_at,
           raw_json = COALESCE(excluded.raw_json, message_reaction_events.raw_json),
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        externalId,
        input.groupId,
        targetProviderMessageId,
        input.reactorId,
        normalizedNullableText(input.emoji),
        occurredAt,
        observedAt,
        input.raw === undefined ? null : JSON.stringify(input.raw),
        timestamp,
        timestamp,
      );

    this.database
      .prepare(
        `UPDATE group_participants
         SET last_seen_at = CASE WHEN last_seen_at < ? THEN ? ELSE last_seen_at END
         WHERE group_id = ? AND participant_id = ?`,
      )
      .run(occurredAt, occurredAt, input.groupId, input.reactorId);

    return { id };
  }

  captureStaffResponse(messageId: string): {
    ticketId: string;
    responseCaptured: boolean;
  } | null {
    const captured = this.captureStaffResponseInternal(
      messageId,
      "realtime",
    );
    return captured
      ? {
          ticketId: captured.ticketId,
          responseCaptured: captured.responseCaptured,
        }
      : null;
  }

  captureHistoricalStaffResponse(
    messageId: string,
  ): HistoricalStaffResponseCaptureResult | null {
    return this.captureStaffResponseInternal(
      messageId,
      "history",
    );
  }

  upsertAttachment(input: UpsertAttachmentInput): EntityRecord {
    this.assertEntityExists("Mensagem", "messages", input.messageId);
    const timestamp = nowUtc();
    const normalized = {
      mimeType: normalizedText(input.mimeType, "MIME do anexo"),
      localPath: normalizedText(input.localPath, "Caminho local do anexo"),
      sha256: normalizedText(input.sha256, "Hash do anexo"),
    };
    const existingBySource = input.sourceKey
      ? (this.database
          .prepare(
            `SELECT id, kind, mime_type, file_name, local_path, size_bytes,
                    sha256, extracted_text, available, updated_at
             FROM attachments WHERE source_key = ?`,
          )
          .get(input.sourceKey) as
          | AttachmentMaterialState
          | undefined)
      : undefined;
    const id = existingBySource?.id ?? input.id ?? randomUUID();

    if (existingBySource) {
      const materialChanged = attachmentMateriallyDiffers(
        existingBySource,
        input,
        normalized,
      );
      this.database
        .prepare(
          `UPDATE attachments SET
            kind = ?, mime_type = ?, file_name = COALESCE(?, file_name),
            local_path = ?, size_bytes = COALESCE(?, size_bytes), sha256 = ?,
            extracted_text = COALESCE(?, extracted_text), available = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.kind,
          normalized.mimeType,
          input.fileName ?? null,
          normalized.localPath,
          input.sizeBytes ?? null,
          normalized.sha256,
          input.extractedText ?? null,
          input.available === false ? 0 : 1,
          materialChanged ? timestamp : existingBySource.updated_at,
          id,
        );
      this.captureAvailableStaffAttachmentResponses(input.messageId, timestamp);
      if (
        materialChanged &&
        input.available !== false &&
        new Set(["image", "pdf", "document"]).has(input.kind)
      ) {
        this.invalidateTicketsForMaterialAttachment(input.messageId, timestamp);
      }
      return { id };
    }

    const existingByMessageHash = this.database
      .prepare(
        `SELECT id, kind, mime_type, file_name, local_path, size_bytes,
                sha256, extracted_text, available, updated_at
         FROM attachments WHERE message_id = ? AND sha256 = ?`,
      )
      .get(input.messageId, normalized.sha256) as
      | AttachmentMaterialState
      | undefined;
    const materialChanged = existingByMessageHash
      ? attachmentMateriallyDiffers(existingByMessageHash, input, normalized)
      : true;

    const attachment = this.database
      .prepare(
        `INSERT INTO attachments
          (id, message_id, kind, mime_type, file_name, local_path, size_bytes,
           sha256, source_key, extracted_text, available, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(message_id, sha256) DO UPDATE SET
          kind = excluded.kind,
          mime_type = excluded.mime_type,
          file_name = COALESCE(excluded.file_name, attachments.file_name),
          local_path = excluded.local_path,
          size_bytes = COALESCE(excluded.size_bytes, attachments.size_bytes),
          source_key = COALESCE(excluded.source_key, attachments.source_key),
          extracted_text = COALESCE(excluded.extracted_text, attachments.extracted_text),
          available = excluded.available,
          updated_at = CASE
            WHEN attachments.kind IS NOT excluded.kind
              OR attachments.mime_type IS NOT excluded.mime_type
              OR attachments.file_name IS NOT COALESCE(
                excluded.file_name,
                attachments.file_name
              )
              OR attachments.local_path IS NOT excluded.local_path
              OR attachments.size_bytes IS NOT COALESCE(
                excluded.size_bytes,
                attachments.size_bytes
              )
              OR attachments.extracted_text IS NOT COALESCE(
                excluded.extracted_text,
                attachments.extracted_text
              )
              OR attachments.available IS NOT excluded.available
            THEN excluded.updated_at
            ELSE attachments.updated_at
          END
         RETURNING id`,
      )
      .get(
        id,
        input.messageId,
        input.kind,
        normalized.mimeType,
        input.fileName ?? null,
        normalized.localPath,
        input.sizeBytes ?? null,
        normalized.sha256,
        input.sourceKey ?? null,
        input.extractedText ?? null,
        input.available === false ? 0 : 1,
        timestamp,
        timestamp,
      ) as EntityRecord;
    this.captureAvailableStaffAttachmentResponses(input.messageId, timestamp);
    if (
      materialChanged &&
      input.available !== false &&
      new Set(["image", "pdf", "document"]).has(input.kind)
    ) {
      this.invalidateTicketsForMaterialAttachment(input.messageId, timestamp);
    }
    return attachment;
  }

  hasAttachmentSourceKey(sourceKey: string): boolean {
    return Boolean(
      this.database
        .prepare(
          "SELECT 1 FROM attachments WHERE source_key = ? AND available = 1 LIMIT 1",
        )
        .get(normalizedText(sourceKey, "Chave de origem do anexo")),
    );
  }

  upsertCategory(input: {
    id?: string;
    facet: CategoryFacet;
    slug: string;
    label: string;
    color?: string | null;
    origin?: "system" | "manual";
  }): CategoryDto {
    const normalized = normalizeCatalogCategory(input.facet, input.label);
    if (!normalized) {
      throw new ValidationError(
        "A categoria deve descrever o problema ou a área funcional, não o canal, a origem, o formato do anexo ou uma limitação da análise",
        { facet: input.facet, label: input.label },
      );
    }
    const id = input.id ?? randomUUID();
    const timestamp = nowUtc();
    return this.database
      .prepare(
        `INSERT INTO categories
          (id, facet, slug, label, color, origin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(facet, slug) DO UPDATE SET
          label = excluded.label,
          color = excluded.color,
          origin = CASE
            WHEN categories.origin = 'manual' OR excluded.origin = 'manual'
              THEN 'manual'
            ELSE 'system'
          END,
          updated_at = excluded.updated_at
         RETURNING id, facet, slug, label, color`,
      )
      .get(
        id,
        normalized.facet,
        normalized.slug,
        normalized.label,
        input.color ?? null,
        input.origin ?? "system",
        timestamp,
        timestamp,
      ) as CategoryDto;
  }

  createTicket(input: CreateTicketInput): TicketDetailDto {
    return this.database.transaction(() => {
      if (input.id) {
        const existing = this.database
          .prepare("SELECT id FROM tickets WHERE id = ?")
          .get(input.id) as EntityRecord | undefined;
        if (existing) return this.getTicketDetail(existing.id);
      }

      const group = this.database
        .prepare(
          `SELECT g.id, g.client_id, c.ignored_at
           FROM whatsapp_groups g
           JOIN clients c ON c.id = g.client_id
           WHERE g.id = ?`,
        )
        .get(input.groupId) as
        | { id: string; client_id: string; ignored_at: string | null }
        | undefined;
      if (!group) {
        throw new NotFoundError("Grupo", input.groupId);
      }
      if (group.ignored_at) {
        throw new ConflictError(
          "O cliente foi excluído da operação e não pode abrir novos tickets",
          { clientId: group.client_id },
        );
      }

      const sourceMessageId = input.sourceMessageId ?? null;
      if (sourceMessageId) {
        const source = this.getMessageContext(sourceMessageId);
        if (source.groupId !== input.groupId) {
          throw new ValidationError("A mensagem de origem não pertence ao grupo do ticket");
        }
        if (source.isStaff) {
          throw new ValidationError(
            "Mensagens de funcionários são contexto e não podem abrir tickets",
            { sourceMessageId },
          );
        }

        const ticketForSource = this.database
          .prepare("SELECT id FROM tickets WHERE source_message_id = ?")
          .get(sourceMessageId) as EntityRecord | undefined;
        if (ticketForSource) {
          return this.getTicketDetail(ticketForSource.id);
        }
      }

      if (input.affectedStoreId) {
        const store = this.database
          .prepare("SELECT client_id FROM client_stores WHERE id = ? AND active = 1")
          .get(input.affectedStoreId) as { client_id: string } | undefined;
        if (!store) {
          throw new NotFoundError("Loja", input.affectedStoreId);
        }
        if (store.client_id !== group.client_id) {
          throw new ValidationError("A loja afetada não pertence ao cliente do grupo");
        }
      }

      const messageIds = [...new Set([
        ...(sourceMessageId ? [sourceMessageId] : []),
        ...(input.messageIds ?? []),
      ])];
      const messageTimes = messageIds.map((messageId) => {
        const context = this.getMessageContext(messageId);
        if (context.groupId !== input.groupId) {
          throw new ValidationError("Todas as mensagens do ticket devem pertencer ao mesmo grupo", {
            messageId,
          });
        }
        return context.occurredAt;
      });

      const createdAt = input.createdAt ?? nowUtc();
      const id = input.id ?? randomUUID();
      const status = input.status ?? "new";
      const firstMessageAt = [...messageTimes].sort()[0] ?? createdAt;
      const lastMessageAt = [...messageTimes].sort().at(-1) ?? createdAt;

      this.database
        .prepare(
          `INSERT INTO tickets
            (id, client_id, group_id, affected_store_id, source_message_id,
             title, summary, status, priority, confidence, needs_review,
             first_message_at, last_message_at, created_at, updated_at,
             resolved_at, archived_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          id,
          group.client_id,
          input.groupId,
          input.affectedStoreId ?? null,
          sourceMessageId,
          normalizedText(input.title, "Título do ticket"),
          normalizedText(input.summary, "Resumo do ticket"),
          status,
          input.priority ?? "normal",
          clampConfidence(input.confidence),
          input.needsReview === false ? 0 : 1,
          firstMessageAt,
          lastMessageAt,
          createdAt,
          createdAt,
          status === "resolved" ? createdAt : null,
        );

      for (const messageId of messageIds) {
        const inserted = this.attachMessageToTicketInternal(id, messageId, createdAt);
        if (inserted) {
          this.captureAttachedStaffMessage(id, messageId, createdAt);
        }
      }

      for (const category of input.categories ?? []) {
        this.addTicketCategoryInternal(
          id,
          category.categoryId,
          category.source ?? "ai",
          clampConfidence(category.confidence),
          createdAt,
        );
      }

      this.insertTicketEvent({
        ticketId: id,
        eventType: "ticket_created",
        actor: input.actor ?? "system",
        fromStatus: null,
        toStatus: status,
        data: {
          sourceMessageId,
          origin: sourceMessageId ? "conversation" : "manual",
        },
        occurredAt: createdAt,
      });

      return this.getTicketDetail(id);
    })();
  }

  createManualTicket(input: CreateManualTicketInput): TicketDetailDto {
    return this.createTicket({
      id: normalizedText(input.clientRequestId, "Identificador da solicitação"),
      groupId: input.groupId,
      sourceMessageId: null,
      title: input.title,
      summary: input.summary,
      status: "triage",
      priority: input.priority ?? "normal",
      confidence: null,
      needsReview: false,
      actor: input.actor ?? "Operador local",
    });
  }

  attachMessageToTicket(ticketId: string, messageId: string, actor = "system"): void {
    this.database.transaction(() => {
      const timestamp = nowUtc();
      const inserted = this.attachMessageToTicketInternal(ticketId, messageId, timestamp);
      if (!inserted) {
        return;
      }
      this.invalidateLegacyAutomaticGuidance(ticketId, timestamp);
      this.captureAttachedStaffMessage(ticketId, messageId, timestamp);
      this.insertTicketEvent({
        ticketId,
        eventType: "message_attached",
        actor,
        fromStatus: null,
        toStatus: null,
        data: { messageId },
        occurredAt: timestamp,
      });
    })();
  }

  detachMessageFromTicket(
    ticketId: string,
    messageId: string,
    actor = "Operador local",
  ): TicketDetailDto {
    return this.database.transaction(() => {
      const ticket = this.database
        .prepare(
          `SELECT id, group_id, source_message_id, status
           FROM tickets
           WHERE id = ?`,
        )
        .get(ticketId) as
        | {
            id: string;
            group_id: string;
            source_message_id: string | null;
            status: TicketStatus;
          }
        | undefined;
      if (!ticket) throw new NotFoundError("Ticket", ticketId);

      const linkedMessage = this.database
        .prepare(
          `SELECT message.id, message.group_id,
                  CASE WHEN staff.participant_id IS NULL THEN 0 ELSE 1 END AS is_staff
           FROM ticket_messages ticket_message
           JOIN messages message ON message.id = ticket_message.message_id
           LEFT JOIN staff_members staff
             ON staff.participant_id = message.sender_id AND staff.active = 1
           WHERE ticket_message.ticket_id = ?
             AND ticket_message.message_id = ?`,
        )
        .get(ticketId, messageId) as
        | { id: string; group_id: string; is_staff: number }
        | undefined;
      if (!linkedMessage) {
        throw new NotFoundError("Mensagem vinculada ao ticket", messageId);
      }
      if (ticket.source_message_id === messageId) {
        throw new ConflictError(
          "A mensagem de origem não pode ser removida do ticket",
          { ticketId, messageId },
        );
      }
      if (linkedMessage.group_id !== ticket.group_id) {
        throw new ValidationError("A mensagem não pertence ao grupo do ticket", {
          messageId,
        });
      }

      const timestamp = nowUtc();
      const removedSentResponses = this.database
        .prepare(
          `DELETE FROM sent_responses
           WHERE ticket_id = ? AND message_id = ?`,
        )
        .run(ticketId, messageId).changes;
      this.database
        .prepare(
          `DELETE FROM ticket_messages
           WHERE ticket_id = ? AND message_id = ?`,
        )
        .run(ticketId, messageId);

      const linkedElsewhere = Boolean(
        this.database
          .prepare(
            `SELECT 1 FROM ticket_messages
             WHERE message_id = ?
             LIMIT 1`,
          )
          .get(messageId),
      );
      if (!linkedElsewhere) {
        this.database
          .prepare(
            `UPDATE messages
             SET triage_kind = 'context', triage_state = 'context', updated_at = ?
             WHERE id = ?`,
          )
          .run(timestamp, messageId);
      }

      this.database
        .prepare(
          `UPDATE tickets
           SET first_message_at = COALESCE(
                 (
                   SELECT MIN(message.occurred_at)
                   FROM ticket_messages ticket_message
                   JOIN messages message ON message.id = ticket_message.message_id
                   WHERE ticket_message.ticket_id = tickets.id
                 ),
                 (
                   SELECT source.occurred_at
                   FROM messages source
                   WHERE source.id = tickets.source_message_id
                 ),
                 tickets.created_at
               ),
               last_message_at = COALESCE(
                 (
                   SELECT MAX(message.occurred_at)
                   FROM ticket_messages ticket_message
                   JOIN messages message ON message.id = ticket_message.message_id
                   WHERE ticket_message.ticket_id = tickets.id
                 ),
                 (
                   SELECT source.occurred_at
                   FROM messages source
                   WHERE source.id = tickets.source_message_id
                 ),
                 tickets.created_at
               ),
               updated_at = ?
           WHERE id = ?`,
        )
        .run(timestamp, ticketId);

      this.insertTicketEvent({
        ticketId,
        eventType: "message_detached",
        actor: normalizedNullableText(actor) ?? "Operador local",
        fromStatus: null,
        toStatus: null,
        data: {
          messageId,
          removedSentResponse: removedSentResponses > 0,
        },
        occurredAt: timestamp,
      });
      this.invalidateLegacyAutomaticGuidance(ticketId, timestamp);

      return this.getTicketDetail(ticketId);
    })();
  }

  deleteTicket(
    ticketId: string,
    input: DeleteTicketInput = {},
  ): DeleteTicketResponse {
    return this.database.transaction(() => {
      const ticket = this.database
        .prepare("SELECT id FROM tickets WHERE id = ?")
        .get(ticketId) as EntityRecord | undefined;
      if (!ticket) throw new NotFoundError("Ticket", ticketId);

      const messageRows = this.database
        .prepare(
          `SELECT DISTINCT m.id
           FROM messages m
           WHERE m.id IN (
             SELECT tm.message_id
             FROM ticket_messages tm
             WHERE tm.ticket_id = ?
             UNION
             SELECT t.source_message_id
             FROM tickets t
             WHERE t.id = ? AND t.source_message_id IS NOT NULL
             UNION
             SELECT block_message.message_id
             FROM triage_block_messages block_message
             JOIN triage_blocks block ON block.id = block_message.block_id
             WHERE (block.suggested_ticket_id = ?
                OR block.confirmed_ticket_id = ?
                OR EXISTS (
                  SELECT 1
                  FROM triage_block_events event
                  WHERE event.block_id = block.id
                    AND instr(event.data_json, ?) > 0
                ))
               AND (block.suggested_ticket_id IS NULL OR block.suggested_ticket_id = ?)
               AND (block.confirmed_ticket_id IS NULL OR block.confirmed_ticket_id = ?)
           )`,
        )
        .all(
          ticketId,
          ticketId,
          ticketId,
          ticketId,
          ticketId,
          ticketId,
          ticketId,
        ) as EntityRecord[];
      const categoryRows = this.database
        .prepare(
          `SELECT category_id AS id
           FROM ticket_categories
           WHERE ticket_id = ?`,
        )
        .all(ticketId) as EntityRecord[];
      const counts = this.database
        .prepare(
          `SELECT
            (SELECT COUNT(*) FROM ticket_events WHERE ticket_id = ?) AS ticket_events,
            (SELECT COUNT(*) FROM ticket_categories WHERE ticket_id = ?) AS categories,
            (SELECT COUNT(*) FROM suggestions WHERE ticket_id = ?) AS suggestions,
            (SELECT COUNT(*) FROM sent_responses WHERE ticket_id = ?) AS sent_responses,
            (SELECT COUNT(*) FROM resolutions WHERE ticket_id = ?) AS resolutions,
            (SELECT COUNT(*) FROM evidence_queries WHERE ticket_id = ?) AS evidence_queries,
            (SELECT COUNT(*) FROM investigation_jobs WHERE ticket_id = ?) AS investigation_jobs,
            (SELECT COUNT(*) FROM investigation_threads WHERE ticket_id = ?) AS investigation_threads,
            (SELECT COUNT(*)
             FROM investigation_thread_messages message
             JOIN investigation_threads thread ON thread.id = message.thread_id
             WHERE thread.ticket_id = ?) AS investigation_thread_messages,
            (SELECT COUNT(*)
             FROM investigation_thread_jobs job
             JOIN investigation_threads thread ON thread.id = job.thread_id
             WHERE thread.ticket_id = ?) AS investigation_thread_jobs,
            (SELECT COUNT(*)
             FROM investigation_thread_tool_executions execution
             JOIN investigation_thread_jobs job ON job.id = execution.job_id
             JOIN investigation_threads thread ON thread.id = job.thread_id
             WHERE thread.ticket_id = ?) AS investigation_thread_tool_executions`,
        )
        .get(
          ticketId,
          ticketId,
          ticketId,
          ticketId,
          ticketId,
          ticketId,
          ticketId,
          ticketId,
          ticketId,
          ticketId,
          ticketId,
        ) as {
        ticket_events: number;
        categories: number;
        suggestions: number;
        sent_responses: number;
        resolutions: number;
        evidence_queries: number;
        investigation_jobs: number;
        investigation_threads: number;
        investigation_thread_messages: number;
        investigation_thread_jobs: number;
        investigation_thread_tool_executions: number;
      };
      const preservedAttachments = messageRows.length
        ? (
            this.database
              .prepare(
                `SELECT COUNT(*) AS count
                 FROM attachments
                 WHERE message_id IN (${messageRows.map(() => "?").join(", ")})`,
              )
              .get(...messageRows.map((message) => message.id)) as { count: number }
          ).count
        : 0;

      this.database
        .prepare(
          `DELETE FROM investigation_thread_jobs
           WHERE thread_id IN (
             SELECT id FROM investigation_threads WHERE ticket_id = ?
           )`,
        )
        .run(ticketId);
      this.database
        .prepare("DELETE FROM evidence_queries WHERE ticket_id = ?")
        .run(ticketId);
      this.database
        .prepare(
          `DELETE FROM triage_blocks
           WHERE (suggested_ticket_id = ?
              OR confirmed_ticket_id = ?
              OR EXISTS (
                SELECT 1
                FROM triage_block_events event
                WHERE event.block_id = triage_blocks.id
                  AND instr(event.data_json, ?) > 0
              ))
             AND (suggested_ticket_id IS NULL OR suggested_ticket_id = ?)
             AND (confirmed_ticket_id IS NULL OR confirmed_ticket_id = ?)`,
        )
        .run(ticketId, ticketId, ticketId, ticketId, ticketId);
      this.database
        .prepare(
          `DELETE FROM triage_block_events
           WHERE instr(data_json, ?) > 0`,
        )
        .run(ticketId);
      this.database.prepare("DELETE FROM tickets WHERE id = ?").run(ticketId);

      if (categoryRows.length) {
        this.deleteOrphanCategories(categoryRows.map((category) => category.id));
      }

      const deletedAt = nowUtc();
      if (messageRows.length) {
        const placeholders = messageRows.map(() => "?").join(", ");
        this.database
          .prepare(
            `UPDATE messages AS message
             SET triage_kind = CASE
                   WHEN EXISTS (
                     SELECT 1 FROM staff_members staff
                     WHERE staff.participant_id = message.sender_id
                       AND staff.active = 1
                   ) THEN 'context'
                   ELSE message.triage_kind
                 END,
                 triage_state = CASE
                   WHEN message.triage_state = 'context'
                     OR EXISTS (
                       SELECT 1 FROM staff_members staff
                       WHERE staff.participant_id = message.sender_id
                         AND staff.active = 1
                     ) THEN 'context'
                   ELSE 'ignored'
                 END,
                 updated_at = ?
             WHERE message.id IN (${placeholders})
               AND NOT EXISTS (
                 SELECT 1 FROM ticket_messages remaining
                 WHERE remaining.message_id = message.id
               )`,
          )
          .run(deletedAt, ...messageRows.map((message) => message.id));
      }

      return {
        id: ticketId,
        deletedAt,
        actor: normalizedNullableText(input.actor) ?? "Operador local",
        reason: normalizedNullableText(input.reason),
        deleted: {
          ticketEvents: counts.ticket_events,
          categories: counts.categories,
          suggestions: counts.suggestions,
          sentResponses: counts.sent_responses,
          resolutions: counts.resolutions,
          evidenceQueries: counts.evidence_queries,
          investigationJobs: counts.investigation_jobs,
          investigationThreads: counts.investigation_threads,
          investigationThreadMessages: counts.investigation_thread_messages,
          investigationThreadJobs: counts.investigation_thread_jobs,
          investigationThreadToolExecutions:
            counts.investigation_thread_tool_executions,
        },
        preserved: {
          messages: messageRows.length,
          attachments: preservedAttachments,
        },
      };
    })();
  }

  listTriageCandidates(limit = 100): TriageCandidate[] {
    const safeLimit = Math.min(Math.max(limit, 1), 500);
    const rows = this.database
      .prepare(
        `WITH eligible_messages AS (
           SELECT
             m.id, m.external_id, m.quoted_external_id, m.occurred_at, m.text,
             m.message_type, m.triage_kind,
             g.id AS group_id, g.external_jid AS group_external_jid,
             g.subject AS group_subject,
             c.id AS client_id, c.name AS client_name, c.kind AS client_kind,
             p.id AS sender_id, p.display_name, p.phone_e164,
             CASE WHEN staff.participant_id IS NULL THEN 0 ELSE 1 END AS is_staff,
             ROW_NUMBER() OVER (
               PARTITION BY g.id ORDER BY m.occurred_at, m.id
             ) AS conversation_position
           FROM messages m
           JOIN whatsapp_groups g ON g.id = m.group_id
           JOIN clients c ON c.id = g.client_id
           JOIN participants p ON p.id = m.sender_id
           LEFT JOIN staff_members staff
             ON staff.participant_id = p.id AND staff.active = 1
           WHERE m.triage_state = 'unreviewed'
             AND m.message_type NOT IN ('reactionMessage', 'protocolMessage')
             AND staff.participant_id IS NULL
             AND c.ignored_at IS NULL
             AND g.suggestions_muted_at IS NULL
             AND NOT EXISTS (
               SELECT 1
               FROM triage_block_messages suggested_message
               JOIN triage_blocks suggested_block
                 ON suggested_block.id = suggested_message.block_id
               WHERE suggested_message.message_id = m.id
                 AND suggested_message.active = 1
                 AND suggested_block.state = 'pending'
             )
             AND NOT EXISTS (
               SELECT 1
               FROM triage_ai_job_messages ai_message
               WHERE ai_message.message_id = m.id
                 AND ai_message.active = 1
             )
             AND (
               g.monitored = 1
               OR g.external_jid LIKE '%@s.whatsapp.net'
               OR g.external_jid LIKE '%@lid'
             )
         )
         SELECT
           id, external_id, quoted_external_id, occurred_at, text,
           message_type, triage_kind, group_id, group_external_jid,
           group_subject, client_id, client_name, client_kind,
           sender_id, display_name, phone_e164, is_staff
         FROM eligible_messages
         ORDER BY conversation_position, occurred_at, id
         LIMIT ?`,
      )
      .all(safeLimit) as Array<{
      id: string;
      external_id: string;
      quoted_external_id: string | null;
      occurred_at: string;
      text: string | null;
      message_type: string;
      triage_kind: TriageKind;
      group_id: string;
      group_external_jid: string;
      group_subject: string;
      client_id: string;
      client_name: string;
      client_kind: ClientKind;
      sender_id: string;
      display_name: string;
      phone_e164: string | null;
      is_staff: number;
    }>;
    const attachmentStatement = this.database.prepare(
      `SELECT id, kind, mime_type, file_name, local_path, size_bytes, sha256,
              extracted_text, available
       FROM attachments WHERE message_id = ? ORDER BY created_at`,
    );

    return rows.map((row) => ({
      id: row.id,
      externalId: row.external_id,
      quotedExternalId: row.quoted_external_id,
      occurredAt: row.occurred_at,
      text: row.text,
      messageType: row.message_type,
      triageKind: row.triage_kind,
      group: {
        id: row.group_id,
        externalJid: row.group_external_jid,
        subject: row.group_subject,
      },
      client: {
        id: row.client_id,
        name: row.client_name,
        kind: row.client_kind,
      },
      sender: {
        id: row.sender_id,
        displayName: row.display_name,
        phoneE164: row.phone_e164,
        isStaff: Boolean(row.is_staff),
      },
      attachments: (attachmentStatement.all(row.id) as Array<{
        id: string;
        kind: AttachmentDto["kind"];
        mime_type: string;
        file_name: string | null;
        local_path: string;
        size_bytes: number | null;
        sha256: string;
        extracted_text: string | null;
        available: number;
      }>).map((attachment) => ({
        id: attachment.id,
        kind: attachment.kind,
        mimeType: attachment.mime_type,
        fileName: attachment.file_name,
        url: attachment.available ? `/api/attachments/${attachment.id}` : null,
        sizeBytes: attachment.size_bytes,
        sha256: attachment.sha256,
        extractedText: attachment.extracted_text,
        available: Boolean(attachment.available),
      })),
    }));
  }

  initializeTriageAiSettings(input: {
    enabled: boolean;
    model: string;
    silenceWindowSeconds?: number;
    actor?: string;
  }): TriageAiSettingsDto {
    const model = normalizedText(input.model, "Modelo de triagem");
    if (model.length > 200) {
      throw new ValidationError("Modelo de triagem excede 200 caracteres");
    }
    const timestamp = nowUtc();
    this.database
      .prepare(
        `INSERT INTO triage_ai_settings
          (singleton, enabled, model, silence_window_seconds, updated_by, created_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(singleton) DO NOTHING`,
      )
      .run(
        input.enabled ? 1 : 0,
        model,
        normalizeTriageSilenceWindowSeconds(
          input.silenceWindowSeconds ?? DEFAULT_TRIAGE_SILENCE_WINDOW_SECONDS,
        ),
        normalizedNullableText(input.actor) ?? "config",
        timestamp,
        timestamp,
      );
    return this.getTriageAiSettings();
  }

  getTriageAiSettings(): TriageAiSettingsDto {
    const existing = this.database
      .prepare(
        `SELECT enabled, model, silence_window_seconds, updated_by, updated_at
         FROM triage_ai_settings WHERE singleton = 1`,
      )
      .get() as
      | {
          enabled: number;
          model: string;
          silence_window_seconds: number;
          updated_by: string;
          updated_at: string;
        }
      | undefined;
    if (!existing) {
      return this.initializeTriageAiSettings({
        enabled: true,
        model: DEFAULT_TRIAGE_AI_MODEL,
        actor: "default",
      });
    }
    return {
      enabled: Boolean(existing.enabled),
      model: existing.model,
      silenceWindowSeconds: existing.silence_window_seconds,
      updatedBy: existing.updated_by,
      updatedAt: existing.updated_at,
    };
  }

  updateTriageAiSettings(
    input: UpdateTriageAiSettingsInput,
  ): TriageAiSettingsDto {
    const model = normalizedText(input.model, "Modelo de triagem");
    if (model.length > 200 || !/^[A-Za-z0-9._:/-]+$/.test(model)) {
      throw new ValidationError("Modelo de triagem inválido");
    }
    const timestamp = nowUtc();
    const actor = normalizedNullableText(input.actor) ?? "Operador local";
    this.initializeTriageAiSettings({ enabled: input.enabled, model, actor });
    this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE triage_ai_settings
           SET enabled = ?, model = ?, silence_window_seconds = ?,
               updated_by = ?, updated_at = ?
           WHERE singleton = 1`,
        )
        .run(
          input.enabled ? 1 : 0,
          model,
          normalizeTriageSilenceWindowSeconds(
            input.silenceWindowSeconds ??
              this.getTriageAiSettings().silenceWindowSeconds,
          ),
          actor,
          timestamp,
        );
      if (!input.enabled) {
        this.releaseQueuedTriageAiJobs(actor, timestamp);
      }
    }).immediate();
    return this.getTriageAiSettings();
  }

  releaseQueuedTriageAiJobs(
    actor = "triage-fallback",
    timestamp = nowUtc(),
  ): number {
    this.database
      .prepare(
        `UPDATE triage_ai_job_messages
         SET active = 0, updated_at = ?
         WHERE active = 1
           AND message_id IN (
             SELECT json_each.value
             FROM triage_context_waits wait_state,
                  json_each(wait_state.message_ids_json)
           )`,
      )
      .run(timestamp);
    this.database.prepare("DELETE FROM triage_context_waits").run();
    this.database
      .prepare(
        `UPDATE triage_ai_job_messages
         SET active = 0, updated_at = ?
         WHERE active = 1
           AND job_id IN (
             SELECT id FROM triage_ai_jobs WHERE state = 'queued'
           )`,
      )
      .run(timestamp);
    return this.database
      .prepare(
        `UPDATE triage_ai_jobs
         SET state = 'failed',
             error = ?,
             finished_at = ?, claimed_at = NULL, lease_expires_at = NULL,
             updated_at = ?
         WHERE state = 'queued'`,
      )
      .run(
        `Triagem por IA desabilitada por ${actor}; mensagens liberadas para fallback local`,
        timestamp,
        timestamp,
      ).changes;
  }

  latestEligibleTriageMessageAt(groupId: string): string | null {
    const row = this.database
      .prepare(
        `SELECT MAX(message.occurred_at) AS occurred_at
         FROM messages message
         JOIN whatsapp_groups conversation ON conversation.id = message.group_id
         JOIN clients client ON client.id = conversation.client_id
         LEFT JOIN staff_members staff
           ON staff.participant_id = message.sender_id AND staff.active = 1
         WHERE message.group_id = ?
           AND message.triage_state = 'unreviewed'
           AND message.message_type NOT IN ('reactionMessage', 'protocolMessage')
           AND staff.participant_id IS NULL
           AND client.ignored_at IS NULL
           AND conversation.suggestions_muted_at IS NULL`,
      )
      .get(groupId) as { occurred_at: string | null };
    return row.occurred_at;
  }

  hasBlockingAudioTranscriptions(groupId: string): boolean {
    return Boolean(
      this.database
        .prepare(
          `SELECT 1
           FROM audio_transcriptions transcription
           JOIN messages message ON message.id = transcription.message_id
           WHERE message.group_id = ?
             AND transcription.source = 'realtime'
             AND transcription.status <> 'completed'
           LIMIT 1`,
        )
        .get(groupId),
    );
  }

  deferTriageForPendingAudio(messageId: string): number {
    const message = this.database
      .prepare("SELECT group_id FROM messages WHERE id = ?")
      .get(messageId) as { group_id: string } | undefined;
    if (!message || !this.hasTriageAiJobSchema()) return 0;
    const timestamp = nowUtc();
    if (this.hasTriageContextWaitSchema()) {
      this.releaseTriageContextWaitMessages(message.group_id, timestamp);
      this.database
        .prepare("DELETE FROM triage_context_waits WHERE group_id = ?")
        .run(message.group_id);
    }
    this.database
      .prepare(
        `UPDATE triage_ai_job_messages
         SET active = 0, updated_at = ?
         WHERE active = 1
           AND job_id IN (
             SELECT id FROM triage_ai_jobs
             WHERE group_id = ? AND state IN ('queued', 'running')
           )`,
      )
      .run(timestamp, message.group_id);
    return this.database
      .prepare(
        `UPDATE triage_ai_jobs
         SET state = 'failed',
             error = 'Áudio aguardando transcrição; contexto reagendado',
             finished_at = ?, claimed_at = NULL, lease_expires_at = NULL,
             updated_at = ?
         WHERE group_id = ? AND state IN ('queued', 'running')`,
      )
      .run(timestamp, timestamp, message.group_id).changes;
  }

  isTriageContextWaiting(groupId: string, messageIds: string[]): boolean {
    const row = this.database
      .prepare(
        `SELECT message_ids_json
         FROM triage_context_waits
         WHERE group_id = ?`,
      )
      .get(groupId) as { message_ids_json: string } | undefined;
    if (!row) return false;
    const waitingIds = parseJson<string[]>(row.message_ids_json, []).toSorted();
    const candidateIds = [...new Set(messageIds)].toSorted();
    return (
      waitingIds.length === candidateIds.length &&
      waitingIds.every((messageId, index) => messageId === candidateIds[index])
    );
  }

  getConversationSuggestionAnalysis(
    groupId: string,
  ): ConversationSuggestionAnalysisDto {
    this.assertEntityExists("Conversa", "whatsapp_groups", groupId);
    const activeJob = this.database
      .prepare(
        `SELECT state
         FROM triage_ai_jobs
         WHERE group_id = ? AND state IN ('queued', 'running')
         ORDER BY CASE state WHEN 'running' THEN 0 ELSE 1 END,
                  requested_at, id
         LIMIT 1`,
      )
      .get(groupId) as { state: "queued" | "running" } | undefined;
    const pending = this.database
      .prepare(
        `SELECT COUNT(*) AS count, MAX(message.occurred_at) AS latest_at
         FROM messages message
         JOIN whatsapp_groups conversation ON conversation.id = message.group_id
         JOIN clients client ON client.id = conversation.client_id
         LEFT JOIN staff_members staff
           ON staff.participant_id = message.sender_id AND staff.active = 1
         WHERE message.group_id = ?
           AND message.triage_state = 'unreviewed'
           AND message.message_type NOT IN ('reactionMessage', 'protocolMessage')
           AND staff.participant_id IS NULL
           AND client.ignored_at IS NULL
           AND conversation.suggestions_muted_at IS NULL
           AND NOT EXISTS (
             SELECT 1
             FROM triage_block_messages suggested_message
             JOIN triage_blocks suggested_block
               ON suggested_block.id = suggested_message.block_id
             WHERE suggested_message.message_id = message.id
               AND suggested_message.active = 1
               AND suggested_block.state = 'pending'
           )`,
      )
      .get(groupId) as { count: number; latest_at: string | null };
    const waiting = this.database
      .prepare("SELECT 1 FROM triage_context_waits WHERE group_id = ?")
      .get(groupId);
    const waitingForAudio = this.hasBlockingAudioTranscriptions(groupId);
    const settings = this.getTriageAiSettings();
    const nextAnalysisAt = pending.latest_at
      ? new Date(
          new Date(pending.latest_at).getTime() +
            settings.silenceWindowSeconds * 1_000,
        ).toISOString()
      : null;
    return {
      state: activeJob?.state ?? (waitingForAudio
        ? "waiting_for_audio"
        : waiting
          ? "waiting_for_context"
          : pending.count
            ? "waiting_for_silence"
            : "idle"),
      pendingMessageCount: pending.count,
      nextAnalysisAt:
        activeJob || waiting || waitingForAudio || !pending.count
          ? null
          : nextAnalysisAt,
    };
  }

  triggerConversationTriageAnalysis(
    groupId: string,
    input: { model?: string; promptVersion: string },
  ): { accepted: boolean; jobId: string | null; analysis: ConversationSuggestionAnalysisDto } {
    this.assertEntityExists("Conversa", "whatsapp_groups", groupId);
    const settings = this.getTriageAiSettings();
    if (!settings.enabled) {
      throw new ConflictError("Ative as sugestões por IA antes de analisar a conversa");
    }
    const conversation = this.database
      .prepare("SELECT suggestions_muted_at FROM whatsapp_groups WHERE id = ?")
      .get(groupId) as { suggestions_muted_at: string | null };
    if (conversation.suggestions_muted_at) {
      throw new ConflictError("As sugestões estão silenciadas para esta conversa");
    }
    if (this.hasBlockingAudioTranscriptions(groupId)) {
      throw new ConflictError(
        "Aguarde a transcrição do áudio antes de analisar esta conversa",
      );
    }
    const active = this.database
      .prepare(
        `SELECT id FROM triage_ai_jobs
         WHERE group_id = ? AND state IN ('queued', 'running')
         ORDER BY requested_at, id LIMIT 1`,
      )
      .get(groupId) as { id: string } | undefined;
    if (active) {
      return {
        accepted: true,
        jobId: active.id,
        analysis: this.getConversationSuggestionAnalysis(groupId),
      };
    }
    this.releaseTriageContextWaitMessages(groupId);
    this.database
      .prepare("DELETE FROM triage_context_waits WHERE group_id = ?")
      .run(groupId);
    const candidates = this.listTriageCandidates(500)
      .filter((candidate) => candidate.group.id === groupId)
      .slice(0, 50);
    if (!candidates.length) {
      throw new ConflictError("Não há novas mensagens externas para analisar");
    }
    const jobId = this.enqueueTriageAiJob(candidates, {
      model: input.model ?? settings.model,
      promptVersion: input.promptVersion,
    });
    return {
      accepted: Boolean(jobId),
      jobId,
      analysis: this.getConversationSuggestionAnalysis(groupId),
    };
  }

  enqueueTriageAiJob(
    candidates: TriageCandidate[],
    input: { model: string; promptVersion: string },
  ): string | null {
    if (!candidates.length || candidates.length > 50) {
      throw new ValidationError("Job de triagem exige de 1 a 50 mensagens");
    }
    const groupId = candidates[0]!.group.id;
    if (candidates.some((candidate) => candidate.group.id !== groupId)) {
      throw new ValidationError("Job de triagem deve conter uma única conversa");
    }
    const uniqueMessageIds = [...new Set(candidates.map((candidate) => candidate.id))];
    if (uniqueMessageIds.length !== candidates.length) {
      throw new ValidationError("Job de triagem recebeu mensagens duplicadas");
    }
    const model = normalizedText(input.model, "Modelo de triagem");
    const promptVersion = normalizedText(
      input.promptVersion,
      "Versão do prompt de triagem",
    );
    const analysisInput = this.buildTriageAnalysisInput(candidates);
    const timestamp = nowUtc();

    return this.database.transaction(() => {
      const activeConversationJob = this.database
        .prepare(
          `SELECT job.id
           FROM triage_ai_jobs job
           WHERE job.group_id = ?
             AND job.state IN ('queued', 'running')
             AND EXISTS (
               SELECT 1 FROM triage_ai_job_messages membership
               WHERE membership.job_id = job.id AND membership.active = 1
             )
           ORDER BY CASE job.state WHEN 'running' THEN 0 ELSE 1 END,
                    job.requested_at, job.id
           LIMIT 1`,
        )
        .get(groupId) as { id: string } | undefined;
      if (activeConversationJob) return null;

      const placeholders = uniqueMessageIds.map(() => "?").join(", ");
      const eligible = this.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM messages message
           JOIN whatsapp_groups conversation ON conversation.id = message.group_id
           JOIN clients client ON client.id = conversation.client_id
           LEFT JOIN staff_members staff
             ON staff.participant_id = message.sender_id AND staff.active = 1
           WHERE message.id IN (${placeholders})
             AND message.group_id = ?
             AND message.triage_state = 'unreviewed'
             AND message.message_type NOT IN ('reactionMessage', 'protocolMessage')
             AND staff.participant_id IS NULL
             AND client.ignored_at IS NULL
             AND conversation.suggestions_muted_at IS NULL
             AND NOT EXISTS (
               SELECT 1
               FROM audio_transcriptions transcription
               JOIN messages audio_message
                 ON audio_message.id = transcription.message_id
               WHERE audio_message.group_id = message.group_id
                 AND transcription.source = 'realtime'
                 AND transcription.status <> 'completed'
             )
             AND NOT EXISTS (
               SELECT 1 FROM triage_ai_job_messages active_job_message
               WHERE active_job_message.message_id = message.id
                 AND active_job_message.active = 1
             )`,
        )
        .get(...uniqueMessageIds, groupId) as { count: number };
      if (eligible.count !== uniqueMessageIds.length) return null;

      const generation = this.database
        .prepare(
          `SELECT COUNT(DISTINCT job_id) AS count
           FROM triage_ai_job_messages
           WHERE message_id IN (${placeholders})`,
        )
        .get(...uniqueMessageIds) as { count: number };
      const fingerprint = createHash("sha256")
        .update(
          `${promptVersion}\0${groupId}\0${generation.count}\0${uniqueMessageIds.join("\0")}`,
        )
        .digest("hex");

      const repeated = this.database
        .prepare("SELECT id FROM triage_ai_jobs WHERE fingerprint = ?")
        .get(fingerprint) as { id: string } | undefined;
      if (repeated) return repeated.id;

      const id = randomUUID();
      this.database
        .prepare(
          `INSERT INTO triage_ai_jobs
            (id, fingerprint, group_id, state, model, prompt_version,
             input_json, requested_at, created_at, updated_at)
           VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          fingerprint,
          groupId,
          model,
          promptVersion,
          JSON.stringify(analysisInput),
          timestamp,
          timestamp,
          timestamp,
        );
      const membership = this.database.prepare(
        `INSERT INTO triage_ai_job_messages
          (job_id, message_id, position, active, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`,
      );
      uniqueMessageIds.forEach((messageId, position) => {
        membership.run(id, messageId, position, timestamp, timestamp);
      });
      return id;
    })();
  }

  getTriageAiJobInput(jobId: string): TriageAnalysisInput {
    const row = this.database
      .prepare("SELECT input_json FROM triage_ai_jobs WHERE id = ?")
      .get(jobId) as { input_json: string } | undefined;
    if (!row) throw new NotFoundError("Job de triagem", jobId);
    const input = parseJson<TriageAnalysisInput>(row.input_json, {
      accountName: "Contexto não identificado",
      accountType: "unknown",
      groupName: "Conversa",
      knownEcommerces: [],
      directoryContext: [],
      categoryCatalog: this.getAnalysisCategoryCatalog(),
      candidateMessageIds: [],
      messages: [],
      openTickets: [],
      pendingSuggestions: [],
    });
    return {
      ...input,
      categoryCatalog:
        input.categoryCatalog ?? this.getAnalysisCategoryCatalog(),
    };
  }

  getTriageAiJobCandidates(jobId: string): TriageCandidate[] {
    const ids = (
      this.database
        .prepare(
          `SELECT message_id
           FROM triage_ai_job_messages
           WHERE job_id = ?
           ORDER BY position, message_id`,
        )
        .all(jobId) as Array<{ message_id: string }>
    ).map((row) => row.message_id);
    if (!ids.length) return [];
    return this.loadTriageCandidatesByIds(ids);
  }

  requeueTriageAiJob(jobId: string, error: string): void {
    const timestamp = nowUtc();
    const result = this.database
      .prepare(
        `UPDATE triage_ai_jobs
         SET state = 'queued', error = ?, claimed_at = NULL,
             lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND state = 'running'`,
      )
      .run(error.slice(0, 16_000), timestamp, jobId);
    if (!result.changes) throw new NotFoundError("Job de triagem em execução", jobId);
  }

  isTriageAiJobObsolete(jobId: string): boolean {
    const row = this.database
      .prepare(
        `SELECT job.state,
                EXISTS (
                  SELECT 1 FROM triage_ai_job_messages membership
                  WHERE membership.job_id = job.id AND membership.active = 1
                ) AS has_active_messages
         FROM triage_ai_jobs job
         WHERE job.id = ?`,
      )
      .get(jobId) as
      | { state: "queued" | "running" | "completed" | "failed"; has_active_messages: number }
      | undefined;
    return !row || row.state !== "running" || !row.has_active_messages;
  }

  recoverRunningTriageAiJobs(): number {
    const timestamp = nowUtc();
    return this.database
      .prepare(
        `UPDATE triage_ai_jobs
         SET state = 'queued', error = 'Recuperado após reinício do worker',
             claimed_at = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE state = 'running'`,
      )
      .run(timestamp).changes;
  }

  completeTriageAiJob(
    jobId: string,
    analysis: TriageAnalysis,
    options: { fallbackUsed?: boolean; error?: string | null } = {},
  ): number {
    return this.database.transaction(() => {
      const job = this.database
        .prepare(
          `SELECT id, group_id, state, model, prompt_version, input_json
           FROM triage_ai_jobs WHERE id = ?`,
        )
        .get(jobId) as
        | {
            id: string;
            group_id: string;
            state: "queued" | "running" | "completed" | "failed";
            model: string;
            prompt_version: string;
            input_json: string;
          }
        | undefined;
      if (!job) throw new NotFoundError("Job de triagem", jobId);
      if (job.state === "completed") return 0;
      if (job.state !== "running") {
        throw new ValidationError(
          `Job de triagem não pode concluir a partir do estado ${job.state}`,
        );
      }

      const jobMessages = (
        this.database
          .prepare(
            `SELECT message_id, active
             FROM triage_ai_job_messages
             WHERE job_id = ?
             ORDER BY position, message_id`,
          )
          .all(jobId) as Array<{ message_id: string; active: number }>
      );
      const candidateIds = jobMessages.map((row) => row.message_id);
      const timestamp = nowUtc();
      const analysisInput = parseJson<TriageAnalysisInput>(job.input_json, {
        accountName: "Contexto não identificado",
        accountType: "unknown",
        groupName: "Conversa",
        knownEcommerces: [],
        directoryContext: [],
        categoryCatalog: this.getAnalysisCategoryCatalog(),
        candidateMessageIds: candidateIds,
        messages: [],
        openTickets: [],
        pendingSuggestions: [],
      });
      assertTriageAnalysisCoverage(analysisInput, analysis);
      if (
        !candidateIds.length ||
        jobMessages.some((message) => !message.active)
      ) {
        this.database
          .prepare(
            `UPDATE triage_ai_job_messages
             SET active = 0, updated_at = ? WHERE job_id = ?`,
          )
          .run(timestamp, jobId);
        this.database
          .prepare(
            `UPDATE triage_ai_jobs
             SET state = 'completed', result_json = ?,
                 error = 'Resultado obsoleto: mensagens restauradas ou alteradas pelo operador',
                 fallback_used = ?, finished_at = ?, claimed_at = NULL,
                 lease_expires_at = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            JSON.stringify(analysis),
            options.fallbackUsed ? 1 : 0,
            timestamp,
            timestamp,
            jobId,
        );
        return 0;
      }
      const placeholders = candidateIds.map(() => "?").join(", ");
      const eligible = this.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM messages message
           JOIN whatsapp_groups conversation ON conversation.id = message.group_id
           JOIN clients client ON client.id = conversation.client_id
           LEFT JOIN staff_members staff
             ON staff.participant_id = message.sender_id AND staff.active = 1
           WHERE message.id IN (${placeholders})
             AND message.group_id = ?
             AND message.triage_state = 'unreviewed'
             AND message.message_type NOT IN ('reactionMessage', 'protocolMessage')
             AND staff.participant_id IS NULL
             AND client.ignored_at IS NULL
             AND conversation.suggestions_muted_at IS NULL`,
        )
        .get(...candidateIds, job.group_id) as { count: number };
      if (eligible.count !== candidateIds.length) {
        this.database
          .prepare(
            `UPDATE triage_ai_job_messages
             SET active = 0, updated_at = ? WHERE job_id = ?`,
          )
          .run(timestamp, jobId);
        this.database
          .prepare(
            `UPDATE triage_ai_jobs
             SET state = 'completed', result_json = ?,
                 error = 'Resultado obsoleto: a conversa mudou durante a análise',
                 fallback_used = ?, finished_at = ?, claimed_at = NULL,
                 lease_expires_at = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            JSON.stringify(analysis),
            options.fallbackUsed ? 1 : 0,
            timestamp,
            timestamp,
            jobId,
          );
        return 0;
      }

      const invalidRelatedSuggestion = analysis.groups.find(
        (decision) =>
          decision.relatedSuggestionId &&
          !this.validPendingSuggestionId(
            job.group_id,
            decision.relatedSuggestionId,
          ),
      );
      if (invalidRelatedSuggestion) {
        this.database
          .prepare(
            `UPDATE triage_ai_job_messages
             SET active = 0, updated_at = ? WHERE job_id = ?`,
          )
          .run(timestamp, jobId);
        this.database
          .prepare(
            `UPDATE triage_ai_jobs
             SET state = 'completed', result_json = ?,
                 error = 'Resultado obsoleto: a sugestão relacionada não está mais pendente',
                 fallback_used = ?, finished_at = ?, claimed_at = NULL,
                 lease_expires_at = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            JSON.stringify(analysis),
            options.fallbackUsed ? 1 : 0,
            timestamp,
            timestamp,
            jobId,
          );
        return 0;
      }

      let appliedBlocks = 0;
      const waitingMessageIds: string[] = [];
      const waitingReasons: string[] = [];
      for (const decision of analysis.groups) {
        if (decision.suggestedAction === "wait") {
          waitingMessageIds.push(...decision.messageIds);
          waitingReasons.push(decision.reason);
          continue;
        }
        let normalizedCategories =
          decision.suggestedAction === "ignore"
            ? emptyTriageCategories()
            : normalizeAnalysisCategories(
                decision.categories,
                this.getAnalysisCategoryCatalog(),
              );
        const affectedStoreId = decision.affectedEcommerce
          ? this.findMentionedStoreId(
              this.clientIdForConversation(job.group_id),
              decision.affectedEcommerce,
            )
          : null;
        const relatedSuggestion = this.pendingSuggestionRouting(
          job.group_id,
          decision.relatedSuggestionId,
        );
        if (relatedSuggestion && decision.suggestedAction !== "ignore") {
          normalizedCategories = mergeTriageCategories(
            normalizedCategories,
            relatedSuggestion.proposedCategories,
          );
        }
        const suggestedTicketId = decision.suggestedAction === "attach"
          ? this.validSuggestedTicketId(
              job.group_id,
              decision.relatedTicketId ??
                relatedSuggestion?.suggestedTicketId ??
                null,
            )
          : null;
        const action =
          decision.suggestedAction === "attach" && !suggestedTicketId
            ? "create"
            : decision.suggestedAction;
        const relatedSuggestionId = relatedSuggestion?.id ?? null;
        let blockId: string | null = null;
        for (const [position, messageId] of decision.messageIds.entries()) {
          const block = this.recordTriageSuggestion(messageId, {
            kind: decision.kind,
            suggestedAction: action,
            suggestedTicketId,
            title: decision.title,
            summary: decision.summary,
            affectedStoreId,
            confidence: decision.confidence,
            actor: options.fallbackUsed ? "triage-fallback" : "Agente de IA",
            reason: options.fallbackUsed ? "local_fallback" : "ai_semantic",
            suggestionGroupId: position
              ? blockId ?? undefined
              : relatedSuggestionId ?? undefined,
            forceNewBlock: position === 0 && !relatedSuggestionId,
          });
          blockId = block.id;
        }
        if (!blockId) continue;
        const contextMessageIds = this.addAiContextMessagesToTriageBlock(
          job.group_id,
          blockId,
          decision.contextMessageIds ?? [],
          timestamp,
        );
        this.database
          .prepare(
            `UPDATE triage_blocks
             SET title = ?, summary = ?, confidence = ?, reason = ?,
                 affected_store_id = COALESCE(?, affected_store_id),
                 proposed_categories_json = ?, ai_model = ?,
                 ai_prompt_version = ?, triage_ai_job_id = ?,
                 ai_fallback_used = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            decision.title,
            decision.summary,
            decision.confidence,
            options.fallbackUsed ? "local_fallback" : decision.reason,
            affectedStoreId,
            JSON.stringify(normalizedCategories),
            job.model,
            job.prompt_version,
            jobId,
            options.fallbackUsed ? 1 : 0,
            timestamp,
            blockId,
          );
        if (relatedSuggestionId) {
          this.insertTriageBlockEvent({
            blockId,
            eventType: "suggestion_updated",
            actor: options.fallbackUsed ? "triage-fallback" : "Agente de IA",
            messageIds: decision.messageIds,
            data: { triageAiJobId: jobId },
            occurredAt: timestamp,
          });
        }
        const shouldAutoAttach =
          !options.fallbackUsed &&
          action === "attach" &&
          Boolean(suggestedTicketId) &&
          !relatedSuggestionId &&
          decision.confidence >= 0.95 &&
          !triageDecisionHasExplicitTopicSwitch(decision, analysisInput);
        if (shouldAutoAttach && suggestedTicketId) {
          this.attachConversationMessages(job.group_id, {
            messageIds: [...decision.messageIds, ...contextMessageIds],
            ticketId: suggestedTicketId,
            clientRequestId: `ai-auto-attach:${jobId}:${blockId}`,
            actor: "Agente de IA",
            reason: "Vínculo semântico automático de alta confiança",
          });
        }
        appliedBlocks += 1;
      }

      const previousWait = this.database
        .prepare(
          `SELECT message_ids_json, reason
           FROM triage_context_waits WHERE group_id = ?`,
        )
        .get(job.group_id) as
        | { message_ids_json: string; reason: string }
        | undefined;
      const currentCandidateIds = new Set(candidateIds);
      const activeWaitingMessage = this.database.prepare(
        `SELECT 1
         FROM messages message
         WHERE message.id = ? AND message.triage_state = 'unreviewed'
           AND EXISTS (
             SELECT 1 FROM triage_ai_job_messages membership
             WHERE membership.message_id = message.id AND membership.active = 1
           )`,
      );
      const previousWaitingMessageIds = parseJson<string[]>(
        previousWait?.message_ids_json ?? null,
        [],
      );
      const retainedWaitingMessageIds = previousWaitingMessageIds.filter(
        (messageId) =>
          !currentCandidateIds.has(messageId) &&
          Boolean(activeWaitingMessage.get(messageId)),
      );
      const uniqueWaitingMessageIds = [
        ...new Set([...retainedWaitingMessageIds, ...waitingMessageIds]),
      ];
      const waitStateChanged =
        waitingMessageIds.length > 0 ||
        retainedWaitingMessageIds.length !== previousWaitingMessageIds.length;

      if (uniqueWaitingMessageIds.length && waitStateChanged) {
        const reasons = [
          retainedWaitingMessageIds.length ? previousWait?.reason : null,
          ...waitingReasons,
        ].filter((reason): reason is string => Boolean(reason));
        this.database
          .prepare(
            `INSERT INTO triage_context_waits
              (group_id, message_ids_json, reason, model, prompt_version,
               created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(group_id) DO UPDATE SET
               message_ids_json = excluded.message_ids_json,
               reason = excluded.reason,
               model = excluded.model,
               prompt_version = excluded.prompt_version,
               updated_at = excluded.updated_at`,
          )
          .run(
            job.group_id,
            JSON.stringify(uniqueWaitingMessageIds),
            reasons.join("\n").slice(0, 4_000),
            job.model,
            job.prompt_version,
            timestamp,
            timestamp,
          );
      } else if (!uniqueWaitingMessageIds.length) {
        this.database
          .prepare("DELETE FROM triage_context_waits WHERE group_id = ?")
          .run(job.group_id);
      }

      this.database
        .prepare(
          `UPDATE triage_ai_jobs
           SET state = 'completed', result_json = ?, error = ?,
               fallback_used = ?, finished_at = ?, claimed_at = NULL,
               lease_expires_at = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          JSON.stringify(analysis),
          options.error?.slice(0, 16_000) ?? null,
          options.fallbackUsed ? 1 : 0,
          timestamp,
          timestamp,
          jobId,
        );
      return appliedBlocks;
    })();
  }

  private addAiContextMessagesToTriageBlock(
    groupId: string,
    blockId: string,
    requestedMessageIds: readonly string[],
    timestamp: string,
  ): string[] {
    const messageIds = [
      ...new Set(requestedMessageIds.map((id) => id.trim()).filter(Boolean)),
    ];
    if (!messageIds.length) return [];

    const accepted: string[] = [];
    const loadMessage = this.database.prepare(
      `SELECT message.id, message.group_id, message.occurred_at,
              CASE WHEN staff.participant_id IS NULL THEN 0 ELSE 1 END AS is_staff
       FROM messages message
       LEFT JOIN staff_members staff
         ON staff.participant_id = message.sender_id AND staff.active = 1
       WHERE message.id = ?`,
    );
    const linkedTicket = this.database.prepare(
      "SELECT 1 FROM ticket_messages WHERE message_id = ? LIMIT 1",
    );
    const activeBlock = this.database.prepare(
      `SELECT block_id FROM triage_block_messages
       WHERE message_id = ? AND active = 1`,
    );
    const insertMembership = this.database.prepare(
      `INSERT INTO triage_block_messages
        (block_id, message_id, active, added_at, updated_at)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(block_id, message_id) DO UPDATE SET
         active = 1, updated_at = excluded.updated_at`,
    );

    for (const messageId of messageIds) {
      const message = loadMessage.get(messageId) as
        | {
            id: string;
            group_id: string;
            occurred_at: string;
            is_staff: number;
          }
        | undefined;
      if (
        !message ||
        message.group_id !== groupId ||
        !message.is_staff ||
        linkedTicket.get(messageId)
      ) {
        continue;
      }
      const currentBlock = activeBlock.get(messageId) as
        | { block_id: string }
        | undefined;
      if (currentBlock && currentBlock.block_id !== blockId) continue;
      insertMembership.run(blockId, messageId, timestamp, timestamp);
      accepted.push(messageId);
    }

    if (!accepted.length) return [];
    this.database
      .prepare(
        `UPDATE triage_blocks
         SET first_message_at = (
               SELECT MIN(message.occurred_at)
               FROM triage_block_messages membership
               JOIN messages message ON message.id = membership.message_id
               WHERE membership.block_id = ? AND membership.active = 1
             ),
             last_message_at = (
               SELECT MAX(message.occurred_at)
               FROM triage_block_messages membership
               JOIN messages message ON message.id = membership.message_id
               WHERE membership.block_id = ? AND membership.active = 1
             ),
             updated_at = ?
         WHERE id = ?`,
      )
      .run(blockId, blockId, timestamp, blockId);
    this.insertTriageBlockEvent({
      blockId,
      eventType: "ai_context_messages_grouped",
      actor: "Agente de IA",
      messageIds: accepted,
      data: { role: "staff_context" },
      occurredAt: timestamp,
    });
    return accepted;
  }

  private getTicketDirectoryContext(ticketId: string): TicketDirectoryContextDto {
    const directorySchemaAvailable = Boolean(
      this.database
        .prepare(
          `SELECT 1
           FROM sqlite_master
           WHERE type = 'table' AND name = 'ticket_record_links'`,
        )
        .get(),
    );
    if (!directorySchemaAvailable) {
      return { records: [], explicitRecordIds: [] };
    }
    const rows = this.database
      .prepare(
        `WITH ticket_requester AS (
           SELECT requester.external_jid
           FROM ticket_messages ticket_message
           JOIN messages message ON message.id = ticket_message.message_id
           JOIN participants requester ON requester.id = message.sender_id
           LEFT JOIN staff_members staff
             ON staff.participant_id = requester.id AND staff.active = 1
           WHERE ticket_message.ticket_id = ?
             AND staff.participant_id IS NULL
           ORDER BY message.occurred_at, message.id
           LIMIT 1
         ), requester_aliases(external_jid) AS (
           SELECT external_jid FROM ticket_requester
           UNION
           SELECT identity_link.phone_jid
           FROM ticket_requester requester
           JOIN whatsapp_identity_links identity_link
             ON identity_link.phone_jid = requester.external_jid
             OR identity_link.lid_jid = requester.external_jid
           UNION
           SELECT identity_link.lid_jid
           FROM ticket_requester requester
           JOIN whatsapp_identity_links identity_link
             ON identity_link.phone_jid = requester.external_jid
             OR identity_link.lid_jid = requester.external_jid
         ), linked_records(record_id, source) AS (
           SELECT ticket_link.record_id, 'ticket'
           FROM ticket_record_links ticket_link
           WHERE ticket_link.ticket_id = ?
             AND ticket_link.archived_at IS NULL
           UNION ALL
           SELECT group_link.record_id, 'group'
           FROM tickets ticket
           JOIN directory_group_links group_link
             ON group_link.group_id = ticket.group_id
            AND group_link.archived_at IS NULL
           WHERE ticket.id = ?
           UNION ALL
           SELECT person_link.record_id, 'requester'
           FROM requester_aliases requester_alias
           JOIN participants requester
             ON requester.external_jid = requester_alias.external_jid
           JOIN directory_person_links person_link
             ON person_link.participant_id = requester.id
            AND person_link.archived_at IS NULL
         )
         SELECT record.id, record.name, record.description,
                record_type.id AS type_id,
                record_type.name AS type_name,
                record_type.plural_name AS type_plural_name,
                record_type.slug AS type_slug,
                record_type.icon AS type_icon,
                record_type.color AS type_color,
                linked.source
         FROM linked_records linked
         JOIN directory_records record
           ON record.id = linked.record_id
          AND record.archived_at IS NULL
         JOIN directory_record_types record_type
           ON record_type.id = record.record_type_id
          AND record_type.archived_at IS NULL
         ORDER BY record_type.name COLLATE NOCASE,
                  record.name COLLATE NOCASE,
                  record.id,
                  CASE linked.source
                    WHEN 'ticket' THEN 0
                    WHEN 'group' THEN 1
                    ELSE 2
                  END`,
      )
      .all(ticketId, ticketId, ticketId) as Array<{
      id: string;
      name: string;
      description: string | null;
      type_id: string;
      type_name: string;
      type_plural_name: string;
      type_slug: string;
      type_icon: string | null;
      type_color: string | null;
      source: TicketDirectoryContextSource;
    }>;

    const records = new Map<
      string,
      TicketDirectoryContextRecordDto & {
        sourceSet: Set<TicketDirectoryContextSource>;
      }
    >();
    for (const row of rows) {
      const current = records.get(row.id) ?? {
        id: row.id,
        name: row.name,
        description: row.description,
        type: {
          id: row.type_id,
          name: row.type_name,
          pluralName: row.type_plural_name,
          slug: row.type_slug,
          icon: row.type_icon,
          color: row.type_color,
        },
        fields: [],
        sources: [],
        sourceSet: new Set<TicketDirectoryContextSource>(),
      };
      current.sourceSet.add(row.source);
      records.set(row.id, current);
    }

    const recordIds = [...records.keys()];
    if (recordIds.length) {
      const placeholders = recordIds.map(() => "?").join(", ");
      const recordNames = new Map(
        (this.database
          .prepare("SELECT id, name FROM directory_records")
          .all() as Array<{ id: string; name: string }>).map((record) => [
          record.id,
          record.name,
        ]),
      );
      const fields = this.database
        .prepare(
          `SELECT field_value.record_id,
                  field.id, field.key, field.label, field.field_type AS type,
                  field_value.value_json
           FROM directory_field_values field_value
           JOIN directory_field_definitions field
             ON field.id = field_value.field_id
            AND field.archived_at IS NULL
           WHERE field_value.record_id IN (${placeholders})
           ORDER BY field_value.record_id, field.position, field.label, field.id`,
        )
        .all(...recordIds) as Array<{
        record_id: string;
        id: string;
        key: string;
        label: string;
        type: DirectoryFieldType;
        value_json: string;
      }>;
      for (const field of fields) {
        const value = parseJson<unknown>(field.value_json, undefined);
        if (!isDirectoryFieldValue(value)) continue;
        records.get(field.record_id)?.fields.push({
          id: field.id,
          key: field.key,
          label: field.label,
          type: field.type,
          value,
          displayValue: directoryFieldDisplayValue(
            value,
            field.type,
            recordNames,
          ),
        });
      }
    }

    const sourceOrder: TicketDirectoryContextSource[] = [
      "ticket",
      "group",
      "requester",
    ];
    const mappedRecords = [...records.values()].map((record) => {
      const { sourceSet, ...mapped } = record;
      return {
        ...mapped,
        sources: sourceOrder.filter((source) => sourceSet.has(source)),
      };
    });
    return {
      records: mappedRecords,
      explicitRecordIds: mappedRecords
        .filter((record) => record.sources.includes("ticket"))
        .map((record) => record.id)
        .toSorted(),
    };
  }

  private getDirectoryAnalysisContext(
    groupId: string,
    ticketId?: string,
  ): DirectoryAnalysisRecord[] {
    if (ticketId) {
      return this.getTicketDirectoryContext(ticketId).records.map((record) => ({
        id: record.id,
        type: record.type.name,
        name: record.name,
        fields: record.fields.map((field) => ({
          label: field.label,
          value: field.value,
        })),
      }));
    }
    const rows = this.database
      .prepare(
        `SELECT record.id,
                record_type.name AS type_name,
                record.name,
                field.label AS field_label,
                field_value.value_json
         FROM directory_group_links group_link
         JOIN directory_records record
           ON record.id = group_link.record_id
          AND record.archived_at IS NULL
         JOIN directory_record_types record_type
           ON record_type.id = record.record_type_id
          AND record_type.archived_at IS NULL
         LEFT JOIN directory_field_values field_value
           ON field_value.record_id = record.id
         LEFT JOIN directory_field_definitions field
           ON field.id = field_value.field_id
          AND field.archived_at IS NULL
         WHERE group_link.group_id = ?
           AND group_link.archived_at IS NULL
         ORDER BY record_type.name, record.name, field.position, field.label
         LIMIT 1_500`,
      )
      .all(groupId) as Array<{
      id: string;
      type_name: string;
      name: string;
      field_label: string | null;
      value_json: string | null;
    }>;
    const records = new Map<string, DirectoryAnalysisRecord>();
    for (const row of rows) {
      if (!records.has(row.id)) {
        if (records.size >= 30) continue;
        records.set(row.id, {
          id: row.id,
          type: row.type_name,
          name: row.name,
          fields: [],
        });
      }
      if (!row.field_label || row.value_json === null) continue;
      const value = parseJson<unknown>(row.value_json, null);
      if (
        value !== null &&
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean" &&
        !(
          Array.isArray(value) &&
          value.every((item): item is string => typeof item === "string")
        )
      ) {
        continue;
      }
      const record = records.get(row.id);
      if (record && record.fields.length < 50) {
        record.fields.push({ label: row.field_label, value });
      }
    }
    return [...records.values()];
  }

  private buildTriageAnalysisInput(
    candidates: TriageCandidate[],
  ): TriageAnalysisInput {
    const first = candidates[0]!;
    const knownEcommerces = (
      this.database
        .prepare(
          `SELECT name FROM client_stores
           WHERE client_id = ? AND active = 1 ORDER BY name`,
        )
        .all(first.client.id) as Array<{ name: string }>
    ).map((row) => row.name);
    const openTickets = this.database
      .prepare(
        `SELECT id, title, summary, status
         FROM tickets
         WHERE group_id = ?
           AND status NOT IN ('resolved', 'archived')
           AND merged_into_ticket_id IS NULL
         ORDER BY last_message_at DESC
         LIMIT 30`,
      )
      .all(first.group.id) as TriageAnalysisInput["openTickets"];
    const pendingSuggestions = this.database
      .prepare(
        `SELECT id, title, summary,
                suggested_action AS suggestedAction,
                suggested_ticket_id AS suggestedTicketId,
                last_message_at AS lastMessageAt
         FROM triage_blocks
         WHERE group_id = ? AND state = 'pending'
         ORDER BY last_message_at DESC, id
         LIMIT 30`,
      )
      .all(first.group.id) as TriageAnalysisInput["pendingSuggestions"];
    return {
      accountName: first.client.name,
      accountType: first.client.kind,
      groupName: first.group.subject,
      knownEcommerces,
      directoryContext: this.getDirectoryAnalysisContext(first.group.id),
      categoryCatalog: this.getAnalysisCategoryCatalog(),
      candidateMessageIds: candidates.map((candidate) => candidate.id),
      messages: this.buildTriageAnalysisMessages(candidates),
      openTickets,
      pendingSuggestions,
    };
  }

  private buildTriageAnalysisMessages(
    candidates: TriageCandidate[],
  ): TriageAnalysisInput["messages"] {
    const orderedCandidates = candidates.toSorted(
      (left, right) =>
        left.occurredAt.localeCompare(right.occurredAt) ||
        left.id.localeCompare(right.id),
    );
    const candidateIds = orderedCandidates.map((candidate) => candidate.id);
    const selectedIds = new Set(candidateIds);
    let remaining = Math.max(0, 70 - selectedIds.size);
    const addContext = (rows: Array<{ id: string }>) => {
      for (const row of rows) {
        if (!remaining) break;
        if (selectedIds.has(row.id)) continue;
        selectedIds.add(row.id);
        remaining -= 1;
      }
    };
    const groupId = orderedCandidates[0]!.group.id;
    const meaningfulMessage =
      "message_type NOT IN ('reactionMessage', 'protocolMessage')";

    const quotedReferences = [
      ...new Set(
        orderedCandidates
          .map((candidate) => candidate.quotedExternalId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    if (remaining && quotedReferences.length) {
      const placeholders = quotedReferences.map(() => "?").join(", ");
      addContext(
        this.database
          .prepare(
            `SELECT id FROM messages
             WHERE group_id = ? AND ${meaningfulMessage}
               AND (provider_message_id IN (${placeholders})
                 OR external_id IN (${placeholders}))
             ORDER BY occurred_at, id`,
          )
          .all(groupId, ...quotedReferences, ...quotedReferences) as Array<{
          id: string;
        }>,
      );
    }

    if (remaining) {
      addContext(
        this.database
          .prepare(
            `SELECT message.id
             FROM triage_blocks block
             JOIN triage_block_messages membership
               ON membership.block_id = block.id AND membership.active = 1
             JOIN messages message ON message.id = membership.message_id
             WHERE block.group_id = ? AND block.state = 'pending'
               AND ${meaningfulMessage.replaceAll("message_type", "message.message_type")}
             ORDER BY message.occurred_at DESC, message.id DESC
             LIMIT ?`,
          )
          .all(groupId, remaining) as Array<{ id: string }>,
      );
    }

    const first = orderedCandidates[0]!;
    const last = orderedCandidates.at(-1)!;
    if (remaining) {
      addContext(
        this.database
          .prepare(
            `SELECT id FROM messages
             WHERE group_id = ? AND ${meaningfulMessage}
               AND (occurred_at > ? OR (occurred_at = ? AND id >= ?))
               AND (occurred_at < ? OR (occurred_at = ? AND id <= ?))
             ORDER BY occurred_at, id
             LIMIT ?`,
          )
          .all(
            groupId,
            first.occurredAt,
            first.occurredAt,
            first.id,
            last.occurredAt,
            last.occurredAt,
            last.id,
            remaining + candidateIds.length,
          ) as Array<{ id: string }>,
      );
    }

    if (remaining) {
      const windowStart = new Date(
        new Date(first.occurredAt).getTime() - 30 * 60_000,
      ).toISOString();
      const windowEnd = new Date(
        new Date(last.occurredAt).getTime() + 30 * 60_000,
      ).toISOString();
      const before = this.database
        .prepare(
          `SELECT id FROM messages
           WHERE group_id = ? AND ${meaningfulMessage}
             AND occurred_at >= ?
             AND (occurred_at < ? OR (occurred_at = ? AND id < ?))
           ORDER BY occurred_at DESC, id DESC LIMIT ?`,
        )
        .all(
          groupId,
          windowStart,
          first.occurredAt,
          first.occurredAt,
          first.id,
          remaining,
        ) as Array<{ id: string }>;
      const after = this.database
        .prepare(
          `SELECT id FROM messages
           WHERE group_id = ? AND ${meaningfulMessage}
             AND occurred_at <= ?
             AND (occurred_at > ? OR (occurred_at = ? AND id > ?))
           ORDER BY occurred_at, id LIMIT ?`,
        )
        .all(
          groupId,
          windowEnd,
          last.occurredAt,
          last.occurredAt,
          last.id,
          remaining,
        ) as Array<{ id: string }>;
      const adjacent: Array<{ id: string }> = [];
      const adjacentCount = Math.max(before.length, after.length);
      for (let index = 0; index < adjacentCount; index += 1) {
        if (before[index]) adjacent.push(before[index]!);
        if (after[index]) adjacent.push(after[index]!);
      }
      addContext(adjacent);
    }

    const ids = [...selectedIds];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.database
      .prepare(
        `SELECT message.id, message.external_id, message.provider_message_id,
                message.occurred_at, message.text, message.quoted_external_id,
                participant.external_jid, participant.display_name,
                CASE
                  WHEN participant.external_jid LIKE 'self:%' THEN 'self'
                  WHEN staff.participant_id IS NOT NULL THEN 'staff'
                  ELSE 'external'
                END AS role
         FROM messages message
         JOIN participants participant ON participant.id = message.sender_id
         LEFT JOIN staff_members staff
           ON staff.participant_id = participant.id AND staff.active = 1
         WHERE message.group_id = ? AND message.id IN (${placeholders})
         ORDER BY message.occurred_at, message.id`,
      )
      .all(groupId, ...ids) as Array<{
      id: string;
      external_id: string;
      provider_message_id: string | null;
      occurred_at: string;
      text: string | null;
      quoted_external_id: string | null;
      external_jid: string;
      display_name: string;
      role: "external" | "staff" | "self";
    }>;
    const references = new Map<string, string>();
    for (const row of rows) {
      references.set(row.external_id, row.id);
      if (row.provider_message_id) references.set(row.provider_message_id, row.id);
    }
    const attachments = this.database.prepare(
      `SELECT kind, file_name, mime_type, local_path, extracted_text
       FROM attachments WHERE message_id = ? ORDER BY created_at, id`,
    );
    return rows.map((row) => ({
      id: row.id,
      author: row.display_name,
      role: row.role,
      timestampUtc: row.occurred_at,
      text: row.text,
      quotedMessageId: row.quoted_external_id
        ? references.get(row.quoted_external_id) ?? row.quoted_external_id
        : null,
      attachments: (attachments.all(row.id) as Array<{
        kind: AttachmentDto["kind"];
        file_name: string | null;
        mime_type: string;
        local_path: string;
        extracted_text: string | null;
      }>).map((attachment) => ({
        kind: analysisAttachmentKind(attachment.kind),
        fileName: attachment.file_name,
        mimeType: attachment.mime_type,
        localPath: attachment.local_path,
        extractedText: attachment.extracted_text,
      })),
    }));
  }

  private loadTriageCandidatesByIds(messageIds: string[]): TriageCandidate[] {
    const all = new Map(
      this.listTriageCandidates(500).map((candidate) => [candidate.id, candidate]),
    );
    return messageIds.flatMap((messageId) => {
      const candidate = all.get(messageId);
      if (candidate) return [candidate];
      const input = this.getTriageAiInputCandidate(messageId);
      return input ? [input] : [];
    });
  }

  private getTriageAiInputCandidate(messageId: string): TriageCandidate | null {
    const job = this.database
      .prepare(
        `SELECT input_json
         FROM triage_ai_jobs job
         JOIN triage_ai_job_messages link ON link.job_id = job.id
         WHERE link.message_id = ?
         ORDER BY job.requested_at DESC LIMIT 1`,
      )
      .get(messageId) as { input_json: string } | undefined;
    if (!job) return null;
    const input = parseJson<TriageAnalysisInput | null>(job.input_json, null);
    const message = input?.messages.find((item) => item.id === messageId);
    if (!input || !message) return null;
    const group = this.database
      .prepare(
        `SELECT conversation.id, conversation.external_jid, conversation.subject,
                client.id AS client_id, client.name, client.kind
         FROM whatsapp_groups conversation
         JOIN clients client ON client.id = conversation.client_id
         JOIN messages source ON source.group_id = conversation.id
         WHERE source.id = ?`,
      )
      .get(messageId) as
      | {
          id: string;
          external_jid: string;
          subject: string;
          client_id: string;
          name: string;
          kind: ClientKind;
        }
      | undefined;
    const sender = this.database
      .prepare(
        `SELECT participant.id, participant.display_name, participant.phone_e164
         FROM participants participant
         JOIN messages source ON source.sender_id = participant.id
         WHERE source.id = ?`,
      )
      .get(messageId) as
      | { id: string; display_name: string; phone_e164: string | null }
      | undefined;
    if (!group || !sender) return null;
    return {
      id: message.id,
      externalId: message.id,
      quotedExternalId: message.quotedMessageId,
      occurredAt: message.timestampUtc,
      text: message.text,
      messageType: "conversation",
      triageKind: "unclassified",
      group: {
        id: group.id,
        externalJid: group.external_jid,
        subject: group.subject,
      },
      client: { id: group.client_id, name: group.name, kind: group.kind },
      sender: {
        id: sender.id,
        displayName: sender.display_name,
        phoneE164: sender.phone_e164,
        isStaff: false,
      },
      attachments: [],
    };
  }

  private clientIdForConversation(groupId: string): string {
    const row = this.database
      .prepare("SELECT client_id FROM whatsapp_groups WHERE id = ?")
      .get(groupId) as { client_id: string } | undefined;
    if (!row) throw new NotFoundError("Conversa", groupId);
    return row.client_id;
  }

  private validSuggestedTicketId(
    groupId: string,
    ticketId: string | null,
  ): string | null {
    if (!ticketId) return null;
    const row = this.database
      .prepare(
        `SELECT id FROM tickets
         WHERE id = ? AND group_id = ?
           AND status NOT IN ('resolved', 'archived')
           AND merged_into_ticket_id IS NULL`,
      )
      .get(ticketId, groupId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  private validPendingSuggestionId(
    groupId: string,
    suggestionId: string | null,
  ): string | null {
    if (!suggestionId) return null;
    const row = this.database
      .prepare(
        `SELECT id FROM triage_blocks
         WHERE id = ? AND group_id = ? AND state = 'pending'`,
      )
      .get(suggestionId, groupId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  private pendingSuggestionRouting(
    groupId: string,
    suggestionId: string | null,
  ): {
    id: string;
    suggestedTicketId: string | null;
    proposedCategories: TriageBlockDto["proposedCategories"];
  } | null {
    if (!suggestionId) return null;
    const row = this.database
      .prepare(
        `SELECT id, suggested_ticket_id, proposed_categories_json
         FROM triage_blocks
         WHERE id = ? AND group_id = ? AND state = 'pending'`,
      )
      .get(suggestionId, groupId) as
      | {
          id: string;
          suggested_ticket_id: string | null;
          proposed_categories_json: string | null;
        }
      | undefined;
    return row
      ? {
          id: row.id,
          suggestedTicketId: row.suggested_ticket_id,
          proposedCategories: parseJson(
            row.proposed_categories_json,
            emptyTriageCategories(),
          ),
        }
      : null;
  }

  findRecentPendingTriageSuggestion(input: {
    groupId: string;
    senderId: string;
    sinceAt: string;
  }): {
    suggestionGroupId: string;
    occurredAt: string;
    routingText: string;
  } | null {
    const row = this.database
      .prepare(
        `SELECT block.id, block.last_message_at,
                COALESCE((
                  SELECT group_concat(text, char(10))
                  FROM (
                    SELECT message.text AS text
                    FROM triage_block_messages block_message
                    JOIN messages message ON message.id = block_message.message_id
                    WHERE block_message.block_id = block.id
                      AND block_message.active = 1
                      AND message.text IS NOT NULL
                      AND trim(message.text) <> ''
                    ORDER BY message.occurred_at, message.id
                  )
                ), '') AS routing_text
         FROM triage_blocks block
         WHERE block.group_id = ?
           AND block.sender_id = ?
           AND block.state = 'pending'
           AND block.last_message_at >= ?
           AND EXISTS (
             SELECT 1 FROM triage_block_messages active_message
             WHERE active_message.block_id = block.id AND active_message.active = 1
           )
         ORDER BY block.last_message_at DESC, block.id
         LIMIT 1`,
      )
      .get(input.groupId, input.senderId, input.sinceAt) as
      | { id: string; last_message_at: string; routing_text: string }
      | undefined;
    return row
      ? {
          suggestionGroupId: row.id,
          occurredAt: row.last_message_at,
          routingText: row.routing_text,
        }
      : null;
  }

  recordTriageSuggestion(
    messageId: string,
    input: RecordTriageSuggestionInput,
  ): TriageBlockDto {
    return this.database.transaction(() => {
      const message = this.database
        .prepare(
          `SELECT m.id, m.group_id, m.sender_id, m.occurred_at,
                  g.suggestions_muted_at,
                  CASE WHEN staff.participant_id IS NULL THEN 0 ELSE 1 END AS is_staff
           FROM messages m
           JOIN whatsapp_groups g ON g.id = m.group_id
           LEFT JOIN staff_members staff
             ON staff.participant_id = m.sender_id AND staff.active = 1
           WHERE m.id = ?`,
        )
        .get(messageId) as
        | {
            id: string;
            group_id: string;
            sender_id: string;
            occurred_at: string;
            suggestions_muted_at: string | null;
            is_staff: number;
          }
        | undefined;
      if (!message) throw new NotFoundError("Mensagem", messageId);
      if (message.is_staff) {
        throw new ValidationError(
          "Mensagem de funcionário permanece como contexto e não recebe sugestão de triagem",
        );
      }
      if (message.suggestions_muted_at) {
        const timestamp = nowUtc();
        this.database
          .prepare(
            `UPDATE messages
             SET triage_kind = 'context', triage_state = 'context', updated_at = ?
             WHERE id = ? AND triage_state = 'unreviewed'`,
          )
          .run(timestamp, messageId);
        const messages = this.loadConversationActionMessages(
          message.group_id,
          [messageId],
        );
        return this.createConversationActionBlock({
          groupId: message.group_id,
          messages,
          state: "context",
          action: "context",
          requestKey: null,
          actor: normalizedNullableText(input.actor) ?? "triage",
          reason: "conversation_suggestions_muted",
          title: "Mensagem mantida como contexto",
          summary: this.deriveConversationActionSummary(messages),
        });
      }

      const confidence = clampConfidence(input.confidence) as number;
      const actor = normalizedNullableText(input.actor) ?? "triage";
      const title = normalizedNullableText(input.title) ?? "Demanda em revisão";
      const summary = normalizedNullableText(input.summary) ?? title;
      const reason = normalizedText(input.reason, "Motivo da sugestão");
      const suggestedTicketId = input.suggestedTicketId ?? null;
      if (suggestedTicketId) {
        const target = this.database
          .prepare("SELECT group_id FROM tickets WHERE id = ?")
          .get(suggestedTicketId) as { group_id: string } | undefined;
        if (!target) throw new NotFoundError("Ticket sugerido", suggestedTicketId);
        if (target.group_id !== message.group_id) {
          throw new ValidationError(
            "O ticket sugerido pertence a outra conversa",
            { messageId, suggestedTicketId },
          );
        }
      }
      if (input.affectedStoreId) {
        const validStore = this.database
          .prepare(
            `SELECT 1
             FROM client_stores store
             JOIN whatsapp_groups conversation ON conversation.client_id = store.client_id
             WHERE store.id = ? AND store.active = 1 AND conversation.id = ?`,
          )
          .get(input.affectedStoreId, message.group_id);
        if (!validStore) throw new NotFoundError("Loja afetada", input.affectedStoreId);
      }

      const alreadyActive = this.database
        .prepare(
          `SELECT block.*
           FROM triage_block_messages block_message
           JOIN triage_blocks block ON block.id = block_message.block_id
           WHERE block_message.message_id = ?
             AND block_message.active = 1
             AND block.state = 'pending'
           LIMIT 1`,
        )
        .get(messageId) as TriageBlockRow | undefined;
      let block = alreadyActive;

      if (!block && input.suggestionGroupId) {
        block = this.database
          .prepare(
            `SELECT * FROM triage_blocks
             WHERE id = ? AND group_id = ?
               AND (
                 state = 'pending'
                 OR (
                   state = 'ignored'
                   AND origin = 'suggestion'
                   AND suggested_action = 'ignore'
                 )
               )`,
          )
          .get(input.suggestionGroupId, message.group_id) as
          | TriageBlockRow
          | undefined;
        if (!block) {
          throw new ValidationError(
            "Bloco de sugestão não está pendente para esta conversa",
            { suggestionGroupId: input.suggestionGroupId },
          );
        }
      }

      if (!block && !input.forceNewBlock) {
        const sinceAt = new Date(
          new Date(message.occurred_at).getTime() - 2 * 60_000,
        ).toISOString();
        block = this.database
          .prepare(
            `SELECT * FROM triage_blocks
             WHERE group_id = ? AND sender_id = ? AND state = 'pending'
               AND last_message_at >= ? AND last_message_at <= ?
             ORDER BY last_message_at DESC, id
             LIMIT 1`,
          )
          .get(
            message.group_id,
            message.sender_id,
            sinceAt,
            message.occurred_at,
          ) as TriageBlockRow | undefined;

        if (!block && input.suggestedAction !== "ignore") {
          block = this.database
            .prepare(
              `SELECT * FROM triage_blocks
               WHERE group_id = ? AND sender_id = ? AND state = 'ignored'
                 AND origin = 'suggestion'
                 AND suggested_action = 'ignore'
                 AND triage_kind IN ('social', 'information')
                 AND last_message_at >= ? AND last_message_at <= ?
               ORDER BY last_message_at DESC, id
               LIMIT 1`,
            )
            .get(
              message.group_id,
              message.sender_id,
              sinceAt,
              message.occurred_at,
            ) as TriageBlockRow | undefined;
          if (block) {
            const promotedAt = nowUtc();
            this.database
              .prepare(
                `UPDATE triage_blocks
                 SET state = 'pending', resolved_at = NULL, updated_at = ?
                 WHERE id = ?`,
              )
              .run(promotedAt, block.id);
            this.database
              .prepare(
                `UPDATE triage_block_messages
                 SET active = 1, updated_at = ? WHERE block_id = ?`,
              )
              .run(promotedAt, block.id);
            this.database
              .prepare(
                `UPDATE messages
                 SET triage_state = 'unreviewed', updated_at = ?
                 WHERE id IN (
                   SELECT message_id FROM triage_block_messages WHERE block_id = ?
                 )`,
              )
              .run(promotedAt, block.id);
            this.insertTriageBlockEvent({
              blockId: block.id,
              eventType: "social_context_promoted",
              actor,
              messageIds: [messageId],
              occurredAt: promotedAt,
            });
          }
        }

      }

      const timestamp = nowUtc();
      if (!block) {
        const id = input.suggestionGroupId ?? randomUUID();
        this.database
          .prepare(
            `INSERT INTO triage_blocks
              (id, group_id, sender_id, state, triage_kind, suggested_action,
               suggested_ticket_id, affected_store_id, title, summary, confidence,
               reason, origin, created_by, first_message_at, last_message_at,
               created_at, updated_at)
             VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, 'suggestion', ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            message.group_id,
            message.sender_id,
            input.kind,
            input.suggestedAction,
            suggestedTicketId,
            input.affectedStoreId ?? null,
            title,
            summary,
            confidence,
            reason,
            actor,
            message.occurred_at,
            message.occurred_at,
            timestamp,
            timestamp,
          );
        block = this.database
          .prepare("SELECT * FROM triage_blocks WHERE id = ?")
          .get(id) as TriageBlockRow;
      }

      this.database
        .prepare(
          `INSERT INTO triage_block_messages
            (block_id, message_id, active, added_at, updated_at)
           VALUES (?, ?, 1, ?, ?)
           ON CONFLICT(block_id, message_id) DO UPDATE SET
             active = 1,
             updated_at = excluded.updated_at`,
        )
        .run(block.id, messageId, timestamp, timestamp);

      const replacesSuggestion =
        triageActionRank(input.suggestedAction) >
        triageActionRank(block.suggested_action);
      const kind =
        triageKindRank(input.kind) > triageKindRank(block.triage_kind)
          ? input.kind
          : block.triage_kind;
      const combinedSummary = this.database
        .prepare(
          `SELECT group_concat(text, char(10)) AS summary
           FROM (
             SELECT message.text AS text
             FROM triage_block_messages block_message
             JOIN messages message ON message.id = block_message.message_id
             WHERE block_message.block_id = ?
               AND block_message.active = 1
               AND message.text IS NOT NULL
               AND trim(message.text) <> ''
             ORDER BY message.occurred_at, message.id
           )`,
        )
        .get(block.id) as { summary: string | null };
      this.database
        .prepare(
          `UPDATE triage_blocks SET
             triage_kind = ?,
             suggested_action = CASE WHEN ? THEN ? ELSE suggested_action END,
             suggested_ticket_id = CASE WHEN ? THEN ? ELSE suggested_ticket_id END,
             affected_store_id = COALESCE(affected_store_id, ?),
             title = CASE WHEN ? OR title = '' THEN ? ELSE title END,
             summary = ?,
             confidence = CASE
               WHEN confidence IS NULL OR confidence < ? THEN ? ELSE confidence
             END,
             reason = CASE WHEN ? THEN ? ELSE reason END,
             first_message_at = CASE WHEN first_message_at > ? THEN ? ELSE first_message_at END,
             last_message_at = CASE WHEN last_message_at < ? THEN ? ELSE last_message_at END,
             updated_at = ?
           WHERE id = ?`,
        )
        .run(
          kind,
          replacesSuggestion ? 1 : 0,
          input.suggestedAction,
          replacesSuggestion ? 1 : 0,
          suggestedTicketId,
          input.affectedStoreId ?? null,
          replacesSuggestion ? 1 : 0,
          title,
          combinedSummary.summary ?? summary,
          confidence,
          confidence,
          replacesSuggestion ? 1 : 0,
          reason,
          message.occurred_at,
          message.occurred_at,
          message.occurred_at,
          message.occurred_at,
          timestamp,
          block.id,
        );
      const finalBlock = this.database
        .prepare("SELECT * FROM triage_blocks WHERE id = ?")
        .get(block.id) as TriageBlockRow;
      const autoResolvedIgnore =
        finalBlock.suggested_action === "ignore" &&
        (finalBlock.triage_kind === "social" ||
          finalBlock.triage_kind === "information");
      if (autoResolvedIgnore) {
        this.database
          .prepare(
            `UPDATE triage_blocks
             SET state = 'ignored', resolved_at = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(timestamp, timestamp, block.id);
        this.database
          .prepare(
            `UPDATE triage_block_messages
             SET active = 0, updated_at = ? WHERE block_id = ?`,
          )
          .run(timestamp, block.id);
        this.database
          .prepare(
            `UPDATE messages
             SET triage_kind = ?, triage_state = 'ignored', updated_at = ?
             WHERE id = ?`,
          )
          .run(input.kind, timestamp, messageId);
      } else {
        this.database
          .prepare(
            `UPDATE messages
             SET triage_kind = ?, triage_state = 'unreviewed', updated_at = ?
             WHERE id = ?`,
          )
          .run(input.kind, timestamp, messageId);
      }
      this.insertTriageBlockEvent({
        blockId: block.id,
        eventType: "suggestion_recorded",
        actor,
        messageIds: [messageId],
        data: {
          kind: input.kind,
          suggestedAction: input.suggestedAction,
          suggestedTicketId,
          confidence,
          reason,
        },
        occurredAt: timestamp,
      });
      return this.getTriageBlock(block.id);
    })();
  }

  collapseTriageMessage(
    messageId: string,
    input: {
      kind: "social" | "information";
      reason: string;
      actor?: string;
    },
  ): TriageBlockDto {
    const message = this.database
      .prepare("SELECT text FROM messages WHERE id = ?")
      .get(messageId) as { text: string | null } | undefined;
    if (!message) throw new NotFoundError("Mensagem", messageId);
    const text = normalizedNullableText(message.text) ?? "Mensagem sem demanda de suporte";
    return this.recordTriageSuggestion(messageId, {
      kind: input.kind,
      suggestedAction: "ignore",
      suggestedTicketId: null,
      title: input.kind === "social" ? "Interação social" : "Informação",
      summary: text,
      confidence: 1,
      reason: input.reason,
      affectedStoreId: null,
      actor: input.actor ?? "triage",
    });
  }

  markMessageTriage(
    messageId: string,
    input: { kind: TriageKind; state: TriageState },
  ): void {
    const message = this.getMessageContext(messageId);
    if (message.isStaff && (input.kind !== "context" || input.state !== "context")) {
      throw new ValidationError("Mensagem de funcionário deve permanecer como contexto");
    }
    if (input.state === "ticketed") {
      const linked = this.database
        .prepare("SELECT 1 FROM ticket_messages WHERE message_id = ? LIMIT 1")
        .get(messageId);
      if (!linked) {
        throw new ValidationError(
          "Uma mensagem só pode ser marcada como ticketed após ser vinculada a um ticket",
        );
      }
    }
    this.database
      .prepare(
        `UPDATE messages SET triage_kind = ?, triage_state = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(input.kind, input.state, nowUtc(), messageId);
  }

  findRecentOpenTicket(
    groupId: string,
    sinceAt?: string,
  ): TicketSummaryDto | null {
    this.assertEntityExists("Grupo", "whatsapp_groups", groupId);
    const row = this.database
      .prepare(
        `${this.ticketSelect()}
         WHERE t.group_id = ?
           AND t.status NOT IN ('resolved', 'archived')
           AND (? IS NULL OR t.last_message_at >= ?)
         ORDER BY t.last_message_at DESC, t.updated_at DESC
         LIMIT 1`,
      )
      .get(groupId, sinceAt ?? null, sinceAt ?? null) as TicketSummaryRow | undefined;
    return row ? this.mapTicketSummary(row) : null;
  }

  findMentionedStoreId(clientId: string, text: string | null): string | null {
    this.assertEntityExists("Cliente", "clients", clientId);
    const normalizedMessage = normalizedRoutingText(text);
    if (!normalizedMessage) return null;

    const stores = this.database
      .prepare(
        `SELECT id, name, business_id
         FROM client_stores
         WHERE client_id = ? AND active = 1
         ORDER BY name, id`,
      )
      .all(clientId) as Array<{
      id: string;
      name: string;
      business_id: string | null;
    }>;
    const matches = stores.filter((store) =>
      [store.name, store.business_id]
        .filter((value): value is string => Boolean(value))
        .map(normalizedRoutingText)
        .some((identifier) => containsRoutingPhrase(normalizedMessage, identifier)),
    );
    return matches.length === 1 ? matches[0]!.id : null;
  }

  findQuotedTicketReference(
    groupId: string,
    quotedProviderMessageId: string,
  ): QuotedTicketReference | null {
    this.assertEntityExists("Grupo", "whatsapp_groups", groupId);
    const rows = this.database
      .prepare(
        `SELECT DISTINCT t.id, t.status, t.last_message_at
         FROM messages quoted
         JOIN ticket_messages tm ON tm.message_id = quoted.id
         JOIN tickets t ON t.id = tm.ticket_id
         WHERE quoted.group_id = ?
           AND quoted.provider_message_id = ?
         ORDER BY t.last_message_at DESC, t.id
         LIMIT 3`,
      )
      .all(groupId, quotedProviderMessageId) as Array<{
      id: string;
      status: TicketStatus;
      last_message_at: string;
    }>;
    const openRows = rows.filter(
      (row) => row.status !== "resolved" && row.status !== "archived",
    );
    if (openRows.length === 1) {
      return { id: openRows[0]!.id, status: openRows[0]!.status };
    }
    if (openRows.length > 1 || rows.length !== 1) return null;
    return { id: rows[0]!.id, status: rows[0]!.status };
  }

  listTopicTicketCandidates(
    groupId: string,
    sinceAt: string,
    untilAt: string,
  ): TopicTicketCandidate[] {
    this.assertEntityExists("Grupo", "whatsapp_groups", groupId);
    const rows = this.database
      .prepare(
        `SELECT id, status, last_message_at, affected_store_id, title, summary
         FROM tickets
         WHERE group_id = ?
           AND status NOT IN ('resolved', 'archived')
           AND last_message_at >= ?
           AND last_message_at <= ?
         ORDER BY last_message_at DESC, updated_at DESC, id
         LIMIT 30`,
      )
      .all(groupId, sinceAt, untilAt) as Array<{
      id: string;
      status: TicketStatus;
      last_message_at: string;
      affected_store_id: string | null;
      title: string;
      summary: string;
    }>;
    const recentExternalMessages = this.database.prepare(
      `SELECT m.sender_id, m.text
       FROM ticket_messages tm
       JOIN messages m ON m.id = tm.message_id
       LEFT JOIN staff_members staff
         ON staff.participant_id = m.sender_id AND staff.active = 1
       WHERE tm.ticket_id = ?
         AND m.occurred_at <= ?
         AND staff.participant_id IS NULL
       ORDER BY m.occurred_at DESC, m.rowid DESC
       LIMIT 8`,
    );

    return rows.map((row) => {
      const messages = recentExternalMessages.all(row.id, untilAt) as Array<{
        sender_id: string;
        text: string | null;
      }>;
      return {
        id: row.id,
        status: row.status,
        lastMessageAt: row.last_message_at,
        lastSenderId: messages[0]?.sender_id ?? null,
        affectedStoreId: row.affected_store_id,
        topicText: [
          row.title,
          row.summary,
          ...messages.toReversed().map((message) => message.text),
        ]
          .filter((value): value is string => Boolean(value?.trim()))
          .join("\n"),
      };
    });
  }

  addSuggestion(input: {
    id?: string;
    ticketId: string;
    body: string;
    confidence: number;
    evidence?: SuggestionDto["evidence"];
    missingInformation?: string[];
    status?: SuggestionDto["status"];
    model?: string | null;
    promptVersion?: string | null;
    createdAt?: string;
  }): SuggestionDto {
    this.assertEntityExists("Ticket", "tickets", input.ticketId);
    const id = input.id ?? randomUUID();
    const timestamp = input.createdAt ?? nowUtc();
    this.database
      .prepare(
        `INSERT INTO suggestions
         (id, ticket_id, body, confidence, evidence_json,
           missing_information_json, status, model, prompt_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          body = excluded.body,
          confidence = excluded.confidence,
          evidence_json = excluded.evidence_json,
          missing_information_json = excluded.missing_information_json,
          status = excluded.status,
          model = excluded.model,
          prompt_version = excluded.prompt_version,
          updated_at = excluded.updated_at`,
      )
      .run(
        id,
        input.ticketId,
        normalizedText(input.body, "Texto da sugestão"),
        clampConfidence(input.confidence),
        JSON.stringify(input.evidence ?? []),
        JSON.stringify(input.missingInformation ?? []),
        input.status ?? "candidate",
        input.model ?? null,
        input.promptVersion ?? null,
        timestamp,
        timestamp,
      );
    return this.getSuggestion(id);
  }

  recordSentResponse(input: {
    id?: string;
    ticketId: string;
    messageId?: string | null;
    body: string;
    sentAt: string;
    capturedAt?: string;
  }): SentResponseDto {
    this.assertEntityExists("Ticket", "tickets", input.ticketId);
    if (input.messageId) {
      this.assertEntityExists("Mensagem", "messages", input.messageId);
    }
    const id = input.id ?? randomUUID();
    const capturedAt = input.capturedAt ?? nowUtc();
    this.database
      .prepare(
        `INSERT INTO sent_responses
          (id, ticket_id, message_id, body, sent_at, captured_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(ticket_id, message_id) DO UPDATE SET
          body = excluded.body,
          sent_at = excluded.sent_at,
          captured_at = excluded.captured_at`,
      )
      .run(
        id,
        input.ticketId,
        input.messageId ?? null,
        normalizedText(input.body, "Resposta enviada"),
        input.sentAt,
        capturedAt,
      );
    const row = this.database
      .prepare(
        `SELECT id, body, message_id, sent_at, captured_at
         FROM sent_responses
         WHERE ticket_id = ? AND ((message_id = ?) OR (message_id IS NULL AND id = ?))`,
      )
      .get(input.ticketId, input.messageId ?? null, id) as {
      id: string;
      body: string;
      message_id: string | null;
      sent_at: string;
      captured_at: string;
    };
    return this.mapSentResponse(row);
  }

  recordResolution(input: {
    ticketId: string;
    summary: string;
    rootCause?: string | null;
    outcome?: string | null;
    validatedBy: string;
    validatedAt?: string;
  }): ResolutionDto {
    return this.database.transaction(() => {
      this.assertEntityExists("Ticket", "tickets", input.ticketId);
      const id = randomUUID();
      const timestamp = input.validatedAt ?? nowUtc();
      const summary = normalizedText(input.summary, "Resumo da resolução");
      const rootCause = normalizedNullableText(input.rootCause);
      const outcome = normalizedNullableText(input.outcome);
      const validatedBy = normalizedText(
        input.validatedBy,
        "Responsável pela validação",
      );
      this.database
        .prepare(
          `INSERT INTO resolutions
            (id, ticket_id, summary, root_cause, outcome, validated_by,
             validated_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(ticket_id) DO UPDATE SET
            summary = excluded.summary,
            root_cause = excluded.root_cause,
            outcome = excluded.outcome,
            validated_by = excluded.validated_by,
            validated_at = excluded.validated_at,
            updated_at = excluded.updated_at`,
        )
        .run(
          id,
          input.ticketId,
          summary,
          rootCause,
          outcome,
          validatedBy,
          timestamp,
          timestamp,
          timestamp,
        );

      return this.getResolution(input.ticketId) as ResolutionDto;
    })();
  }

  updateTicketStatus(ticketId: string, input: UpdateTicketStatusInput): TicketDetailDto {
    return this.database.transaction(() => {
      const ticket = this.database
        .prepare("SELECT id, status FROM tickets WHERE id = ?")
        .get(ticketId) as TicketStatusRow | undefined;
      if (!ticket) {
        throw new NotFoundError("Ticket", ticketId);
      }

      assertStatusTransition(ticket.status, input.status);
      if (ticket.status === input.status) {
        if (input.resolution) {
          this.recordResolution({
            ticketId,
            summary: input.resolution.summary,
            rootCause: input.resolution.rootCause,
            outcome: input.resolution.outcome,
            validatedBy: input.resolution.validatedBy ?? input.actor ?? "Operador local",
          });
        }
        if (isTerminalTicketStatus(input.status)) {
          this.closeAutomaticInvestigationLifecycle(
            ticketId,
            nowUtc(),
            `Ticket ${input.status === "resolved" ? "resolvido" : "arquivado"}; investigação automática cancelada.`,
          );
        }
        return this.getTicketDetail(ticketId);
      }
      const existingResolution =
        input.status === "resolved" && !input.resolution
          ? this.getResolution(ticketId)
          : null;
      if (input.status === "resolved" && !input.resolution && !existingResolution) {
        throw new ValidationError(
          "Informe um resumo da resolução antes de concluir o ticket",
        );
      }

      const timestamp = nowUtc();
      this.database
        .prepare(
          `UPDATE tickets SET
            status = ?,
            needs_review = CASE WHEN ? IN ('triage', 'new') THEN needs_review ELSE 0 END,
            resolved_at = CASE
              WHEN ? = 'resolved' THEN COALESCE(resolved_at, ?)
              WHEN ? = 'archived' THEN resolved_at
              ELSE NULL
            END,
            archived_at = CASE WHEN ? = 'archived' THEN ? WHEN status = 'archived' THEN NULL ELSE archived_at END,
            updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.status,
          input.status,
          input.status,
          timestamp,
          input.status,
          input.status,
          timestamp,
          timestamp,
          ticketId,
        );

      if (input.resolution) {
        this.recordResolution({
          ticketId,
          summary: input.resolution.summary,
          rootCause: input.resolution.rootCause,
          outcome: input.resolution.outcome,
          validatedBy: input.resolution.validatedBy ?? input.actor ?? "Operador local",
          validatedAt: timestamp,
        });
      }

      if (isTerminalTicketStatus(input.status)) {
        this.closeAutomaticInvestigationLifecycle(
          ticketId,
          timestamp,
          `Ticket ${input.status === "resolved" ? "resolvido" : "arquivado"}; investigação automática cancelada.`,
        );
      }

      this.insertTicketEvent({
        ticketId,
        eventType: "status_changed",
        actor: input.actor ?? "Operador local",
        fromStatus: ticket.status,
        toStatus: input.status,
        data: input.reason ? { reason: input.reason } : {},
        occurredAt: timestamp,
      });

      return this.getTicketDetail(ticketId);
    })();
  }

  updateTicketStatusesInBulk(
    input: TicketBulkStatusInput,
  ): TicketBulkStatusResponse {
    if (input.status !== "archived" && input.status !== "resolved") {
      throw new ValidationError("Status em lote inválido", {
        status: input.status,
        allowed: ["archived", "resolved"],
      });
    }
    if (!input.ticketIds.length) {
      throw new ValidationError("Selecione ao menos um ticket");
    }
    if (input.ticketIds.length > 500) {
      throw new ValidationError("Selecione no máximo 500 tickets por operação", {
        maximum: 500,
      });
    }
    const ticketIds = input.ticketIds.map((ticketId) =>
      normalizedBoundedText(ticketId, "ID do ticket", 200),
    );
    const seen = new Set<string>();
    const duplicateIds = new Set<string>();
    for (const ticketId of ticketIds) {
      if (seen.has(ticketId)) duplicateIds.add(ticketId);
      seen.add(ticketId);
    }
    if (duplicateIds.size) {
      throw new ValidationError("A seleção contém tickets duplicados", {
        duplicateIds: [...duplicateIds],
      });
    }

    return this.database.transaction(() => {
      const placeholders = ticketIds.map(() => "?").join(", ");
      const rows = this.database
        .prepare(
          `SELECT id, status, resolved_at, archived_at
           FROM tickets
           WHERE id IN (${placeholders})`,
        )
        .all(...ticketIds) as Array<{
        id: string;
        status: TicketStatus;
        resolved_at: string | null;
        archived_at: string | null;
      }>;
      const byId = new Map(rows.map((row) => [row.id, row]));
      const missingIds = ticketIds.filter((ticketId) => !byId.has(ticketId));
      if (missingIds.length) {
        throw new ValidationError("Um ou mais tickets não foram encontrados", {
          missingIds,
        });
      }

      const action: TicketBulkStatusResponse["action"] =
        input.status === "archived" ? "archive" : "restore";
      const requiredStatus: TicketStatus =
        action === "archive" ? "resolved" : "archived";
      const incompatible = ticketIds
        .map((ticketId) => byId.get(ticketId) as (typeof rows)[number])
        .filter((ticket) => ticket.status !== requiredStatus)
        .map((ticket) => ({ ticketId: ticket.id, status: ticket.status }));
      if (incompatible.length) {
        throw new ConflictError(
          action === "archive"
            ? "Somente tickets resolvidos podem ser arquivados em lote"
            : "Somente tickets arquivados podem ser restaurados em lote",
          { action, requiredStatus, incompatible },
        );
      }

      const timestamp = nowUtc();
      const batchId = randomUUID();
      const actor = normalizedBoundedText(
        input.actor ?? "Operador local",
        "Responsável",
        200,
      );
      const reason = input.reason
        ? normalizedBoundedText(input.reason, "Motivo", 1_000)
        : null;
      const update = this.database.prepare(
        action === "archive"
          ? `UPDATE tickets
             SET status = 'archived', archived_at = ?, updated_at = ?
             WHERE id = ?`
          : `UPDATE tickets
             SET status = 'resolved', archived_at = NULL,
                 resolved_at = COALESCE(resolved_at, ?), updated_at = ?
             WHERE id = ?`,
      );

      for (const ticketId of ticketIds) {
        update.run(timestamp, timestamp, ticketId);
        this.closeAutomaticInvestigationLifecycle(
          ticketId,
          timestamp,
          `Ticket ${input.status === "resolved" ? "resolvido" : "arquivado"}; investigação automática cancelada.`,
        );
        this.insertTicketEvent({
          ticketId,
          eventType: "status_changed",
          actor,
          fromStatus: requiredStatus,
          toStatus: input.status,
          data: {
            batchId,
            batchAction: action,
            batchSize: ticketIds.length,
            ...(reason ? { reason } : {}),
            description:
              action === "archive"
                ? `Ticket arquivado em lote por ${actor}.`
                : `Ticket restaurado em lote para Resolvido por ${actor}.`,
          },
          occurredAt: timestamp,
        });
      }

      const ticketSummary = this.database.prepare(
        `${this.ticketSelect()} WHERE t.id = ?`,
      );
      return {
        batchId,
        action,
        changedAt: timestamp,
        tickets: ticketIds.map((ticketId) =>
          this.mapTicketSummary(ticketSummary.get(ticketId) as TicketSummaryRow),
        ),
      };
    }).immediate();
  }

  queueInvestigation(
    ticketId: string,
    instructions?: string,
    options: QueueInvestigationOptions = {},
  ): InvestigateTicketResponse {
    const ticketClient = this.database
      .prepare(
        `SELECT c.id, c.ignored_at, t.status
         FROM tickets t
         JOIN clients c ON c.id = t.client_id
         WHERE t.id = ?`,
      )
      .get(ticketId) as
      | { id: string; ignored_at: string | null; status: TicketStatus }
      | undefined;
    if (!ticketClient) throw new NotFoundError("Ticket", ticketId);
    if (ticketClient.ignored_at) {
      throw new ConflictError(
        "O cliente foi excluído da operação e não pode iniciar novas investigações",
        { clientId: ticketClient.id },
      );
    }
    if (isTerminalTicketStatus(ticketClient.status)) {
      throw new ConflictError(
        "Tickets resolvidos ou arquivados não podem iniciar uma investigação automática",
        { ticketId, status: ticketClient.status },
      );
    }
    const normalizedInstructions = instructions?.trim() || null;
    const actor = options.actor?.trim() || "Operador local";
    const trigger = options.trigger ?? "manual";
    const timestamp = nowUtc();
    const job = this.database.transaction(() => {
      if (trigger === "new_customer_message" || trigger === "context_changed") {
        this.supersedeCandidateSuggestions(ticketId, timestamp);
        this.database
          .prepare(
            `UPDATE tickets
             SET next_action = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .run(timestamp, ticketId);
      }
      const active = this.database
        .prepare(
          `SELECT id, state, instructions, rerun_requested, rerun_instructions
           FROM investigation_jobs
           WHERE ticket_id = ? AND state IN ('queued', 'running')
           ORDER BY requested_at LIMIT 1`,
        )
        .get(ticketId) as
        | {
            id: string;
            state: "queued" | "running";
            instructions: string | null;
            rerun_requested: number;
            rerun_instructions: string | null;
          }
        | undefined;

      if (active) {
        if (active.state === "queued") {
          if (
            normalizedInstructions &&
            !includesInvestigationInstruction(
              active.instructions,
              normalizedInstructions,
            )
          ) {
            this.database
              .prepare(
                `UPDATE investigation_jobs
                 SET instructions = CASE
                   WHEN instructions IS NULL OR trim(instructions) = '' THEN ?
                   ELSE instructions || char(10) || char(10) || ?
                 END
                 WHERE id = ? AND state = 'queued'`,
              )
              .run(normalizedInstructions, normalizedInstructions, active.id);
            this.insertTicketEvent({
              ticketId,
              eventType: "investigation_queue_updated",
              actor,
              fromStatus: null,
              toStatus: null,
              data: {
                jobId: active.id,
                trigger,
                instructions: normalizedInstructions,
              },
              occurredAt: timestamp,
            });
          }
          return active;
        }

        const hasInstruction = includesInvestigationInstruction(
          active.rerun_instructions,
          normalizedInstructions,
        );
        if (active.rerun_requested && hasInstruction) return active;

        this.database
          .prepare(
            `UPDATE investigation_jobs
             SET rerun_requested = 1,
                 rerun_instructions = CASE
                   WHEN ? IS NULL THEN rerun_instructions
                   WHEN rerun_instructions IS NULL OR trim(rerun_instructions) = '' THEN ?
                   ELSE rerun_instructions || char(10) || char(10) || ?
                 END
             WHERE id = ? AND state = 'running'`,
          )
          .run(
            normalizedInstructions,
            normalizedInstructions,
            normalizedInstructions,
            active.id,
          );
        this.insertTicketEvent({
          ticketId,
          eventType: "investigation_rerun_requested",
          actor: "system",
          fromStatus: null,
          toStatus: null,
          data: {
            activeJobId: active.id,
            trigger,
            instructions: normalizedInstructions,
          },
          occurredAt: timestamp,
        });
        return active;
      }

      const id = randomUUID();
      this.database
        .prepare(
          `INSERT INTO investigation_jobs
            (id, ticket_id, state, instructions, requested_at)
           VALUES (?, ?, 'queued', ?, ?)`,
        )
        .run(id, ticketId, normalizedInstructions, timestamp);
      this.insertTicketEvent({
        ticketId,
        eventType: "investigation_queued",
        actor,
        fromStatus: null,
        toStatus: null,
        data: { jobId: id, trigger, instructions: normalizedInstructions },
        occurredAt: timestamp,
      });
      return { id, state: "queued" as const };
    })();

    return { accepted: true, ticketId, jobId: job.id, state: "queued" };
  }

  markInvestigationRunning(jobId: string): void {
    this.database.transaction(() => {
      const timestamp = nowUtc();
      const job = this.database
        .prepare(
          `UPDATE investigation_jobs
           SET state = 'running', started_at = ?, error = NULL,
               attempt_count = attempt_count + 1,
               instructions = CASE
                 WHEN rerun_instructions IS NULL OR trim(rerun_instructions) = '' THEN instructions
                 WHEN instructions IS NULL OR trim(instructions) = '' THEN rerun_instructions
                 ELSE instructions || char(10) || char(10) || rerun_instructions
               END,
               rerun_requested = 0, rerun_instructions = NULL
           WHERE id = ? AND state = 'queued'
           RETURNING ticket_id, attempt_count`,
        )
        .get(timestamp, jobId) as
        | { ticket_id: string; attempt_count: number }
        | undefined;
      if (!job) {
        const existing = this.database
          .prepare("SELECT id, state FROM investigation_jobs WHERE id = ?")
          .get(jobId) as { id: string; state: string } | undefined;
        if (!existing) {
          throw new NotFoundError("Job de investigação", jobId);
        }
        throw new ValidationError(
          `Job não pode iniciar a partir do estado ${existing.state}`,
        );
      }
      this.insertTicketEvent({
        ticketId: job.ticket_id,
        eventType: "investigation_started",
        actor: "Agente de IA",
        fromStatus: null,
        toStatus: null,
        data: { jobId, jobKind: "automatic", attempt: job.attempt_count },
        occurredAt: timestamp,
      });
    })();
  }

  claimNextInvestigationJob(leaseMs = 10 * 60_000): ClaimedInvestigationJob | null {
    if (!Number.isFinite(leaseMs) || leaseMs < 1_000) {
      throw new ValidationError("Lease do job deve ser de pelo menos 1000ms");
    }
    const claimedAt = nowUtc();
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    return this.database.transaction(() => {
      const row = this.database.prepare(
        `UPDATE investigation_jobs
         SET state = 'running',
             started_at = COALESCE(started_at, ?),
             claimed_at = ?,
             lease_expires_at = ?,
             attempt_count = attempt_count + 1,
             error = NULL,
             instructions = CASE
               WHEN rerun_instructions IS NULL OR trim(rerun_instructions) = '' THEN instructions
               WHEN instructions IS NULL OR trim(instructions) = '' THEN rerun_instructions
               ELSE instructions || char(10) || char(10) || rerun_instructions
             END,
             rerun_requested = 0, rerun_instructions = NULL
         WHERE id = (
           SELECT j.id
           FROM investigation_jobs j
           JOIN tickets t ON t.id = j.ticket_id
           JOIN clients c ON c.id = t.client_id
           WHERE c.ignored_at IS NULL
             AND t.status NOT IN ('resolved', 'archived')
             AND (
               j.state = 'queued'
               OR (j.state = 'running' AND j.lease_expires_at IS NOT NULL AND j.lease_expires_at <= ?)
             )
           ORDER BY CASE j.state WHEN 'running' THEN 0 ELSE 1 END, j.requested_at
           LIMIT 1
         )
         RETURNING id, ticket_id, instructions, attempt_count`,
      ).get(claimedAt, claimedAt, leaseExpiresAt, claimedAt) as
        | {
            id: string;
            ticket_id: string;
            instructions: string | null;
            attempt_count: number;
          }
        | undefined;
      if (!row) return null;
      this.insertTicketEvent({
        ticketId: row.ticket_id,
        eventType: "investigation_started",
        actor: "Agente de IA",
        fromStatus: null,
        toStatus: null,
        data: { jobId: row.id, jobKind: "automatic", attempt: row.attempt_count },
        occurredAt: claimedAt,
      });
      return { id: row.id, ticketId: row.ticket_id, instructions: row.instructions };
    })();
  }

  recoverRunningInvestigationJobs(): number {
    const result = this.database
      .prepare(
        `UPDATE investigation_jobs
         SET state = 'queued', claimed_at = NULL, lease_expires_at = NULL,
             error = 'Recuperado após reinício do worker',
             instructions = CASE
               WHEN rerun_instructions IS NULL OR trim(rerun_instructions) = '' THEN instructions
               WHEN instructions IS NULL OR trim(instructions) = '' THEN rerun_instructions
               ELSE instructions || char(10) || char(10) || rerun_instructions
             END,
             rerun_requested = 0, rerun_instructions = NULL
         WHERE state = 'running'`,
      )
      .run();
    return result.changes;
  }

  claimNextAgentJob(leaseMs = 10 * 60_000): ClaimedAgentJob | null {
    if (!Number.isFinite(leaseMs) || leaseMs < 1_000) {
      throw new ValidationError("Lease do job deve ser de pelo menos 1000ms");
    }
    const claimedAt = nowUtc();
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();

    return this.database.transaction(() => {
      const candidate = this.database
        .prepare(
          `SELECT kind, id
           FROM (
             SELECT 'thread_turn' AS kind, j.id, j.state, j.requested_at,
                    j.lease_expires_at, 0 AS queue_priority
             FROM investigation_thread_jobs j
             JOIN investigation_threads thread ON thread.id = j.thread_id
             JOIN tickets t ON t.id = thread.ticket_id
             JOIN clients c ON c.id = t.client_id
             WHERE c.ignored_at IS NULL
               AND (
                 j.state = 'queued'
                 OR (j.state = 'running' AND j.lease_expires_at IS NOT NULL AND j.lease_expires_at <= ?)
               )
             UNION ALL
             SELECT 'triage' AS kind, job.id, job.state, job.requested_at,
                    job.lease_expires_at, 2 AS queue_priority
             FROM triage_ai_jobs job
             JOIN whatsapp_groups conversation ON conversation.id = job.group_id
             JOIN clients client ON client.id = conversation.client_id
             JOIN triage_ai_settings settings
               ON settings.singleton = 1 AND settings.enabled = 1
             WHERE client.ignored_at IS NULL
               AND conversation.suggestions_muted_at IS NULL
               AND (
                 job.state = 'queued'
                 OR (job.state = 'running' AND job.lease_expires_at IS NOT NULL AND job.lease_expires_at <= ?)
               )
           )
           ORDER BY CASE state WHEN 'running' THEN 0 ELSE 1 END,
                    queue_priority, requested_at, id
           LIMIT 1`,
        )
        .get(claimedAt, claimedAt) as
        | { kind: "thread_turn" | "triage"; id: string }
        | undefined;
      if (!candidate) return null;

      if (candidate.kind === "triage") {
        const row = this.database
          .prepare(
            `UPDATE triage_ai_jobs
             SET state = 'running', started_at = COALESCE(started_at, ?),
                 claimed_at = ?, lease_expires_at = ?,
                 attempt_count = attempt_count + 1, error = NULL,
                 updated_at = ?
             WHERE id = ?
               AND (state = 'queued'
                 OR (state = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?))
             RETURNING id, group_id, model, attempt_count`,
          )
          .get(
            claimedAt,
            claimedAt,
            leaseExpiresAt,
            claimedAt,
            candidate.id,
            claimedAt,
          ) as
          | {
              id: string;
              group_id: string;
              model: string;
              attempt_count: number;
            }
          | undefined;
        if (!row) return null;
        return {
          kind: "triage" as const,
          id: row.id,
          groupId: row.group_id,
          model: row.model,
          attemptCount: row.attempt_count,
        };
      }

      const row = this.database
        .prepare(
          `UPDATE investigation_thread_jobs
           SET state = 'running', started_at = COALESCE(started_at, ?),
               claimed_at = ?, lease_expires_at = ?,
               attempt_count = attempt_count + 1, error = NULL
           WHERE id = ?
             AND (state = 'queued'
               OR (state = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?))
           RETURNING id, thread_id, operator_message_id, attempt_count,
             (SELECT ticket_id FROM investigation_threads WHERE id = thread_id) AS ticket_id`,
        )
        .get(
          claimedAt,
          claimedAt,
          leaseExpiresAt,
          candidate.id,
          claimedAt,
        ) as
        | {
            id: string;
            thread_id: string;
            ticket_id: string;
            operator_message_id: string;
            attempt_count: number;
          }
        | undefined;
      if (!row) return null;
      this.insertTicketEvent({
        ticketId: row.ticket_id,
        eventType: "investigation_thread_turn_started",
        actor: "Agente de IA",
        fromStatus: null,
        toStatus: null,
        data: {
          threadId: row.thread_id,
          jobId: row.id,
          operatorMessageId: row.operator_message_id,
          jobKind: "thread_turn",
          attempt: row.attempt_count,
          mode: "readonly",
          sourceScope: ["code", "postgres", "clickhouse", "aws"],
        },
        occurredAt: claimedAt,
      });
      return {
        kind: "thread_turn" as const,
        id: row.id,
        threadId: row.thread_id,
        ticketId: row.ticket_id,
        operatorMessageId: row.operator_message_id,
      };
    })();
  }

  recoverRunningAgentJobs(): number {
    return this.database.transaction(() => {
      const retiredAutomatic = this.database
        .prepare(
          `UPDATE investigation_jobs
           SET state = 'failed', finished_at = ?,
               error = 'Investigação automática removida do Threadmark',
               claimed_at = NULL, lease_expires_at = NULL,
               rerun_requested = 0, rerun_instructions = NULL
           WHERE state IN ('queued', 'running')`,
        )
        .run(nowUtc()).changes;
      const conversational = this.database
        .prepare(
          `UPDATE investigation_thread_jobs
           SET state = 'queued', claimed_at = NULL, lease_expires_at = NULL,
               error = 'Recuperado após reinício do worker'
           WHERE state = 'running'`,
        )
        .run().changes;
      const triage = this.recoverRunningTriageAiJobs();
      return retiredAutomatic + conversational + triage;
    })();
  }

  getOrCreateInvestigationThread(ticketId: string): InvestigationThreadDto {
    this.assertEntityExists("Ticket", "tickets", ticketId);
    return this.database.transaction(() => {
      const timestamp = nowUtc();
      const id = randomUUID();
      const inserted = this.database
        .prepare(
          `INSERT OR IGNORE INTO investigation_threads
            (id, ticket_id, status, summary, created_at, updated_at)
           VALUES (?, ?, 'active', '', ?, ?)`,
        )
        .run(id, ticketId, timestamp, timestamp);
      const row = this.database
        .prepare("SELECT id FROM investigation_threads WHERE ticket_id = ?")
        .get(ticketId) as EntityRecord | undefined;
      if (!row) {
        throw new Error("Não foi possível localizar ou criar a sala de investigação");
      }
      if (inserted.changes > 0) {
        this.insertTicketEvent({
          ticketId,
          eventType: "investigation_thread_created",
          actor: "Operador local",
          fromStatus: null,
          toStatus: null,
          data: { threadId: row.id },
          occurredAt: timestamp,
        });
      }
      return this.getInvestigationThread(row.id);
    })();
  }

  getInvestigationThread(threadId: string): InvestigationThreadDto {
    const row = this.database
      .prepare(
        `SELECT id, ticket_id, status, summary, created_at, updated_at
         FROM investigation_threads WHERE id = ?`,
      )
      .get(threadId) as
      | {
          id: string;
          ticket_id: string;
          status: InvestigationThreadDto["status"];
          summary: string;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (!row) {
      throw new NotFoundError("Sala de investigação", threadId);
    }

    const messages = this.getInvestigationThreadMessages(threadId);
    const turns = this.getInvestigationThreadTurns(threadId);
    const activeTurn = turns.find(
      (turn) => turn.state === "queued" || turn.state === "running",
    );
    const lastAssistantMessageAt = messages.reduce<string | null>(
      (latest, message) =>
        message.role === "assistant" &&
        (!latest || message.createdAt > latest)
          ? message.createdAt
          : latest,
      null,
    );
    return {
      id: row.id,
      ticketId: row.ticket_id,
      status: row.status,
      summary: row.summary,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastAssistantMessageAt,
      activeTurnState: activeTurn?.state ?? null,
      messages,
      turns,
    };
  }

  cancelInvestigationThread(
    threadId: string,
    actor = "Operador local",
  ): CancelInvestigationThreadResult {
    const cancelledBy = normalizedText(actor, "Responsável").slice(0, 200);

    return this.database.transaction(() => {
      const thread = this.database
        .prepare("SELECT ticket_id FROM investigation_threads WHERE id = ?")
        .get(threadId) as { ticket_id: string } | undefined;
      if (!thread) {
        throw new NotFoundError("Sala de investigação", threadId);
      }

      const active = this.database
        .prepare(
          `SELECT id, state
           FROM investigation_thread_jobs
           WHERE thread_id = ? AND state IN ('queued', 'running')
           ORDER BY requested_at DESC, rowid DESC
           LIMIT 1`,
        )
        .get(threadId) as
        | { id: string; state: "queued" | "running" }
        | undefined;

      if (!active) {
        const latestTurn = this.database
          .prepare(
            `SELECT id, cancelled_at FROM investigation_thread_jobs
             WHERE thread_id = ?
             ORDER BY requested_at DESC, rowid DESC LIMIT 1`,
          )
          .get(threadId) as
          | { id: string; cancelled_at: string | null }
          | undefined;
        return {
          thread: this.getInvestigationThread(threadId),
          cancelledJobId: latestTurn?.cancelled_at ? latestTurn.id : null,
          newlyCancelled: false,
        };
      }

      const timestamp = nowUtc();
      const cancelled = this.database
        .prepare(
          `UPDATE investigation_thread_jobs
           SET state = 'failed', cancelled_at = ?, cancelled_by = ?,
               finished_at = ?, error = NULL, claimed_at = NULL,
               lease_expires_at = NULL
           WHERE id = ? AND state IN ('queued', 'running')
             AND cancelled_at IS NULL`,
        )
        .run(timestamp, cancelledBy, timestamp, active.id);

      if (!cancelled.changes) {
        return {
          thread: this.getInvestigationThread(threadId),
          cancelledJobId: null,
          newlyCancelled: false,
        };
      }

      this.database
        .prepare(
          `UPDATE investigation_threads
           SET status = 'active', updated_at = ? WHERE id = ?`,
        )
        .run(timestamp, threadId);
      this.insertTicketEvent({
        ticketId: thread.ticket_id,
        eventType: "investigation_thread_turn_cancelled",
        actor: cancelledBy,
        fromStatus: null,
        toStatus: null,
        data: {
          threadId,
          jobId: active.id,
          jobKind: "thread_turn",
          previousState: active.state,
        },
        occurredAt: timestamp,
      });

      return {
        thread: this.getInvestigationThread(threadId),
        cancelledJobId: active.id,
        newlyCancelled: true,
      };
    })();
  }

  isInvestigationThreadJobCancelled(jobId: string): boolean {
    const row = this.database
      .prepare(
        `SELECT cancelled_at FROM investigation_thread_jobs WHERE id = ?`,
      )
      .get(jobId) as { cancelled_at: string | null } | undefined;
    return Boolean(row?.cancelled_at);
  }

  addInvestigationThreadMessage(
    threadId: string,
    input: AddInvestigationThreadMessageInput,
  ): InvestigationThreadDto {
    const body = normalizedText(input.body, "Mensagem");
    if (body.length > INVESTIGATION_THREAD_MESSAGE_MAX_LENGTH) {
      throw new ValidationError(
        `Mensagem deve ter no máximo ${INVESTIGATION_THREAD_MESSAGE_MAX_LENGTH} caracteres`,
      );
    }
    const clientMessageId = normalizedNullableText(input.clientMessageId)?.slice(
      0,
      200,
    );

    return this.database.transaction(() => {
      const thread = this.database
        .prepare("SELECT id, ticket_id FROM investigation_threads WHERE id = ?")
        .get(threadId) as { id: string; ticket_id: string } | undefined;
      if (!thread) {
        throw new NotFoundError("Sala de investigação", threadId);
      }

      if (clientMessageId) {
        const duplicate = this.database
          .prepare(
            `SELECT id FROM investigation_thread_messages
             WHERE thread_id = ? AND client_message_id = ?`,
          )
          .get(threadId, clientMessageId);
        if (duplicate) return this.getInvestigationThread(threadId);
      }

      const active = this.database
        .prepare(
          `SELECT id FROM investigation_thread_jobs
           WHERE thread_id = ? AND state IN ('queued', 'running') LIMIT 1`,
        )
        .get(threadId) as EntityRecord | undefined;
      if (active) {
        throw new ConflictError(
          "Aguarde a conclusão da mensagem anterior antes de enviar outra.",
          { threadId, activeJobId: active.id },
        );
      }

      const timestamp = nowUtc();
      const messageId = randomUUID();
      const jobId = randomUUID();
      this.database
        .prepare(
          `INSERT INTO investigation_thread_messages
            (id, thread_id, role, body, client_message_id, created_at)
           VALUES (?, ?, 'operator', ?, ?, ?)`,
        )
        .run(messageId, threadId, body, clientMessageId, timestamp);
      this.database
        .prepare(
          `INSERT INTO investigation_thread_jobs
            (id, thread_id, operator_message_id, state, requested_at)
           VALUES (?, ?, ?, 'queued', ?)`,
        )
        .run(jobId, threadId, messageId, timestamp);
      this.database
        .prepare(
          `UPDATE investigation_threads
           SET status = 'active', updated_at = ? WHERE id = ?`,
        )
        .run(timestamp, threadId);
      this.insertTicketEvent({
        ticketId: thread.ticket_id,
        eventType: "investigation_thread_message_queued",
        actor: "Operador local",
        fromStatus: null,
        toStatus: null,
        data: { threadId, messageId, jobId },
        occurredAt: timestamp,
      });
      return this.getInvestigationThread(threadId);
    })();
  }

  private getSupportConversationState(
    ticketId: string,
  ): SupportAnalysisInput["conversationState"] {
    const external = this.database
      .prepare(
        `SELECT MAX(message.occurred_at) AS last_external_message_at
         FROM ticket_messages ticket_message
         JOIN messages message ON message.id = ticket_message.message_id
         LEFT JOIN staff_members staff
           ON staff.participant_id = message.sender_id AND staff.active = 1
         WHERE ticket_message.ticket_id = ?
           AND staff.participant_id IS NULL`,
      )
      .get(ticketId) as {
      last_external_message_at: string | null;
    };
    const latestResponse = this.database
      .prepare(
        `WITH response_moments AS (
           SELECT response.sent_at, message.rowid AS message_rowid,
                  response.rowid AS response_rowid
           FROM sent_responses response
           LEFT JOIN messages message ON message.id = response.message_id
           WHERE response.ticket_id = ?

           UNION ALL

           SELECT message.occurred_at AS sent_at,
                  message.rowid AS message_rowid,
                  0 AS response_rowid
           FROM ticket_messages ticket_message
           JOIN messages message ON message.id = ticket_message.message_id
           JOIN staff_members staff
             ON staff.participant_id = message.sender_id AND staff.active = 1
           WHERE ticket_message.ticket_id = ?
             AND (
               (message.text IS NOT NULL AND trim(message.text) <> '')
               OR EXISTS (
                 SELECT 1 FROM attachments attachment
                 WHERE attachment.message_id = message.id
                   AND attachment.available = 1
               )
             )
             AND NOT EXISTS (
               SELECT 1 FROM sent_responses response
               WHERE response.ticket_id = ticket_message.ticket_id
                 AND response.message_id = message.id
             )
         )
         SELECT sent_at, message_rowid
         FROM response_moments
         ORDER BY sent_at DESC,
                  CASE WHEN message_rowid IS NULL THEN 0 ELSE 1 END,
                  message_rowid DESC,
                  response_rowid DESC
         LIMIT 1`,
      )
      .get(ticketId, ticketId) as
      | {
          sent_at: string;
          message_rowid: number | null;
        }
      | undefined;
    const timestamps = {
      last_external_message_at: external.last_external_message_at,
      last_sent_response_at: latestResponse?.sent_at ?? null,
      last_sent_message_rowid: latestResponse?.message_rowid ?? null,
    };
    const unansweredExternalMessageIds = (
      this.database
        .prepare(
          `SELECT message.id
           FROM ticket_messages ticket_message
           JOIN messages message ON message.id = ticket_message.message_id
           LEFT JOIN staff_members staff
             ON staff.participant_id = message.sender_id AND staff.active = 1
           WHERE ticket_message.ticket_id = ?
             AND staff.participant_id IS NULL
             AND (
               ? IS NULL
               OR message.occurred_at > ?
               OR (
                 message.occurred_at = ?
                 AND (
                   ? IS NULL
                   OR message.rowid > ?
                 )
               )
             )
           ORDER BY message.occurred_at DESC, message.rowid DESC
           LIMIT ?`,
        )
        .all(
          ticketId,
          timestamps.last_sent_response_at,
          timestamps.last_sent_response_at,
          timestamps.last_sent_response_at,
          timestamps.last_sent_message_rowid,
          timestamps.last_sent_message_rowid,
          THREAD_PROMPT_TICKET_MESSAGE_LIMIT,
        ) as Array<{ id: string }>
    ).toReversed().map((row) => row.id);

    return {
      lastExternalMessageAt: timestamps.last_external_message_at,
      lastSentResponseAt: timestamps.last_sent_response_at,
      unansweredExternalMessageIds,
      hasUnansweredExternalMessages: unansweredExternalMessageIds.length > 0,
    };
  }

  private getSupportSentResponses(
    ticketId: string,
  ): SupportAnalysisInput["sentResponses"] {
    const rows = this.database
      .prepare(
        `SELECT id, message_id, body, sent_at
         FROM sent_responses
         WHERE ticket_id = ?
         ORDER BY sent_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(ticketId, SUPPORT_PROMPT_SENT_RESPONSE_LIMIT) as Array<{
      id: string;
      message_id: string | null;
      body: string;
      sent_at: string;
    }>;
    return rows.toReversed().map((row) => ({
      id: row.id,
      messageId: row.message_id,
      body: truncatePromptText(row.body, SUPPORT_PROMPT_MESSAGE_TEXT_LIMIT),
      sentAt: row.sent_at,
    }));
  }

  private getSupportResolvedPrecedents(
    ticketId: string,
    clientId: string,
    affectedStoreId: string | null,
  ): SupportAnalysisInput["resolvedPrecedents"] {
    const rows = this.database
      .prepare(
        `SELECT ticket.id, ticket.title, ticket.summary, ticket.resolved_at,
                ticket.affected_store_id, affected_store.name AS affected_store_name,
                resolution.summary AS resolution_summary,
                resolution.root_cause, resolution.outcome,
                resolution.validated_at,
                (SELECT response.body
                   FROM sent_responses response
                  WHERE response.ticket_id = ticket.id
                  ORDER BY response.sent_at DESC, response.rowid DESC
                  LIMIT 1) AS final_response,
                (SELECT COUNT(*)
                   FROM ticket_categories precedent_category
                  WHERE precedent_category.ticket_id = ticket.id
                    AND EXISTS (
                      SELECT 1
                      FROM ticket_categories current_category
                      WHERE current_category.ticket_id = ?
                        AND current_category.category_id = precedent_category.category_id
                    )) AS shared_category_count
         FROM tickets ticket
         JOIN resolutions resolution ON resolution.ticket_id = ticket.id
         LEFT JOIN client_stores affected_store
           ON affected_store.id = ticket.affected_store_id
         WHERE ticket.client_id = ?
           AND ticket.id <> ?
           AND ticket.status IN ('resolved', 'archived')
           AND (
             ? IS NULL
             OR ticket.affected_store_id IS NULL
             OR ticket.affected_store_id = ?
           )
         ORDER BY
                  CASE
                    WHEN ? IS NOT NULL AND ticket.affected_store_id = ? THEN 0
                    WHEN ticket.affected_store_id IS NULL THEN 1
                    ELSE 2
                  END,
                  shared_category_count DESC,
                  COALESCE(ticket.resolved_at, resolution.validated_at) DESC,
                  ticket.updated_at DESC,
                  ticket.id
         LIMIT ?`,
      )
      .all(
        ticketId,
        clientId,
        ticketId,
        affectedStoreId,
        affectedStoreId,
        affectedStoreId,
        affectedStoreId,
        SUPPORT_PROMPT_RESOLVED_PRECEDENT_LIMIT,
      ) as Array<{
      id: string;
      title: string;
      summary: string;
      resolved_at: string | null;
      affected_store_id: string | null;
      affected_store_name: string | null;
      resolution_summary: string;
      root_cause: string | null;
      outcome: string | null;
      validated_at: string;
      final_response: string | null;
      shared_category_count: number;
    }>;
    if (!rows.length) return [];

    const categories = this.database.prepare(
      `SELECT category.label
       FROM ticket_categories ticket_category
       JOIN categories category ON category.id = ticket_category.category_id
       WHERE ticket_category.ticket_id = ?
       ORDER BY category.facet, category.label`,
    );
    return rows.map((row) => ({
      ticketId: row.id,
      title: truncatePromptText(row.title, 500),
      summary: truncatePromptText(row.summary, 2_000),
      resolvedAt: row.resolved_at,
      affectedStore: row.affected_store_id
        ? {
            id: row.affected_store_id,
            name: row.affected_store_name as string,
          }
        : null,
      categories: (categories.all(row.id) as Array<{ label: string }>).map(
        (category) => category.label,
      ),
      resolution: {
        summary: truncatePromptText(row.resolution_summary, 4_000),
        rootCause: row.root_cause
          ? truncatePromptText(row.root_cause, 4_000)
          : null,
        outcome: row.outcome ? truncatePromptText(row.outcome, 4_000) : null,
        validatedAt: row.validated_at,
      },
      finalResponse: row.final_response
        ? truncatePromptText(row.final_response, SUPPORT_PROMPT_MESSAGE_TEXT_LIMIT)
        : null,
    }));
  }

  private supersedeCandidateSuggestions(
    ticketId: string,
    updatedAt: string,
  ): number {
    return this.database
      .prepare(
        `UPDATE suggestions
         SET status = 'superseded', updated_at = ?
         WHERE ticket_id = ? AND status = 'candidate'`,
      )
      .run(updatedAt, ticketId).changes;
  }

  private invalidateLegacyAutomaticGuidance(
    ticketId: string,
    updatedAt: string,
  ): void {
    this.supersedeCandidateSuggestions(ticketId, updatedAt);
    this.database
      .prepare(
        `UPDATE tickets
         SET next_action = NULL,
             updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END
         WHERE id = ?`,
      )
      .run(updatedAt, updatedAt, ticketId);
  }

  private closeAutomaticInvestigationLifecycle(
    ticketId: string,
    finishedAt: string,
    reason: string,
  ): number {
    this.supersedeCandidateSuggestions(ticketId, finishedAt);
    const activeJobs = this.database
      .prepare(
        `SELECT id, state FROM investigation_jobs
         WHERE ticket_id = ? AND state IN ('queued', 'running')
         ORDER BY requested_at, rowid`,
      )
      .all(ticketId) as Array<{
      id: string;
      state: "queued" | "running";
    }>;
    if (!activeJobs.length) return 0;

    this.database
      .prepare(
        `UPDATE investigation_jobs
         SET state = 'failed', finished_at = ?, error = ?,
             claimed_at = NULL, lease_expires_at = NULL,
             rerun_requested = 0, rerun_instructions = NULL
         WHERE ticket_id = ? AND state IN ('queued', 'running')`,
      )
      .run(finishedAt, reason, ticketId);
    for (const job of activeJobs) {
      this.insertTicketEvent({
        ticketId,
        eventType: "investigation_cancelled",
        actor: "system",
        fromStatus: null,
        toStatus: null,
        data: {
          jobId: job.id,
          jobKind: "automatic",
          previousState: job.state,
          reason,
        },
        occurredAt: finishedAt,
      });
    }
    return activeJobs.length;
  }

  private investigationContextChangedSince(
    ticketId: string,
    sinceAt: string | null,
  ): boolean {
    if (!sinceAt) return false;
    return Boolean(
      this.database
        .prepare(
          `SELECT 1
           WHERE EXISTS (
             SELECT 1 FROM ticket_messages
             WHERE ticket_id = ? AND added_at > ?
           )
           OR EXISTS (
             SELECT 1 FROM sent_responses
             WHERE ticket_id = ? AND captured_at > ?
           )
           OR EXISTS (
             SELECT 1
             FROM ticket_messages tm
             JOIN messages m ON m.id = tm.message_id
             WHERE tm.ticket_id = ? AND m.updated_at > ?
           )
           OR EXISTS (
             SELECT 1
             FROM ticket_messages tm
             JOIN attachments a ON a.message_id = tm.message_id
             WHERE tm.ticket_id = ? AND a.updated_at > ?
           )`,
        )
        .get(
          ticketId,
          sinceAt,
          ticketId,
          sinceAt,
          ticketId,
          sinceAt,
          ticketId,
          sinceAt,
        ),
    );
  }

  private isSuggestedResponseAlreadySent(
    ticketId: string,
    suggestedResponse: string | null | undefined,
  ): boolean {
    const candidate = suggestedResponse?.trim();
    if (!candidate) return false;
    const responses = this.database
      .prepare(
        `SELECT body FROM sent_responses
         WHERE ticket_id = ?
         ORDER BY sent_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(ticketId, SENT_RESPONSE_DEDUPLICATION_LIMIT) as Array<{
      body: string;
    }>;
    return responses.some((response) =>
      responsesAreEquivalent(candidate, response.body),
    );
  }

  private normalizeAutomaticReplyState(
    ticketId: string,
    analysis: SupportAnalysis,
  ): SupportAnalysis {
    const conversationState = this.getSupportConversationState(ticketId);
    const lastExternalAt = conversationState.lastExternalMessageAt
      ? Date.parse(conversationState.lastExternalMessageAt)
      : Number.NaN;
    const lastSentResponseAt = conversationState.lastSentResponseAt
      ? Date.parse(conversationState.lastSentResponseAt)
      : Number.NaN;
    const hasCoherentSentResponse =
      Number.isFinite(lastExternalAt) &&
      Number.isFinite(lastSentResponseAt) &&
      lastSentResponseAt >= lastExternalAt &&
      !conversationState.hasUnansweredExternalMessages;
    if (analysis.outcome === "already_answered" && !hasCoherentSentResponse) {
      return {
        ...analysis,
        outcome: "technical_investigation_required",
        suggestedResponse: null,
        nextAction:
          "Não há evidência temporal suficiente de que a demanda atual foi respondida. Reavalie o contexto antes de concluir o atendimento.",
      };
    }

    const duplicate = analysis.suggestedResponse?.trim()
      ? this.isSuggestedResponseAlreadySent(
          ticketId,
          analysis.suggestedResponse,
        )
      : false;
    if (!duplicate) return analysis;
    return {
      ...analysis,
      outcome: "technical_investigation_required",
      suggestedResponse: null,
      nextAction:
        "A minuta repete uma resposta já enviada. Reavalie o contexto e produza orientação somente se houver informação materialmente nova.",
    };
  }

  getInvestigationContext(
    ticketId: string,
    messageLimit?: number,
  ): SupportAnalysisInput {
    if (
      messageLimit !== undefined &&
      (!Number.isInteger(messageLimit) || messageLimit < 1)
    ) {
      throw new ValidationError("Limite de mensagens deve ser um inteiro positivo");
    }
    const safeMessageLimit = Math.min(
      messageLimit ?? THREAD_PROMPT_TICKET_MESSAGE_LIMIT,
      THREAD_PROMPT_TICKET_MESSAGE_LIMIT,
    );
    const ticket = this.database
      .prepare(
        `SELECT t.id, t.client_id, t.group_id, t.affected_store_id,
                c.name AS client_name,
                c.kind AS client_kind,
                c.identification_pending AS client_identification_pending,
                g.subject AS group_name
         FROM tickets t
         JOIN clients c ON c.id = t.client_id
         JOIN whatsapp_groups g ON g.id = t.group_id
         WHERE t.id = ?`,
      )
      .get(ticketId) as
      | {
          id: string;
          client_id: string;
          group_id: string;
          affected_store_id: string | null;
          client_name: string;
          client_kind: "agency" | "ecommerce";
          client_identification_pending: number;
          group_name: string;
        }
      | undefined;
    if (!ticket) {
      throw new NotFoundError("Ticket", ticketId);
    }

    const messageRowsDescending = this.database
      .prepare(
        `SELECT
          m.id, m.occurred_at, m.text, m.quoted_external_id,
          p.display_name,
          CASE WHEN staff.participant_id IS NULL THEN 'external' ELSE 'staff' END AS role
         FROM ticket_messages tm
         JOIN messages m ON m.id = tm.message_id
         JOIN participants p ON p.id = m.sender_id
         LEFT JOIN staff_members staff
          ON staff.participant_id = p.id AND staff.active = 1
         WHERE tm.ticket_id = ?
         ORDER BY m.occurred_at DESC, m.rowid DESC
         LIMIT ?`,
      )
      .all(ticketId, safeMessageLimit) as Array<{
      id: string;
      occurred_at: string;
      text: string | null;
      quoted_external_id: string | null;
      display_name: string;
      role: "external" | "staff";
    }>;
    const messageRows = messageRowsDescending.reverse();
    const attachmentStatement = this.database.prepare(
      `SELECT kind, file_name, mime_type, local_path, extracted_text
       FROM attachments WHERE message_id = ? ORDER BY created_at`,
    );
    const openTickets = this.database
      .prepare(
        `SELECT id, title, summary, status
         FROM tickets
         WHERE client_id = ?
           AND id != ?
           AND status NOT IN ('resolved', 'archived')
         ORDER BY updated_at DESC
         LIMIT 30`,
      )
      .all(ticket.client_id, ticketId) as SupportAnalysisInput["openTickets"];
    const stores = this.database
      .prepare(
        "SELECT name FROM client_stores WHERE client_id = ? AND active = 1 ORDER BY name",
      )
      .all(ticket.client_id) as Array<{ name: string }>;
    const messages = messageRows.map((message) => ({
      id: message.id,
      author: message.display_name,
      role: message.role,
      timestampUtc: message.occurred_at,
      text: message.text,
      attachments: (attachmentStatement.all(message.id) as Array<{
        kind: AttachmentDto["kind"];
        file_name: string | null;
        mime_type: string;
        local_path: string;
        extracted_text: string | null;
      }>).map((attachment) => ({
        kind:
          attachment.kind === "pdf" || attachment.kind === "document"
            ? "document" as const
            : attachment.kind,
        fileName: attachment.file_name,
        mimeType: attachment.mime_type,
        localPath: attachment.local_path,
        extractedText: attachment.extracted_text,
      })),
      quotedMessageId: message.quoted_external_id,
    }));

    return {
      ticketId,
      accountName: ticket.client_name,
      accountType: ticket.client_identification_pending
        ? "unknown"
        : ticket.client_kind,
      groupName: ticket.group_name,
      knownEcommerces: stores.map((store) => store.name),
      directoryContext: this.getDirectoryAnalysisContext(
        ticket.group_id,
        ticketId,
      ),
      categoryCatalog: this.getAnalysisCategoryCatalog(),
      conversationState: this.getSupportConversationState(ticketId),
      messages: limitSupportPromptMessages(messages),
      sentResponses: this.getSupportSentResponses(ticketId),
      openTickets: openTickets.map((item) => ({
        ...item,
        title: truncatePromptText(item.title, 500),
        summary: truncatePromptText(item.summary, 2_000),
      })),
      resolvedPrecedents: this.getSupportResolvedPrecedents(
        ticketId,
        ticket.client_id,
        ticket.affected_store_id,
      ),
    };
  }

  getInvestigationThreadContext(jobId: string): InvestigationThreadInput {
    const job = this.database
      .prepare(
        `SELECT j.id, j.thread_id, j.operator_message_id, t.ticket_id, t.summary
         FROM investigation_thread_jobs j
         JOIN investigation_threads t ON t.id = j.thread_id
         WHERE j.id = ?`,
      )
      .get(jobId) as
      | {
          id: string;
          thread_id: string;
          operator_message_id: string;
          ticket_id: string;
          summary: string;
        }
      | undefined;
    if (!job) {
      throw new NotFoundError("Turno da sala de investigação", jobId);
    }

    const recentMessagesDescending = this.database
      .prepare(
        `SELECT id, role, body, phase, created_at
         FROM investigation_thread_messages
         WHERE thread_id = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(job.thread_id, THREAD_PROMPT_MESSAGE_LIMIT) as Array<{
      id: string;
      role: "operator" | "assistant";
      body: string;
      phase: InvestigationThreadInput["recentMessages"][number]["phase"];
      created_at: string;
    }>;
    const recentMessages = recentMessagesDescending.reverse().map((message) => ({
      id: message.id,
      role: message.role,
      body: message.body,
      phase: message.phase,
      createdAt: message.created_at,
    }));
    const ticket = this.getInvestigationContext(
      job.ticket_id,
      THREAD_PROMPT_TICKET_MESSAGE_LIMIT,
    );

    const automaticRow = this.database
      .prepare(
        `SELECT result_json FROM investigation_jobs
         WHERE ticket_id = ? AND state = 'completed' AND result_json IS NOT NULL
         ORDER BY finished_at DESC, requested_at DESC, rowid DESC LIMIT 1`,
      )
      .get(job.ticket_id) as { result_json: string } | undefined;
    const automaticResult = parseJson<unknown>(
      automaticRow?.result_json ?? null,
      null,
    );

    return {
      threadId: job.thread_id,
      currentOperatorMessageId: job.operator_message_id,
      durableSummary: job.summary,
      recentMessages: limitRecentThreadMessages(recentMessages),
      ticket,
      automaticInvestigation: isRecord(automaticResult)
        ? (automaticResult as unknown as SupportAnalysis)
        : null,
      toolResults: this.getInvestigationThreadToolExecutions(job.id),
    };
  }

  /**
   * Persists a trusted executor result before the next model round starts.
   * The (job, request) key is first-write-wins so retries are idempotent and
   * cannot rewrite an audit record that was already observed by the operator.
   */
  appendInvestigationThreadToolExecution(
    jobId: string,
    execution: InvestigationToolResult,
  ): InvestigationToolExecutionDto {
    const job = this.database
      .prepare("SELECT id FROM investigation_thread_jobs WHERE id = ?")
      .get(jobId);
    if (!job) {
      throw new NotFoundError("Turno da sala de investigação", jobId);
    }

    const normalized = this.normalizeInvestigationToolExecution(execution);
    this.database
      .prepare(
        `INSERT OR IGNORE INTO investigation_thread_tool_executions
          (id, job_id, request_id, tool_id, tool_name, operation,
           arguments_json, purpose, status, summary, content, reference,
           executed_at, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        jobId,
        normalized.requestId,
        normalized.toolId,
        normalized.toolName,
        normalized.operation,
        normalized.argumentsJson,
        normalized.purpose,
        normalized.status,
        normalized.summary,
        normalized.content,
        normalized.reference,
        normalized.executedAt,
        nowUtc(),
      );

    const persisted = this.getInvestigationThreadToolExecutions(jobId).find(
      (item) => item.requestId === normalized.requestId,
    );
    if (!persisted) {
      throw new Error("Não foi possível persistir a auditoria da ferramenta");
    }
    return persisted;
  }

  completeInvestigationThreadJob(
    jobId: string,
    result: InvestigationTurnResult,
  ): InvestigationThreadDto {
    return this.database.transaction(() => {
      const job = this.database
        .prepare(
          `SELECT j.id, j.thread_id, j.state, j.operator_message_id,
                  j.assistant_message_id, j.requested_at, j.started_at,
                  j.ai_model,
                  t.ticket_id, t.summary AS thread_summary,
                  ticket.status AS ticket_status
           FROM investigation_thread_jobs j
           JOIN investigation_threads t ON t.id = j.thread_id
           JOIN tickets ticket ON ticket.id = t.ticket_id
           WHERE j.id = ?`,
        )
        .get(jobId) as
        | {
            id: string;
            thread_id: string;
            ticket_id: string;
            state: InvestigationJobState;
            operator_message_id: string;
            assistant_message_id: string | null;
            requested_at: string;
            started_at: string | null;
            ai_model: string | null;
            thread_summary: string;
            ticket_status: TicketStatus;
          }
        | undefined;
      if (!job) {
        throw new NotFoundError("Turno da sala de investigação", jobId);
      }
      if (job.state === "completed") {
        return this.getInvestigationThread(job.thread_id);
      }
      if (job.state !== "queued" && job.state !== "running") {
        throw new ValidationError(
          `Turno não pode ser concluído a partir do estado ${job.state}`,
        );
      }

      const auditedRequestIds = new Set(
        this.getInvestigationThreadToolExecutions(jobId).map(
          (execution) => execution.requestId,
        ),
      );
      for (const execution of result.toolExecutions ?? []) {
        if (auditedRequestIds.has(execution.requestId)) continue;
        this.appendInvestigationThreadToolExecution(jobId, execution);
        auditedRequestIds.add(execution.requestId);
      }
      const toolExecutions = this.getInvestigationThreadToolExecutions(jobId);

      const timestamp = nowUtc();
      const assistantMessageId = job.assistant_message_id ?? randomUUID();
      const proposedAssistantMessage = normalizedText(
        result.assistantMessage,
        "Resposta da IA",
      );
      const proposedThreadSummary = normalizedText(
        result.threadSummary,
        "Resumo da investigação",
      );
      const proposedResponse = normalizedNullableText(
        result.suggestedResponse,
      );
      const staleCompletion = this.investigationContextChangedSince(
        job.ticket_id,
        job.started_at ?? job.requested_at,
      );
      const terminalCompletion = isTerminalTicketStatus(job.ticket_status);
      const assistantMessage = staleCompletion
        ? "O contexto do ticket mudou durante esta investigação. A conclusão anterior foi descartada; continue a análise considerando as mensagens, respostas e anexos atuais."
        : proposedAssistantMessage;
      const threadSummary = staleCompletion
        ? job.thread_summary
        : proposedThreadSummary;
      const evidence = staleCompletion ? [] : result.evidence;
      const responseAlreadySent = this.isSuggestedResponseAlreadySent(
        job.ticket_id,
        proposedResponse,
      );
      const suggestedResponse = staleCompletion || terminalCompletion || responseAlreadySent
        ? null
        : proposedResponse;
      const persistedPhase = staleCompletion ? "analysis" : result.phase;
      const nextAction = staleCompletion
        ? "O contexto mudou durante a investigação. Continue a análise e reavalie as mensagens e respostas atuais antes de concluir."
        : normalizedNullableText(result.nextAction);
      const confidence = staleCompletion
        ? 0
        : (clampConfidence(result.confidence) ?? 0);
      const persistedResult: InvestigationTurnResult = {
        ...result,
        assistantMessage,
        phase: persistedPhase,
        threadSummary,
        evidence,
        suggestedResponse,
        nextAction,
        confidence,
        toolExecutions,
      };

      this.database
        .prepare(
          `INSERT OR IGNORE INTO investigation_thread_messages
            (id, thread_id, role, body, phase, evidence_json,
             suggested_response, next_action, job_id, created_at)
           VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          assistantMessageId,
          job.thread_id,
          assistantMessage,
          persistedPhase,
          JSON.stringify(evidence),
          suggestedResponse,
          nextAction,
          jobId,
          timestamp,
        );

      if (
        !staleCompletion &&
        !terminalCompletion &&
        (responseAlreadySent ||
          suggestedResponse ||
          persistedPhase === "conclusion" ||
          persistedPhase === "needs_information")
      ) {
        this.supersedeCandidateSuggestions(job.ticket_id, timestamp);
      }
      if (suggestedResponse) {
        this.addSuggestion({
          ticketId: job.ticket_id,
          body: suggestedResponse,
          confidence,
          evidence: evidence.map((item) => ({
            source: item.source,
            label: item.summary,
            ...(item.reference ? { reference: item.reference } : {}),
          })),
          model: job.ai_model?.trim() || "codex-conversational",
          promptVersion: DEEP_INVESTIGATION_PROMPT_VERSION,
          createdAt: timestamp,
        });
      }

      if (!terminalCompletion) {
        this.database
          .prepare(
            `UPDATE tickets
             SET next_action = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(nextAction, timestamp, job.ticket_id);
      }
      this.database
        .prepare(
          `UPDATE investigation_threads
           SET status = ?, summary = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          persistedPhase === "conclusion" ? "concluded" : "active",
          threadSummary,
          timestamp,
          job.thread_id,
        );
      this.database
        .prepare(
          `UPDATE investigation_thread_jobs
           SET state = 'completed', assistant_message_id = ?, finished_at = ?,
               result_json = ?, error = NULL, claimed_at = NULL,
               lease_expires_at = NULL
           WHERE id = ?`,
        )
        .run(
          assistantMessageId,
          timestamp,
          JSON.stringify(persistedResult),
          jobId,
        );
      this.insertTicketEvent({
        ticketId: job.ticket_id,
        eventType: "investigation_thread_turn_completed",
        actor: "Agente de IA",
        fromStatus: null,
        toStatus: null,
        data: {
          threadId: job.thread_id,
          jobId,
          jobKind: "thread_turn",
          phase: persistedPhase,
          originalPhase: result.phase,
          confidence,
          toolExecutionCount: toolExecutions.length,
          suggestionCreated: Boolean(suggestedResponse),
          staleCompletion,
        },
        occurredAt: timestamp,
      });

      return this.getInvestigationThread(job.thread_id);
    })();
  }

  failInvestigationThreadJob(jobId: string, error: string): void {
    this.database.transaction(() => {
      const timestamp = nowUtc();
      const result = this.database
        .prepare(
          `UPDATE investigation_thread_jobs
           SET state = 'failed', finished_at = ?, error = ?,
               claimed_at = NULL, lease_expires_at = NULL
           WHERE id = ? AND state IN ('queued', 'running')
           RETURNING thread_id`,
        )
        .get(timestamp, error.slice(0, 4_000), jobId) as
        | { thread_id: string }
        | undefined;
      if (!result) {
        const job = this.database
          .prepare("SELECT id FROM investigation_thread_jobs WHERE id = ?")
          .get(jobId);
        if (!job) {
          throw new NotFoundError("Turno da sala de investigação", jobId);
        }
        return;
      }
      this.database
        .prepare(
          "UPDATE investigation_threads SET status = 'active', updated_at = ? WHERE id = ?",
        )
        .run(timestamp, result.thread_id);
      const thread = this.database
        .prepare("SELECT ticket_id FROM investigation_threads WHERE id = ?")
        .get(result.thread_id) as { ticket_id: string } | undefined;
      if (thread) {
        this.insertTicketEvent({
          ticketId: thread.ticket_id,
          eventType: "investigation_thread_turn_failed",
          actor: "Agente de IA",
          fromStatus: null,
          toStatus: null,
          data: {
            threadId: result.thread_id,
            jobId,
            jobKind: "thread_turn",
            error: error.slice(0, 4_000),
          },
          occurredAt: timestamp,
        });
      }
    })();
  }

  completeInvestigationJob(jobId: string, analysis: SupportAnalysis): TicketDetailDto {
    return this.database.transaction(() => {
      const job = this.database
        .prepare(
          `SELECT id, ticket_id, state, started_at, ai_model,
                  rerun_requested, rerun_instructions
           FROM investigation_jobs WHERE id = ?`,
        )
        .get(jobId) as
        | {
            id: string;
            ticket_id: string;
            state: string;
            started_at: string | null;
            ai_model: string | null;
            rerun_requested: number;
            rerun_instructions: string | null;
          }
        | undefined;
      if (!job) {
        throw new NotFoundError("Job de investigação", jobId);
      }
      if (job.state === "completed") {
        return this.getTicketDetail(job.ticket_id);
      }

      const timestamp = nowUtc();
      const ticket = this.database
        .prepare("SELECT id, client_id, status FROM tickets WHERE id = ?")
        .get(job.ticket_id) as
        | { id: string; client_id: string; status: TicketStatus }
        | undefined;
      if (!ticket) {
        throw new NotFoundError("Ticket", job.ticket_id);
      }
      if (isTerminalTicketStatus(ticket.status)) {
        this.closeAutomaticInvestigationLifecycle(
          job.ticket_id,
          timestamp,
          `Resultado descartado porque o ticket está ${ticket.status === "resolved" ? "resolvido" : "arquivado"}.`,
        );
        return this.getTicketDetail(job.ticket_id);
      }
      if (!new Set(["queued", "running"]).has(job.state)) {
        throw new ValidationError(`Job não pode ser concluído a partir do estado ${job.state}`);
      }
      const contextChangedSinceStart = this.investigationContextChangedSince(
        job.ticket_id,
        job.started_at,
      );
      const staleCompletion = Boolean(job.rerun_requested) || contextChangedSinceStart;
      const effectiveAnalysis: SupportAnalysis = staleCompletion
        ? {
            createTicket: false,
            outcome: "technical_investigation_required",
            relation: "uncertain",
            relatedTicketId: null,
            title: "Análise desatualizada",
            summary:
              "O contexto mudou durante a investigação e o resultado anterior foi descartado.",
            affectedEcommerce: null,
            priority: analysis.priority,
            categories: {
              contactReason: [],
              productArea: [],
              platform: [],
              symptom: [],
            },
            evidence: [],
            suggestedResponse: null,
            missingInformation: [],
            nextAction:
              "O contexto mudou durante a investigação. Aguarde a nova análise já enfileirada.",
            confidence: 0,
          }
        : this.normalizeAutomaticReplyState(job.ticket_id, analysis);

      const store = effectiveAnalysis.affectedEcommerce
        ? (this.database
            .prepare(
              `SELECT id FROM client_stores
               WHERE client_id = ? AND active = 1 AND lower(name) = lower(?)
               LIMIT 1`,
            )
            .get(
              ticket.client_id,
              effectiveAnalysis.affectedEcommerce,
            ) as EntityRecord | undefined)
        : undefined;
      const priority: TicketPriority = effectiveAnalysis.priority;
      const title = effectiveAnalysis.title.trim();
      const summary = effectiveAnalysis.summary.trim();
      const nextAction = effectiveAnalysis.nextAction.trim();
      const normalizedCategories = normalizeCategoriesForAnalysis(
        effectiveAnalysis,
        this.getAnalysisCategoryCatalog(),
      );
      const persistedAnalysis: SupportAnalysis = {
        ...effectiveAnalysis,
        categories: normalizedCategories,
      };

      if (!staleCompletion) {
        this.database
          .prepare(
            `UPDATE tickets SET
              title = CASE WHEN ? = '' THEN title ELSE ? END,
              summary = CASE WHEN ? = '' THEN summary ELSE ? END,
              priority = ?,
              confidence = ?,
              needs_review = CASE WHEN ? = 'uncertain' THEN 1 ELSE needs_review END,
              ai_relation = ?,
              next_action = CASE WHEN ? = '' THEN next_action ELSE ? END,
              affected_store_id = COALESCE(?, affected_store_id),
              updated_at = ?
             WHERE id = ?`,
          )
          .run(
            title,
            title,
            summary,
            summary,
            priority,
            effectiveAnalysis.confidence,
            effectiveAnalysis.relation,
            effectiveAnalysis.relation,
            nextAction,
            nextAction,
            store?.id ?? null,
            timestamp,
            job.ticket_id,
          );

        const previousAiCategoryRows = this.database
          .prepare(
            `SELECT category_id AS id
             FROM ticket_categories
             WHERE ticket_id = ? AND source = 'ai'`,
          )
          .all(job.ticket_id) as EntityRecord[];
        this.database
          .prepare(
            `DELETE FROM ticket_categories
             WHERE ticket_id = ? AND source = 'ai'`,
          )
          .run(job.ticket_id);
        const categoryGroups: Array<{
          facet: CategoryFacet;
          values: string[];
        }> = [
          { facet: "reason", values: normalizedCategories.contactReason },
          { facet: "product", values: normalizedCategories.productArea },
          { facet: "platform", values: normalizedCategories.platform },
          { facet: "symptom", values: normalizedCategories.symptom },
        ];
        for (const group of categoryGroups) {
          for (const rawLabel of group.values) {
            const label = rawLabel.trim();
            const slug = slugify(label);
            if (!label || !slug) {
              continue;
            }
            const category = this.upsertCategory({
              facet: group.facet,
              slug,
              label,
            });
            this.addTicketCategoryInternal(
              job.ticket_id,
              category.id,
              "ai",
              effectiveAnalysis.confidence,
              timestamp,
            );
          }
        }
        this.deleteOrphanCategories(
          previousAiCategoryRows.map((category) => category.id),
        );

        this.supersedeCandidateSuggestions(job.ticket_id, timestamp);
        if (effectiveAnalysis.suggestedResponse?.trim()) {
          this.addSuggestion({
            ticketId: job.ticket_id,
            body: effectiveAnalysis.suggestedResponse,
            confidence: effectiveAnalysis.confidence,
            evidence: effectiveAnalysis.evidence.map((evidence) => ({
              source: evidence.source,
              label: evidence.summary,
              ...(evidence.reference ? { reference: evidence.reference } : {}),
            })),
            missingInformation: effectiveAnalysis.missingInformation,
            model: job.ai_model?.trim() || "codex",
            promptVersion: AUTOMATIC_INVESTIGATION_PROMPT_VERSION,
            createdAt: timestamp,
          });
        }
      }

      this.database
        .prepare(
          `UPDATE investigation_jobs
           SET state = 'completed', finished_at = ?, result_json = ?, error = NULL,
               claimed_at = NULL, lease_expires_at = NULL
           WHERE id = ?`,
        )
        .run(timestamp, JSON.stringify(persistedAnalysis), jobId);
      this.insertTicketEvent({
        ticketId: job.ticket_id,
        eventType: "investigation_completed",
        actor: "Agente de IA",
        fromStatus: null,
        toStatus: null,
        data: {
          jobId,
          jobKind: "automatic",
          outcome: effectiveAnalysis.outcome,
          relation: effectiveAnalysis.relation,
          confidence: effectiveAnalysis.confidence,
          createTicket: effectiveAnalysis.createTicket,
          relatedTicketId: effectiveAnalysis.relatedTicketId,
          affectedEcommerceMatched: Boolean(store),
          staleCompletion,
          contextChangedSinceStart,
        },
        occurredAt: timestamp,
      });
      return this.getTicketDetail(job.ticket_id);
    })();
  }

  failInvestigationJob(jobId: string, error: string): void {
    this.database.transaction(() => {
      const timestamp = nowUtc();
      const job = this.database
        .prepare(
          `SELECT id, ticket_id, state, rerun_requested, rerun_instructions
           FROM investigation_jobs WHERE id = ?`,
        )
        .get(jobId) as
        | {
            id: string;
            ticket_id: string;
            state: string;
            rerun_requested: number;
            rerun_instructions: string | null;
          }
        | undefined;
      if (!job) {
        throw new NotFoundError("Job de investigação", jobId);
      }
      if (!new Set(["queued", "running"]).has(job.state)) {
        return;
      }

      this.database
        .prepare(
          `UPDATE investigation_jobs
           SET state = 'failed', finished_at = ?, error = ?,
               claimed_at = NULL, lease_expires_at = NULL
           WHERE id = ? AND state IN ('queued', 'running')`,
        )
        .run(timestamp, error.slice(0, 4_000), jobId);
      this.insertTicketEvent({
        ticketId: job.ticket_id,
        eventType: "investigation_failed",
        actor: "Agente de IA",
        fromStatus: null,
        toStatus: null,
        data: {
          jobId,
          jobKind: "automatic",
          error: error.slice(0, 4_000),
        },
        occurredAt: timestamp,
      });
    })();
  }

  listTickets(filters: TicketListFilters = {}): TicketListResponse {
    const where: string[] = ["c.ignored_at IS NULL"];
    const parameters: Array<string | number> = [];

    if (filters.statuses?.length) {
      where.push(`t.status IN (${filters.statuses.map(() => "?").join(", ")})`);
      parameters.push(...filters.statuses);
    } else if (!filters.includeArchived) {
      where.push("t.status != 'archived'");
    }

    if (filters.clientId) {
      where.push("t.client_id = ?");
      parameters.push(filters.clientId);
    }

    if (filters.productForwardingKind) {
      where.push(
        `EXISTS (
          SELECT 1
          FROM ticket_product_forwardings product_forwarding_filter
          WHERE product_forwarding_filter.ticket_id = t.id
            AND product_forwarding_filter.kind = ?
        )`,
      );
      parameters.push(filters.productForwardingKind);
    }

    if (filters.createdFromUtc) {
      where.push("t.created_at >= ?");
      parameters.push(filters.createdFromUtc);
    }

    if (filters.createdToUtcExclusive) {
      where.push("t.created_at < ?");
      parameters.push(filters.createdToUtcExclusive);
    }

    if (filters.query?.trim()) {
      const search = `%${filters.query.trim()}%`;
      where.push(
        `(t.title LIKE ? OR t.summary LIKE ? OR c.name LIKE ? OR g.subject LIKE ? OR s.name LIKE ?
          OR EXISTS (
            SELECT 1
            FROM ticket_messages requester_search_ticket_message
            JOIN messages requester_search_message
              ON requester_search_message.id = requester_search_ticket_message.message_id
            JOIN participants requester_search
              ON requester_search.id = requester_search_message.sender_id
            LEFT JOIN staff_members requester_search_staff
              ON requester_search_staff.participant_id = requester_search.id
             AND requester_search_staff.active = 1
            WHERE requester_search_ticket_message.ticket_id = t.id
              AND requester_search_staff.participant_id IS NULL
              AND (requester_search.display_name LIKE ? OR requester_search.phone_e164 LIKE ?)
          ))`,
      );
      parameters.push(search, search, search, search, search, search, search);
    }

    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const requestedLimit = filters.limit ?? 50;
    const requestedOffset = filters.offset ?? 0;
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
      throw new ValidationError("limit deve ser um inteiro positivo");
    }
    if (!Number.isInteger(requestedOffset) || requestedOffset < 0) {
      throw new ValidationError("offset deve ser um inteiro maior ou igual a zero");
    }
    const limit = Math.min(requestedLimit, 200);
    const offset = requestedOffset;
    const totalRow = this.database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM tickets t
         JOIN clients c ON c.id = t.client_id
         JOIN whatsapp_groups g ON g.id = t.group_id
         LEFT JOIN client_stores s ON s.id = t.affected_store_id
         ${clause}`,
      )
      .get(...parameters) as { count: number };

    const rows = this.database
      .prepare(
        `${this.ticketSelect()}
         ${clause}
         ORDER BY ${
           filters.order === "created_desc"
             ? "t.created_at DESC, t.number DESC"
             : filters.order === "resolved_desc"
               ? "COALESCE(t.resolved_at, t.updated_at) DESC, t.number DESC"
             : filters.order === "archived_desc"
               ? "COALESCE(t.archived_at, t.updated_at) DESC, t.number DESC"
               : "CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.updated_at DESC"
         }
         LIMIT ? OFFSET ?`,
      )
      .all(...parameters, limit, offset) as TicketSummaryRow[];

    return {
      items: rows.map((row) => this.mapTicketSummary(row)),
      total: totalRow.count,
      limit,
      offset,
    };
  }

  listConversationTickets(
    groupId: string,
    filters: ConversationTicketListFilters = {},
  ): ConversationTicketListResponse {
    const conversation = this.database
      .prepare("SELECT id FROM whatsapp_groups WHERE id = ?")
      .get(groupId) as { id: string } | undefined;
    if (!conversation) throw new NotFoundError("Conversa", groupId);

    const requestedLimit = filters.limit ?? 10;
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
      throw new ValidationError("Limite de tickets da conversa inválido");
    }
    const limit = Math.min(requestedLimit, 50);
    const statuses = [...new Set(filters.statuses ?? [])].toSorted();
    const query = normalizedNullableText(filters.query)?.toLocaleLowerCase("pt-BR") ?? null;
    const filterKey = JSON.stringify({ groupId, statuses, query });
    const cursor = decodePageCursor(
      filters.cursor,
      "Cursor de tickets da conversa",
    );
    if (cursor && cursor.filterKey !== filterKey) {
      throw new ValidationError(
        "O cursor de tickets não pertence aos filtros informados",
      );
    }

    const clauses = ["t.group_id = ?", "c.ignored_at IS NULL"];
    const parameters: Array<string | number> = [groupId];
    if (statuses.length) {
      clauses.push(`t.status IN (${statuses.map(() => "?").join(", ")})`);
      parameters.push(...statuses);
    }
    if (query) {
      const pattern = `%${query}%`;
      clauses.push(
        "(lower(t.title) LIKE ? OR CAST(t.number AS TEXT) LIKE ?)",
      );
      parameters.push(pattern, pattern);
    }
    const where = `WHERE ${clauses.join(" AND ")}`;
    const rows = this.database
      .prepare(
        `SELECT t.id, t.number, t.title, t.status, t.updated_at
         FROM tickets t
         JOIN clients c ON c.id = t.client_id
         ${where}
           AND (? IS NULL OR t.updated_at < ? OR (t.updated_at = ? AND t.id < ?))
         ORDER BY t.updated_at DESC, t.id DESC
         LIMIT ?`,
      )
      .all(
        ...parameters,
        cursor?.occurredAt ?? null,
        cursor?.occurredAt ?? null,
        cursor?.occurredAt ?? null,
        cursor?.id ?? null,
        limit + 1,
      ) as Array<{
        id: string;
        number: number;
        title: string;
        status: TicketStatus;
        updated_at: string;
      }>;

    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const last = selected.at(-1);
    const total = (
      this.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM tickets t
           JOIN clients c ON c.id = t.client_id
           ${where}`,
        )
        .get(...parameters) as { count: number }
    ).count;
    const summary = this.database
      .prepare(
        `SELECT
           COUNT(*) AS all_count,
           SUM(CASE WHEN t.status NOT IN ('resolved', 'archived') THEN 1 ELSE 0 END) AS active_count,
           SUM(CASE WHEN t.status = 'resolved' THEN 1 ELSE 0 END) AS resolved_count,
           SUM(CASE WHEN t.status = 'archived' THEN 1 ELSE 0 END) AS archived_count
         FROM tickets t
         JOIN clients c ON c.id = t.client_id
         WHERE t.group_id = ? AND c.ignored_at IS NULL`,
      )
      .get(groupId) as {
        all_count: number;
        active_count: number | null;
        resolved_count: number | null;
        archived_count: number | null;
      };

    return {
      items: selected.map((ticket) => ({
        id: ticket.id,
        number: ticket.number,
        title: ticket.title,
        status: ticket.status,
      })),
      total,
      summary: {
        all: summary.all_count,
        active: summary.active_count ?? 0,
        resolved: summary.resolved_count ?? 0,
        archived: summary.archived_count ?? 0,
      },
      nextCursor:
        hasMore && last
          ? encodePageCursor(last.updated_at, last.id, filterKey)
          : null,
      hasMore,
    };
  }

  listCategories(filters: CategoryListFilters = {}): Array<CategoryCatalogDto> {
    const where: string[] = [];
    const parameters: Array<string | number> = [];

    if (filters.facet) {
      where.push("c.facet = ?");
      parameters.push(filters.facet);
    }
    if (filters.query?.trim()) {
      const term = `%${filters.query.trim()}%`;
      where.push("(c.label LIKE ? OR c.slug LIKE ?)");
      parameters.push(term, term);
    }
    const includeEmpty = filters.includeEmpty ?? true;

    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.database
      .prepare(
        `SELECT c.id, c.facet, c.slug, c.label, c.color,
                COUNT(tc.ticket_id) AS ticket_count
         FROM categories c
         LEFT JOIN ticket_categories tc ON tc.category_id = c.id
         ${clause}
         GROUP BY c.id
         ${includeEmpty ? "" : "HAVING COUNT(tc.ticket_id) > 0"}
         ORDER BY c.facet ASC, c.label ASC`,
      )
      .all(...parameters) as CategoryCatalogRow[];
    return rows.map((row) => this.mapCategoryCatalog(row));
  }

  private getAnalysisCategoryCatalog(): AnalysisCategoryCatalog {
    const catalog: AnalysisCategoryCatalog = {
      contactReason: [...DEFAULT_ANALYSIS_CATEGORY_CATALOG.contactReason],
      productArea: [...DEFAULT_ANALYSIS_CATEGORY_CATALOG.productArea],
      platform: [...DEFAULT_ANALYSIS_CATEGORY_CATALOG.platform],
      symptom: [...DEFAULT_ANALYSIS_CATEGORY_CATALOG.symptom],
    };
    const targetByFacet = {
      reason: catalog.contactReason,
      product: catalog.productArea,
      platform: catalog.platform,
      symptom: catalog.symptom,
    } as const;
    const rows = this.database
      .prepare(
        `SELECT facet, label FROM categories
         WHERE facet IN ('reason', 'product', 'platform', 'symptom')
         ORDER BY facet, label`,
      )
      .all() as Array<{
      facet: keyof typeof targetByFacet;
      label: string;
    }>;
    for (const row of rows) {
      const target = targetByFacet[row.facet];
      const alreadyPresent = target.some(
        (label) =>
          label.localeCompare(row.label, "pt-BR", { sensitivity: "base" }) === 0,
      );
      if (!alreadyPresent) target.push(row.label);
    }
    return catalog;
  }

  createCategory(input: {
    facet: CategoryFacet;
    label: string;
    color?: string | null;
  }): CategoryCatalogDto {
    const slug = slugify(input.label);
    if (!slug) {
      throw new ValidationError("A categoria precisa de um nome válido.", {
        facet: input.facet,
        label: input.label,
      });
    }
    const category = this.upsertCategory({
      ...input,
      slug,
      origin: "manual",
    });
    return {
      ...category,
      ticketCount: this.countCategoryTickets(category.id),
    };
  }

  attachCategoryToTicket(
    ticketId: string,
    categoryId: string,
    actor = "Operador local",
  ): TicketDetailDto {
    return this.database.transaction(() => {
      const ticket = this.database
        .prepare("SELECT id FROM tickets WHERE id = ?")
        .get(ticketId) as { id: string } | undefined;
      if (!ticket) {
        throw new NotFoundError("Ticket", ticketId);
      }

  const alreadyLinked = this.database
        .prepare(
          "SELECT 1 FROM ticket_categories WHERE ticket_id = ? AND category_id = ?",
        )
        .get(ticketId, categoryId) !== undefined;

      const timestamp = nowUtc();
      this.addTicketCategoryInternal(
        ticketId,
        categoryId,
        "manual",
        1,
        timestamp,
      );

      if (!alreadyLinked) {
        this.insertTicketEvent({
          ticketId,
          eventType: "ticket_category_added",
          actor,
          fromStatus: null,
          toStatus: null,
          data: { categoryId },
          occurredAt: timestamp,
        });
      }
      return this.getTicketDetail(ticketId);
    })();
  }

  detachCategoryFromTicket(
    ticketId: string,
    categoryId: string,
    actor = "Operador local",
  ): TicketDetailDto {
    return this.database.transaction(() => {
      const timestamp = nowUtc();
      const ticket = this.database
        .prepare("SELECT id FROM tickets WHERE id = ?")
        .get(ticketId) as { id: string } | undefined;
      if (!ticket) {
        throw new NotFoundError("Ticket", ticketId);
      }

      const removed = this.database
        .prepare(
          `DELETE FROM ticket_categories
           WHERE ticket_id = ? AND category_id = ?`,
        )
        .run(ticketId, categoryId).changes > 0;
      if (!removed) {
        throw new NotFoundError("Associação de categoria", categoryId);
      }

      this.insertTicketEvent({
        ticketId,
        eventType: "ticket_category_removed",
        actor,
        fromStatus: null,
        toStatus: null,
        data: { categoryId },
        occurredAt: timestamp,
      });
      return this.getTicketDetail(ticketId);
    })();
  }

  getTicketDetail(ticketId: string): TicketDetailDto {
    const row = this.database
      .prepare(`${this.ticketSelect()} WHERE t.id = ?`)
      .get(ticketId) as TicketSummaryRow | undefined;
    if (!row) {
      throw new NotFoundError("Ticket", ticketId);
    }

    return {
      ...this.mapTicketSummary(row),
      requesterOverrideId: row.requester_override_id,
      requesterCandidates: this.getTicketRequesterCandidates(ticketId),
      directoryContext: this.getTicketDirectoryContext(ticketId),
      productForwarding: this.getTicketProductForwarding(ticketId),
      timeline: this.getTimeline(ticketId),
      suggestions: this.getSuggestions(ticketId),
      sentResponses: this.getSentResponses(ticketId),
      resolution: this.getResolution(ticketId),
      latestInvestigation: this.getLatestInvestigation(ticketId),
      investigationThread: this.getInvestigationThreadSummaryForTicket(ticketId),
    };
  }

  getTicketRequesterCandidates(ticketId: string): TicketRequesterDto[] {
    const ticket = this.database
      .prepare(
        `SELECT group_id,
                ${this.requesterOverrideAvailable ? "requester_id" : "NULL"}
                  AS requester_id
         FROM tickets WHERE id = ?`,
      )
      .get(ticketId) as
      | { group_id: string; requester_id: string | null }
      | undefined;
    if (!ticket) throw new NotFoundError("Ticket", ticketId);

    const rows = this.database
      .prepare(
        `SELECT participant.id, participant.external_jid,
                participant.display_name, participant.phone_e164,
                participant.created_at, participant.updated_at
         FROM group_participants membership
         JOIN participants participant
           ON participant.id = membership.participant_id
         LEFT JOIN staff_members staff
           ON staff.participant_id = participant.id AND staff.active = 1
         WHERE membership.group_id = ?
           AND membership.active = 1
           AND staff.participant_id IS NULL
         ORDER BY participant.updated_at DESC, participant.id`,
      )
      .all(ticket.group_id) as Array<{
      id: string;
      external_jid: string;
      display_name: string;
      phone_e164: string | null;
      created_at: string;
      updated_at: string;
    }>;
    if (!rows.length) return [];

    const links = this.database
      .prepare("SELECT phone_jid, lid_jid FROM whatsapp_identity_links")
      .all() as Array<{ phone_jid: string; lid_jid: string }>;
    const canonicalJidByAlias = new Map<string, string>();
    for (const link of links) {
      canonicalJidByAlias.set(link.phone_jid, link.phone_jid);
      canonicalJidByAlias.set(link.lid_jid, link.phone_jid);
    }
    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const key =
        canonicalJidByAlias.get(row.external_jid) ??
        row.phone_e164 ??
        row.external_jid;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }

    return [...groups.entries()]
      .map(([canonicalJid, aliases]) => {
        const representative =
          aliases.find((alias) => alias.id === ticket.requester_id) ??
          aliases.find((alias) => alias.external_jid === canonicalJid) ??
          aliases.find((alias) => alias.external_jid.endsWith("@s.whatsapp.net")) ??
          aliases[0]!;
        const humanName = aliases
          .filter((alias) =>
            isHumanParticipantDisplayName(alias.display_name, [
              alias.external_jid,
              alias.phone_e164,
            ]),
          )
          .toSorted(
            (left, right) =>
              right.updated_at.localeCompare(left.updated_at) ||
              left.id.localeCompare(right.id),
          )[0]?.display_name;
        const phoneE164 =
          aliases.find((alias) => alias.phone_e164)?.phone_e164 ??
          (canonicalJid.endsWith("@s.whatsapp.net")
            ? `+${canonicalJid.slice(0, -"@s.whatsapp.net".length)}`
            : null);
        return {
          id: representative.id,
          displayName: humanName ?? phoneE164 ?? representative.display_name,
          phoneE164,
        };
      })
      .toSorted(
        (left, right) =>
          left.displayName.localeCompare(right.displayName, "pt-BR", {
            sensitivity: "base",
          }) || left.id.localeCompare(right.id),
      );
  }

  getDashboard(input?: DashboardPeriodInput): DashboardResponse {
    const timeZone = this.workspaceTimeZone();
    const period = resolveDashboardPeriod(input, timeZone);
    const createdRangeSql = period
      ? " AND t.created_at >= ? AND t.created_at < ?"
      : "";
    const createdRangeParameters = period
      ? [period.fromUtc, period.toUtcExclusive]
      : [];
    const resolutionRangeSql = period
      ? " AND event.occurred_at >= ? AND event.occurred_at < ?"
      : "";
    const resolutionRangeParameters = period
      ? [period.fromUtc, period.toUtcExclusive]
      : [];
    const ticketTotal = this.database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM tickets t
         JOIN clients c ON c.id = t.client_id
         WHERE c.ignored_at IS NULL${createdRangeSql}`,
      )
      .get(...createdRangeParameters) as { count: number };
    const openTotal = this.database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM tickets t
         JOIN clients c ON c.id = t.client_id
         WHERE c.ignored_at IS NULL
           AND t.status NOT IN ('resolved', 'archived')${createdRangeSql}`,
      )
      .get(...createdRangeParameters) as { count: number };
    const reviewTotal = this.database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM tickets t
         JOIN clients c ON c.id = t.client_id
         WHERE c.ignored_at IS NULL
           AND t.needs_review = 1
           AND t.status NOT IN ('resolved', 'archived')${createdRangeSql}`,
      )
      .get(...createdRangeParameters) as { count: number };
    const resolvedTotal = this.database
      .prepare(
        `SELECT COUNT(DISTINCT event.ticket_id) AS count
         FROM ticket_events event
         JOIN tickets t ON t.id = event.ticket_id
         JOIN clients c ON c.id = t.client_id
         WHERE c.ignored_at IS NULL
           AND event.event_type IN ('ticket_created', 'status_changed')
           AND event.to_status = 'resolved'
           AND (event.from_status IS NULL OR event.from_status != 'archived')${resolutionRangeSql}`,
      )
      .get(...resolutionRangeParameters) as { count: number };
    const clientTotal = period
      ? (this.database
          .prepare(
            `SELECT COUNT(DISTINCT t.client_id) AS count
             FROM tickets t
             JOIN clients c ON c.id = t.client_id
             WHERE c.ignored_at IS NULL${createdRangeSql}`,
          )
          .get(...createdRangeParameters) as { count: number })
      : (this.database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM clients c
             WHERE c.ignored_at IS NULL
               AND (
                 c.identification_pending = 1
                 OR EXISTS (
                   SELECT 1 FROM whatsapp_groups g
                   WHERE g.client_id = c.id AND g.external_jid LIKE '%@g.us'
                 )
                 OR EXISTS (
                   SELECT 1 FROM tickets t WHERE t.client_id = c.id
                 )
               )`,
          )
          .get() as { count: number });
    const groupTotal = this.database
      .prepare(
        `SELECT COUNT(DISTINCT t.group_id) AS count
         FROM tickets t
         JOIN clients c ON c.id = t.client_id
         WHERE c.ignored_at IS NULL${createdRangeSql}`,
      )
      .get(...createdRangeParameters) as { count: number };
    const recordTotal = this.database
      .prepare(
        `SELECT COUNT(DISTINCT directory_record.id) AS count
         FROM tickets t
         JOIN clients c ON c.id = t.client_id
         JOIN directory_group_links directory_link
           ON directory_link.group_id = t.group_id
          AND directory_link.archived_at IS NULL
         JOIN directory_records directory_record
           ON directory_record.id = directory_link.record_id
          AND directory_record.archived_at IS NULL
         WHERE c.ignored_at IS NULL${createdRangeSql}`,
      )
      .get(...createdRangeParameters) as { count: number };
    const orphanTotal = this.database
      .prepare(
        `SELECT COUNT(DISTINCT m.group_id) AS count
         FROM messages m
         JOIN whatsapp_groups g ON g.id = m.group_id
         JOIN clients c ON c.id = g.client_id
         LEFT JOIN staff_members staff
          ON staff.participant_id = m.sender_id AND staff.active = 1
         LEFT JOIN ticket_messages tm ON tm.message_id = m.id
         WHERE staff.participant_id IS NULL
          AND c.ignored_at IS NULL
          AND g.suggestions_muted_at IS NULL
          AND m.triage_kind IN ('demand', 'uncertain')
          AND m.triage_state = 'unreviewed'
          AND tm.message_id IS NULL`,
      )
      .get() as { count: number };

    const rawStatusCounts = this.database
      .prepare(
        `SELECT t.status, COUNT(*) AS count
         FROM tickets t
         JOIN clients c ON c.id = t.client_id
         WHERE c.ignored_at IS NULL${createdRangeSql}
         GROUP BY t.status`,
      )
      .all(...createdRangeParameters) as Array<{ status: TicketStatus; count: number }>;
    const statusMap = new Map(rawStatusCounts.map((item) => [item.status, item.count]));

    const chartPeriod = period ?? recentDashboardPeriod(14, new Date(), timeZone);
    const dailyCounts = new Map(
      dashboardCalendarDates(chartPeriod).map((date) => [
        date,
        { date, created: 0, resolved: 0 },
      ]),
    );
    const ticketActivity = this.database
      .prepare(
        `SELECT t.created_at AS occurred_at, 'created' AS activity
         FROM tickets t
         JOIN clients c ON c.id = t.client_id
         WHERE c.ignored_at IS NULL
           AND t.created_at >= ? AND t.created_at < ?
         UNION ALL
         SELECT event.occurred_at, 'resolved' AS activity
         FROM ticket_events event
         JOIN tickets t ON t.id = event.ticket_id
         JOIN clients c ON c.id = t.client_id
         WHERE c.ignored_at IS NULL
           AND event.event_type IN ('ticket_created', 'status_changed')
           AND event.to_status = 'resolved'
           AND (event.from_status IS NULL OR event.from_status != 'archived')
           AND event.occurred_at >= ? AND event.occurred_at < ?`,
      )
      .all(
        chartPeriod.fromUtc,
        chartPeriod.toUtcExclusive,
        chartPeriod.fromUtc,
        chartPeriod.toUtcExclusive,
      ) as Array<{ occurred_at: string; activity: "created" | "resolved" }>;
    for (const activity of ticketActivity) {
      const bucket = dailyCounts.get(
        dashboardDateInTimeZone(activity.occurred_at, timeZone),
      );
      if (bucket) bucket[activity.activity] += 1;
    }
    const ticketsByDay = [...dailyCounts.values()];

    const topCategoryRows = this.database
      .prepare(
        `SELECT c.id, c.facet, c.slug, c.label, c.color, COUNT(*) AS count
         FROM ticket_categories tc
         JOIN categories c ON c.id = tc.category_id
         JOIN tickets t ON t.id = tc.ticket_id
         JOIN clients ticket_client ON ticket_client.id = t.client_id
         WHERE ticket_client.ignored_at IS NULL${createdRangeSql}
         GROUP BY c.id
         ORDER BY count DESC, c.label
         LIMIT 8`,
      )
      .all(...createdRangeParameters) as Array<CategoryRow & { count: number }>;
    const topClients = this.database
      .prepare(
        `SELECT c.id AS client_id, c.name AS client_name, COUNT(t.id) AS count
         FROM clients c
         JOIN tickets t ON t.client_id = c.id
         WHERE c.ignored_at IS NULL${createdRangeSql}
         GROUP BY c.id
         ORDER BY count DESC, c.name
         LIMIT 8`,
      )
      .all(...createdRangeParameters) as Array<{
      client_id: string;
      client_name: string;
      count: number;
    }>;
    const topGroups = this.database
      .prepare(
        `SELECT conversation.id AS group_id,
                conversation.subject AS group_subject,
                COUNT(t.id) AS count
         FROM tickets t
         JOIN whatsapp_groups conversation ON conversation.id = t.group_id
         JOIN clients c ON c.id = t.client_id
         WHERE c.ignored_at IS NULL${createdRangeSql}
         GROUP BY conversation.id
         ORDER BY count DESC, conversation.subject, conversation.id
         LIMIT 8`,
      )
      .all(...createdRangeParameters) as Array<{
      group_id: string;
      group_subject: string;
      count: number;
    }>;
    const directoryRecordRows = this.database
      .prepare(
        `SELECT record.id AS record_id,
                record.name AS record_name,
                record_type.id AS record_type_id,
                record_type.name AS record_type_name,
                COUNT(DISTINCT t.id) AS count
         FROM tickets t
         JOIN clients c ON c.id = t.client_id
         JOIN directory_group_links directory_link
           ON directory_link.group_id = t.group_id
          AND directory_link.archived_at IS NULL
         JOIN directory_records record
           ON record.id = directory_link.record_id
          AND record.archived_at IS NULL
         JOIN directory_record_types record_type
           ON record_type.id = record.record_type_id
          AND record_type.archived_at IS NULL
         WHERE c.ignored_at IS NULL${createdRangeSql}
         GROUP BY record.id, record_type.id
         ORDER BY count DESC, record.name, record.id`,
      )
      .all(...createdRangeParameters) as Array<{
      record_id: string;
      record_name: string;
      record_type_id: string;
      record_type_name: string;
      count: number;
    }>;
    const recordBreakdownMap = new Map<
      string,
      {
        recordTypeId: string;
        recordTypeName: string;
        items: Array<{ recordId: string; recordName: string; count: number }>;
      }
    >();
    for (const row of directoryRecordRows) {
      const breakdown = recordBreakdownMap.get(row.record_type_id) ?? {
        recordTypeId: row.record_type_id,
        recordTypeName: row.record_type_name,
        items: [],
      };
      if (breakdown.items.length < 8) {
        breakdown.items.push({
          recordId: row.record_id,
          recordName: row.record_name,
          count: row.count,
        });
      }
      recordBreakdownMap.set(row.record_type_id, breakdown);
    }
    const directoryFieldRows = this.database
      .prepare(
        `SELECT field.id AS field_id,
                field.label AS field_label,
                record_type.id AS record_type_id,
                record_type.name AS record_type_name,
                CAST(option_value.value AS TEXT) AS option_value,
                field.field_type,
                COUNT(DISTINCT t.id) AS count
         FROM tickets t
         JOIN clients c ON c.id = t.client_id
         JOIN directory_group_links directory_link
           ON directory_link.group_id = t.group_id
          AND directory_link.archived_at IS NULL
         JOIN directory_records record
           ON record.id = directory_link.record_id
          AND record.archived_at IS NULL
         JOIN directory_record_types record_type
           ON record_type.id = record.record_type_id
          AND record_type.archived_at IS NULL
         JOIN directory_field_values field_value
           ON field_value.record_id = record.id
         JOIN directory_field_definitions field
           ON field.id = field_value.field_id
          AND field.archived_at IS NULL
          AND field.field_type IN ('select', 'multi_select', 'boolean')
         JOIN json_each(
           CASE
             WHEN field.field_type = 'multi_select' THEN field_value.value_json
             ELSE json_array(json_extract(field_value.value_json, '$'))
           END
         ) option_value
         WHERE c.ignored_at IS NULL${createdRangeSql}
           AND option_value.value IS NOT NULL
         GROUP BY field.id, CAST(option_value.value AS TEXT)
         ORDER BY field.label, count DESC, option_value.value`,
      )
      .all(...createdRangeParameters) as Array<{
      field_id: string;
      field_label: string;
      record_type_id: string;
      record_type_name: string;
      option_value: string;
      field_type: "select" | "multi_select" | "boolean";
      count: number;
    }>;
    const fieldBreakdownMap = new Map<
      string,
      {
        fieldId: string;
        fieldLabel: string;
        recordTypeId: string;
        recordTypeName: string;
        items: Array<{ value: string; count: number }>;
      }
    >();
    for (const row of directoryFieldRows) {
      const breakdown = fieldBreakdownMap.get(row.field_id) ?? {
        fieldId: row.field_id,
        fieldLabel: row.field_label,
        recordTypeId: row.record_type_id,
        recordTypeName: row.record_type_name,
        items: [],
      };
      if (breakdown.items.length < 8) {
        breakdown.items.push({
          value:
            row.field_type === "boolean"
              ? row.option_value === "1"
                ? "Sim"
                : "Não"
              : row.option_value,
          count: row.count,
        });
      }
      fieldBreakdownMap.set(row.field_id, breakdown);
    }

    return {
      period,
      totals: {
        tickets: ticketTotal.count,
        open: openTotal.count,
        needsReview: reviewTotal.count,
        resolved: resolvedTotal.count,
        orphanDemands: orphanTotal.count,
        clients: clientTotal.count,
        groups: groupTotal.count,
        records: recordTotal.count,
      },
      statusCounts: TICKET_STATUSES.map((status) => ({
        status,
        count: statusMap.get(status) ?? 0,
      })),
      ticketsByDay,
      topCategories: topCategoryRows.map((row) => ({
        category: this.mapCategory(row),
        count: row.count,
      })),
      topGroups: topGroups.map((row) => ({
        groupId: row.group_id,
        groupSubject: row.group_subject,
        count: row.count,
      })),
      topRecords: directoryRecordRows.slice(0, 8).map((row) => ({
        recordId: row.record_id,
        recordName: row.record_name,
        recordTypeId: row.record_type_id,
        recordTypeName: row.record_type_name,
        count: row.count,
      })),
      recordBreakdowns: [...recordBreakdownMap.values()],
      fieldBreakdowns: [...fieldBreakdownMap.values()],
      topClients: topClients.map((row) => ({
        clientId: row.client_id,
        clientName: row.client_name,
        count: row.count,
      })),
      recentTickets: this.listTickets({
        includeArchived: Boolean(period),
        createdFromUtc: period?.fromUtc,
        createdToUtcExclusive: period?.toUtcExclusive,
        order: "created_desc",
        limit: 6,
      }).items,
    };
  }

  getDashboardExportRows(input?: DashboardPeriodInput): DashboardExportRowDto[] {
    const timeZone = this.workspaceTimeZone();
    const period = resolveDashboardPeriod(input, timeZone);
    const periodFilter = period
      ? `AND (
           (t.created_at >= ? AND t.created_at < ?)
           OR EXISTS (
             SELECT 1
             FROM ticket_events period_resolution
             WHERE period_resolution.ticket_id = t.id
               AND period_resolution.event_type IN ('ticket_created', 'status_changed')
               AND period_resolution.to_status = 'resolved'
               AND (
                 period_resolution.from_status IS NULL
                 OR period_resolution.from_status != 'archived'
               )
               AND period_resolution.occurred_at >= ?
               AND period_resolution.occurred_at < ?
           )
         )`
      : "";
    const parameters = period
      ? [
          period.fromUtc,
          period.toUtcExclusive,
          period.fromUtc,
          period.toUtcExclusive,
        ]
      : [];
    const rows = this.database
      .prepare(
        `SELECT
           t.id,
           t.number,
           t.title,
           t.summary,
           client.name AS client_name,
           client.kind AS client_kind,
           conversation.subject AS group_subject,
           store.name AS store_name,
           t.status,
           t.priority,
           t.needs_review,
           t.created_at,
           (
             SELECT MAX(resolution.occurred_at)
             FROM ticket_events resolution
             WHERE resolution.ticket_id = t.id
               AND resolution.event_type IN ('ticket_created', 'status_changed')
               AND resolution.to_status = 'resolved'
               AND (resolution.from_status IS NULL OR resolution.from_status != 'archived')
           ) AS latest_resolution_at
         FROM tickets t
         JOIN clients client ON client.id = t.client_id
         JOIN whatsapp_groups conversation ON conversation.id = t.group_id
         LEFT JOIN client_stores store ON store.id = t.affected_store_id
         WHERE client.ignored_at IS NULL
         ${periodFilter}
         ORDER BY t.created_at, t.number`,
      )
      .all(...parameters) as Array<{
      id: string;
      number: number;
      title: string;
      summary: string;
      client_name: string;
      client_kind: ClientKind;
      group_subject: string;
      store_name: string | null;
      status: TicketStatus;
      priority: TicketPriority;
      needs_review: number;
      created_at: string;
      latest_resolution_at: string | null;
    }>;
    const resolvedInPeriod = period
      ? this.database.prepare(
          `SELECT EXISTS (
             SELECT 1
             FROM ticket_events resolution
             WHERE resolution.ticket_id = ?
               AND resolution.event_type IN ('ticket_created', 'status_changed')
               AND resolution.to_status = 'resolved'
               AND (resolution.from_status IS NULL OR resolution.from_status != 'archived')
               AND resolution.occurred_at >= ?
               AND resolution.occurred_at < ?
           ) AS matches_period`,
        )
      : null;

    return rows.map((row) => ({
      ticketId: row.id,
      ticketNumber: row.number,
      title: row.title,
      summary: row.summary,
      clientName: row.client_name,
      clientKind: row.client_kind,
      groupSubject: row.group_subject,
      affectedStoreName: row.store_name,
      status: row.status,
      priority: row.priority,
      needsReview: Boolean(row.needs_review),
      categories: this.getTicketCategories(row.id).map((category) => category.label),
      createdAt: row.created_at,
      createdAtSaoPaulo: dashboardDateTimeInTimeZone(row.created_at, timeZone),
      latestResolutionAt: row.latest_resolution_at,
      latestResolutionAtSaoPaulo: row.latest_resolution_at
        ? dashboardDateTimeInTimeZone(row.latest_resolution_at, timeZone)
        : null,
      createdInPeriod:
        !period ||
        (row.created_at >= period.fromUtc && row.created_at < period.toUtcExclusive),
      resolvedInPeriod: period
        ? Boolean(
            (
              resolvedInPeriod?.get(
                row.id,
                period.fromUtc,
                period.toUtcExclusive,
              ) as { matches_period: number }
            ).matches_period,
          )
        : Boolean(row.latest_resolution_at),
    }));
  }

  private workspaceTimeZone(): string {
    const row = this.database
      .prepare(
        `SELECT timezone
         FROM local_app_settings
         WHERE singleton = 1`,
      )
      .get() as { timezone: string } | undefined;
    const timeZone = row?.timezone?.trim() || DASHBOARD_TIME_ZONE;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone }).format();
      return timeZone;
    } catch {
      return DASHBOARD_TIME_ZONE;
    }
  }

  listOperationalGroups(): OperationalGroupDto[] {
    const rows = this.database
      .prepare(
        `SELECT
          g.id,
          g.subject,
          g.external_jid,
          g.monitored,
          g.history_oldest_at,
          g.history_newest_at,
          g.history_complete,
          c.id AS client_id,
          c.name AS client_name,
          c.kind AS client_kind,
          (SELECT COUNT(*) FROM messages m WHERE m.group_id = g.id) AS message_count,
          (SELECT COUNT(*) FROM tickets t
           WHERE t.group_id = g.id AND t.status NOT IN ('resolved', 'archived')) AS open_ticket_count,
          (SELECT MAX(m.occurred_at) FROM messages m WHERE m.group_id = g.id) AS last_message_at
         FROM whatsapp_groups g
         JOIN clients c ON c.id = g.client_id
         WHERE c.ignored_at IS NULL
         ORDER BY g.monitored DESC, last_message_at DESC, g.subject`,
      )
      .all() as Array<{
      id: string;
      subject: string;
      external_jid: string;
      monitored: number;
      history_oldest_at: string | null;
      history_newest_at: string | null;
      history_complete: number;
      client_id: string;
      client_name: string;
      client_kind: ClientKind;
      message_count: number;
      open_ticket_count: number;
      last_message_at: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      subject: row.subject,
      externalJid: row.external_jid,
      client: {
        id: row.client_id,
        name: row.client_name,
        kind: row.client_kind,
      },
      monitored: Boolean(row.monitored),
      messageCount: row.message_count,
      openTicketCount: row.open_ticket_count,
      lastMessageAt: row.last_message_at,
      historyOldestAt: row.history_oldest_at,
      historyNewestAt: row.history_newest_at,
      historyComplete: Boolean(row.history_complete),
    }));
  }

  listInvestigationJobs(
    filters: InvestigationJobListFilters = {},
  ): InvestigationJobListResponse {
    const requestedLimit = filters.limit ?? 50;
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
      throw new ValidationError("limit deve ser um inteiro positivo");
    }
    const limit = Math.min(requestedLimit, 200);
    const states = filters.states?.length
      ? [...new Set(filters.states)]
      : undefined;
    const invalidStates = states?.filter(
      (state) => !INVESTIGATION_JOB_STATES.includes(state),
    );
    if (invalidStates?.length) {
      throw new ValidationError(
        `Estado de investigação inválido: ${invalidStates.join(", ")}`,
      );
    }
    const where = states
      ? `WHERE c.ignored_at IS NULL AND j.state IN (${states.map(() => "?").join(", ")})`
      : "WHERE c.ignored_at IS NULL";
    const rows = this.database
      .prepare(
        `SELECT
          j.id,
          j.ticket_id,
          t.number AS ticket_number,
          t.title AS ticket_title,
          c.name AS client_name,
          j.state,
          j.instructions,
          j.requested_at,
          j.started_at,
          j.finished_at,
          j.attempt_count,
          j.error
         FROM investigation_jobs j
         JOIN tickets t ON t.id = j.ticket_id
         JOIN clients c ON c.id = t.client_id
         ${where}
         ORDER BY
           CASE j.state WHEN 'running' THEN 0 WHEN 'queued' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END,
           COALESCE(j.started_at, j.requested_at) DESC
         LIMIT ?`,
      )
      .all(...(states ?? []), limit) as Array<{
      id: string;
      ticket_id: string;
      ticket_number: number;
      ticket_title: string;
      client_name: string;
      state: InvestigationJobState;
      instructions: string | null;
      requested_at: string;
      started_at: string | null;
      finished_at: string | null;
      attempt_count: number;
      error: string | null;
    }>;
    const rawCounts = this.database
      .prepare(
        `SELECT j.state, COUNT(*) AS count
         FROM investigation_jobs j
         JOIN tickets t ON t.id = j.ticket_id
         JOIN clients c ON c.id = t.client_id
         WHERE c.ignored_at IS NULL
         GROUP BY j.state`,
      )
      .all() as Array<{ state: InvestigationJobState; count: number }>;
    const countMap = new Map(rawCounts.map((item) => [item.state, item.count]));

    return {
      items: rows.map((row) => ({
        id: row.id,
        ticketId: row.ticket_id,
        ticketNumber: row.ticket_number,
        ticketTitle: row.ticket_title,
        clientName: row.client_name,
        state: row.state,
        instructions: row.instructions,
        requestedAt: row.requested_at,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        attemptCount: row.attempt_count,
        error: row.error,
      })),
      counts: INVESTIGATION_JOB_STATES.map((state) => ({
        state,
        count: countMap.get(state) ?? 0,
      })),
    };
  }

  listClients(): ClientSummaryDto[] {
    const rows = this.database
      .prepare(
        `SELECT
          c.id,
          c.name,
          c.kind,
          c.identification_pending,
          c.slug,
          c.notes,
          (SELECT COUNT(DISTINCT COALESCE(
             identity_link.phone_jid,
             NULLIF(participant.phone_e164, ''),
             participant.external_jid
           ))
           FROM whatsapp_groups participant_group
           JOIN group_participants gp ON gp.group_id = participant_group.id
           JOIN participants participant ON participant.id = gp.participant_id
           LEFT JOIN whatsapp_identity_links identity_link
             ON identity_link.phone_jid = participant.external_jid
             OR identity_link.lid_jid = participant.external_jid
           WHERE participant_group.client_id = c.id
             AND participant_group.external_jid LIKE '%@g.us'
             AND gp.active = 1) AS participant_count,
          (SELECT COUNT(*) FROM tickets t WHERE t.client_id = c.id) AS ticket_count,
          (SELECT COUNT(*) FROM tickets t
           WHERE t.client_id = c.id AND t.status NOT IN ('resolved', 'archived')) AS open_ticket_count,
          (SELECT MAX(m.occurred_at)
           FROM whatsapp_groups activity_group
           JOIN messages m ON m.group_id = activity_group.id
           WHERE activity_group.client_id = c.id) AS last_activity_at
         FROM clients c
         WHERE c.ignored_at IS NULL
           AND (
             c.identification_pending = 1
             OR EXISTS (
               SELECT 1 FROM whatsapp_groups visible_group
               WHERE visible_group.client_id = c.id
                 AND visible_group.external_jid LIKE '%@g.us'
             )
             OR EXISTS (
               SELECT 1 FROM tickets visible_ticket
               WHERE visible_ticket.client_id = c.id
             )
           )
         ORDER BY c.name`,
      )
      .all() as Array<{
      id: string;
      name: string;
      kind: ClientKind;
      identification_pending: number;
      slug: string;
      notes: string | null;
      participant_count: number;
      ticket_count: number;
      open_ticket_count: number;
      last_activity_at: string | null;
    }>;

    const groupStatement = this.database.prepare(
      "SELECT id, subject, external_jid FROM whatsapp_groups WHERE client_id = ? ORDER BY subject",
    );
    const storeStatement = this.database.prepare(
      `SELECT id, name, business_id, platform
       FROM client_stores
       WHERE client_id = ? AND active = 1
       ORDER BY name`,
    );

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      isUnidentified: Boolean(row.identification_pending),
      slug: row.slug,
      notes: row.notes,
      groups: (groupStatement.all(row.id) as Array<{
        id: string;
        subject: string;
        external_jid: string;
      }>).map((group) => ({
        id: group.id,
        subject: group.subject,
        externalJid: group.external_jid,
      })),
      stores: (storeStatement.all(row.id) as Array<{
        id: string;
        name: string;
        business_id: string | null;
        platform: string | null;
      }>).map((store) => ({
        id: store.id,
        name: store.name,
        businessId: store.business_id,
        platform: store.platform,
      })),
      participantCount: row.participant_count,
      ticketCount: row.ticket_count,
      openTicketCount: row.open_ticket_count,
      lastActivityAt: row.last_activity_at,
    }));
  }

  getRuntimeStatus(): RuntimeStatusDto {
    const row = this.database
      .prepare(
        `SELECT state, started_at, last_heartbeat_at, last_sync_at,
                connected_account, last_error
         FROM runtime_state WHERE singleton = 1`,
      )
      .get() as
      | {
          state: RuntimeStatusDto["state"];
          started_at: string | null;
          last_heartbeat_at: string | null;
          last_sync_at: string | null;
          connected_account: string | null;
          last_error: string | null;
        }
      | undefined;
    const counts = readRuntimeCounts(this.database);

    return {
      state: row?.state ?? "offline",
      pid: null,
      startedAt: row?.started_at ?? null,
      lastHeartbeatAt: row?.last_heartbeat_at ?? null,
      lastSyncAt: row?.last_sync_at ?? null,
      connectedAccount: row?.connected_account ?? null,
      whatsappConnected: row?.state === "online" || row?.state === "syncing",
      qrAvailable: false,
      groupsDiscovered: counts.groupsDiscovered,
      groupsSynced: counts.groupsSynced,
      privateConversations: counts.privateConversations,
      messagesStored: counts.messagesStored,
      ticketsCreated: counts.ticketsCreated,
      monitoredGroups: counts.monitoredGroups,
      lastError: row?.last_error ?? null,
    };
  }

  setRuntimeStatus(
    input: Omit<
      RuntimeStatusDto,
      | "monitoredGroups"
      | "pid"
      | "whatsappConnected"
      | "qrAvailable"
      | "groupsDiscovered"
      | "groupsSynced"
      | "privateConversations"
      | "messagesStored"
      | "ticketsCreated"
    >,
  ): void {
    const timestamp = nowUtc();
    this.database
      .prepare(
        `INSERT INTO runtime_state
          (singleton, state, started_at, last_heartbeat_at, last_sync_at,
           connected_account, last_error, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
          state = excluded.state,
          started_at = excluded.started_at,
          last_heartbeat_at = excluded.last_heartbeat_at,
          last_sync_at = excluded.last_sync_at,
          connected_account = excluded.connected_account,
          last_error = excluded.last_error,
          updated_at = excluded.updated_at`,
      )
      .run(
        input.state,
        input.startedAt,
        input.lastHeartbeatAt,
        input.lastSyncAt,
        input.connectedAccount,
        input.lastError,
        timestamp,
      );
  }

  private assertEntityExists(label: string, table: string, id: string): void {
    const allowedTables = new Set([
      "whatsapp_accounts",
      "clients",
      "whatsapp_groups",
      "participants",
      "messages",
      "tickets",
    ]);
    if (!allowedTables.has(table)) {
      throw new Error(`Tabela não permitida em assertEntityExists: ${table}`);
    }
    const found = this.database.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id);
    if (!found) {
      throw new NotFoundError(label, id);
    }
  }

  private isActiveStaff(participantId: string): boolean {
    return Boolean(
      this.database
        .prepare("SELECT 1 FROM staff_members WHERE participant_id = ? AND active = 1")
        .get(participantId),
    );
  }

  private getMessageContext(messageId: string): {
    groupId: string;
    occurredAt: string;
    isStaff: boolean;
  } {
    const row = this.database
      .prepare(
        `SELECT m.group_id, m.occurred_at,
          CASE WHEN staff.participant_id IS NULL THEN 0 ELSE 1 END AS is_staff
         FROM messages m
         LEFT JOIN staff_members staff
          ON staff.participant_id = m.sender_id AND staff.active = 1
         WHERE m.id = ?`,
      )
      .get(messageId) as
      | { group_id: string; occurred_at: string; is_staff: number }
      | undefined;
    if (!row) {
      throw new NotFoundError("Mensagem", messageId);
    }
    return {
      groupId: row.group_id,
      occurredAt: row.occurred_at,
      isStaff: Boolean(row.is_staff),
    };
  }

  private attachMessageToTicketInternal(
    ticketId: string,
    messageId: string,
    addedAt: string,
  ): boolean {
    const ticket = this.database
      .prepare("SELECT group_id FROM tickets WHERE id = ?")
      .get(ticketId) as { group_id: string } | undefined;
    if (!ticket) {
      throw new NotFoundError("Ticket", ticketId);
    }
    const message = this.getMessageContext(messageId);
    if (message.groupId !== ticket.group_id) {
      throw new ValidationError("A mensagem não pertence ao grupo do ticket", { messageId });
    }

    const insert = this.database
      .prepare(
        `INSERT INTO ticket_messages (ticket_id, message_id, added_at)
         VALUES (?, ?, ?)
         ON CONFLICT(ticket_id, message_id) DO NOTHING`,
      )
      .run(ticketId, messageId, addedAt);
    if (!insert.changes) return false;
    this.database
      .prepare(
        `UPDATE messages
         SET triage_state = CASE WHEN ? THEN 'context' ELSE 'ticketed' END,
             triage_kind = CASE WHEN ? THEN 'context' ELSE triage_kind END,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(message.isStaff ? 1 : 0, message.isStaff ? 1 : 0, addedAt, messageId);
    this.database
      .prepare(
        `UPDATE tickets
         SET first_message_at = CASE WHEN first_message_at > ? THEN ? ELSE first_message_at END,
             last_message_at = CASE WHEN last_message_at < ? THEN ? ELSE last_message_at END,
             updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END
         WHERE id = ?`,
      )
      .run(
        message.occurredAt,
        message.occurredAt,
        message.occurredAt,
        message.occurredAt,
        addedAt,
        addedAt,
        ticketId,
      );
    return true;
  }

  private captureStaffResponseInternal(
    messageId: string,
    source: "realtime" | "history",
  ): HistoricalStaffResponseCaptureResult | null {
    const message = this.database
      .prepare(
        `SELECT m.id, m.group_id, m.text, m.occurred_at, m.quoted_external_id,
                participant.external_jid AS sender_external_jid,
                CASE WHEN staff.participant_id IS NULL THEN 0 ELSE 1 END AS is_staff
         FROM messages m
         JOIN participants participant ON participant.id = m.sender_id
         LEFT JOIN staff_members staff
           ON staff.participant_id = m.sender_id AND staff.active = 1
         WHERE m.id = ?`,
      )
      .get(messageId) as StaffResponseMessageRow | undefined;
    if (!message) throw new NotFoundError("Mensagem", messageId);
    if (!message.is_staff) {
      throw new ValidationError(
        "Somente mensagem de funcionário pode ser capturada como resposta",
      );
    }

    const targetTicketId = this.resolveStaffResponseTicket(message);
    if (!targetTicketId) return null;

    return this.database.transaction(() => {
      const capturedAt = nowUtc();
      const invalidatesCurrentCandidate =
        source === "realtime" ||
        this.historicalStaffResponseInvalidatesCurrentCandidate(
          targetTicketId,
          message,
        );
      const attached = this.attachMessageToTicketInternal(
        targetTicketId,
        message.id,
        capturedAt,
      );
      const capture = this.captureAttachedStaffMessage(
        targetTicketId,
        message.id,
        capturedAt,
        invalidatesCurrentCandidate,
      );
      if (attached) {
        this.insertTicketEvent({
          ticketId: targetTicketId,
          eventType: "message_attached",
          actor: "whatsapp-capture",
          fromStatus: null,
          toStatus: null,
          data: { messageId: message.id },
          occurredAt: capturedAt,
        });
      }
      return {
        ticketId: targetTicketId,
        responseCaptured: capture.responseCaptured,
        reanalysisRequired:
          source === "history" &&
          capture.newlyCaptured &&
          invalidatesCurrentCandidate,
      };
    })();
  }

  private resolveStaffResponseTicket(
    message: StaffResponseMessageRow,
  ): string | null {
    if (message.quoted_external_id) {
      const quotedTargets = this.database
        .prepare(
          `SELECT DISTINCT ticket.id
           FROM messages quoted
           JOIN ticket_messages ticket_message
             ON ticket_message.message_id = quoted.id
           JOIN tickets ticket ON ticket.id = ticket_message.ticket_id
           WHERE quoted.group_id = ?
             AND quoted.provider_message_id = ?
             AND ticket.status NOT IN ('resolved', 'archived')
           LIMIT 2`,
        )
        .all(message.group_id, message.quoted_external_id) as Array<{
        id: string;
      }>;
      return quotedTargets.length === 1 ? quotedTargets[0]?.id ?? null : null;
    }

    return null;
  }

  private historicalStaffResponseInvalidatesCurrentCandidate(
    ticketId: string,
    message: StaffResponseMessageRow,
  ): boolean {
    const candidate = this.database
      .prepare(
        `SELECT body, created_at
         FROM suggestions
         WHERE ticket_id = ? AND status = 'candidate'
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(ticketId) as
      | { body: string; created_at: string }
      | undefined;
    if (!candidate) return false;
    const sentAt = Date.parse(message.occurred_at);
    const candidateCreatedAt = Date.parse(candidate.created_at);
    if (
      Number.isFinite(sentAt) &&
      Number.isFinite(candidateCreatedAt) &&
      sentAt >= candidateCreatedAt
    ) {
      return true;
    }
    return Boolean(
      message.text && exactResponseBodiesMatch(message.text, candidate.body),
    );
  }

  private captureAttachedStaffMessage(
    ticketId: string,
    messageId: string,
    capturedAt: string,
    supersedeCandidatesOnCapture = true,
  ): AttachedStaffCaptureResult {
    const message = this.database
      .prepare(
        `SELECT message.text, message.occurred_at,
                CASE WHEN staff.participant_id IS NULL THEN 0 ELSE 1 END AS is_staff,
                EXISTS (
                  SELECT 1 FROM attachments attachment
                  WHERE attachment.message_id = message.id
                    AND attachment.available = 1
                ) AS has_attachment
         FROM messages message
         LEFT JOIN staff_members staff
           ON staff.participant_id = message.sender_id AND staff.active = 1
         WHERE message.id = ?`,
      )
      .get(messageId) as
      | {
          text: string | null;
          occurred_at: string;
          is_staff: number;
          has_attachment: number;
        }
      | undefined;
    if (!message?.is_staff) {
      return { responseCaptured: false, newlyCaptured: false };
    }

    const body = message.text?.trim() || null;
    if (!body && !message.has_attachment) {
      return { responseCaptured: false, newlyCaptured: false };
    }
    let newlyCaptured = false;
    if (body) {
      const existing = this.database
        .prepare(
          `SELECT body, sent_at FROM sent_responses
           WHERE ticket_id = ? AND message_id = ?`,
        )
        .get(ticketId, messageId) as
        | { body: string; sent_at: string }
        | undefined;
      if (!existing || existing.body !== body || existing.sent_at !== message.occurred_at) {
        this.recordSentResponse({
          ticketId,
          messageId,
          body,
          sentAt: message.occurred_at,
          capturedAt,
        });
        newlyCaptured = true;
      }
    } else {
      const alreadyCaptured = Boolean(
        this.database
          .prepare(
            `SELECT 1 FROM ticket_events
             WHERE ticket_id = ?
               AND event_type = 'staff_response_captured'
               AND json_extract(data_json, '$.messageId') = ?
               AND json_extract(data_json, '$.responseKind') = 'attachment'
             LIMIT 1`,
          )
          .get(ticketId, messageId),
      );
      if (!alreadyCaptured) {
        this.insertTicketEvent({
          ticketId,
          eventType: "staff_response_captured",
          actor: "system",
          fromStatus: null,
          toStatus: null,
          data: {
            messageId,
            responseKind: "attachment",
          },
          occurredAt: capturedAt,
        });
        newlyCaptured = true;
      }
    }

    if (!newlyCaptured) {
      return { responseCaptured: true, newlyCaptured: false };
    }
    if (supersedeCandidatesOnCapture) {
      this.invalidateLegacyAutomaticGuidance(ticketId, capturedAt);
    }
    return { responseCaptured: true, newlyCaptured: true };
  }

  private captureAvailableStaffAttachmentResponses(
    messageId: string,
    capturedAt: string,
  ): void {
    const tickets = this.database
      .prepare(
        `SELECT ticket.id
         FROM ticket_messages ticket_message
         JOIN tickets ticket ON ticket.id = ticket_message.ticket_id
         JOIN messages message ON message.id = ticket_message.message_id
         JOIN staff_members staff
           ON staff.participant_id = message.sender_id AND staff.active = 1
         WHERE ticket_message.message_id = ?
           AND ticket.status NOT IN ('resolved', 'archived')
           AND (message.text IS NULL OR trim(message.text) = '')
           AND EXISTS (
             SELECT 1 FROM attachments attachment
             WHERE attachment.message_id = message.id
               AND attachment.available = 1
           )`,
      )
      .all(messageId) as EntityRecord[];
    for (const ticket of tickets) {
      this.captureAttachedStaffMessage(
        ticket.id,
        messageId,
        capturedAt,
      );
    }
  }

  private invalidateTicketsForMaterialAttachment(
    messageId: string,
    updatedAt: string,
  ): void {
    const tickets = this.database
      .prepare(
        `SELECT ticket.id
         FROM ticket_messages ticket_message
         JOIN tickets ticket ON ticket.id = ticket_message.ticket_id
         WHERE ticket_message.message_id = ?
           AND ticket.status NOT IN ('resolved', 'archived')`,
      )
      .all(messageId) as EntityRecord[];
    for (const ticket of tickets) {
      this.invalidateLegacyAutomaticGuidance(ticket.id, updatedAt);
    }
  }

  private addTicketCategoryInternal(
    ticketId: string,
    categoryId: string,
    source: "ai" | "manual" | "rule",
    confidence: number | null,
    addedAt: string,
  ): void {
    const category = this.database.prepare("SELECT id FROM categories WHERE id = ?").get(categoryId);
    if (!category) {
      throw new NotFoundError("Categoria", categoryId);
    }
    this.database
      .prepare(
        `INSERT INTO ticket_categories
          (ticket_id, category_id, source, confidence, added_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(ticket_id, category_id) DO UPDATE SET
          source = CASE
            WHEN ticket_categories.source = 'manual' OR excluded.source = 'manual'
              THEN 'manual'
            WHEN ticket_categories.source = 'rule' OR excluded.source = 'rule'
              THEN 'rule'
            ELSE 'ai'
          END,
          confidence = CASE
            WHEN ticket_categories.source = 'manual' AND excluded.source <> 'manual'
              THEN ticket_categories.confidence
            WHEN ticket_categories.source = 'rule' AND excluded.source = 'ai'
              THEN ticket_categories.confidence
            ELSE excluded.confidence
          END,
          added_at = CASE
            WHEN ticket_categories.source = 'manual' AND excluded.source <> 'manual'
              THEN ticket_categories.added_at
            WHEN ticket_categories.source = 'rule' AND excluded.source = 'ai'
              THEN ticket_categories.added_at
            ELSE excluded.added_at
          END`,
      )
      .run(ticketId, categoryId, source, confidence, addedAt);
  }

  private deleteOrphanCategories(categoryIds: string[]): void {
    const ids = [...new Set(categoryIds.filter(Boolean))];
    if (!ids.length) return;
    const placeholders = ids.map(() => "?").join(", ");
    this.database
      .prepare(
        `DELETE FROM categories
         WHERE id IN (${placeholders})
           AND origin <> 'manual'
           AND NOT EXISTS (
             SELECT 1 FROM ticket_categories remaining
             WHERE remaining.category_id = categories.id
           )`,
      )
      .run(...ids);
  }

  private requireTicketInternalNoteEvent(
    ticketId: string,
    noteId: string,
  ): {
    id: string;
    ticket_id: string;
    event_type: string;
    data_json: string;
    occurred_at: string;
  } {
    const event = this.database
      .prepare(
        `SELECT id, ticket_id, event_type, data_json, occurred_at
         FROM ticket_events
         WHERE id = ?`,
      )
      .get(noteId) as
      | {
          id: string;
          ticket_id: string;
          event_type: string;
          data_json: string;
          occurred_at: string;
        }
      | undefined;
    if (!event || event.ticket_id !== ticketId) {
      throw new NotFoundError("Nota interna", noteId);
    }
    if (event.event_type !== "internal_note_added") {
      throw new ValidationError("O evento informado não é uma nota interna", {
        ticketId,
        noteId,
        eventType: event.event_type,
      });
    }
    return event;
  }

  private insertTicketEvent(input: {
    id?: string;
    ticketId: string;
    eventType: string;
    actor: string;
    fromStatus: TicketStatus | null;
    toStatus: TicketStatus | null;
    data: Record<string, unknown>;
    occurredAt: string;
  }): boolean {
    const description =
      typeof input.data.description === "string" && input.data.description.trim()
        ? input.data.description.trim()
        : describeTicketEvent(input);
    const insertVerb = input.id ? "INSERT OR IGNORE" : "INSERT";
    const result = this.database
      .prepare(
        `${insertVerb} INTO ticket_events
          (id, ticket_id, event_type, actor, from_status, to_status, data_json, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id ?? randomUUID(),
        input.ticketId,
        input.eventType,
        input.actor,
        input.fromStatus,
        input.toStatus,
        JSON.stringify({ ...input.data, description }),
        input.occurredAt,
      );
    return result.changes > 0;
  }

  private mapTicketSummary(row: TicketSummaryRow): TicketSummaryDto {
    return {
      id: row.id,
      number: row.number,
      title: row.title,
      summary: row.summary,
      status: row.status,
      priority: row.priority,
      confidence: row.confidence,
      needsReview: Boolean(row.needs_review),
      relation: row.ai_relation,
      nextAction: row.next_action,
      client: {
        id: row.client_id,
        name: row.client_name,
        kind: row.client_kind,
        isUnidentified: Boolean(row.client_identification_pending),
      },
      group: {
        id: row.group_id,
        subject: row.group_subject,
        externalJid: row.group_external_jid,
      },
      requester:
        row.requester_id && row.requester_display_name
          ? {
              id: row.requester_id,
              displayName: row.requester_display_name,
              phoneE164: row.requester_phone_e164,
            }
          : null,
      assignee:
        row.assignee_user_id && row.assignee_display_name && row.assignee_role
          ? {
              id: row.assignee_user_id,
              displayName: row.assignee_display_name,
              role: row.assignee_role,
            }
          : null,
      affectedStore: row.store_id
        ? {
            id: row.store_id,
            name: row.store_name as string,
            businessId: row.store_business_id,
            platform: row.store_platform,
          }
        : null,
      productForwarding: this.getTicketProductForwardingSummary(row.id),
      categories: this.getTicketCategories(row.id),
      firstMessageAt: row.first_message_at,
      lastMessageAt: row.last_message_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      resolvedAt: row.resolved_at,
      archivedAt: row.archived_at,
      messageCount: row.message_count,
      latestSuggestion:
        row.suggestion_id && row.suggestion_confidence !== null && row.suggestion_status
          ? {
              id: row.suggestion_id,
              confidence: row.suggestion_confidence,
              status: row.suggestion_status,
            }
          : null,
    };
  }

  private getTicketProductForwarding(
    ticketId: string,
  ): TicketProductForwardingDto | null {
    if (!this.productForwardingSchemaAvailable) {
      this.productForwardingSchemaAvailable = Boolean(
        this.database
          .prepare(
            `SELECT 1
             FROM sqlite_master
             WHERE type = 'table' AND name = 'ticket_product_forwardings'`,
          )
          .get(),
      );
    }
    if (!this.productForwardingSchemaAvailable) return null;

    const row = this.database
      .prepare(
        `SELECT kind, title, description, external_reference,
                created_by, updated_by, created_at, updated_at
         FROM ticket_product_forwardings
         WHERE ticket_id = ?`,
      )
      .get(ticketId) as
      | {
          kind: TicketProductForwardingDto["kind"];
          title: string;
          description: string;
          external_reference: string | null;
          created_by: string;
          updated_by: string;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (!row) return null;

    return {
      kind: row.kind,
      title: row.title,
      description: row.description,
      externalReference: row.external_reference,
      createdBy: row.created_by,
      updatedBy: row.updated_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private getTicketProductForwardingSummary(
    ticketId: string,
  ): TicketProductForwardingSummaryDto | null {
    const forwarding = this.getTicketProductForwarding(ticketId);
    if (!forwarding) return null;
    return {
      kind: forwarding.kind,
      title: forwarding.title,
      externalReference: forwarding.externalReference,
      updatedAt: forwarding.updatedAt,
    };
  }

  private getTicketCategories(ticketId: string): CategoryDto[] {
    const rows = this.database
      .prepare(
        `SELECT c.id, c.facet, c.slug, c.label, c.color
         FROM ticket_categories tc
         JOIN categories c ON c.id = tc.category_id
         WHERE tc.ticket_id = ?
         ORDER BY c.facet, c.label`,
      )
      .all(ticketId) as CategoryRow[];
    return rows.map((row) => this.mapCategory(row));
  }

  private mapCategory(row: CategoryRow): CategoryDto {
    return {
      id: row.id,
      facet: row.facet,
      slug: row.slug,
      label: row.label,
      color: row.color,
    };
  }

  private mapCategoryCatalog(row: CategoryCatalogRow): CategoryCatalogDto {
    return {
      ...this.mapCategory(row),
      ticketCount: row.ticket_count,
    };
  }

  private countCategoryTickets(categoryId: string): number {
    const row = this.database
      .prepare(
        "SELECT COUNT(DISTINCT ticket_id) AS count FROM ticket_categories WHERE category_id = ?",
      )
      .get(categoryId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  private getTimeline(ticketId: string): TimelineItemDto[] {
    const messageRows = this.database
      .prepare(
        `SELECT
          m.id,
          m.rowid AS message_rowid,
          m.external_id,
          m.occurred_at,
          m.text,
          m.message_type,
          m.raw_json,
          ticket.group_id,
          CASE WHEN ticket.source_message_id = m.id THEN 0 ELSE 1 END AS can_detach,
          p.id AS sender_id,
          p.display_name,
          p.phone_e164,
          CASE WHEN staff.participant_id IS NULL THEN 0 ELSE 1 END AS is_staff
         FROM ticket_messages tm
         JOIN messages m ON m.id = tm.message_id
         JOIN tickets ticket ON ticket.id = tm.ticket_id
         JOIN participants p ON p.id = m.sender_id
         LEFT JOIN staff_members staff
          ON staff.participant_id = p.id AND staff.active = 1
         WHERE tm.ticket_id = ?`,
      )
      .all(ticketId) as Array<{
      id: string;
      message_rowid: number;
      external_id: string;
      occurred_at: string;
      text: string | null;
      message_type: string;
      raw_json: string | null;
      group_id: string;
      can_detach: number;
      sender_id: string;
      display_name: string;
      phone_e164: string | null;
      is_staff: number;
    }>;
    const hasAudioTranscriptions = databaseHasTable(
      this.database,
      "audio_transcriptions",
    );
    const attachmentRows = this.database
      .prepare(
        `SELECT
           a.message_id,
           a.id,
           a.kind,
           a.mime_type,
           a.file_name,
           a.local_path,
           a.size_bytes,
           a.sha256,
           a.extracted_text,
           a.available,
           ${hasAudioTranscriptions
             ? `transcription.status AS transcription_status,
                transcription.text AS transcription_text,
                transcription.language AS transcription_language,
                transcription.confidence AS transcription_confidence,
                transcription.model_id AS transcription_model_id,
                transcription.error AS transcription_error,
                transcription.updated_at AS transcription_updated_at`
             : `NULL AS transcription_status,
                NULL AS transcription_text,
                NULL AS transcription_language,
                NULL AS transcription_confidence,
                NULL AS transcription_model_id,
                NULL AS transcription_error,
                NULL AS transcription_updated_at`}
         FROM attachments a
         JOIN ticket_messages tm ON tm.message_id = a.message_id
         ${hasAudioTranscriptions
           ? `LEFT JOIN audio_transcriptions transcription
                ON transcription.attachment_id = a.id`
           : ""}
         WHERE tm.ticket_id = ?
         ORDER BY a.created_at, a.id`,
      )
      .all(ticketId) as Array<{
      message_id: string;
      id: string;
      kind: AttachmentDto["kind"];
      mime_type: string;
      file_name: string | null;
      local_path: string;
      size_bytes: number | null;
      sha256: string;
      extracted_text: string | null;
      available: number;
      transcription_status: NonNullable<AttachmentDto["transcription"]>["status"] | null;
      transcription_text: string | null;
      transcription_language: string | null;
      transcription_confidence: number | null;
      transcription_model_id: string | null;
      transcription_error: string | null;
      transcription_updated_at: string | null;
    }>;
    const attachmentsByMessage = new Map<string, AttachmentDto[]>();
    for (const attachment of attachmentRows) {
      const current = attachmentsByMessage.get(attachment.message_id) ?? [];
      current.push({
        id: attachment.id,
        kind: attachment.kind,
        mimeType: attachment.mime_type,
        fileName: attachment.file_name,
        url: attachment.available ? `/api/attachments/${attachment.id}` : null,
        sizeBytes: attachment.size_bytes,
        sha256: attachment.sha256,
        extractedText: attachment.extracted_text,
        available: Boolean(attachment.available),
        transcription:
          attachment.transcription_status &&
          attachment.transcription_language &&
          attachment.transcription_model_id &&
          attachment.transcription_updated_at
            ? {
                status: attachment.transcription_status,
                text: attachment.transcription_text,
                language: attachment.transcription_language,
                confidence: attachment.transcription_confidence,
                modelId: attachment.transcription_model_id,
                error: attachment.transcription_error,
                updatedAt: attachment.transcription_updated_at,
              }
            : null,
      });
      attachmentsByMessage.set(attachment.message_id, current);
    }
    const ticketGroupId = messageRows[0]?.group_id ?? null;
    const mentionNames = ticketGroupId
      ? this.resolveMentionDisplayNames(
          ticketGroupId,
          messageRows.map((row) => row.raw_json),
        )
      : new Map<string, string>();
    const messages: TimelineMessageDto[] = messageRows.map((row) => ({
      type: "message",
      id: row.id,
      externalId: row.external_id,
      occurredAt: row.occurred_at,
      sender: {
        id: row.sender_id,
        displayName: row.display_name,
        phoneE164: row.phone_e164,
        isStaff: Boolean(row.is_staff),
      },
      text: presentMessageText(row.text, row.raw_json, mentionNames),
      messageType: row.message_type,
      canDetach: Boolean(row.can_detach),
      attachments: attachmentsByMessage.get(row.id) ?? [],
    }));
    const messageOrderById = new Map(
      messageRows.map((row) => [row.id, row.message_rowid]),
    );

    const events = (this.database
      .prepare(
        `SELECT id, event_type, actor, from_status, to_status, data_json, occurred_at
         FROM ticket_events WHERE ticket_id = ?`,
      )
      .all(ticketId) as Array<{
      id: string;
      event_type: string;
      actor: string;
      from_status: TicketStatus | null;
      to_status: TicketStatus | null;
      data_json: string;
      occurred_at: string;
    }>).flatMap<TimelineEventDto>((row) => {
      const persistedData = parseJson<Record<string, unknown>>(row.data_json, {});
      if (
        row.event_type === "internal_note_added" &&
        typeof persistedData.deletedAt === "string"
      ) {
        return [];
      }
      const persistedDescription = persistedData.description;
      const description =
        typeof persistedDescription === "string" && persistedDescription.trim()
          ? persistedDescription.trim()
          : describeTicketEvent({
              eventType: row.event_type,
              actor: row.actor,
              fromStatus: row.from_status,
              toStatus: row.to_status,
            });
      const metadata = { ...persistedData };
      delete metadata.description;
      return [{
        type: "event",
        id: row.id,
        occurredAt: row.occurred_at,
        eventType: row.event_type,
        description,
        actor: row.actor,
        fromStatus: row.from_status,
        toStatus: row.to_status,
        metadata,
        data: metadata,
      }];
    });

    return [...messages, ...events].sort((left, right) => {
      const occurredAtOrder = left.occurredAt.localeCompare(right.occurredAt);
      if (occurredAtOrder !== 0) return occurredAtOrder;

      const typeOrder = left.type.localeCompare(right.type);
      if (typeOrder !== 0) return typeOrder;

      if (left.type === "message" && right.type === "message") {
        const leftOrder = messageOrderById.get(left.id);
        const rightOrder = messageOrderById.get(right.id);
        if (leftOrder !== undefined && rightOrder !== undefined) {
          return leftOrder - rightOrder;
        }
      }
      return 0;
    });
  }

  private getSuggestion(id: string): SuggestionDto {
    const row = this.database
      .prepare(
        `SELECT id, body, confidence, evidence_json, missing_information_json,
                status, model, prompt_version, created_at
         FROM suggestions WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string;
          body: string;
          confidence: number;
          evidence_json: string;
          missing_information_json: string;
          status: SuggestionDto["status"];
          model: string | null;
          prompt_version: string | null;
          created_at: string;
        }
      | undefined;
    if (!row) {
      throw new NotFoundError("Sugestão", id);
    }
    return this.mapSuggestion(row);
  }

  private getSuggestions(ticketId: string): SuggestionDto[] {
    const rows = this.database
      .prepare(
        `SELECT id, body, confidence, evidence_json, missing_information_json,
                status, model, prompt_version, created_at
         FROM suggestions WHERE ticket_id = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .all(ticketId) as Array<{
      id: string;
      body: string;
      confidence: number;
      evidence_json: string;
      missing_information_json: string;
      status: SuggestionDto["status"];
      model: string | null;
      prompt_version: string | null;
      created_at: string;
    }>;
    return rows.map((row) => this.mapSuggestion(row));
  }

  private getInvestigationThreadSummaryForTicket(
    ticketId: string,
  ): InvestigationThreadSummaryDto | null {
    const row = this.database
      .prepare(
        `SELECT t.id, t.status, t.updated_at,
                (SELECT MAX(message.created_at)
                 FROM investigation_thread_messages message
                 WHERE message.thread_id = t.id
                   AND message.role = 'assistant') AS last_assistant_message_at,
                (SELECT j.state FROM investigation_thread_jobs j
                 WHERE j.thread_id = t.id AND j.state IN ('queued', 'running')
                 ORDER BY j.requested_at DESC, j.rowid DESC LIMIT 1) AS active_turn_state
         FROM investigation_threads t WHERE t.ticket_id = ?`,
      )
      .get(ticketId) as
      | {
          id: string;
          status: InvestigationThreadSummaryDto["status"];
          updated_at: string;
          last_assistant_message_at: string | null;
          active_turn_state: InvestigationJobState | null;
        }
      | undefined;
    return row
      ? {
          id: row.id,
          status: row.status,
          updatedAt: row.updated_at,
          lastAssistantMessageAt: row.last_assistant_message_at,
          activeTurnState: row.active_turn_state,
        }
      : null;
  }

  private normalizeInvestigationToolExecution(
    execution: InvestigationToolResult,
  ): InvestigationToolExecutionDto {
    if (execution.status !== "success" && execution.status !== "error") {
      throw new ValidationError("Status da execução da ferramenta é inválido");
    }
    const executedAt = normalizedBoundedText(
      execution.executedAt,
      "Data de execução da ferramenta",
      100,
    );
    if (Number.isNaN(Date.parse(executedAt))) {
      throw new ValidationError("Data de execução da ferramenta é inválida");
    }
    return {
      requestId: normalizedBoundedText(
        execution.requestId,
        "Identificador da solicitação",
        TOOL_AUDIT_REQUEST_ID_MAX_LENGTH,
      ),
      toolId: normalizedBoundedText(
        execution.toolId,
        "Identificador da ferramenta",
        TOOL_AUDIT_IDENTITY_MAX_LENGTH,
      ),
      toolName: normalizedBoundedText(
        execution.toolName,
        "Nome da ferramenta",
        TOOL_AUDIT_IDENTITY_MAX_LENGTH,
      ),
      operation: normalizedBoundedText(
        execution.operation,
        "Operação da ferramenta",
        TOOL_AUDIT_IDENTITY_MAX_LENGTH,
      ),
      argumentsJson: normalizedBoundedText(
        execution.argumentsJson,
        "Argumentos da ferramenta",
        TOOL_AUDIT_ARGUMENTS_MAX_LENGTH,
      ),
      purpose: normalizedBoundedText(
        execution.purpose,
        "Finalidade da ferramenta",
        TOOL_AUDIT_PURPOSE_MAX_LENGTH,
      ),
      status: execution.status,
      summary: normalizedBoundedText(
        execution.summary,
        "Resumo da execução",
        TOOL_AUDIT_SUMMARY_MAX_LENGTH,
      ),
      content: normalizedBoundedText(
        execution.content,
        "Conteúdo da execução",
        TOOL_AUDIT_CONTENT_MAX_LENGTH,
      ),
      reference: execution.reference
        ? normalizedBoundedText(
            execution.reference,
            "Referência da execução",
            TOOL_AUDIT_IDENTITY_MAX_LENGTH,
          )
        : null,
      executedAt,
    };
  }

  private getInvestigationThreadToolExecutions(
    jobId: string,
  ): InvestigationToolExecutionDto[] {
    const rows = this.database
      .prepare(
        `SELECT request_id, tool_id, tool_name, operation, arguments_json,
                purpose, status, summary, content, reference, executed_at
         FROM investigation_thread_tool_executions
         WHERE job_id = ?
         ORDER BY executed_at, rowid`,
      )
      .all(jobId) as Array<{
      request_id: string;
      tool_id: string;
      tool_name: string;
      operation: string;
      arguments_json: string;
      purpose: string;
      status: InvestigationToolExecutionDto["status"];
      summary: string;
      content: string;
      reference: string | null;
      executed_at: string;
    }>;
    return rows.map((row) => ({
      requestId: row.request_id,
      toolId: row.tool_id,
      toolName: row.tool_name,
      operation: row.operation,
      argumentsJson: row.arguments_json,
      purpose: row.purpose,
      status: row.status,
      summary: row.summary,
      content: row.content,
      reference: row.reference,
      executedAt: row.executed_at,
    }));
  }

  private getInvestigationThreadMessages(
    threadId: string,
  ): InvestigationThreadMessageDto[] {
    const rows = this.database
      .prepare(
        `SELECT message.id, message.role, message.body, message.phase,
                message.evidence_json, message.suggested_response,
                message.next_action, message.created_at,
                assistant_job.result_json,
                COALESCE(assistant_job.id, unfinished_job.id) AS execution_job_id
         FROM investigation_thread_messages message
         LEFT JOIN investigation_thread_jobs assistant_job
           ON assistant_job.id = message.job_id
         LEFT JOIN investigation_thread_jobs unfinished_job
           ON unfinished_job.operator_message_id = message.id
          AND unfinished_job.assistant_message_id IS NULL
         WHERE message.thread_id = ? ORDER BY message.created_at, message.rowid`,
      )
      .all(threadId) as Array<{
      id: string;
      role: InvestigationThreadMessageDto["role"];
      body: string;
      phase: InvestigationThreadMessageDto["phase"];
      evidence_json: string;
      suggested_response: string | null;
      next_action: string | null;
      created_at: string;
      result_json: string | null;
      execution_job_id: string | null;
    }>;
    return rows.map((row) => {
      const audited = row.execution_job_id
        ? this.getInvestigationThreadToolExecutions(row.execution_job_id)
        : [];
      return {
        id: row.id,
        role: row.role,
        body: row.body,
        phase: row.phase,
        evidence: this.parseInvestigationEvidence(row.evidence_json),
        suggestedResponse: row.suggested_response,
        nextAction: row.next_action,
        toolExecutions: audited.length
          ? audited
          : this.parseInvestigationToolExecutions(row.result_json),
        createdAt: row.created_at,
      };
    });
  }

  private getInvestigationThreadTurns(
    threadId: string,
  ): InvestigationThreadTurnDto[] {
    const rows = this.database
      .prepare(
        `SELECT id,
                CASE WHEN cancelled_at IS NOT NULL THEN 'cancelled' ELSE state END AS state,
                operator_message_id, assistant_message_id,
                requested_at, started_at, finished_at, attempt_count,
                error, result_json, cancelled_at, cancelled_by
         FROM investigation_thread_jobs
         WHERE thread_id = ? ORDER BY requested_at, rowid`,
      )
      .all(threadId) as Array<{
      id: string;
      state: InvestigationJobState;
      operator_message_id: string;
      assistant_message_id: string | null;
      requested_at: string;
      started_at: string | null;
      finished_at: string | null;
      attempt_count: number;
      error: string | null;
      result_json: string | null;
      cancelled_at: string | null;
      cancelled_by: string | null;
    }>;

    return rows.map((row) => {
      const audited = this.getInvestigationThreadToolExecutions(row.id);
      const parsedResult = this.parseInvestigationTurnResult(row.result_json);
      return {
        id: row.id,
        state: row.state,
        operatorMessageId: row.operator_message_id,
        assistantMessageId: row.assistant_message_id,
        requestedAt: row.requested_at,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        attemptCount: row.attempt_count,
        error: row.error,
        cancelledAt: row.cancelled_at,
        cancelledBy: row.cancelled_by,
        toolExecutions: audited.length
          ? audited
          : parsedResult?.toolExecutions ?? [],
        result: parsedResult
          ? {
              ...parsedResult,
              toolExecutions: audited.length
                ? audited
                : parsedResult.toolExecutions,
            }
          : null,
      };
    });
  }

  private parseInvestigationEvidence(
    json: string | null,
  ): InvestigationThreadMessageDto["evidence"] {
    const parsed = parseJson<unknown>(json, []);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!isRecord(item)) return [];
      const source = trimmedString(item.source);
      const summary = trimmedString(item.summary);
      if (!source || !summary) return [];
      return [{
        source,
        summary,
        reference: trimmedString(item.reference),
      }];
    });
  }

  private parseInvestigationTurnResult(
    json: string | null,
  ): InvestigationTurnResultDto | null {
    const parsed = parseJson<unknown>(json, null);
    if (!isRecord(parsed)) return null;
    const assistantMessage = trimmedString(parsed.assistantMessage);
    const threadSummary = trimmedString(parsed.threadSummary);
    const phase = parsed.phase;
    const confidence = parsed.confidence;
    if (
      !assistantMessage ||
      !threadSummary ||
      typeof phase !== "string" ||
      !INVESTIGATION_TURN_PHASES.includes(
        phase as InvestigationTurnResultDto["phase"],
      ) ||
      typeof confidence !== "number" ||
      confidence < 0 ||
      confidence > 1
    ) {
      return null;
    }
    return {
      assistantMessage,
      phase: phase as InvestigationTurnResultDto["phase"],
      threadSummary,
      evidence: this.parseInvestigationEvidence(
        JSON.stringify(parsed.evidence ?? []),
      ),
      suggestedResponse: trimmedString(parsed.suggestedResponse),
      nextAction: trimmedString(parsed.nextAction),
      confidence,
      toolExecutions: this.parseInvestigationToolExecutions(json),
    };
  }

  private parseInvestigationToolExecutions(
    json: string | null,
  ): InvestigationTurnResultDto["toolExecutions"] {
    const parsed = parseJson<unknown>(json, null);
    if (!isRecord(parsed) || !Array.isArray(parsed.toolExecutions)) return [];
    return parsed.toolExecutions.flatMap((item) => {
      if (!isRecord(item)) return [];
      const requestId = trimmedString(item.requestId);
      const toolId = trimmedString(item.toolId);
      const toolName = trimmedString(item.toolName);
      const operation = trimmedString(item.operation);
      const argumentsJson = trimmedString(item.argumentsJson);
      const purpose = trimmedString(item.purpose);
      const status = item.status;
      const summary = trimmedString(item.summary);
      const content = trimmedString(item.content);
      const executedAt = trimmedString(item.executedAt);
      if (
        !requestId ||
        !toolId ||
        !toolName ||
        !operation ||
        !argumentsJson ||
        !purpose ||
        (status !== "success" && status !== "error") ||
        !summary ||
        !content ||
        !executedAt
      ) {
        return [];
      }
      return [{
        requestId,
        toolId,
        toolName,
        operation,
        argumentsJson,
        purpose,
        status,
        summary,
        content,
        reference: trimmedString(item.reference),
        executedAt,
      }];
    });
  }

  private getLatestInvestigation(ticketId: string): LatestInvestigationDto | null {
    const row = this.database
      .prepare(
        `SELECT id, state, instructions, requested_at, started_at, finished_at,
                result_json, error
         FROM investigation_jobs
         WHERE ticket_id = ?
         ORDER BY requested_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(ticketId) as
      | {
          id: string;
          state: InvestigationJobState;
          instructions: string | null;
          requested_at: string;
          started_at: string | null;
          finished_at: string | null;
          result_json: string | null;
          error: string | null;
        }
      | undefined;
    if (!row) {
      return null;
    }

    const parsedResult = parseJson<unknown>(row.result_json, null);
    const result = isRecord(parsedResult) ? parsedResult : null;
    const suggestedResponse = trimmedString(result?.suggestedResponse);
    const missingInformation = stringArray(result?.missingInformation);
    const explicitOutcome = investigationOutcome(result?.outcome);
    const outcome = explicitOutcome
      ?? (row.state === "completed"
        ? missingInformation.length > 0
          ? "needs_information"
          : suggestedResponse
            ? "reply_ready"
            : "technical_investigation_required"
        : null);
    const confidence = result?.confidence;
    const evidence = Array.isArray(result?.evidence)
      ? result.evidence.flatMap((item) => {
          if (!isRecord(item)) {
            return [];
          }
          const source = trimmedString(item.source);
          const summary = trimmedString(item.summary);
          if (!source || !summary) {
            return [];
          }
          return [{
            source,
            summary,
            reference: trimmedString(item.reference),
          }];
        })
      : [];

    return {
      id: row.id,
      state: row.state,
      instructions: row.instructions,
      requestedAt: row.requested_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      error: row.error,
      outcome,
      confidence:
        typeof confidence === "number" &&
        Number.isFinite(confidence) &&
        confidence >= 0 &&
        confidence <= 1
          ? confidence
          : null,
      evidence,
      missingInformation,
      nextAction: trimmedString(result?.nextAction),
      suggestedResponse,
    };
  }

  private mapSuggestion(row: {
    id: string;
    body: string;
    confidence: number;
    evidence_json: string;
    missing_information_json: string;
    status: SuggestionDto["status"];
    model: string | null;
    prompt_version: string | null;
    created_at: string;
  }): SuggestionDto {
    return {
      id: row.id,
      body: row.body,
      confidence: row.confidence,
      evidence: parseJson<SuggestionDto["evidence"]>(row.evidence_json, []),
      missingInformation: parseJson<string[]>(row.missing_information_json, []),
      status: row.status,
      model: row.model,
      promptVersion: row.prompt_version,
      createdAt: row.created_at,
    };
  }

  private getSentResponses(ticketId: string): SentResponseDto[] {
    const rows = this.database
      .prepare(
        `SELECT id, body, message_id, sent_at, captured_at
         FROM sent_responses WHERE ticket_id = ? ORDER BY sent_at`,
      )
      .all(ticketId) as Array<{
      id: string;
      body: string;
      message_id: string | null;
      sent_at: string;
      captured_at: string;
    }>;
    return rows.map((row) => this.mapSentResponse(row));
  }

  private mapSentResponse(row: {
    id: string;
    body: string;
    message_id: string | null;
    sent_at: string;
    captured_at: string;
  }): SentResponseDto {
    return {
      id: row.id,
      body: row.body,
      messageId: row.message_id,
      sentAt: row.sent_at,
      capturedAt: row.captured_at,
    };
  }

  private getTriageBlock(blockId: string): TriageBlockDto {
    const row = this.database
      .prepare("SELECT * FROM triage_blocks WHERE id = ?")
      .get(blockId) as TriageBlockRow | undefined;
    if (!row) throw new NotFoundError("Bloco de triagem", blockId);
    const messageIds = (
      this.database
        .prepare(
          `SELECT block_message.message_id
           FROM triage_block_messages block_message
           JOIN messages message ON message.id = block_message.message_id
           WHERE block_message.block_id = ?
             AND (? <> 'pending' OR block_message.active = 1)
           ORDER BY message.occurred_at, message.id`,
        )
        .all(blockId, row.state) as Array<{ message_id: string }>
    ).map((message) => message.message_id);
    return {
      id: row.id,
      conversationId: row.group_id,
      messageIds,
      title: row.title,
      summary: row.summary,
      kind: row.triage_kind,
      state: row.state,
      confidence: row.confidence,
      suggestedAction: row.suggested_action,
      suggestedTicketId: row.suggested_ticket_id,
      confirmedTicketId: row.confirmed_ticket_id,
      affectedStoreId: row.affected_store_id,
      reason: row.reason,
      proposedCategories: parseJson<
        TriageBlockDto["proposedCategories"]
      >(row.proposed_categories_json, emptyTriageCategories()),
      ai:
        row.ai_model && row.ai_prompt_version
          ? {
              model: row.ai_model,
              promptVersion: row.ai_prompt_version,
              fallbackUsed: Boolean(row.ai_fallback_used),
            }
          : null,
      firstMessageAt: row.first_message_at,
      lastMessageAt: row.last_message_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private proposedCategoriesForExactSelection(
    groupId: string,
    messageIds: string[],
  ): {
    categories: TriageBlockDto["proposedCategories"];
    confidence: number | null;
  } | null {
    const selected = new Set(messageIds);
    const rows = this.database
      .prepare(
        `SELECT id, proposed_categories_json, confidence
         FROM triage_blocks
         WHERE group_id = ? AND state = 'pending'
           AND proposed_categories_json IS NOT NULL
         ORDER BY updated_at DESC, id`,
      )
      .all(groupId) as Array<{
      id: string;
      proposed_categories_json: string;
      confidence: number | null;
    }>;
    const members = this.database.prepare(
      `SELECT message_id FROM triage_block_messages
       WHERE block_id = ? AND active = 1 ORDER BY message_id`,
    );
    for (const row of rows) {
      const blockMessageIds = (
        members.all(row.id) as Array<{ message_id: string }>
      ).map((item) => item.message_id);
      if (
        blockMessageIds.length === selected.size &&
        blockMessageIds.every((messageId) => selected.has(messageId))
      ) {
        return {
          categories: parseJson(
            row.proposed_categories_json,
            emptyTriageCategories(),
          ),
          confidence: row.confidence,
        };
      }
    }
    return null;
  }

  private promoteTriageCategories(
    ticketId: string,
    categories: TriageBlockDto["proposedCategories"],
    confidence: number | null,
  ): void {
    const timestamp = nowUtc();
    const facets: Array<{
      facet: "reason" | "product" | "platform" | "symptom";
      labels: string[];
    }> = [
      { facet: "reason", labels: categories.contactReason },
      { facet: "product", labels: categories.productArea },
      { facet: "platform", labels: categories.platform },
      { facet: "symptom", labels: categories.symptom },
    ];
    const catalog = this.getAnalysisCategoryCatalog();
    for (const entry of facets) {
      for (const label of entry.labels) {
        const candidate = normalizeAnalysisCategories(
          {
            contactReason: entry.facet === "reason" ? [label] : [],
            productArea: entry.facet === "product" ? [label] : [],
            platform: entry.facet === "platform" ? [label] : [],
            symptom: entry.facet === "symptom" ? [label] : [],
          },
          catalog,
        );
        const allowedLabel =
          entry.facet === "reason"
            ? candidate.contactReason[0]
            : entry.facet === "product"
              ? candidate.productArea[0]
              : entry.facet === "platform"
                ? candidate.platform[0]
                : candidate.symptom[0];
        const normalized = allowedLabel
          ? normalizeCatalogCategory(entry.facet, allowedLabel)
          : null;
        if (!normalized) continue;
        const category = this.upsertCategory({
          facet: normalized.facet,
          slug: normalized.slug,
          label: normalized.label,
        });
        this.addTicketCategoryInternal(
          ticketId,
          category.id,
          "ai",
          confidence,
          timestamp,
        );
      }
    }
  }

  private conversationRequestKey(
    groupId: string,
    action: string,
    clientRequestId: string | undefined,
  ): string | null {
    const requestId = normalizedNullableText(clientRequestId);
    return requestId ? `${groupId}:${action}:${requestId}` : null;
  }

  private getConversationActionByRequestKey(
    requestKey: string | null,
  ): ConversationTriageActionResponse | null {
    if (!requestKey) return null;
    const row = this.database
      .prepare(
        `SELECT id, group_id, state, confirmed_ticket_id
         FROM triage_blocks WHERE request_key = ?`,
      )
      .get(requestKey) as
      | {
          id: string;
          group_id: string;
          state: TriageBlockDto["state"];
          confirmed_ticket_id: string | null;
        }
      | undefined;
    if (!row) return null;
    const block = this.getTriageBlock(row.id);
    const action =
      row.state === "ticketed"
        ? "create"
        : row.state === "attached"
          ? "attach"
          : row.state === "ignored"
            ? "ignore"
            : row.state === "context"
              ? "context"
              : "restore";
    return {
      blockId: row.id,
      conversationId: row.group_id,
      action,
      messageIds: block.messageIds,
      ticket: row.confirmed_ticket_id
        ? this.getTicketDetail(row.confirmed_ticket_id)
        : null,
      investigationJobId: null,
    };
  }

  private loadConversationActionMessages(
    groupId: string,
    messageIds: readonly string[],
  ): ConversationActionMessageRow[] {
    this.assertEntityExists("Conversa", "whatsapp_groups", groupId);
    const ids = [...new Set(messageIds.map((id) => id.trim()).filter(Boolean))];
    if (!ids.length) throw new ValidationError("Selecione ao menos uma mensagem");
    if (ids.length > 500) {
      throw new ValidationError("Selecione no máximo 500 mensagens por ação");
    }
    const rows = this.database
      .prepare(
        `SELECT message.id, message.group_id, message.sender_id,
                message.occurred_at, message.text, message.message_type,
                message.triage_kind, message.triage_state,
                CASE WHEN staff.participant_id IS NULL THEN 0 ELSE 1 END AS is_staff
         FROM messages message
         LEFT JOIN staff_members staff
           ON staff.participant_id = message.sender_id AND staff.active = 1
         WHERE message.id IN (${ids.map(() => "?").join(", ")})
         ORDER BY message.occurred_at, message.id`,
      )
      .all(...ids) as ConversationActionMessageRow[];
    if (rows.length !== ids.length) {
      const found = new Set(rows.map((row) => row.id));
      throw new NotFoundError(
        "Mensagem",
        ids.find((id) => !found.has(id)) ?? "desconhecida",
      );
    }
    const foreign = rows.find((message) => message.group_id !== groupId);
    if (foreign) {
      throw new ValidationError("Todas as mensagens devem pertencer à mesma conversa", {
        messageId: foreign.id,
      });
    }
    return rows;
  }

  private assertMessagesHaveNoTicket(messageIds: readonly string[]): void {
    const linked = this.database
      .prepare(
        `SELECT ticket_message.message_id, ticket.number
         FROM ticket_messages ticket_message
         JOIN tickets ticket ON ticket.id = ticket_message.ticket_id
         WHERE ticket_message.message_id IN (${messageIds.map(() => "?").join(", ")})
         LIMIT 1`,
      )
      .get(...messageIds) as { message_id: string; number: number } | undefined;
    if (linked) {
      throw new ConflictError(
        `A mensagem já está vinculada ao ticket #${linked.number}`,
        { messageId: linked.message_id, ticketNumber: linked.number },
      );
    }
  }

  private assertMessagesBelongOnlyToTicket(
    messageIds: readonly string[],
    targetTicketId: string,
  ): void {
    const linked = this.database
      .prepare(
        `SELECT ticket_message.message_id, ticket.number
         FROM ticket_messages ticket_message
         JOIN tickets ticket ON ticket.id = ticket_message.ticket_id
         WHERE ticket_message.message_id IN (${messageIds.map(() => "?").join(", ")})
           AND ticket_message.ticket_id <> ?
         LIMIT 1`,
      )
      .get(...messageIds, targetTicketId) as
      | { message_id: string; number: number }
      | undefined;
    if (linked) {
      throw new ConflictError(
        `A mensagem já está vinculada ao ticket #${linked.number}`,
        { messageId: linked.message_id, ticketNumber: linked.number },
      );
    }
  }

  private deriveConversationActionTitle(
    messages: readonly ConversationActionMessageRow[],
  ): string {
    const text = messages
      .map((message) => normalizedNullableText(message.text))
      .find((value): value is string => Boolean(value));
    const source = text ?? "Conteúdo recebido para triagem";
    return source.length > 92 ? `${source.slice(0, 89).trimEnd()}…` : source;
  }

  private deriveConversationActionSummary(
    messages: readonly ConversationActionMessageRow[],
  ): string {
    return messages
      .map(
        (message) =>
          normalizedNullableText(message.text) ??
          `[${message.message_type} sem texto]`,
      )
      .join("\n");
  }

  private createConversationActionBlock(input: {
    groupId: string;
    messages: ConversationActionMessageRow[];
    state: "ticketed" | "attached" | "ignored" | "context" | "restored";
    action: "create" | "attach" | "ignore" | "context" | "restore";
    requestKey: string | null;
    actor: string;
    reason: string | null;
    ticketId?: string | null;
    affectedStoreId?: string | null;
    title: string;
    summary: string;
  }): TriageBlockDto {
    const timestamp = nowUtc();
    const messageIds = input.messages.map((message) => message.id);
    this.removeMessagesFromTriageContextWait(
      input.groupId,
      messageIds,
      timestamp,
    );
    const placeholders = messageIds.map(() => "?").join(", ");
    const sourceBlocks = (
      this.database
        .prepare(
          `SELECT DISTINCT block_id
           FROM triage_block_messages
           WHERE active = 1 AND message_id IN (${placeholders})`,
        )
        .all(...messageIds) as Array<{ block_id: string }>
    ).map((row) => row.block_id);
    this.database
      .prepare(
        `UPDATE triage_block_messages
         SET active = 0, updated_at = ?
         WHERE active = 1 AND message_id IN (${placeholders})`,
      )
      .run(timestamp, ...messageIds);
    for (const sourceBlockId of sourceBlocks) {
      this.refreshPendingTriageBlock(sourceBlockId, timestamp);
      this.insertTriageBlockEvent({
        blockId: sourceBlockId,
        eventType: "messages_selected",
        actor: input.actor,
        messageIds,
        data: { action: input.action },
        occurredAt: timestamp,
      });
    }

    const firstMessageAt = input.messages[0]!.occurred_at;
    const lastMessageAt = input.messages.at(-1)!.occurred_at;
    const id = randomUUID();
    const kind = input.messages
      .map((message) => message.triage_kind)
      .sort((left, right) => triageKindRank(right) - triageKindRank(left))[0] ??
      "unclassified";
    const suggestedAction: TriageSuggestedAction | null =
      input.action === "create" ||
      input.action === "attach" ||
      input.action === "ignore"
        ? input.action
        : null;
    this.database
      .prepare(
        `INSERT INTO triage_blocks
          (id, group_id, sender_id, state, triage_kind, suggested_action,
           suggested_ticket_id, confirmed_ticket_id, affected_store_id,
           title, summary, confidence, reason, origin, created_by, request_key,
           first_message_at, last_message_at, resolved_at, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?, 'operator', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.groupId,
        input.state,
        kind,
        suggestedAction,
        input.ticketId ?? null,
        input.affectedStoreId ?? null,
        input.title,
        input.summary,
        input.reason,
        input.actor,
        input.requestKey,
        firstMessageAt,
        lastMessageAt,
        timestamp,
        timestamp,
        timestamp,
      );
    const membership = this.database.prepare(
      `INSERT INTO triage_block_messages
        (block_id, message_id, active, added_at, updated_at)
       VALUES (?, ?, 0, ?, ?)`,
    );
    for (const messageId of messageIds) {
      membership.run(id, messageId, timestamp, timestamp);
    }
    this.insertTriageBlockEvent({
      blockId: id,
      eventType: `operator_${input.action}`,
      actor: input.actor,
      messageIds,
      data: { ticketId: input.ticketId ?? null, reason: input.reason },
      occurredAt: timestamp,
    });
    return this.getTriageBlock(id);
  }

  private refreshPendingTriageBlock(blockId: string, timestamp: string): void {
    const rows = this.database
      .prepare(
        `SELECT message.id, message.occurred_at, message.text,
                message.message_type, message.triage_kind
         FROM triage_block_messages block_message
         JOIN messages message ON message.id = block_message.message_id
         WHERE block_message.block_id = ? AND block_message.active = 1
         ORDER BY message.occurred_at, message.id`,
      )
      .all(blockId) as Array<{
      id: string;
      occurred_at: string;
      text: string | null;
      message_type: string;
      triage_kind: TriageKind;
    }>;
    if (!rows.length) {
      this.database
        .prepare(
          `UPDATE triage_blocks
           SET state = 'superseded', resolved_at = ?, updated_at = ?
           WHERE id = ? AND state = 'pending'`,
        )
        .run(timestamp, timestamp, blockId);
      return;
    }
    const texts = rows.map(
      (message) =>
        normalizedNullableText(message.text) ?? `[${message.message_type} sem texto]`,
    );
    const titleSource = texts[0] ?? "Demanda em revisão";
    const title =
      titleSource.length > 92
        ? `${titleSource.slice(0, 89).trimEnd()}…`
        : titleSource;
    const kind = rows
      .map((message) => message.triage_kind)
      .sort((left, right) => triageKindRank(right) - triageKindRank(left))[0] ??
      "unclassified";
    this.database
      .prepare(
        `UPDATE triage_blocks
         SET triage_kind = ?, title = ?, summary = ?,
             first_message_at = ?, last_message_at = ?, updated_at = ?
         WHERE id = ? AND state = 'pending'`,
      )
      .run(
        kind,
        title,
        texts.join("\n"),
        rows[0]!.occurred_at,
        rows.at(-1)!.occurred_at,
        timestamp,
        blockId,
      );
  }

  private applyConversationMessageState(
    groupId: string,
    action: "ignore" | "context" | "restore",
    input: ConversationBatchActionInput,
  ): ConversationTriageActionResponse {
    return this.database.transaction(() => {
      const requestKey = this.conversationRequestKey(
        groupId,
        action,
        input.clientRequestId,
      );
      const repeated = this.getConversationActionByRequestKey(requestKey);
      if (repeated) return repeated;
      if (action === "restore") {
        const conversation = this.database
          .prepare(
            `SELECT suggestions_muted_at FROM whatsapp_groups WHERE id = ?`,
          )
          .get(groupId) as { suggestions_muted_at: string | null } | undefined;
        if (!conversation) throw new NotFoundError("Conversa", groupId);
        if (conversation.suggestions_muted_at) {
          throw new ConflictError(
            "Reative as sugestões desta conversa antes de restaurar mensagens para a triagem",
          );
        }
      }
      const messages = this.loadConversationActionMessages(groupId, input.messageIds);
      this.assertMessagesHaveNoTicket(messages.map((message) => message.id));
      if (action === "restore") {
        const invalid = messages.find(
          (message) =>
            !message.is_staff &&
            message.triage_state !== "ignored" &&
            message.triage_state !== "context",
        );
        if (invalid) {
          throw new ConflictError(
            "Somente mensagens ignoradas ou de contexto podem ser restauradas",
            { messageId: invalid.id, triageState: invalid.triage_state },
          );
        }
      }
      const actor = normalizedNullableText(input.actor) ?? "Operador local";
      const timestamp = nowUtc();
      if (action === "restore") {
        const messageIds = messages.map((message) => message.id);
        const placeholders = messageIds.map(() => "?").join(", ");
        this.database
          .prepare(
            `UPDATE triage_ai_job_messages
             SET active = 0, updated_at = ?
             WHERE active = 1 AND message_id IN (${placeholders})`,
          )
          .run(timestamp, ...messageIds);
      }
      const update = this.database.prepare(
        `UPDATE messages SET triage_kind = ?, triage_state = ?, updated_at = ?
         WHERE id = ?`,
      );
      for (const message of messages) {
        if (message.is_staff) {
          update.run("context", "context", timestamp, message.id);
          continue;
        }
        if (action === "restore") {
          update.run("unclassified", "unreviewed", timestamp, message.id);
        } else if (action === "context") {
          update.run("context", "context", timestamp, message.id);
        } else {
          update.run(message.triage_kind, "ignored", timestamp, message.id);
        }
      }
      const state =
        action === "ignore"
          ? "ignored"
          : action === "context"
            ? "context"
            : "restored";
      const block = this.createConversationActionBlock({
        groupId,
        messages,
        state,
        action,
        requestKey,
        actor,
        reason: normalizedNullableText(input.reason),
        title:
          action === "ignore"
            ? "Mensagens ignoradas"
            : action === "context"
              ? "Mensagens mantidas como contexto"
              : "Mensagens restauradas para triagem",
        summary: this.deriveConversationActionSummary(messages),
      });
      return {
        blockId: block.id,
        conversationId: groupId,
        action,
        messageIds: messages.map((message) => message.id),
        ticket: null,
        investigationJobId: null,
      };
    })();
  }

  private getConversationSummary(groupId: string): ConversationSummaryDto {
    const row = this.database
      .prepare(
        `SELECT
           conversation.id, conversation.subject, conversation.external_jid,
           conversation.monitored, conversation.suggestions_muted_at,
           client.id AS client_id, client.name AS client_name,
           client.kind AS client_kind,
           client.identification_pending,
           (SELECT COUNT(*) FROM messages message
            WHERE message.group_id = conversation.id
              AND message.triage_state = 'unreviewed'
              AND message.message_type NOT IN ('reactionMessage', 'protocolMessage')
              AND (
                trim(COALESCE(message.text, '')) <> ''
                OR message.message_type <> 'system'
                OR EXISTS (
                  SELECT 1 FROM attachments pending_attachment
                  WHERE pending_attachment.message_id = message.id
                )
              )) AS pending_count,
           (SELECT COUNT(*) FROM messages message
            WHERE message.group_id = conversation.id
              AND message.triage_state = 'ignored'
              AND message.message_type NOT IN ('reactionMessage', 'protocolMessage')
              AND (
                trim(COALESCE(message.text, '')) <> ''
                OR message.message_type <> 'system'
                OR EXISTS (
                  SELECT 1 FROM attachments ignored_attachment
                  WHERE ignored_attachment.message_id = message.id
                )
              )) AS ignored_count,
           (SELECT COUNT(*) FROM tickets ticket
            WHERE ticket.group_id = conversation.id) AS ticket_count,
           (SELECT COUNT(*) FROM tickets ticket
            WHERE ticket.group_id = conversation.id
              AND ticket.status NOT IN ('resolved', 'archived')) AS open_ticket_count,
           (SELECT message.occurred_at FROM messages message
            WHERE message.group_id = conversation.id
              AND message.message_type NOT IN ('reactionMessage', 'protocolMessage')
              AND (
                trim(COALESCE(message.text, '')) <> ''
                OR message.message_type <> 'system'
                OR EXISTS (
                  SELECT 1 FROM attachments latest_attachment
                  WHERE latest_attachment.message_id = message.id
                )
              )
            ORDER BY message.occurred_at DESC, message.id DESC LIMIT 1) AS last_message_at,
           (SELECT CASE
              WHEN message.text IS NOT NULL AND trim(message.text) <> ''
                THEN substr(replace(message.text, char(10), ' '), 1, 180)
              ELSE '[Anexo ou evento sem texto]'
            END
            FROM messages message
            WHERE message.group_id = conversation.id
              AND message.message_type NOT IN ('reactionMessage', 'protocolMessage')
              AND (
                trim(COALESCE(message.text, '')) <> ''
                OR message.message_type <> 'system'
                OR EXISTS (
                  SELECT 1 FROM attachments preview_attachment
                  WHERE preview_attachment.message_id = message.id
                )
              )
            ORDER BY message.occurred_at DESC, message.id DESC LIMIT 1) AS last_message_preview
         FROM whatsapp_groups conversation
         JOIN clients client ON client.id = conversation.client_id
         WHERE conversation.id = ? AND client.ignored_at IS NULL`,
      )
      .get(groupId) as
      | {
          id: string;
          subject: string;
          external_jid: string;
          monitored: number;
          suggestions_muted_at: string | null;
          client_id: string;
          client_name: string;
          client_kind: ClientKind;
          identification_pending: number;
          pending_count: number;
          ignored_count: number;
          ticket_count: number;
          open_ticket_count: number;
          last_message_at: string | null;
          last_message_preview: string | null;
        }
      | undefined;
    if (!row) throw new NotFoundError("Conversa", groupId);
    const direct = isDirectConversationJid(row.external_jid);
    return {
      id: row.id,
      subject: direct
        ? this.getDirectConversationSubject(
            row.id,
            row.external_jid,
            row.subject,
          )
        : normalizeConversationSubject(row.subject, row.external_jid),
      externalJid: row.external_jid,
      scope: direct ? "direct" : "group",
      monitored: Boolean(row.monitored),
      suggestionsMuted: Boolean(row.suggestions_muted_at),
      suggestionsMutedAt: row.suggestions_muted_at,
      client: {
        id: row.client_id,
        name: row.client_name,
        kind: row.client_kind,
        isUnidentified: Boolean(row.identification_pending),
      },
      pendingCount: row.pending_count,
      ignoredCount: row.ignored_count,
      ticketCount: row.ticket_count,
      openTicketCount: row.open_ticket_count,
      lastMessageAt: row.last_message_at,
      lastMessagePreview: row.last_message_preview,
    };
  }

  private getDirectConversationSubject(
    groupId: string,
    externalJid: string,
    storedSubject: string,
  ): string {
    const candidates = this.database
      .prepare(
        `SELECT
           participant.external_jid,
           participant.phone_e164,
           participant.display_name,
           MAX(message.occurred_at) AS last_message_at,
           CASE
             WHEN participant.external_jid = ? THEN 1
             WHEN EXISTS (
               SELECT 1
               FROM whatsapp_identity_links identity_link
               WHERE (
                 identity_link.phone_jid = participant.external_jid
                 OR identity_link.lid_jid = participant.external_jid
               )
                 AND (
                   identity_link.phone_jid = ?
                   OR identity_link.lid_jid = ?
                 )
             ) THEN 1
             ELSE 0
           END AS identity_match
         FROM group_participants membership
         JOIN participants participant
           ON participant.id = membership.participant_id
         LEFT JOIN staff_members staff
           ON staff.participant_id = participant.id AND staff.active = 1
         LEFT JOIN messages message
           ON message.group_id = membership.group_id
          AND message.sender_id = participant.id
         WHERE membership.group_id = ?
           AND staff.participant_id IS NULL
         GROUP BY
           participant.id,
           participant.external_jid,
           participant.phone_e164,
           participant.display_name,
           participant.updated_at,
           membership.active
         ORDER BY
           identity_match DESC,
           membership.active DESC,
           last_message_at DESC,
           participant.updated_at DESC`,
      )
      .all(externalJid, externalJid, externalJid, groupId) as Array<{
      external_jid: string;
      phone_e164: string | null;
      display_name: string;
      last_message_at: string | null;
      identity_match: number;
    }>;
    const namedContact = candidates.find(
      (candidate) =>
        candidate.identity_match === 1 &&
        isHumanParticipantDisplayName(candidate.display_name, [
          candidate.external_jid,
          candidate.phone_e164,
          externalJid,
        ]),
    );
    if (namedContact) return namedContact.display_name.trim();

    const normalizedStoredSubject = normalizeConversationSubject(
      storedSubject,
      externalJid,
    );
    if (
      isHumanParticipantDisplayName(normalizedStoredSubject, [externalJid])
    ) {
      return normalizedStoredSubject;
    }

    return (
      candidates.find((candidate) => candidate.phone_e164)?.phone_e164?.trim() ||
      normalizedStoredSubject
    );
  }

  private resolveMentionDisplayNames(
    groupId: string,
    rawMessages: readonly (string | null)[],
  ): Map<string, string> {
    const mentionedJids = new Set(rawMessages.flatMap(extractMentionedJids));
    if (!mentionedJids.size) return new Map();

    const jids = [...mentionedJids];
    const placeholders = jids.map(() => "?").join(", ");
    const candidates = this.database
      .prepare(
        `SELECT
           participant.external_jid,
           participant.phone_e164,
           participant.display_name,
           identity_link.phone_jid,
           identity_link.lid_jid,
           COALESCE(membership.active, 0) AS active
         FROM participants participant
         LEFT JOIN whatsapp_identity_links identity_link
           ON identity_link.phone_jid = participant.external_jid
           OR identity_link.lid_jid = participant.external_jid
         LEFT JOIN group_participants membership
           ON membership.participant_id = participant.id
          AND membership.group_id = ?
         WHERE participant.external_jid IN (${placeholders})
            OR identity_link.phone_jid IN (${placeholders})
            OR identity_link.lid_jid IN (${placeholders})
         ORDER BY active DESC, participant.updated_at DESC, participant.id`,
      )
      .all(groupId, ...jids, ...jids, ...jids) as Array<{
      external_jid: string;
      phone_e164: string | null;
      display_name: string;
      phone_jid: string | null;
      lid_jid: string | null;
      active: number;
    }>;

    const names = new Map<string, string>();
    for (const candidate of candidates) {
      const aliases = [
        candidate.external_jid,
        candidate.phone_jid,
        candidate.lid_jid,
      ].filter((jid): jid is string => Boolean(jid));
      if (
        !isHumanParticipantDisplayName(candidate.display_name, [
          ...aliases,
          candidate.phone_e164,
        ])
      ) {
        continue;
      }
      for (const alias of aliases) {
        if (mentionedJids.has(alias) && !names.has(alias)) {
          names.set(alias, candidate.display_name.trim());
        }
      }
    }
    return names;
  }

  private insertTriageBlockEvent(input: {
    blockId: string;
    eventType: string;
    actor: string;
    messageIds: string[];
    data?: Record<string, unknown>;
    occurredAt?: string;
  }): void {
    this.database
      .prepare(
        `INSERT INTO triage_block_events
          (id, block_id, event_type, actor, message_ids_json, data_json, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.blockId,
        input.eventType,
        input.actor,
        JSON.stringify(input.messageIds),
        JSON.stringify(input.data ?? {}),
        input.occurredAt ?? nowUtc(),
      );
  }

  private getResolution(ticketId: string): ResolutionDto | null {
    const row = this.database
      .prepare(
        `SELECT id, summary, root_cause, outcome, validated_by, validated_at
         FROM resolutions WHERE ticket_id = ?`,
      )
      .get(ticketId) as
      | {
          id: string;
          summary: string;
          root_cause: string | null;
          outcome: string | null;
          validated_by: string;
          validated_at: string;
        }
      | undefined;
    return row
      ? {
          id: row.id,
          summary: row.summary,
          rootCause: row.root_cause,
          outcome: row.outcome,
          validatedBy: row.validated_by,
          validatedAt: row.validated_at,
        }
      : null;
  }
}
