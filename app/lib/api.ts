import type {
  ClientSummary,
  DashboardData,
  DirectoryFieldDefinitionInput,
  DirectoryRecordInput,
  DirectoryRecordTypeInput,
  DirectorySegmentInput,
  DirectorySnapshot,
  RuntimeState,
  TicketDetail,
  TicketStatus,
  TicketSummary,
} from "./types";
import type {
  AddInvestigationThreadMessageInput,
  CategoryCatalogDto,
  CategoryFacet,
  CreateManualTicketInput,
  DeleteClientResponse,
  DeleteTicketResponse,
  InvestigationThreadDto,
  ExecuteRecordConnectorInput,
  ExecuteRecordConnectorResponse,
  RecordConnectorSummaryDto,
  TicketListResponse,
  CreateCategoryInput,
  TicketCategoryAttachInput,
  TriageAiSettingsDto,
  TriggerConversationAnalysisResponse,
  UpsertTicketProductForwardingInput,
  UpdateTriageAiSettingsInput,
  UpdateClientProfileInput,
  UpdateTicketDirectoryContextInput,
  UpdateTicketInternalNoteInput,
  UpdateTicketContextInput,
  UpdateTicketMetadataInput,
} from "@/shared/contracts";
import type {
  ConversationActionResponse,
  ConversationAttachInput,
  ConversationBatchActionInput,
  ConversationClearPendingResponse,
  ConversationCreateTicketInput,
  ConversationListResponse,
  ConversationMessagesResponse,
  ConversationTicketListResponse,
  ConversationSuggestionSettingsResponse,
  ConversationTriageBlocksResponse,
} from "./conversations";
import {
  dashboardExportFallbackName,
  type DashboardDateRange,
} from "./dashboard-period";
import { notifySessionExpired } from "./session-events";

export const API_URL =
  process.env.NEXT_PUBLIC_SUPPORT_API_URL ?? "http://127.0.0.1:4317";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
      cache: "no-store",
    });
  } catch {
    throw new ApiError(
      "Não foi possível alcançar o serviço local. Confirme se o Suporte está ligado.",
    );
  }

  if (!response.ok) {
    throw await apiResponseError(response);
  }

  return (await response.json()) as T;
}

export { request as apiRequest };

async function apiResponseError(response: Response): Promise<ApiError> {
  if (response.status === 401) notifySessionExpired();
  const payload = (await response.json().catch(() => null)) as {
    error?: string | { message?: string };
    message?: string;
  } | null;
  return new ApiError(
    payload?.message ??
      (typeof payload?.error === "string" ? payload.error : payload?.error?.message) ??
      `A API respondeu com ${response.status}.`,
    response.status,
  );
}

function dashboardPath(path: string, range: DashboardDateRange): string {
  const params = new URLSearchParams();
  if (range.from) params.set("from", range.from);
  if (range.to) params.set("to", range.to);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function contentDispositionFileName(value: string | null): string | null {
  if (!value) return null;
  const utf8Name = /filename\*=UTF-8''([^;]+)/i.exec(value)?.[1];
  if (utf8Name) {
    try {
      return decodeURIComponent(utf8Name.trim());
    } catch {
      return utf8Name.trim();
    }
  }
  return /filename="?([^";]+)"?/i.exec(value)?.[1]?.trim() ?? null;
}

export async function getRuntime(): Promise<RuntimeState> {
  return request<RuntimeState>("/api/runtime");
}

export async function getCategories(filters: {
  query?: string;
  facet?: CategoryFacet;
  includeEmpty?: boolean;
} = {}): Promise<{ items: CategoryCatalogDto[]; total: number }> {
  const params = new URLSearchParams();
  if (filters.query?.trim()) params.set("q", filters.query.trim());
  if (filters.facet) params.set("facet", filters.facet);
  if (typeof filters.includeEmpty === "boolean") {
    params.set("includeEmpty", filters.includeEmpty ? "true" : "false");
  }
  const path = params.toString()
    ? `/api/categories?${params}`
    : "/api/categories";
  return request(path);
}

export async function createCategory(
  input: CreateCategoryInput,
): Promise<CategoryCatalogDto> {
  return request<CategoryCatalogDto>("/api/categories", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function attachCategoryToTicket(
  ticketId: string,
  input: TicketCategoryAttachInput,
): Promise<TicketDetail> {
  return request<TicketDetail>(
    `/api/tickets/${encodeURIComponent(ticketId)}/categories`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function detachCategoryFromTicket(
  ticketId: string,
  categoryId: string,
): Promise<TicketDetail> {
  return request<TicketDetail>(
    `/api/tickets/${encodeURIComponent(ticketId)}/categories/${encodeURIComponent(
      categoryId,
    )}`,
    { method: "DELETE" },
  );
}

export async function getDashboard(
  range: DashboardDateRange = {},
): Promise<DashboardData> {
  return request<DashboardData>(dashboardPath("/api/dashboard", range));
}

export async function getDashboardExport(
  range: DashboardDateRange = {},
): Promise<{ blob: Blob; fileName: string }> {
  let response: Response;
  try {
    response = await fetch(dashboardPath(`${API_URL}/api/dashboard/export`, range), {
      headers: { Accept: "text/csv" },
      credentials: "include",
      cache: "no-store",
    });
  } catch {
    throw new ApiError(
      "Não foi possível alcançar o serviço local para exportar o dashboard.",
    );
  }
  if (!response.ok) throw await apiResponseError(response);
  return {
    blob: await response.blob(),
    fileName:
      contentDispositionFileName(response.headers.get("content-disposition")) ??
      dashboardExportFallbackName(range),
  };
}

export async function getTriageAiSettings(): Promise<TriageAiSettingsDto> {
  return request<TriageAiSettingsDto>("/api/triage/settings");
}

export async function updateTriageAiSettings(
  input: UpdateTriageAiSettingsInput,
): Promise<TriageAiSettingsDto> {
  return request<TriageAiSettingsDto>("/api/triage/settings", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function getTickets(): Promise<TicketSummary[]> {
  const items: TicketSummary[] = [];
  const limit = 200;
  let offset = 0;

  while (true) {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
    });
    const result = await request<TicketListResponse>(`/api/tickets?${params}`);
    items.push(...result.items);
    offset += result.items.length;
    if (!result.items.length || offset >= result.total) return items;
  }
}

export async function createManualTicket(
  input: CreateManualTicketInput,
): Promise<TicketDetail> {
  return request<TicketDetail>("/api/tickets", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getBugTickets(): Promise<TicketSummary[]> {
  const items: TicketSummary[] = [];
  const limit = 200;
  let offset = 0;

  while (true) {
    const params = new URLSearchParams({
      productForwardingKind: "bug",
      includeArchived: "true",
      order: "created_desc",
      limit: String(limit),
      offset: String(offset),
    });
    const result = await request<TicketListResponse>(`/api/tickets?${params}`);
    items.push(...result.items);
    offset += result.items.length;
    if (!result.items.length || offset >= result.total) return items;
  }
}

export async function getArchivedTickets(
  options: { offset?: number; limit?: number } = {},
): Promise<TicketListResponse> {
  const params = new URLSearchParams({
    status: "archived",
    includeArchived: "true",
    order: "archived_desc",
    limit: String(options.limit ?? 200),
    offset: String(options.offset ?? 0),
  });
  return request<TicketListResponse>(`/api/tickets?${params}`);
}

export async function getResolvedTickets(
  options: { offset?: number; limit?: number } = {},
): Promise<TicketListResponse> {
  const params = new URLSearchParams({
    status: "resolved",
    order: "resolved_desc",
    limit: String(options.limit ?? 200),
    offset: String(options.offset ?? 0),
  });
  return request<TicketListResponse>(`/api/tickets?${params}`);
}

export async function bulkUpdateTicketStatus(
  ticketIds: string[],
  status: "archived" | "resolved",
): Promise<TicketSummary[]> {
  const result = await request<{
    tickets: TicketSummary[];
    action: string;
    changedAt: string;
  }>("/api/tickets/bulk-status", {
    method: "POST",
    body: JSON.stringify({ ticketIds, status }),
  });
  return result.tickets;
}

export async function getConversations(
  options: {
    cursor?: string | null;
    limit?: number;
    query?: string;
    scope?: "group" | "direct";
    attention?: "pending" | "all";
  } = {},
): Promise<ConversationListResponse> {
  const params = new URLSearchParams({ limit: String(options.limit ?? 50) });
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.query?.trim()) params.set("q", options.query.trim());
  if (options.scope) params.set("scope", options.scope);
  if (options.attention) params.set("attention", options.attention);
  return request<ConversationListResponse>(`/api/conversations?${params}`);
}

export async function getConversationMessages(
  conversationId: string,
  options: { before?: string | null; limit?: number } = {},
): Promise<ConversationMessagesResponse> {
  const params = new URLSearchParams({ limit: String(options.limit ?? 100) });
  if (options.before) params.set("before", options.before);
  return request<ConversationMessagesResponse>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages?${params}`,
  );
}

export async function getConversationTickets(
  conversationId: string,
  options: {
    cursor?: string | null;
    limit?: number;
    query?: string;
    statuses?: TicketStatus[];
  } = {},
): Promise<ConversationTicketListResponse> {
  const params = new URLSearchParams({ limit: String(options.limit ?? 10) });
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.query?.trim()) params.set("q", options.query.trim());
  for (const status of options.statuses ?? []) params.append("status", status);
  return request<ConversationTicketListResponse>(
    `/api/conversations/${encodeURIComponent(conversationId)}/tickets?${params}`,
  );
}

export async function getConversationTriageBlocks(
  conversationId: string,
): Promise<ConversationTriageBlocksResponse> {
  return request<ConversationTriageBlocksResponse>(
    `/api/conversations/${encodeURIComponent(conversationId)}/triage-blocks?includeResolved=false`,
  );
}

export async function triggerConversationAnalysis(
  conversationId: string,
): Promise<TriggerConversationAnalysisResponse> {
  return request<TriggerConversationAnalysisResponse>(
    `/api/conversations/${encodeURIComponent(conversationId)}/triage/analyze`,
    { method: "POST" },
  );
}

export async function setConversationSuggestionsMuted(
  conversationId: string,
  muted: boolean,
): Promise<ConversationSuggestionSettingsResponse> {
  return request<ConversationSuggestionSettingsResponse>(
    `/api/conversations/${encodeURIComponent(conversationId)}/suggestion-settings`,
    {
      method: "PUT",
      body: JSON.stringify({ muted }),
    },
  );
}

export async function createConversationTicket(
  input: ConversationCreateTicketInput,
): Promise<ConversationActionResponse> {
  const { conversationId, ...body } = input;
  return request<ConversationActionResponse>(
    `/api/conversations/${encodeURIComponent(conversationId)}/triage/tickets`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function attachConversationMessages(
  input: ConversationAttachInput,
): Promise<ConversationActionResponse> {
  const { conversationId, ...body } = input;
  return request<ConversationActionResponse>(
    `/api/conversations/${encodeURIComponent(conversationId)}/triage/attach`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function runConversationBatchAction(
  action: "ignore" | "context" | "restore",
  input: ConversationBatchActionInput,
): Promise<ConversationActionResponse> {
  const { conversationId, ...body } = input;
  return request<ConversationActionResponse>(
    `/api/conversations/${encodeURIComponent(conversationId)}/triage/${action}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function ignoreConversationMessages(
  input: ConversationBatchActionInput,
): Promise<ConversationActionResponse> {
  return runConversationBatchAction("ignore", input);
}

export async function keepConversationMessagesAsContext(
  input: ConversationBatchActionInput,
): Promise<ConversationActionResponse> {
  return runConversationBatchAction("context", input);
}

export async function keepAllPendingMessagesAsContext(): Promise<ConversationClearPendingResponse> {
  return request<ConversationClearPendingResponse>(
    "/api/conversations/triage/context-all",
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

export async function keepConversationPendingMessagesAsContext(
  conversationId: string,
): Promise<ConversationClearPendingResponse> {
  return request<ConversationClearPendingResponse>(
    `/api/conversations/${encodeURIComponent(conversationId)}/triage/context-all`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

export async function restoreConversationMessages(
  input: ConversationBatchActionInput,
): Promise<ConversationActionResponse> {
  return runConversationBatchAction("restore", input);
}

export async function getTicket(id: string): Promise<TicketDetail> {
  return request<TicketDetail>(`/api/tickets/${encodeURIComponent(id)}`);
}

export async function updateTicketMetadata(
  id: string,
  input: UpdateTicketMetadataInput,
): Promise<TicketDetail> {
  return request<TicketDetail>(`/api/tickets/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function detachTicketMessage(
  ticketId: string,
  messageId: string,
): Promise<TicketDetail> {
  return request<TicketDetail>(
    `/api/tickets/${encodeURIComponent(ticketId)}/messages/${encodeURIComponent(messageId)}`,
    { method: "DELETE" },
  );
}

export async function deleteTicket(id: string): Promise<DeleteTicketResponse> {
  return request<DeleteTicketResponse>(`/api/tickets/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: JSON.stringify({
      reason: "Excluído permanentemente pelo operador",
    }),
  });
}

export async function getClients(): Promise<ClientSummary[]> {
  return request<ClientSummary[]>("/api/clients");
}

export async function getDirectory(): Promise<DirectorySnapshot> {
  return request<DirectorySnapshot>("/api/directory");
}

export async function createDirectoryRecordType(
  input: DirectoryRecordTypeInput,
): Promise<void> {
  await request("/api/directory/types", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateDirectoryRecordType(
  id: string,
  input: DirectoryRecordTypeInput,
): Promise<void> {
  await request(`/api/directory/types/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function createDirectoryField(
  input: DirectoryFieldDefinitionInput,
): Promise<void> {
  await request("/api/directory/fields", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateDirectoryField(
  id: string,
  input: DirectoryFieldDefinitionInput,
): Promise<void> {
  await request(`/api/directory/fields/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function createDirectoryRecord(
  input: DirectoryRecordInput,
): Promise<void> {
  await request("/api/directory/records", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateDirectoryRecord(
  id: string,
  input: DirectoryRecordInput,
): Promise<void> {
  await request(`/api/directory/records/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function archiveDirectoryRecord(id: string): Promise<void> {
  await request(`/api/directory/records/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function createDirectorySegment(
  input: DirectorySegmentInput,
): Promise<void> {
  await request("/api/directory/segments", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateDirectorySegment(
  id: string,
  input: DirectorySegmentInput,
): Promise<void> {
  await request(`/api/directory/segments/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function deleteDirectorySegment(id: string): Promise<void> {
  await request(`/api/directory/segments/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function updateClientProfile(
  id: string,
  input: UpdateClientProfileInput,
): Promise<ClientSummary> {
  return request<ClientSummary>(`/api/clients/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function deleteClient(id: string): Promise<DeleteClientResponse> {
  return request<DeleteClientResponse>(`/api/clients/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: JSON.stringify({
      reason: "Removido manualmente da operação de suporte",
    }),
  });
}

export async function updateTicketContext(
  id: string,
  input: UpdateTicketContextInput,
): Promise<TicketDetail> {
  return request<TicketDetail>(`/api/tickets/${encodeURIComponent(id)}/context`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function updateTicketDirectoryContext(
  id: string,
  input: UpdateTicketDirectoryContextInput,
): Promise<TicketDetail> {
  return request<TicketDetail>(
    `/api/tickets/${encodeURIComponent(id)}/directory-context`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
}

export async function addTicketInternalNote(
  id: string,
  body: string,
  clientNoteId: string,
): Promise<TicketDetail> {
  return request<TicketDetail>(`/api/tickets/${encodeURIComponent(id)}/notes`, {
    method: "POST",
    body: JSON.stringify({ body, clientNoteId }),
  });
}

export async function updateTicketInternalNote(
  ticketId: string,
  noteId: string,
  input: UpdateTicketInternalNoteInput,
): Promise<TicketDetail> {
  return request<TicketDetail>(
    `/api/tickets/${encodeURIComponent(ticketId)}/notes/${encodeURIComponent(noteId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
}

export async function deleteTicketInternalNote(
  ticketId: string,
  noteId: string,
): Promise<TicketDetail> {
  return request<TicketDetail>(
    `/api/tickets/${encodeURIComponent(ticketId)}/notes/${encodeURIComponent(noteId)}`,
    { method: "DELETE" },
  );
}

export async function upsertTicketProductForwarding(
  id: string,
  input: UpsertTicketProductForwardingInput,
): Promise<TicketDetail> {
  return request<TicketDetail>(
    `/api/tickets/${encodeURIComponent(id)}/product-forwarding`,
    {
      method: "PUT",
      body: JSON.stringify(input),
    },
  );
}

export async function getRecordConnectorCatalog(): Promise<
  RecordConnectorSummaryDto[]
> {
  const result = await request<{ items: RecordConnectorSummaryDto[] }>(
    "/api/record-connectors",
  );
  return result.items;
}

export async function executeRecordConnector(
  ticketId: string,
  connectorId: string,
  input: ExecuteRecordConnectorInput,
): Promise<ExecuteRecordConnectorResponse> {
  return request<ExecuteRecordConnectorResponse>(
    `/api/tickets/${encodeURIComponent(ticketId)}/record-connectors/${encodeURIComponent(connectorId)}/execute`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function updateTicketStatus(
  id: string,
  status: TicketStatus,
  resolutionSummary?: string,
): Promise<TicketDetail> {
  return request<TicketDetail>(`/api/tickets/${encodeURIComponent(id)}/status`, {
    method: "PATCH",
    body: JSON.stringify({
      status,
      ...(resolutionSummary
        ? {
            resolution: {
              summary: resolutionSummary,
            },
          }
        : {}),
    }),
  });
}

export async function openInvestigationThread(
  ticketId: string,
): Promise<InvestigationThreadDto> {
  return request<InvestigationThreadDto>(
    `/api/tickets/${encodeURIComponent(ticketId)}/investigation-thread`,
    { method: "POST" },
  );
}

export async function getInvestigationThread(
  threadId: string,
): Promise<InvestigationThreadDto> {
  return request<InvestigationThreadDto>(
    `/api/investigation-threads/${encodeURIComponent(threadId)}`,
  );
}

export async function addInvestigationThreadMessage(
  threadId: string,
  body: string,
  clientMessageId: string,
): Promise<InvestigationThreadDto> {
  const input: AddInvestigationThreadMessageInput = {
    body: body.trim(),
    clientMessageId,
  };
  return request<InvestigationThreadDto>(
    `/api/investigation-threads/${encodeURIComponent(threadId)}/messages`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function cancelInvestigationThread(
  threadId: string,
): Promise<InvestigationThreadDto> {
  return request<InvestigationThreadDto>(
    `/api/investigation-threads/${encodeURIComponent(threadId)}/cancel`,
    { method: "POST" },
  );
}
