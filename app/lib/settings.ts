import type { RuntimeState } from "./types";
import { API_URL, ApiError } from "./api";
import { notifySessionExpired } from "./session-events";
import {
  type AudioTranscriptionSettingsDto,
  type LocalTranscriptionModelDto,
} from "../../shared/contracts";

export type {
  AudioTranscriptionSettingsDto,
  LocalTranscriptionModelDto,
};

export type SettingsRole = "owner" | "admin" | "operator" | "viewer";

export interface WorkspaceSettings {
  organizationName: string;
  workspaceName: string;
  timezone: string;
  workSchedule: WorkSchedule;
}

export interface WorkTimePeriod {
  startTime: string;
  endTime: string;
}

export interface WorkDaySchedule {
  dayOfWeek: number;
  periods: WorkTimePeriod[];
}

export interface WorkSchedule {
  days: WorkDaySchedule[];
}

export const DEFAULT_WORK_SCHEDULE: WorkSchedule = {
  days: [1, 2, 3, 4, 5].map((dayOfWeek) => ({
    dayOfWeek,
    periods: [{ startTime: "09:00", endTime: "18:00" }],
  })),
};

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

export interface IntegrationCredential {
  id: string;
  userId: string;
  name: string;
  scope: "headless";
  clientId: "threadmark-cli";
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IssuedIntegrationCredential {
  credential: IntegrationCredential;
  token: string;
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

function normalizeWorkspace(value: unknown): WorkspaceSettings {
  const object = asObject(value);
  const schedule = object.workSchedule && typeof object.workSchedule === "object" && !Array.isArray(object.workSchedule)
    ? (object.workSchedule as JsonObject)
    : {};
  const isClockTime = (time: unknown): time is string =>
    typeof time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
  const normalizedDays = Array.isArray(schedule.days)
    ? schedule.days.flatMap((candidate) => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
        const day = candidate as JsonObject;
        const dayOfWeek = day.dayOfWeek;
        const periods = Array.isArray(day.periods)
          ? day.periods.flatMap((period) => {
              if (!period || typeof period !== "object" || Array.isArray(period)) return [];
              const range = period as JsonObject;
              if (!isClockTime(range.startTime) || !isClockTime(range.endTime) || range.startTime >= range.endTime) return [];
              return [{ startTime: range.startTime, endTime: range.endTime }];
            })
          : [];
        return typeof dayOfWeek === "number" && Number.isInteger(dayOfWeek) && dayOfWeek >= 1 && dayOfWeek <= 7 && periods.length > 0
          ? [{ dayOfWeek, periods }]
          : [];
      })
    : Array.isArray(schedule.daysOfWeek) &&
        isClockTime(schedule.startTime) &&
        isClockTime(schedule.endTime) &&
        schedule.startTime < schedule.endTime
      ? schedule.daysOfWeek
          .filter((day): day is number => typeof day === "number" && Number.isInteger(day) && day >= 1 && day <= 7)
          .map((dayOfWeek) => ({
            dayOfWeek,
            periods: [{ startTime: schedule.startTime as string, endTime: schedule.endTime as string }],
          }))
      : [];
  const days = [...new Map(normalizedDays.map((day) => [day.dayOfWeek, day])).values()]
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek);
  const validLegacyShape = Array.isArray(schedule.daysOfWeek) &&
    isClockTime(schedule.startTime) &&
    isClockTime(schedule.endTime) &&
    schedule.startTime < schedule.endTime;
  const hasExplicitSchedule = Array.isArray(schedule.days)
    ? schedule.days.length === 0 || days.length > 0
    : validLegacyShape;
  return {
    organizationName: stringValue(object.organizationName),
    workspaceName: stringValue(object.workspaceName),
    timezone: stringValue(object.timezone, "UTC"),
    workSchedule: { days: hasExplicitSchedule ? days : DEFAULT_WORK_SCHEDULE.days },
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

function normalizeIntegrationCredential(value: unknown): IntegrationCredential {
  const object = asObject(value);
  return {
    id: stringValue(object.id),
    userId: stringValue(object.userId),
    name: stringValue(object.name),
    scope: "headless",
    clientId: "threadmark-cli",
    expiresAt: nullableString(object.expiresAt),
    lastUsedAt: nullableString(object.lastUsedAt),
    revokedAt: nullableString(object.revokedAt),
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

export async function getIntegrationCredentials(): Promise<IntegrationCredential[]> {
  const payload = asObject(
    await settingsRequest<unknown>("/api/integration-credentials"),
  );
  return Array.isArray(payload.items)
    ? payload.items.map(normalizeIntegrationCredential)
    : [];
}

export async function createIntegrationCredential(input: {
  name: string;
  expiresAt: string | null;
}): Promise<IssuedIntegrationCredential> {
  const payload = asObject(
    await settingsRequest<unknown>("/api/integration-credentials", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  );
  return {
    credential: normalizeIntegrationCredential(payload.credential),
    token: stringValue(payload.token),
  };
}

export async function revokeIntegrationCredential(
  credentialId: string,
): Promise<IntegrationCredential> {
  const payload = asObject(
    await settingsRequest<unknown>(
      `/api/integration-credentials/${encodeURIComponent(credentialId)}`,
      { method: "DELETE" },
    ),
  );
  return normalizeIntegrationCredential(payload.credential);
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
