import type { RuntimeState } from "./types";
import { API_URL, ApiError } from "./api";
import { notifySessionExpired } from "./session-events";
import {
  LOCAL_TOOL_OPERATIONS,
  LOCAL_TOOL_TYPES,
  type LocalToolConfigMap,
  type LocalToolDto,
  type LocalToolOperation,
  type LocalToolTestResult,
  type LocalToolType,
  type LocalToolWriteInput,
  type RecordConnectorDto,
  type RecordConnectorWriteInput,
  type AudioTranscriptionSettingsDto,
  type LocalTranscriptionModelDto,
} from "../../shared/contracts";

export type {
  LocalToolDto,
  LocalToolOperation,
  LocalToolTestResult,
  LocalToolType,
  LocalToolWriteInput,
  RecordConnectorDto,
  RecordConnectorWriteInput,
  AudioTranscriptionSettingsDto,
  LocalTranscriptionModelDto,
};

export type SettingsRole = "owner" | "admin" | "operator" | "viewer";

export interface WorkspaceSettings {
  organizationName: string;
  workspaceName: string;
  timezone: string;
}

export interface SettingsUser {
  id: string;
  username: string;
  displayName: string;
  role: SettingsRole;
  active: boolean;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSettingsUserInput {
  username: string;
  displayName: string;
  role: SettingsRole;
  password: string;
}

export interface UpdateSettingsUserInput {
  username?: string;
  displayName?: string;
  role?: SettingsRole;
  active?: boolean;
}

export interface StaffParticipant {
  id: string;
  displayName: string;
  phoneE164: string | null;
  externalJid: string;
  active: boolean;
}

export interface StaffSettings {
  identities: string[];
  participants: StaffParticipant[];
  restartRequired: boolean;
}

export type AiProviderId =
  | "codex"
  | "openai"
  | "anthropic"
  | "openrouter"
  | "ollama";

export interface AiConnectionCapabilities {
  structuredOutput: boolean;
  vision: boolean;
  triage: boolean;
  automaticAnalysis: boolean;
  localTools: boolean;
  codebaseAccess: boolean;
  deepInvestigation: boolean;
}

export interface AiConnection {
  id: string;
  label: string;
  providerId: AiProviderId;
  baseUrl: string | null;
  enabled: boolean;
  hasSecret: boolean;
  secretLastFour: string | null;
  capabilities: AiConnectionCapabilities;
  createdAt: string;
  updatedAt: string;
}

export interface WriteAiConnectionInput {
  label: string;
  providerId: AiProviderId;
  baseUrl?: string | null;
  enabled?: boolean;
  /** Write-only. An empty value must be omitted so an existing secret is preserved. */
  apiKey?: string;
}

export interface AiConnectionTestResult {
  ok: boolean;
  message: string;
  models?: string[];
}

export type AiTaskKind = "triage" | "automatic" | "deep";

export interface AiTaskProfile {
  taskKind: AiTaskKind;
  connectionId: string | null;
  model: string;
  enabled: boolean;
  updatedAt: string;
}

export interface WriteAiTaskProfile {
  taskKind: AiTaskKind;
  connectionId: string | null;
  model: string;
  enabled: boolean;
}

export interface WhatsappQrState {
  dataUrl: string | null;
  expiresAt: string | null;
  available: boolean;
}

export interface BackupResult {
  backup: {
    id: string;
    createdAt: string;
    attachmentsIncluded: boolean;
    directory: string;
    databasePath: string;
  };
}

export type LocalStorageComponentKey =
  | "sqlite"
  | "attachments"
  | "backups"
  | "logs"
  | "other";

export interface LocalStorageComponentUsage {
  bytes: number;
  files: number;
}

export interface LocalStorageUsage {
  measuredAt: string;
  totalBytes: number;
  components: Record<LocalStorageComponentKey, LocalStorageComponentUsage>;
  scan: {
    entriesVisited: number;
    directoriesVisited: number;
    filesCounted: number;
    skippedSymlinks: number;
    skippedSpecialFiles: number;
    unreadableEntries: number;
    truncated: boolean;
  };
}

type JsonObject = Record<string, unknown>;

async function settingsRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      credentials: "include",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError(
      "Não foi possível alcançar o serviço local do Threadmark.",
    );
  }

  if (!response.ok) {
    if (response.status === 401) notifySessionExpired();
    const payload = (await response.json().catch(() => null)) as
      | { error?: string | { message?: string }; message?: string }
      | null;
    throw new ApiError(
      payload?.message ??
        (typeof payload?.error === "string"
          ? payload.error
          : payload?.error?.message) ??
        `A API respondeu com ${response.status}.`,
      response.status,
    );
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("O serviço local devolveu uma resposta inválida.");
  }
  return value as JsonObject;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function roleValue(value: unknown): SettingsRole {
  return value === "owner" ||
    value === "admin" ||
    value === "operator" ||
    value === "viewer"
    ? value
    : "viewer";
}

function providerValue(value: unknown): AiProviderId {
  if (value === "codex_cli") return "codex";
  return value === "codex" ||
    value === "openai" ||
    value === "anthropic" ||
    value === "openrouter" ||
    value === "ollama"
    ? value
    : "codex";
}

function taskKindValue(value: unknown): AiTaskKind {
  return value === "triage" || value === "automatic" || value === "deep"
    ? value
    : "automatic";
}

function localToolTypeValue(value: unknown): LocalToolType {
  return LOCAL_TOOL_TYPES.includes(value as LocalToolType)
    ? (value as LocalToolType)
    : "codebase";
}

function localToolOperationValues(value: unknown): LocalToolOperation[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is LocalToolOperation =>
      LOCAL_TOOL_OPERATIONS.includes(item as LocalToolOperation),
  );
}

function normalizeWorkspace(value: unknown): WorkspaceSettings {
  const object = asObject(value);
  return {
    organizationName: stringValue(object.organizationName),
    workspaceName: stringValue(object.workspaceName),
    timezone: stringValue(object.timezone, "UTC"),
  };
}

function normalizeUser(value: unknown): SettingsUser {
  const object = asObject(value);
  return {
    id: stringValue(object.id),
    username: stringValue(object.username),
    displayName: stringValue(object.displayName),
    role: roleValue(object.role),
    active: booleanValue(object.active, true),
    lockedUntil: nullableString(object.lockedUntil),
    lastLoginAt: nullableString(object.lastLoginAt),
    createdAt: stringValue(object.createdAt),
    updatedAt: stringValue(object.updatedAt),
  };
}

function normalizeParticipant(value: unknown): StaffParticipant {
  const object = asObject(value);
  return {
    id: stringValue(object.id),
    displayName: stringValue(object.displayName, "Participante sem nome"),
    phoneE164: nullableString(object.phoneE164),
    externalJid: stringValue(object.externalJid),
    active: booleanValue(object.active, true),
  };
}

function normalizeConnection(value: unknown): AiConnection {
  const object = asObject(value);
  const capabilitySource = asObject(object.capabilities ?? {});
  const providerId = providerValue(object.providerId ?? object.provider);
  const localTools = booleanValue(capabilitySource.localTools);
  const codebaseAccess = booleanValue(
    capabilitySource.codebaseAccess,
    localTools,
  );
  return {
    id: stringValue(object.id),
    label: stringValue(object.label),
    providerId,
    baseUrl: nullableString(object.baseUrl),
    enabled: booleanValue(object.enabled, true),
    hasSecret: booleanValue(object.hasSecret),
    secretLastFour: nullableString(object.secretLastFour),
    capabilities: {
      structuredOutput: booleanValue(capabilitySource.structuredOutput, true),
      vision: booleanValue(capabilitySource.vision),
      triage: booleanValue(capabilitySource.triage),
      automaticAnalysis: booleanValue(capabilitySource.automaticAnalysis),
      localTools,
      codebaseAccess,
      deepInvestigation: booleanValue(capabilitySource.deepInvestigation),
    },
    createdAt: stringValue(object.createdAt),
    updatedAt: stringValue(object.updatedAt),
  };
}

function normalizeTaskProfile(value: unknown): AiTaskProfile {
  const object = asObject(value);
  return {
    taskKind: taskKindValue(object.taskKind),
    connectionId: nullableString(object.connectionId),
    model: stringValue(object.model),
    enabled: booleanValue(object.enabled, true),
    updatedAt: stringValue(object.updatedAt),
  };
}

function normalizeAudioTranscriptionSettings(
  value: unknown,
): AudioTranscriptionSettingsDto {
  const object = asObject(value);
  const queue = asObject(object.queue ?? {});
  const runtime = asObject(object.runtime ?? {});
  const models = Array.isArray(object.models) ? object.models : [];
  return {
    enabled: booleanValue(object.enabled),
    modelId: stringValue(object.modelId),
    language: stringValue(object.language, "pt"),
    autoTranscribeNew: booleanValue(object.autoTranscribeNew, true),
    updatedAt: stringValue(object.updatedAt),
    queue: {
      queued: nonNegativeNumber(queue.queued),
      processing: nonNegativeNumber(queue.processing),
      review: nonNegativeNumber(queue.review),
      failed: nonNegativeNumber(queue.failed),
    },
    runtime: {
      state:
        runtime.state === "loading" ||
        runtime.state === "ready" ||
        runtime.state === "processing" ||
        runtime.state === "error"
          ? runtime.state
          : "idle",
      activeModelId: nullableString(runtime.activeModelId),
      totalMemoryBytes: nonNegativeNumber(runtime.totalMemoryBytes),
      freeMemoryBytes: nonNegativeNumber(runtime.freeMemoryBytes),
      availableDiskBytes:
        typeof runtime.availableDiskBytes === "number"
          ? nonNegativeNumber(runtime.availableDiskBytes)
          : null,
      cacheBytes: nonNegativeNumber(runtime.cacheBytes),
      unloadAfterSeconds: nonNegativeNumber(runtime.unloadAfterSeconds),
      error: nullableString(runtime.error),
    },
    models: models.map((value): LocalTranscriptionModelDto => {
      const model = asObject(value);
      return {
        id: stringValue(model.id),
        label: stringValue(model.label),
        description: stringValue(model.description),
        estimatedDiskBytes: nonNegativeNumber(model.estimatedDiskBytes),
        estimatedRamBytes: nonNegativeNumber(model.estimatedRamBytes),
        recommended: booleanValue(model.recommended),
        state:
          model.state === "downloading" ||
          model.state === "installed" ||
          model.state === "error"
            ? model.state
            : "not_installed",
        progress: Math.max(0, Math.min(1, nonNegativeNumber(model.progress))),
        cacheBytes: nonNegativeNumber(model.cacheBytes),
        error: nullableString(model.error),
        installedAt: nullableString(model.installedAt),
      };
    }),
  };
}

function normalizeLocalTool(value: unknown): LocalToolDto {
  const object = asObject(value);
  const type = localToolTypeValue(object.type);
  return {
    id: stringValue(object.id),
    type,
    name: stringValue(object.name),
    description: nullableString(object.description),
    enabled: booleanValue(object.enabled, true),
    deepEnabled: booleanValue(object.deepEnabled, true),
    allowedOperations: localToolOperationValues(object.allowedOperations),
    config: asObject(object.config ?? {}) as unknown as LocalToolConfigMap[LocalToolType],
    secretFields: Array.isArray(object.secretFields)
      ? object.secretFields.filter((item): item is string => typeof item === "string")
      : [],
    lastTestedAt: nullableString(object.lastTestedAt),
    lastTestStatus:
      object.lastTestStatus === "success" || object.lastTestStatus === "failed"
        ? object.lastTestStatus
        : null,
    lastTestMessage: nullableString(object.lastTestMessage),
    createdAt: stringValue(object.createdAt),
    updatedAt: stringValue(object.updatedAt),
  };
}

function normalizeRecordConnector(value: unknown): RecordConnectorDto {
  return asObject(value) as unknown as RecordConnectorDto;
}

function normalizeStorageComponent(value: unknown): LocalStorageComponentUsage {
  const object = asObject(value ?? {});
  return {
    bytes: nonNegativeNumber(object.bytes),
    files: nonNegativeNumber(object.files),
  };
}

function normalizeLocalStorageUsage(value: unknown): LocalStorageUsage {
  const object = asObject(value);
  const components = asObject(object.components ?? {});
  const scan = asObject(object.scan ?? {});
  return {
    measuredAt: stringValue(object.measuredAt),
    totalBytes: nonNegativeNumber(object.totalBytes),
    components: {
      sqlite: normalizeStorageComponent(components.sqlite),
      attachments: normalizeStorageComponent(components.attachments),
      backups: normalizeStorageComponent(components.backups),
      logs: normalizeStorageComponent(components.logs),
      other: normalizeStorageComponent(components.other),
    },
    scan: {
      entriesVisited: nonNegativeNumber(scan.entriesVisited),
      directoriesVisited: nonNegativeNumber(scan.directoriesVisited),
      filesCounted: nonNegativeNumber(scan.filesCounted),
      skippedSymlinks: nonNegativeNumber(scan.skippedSymlinks),
      skippedSpecialFiles: nonNegativeNumber(scan.skippedSpecialFiles),
      unreadableEntries: nonNegativeNumber(scan.unreadableEntries),
      truncated: booleanValue(scan.truncated),
    },
  };
}

export async function getWorkspaceSettings(): Promise<WorkspaceSettings> {
  return normalizeWorkspace(
    await settingsRequest<unknown>("/api/settings/workspace"),
  );
}

export async function updateWorkspaceSettings(
  input: WorkspaceSettings,
): Promise<WorkspaceSettings> {
  return normalizeWorkspace(
    await settingsRequest<unknown>("/api/settings/workspace", {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  );
}

export async function getSettingsUsers(): Promise<SettingsUser[]> {
  const payload = asObject(await settingsRequest<unknown>("/api/users"));
  return Array.isArray(payload.items) ? payload.items.map(normalizeUser) : [];
}

export async function createSettingsUser(
  input: CreateSettingsUserInput,
): Promise<SettingsUser> {
  return normalizeUser(
    await settingsRequest<unknown>("/api/users", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  );
}

export async function updateSettingsUser(
  userId: string,
  input: UpdateSettingsUserInput,
): Promise<SettingsUser> {
  return normalizeUser(
    await settingsRequest<unknown>(`/api/users/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  );
}

export async function deleteSettingsUser(userId: string): Promise<void> {
  await settingsRequest<{ ok: true }>(`/api/users/${encodeURIComponent(userId)}`, {
    method: "DELETE",
  });
}

export async function getStaffSettings(): Promise<StaffSettings> {
  const payload = asObject(
    await settingsRequest<unknown>("/api/settings/staff"),
  );
  return {
    identities: Array.isArray(payload.identities)
      ? payload.identities.filter((item): item is string => typeof item === "string")
      : [],
    participants: Array.isArray(payload.participants)
      ? payload.participants.map(normalizeParticipant)
      : [],
    restartRequired: booleanValue(payload.restartRequired),
  };
}

export async function updateStaffSettings(
  identities: string[],
): Promise<StaffSettings> {
  const payload = asObject(
    await settingsRequest<unknown>("/api/settings/staff", {
      method: "PUT",
      body: JSON.stringify({ identities }),
    }),
  );
  return {
    identities: Array.isArray(payload.identities)
      ? payload.identities.filter((item): item is string => typeof item === "string")
      : [],
    participants: Array.isArray(payload.participants)
      ? payload.participants.map(normalizeParticipant)
      : [],
    restartRequired: booleanValue(payload.restartRequired),
  };
}

export function getWhatsappRuntime(): Promise<RuntimeState> {
  return settingsRequest<RuntimeState>("/api/runtime");
}

export async function getWhatsappQr(): Promise<WhatsappQrState> {
  const payload = asObject(await settingsRequest<unknown>("/api/runtime/qr"));
  const possibleDataUrl =
    nullableString(payload.dataUrl) ?? nullableString(payload.qrDataUrl);
  return {
    dataUrl:
      possibleDataUrl?.startsWith("data:image/") === true
        ? possibleDataUrl
        : null,
    expiresAt: nullableString(payload.expiresAt),
    available:
      booleanValue(payload.available) || possibleDataUrl?.startsWith("data:image/") === true,
  };
}

export async function renewWhatsappQr(): Promise<void> {
  await settingsRequest<{ accepted: true }>("/api/runtime/qr/renew", {
    method: "POST",
  });
}

export async function getAiConnections(): Promise<AiConnection[]> {
  const payload = asObject(
    await settingsRequest<unknown>("/api/ai/connections"),
  );
  return Array.isArray(payload.items)
    ? payload.items.map(normalizeConnection)
    : [];
}

export async function createAiConnection(
  input: WriteAiConnectionInput,
): Promise<AiConnection> {
  return normalizeConnection(
    await settingsRequest<unknown>("/api/ai/connections", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  );
}

export async function updateAiConnection(
  connectionId: string,
  input: Partial<WriteAiConnectionInput>,
): Promise<AiConnection> {
  return normalizeConnection(
    await settingsRequest<unknown>(
      `/api/ai/connections/${encodeURIComponent(connectionId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      },
    ),
  );
}

export async function deleteAiConnection(connectionId: string): Promise<void> {
  await settingsRequest<{ ok: true }>(
    `/api/ai/connections/${encodeURIComponent(connectionId)}`,
    { method: "DELETE" },
  );
}

export function testAiConnection(
  connectionId: string,
): Promise<AiConnectionTestResult> {
  return settingsRequest<AiConnectionTestResult>(
    `/api/ai/connections/${encodeURIComponent(connectionId)}/test`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export async function getAiTaskProfiles(): Promise<AiTaskProfile[]> {
  const payload = asObject(
    await settingsRequest<unknown>("/api/ai/task-profiles"),
  );
  return Array.isArray(payload.items)
    ? payload.items.map(normalizeTaskProfile)
    : [];
}

export async function updateAiTaskProfiles(
  items: WriteAiTaskProfile[],
): Promise<AiTaskProfile[]> {
  const payload = asObject(
    await settingsRequest<unknown>("/api/ai/task-profiles", {
      method: "PUT",
      body: JSON.stringify({ items }),
    }),
  );
  return Array.isArray(payload.items)
    ? payload.items.map(normalizeTaskProfile)
    : [];
}

export async function getAudioTranscriptionSettings(): Promise<AudioTranscriptionSettingsDto> {
  return normalizeAudioTranscriptionSettings(
    await settingsRequest<unknown>("/api/ai/audio-transcription"),
  );
}

export async function updateAudioTranscriptionSettings(input: {
  enabled: boolean;
  modelId: string;
  language: string;
  autoTranscribeNew: boolean;
}): Promise<AudioTranscriptionSettingsDto> {
  return normalizeAudioTranscriptionSettings(
    await settingsRequest<unknown>("/api/ai/audio-transcription", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  );
}

export async function installAudioTranscriptionModel(
  modelId: string,
): Promise<void> {
  await settingsRequest<{ accepted: true }>(
    `/api/ai/audio-transcription/models/${encodeURIComponent(modelId)}/install`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export async function removeAudioTranscriptionModel(
  modelId: string,
): Promise<void> {
  await settingsRequest<{ ok: true }>(
    `/api/ai/audio-transcription/models/${encodeURIComponent(modelId)}`,
    { method: "DELETE" },
  );
}

export async function queueHistoricalAudioTranscription(
  limit = 100,
): Promise<number> {
  const payload = asObject(
    await settingsRequest<unknown>("/api/ai/audio-transcription/history", {
      method: "POST",
      body: JSON.stringify({ limit }),
    }),
  );
  return nonNegativeNumber(payload.queued);
}

export async function retryAudioTranscription(
  attachmentId: string,
): Promise<void> {
  await settingsRequest<{ queued: true }>(
    `/api/attachments/${encodeURIComponent(attachmentId)}/transcription/retry`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export async function queueAudioTranscription(
  attachmentId: string,
): Promise<void> {
  await settingsRequest<{ queued: true }>(
    `/api/attachments/${encodeURIComponent(attachmentId)}/transcription`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export async function getLocalTools(): Promise<LocalToolDto[]> {
  const payload = asObject(await settingsRequest<unknown>("/api/tools"));
  return Array.isArray(payload.items) ? payload.items.map(normalizeLocalTool) : [];
}

export async function getRecordConnectors(): Promise<RecordConnectorDto[]> {
  const payload = asObject(
    await settingsRequest<unknown>("/api/settings/record-connectors"),
  );
  return Array.isArray(payload.items)
    ? payload.items.map(normalizeRecordConnector)
    : [];
}

export async function createRecordConnector(
  input: RecordConnectorWriteInput,
): Promise<RecordConnectorDto> {
  return normalizeRecordConnector(
    await settingsRequest<unknown>("/api/settings/record-connectors", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  );
}

export async function updateRecordConnector(
  connectorId: string,
  input: RecordConnectorWriteInput,
): Promise<RecordConnectorDto> {
  return normalizeRecordConnector(
    await settingsRequest<unknown>(
      `/api/settings/record-connectors/${encodeURIComponent(connectorId)}`,
      {
        method: "PUT",
        body: JSON.stringify(input),
      },
    ),
  );
}

export async function archiveRecordConnector(
  connectorId: string,
): Promise<void> {
  await settingsRequest<{ ok: true }>(
    `/api/settings/record-connectors/${encodeURIComponent(connectorId)}`,
    { method: "DELETE" },
  );
}

export async function createLocalTool(
  input: LocalToolWriteInput,
): Promise<LocalToolDto> {
  return normalizeLocalTool(
    await settingsRequest<unknown>("/api/tools", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  );
}

export async function updateLocalTool(
  toolId: string,
  input: Partial<LocalToolWriteInput>,
): Promise<LocalToolDto> {
  return normalizeLocalTool(
    await settingsRequest<unknown>(`/api/tools/${encodeURIComponent(toolId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  );
}

export async function deleteLocalTool(toolId: string): Promise<void> {
  await settingsRequest<{ ok: true }>(`/api/tools/${encodeURIComponent(toolId)}`, {
    method: "DELETE",
  });
}

export function testLocalTool(toolId: string): Promise<LocalToolTestResult> {
  return settingsRequest<LocalToolTestResult>(
    `/api/tools/${encodeURIComponent(toolId)}/test`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export function createLocalBackup(
  includeAttachments: boolean,
): Promise<BackupResult> {
  return settingsRequest<BackupResult>("/api/settings/backup", {
    method: "POST",
    body: JSON.stringify({ includeAttachments }),
  });
}

export async function getLocalStorageUsage(): Promise<LocalStorageUsage> {
  return normalizeLocalStorageUsage(
    await settingsRequest<unknown>("/api/settings/storage"),
  );
}
