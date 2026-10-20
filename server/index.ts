import { ChannelService } from "./channels/service.js";
import { readChannelBody } from "./channels/http.js";
import { fileURLToPath } from "node:url";
import { isAbsolute, relative, resolve } from "node:path";
import { readFile, realpath } from "node:fs/promises";

import { serve, type ServerType } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import QRCode from "qrcode";
import { z } from "zod";

import {
  CATEGORY_FACETS,
  CLIENT_KINDS,
  PRODUCT_FORWARDING_DESCRIPTION_MAX_LENGTH,
  PRODUCT_FORWARDING_EXTERNAL_REFERENCE_MAX_LENGTH,
  PRODUCT_FORWARDING_KINDS,
  PRODUCT_FORWARDING_TITLE_MAX_LENGTH,
  TICKET_INTERNAL_NOTE_MAX_LENGTH,
  TICKET_PRIORITIES,
  TICKET_SUMMARY_MAX_LENGTH,
  TICKET_STATUSES,
  TICKET_TITLE_MAX_LENGTH,

  type ApiErrorResponse,
  type DashboardExportRowDto,
  type DashboardPeriodInput,
  type RuntimeStatusDto,
  type TicketStatus,
  AUTH_ROLES,
  type AuthRole,
  type AuthUserDto,
  type CategoryFacet,
} from "../shared/contracts.js";
import {
  AuthError,
  IntegrationCredentialService,
  LocalAuthService,
  SetupChallengeService,
} from "./auth/index.js";
import { LocalAccessToken } from "./auth/local-access-token.js";
import { triageAnalysisSchema } from "./agent/validation.js";
import { createDatabase, type SupportDatabase } from "./db/index.js";
import {
  DirectoryStore,
  DomainError,
  SupportStore,
  ValidationError,
} from "./domain/index.js";
import { loadConfig } from "./runtime/config.js";
import {
  readWebBuildReloadRequest,
  webBuildReloadPath,
} from "./runtime/web-build-reload.js";
import {
  createLocalBackup,
  DEFAULT_LOCAL_BACKUP_RETENTION,
} from "./runtime/backup.js";
import { LocalSecretVault } from "./runtime/secret-vault.js";
import {
  LocalSettingsFile,
  mergeConfiguredIdentities,
} from "./runtime/local-settings.js";
import { resolveConfiguredStaffIdentities } from "./runtime/staff-identities.js";
import {
  RuntimeStateFile,
  type RuntimeState,
} from "./runtime/runtime-state.js";
import {
  LocalStorageUsageError,
  LocalStorageUsageService,
  type LocalStorageUsageReader,
} from "./runtime/storage-usage.js";
import { TRIAGE_PROMPT_VERSION } from "./triage/index.js";
import { AudioTranscriptionService } from "./transcription/index.js";
import { AutomationRuntime } from "./automation-runtime/index.js";
import {
  AutomationApiError,
  AutomationApiService,
} from "./automation-runtime/api-service.js";
import { AutomationValidationError } from "./automations/index.js";
import { ConnectedAppSettingsError } from "./integrations/index.js";
import { NotificationService } from "./notifications/index.js";


interface RuntimeStateReader {
  read(): Promise<RuntimeState>;
}

interface EphemeralQrReader {
  getEphemeralQr(): string | null;
}

interface WhatsappQrController {
  renewQr(): Promise<void>;
}


export interface StartApiServerOptions {
  host?: string;
  port?: number;
  store?: SupportStore;
  database?: SupportDatabase;
  runtimeState?: RuntimeStateReader;
  qrReader?: EphemeralQrReader;
  authService?: LocalAuthService;
  setupChallenges?: SetupChallengeService;
  localAccessToken?: LocalAccessToken;
  localSettings?: LocalSettingsFile;
  storageUsage?: LocalStorageUsageReader;
  requestShutdown?: (reason: string) => void | Promise<void>;
  whatsappQrController?: WhatsappQrController;
  audioTranscription?: AudioTranscriptionService;
  automationRuntime?: AutomationRuntime;
  notifications?: NotificationService;
  attachmentsDirectory?: string;
}

type RequestIdentity =
  | { kind: "user"; user: AuthUserDto; sessionToken: string }
  | {
      kind: "agent";
      user: AuthUserDto;
      sessionToken: null;
      clientId: "threadmark-cli";
      clientLabel: "Threadmark CLI";
      integrationCredentialId: string | null;
    }
  | {
      kind: "local";
      user: AuthUserDto;
      sessionToken: null;
    }
  | {
      kind: "test";
      user: AuthUserDto;
      sessionToken: null;
    };

type ApiEnvironment = {
  Variables: {
    identity: RequestIdentity | null;
  };
};

interface ApiServices {
  channels?: ChannelService;
  auth?: LocalAuthService;
  setupChallenges?: SetupChallengeService;
  localAccessToken?: LocalAccessToken;
  localSettings?: LocalSettingsFile;
  storageUsage?: LocalStorageUsageReader;
  requestShutdown?: (reason: string) => void | Promise<void>;
  whatsappQrController?: WhatsappQrController;
  audioTranscription?: AudioTranscriptionService;
  automations?: AutomationApiService;
  notifications?: NotificationService;
  attachmentsDirectory?: string;
}

const SESSION_COOKIE = "threadmark_session";

const integrationCredentialInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    // Aceita o campo de clientes antigos, sem usá-lo para definir acesso.
    clientId: z.string().trim().max(200).optional(),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

const statusInputSchema = z.object({
  status: z.enum(TICKET_STATUSES),
  actor: z.string().trim().min(1).optional(),
  reason: z.string().trim().min(1).optional(),
  resolution: z
    .object({
      summary: z.string().trim().min(1),
      rootCause: z.string().trim().min(1).optional(),
      outcome: z.string().trim().min(1).optional(),
      validatedBy: z.string().trim().min(1).optional(),
    })
    .optional(),
});

const ticketContextInputSchema = z
  .object({
    clientId: z.string().trim().min(1).max(200),
    affectedStoreId: z.union([z.string().trim().min(1).max(200), z.null()]).optional(),
    rememberForConversation: z.boolean(),
    actor: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const ticketMetadataInputSchema = z
  .object({
    title: z.string().trim().min(1).max(TICKET_TITLE_MAX_LENGTH),
    summary: z.string().trim().min(1).max(TICKET_SUMMARY_MAX_LENGTH),
    priority: z.enum(TICKET_PRIORITIES),
    requesterId: z.union([z.string().trim().min(1).max(200), z.null()]),
  })
  .strict();

const ticketAssigneeInputSchema = z
  .object({
    assigneeId: z.union([z.string().trim().min(1).max(200), z.null()]),
  })
  .strict();

const notificationListQuerySchema = z.object({
  unread: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0),
}).strict();

const notificationReadSchema = z.object({
  read: z.boolean(),
}).strict();

const ticketInternalNoteInputSchema = z
  .object({
    body: z.string().trim().min(1).max(TICKET_INTERNAL_NOTE_MAX_LENGTH),
    clientNoteId: z.string().trim().min(1).max(200),
  })
  .strict();

const externalTicketMessagesInputSchema = z
  .object({
    sourceType: z.string().trim().min(1).max(100),
    sourceConversationId: z.string().trim().min(1).max(200),
    messages: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(200),
            author: z.string().trim().min(1).max(200),
            authorRole: z.enum(["customer", "support"]),
            body: z.string().trim().min(1).max(20_000),
            occurredAt: z.string().datetime({ offset: true }),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

const ticketInternalNoteUpdateSchema = z
  .object({
    body: z.string().trim().min(1).max(TICKET_INTERNAL_NOTE_MAX_LENGTH),
    expectedUpdatedAt: z.string().trim().datetime({ offset: true }),
  })
  .strict();

const ticketProductForwardingInputSchema = z
  .object({
    kind: z.enum(PRODUCT_FORWARDING_KINDS),
    title: z
      .string()
      .trim()
      .min(1)
      .max(PRODUCT_FORWARDING_TITLE_MAX_LENGTH),
    description: z
      .string()
      .trim()
      .min(1)
      .max(PRODUCT_FORWARDING_DESCRIPTION_MAX_LENGTH),
    externalReference: z
      .union([
        z
          .string()
          .trim()
          .min(1)
          .max(PRODUCT_FORWARDING_EXTERNAL_REFERENCE_MAX_LENGTH),
        z.null(),
      ])
      .optional(),
    resolveTicket: z.boolean().optional(),
  })
  .strict();

const clientIgnoreInputSchema = z
  .object({
    actor: z.string().trim().min(1).max(200).optional(),
    reason: z.union([z.string().trim().max(1_000), z.null()]).optional(),
  })
  .strict();

const ticketDeleteInputSchema = z
  .object({
    actor: z.string().trim().min(1).max(200).optional(),
    reason: z.union([z.string().trim().max(1_000), z.null()]).optional(),
  })
  .strict();

const ticketBulkStatusInputSchema = z
  .object({
    ticketIds: z
      .array(z.string().trim().min(1).max(200))
      .min(1)
      .max(500)
      .refine((ticketIds) => new Set(ticketIds).size === ticketIds.length, {
        message: "A seleção contém tickets duplicados",
      }),
    status: z.enum(["archived", "resolved"]),
    actor: z.string().trim().min(1).max(200).optional(),
    reason: z.union([z.string().trim().min(1).max(1_000), z.null()]).optional(),
  })
  .strict();

const manualTicketCreateInputSchema = z
  .object({
    clientRequestId: z.string().trim().min(1).max(200),
    groupId: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(20_000),
    priority: z.enum(TICKET_PRIORITIES).optional(),
    actor: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const conversationMessageIdsSchema = z
  .array(z.string().trim().min(1).max(200))
  .min(1)
  .max(500);

const conversationBatchFields = {
  messageIds: conversationMessageIdsSchema,
  clientRequestId: z.string().trim().min(1).max(200).optional(),
  actor: z.string().trim().min(1).max(200).optional(),
  reason: z.union([z.string().trim().max(1_000), z.null()]).optional(),
};

const conversationCreateTicketInputSchema = z
  .object({
    ...conversationBatchFields,
    title: z.string().trim().min(1).max(200).optional(),
    summary: z.string().trim().min(1).max(20_000).optional(),
    clientId: z.union([z.string().trim().min(1).max(200), z.null()]).optional(),
    affectedStoreId: z
      .union([z.string().trim().min(1).max(200), z.null()])
      .optional(),
    priority: z.enum(TICKET_PRIORITIES).optional(),
  })
  .strict();

const conversationAttachInputSchema = z
  .object({
    ...conversationBatchFields,
    ticketId: z.string().trim().min(1).max(200),
  })
  .strict();

const conversationBatchInputSchema = z
  .object(conversationBatchFields)
  .strict();

const conversationSuggestionSettingsInputSchema = z
  .object({
    muted: z.boolean(),
    actor: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const conversationClearPendingInputSchema = z
  .object({
    actor: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const externalTriageLeaseInputSchema = z
  .object({
    leaseSeconds: z.number().int().min(30).max(15 * 60).default(10 * 60),
  })
  .strict();

const externalTriageCompleteInputSchema = z
  .object({
    analysis: triageAnalysisSchema,
    model: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const categoryCreateInputSchema = z
  .object({
    facet: z.enum(CATEGORY_FACETS),
    label: z.string().trim().min(1).max(120),
    color: z
      .string()
      .trim()
      .min(4)
      .max(40)
      .optional()
      .nullable(),
  })
  .strict();

const categoryUpdateInputSchema = categoryCreateInputSchema;

const categoryDeleteInputSchema = z
  .object({
    replacementCategoryId: z.string().trim().min(1).max(200).optional().nullable(),
  })
  .strict();

const categoryAttachInputSchema = z
  .object({
    categoryId: z.string().trim().min(1).max(200),
    actor: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const triageAiSettingsInputSchema = z
  .object({
    enabled: z.boolean(),
    model: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9._:/-]+$/),
    silenceWindowSeconds: z.number().int().min(30).max(1_800).optional(),
    actor: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const setupInputSchema = z
  .object({
    bootstrapToken: z.string().trim().min(1),
    organizationName: z.string().trim().min(1).max(160).optional(),
    workspaceName: z.string().trim().min(1).max(120),
    timezone: z.string().trim().min(1).max(100),
    username: z.string().trim().min(3).max(64).optional(),
    login: z.string().trim().min(3).max(64).optional(),
    displayName: z.string().trim().min(1).max(120),
    password: z.string().min(12).max(256),
  })
  .strict()
  .superRefine((input, context) => {
    if (!input.username && !input.login) {
      context.addIssue({
        code: "custom",
        message: "Informe o login do administrador",
        path: ["login"],
      });
    }
  });

const loginInputSchema = z
  .object({
    username: z.string().trim().min(1).max(64).optional(),
    login: z.string().trim().min(1).max(64).optional(),
    password: z.string().max(256),
  })
  .strict();

const createUserInputSchema = z
  .object({
    username: z.string().trim().min(3).max(64),
    displayName: z.string().trim().min(1).max(120),
    role: z.enum(AUTH_ROLES),
    password: z.string().min(12).max(256),
  })
  .strict();

const updateUserInputSchema = z
  .object({
    username: z.string().trim().min(3).max(64).optional(),
    displayName: z.string().trim().min(1).max(120).optional(),
    role: z.enum(AUTH_ROLES).optional(),
    active: z.boolean().optional(),
  })
  .strict();

const changePasswordInputSchema = z
  .object({
    currentPassword: z.string().max(256),
    password: z.string().min(12).max(256),
  })
  .strict();

const workTimePeriodSchema = z
  .object({
    startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Informe um horário inicial válido"),
    endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Informe um horário final válido"),
  })
  .strict()
  .refine((period) => period.startTime < period.endTime, {
    message: "O término precisa ser depois do início",
    path: ["endTime"],
  });

const workDayScheduleSchema = z
  .object({
    dayOfWeek: z.number().int().min(1).max(7),
    periods: z
      .array(workTimePeriodSchema)
      .min(1)
      .max(4)
      .refine(
        (periods) => periods.every((period, index) => index === 0 || periods[index - 1]!.endTime <= period.startTime),
        "Os períodos do dia não podem se sobrepor e precisam estar em ordem",
      ),
  })
  .strict();

const workScheduleSchema = z
  .object({
    days: z
      .array(workDayScheduleSchema)
      .max(7)
      .refine((days) => new Set(days.map((day) => day.dayOfWeek)).size === days.length, "Os dias não podem se repetir"),
  })
  .strict();

const workspaceSettingsInputSchema = z
  .object({
    organizationName: z.string().trim().min(1).max(160).optional(),
    workspaceName: z.string().trim().min(1).max(120).optional(),
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine(isValidTimeZone, "Informe um fuso horário IANA válido")
      .optional(),
    workSchedule: workScheduleSchema.optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0, {
    message: "Informe ao menos uma configuração para alterar",
  });

const staffSettingsInputSchema = z
  .object({
    identities: z
      .array(z.string().trim().min(1).max(200))
      .max(500)
      .transform((values) => [...new Set(values)]),
  })
  .strict();

const audioTranscriptionSettingsInputSchema = z
  .object({
    enabled: z.boolean(),
    modelId: z.string().trim().min(1).max(200),
    language: z.string().trim().min(2).max(20).optional(),
    autoTranscribeNew: z.boolean(),
  })
  .strict();

const audioTranscriptionHistoryInputSchema = z
  .object({
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();

const backupInputSchema = z
  .object({ includeAttachments: z.boolean().default(false) })
  .strict();

const nullableProfileText = z.union([
  z.string().trim().max(500),
  z.null(),
]);

const clientProfileInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    kind: z.enum(CLIENT_KINDS),
    notes: z.union([z.string().trim().max(4_000), z.null()]).optional(),
    stores: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(200).optional(),
            name: z.string().trim().min(1).max(200),
            businessId: nullableProfileText.optional(),
            platform: nullableProfileText.optional(),
          })
          .strict(),
      )
      .max(250),
  })
  .strict();

function apiError(code: string, message: string, details?: unknown): ApiErrorResponse {
  return {
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };
}

function parseTicketStatuses(values: string[]): TicketStatus[] | undefined {
  const requested = values.flatMap((value) => value.split(",")).filter(Boolean);
  if (!requested.length) {
    return undefined;
  }
  const statuses = new Set<TicketStatus>(TICKET_STATUSES);
  const invalid = requested.filter((status) => !statuses.has(status as TicketStatus));
  if (invalid.length) {
    throw new DomainError(
      `Status inválido: ${invalid.join(", ")}`,
      "validation_error",
      400,
      { invalid, allowed: TICKET_STATUSES },
    );
  }
  return requested as TicketStatus[];
}

function parseCategoryListFilters(url: URL): {
  query?: string;
  facet?: CategoryFacet;
  includeEmpty?: boolean;
} {
  const query = url.searchParams.get("q")?.trim();
  const rawFacet = url.searchParams.get("facet");
  const facet = rawFacet ? z.enum(CATEGORY_FACETS).parse(rawFacet) : undefined;

  const rawIncludeEmpty = url.searchParams.get("includeEmpty");
  const includeEmpty = rawIncludeEmpty ? rawIncludeEmpty === "true" : undefined;

  return {
    query: query?.length ? query : undefined,
    facet,
    includeEmpty,
  };
}

function runtimeFromFile(
  state: RuntimeState,
  fallback: RuntimeStatusDto,
): RuntimeStatusDto {
  return {
    ...fallback,
    state: state.phase,
    pid: state.pid,
    startedAt: state.startedAt,
    lastHeartbeatAt: state.updatedAt,
    whatsappConnected: state.whatsappConnected,
    qrAvailable: state.qrAvailable,
    lastError: state.lastError,
  };
}

function dashboardQueryFromUrl(url: URL): {
  period: DashboardPeriodInput | undefined;
  assigneeId: string | readonly string[] | null | undefined;
} {
  const from = url.searchParams.get("from")?.trim() || null;
  const to = url.searchParams.get("to")?.trim() || null;
  if (!from || !to) {
    if (from || to) {
      throw new ValidationError("Informe from e to juntos no formato YYYY-MM-DD", {
        from,
        to,
      });
    }
  }
  const rawAssignees = url.searchParams.getAll("assigneeId").map((value) => value.trim());
  if (rawAssignees.some((value) => !value)) {
    throw new ValidationError("Informe um responsável válido para filtrar o dashboard");
  }
  if (rawAssignees.some((value) => value.length > 200) || rawAssignees.length > 100) {
    throw new ValidationError("Identificador de responsável inválido");
  }
  const assignees = [...new Set(rawAssignees)];
  if (assignees.includes("unassigned") && assignees.length > 1) {
    throw new ValidationError("Não é possível combinar a fila sem responsável com pessoas específicas");
  }
  return {
    period: from && to ? { from, to } : undefined,
    assigneeId: assignees.length
      ? assignees.length === 1 && assignees[0] === "unassigned"
        ? null
        : assignees.length === 1
          ? assignees[0]
          : assignees
      : undefined,
  };
}

function dashboardExportCsv(rows: DashboardExportRowDto[]): string {
  const header = [
    "ticket_id",
    "ticket_number",
    "title",
    "summary",
    "client_name",
    "client_kind",
    "group_subject",
    "affected_store_name",
    "assignee_name",
    "assignee_role",
    "status",
    "priority",
    "needs_review",
    "categories",
    "created_at_utc",
    "created_at_local",
    "latest_resolution_at_utc",
    "latest_resolution_at_local",
    "created_in_period",
    "resolved_in_period",
  ];
  const body = rows.map((row) =>
    [
      row.ticketId,
      row.ticketNumber,
      row.title,
      row.summary,
      row.clientName,
      row.clientKind,
      row.groupSubject,
      row.affectedStoreName,
      row.assigneeName,
      row.assigneeRole,
      row.status,
      row.priority,
      row.needsReview,
      row.categories.join(" | "),
      row.createdAt,
      row.createdAtSaoPaulo,
      row.latestResolutionAt,
      row.latestResolutionAtSaoPaulo,
      row.createdInPeriod,
      row.resolvedInPeriod,
    ]
      .map(csvCell)
      .join(","),
  );
  return `\uFEFF${[header.map(csvCell).join(","), ...body].join("\r\n")}\r\n`;
}

function csvCell(value: string | number | boolean | null): string {
  let normalized = value === null ? "" : String(value);
  if (/^[=+\-@\t\r\n]/.test(normalized)) normalized = `'${normalized}`;
  return `"${normalized.replaceAll('"', '""')}"`;
}

function isPublicApiPath(pathname: string): boolean {
  return new Set([
    "/api/setup/status",
    "/api/setup/complete",
    "/api/auth/login",
  ]).has(pathname);
}

function isMutation(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function requireAuthService(services: ApiServices): LocalAuthService {
  if (!services.auth) {
    throw new DomainError(
      "Autenticação local indisponível",
      "service_unavailable",
      503,
    );
  }
  return services.auth;
}

function requireSetupChallenges(services: ApiServices): SetupChallengeService {
  if (!services.setupChallenges) {
    throw new DomainError(
      "Configuração inicial indisponível",
      "service_unavailable",
      503,
    );
  }
  return services.setupChallenges;
}

function requireLocalSettings(services: ApiServices): LocalSettingsFile {
  if (!services.localSettings) {
    throw new DomainError(
      "Configurações locais indisponíveis",
      "service_unavailable",
      503,
    );
  }
  return services.localSettings;
}

function requireAudioTranscription(
  services: ApiServices,
): AudioTranscriptionService {
  if (!services.audioTranscription) {
    throw new DomainError(
      "Transcrição local de áudio indisponível",
      "service_unavailable",
      503,
    );
  }
  return services.audioTranscription;
}

function requireStorageUsage(services: ApiServices): LocalStorageUsageReader {
  if (!services.storageUsage) {
    throw new DomainError(
      "Medição do armazenamento local indisponível",
      "service_unavailable",
      503,
    );
  }
  return services.storageUsage;
}

function requireAutomations(services: ApiServices): AutomationApiService {
  if (!services.automations) {
    throw new DomainError(
      "Automações indisponíveis nesta instalação",
      "service_unavailable",
      503,
    );
  }
  return services.automations;
}

function requireNotifications(services: ApiServices): NotificationService {
  if (!services.notifications) {
    throw new DomainError(
      "Central de notificações indisponível nesta instalação",
      "service_unavailable",
      503,
    );
  }
  return services.notifications;
}

function notificationUserId(context: Context<ApiEnvironment>): string {
  const identity = context.get("identity");
  if (!identity) {
    throw new AuthError("authentication_required", "Entre para continuar.");
  }
  return identity.user.id;
}

function requireUserIdentity(context: Context<ApiEnvironment>): Extract<RequestIdentity, { kind: "user" }> {
  const identity = context.get("identity");
  if (!identity || identity.kind !== "user") {
    throw new AuthError("authentication_required", "Entre para continuar.");
  }
  return identity;
}

function requireLocalMachineIdentity(
  context: Context<ApiEnvironment>,
): Extract<RequestIdentity, { kind: "local" }> {
  const identity = context.get("identity");
  if (!identity || identity.kind !== "local") {
    throw new AuthError(
      "forbidden",
      "Esta operação exige a credencial local da instalação.",
    );
  }
  return identity;
}

function requireAgentIdentity(
  context: Context<ApiEnvironment>,
): Extract<RequestIdentity, { kind: "agent" }> {
  const identity = context.get("identity");
  if (!identity || identity.kind !== "agent") {
    throw new AuthError(
      "forbidden",
      "Esta operação exige uma identidade CLI delegada e autenticada.",
    );
  }
  return identity;
}

function requireIntegrationIdentity(
  context: Context<ApiEnvironment>,
): Extract<RequestIdentity, { kind: "agent" }> {
  const identity = context.get("identity");
  if (!identity || identity.kind !== "agent" || !identity.integrationCredentialId) {
    throw new AuthError(
      "forbidden",
      "Esta operação exige uma credencial de integração autenticada.",
    );
  }
  return identity;
}

function requireRole(
  context: Context<ApiEnvironment>,
  roles: AuthRole[],
): RequestIdentity {
  const identity = context.get("identity");
  if (!identity) {
    throw new AuthError("authentication_required", "Entre para continuar.");
  }
  if (!roles.includes(identity.user.role)) {
    throw new AuthError("forbidden", "Você não tem permissão para esta ação.");
  }
  return identity;
}

function actorFor(
  context: Context<ApiEnvironment>,
  unauthenticatedFallback?: string | null,
): string {
  const identity = context.get("identity");
  if (identity?.kind === "test") {
    return unauthenticatedFallback?.trim() || "Operador local";
  }
  if (identity?.kind === "agent") {
    return `${identity.clientLabel} · ${identity.user.displayName}`;
  }
  return (
    identity?.user.displayName ??
    unauthenticatedFallback?.trim() ??
    "Operador local"
  );
}

function localMachineIdentity(): Extract<RequestIdentity, { kind: "local" }> {
  const now = new Date().toISOString();
  return {
    kind: "local",
    sessionToken: null,
    user: {
      id: "local-machine",
      username: "local-machine",
      displayName: "Threadmark local",
      role: "owner",
      active: true,
      lockedUntil: null,
      lastLoginAt: now,
      createdAt: now,
      updatedAt: now,
    },
  };
}

function agentMachineIdentity(
  auth: LocalAuthService,
  userId: string,
  integrationCredentialId: string | null = null,
): Extract<RequestIdentity, { kind: "agent" }> {
  return {
    kind: "agent",
    user: auth.resolveMachineActor(userId),
    sessionToken: null,
    clientId: "threadmark-cli",
    clientLabel: "Threadmark CLI",
    integrationCredentialId,
  };
}

function isHeadlessIntegrationRoute(method: string, pathname: string): boolean {
  const routes: Array<{ method: string; path: RegExp }> = [
    { method: "GET", path: /^\/api\/ticket-assignees$/ },
    { method: "GET", path: /^\/api\/clients$/ },
    { method: "GET", path: /^\/api\/channels$/ },
    { method: "POST", path: /^\/api\/channels$/ },
    { method: "PATCH", path: /^\/api\/channels\/[^/]+$/ },
    { method: "POST", path: /^\/api\/channels\/[^/]+\/preview$/ },
    { method: "PATCH", path: /^\/api\/channels\/[^/]+\/status$/ },
    { method: "GET", path: /^\/api\/categories$/ },
    { method: "POST", path: /^\/api\/categories$/ },
    { method: "DELETE", path: /^\/api\/categories\/[^/]+$/ },
    { method: "GET", path: /^\/api\/conversations$/ },
    { method: "GET", path: /^\/api\/conversations\/[^/]+\/(?:messages|tickets|triage-blocks)$/ },
    { method: "POST", path: /^\/api\/conversations\/[^/]+\/triage\/(?:analyze|tickets|attach|ignore|context|restore)$/ },
    { method: "GET", path: /^\/api\/dashboard$/ },
    { method: "GET", path: /^\/api\/tickets$/ },
    { method: "POST", path: /^\/api\/tickets$/ },
    { method: "GET", path: /^\/api\/tickets\/by-number\/[^/]+$/ },
    { method: "GET", path: /^\/api\/tickets\/[^/]+$/ },
    { method: "PATCH", path: /^\/api\/tickets\/[^/]+$/ },
    { method: "PATCH", path: /^\/api\/tickets\/[^/]+\/(?:assignee|status)$/ },
    { method: "POST", path: /^\/api\/tickets\/[^/]+\/(?:categories|notes|external-messages)$/ },
    { method: "DELETE", path: /^\/api\/tickets\/[^/]+\/categories\/[^/]+$/ },
    { method: "DELETE", path: /^\/api\/tickets\/[^/]+\/notes\/[^/]+$/ },
    { method: "PUT", path: /^\/api\/tickets\/[^/]+\/product-forwarding$/ },
    { method: "GET", path: /^\/api\/agent\/triage\/jobs$/ },
    { method: "POST", path: /^\/api\/agent\/triage\/jobs\/claim$/ },
    { method: "POST", path: /^\/api\/agent\/triage\/jobs\/[^/]+\/(?:heartbeat|complete)$/ },
    { method: "GET", path: /^\/api\/integration-credentials\/current$/ },
    { method: "DELETE", path: /^\/api\/integration-credentials\/current$/ },
  ];
  return routes.some((route) => route.method === method && route.path.test(pathname));
}

function testMachineIdentity(): Extract<RequestIdentity, { kind: "test" }> {
  return {
    ...localMachineIdentity(),
    kind: "test",
  };
}

function setSessionCookie(
  context: Context<ApiEnvironment>,
  token: string,
  expiresAt: string,
  webOrigin: string,
): void {
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1_000));
  setCookie(context, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Strict",
    secure: new URL(webOrigin).protocol === "https:",
    path: "/",
    maxAge,
  });
}

function hasOperationalData(database: SupportDatabase): boolean {
  const row = database
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM messages) +
         (SELECT COUNT(*) FROM clients) +
         (SELECT COUNT(*) FROM tickets) AS count`,
    )
    .get() as { count: number };
  return row.count > 0;
}

function readWorkspaceSettings(
  database: SupportDatabase,
  fallbackName: string,
): {
  organizationName: string;
  workspaceName: string;
  timezone: string;
  workSchedule: { days: Array<{ dayOfWeek: number; periods: Array<{ startTime: string; endTime: string }> }> };
} {
  const row = database
    .prepare(
      `SELECT organization_name, workspace_name, timezone, work_schedule_json
       FROM local_app_settings WHERE singleton = 1`,
    )
    .get() as
    | {
        organization_name: string;
        workspace_name: string;
        timezone: string;
        work_schedule_json: string;
      }
    | undefined;
  return {
    organizationName: row?.organization_name ?? fallbackName,
    workspaceName: row?.workspace_name ?? fallbackName,
    timezone: row?.timezone ?? "UTC",
    workSchedule: parseWorkSchedule(row?.work_schedule_json),
  };
}

function parseWorkSchedule(value: string | undefined): {
  days: Array<{ dayOfWeek: number; periods: Array<{ startTime: string; endTime: string }> }>;
} {
  const fallback = {
    days: [1, 2, 3, 4, 5].map((dayOfWeek) => ({
      dayOfWeek,
      periods: [{ startTime: "09:00", endTime: "18:00" }],
    })),
  };
  if (!value) return fallback;
  try {
    const schedule = JSON.parse(value) as Record<string, unknown>;
    if (Array.isArray(schedule.days)) {
      const parsed = workScheduleSchema.safeParse({ days: schedule.days });
      if (parsed.success) {
        return {
          days: [...parsed.data.days]
            .sort((a, b) => a.dayOfWeek - b.dayOfWeek)
            .map((day) => ({ ...day, periods: [...day.periods].sort((a, b) => a.startTime.localeCompare(b.startTime)) })),
        };
      }
    } else if (
      Array.isArray(schedule.daysOfWeek) &&
      typeof schedule.startTime === "string" &&
      /^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.startTime) &&
      typeof schedule.endTime === "string" &&
      /^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.endTime) &&
      schedule.startTime < schedule.endTime
    ) {
      const days = schedule.daysOfWeek.filter(
        (day): day is number => typeof day === "number" && Number.isInteger(day) && day >= 1 && day <= 7,
      );
      const legacySchedule = workScheduleSchema.safeParse({
        days: [...new Set(days)].map((dayOfWeek) => ({
          dayOfWeek,
          periods: [{ startTime: schedule.startTime as string, endTime: schedule.endTime as string }],
        })),
      });
      if (legacySchedule.success) {
        return { days: legacySchedule.data.days };
      }
    }
  } catch {
    return fallback;
  }
  return fallback;
}

function sessionResponse(
  database: SupportDatabase,
  issued: { user: AuthUserDto; expiresAt: string },
) {
  const settings = readWorkspaceSettings(database, "Meu workspace");
  return {
    user: issued.user,
    workspace: { name: settings.workspaceName, timezone: settings.timezone },
    expiresAt: issued.expiresAt,
  };
}

function staffSettingsResponse(
  store: SupportStore,
  identities: string[],
  restartRequired: boolean,
) {
  const participants = store.database
    .prepare(
      `SELECT participant.id, participant.display_name, participant.phone_e164,
              participant.external_jid, COALESCE(staff.active, 0) AS active
       FROM participants participant
       LEFT JOIN staff_members staff ON staff.participant_id = participant.id
       WHERE participant.phone_e164 IS NOT NULL OR staff.active = 1
       ORDER BY staff.active DESC, participant.display_name COLLATE NOCASE, participant.id
       LIMIT 2000`,
    )
    .all() as Array<{
    id: string;
    display_name: string;
    phone_e164: string | null;
    external_jid: string;
    active: number;
  }>;
  return {
    identities,
    participants: participants.map((participant) => ({
      id: participant.id,
      displayName: participant.display_name,
      phoneE164: participant.phone_e164,
      externalJid: participant.external_jid,
      active: Boolean(participant.active),
    })),
    restartRequired,
  };
}

export function createApiApp(
  store: SupportStore,
  runtimeState?: RuntimeStateReader,
  qrReader?: EphemeralQrReader,
  services: ApiServices = {},
): Hono<ApiEnvironment> {
  return createApiAppInternal(store, runtimeState, qrReader, services, false);
}

/**
 * Isolated in-memory API surface for unit tests that exercise domain routes.
 * Production entrypoints must use createApiApp/startApiServer, which fail
 * closed whenever the local authentication service is unavailable.
 */
export function createTestApiApp(
  store: SupportStore,
  runtimeState?: RuntimeStateReader,
  qrReader?: EphemeralQrReader,
  services: Omit<ApiServices, "auth"> = {},
): Hono<ApiEnvironment> {
  return createApiAppInternal(store, runtimeState, qrReader, services, true);
}

function createApiAppInternal(
  store: SupportStore,
  runtimeState: RuntimeStateReader | undefined,
  qrReader: EphemeralQrReader | undefined,
  services: ApiServices,
  allowUnauthenticatedTestMode: boolean,
): Hono<ApiEnvironment> {
  const app = new Hono<ApiEnvironment>();
  const config = loadConfig();
  const directory = new DirectoryStore(store.database);
  const integrationCredentials = new IntegrationCredentialService(store.database);
  const channels = services.channels ?? new ChannelService(store, new LocalSecretVault(pathForSecrets(config.dataDir)));

  app.use(
    "/api/*",
    cors({
      origin: config.publicOrigin,
      allowMethods: ["GET", "PATCH", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: [
        "Content-Type",
        "Authorization",
        "X-Threadmark-Actor-Id",
        "X-Threadmark-Agent-Client",
      ],
      exposeHeaders: ["Content-Disposition"],
      credentials: true,
    }),
  );

  app.use("/api/*", async (context, next) => {
    context.set("identity", null);
    if (context.req.method === "OPTIONS") return next();
    // A channel credential only authorizes its exact ingestion route, never management/session routes.
    if (context.req.method === "POST" && /^\/api\/channels\/[^/]+\/events$/.test(new URL(context.req.url).pathname)) return next();

    const origin = context.req.header("Origin");
    if (
      origin &&
      !["GET", "HEAD", "OPTIONS"].includes(context.req.method) &&
      origin !== config.publicOrigin
    ) {
      return context.json(apiError("forbidden", "Origem não autorizada"), 403);
    }

    const auth = services.auth;
    if (!auth) {
      if (allowUnauthenticatedTestMode) {
        context.set("identity", testMachineIdentity());
        return next();
      }
      throw new DomainError(
        "Autenticação local indisponível",
        "service_unavailable",
        503,
      );
    }
    const pathname = new URL(context.req.url).pathname;
    if (isPublicApiPath(pathname)) return next();

    const authorization = context.req.header("Authorization");
    if (authorization?.startsWith("Bearer ") && services.localAccessToken) {
      const token = authorization.slice("Bearer ".length).trim();
      if (await services.localAccessToken.verify(token)) {
        const delegatedActorId = context.req.header("X-Threadmark-Actor-Id")?.trim();
        context.set(
          "identity",
          delegatedActorId
            ? agentMachineIdentity(
                auth,
                delegatedActorId,
              )
            : localMachineIdentity(),
        );
        if (isMutation(context.req.method)) requireRole(context, ["owner", "admin", "operator"]);
        return next();
      }
    }

    if (authorization?.startsWith("Bearer ")) {
      const token = authorization.slice("Bearer ".length).trim();
      let credential;
      try {
        credential = integrationCredentials.authenticate(token);
      } catch (error) {
        if (!(error instanceof AuthError) || error.code !== "invalid_credentials") {
          throw error;
        }
        throw new AuthError("authentication_required", "Credencial de integração inválida.");
      }
      if (!isHeadlessIntegrationRoute(context.req.method, pathname)) {
        throw new AuthError(
          "forbidden",
          "A credencial de integração não permite esta operação.",
        );
      }
      const delegatedActorId = context.req.header("X-Threadmark-Actor-Id")?.trim();
      if (delegatedActorId && delegatedActorId !== credential.userId) {
        throw new AuthError(
          "forbidden",
          "A credencial de integração não pode atuar como outro usuário.",
        );
      }
      context.set(
        "identity",
        agentMachineIdentity(
          auth,
          credential.userId,
          credential.id,
        ),
      );
      if (isMutation(context.req.method)) {
        requireRole(context, ["owner", "admin", "operator"]);
      }
      return next();
    }

    const token = getCookie(context, SESSION_COOKIE) ?? "";
    const session = auth.authenticate(token);
    context.set("identity", {
      kind: "user",
      sessionToken: token,
      user: session.user,
    });
    if (isMutation(context.req.method)) {
      requireRole(context, ["owner", "admin", "operator"]);
    }
    return next();
  });

  app.get("/health", async (context) => {
    const state = await runtimeState?.read().catch(() => null);
    return context.json({
      ok: true,
      service: "threadmark-api",
      pid: process.pid,
      startedAt: state?.startedAt ?? null,
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/api/runtime/identity", (context) => {
    requireLocalMachineIdentity(context);
    return context.json({
      ok: true as const,
      service: "threadmark-api" as const,
      pid: process.pid,
      startedAt: null,
    });
  });

  app.post("/api/runtime/shutdown", (context) => {
    requireLocalMachineIdentity(context);
    const requestShutdown = services.requestShutdown;
    if (!requestShutdown) {
      throw new DomainError(
        "Encerramento controlado indisponível neste processo.",
        "service_unavailable",
        503,
      );
    }
    const timer = setTimeout(() => {
      void Promise.resolve(requestShutdown("API local autenticada")).catch((error) => {
        console.error("Falha ao solicitar encerramento controlado", error);
      });
    }, 25);
    timer.unref();
    return context.json(
      {
        accepted: true as const,
        service: "threadmark-api" as const,
        pid: process.pid,
      },
      202,
    );
  });

  app.get("/api/setup/status", (context) => {
    const status = requireAuthService(services).getSetupStatus();
    const workspace = {
      name: status.workspaceName ?? config.workspaceName,
      timezone: status.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
    };
    const legacyInstallation = hasOperationalData(store.database);
    return context.json({
      completed: !status.required,
      required: status.required,
      legacyInstallation,
      bootstrapTokenRequired: status.required,
      organizationName: status.organizationName,
      workspaceName: status.workspaceName,
      timezone: status.timezone,
      completedAt: status.completedAt,
      workspace,
    });
  });

  app.post("/api/setup/complete", async (context) => {
    const input = setupInputSchema.parse(await context.req.json());
    const challenges = requireSetupChallenges(services);
    challenges.assertValid(input.bootstrapToken);
    const issued = await requireAuthService(services).bootstrapSetup({
      organizationName: input.organizationName ?? input.workspaceName,
      workspaceName: input.workspaceName,
      timezone: input.timezone,
      username: input.username ?? input.login ?? "",
      displayName: input.displayName,
      password: input.password,
    });
    challenges.consume();
    setSessionCookie(context, issued.token, issued.expiresAt, config.publicOrigin);
    return context.json(sessionResponse(store.database, issued), 201);
  });

  app.post("/api/auth/login", async (context) => {
    const input = loginInputSchema.parse(await context.req.json());
    const issued = await requireAuthService(services).login({
      username: input.username ?? input.login ?? "",
      password: input.password,
    });
    setSessionCookie(context, issued.token, issued.expiresAt, config.publicOrigin);
    return context.json(sessionResponse(store.database, issued));
  });

  app.get("/api/auth/me", (context) => {
    const identity = requireUserIdentity(context);
    const settings = readWorkspaceSettings(store.database, config.workspaceName);
    return context.json({
      user: identity.user,
      workspace: { name: settings.workspaceName, timezone: settings.timezone },
      expiresAt: requireAuthService(services).authenticate(identity.sessionToken).expiresAt,
    });
  });

  app.post("/api/auth/logout", (context) => {
    const identity = requireUserIdentity(context);
    requireAuthService(services).logout(identity.sessionToken);
    deleteCookie(context, SESSION_COOKIE, { path: "/" });
    return context.json({ ok: true as const });
  });

  app.post("/api/auth/change-password", async (context) => {
    const identity = requireUserIdentity(context);
    const input = changePasswordInputSchema.parse(await context.req.json());
    const issued = await requireAuthService(services).changeOwnPassword(
      identity.sessionToken,
      input.currentPassword,
      input.password,
    );
    setSessionCookie(context, issued.token, issued.expiresAt, config.publicOrigin);
    return context.json(sessionResponse(store.database, issued));
  });

  app.get("/api/integration-credentials", (context) => {
    const identity = requireUserIdentity(context);
    return context.json({ items: integrationCredentials.list(identity.user.id) });
  });

  app.post("/api/integration-credentials", async (context) => {
    const identity = requireUserIdentity(context);
    const input = integrationCredentialInputSchema.parse(await context.req.json());
    context.header("Cache-Control", "no-store");
    return context.json(
      integrationCredentials.create(identity.user.id, input),
      201,
    );
  });

  app.get("/api/integration-credentials/current", (context) => {
    const identity = requireIntegrationIdentity(context);
    const credential = integrationCredentials
      .list(identity.user.id)
      .find((item) => item.id === identity.integrationCredentialId);
    if (!credential) {
      throw new AuthError("authentication_required", "Credencial de integração inválida.");
    }
    return context.json({
      credential,
      user: {
        id: identity.user.id,
        displayName: identity.user.displayName,
        role: identity.user.role,
        active: identity.user.active,
      },
      clientId: identity.clientId,
      headlessSchemaVersion: "threadmark.headless.v1",
    });
  });

  app.delete("/api/integration-credentials/current", (context) => {
    const identity = requireIntegrationIdentity(context);
    const credential = integrationCredentials.revoke(
      identity.user.id,
      identity.integrationCredentialId!,
    );
    return context.json({
      credential,
      user: {
        id: identity.user.id,
        displayName: identity.user.displayName,
        role: identity.user.role,
        active: identity.user.active,
      },
      clientId: identity.clientId,
      headlessSchemaVersion: "threadmark.headless.v1",
    });
  });

  app.delete("/api/integration-credentials/:id", (context) => {
    const identity = requireUserIdentity(context);
    return context.json({
      credential: integrationCredentials.revoke(
        identity.user.id,
        context.req.param("id"),
      ),
    });
  });

  app.get("/api/users", (context) => {
    const identity = requireUserIdentity(context);
    return context.json({
      items: requireAuthService(services).listUsers(identity.sessionToken),
    });
  });

  app.post("/api/users", async (context) => {
    const identity = requireUserIdentity(context);
    const input = createUserInputSchema.parse(await context.req.json());
    return context.json(
      await requireAuthService(services).createUser(identity.sessionToken, input),
      201,
    );
  });

  app.patch("/api/users/:id", async (context) => {
    const identity = requireUserIdentity(context);
    const input = updateUserInputSchema.parse(await context.req.json());
    return context.json(
      requireAuthService(services).updateUser(
        identity.sessionToken,
        context.req.param("id"),
        input,
      ),
    );
  });

  app.delete("/api/users/:id", (context) => {
    const identity = requireUserIdentity(context);
    requireAuthService(services).deleteUser(identity.sessionToken, context.req.param("id"));
    return context.json({ ok: true as const });
  });

  app.get("/api/runtime", async (context) => {
    const fallback: RuntimeStatusDto = {
      ...store.getRuntimeStatus(),
      whatsappEnabled: config.whatsappEnabled,
    };
    const runtime = runtimeState
      ? runtimeFromFile(await runtimeState.read(), fallback)
      : fallback;
    return context.json(runtime);
  });

  app.get("/api/runtime/web-build", async (context) => {
    context.header("Cache-Control", "no-store, max-age=0");
    return context.json({
      revision: await readWebBuildReloadRequest(
        webBuildReloadPath(config.dataDir),
      ),
    });
  });

  app.get("/api/runtime/qr", async (context) => {
    requireRole(context, ["owner", "admin"]);
    context.header("Cache-Control", "no-store, max-age=0");
    const qr = qrReader?.getEphemeralQr() ?? null;
    return context.json({
      available: Boolean(qr),
      qr,
      dataUrl: qr
        ? await QRCode.toDataURL(qr, { margin: 1, width: 320, errorCorrectionLevel: "M" })
        : null,
    });
  });

  app.post("/api/runtime/qr/renew", async (context) => {
    requireRole(context, ["owner", "admin"]);
    const controller = services.whatsappQrController;
    if (!controller) {
      throw new DomainError(
        "A captura do WhatsApp não está habilitada neste processo.",
        "whatsapp_unavailable",
        503,
      );
    }
    const current = await runtimeState?.read().catch(() => null);
    if (current?.whatsappConnected) {
      throw new DomainError(
        "O WhatsApp ainda está conectado. Desconecte a conta antes de gerar um novo QR code.",
        "whatsapp_already_connected",
        409,
      );
    }
    try {
      await controller.renewQr();
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        error instanceof Error
          ? error.message
          : "Não foi possível iniciar uma nova autenticação do WhatsApp.",
        "whatsapp_qr_renewal_failed",
        503,
      );
    }
    return context.json({ accepted: true as const }, 202);
  });

  app.get("/api/settings/workspace", (context) => {
    return context.json(readWorkspaceSettings(store.database, config.workspaceName));
  });

  app.patch("/api/settings/workspace", async (context) => {
    requireRole(context, ["owner", "admin"]);
    const input = workspaceSettingsInputSchema.parse(await context.req.json());
    const current = readWorkspaceSettings(store.database, config.workspaceName);
    const next = {
      organizationName: input.organizationName ?? current.organizationName,
      workspaceName: input.workspaceName ?? current.workspaceName,
      timezone: input.timezone ?? current.timezone,
      workSchedule: input.workSchedule ?? current.workSchedule,
    };
    store.database
      .prepare(
        `UPDATE local_app_settings
         SET organization_name = ?, workspace_name = ?, timezone = ?,
             work_schedule_json = ?, updated_at = ?
         WHERE singleton = 1`,
      )
      .run(
        next.organizationName,
        next.workspaceName,
        next.timezone,
        JSON.stringify(next.workSchedule),
        new Date().toISOString(),
      );
    return context.json(next);
  });

  app.get("/api/settings/staff", async (context) => {
    requireRole(context, ["owner", "admin"]);
    const settings = await requireLocalSettings(services).read();
    const identities = settings.staffIdentitiesConfigured
      ? settings.staffIdentities
      : mergeConfiguredIdentities(
          config.staffIdentities,
          settings.staffIdentities,
        );
    return context.json(
      staffSettingsResponse(
        store,
        identities,
        settings.staffRestartRequired,
      ),
    );
  });

  app.put("/api/settings/staff", async (context) => {
    requireRole(context, ["owner", "admin"]);
    const input = staffSettingsInputSchema.parse(await context.req.json());
    const settingsFile = requireLocalSettings(services);
    const current = await settingsFile.read();
    await settingsFile.write({
      ...current,
      staffIdentities: input.identities,
      staffIdentitiesConfigured: true,
      staffRestartRequired: true,
    });
    const resolved = resolveConfiguredStaffIdentities(store, input.identities);
    store.reconcileStaffMembers(resolved.participantIds);
    return context.json(staffSettingsResponse(store, input.identities, true));
  });

  app.get("/api/ai/audio-transcription", async (context) => {
    requireRole(context, ["owner", "admin"]);
    return context.json(await requireAudioTranscription(services).getSettings());
  });

  app.put("/api/ai/audio-transcription", async (context) => {
    requireRole(context, ["owner", "admin"]);
    const input = audioTranscriptionSettingsInputSchema.parse(
      await context.req.json(),
    );
    try {
      requireAudioTranscription(services).updateSettings({
        ...input,
        actor: actorFor(context),
      });
    } catch (error) {
      throw new DomainError(
        error instanceof Error ? error.message : String(error),
        "invalid_input",
        400,
      );
    }
    return context.json(await requireAudioTranscription(services).getSettings());
  });

  app.post("/api/ai/audio-transcription/models/:id/install", async (context) => {
    requireRole(context, ["owner", "admin"]);
    try {
      requireAudioTranscription(services).startModelInstall(
        decodeURIComponent(context.req.param("id")),
      );
    } catch (error) {
      throw new DomainError(
        error instanceof Error ? error.message : String(error),
        "invalid_input",
        400,
      );
    }
    return context.json({ accepted: true as const }, 202);
  });

  app.delete("/api/ai/audio-transcription/models/:id", async (context) => {
    requireRole(context, ["owner", "admin"]);
    try {
      await requireAudioTranscription(services).removeModel(
        decodeURIComponent(context.req.param("id")),
      );
    } catch (error) {
      throw new DomainError(
        error instanceof Error ? error.message : String(error),
        "conflict",
        409,
      );
    }
    return context.json({ ok: true as const });
  });

  app.post("/api/ai/audio-transcription/history", async (context) => {
    requireRole(context, ["owner", "admin"]);
    const input = audioTranscriptionHistoryInputSchema.parse(
      await context.req.json().catch(() => ({})),
    );
    let queued: number;
    try {
      queued = requireAudioTranscription(services).queueHistorical(
        input.limit ?? 100,
      );
    } catch (error) {
      throw new DomainError(
        error instanceof Error ? error.message : String(error),
        "conflict",
        409,
      );
    }
    return context.json({ queued });
  });

  app.post("/api/attachments/:id/transcription/retry", async (context) => {
    let queued: boolean;
    try {
      queued = requireAudioTranscription(services).retryAttachment(
        context.req.param("id"),
      );
    } catch (error) {
      throw new DomainError(
        error instanceof Error ? error.message : String(error),
        "conflict",
        409,
      );
    }
    if (!queued) {
      throw new DomainError(
        "Esta transcrição não está disponível para nova tentativa",
        "not_found",
        404,
      );
    }
    return context.json({ queued: true as const });
  });

  app.post("/api/attachments/:id/transcription", async (context) => {
    let queued: boolean;
    try {
      queued = requireAudioTranscription(services).queueAttachment(
        context.req.param("id"),
      );
    } catch (error) {
      throw new DomainError(
        error instanceof Error ? error.message : String(error),
        "conflict",
        409,
      );
    }
    if (!queued) {
      throw new DomainError(
        "Este áudio não está disponível para transcrição",
        "not_found",
        404,
      );
    }
    return context.json({ queued: true as const });
  });

  app.post("/api/settings/backup", async (context) => {
    requireRole(context, ["owner", "admin"]);
    const input = backupInputSchema.parse(await context.req.json());
    const backup = await createLocalBackup({
      database: store.database,
      backupsDirectory: config.backupsDir,
      settingsPath: config.localSettingsPath,
      attachmentsDirectory: config.attachmentsDir,
      mode: input.includeAttachments ? "full" : "quick",
      kind: "manual",
      label: "ui",
      retention: DEFAULT_LOCAL_BACKUP_RETENTION,
    });
    return context.json({
      backup: {
        id: backup.id,
        createdAt: backup.createdAt,
        attachmentsIncluded: backup.attachmentsIncluded,
        directory: backup.directory,
        databasePath: backup.databasePath,
      },
    });
  });

  app.get("/api/channels", (context) => context.json({ items: channels.list() }));
  app.post("/api/channels", async (context) => {
    requireRole(context, ["owner", "admin"]);
    return context.json(await channels.create(await context.req.json(), actorFor(context)), 201);
  });
  app.patch("/api/channels/:id", async (context) => {
    requireRole(context, ["owner", "admin"]);
    return context.json(await channels.update(context.req.param("id"), await context.req.json()));
  });
  app.post("/api/channels/:id/preview", async (context) => {
    requireRole(context, ["owner", "admin"]);
    return context.json({ event: channels.preview(context.req.param("id"), JSON.parse(await readChannelBody(context.req.raw))) });
  });
  app.patch("/api/channels/:id/status", async (context) => {
    requireRole(context, ["owner", "admin"]);
    const input = z.object({ status: z.enum(["draft", "active", "paused"]) }).strict().parse(await context.req.json());
    return context.json(channels.setStatus(context.req.param("id"), input.status));
  });
  app.post("/api/channels/:id/rotate-token", (context) => {
    requireRole(context, ["owner", "admin"]);
    return context.json({ token: channels.rotateToken(context.req.param("id")) });
  });
  app.get("/api/channels/:id/events", (context) => {
    requireRole(context, ["owner", "admin"]);
    return context.json({ items: channels.events(context.req.param("id")) });
  });
  app.post("/api/channels/:id/events/:eventId/retry", (context) => {
    requireRole(context, ["owner", "admin"]);
    channels.retry(context.req.param("id"), context.req.param("eventId"));
    return context.json({ accepted: true }, 202);
  });
  app.post("/api/channels/:id/events", async (context) => {
    const id = context.req.param("id");
    const raw = await readChannelBody(context.req.raw);
    await channels.authenticate(id, context.req.raw.headers, raw);
    if (!(context.req.header("Content-Type") ?? "").toLowerCase().startsWith("application/json")) {
      throw new DomainError("Utilize Content-Type application/json.", "channel_content_type", 415);
    }
    return context.json(channels.receive(id, JSON.parse(raw)), 202);
  });

  app.get("/api/settings/storage", async (context) => {
    requireRole(context, ["owner", "admin"]);
    try {
      return context.json(await requireStorageUsage(services).read());
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (error instanceof LocalStorageUsageError) {
        throw new DomainError(error.message, "storage_unavailable", 503);
      }
      throw new DomainError(
        "Não foi possível medir o armazenamento local.",
        "storage_unavailable",
        503,
      );
    }
  });

  app.get("/api/automations", (context) =>
    context.json(requireAutomations(services).listAutomations()),
  );

  app.get("/api/notifications", (context) => {
    const userId = notificationUserId(context);
    const url = new URL(context.req.url);
    const query = notificationListQuerySchema.parse({
      unread: url.searchParams.get("unread") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
      offset: url.searchParams.get("offset") ?? undefined,
    });
    return context.json(requireNotifications(services).listForUser(userId, {
      unreadOnly: query.unread === "true",
      limit: query.limit,
      offset: query.offset,
    }));
  });

  app.get("/api/notifications/unread-count", (context) => {
    const userId = notificationUserId(context);
    return context.json({ unread: requireNotifications(services).unreadCount(userId) });
  });

  app.patch("/api/notifications/:id", async (context) => {
    const userId = notificationUserId(context);
    const input = notificationReadSchema.parse(await context.req.json());
    const updated = requireNotifications(services).markRead(
      userId,
      context.req.param("id"),
      input.read,
    );
    if (!updated) throw new DomainError("Notificação não encontrada", "not_found", 404);
    return context.json({
      updated: true,
      unread: requireNotifications(services).unreadCount(userId),
    });
  });

  app.post("/api/notifications/read-all", (context) => {
    const userId = notificationUserId(context);
    return context.json({
      updated: requireNotifications(services).markAllRead(userId),
      unread: 0,
    });
  });

  app.post("/api/automations", async (context) => {
    requireRole(context, ["owner", "admin"]);
    return context.json(
      requireAutomations(services).createAutomation(
        await context.req.json(),
        actorFor(context),
      ),
      201,
    );
  });

  app.get("/api/automations/:id", (context) =>
    context.json(requireAutomations(services).getAutomation(context.req.param("id"))),
  );

  app.put("/api/automations/:id", async (context) => {
    requireRole(context, ["owner", "admin"]);
    return context.json(
      requireAutomations(services).updateAutomation(
        context.req.param("id"),
        await context.req.json(),
        actorFor(context),
      ),
    );
  });

  app.patch("/api/automations/:id/layout", async (context) => {
    requireRole(context, ["owner", "admin"]);
    return context.json(
      requireAutomations(services).updateAutomationLayout(
        context.req.param("id"),
        await context.req.json(),
        actorFor(context),
      ),
    );
  });

  app.patch("/api/automations/:id/metadata", async (context) => {
    requireRole(context, ["owner", "admin"]);
    return context.json(
      requireAutomations(services).updateAutomationMetadata(
        context.req.param("id"),
        await context.req.json(),
        actorFor(context),
      ),
    );
  });

  app.delete("/api/automations/:id", (context) => {
    requireRole(context, ["owner", "admin"]);
    return context.json(
      requireAutomations(services).deleteAutomation(
        context.req.param("id"),
        actorFor(context),
      ),
    );
  });

  app.post("/api/automations/:id/activate", (context) => {
    requireRole(context, ["owner", "admin"]);
    return context.json(
      requireAutomations(services).activateAutomation(
        context.req.param("id"),
        actorFor(context),
      ),
    );
  });

  app.post("/api/automations/:id/pause", (context) => {
    requireRole(context, ["owner", "admin"]);
    return context.json(
      requireAutomations(services).pauseAutomation(
        context.req.param("id"),
        actorFor(context),
      ),
    );
  });

  app.post("/api/automations/:id/test", (context) => {
    requireRole(context, ["owner", "admin"]);
    return context.json(
      requireAutomations(services).testAutomation(
        context.req.param("id"),
      ),
    );
  });

  app.post("/api/automation-runs/:id/decision", async (context) => {
    requireRole(context, ["owner", "admin", "operator"]);
    return context.json(
      requireAutomations(services).decideExecution(
        context.req.param("id"),
        await context.req.json(),
        actorFor(context),
      ),
    );
  });

  app.post("/api/automation-runs/:id/pause", (context) => {
    requireRole(context, ["owner", "admin", "operator"]);
    return context.json(
      requireAutomations(services).pauseExecution(context.req.param("id")),
    );
  });

  app.post("/api/automation-runs/:id/resume", (context) => {
    requireRole(context, ["owner", "admin", "operator"]);
    return context.json(
      requireAutomations(services).resumeExecution(context.req.param("id")),
    );
  });

  app.post("/api/automation-runs/:id/cancel", (context) => {
    requireRole(context, ["owner", "admin", "operator"]);
    return context.json(
      requireAutomations(services).cancelExecution(context.req.param("id")),
    );
  });

  app.get("/api/automation-apps", (context) => {
    requireRole(context, ["owner", "admin"]);
    return context.json(requireAutomations(services).listConnectedApps());
  });

  app.post("/api/automation-apps", async (context) => {
    requireRole(context, ["owner", "admin"]);
    return context.json(
      await requireAutomations(services).createConnectedApp(
        await context.req.json(),
        actorFor(context),
      ),
      201,
    );
  });

  app.patch("/api/automation-apps/:id", async (context) => {
    requireRole(context, ["owner", "admin"]);
    return context.json(
      await requireAutomations(services).updateConnectedApp(
        context.req.param("id"),
        await context.req.json(),
        actorFor(context),
      ),
    );
  });

  app.delete("/api/automation-apps/:id", async (context) => {
    requireRole(context, ["owner", "admin"]);
    return context.json(
      await requireAutomations(services).deleteConnectedApp(context.req.param("id")),
    );
  });

  app.post("/api/automation-apps/:id/test", async (context) => {
    requireRole(context, ["owner", "admin"]);
    return context.json(
      await requireAutomations(services).testConnectedApp(context.req.param("id")),
    );
  });

  app.get("/api/agent/triage/jobs", (context) => {
    return context.json(store.getTriageAiQueueStatus());
  });

  app.post("/api/agent/triage/jobs/claim", async (context) => {
    requireAgentIdentity(context);
    const raw = await context.req.text();
    const input = externalTriageLeaseInputSchema.parse(raw ? JSON.parse(raw) : {});
    const job = store.claimNextTriageAiJob(input.leaseSeconds * 1_000);
    return context.json({
      job: job
        ? {
            ...job,
            input: store.getTriageAiJobInput(job.id),
          }
        : null,
    });
  });

  app.post("/api/agent/triage/jobs/:id/heartbeat", async (context) => {
    requireAgentIdentity(context);
    const raw = await context.req.text();
    const input = externalTriageLeaseInputSchema.parse(raw ? JSON.parse(raw) : {});
    const renewed = store.renewTriageAiJobLease(
      context.req.param("id"),
      input.leaseSeconds * 1_000,
    );
    if (!renewed) {
      throw new DomainError(
        "Job de triagem em execução não encontrado",
        "not_found",
        404,
      );
    }
    return context.json({ renewed: true as const });
  });

  app.post("/api/agent/triage/jobs/:id/complete", async (context) => {
    requireAgentIdentity(context);
    const input = externalTriageCompleteInputSchema.parse(await context.req.json());
    const appliedBlocks = store.completeTriageAiJob(
      context.req.param("id"),
      input.analysis,
      {
        actor: actorFor(context),
        allowAutoAttach: false,
        ...(input.model ? { model: input.model } : {}),
      },
    );
    return context.json({ appliedBlocks });
  });

  app.get("/api/dashboard", (context) => {
    const query = dashboardQueryFromUrl(new URL(context.req.url));
    return context.json(store.getDashboard(query.period, query.assigneeId));
  });

  app.get("/api/dashboard/export", (context) => {
    const query = dashboardQueryFromUrl(new URL(context.req.url));
    const rows = store.getDashboardExportRows(query.period, query.assigneeId);
    const suffix = query.period
      ? `${query.period.from}_${query.period.to}`
      : "all";
    return new Response(dashboardExportCsv(rows), {
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Disposition": `attachment; filename="threadmark-dashboard-${suffix}.csv"`,
        "Content-Type": "text/csv; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  const triageSettingsPayload = () => store.getTriageAiSettings();

  app.get("/api/triage/settings", (context) =>
    context.json(triageSettingsPayload()),
  );

  app.put("/api/triage/settings", async (context) => {
    requireRole(context, ["owner", "admin"]);
    const input = triageAiSettingsInputSchema.parse(await context.req.json());
    store.updateTriageAiSettings({
      ...input,
      actor: actorFor(context, input.actor),
    });
    return context.json(triageSettingsPayload());
  });

  app.get("/api/conversations", (context) => {
    const url = new URL(context.req.url);
    const limit = url.searchParams.get("limit");
    const attention = z
      .enum(["pending", "all"])
      .parse(url.searchParams.get("attention") || "all");
    const scopeValue = url.searchParams.get("scope");
    const scope = scopeValue
      ? z.enum(["group", "direct"]).parse(scopeValue)
      : undefined;
    return context.json(
      store.listConversations({
        limit: limit ? Number(limit) : undefined,
        cursor: url.searchParams.get("cursor") || undefined,
        attention,
        scope,
        connectionId: url.searchParams.get("connectionId") || undefined,
        query: url.searchParams.get("q") || undefined,
      }),
    );
  });

  app.post("/api/conversations/triage/context-all", async (context) => {
    const input = conversationClearPendingInputSchema.parse(
      await context.req.json(),
    );
    return context.json(
      store.contextualizePendingMessages({
        actor: actorFor(context, input.actor),
      }),
    );
  });

  app.post("/api/conversations/:id/triage/context-all", async (context) => {
    const input = conversationClearPendingInputSchema.parse(
      await context.req.json(),
    );
    return context.json(
      store.contextualizePendingMessages({
        actor: actorFor(context, input.actor),
        conversationId: context.req.param("id"),
      }),
    );
  });

  app.get("/api/conversations/:id/tickets", (context) => {
    const url = new URL(context.req.url);
    const limit = url.searchParams.get("limit");
    return context.json(
      store.listConversationTickets(context.req.param("id"), {
        limit: limit ? Number(limit) : undefined,
        cursor: url.searchParams.get("cursor") || undefined,
        statuses: parseTicketStatuses(url.searchParams.getAll("status")),
        query: url.searchParams.get("q") || undefined,
      }),
    );
  });

  app.get("/api/conversations/:id/messages", (context) => {
    const url = new URL(context.req.url);
    const limit = url.searchParams.get("limit");
    return context.json(
      store.getConversationMessages(context.req.param("id"), {
        limit: limit ? Number(limit) : undefined,
        before: url.searchParams.get("before") || undefined,
      }),
    );
  });

  app.get("/api/conversations/:id/triage-blocks", (context) => {
    const url = new URL(context.req.url);
    return context.json(
      store.listConversationTriageBlocks(
        context.req.param("id"),
        url.searchParams.get("includeResolved") === "true",
      ),
    );
  });

  app.put("/api/conversations/:id/suggestion-settings", async (context) => {
    const input = conversationSuggestionSettingsInputSchema.parse(
      await context.req.json(),
    );
    return context.json(
      store.setConversationSuggestionsMuted(context.req.param("id"), {
        ...input,
        actor: actorFor(context, input.actor),
      }),
    );
  });

  app.post("/api/conversations/:id/triage/analyze", (context) =>
    context.json(
      store.triggerConversationTriageAnalysis(context.req.param("id"), {
        promptVersion: TRIAGE_PROMPT_VERSION,
      }),
    ),
  );

  app.post("/api/conversations/:id/triage/tickets", async (context) => {
    const input = conversationCreateTicketInputSchema.parse(
      await context.req.json(),
    );
    return context.json(
      store.createTicketFromConversation(context.req.param("id"), {
        ...input,
        actor: actorFor(context, input.actor),
      }),
      201,
    );
  });

  app.post("/api/conversations/:id/triage/attach", async (context) => {
    const input = conversationAttachInputSchema.parse(await context.req.json());
    return context.json(
      store.attachConversationMessages(context.req.param("id"), {
        ...input,
        actor: actorFor(context, input.actor),
      }),
    );
  });

  app.post("/api/conversations/:id/triage/ignore", async (context) => {
    const input = conversationBatchInputSchema.parse(await context.req.json());
    return context.json(
      store.ignoreConversationMessages(context.req.param("id"), {
        ...input,
        actor: actorFor(context, input.actor),
      }),
    );
  });

  app.post("/api/conversations/:id/triage/context", async (context) => {
    const input = conversationBatchInputSchema.parse(await context.req.json());
    return context.json(
      store.contextualizeConversationMessages(context.req.param("id"), {
        ...input,
        actor: actorFor(context, input.actor),
      }),
    );
  });

  app.post("/api/conversations/:id/triage/restore", async (context) => {
    const input = conversationBatchInputSchema.parse(await context.req.json());
    return context.json(
      store.restoreConversationMessages(context.req.param("id"), {
        ...input,
        actor: actorFor(context, input.actor),
      }),
    );
  });

  app.get("/api/groups", (context) =>
    context.json(store.listOperationalGroups()),
  );

  app.get("/api/categories", (context) => {
    const filters = parseCategoryListFilters(new URL(context.req.url));
    const categories = store.listCategories(filters);
    return context.json({ items: categories, total: categories.length });
  });

  app.post("/api/categories", async (context) => {
    const input = categoryCreateInputSchema.parse(await context.req.json());
    return context.json(store.createCategory(input), 201);
  });

  app.put("/api/categories/:id", async (context) => {
    const input = categoryUpdateInputSchema.parse(await context.req.json());
    return context.json(
      store.updateCategory(context.req.param("id"), input),
    );
  });

  app.delete("/api/categories/:id", async (context) => {
    const input = categoryDeleteInputSchema.parse(await context.req.json());
    return context.json(
      store.deleteCategory(
        context.req.param("id"),
        input.replacementCategoryId,
        actorFor(context),
      ),
    );
  });

  app.get("/api/ticket-assignees", (context) =>
    context.json(store.listTicketAssignees()),
  );

  app.get("/api/tickets", (context) => {
    const url = new URL(context.req.url);
    const limit = url.searchParams.get("limit");
    const offset = url.searchParams.get("offset");
    const includeArchived = url.searchParams.get("includeArchived") === "true";
    const productForwardingKind = z
      .enum(PRODUCT_FORWARDING_KINDS)
      .optional()
      .parse(url.searchParams.get("productForwardingKind") || undefined);
    const statuses = parseTicketStatuses(url.searchParams.getAll("status"));
    const order = z
      .enum(["operational", "created_desc", "resolved_desc", "archived_desc"])
      .optional()
      .parse(url.searchParams.get("order") || undefined);
    return context.json(
      store.listTickets({
        statuses,
        clientId: url.searchParams.get("clientId") || undefined,
        connectionId: url.searchParams.get("connectionId") || undefined,
        query: url.searchParams.get("q") || undefined,
        includeArchived,
        productForwardingKind,
        order,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
      }),
    );
  });

  app.post("/api/tickets", async (context) => {
    const input = manualTicketCreateInputSchema.parse(await context.req.json());
    return context.json(
      store.createManualTicket({
        ...input,
        actor: actorFor(context, input.actor),
      }),
      201,
    );
  });

  app.post("/api/tickets/bulk-status", async (context) => {
    const input = ticketBulkStatusInputSchema.parse(await context.req.json());
    return context.json(
      store.updateTicketStatusesInBulk({
        ...input,
        actor: actorFor(context, input.actor),
      }),
    );
  });

  app.get("/api/tickets/by-number/:number", (context) => {
    const ticket = store.getTicketByNumber(Number(context.req.param("number")));
    return context.json({ id: ticket.id, number: ticket.number });
  });

  app.get("/api/tickets/:id", (context) =>
    context.json(store.getTicketDetail(context.req.param("id"))),
  );

  app.patch("/api/tickets/:id", async (context) => {
    const input = ticketMetadataInputSchema.parse(await context.req.json());
    return context.json(
      store.updateTicketMetadata(
        context.req.param("id"),
        input,
        actorFor(context),
      ),
    );
  });

  app.patch("/api/tickets/:id/assignee", async (context) => {
    const input = ticketAssigneeInputSchema.parse(await context.req.json());
    return context.json(
      store.updateTicketAssignee(
        context.req.param("id"),
        input.assigneeId,
        actorFor(context),
      ),
    );
  });

  app.post("/api/tickets/:id/categories", async (context) => {
    const input = categoryAttachInputSchema.parse(await context.req.json());
    return context.json(
      store.attachCategoryToTicket(
        context.req.param("id"),
        input.categoryId,
        actorFor(context, input.actor),
      ),
    );
  });

  app.delete("/api/tickets/:id/categories/:categoryId", (context) =>
    context.json(
      store.detachCategoryFromTicket(
        context.req.param("id"),
        context.req.param("categoryId"),
        actorFor(context),
      ),
    ),
  );

  app.delete("/api/tickets/:id/messages/:messageId", (context) =>
    context.json(
      store.detachMessageFromTicket(
        context.req.param("id"),
        context.req.param("messageId"),
        actorFor(context),
      ),
    ),
  );

  app.delete("/api/tickets/:id", async (context) => {
    requireRole(context, ["owner", "admin"]);
    const raw = await context.req.text();
    const input = ticketDeleteInputSchema.parse(raw ? JSON.parse(raw) : {});
    return context.json(
      store.deleteTicket(context.req.param("id"), {
        ...input,
        actor: actorFor(context, input.actor),
      }),
    );
  });

  app.patch("/api/tickets/:id/status", async (context) => {
    const input = statusInputSchema.parse(await context.req.json());
    return context.json(
      store.updateTicketStatus(context.req.param("id"), {
        ...input,
        actor: actorFor(context, input.actor),
        ...(input.resolution
          ? {
              resolution: {
                ...input.resolution,
                validatedBy: actorFor(
                  context,
                  input.resolution.validatedBy ?? input.actor,
                ),
              },
            }
          : {}),
      }),
    );
  });

  app.patch("/api/tickets/:id/context", async (context) => {
    const input = ticketContextInputSchema.parse(await context.req.json());
    return context.json(
      store.updateTicketContext(context.req.param("id"), {
        ...input,
        actor: actorFor(context, input.actor),
      }),
    );
  });

  app.post("/api/tickets/:id/notes", async (context) => {
    const input = ticketInternalNoteInputSchema.parse(await context.req.json());
    return context.json(
      store.addTicketInternalNote(
        context.req.param("id"),
        input,
        actorFor(context),
      ),
      201,
    );
  });

  app.post("/api/tickets/:id/external-messages", async (context) => {
    const input = externalTicketMessagesInputSchema.parse(await context.req.json());
    return context.json(
      store.importExternalSourceMessagesToTicket(context.req.param("id"), {
        ...input,
        actor: actorFor(context),
      }),
    );
  });

  app.patch("/api/tickets/:id/notes/:noteId", async (context) => {
    const input = ticketInternalNoteUpdateSchema.parse(
      await context.req.json(),
    );
    return context.json(
      store.updateTicketInternalNote(
        context.req.param("id"),
        context.req.param("noteId"),
        input,
        actorFor(context),
      ),
    );
  });

  app.delete("/api/tickets/:id/notes/:noteId", (context) =>
    context.json(
      store.deleteTicketInternalNote(
        context.req.param("id"),
        context.req.param("noteId"),
        actorFor(context),
      ),
    ),
  );

  app.put("/api/tickets/:id/product-forwarding", async (context) => {
    const input = ticketProductForwardingInputSchema.parse(
      await context.req.json(),
    );
    return context.json(
      store.upsertTicketProductForwarding(
        context.req.param("id"),
        input,
        actorFor(context),
      ),
    );
  });

  app.get("/api/directory", (context) =>
    context.json(directory.getSnapshot()),
  );

  app.get("/api/clients", (context) => context.json(store.listClients()));

  app.put("/api/clients/:id", async (context) => {
    const input = clientProfileInputSchema.parse(await context.req.json());
    return context.json(store.updateClientProfile(context.req.param("id"), input));
  });

  app.delete("/api/clients/:id", async (context) => {
    requireRole(context, ["owner", "admin"]);
    const raw = await context.req.text();
    const input = clientIgnoreInputSchema.parse(raw ? JSON.parse(raw) : {});
    return context.json(
      store.ignoreClient(context.req.param("id"), {
        ...input,
        actor: actorFor(context, input.actor),
      }),
    );
  });

  app.get("/api/attachments/:id", async (context) => {
    const attachment = store.database
      .prepare(
        `SELECT local_path, mime_type, file_name, available
         FROM attachments WHERE id = ?`,
      )
      .get(context.req.param("id")) as
      | {
          local_path: string;
          mime_type: string;
          file_name: string | null;
          available: number;
        }
      | undefined;
    if (!attachment || !attachment.available) {
      throw new DomainError("Anexo não encontrado", "not_found", 404);
    }

    let trustedRoot: string;
    let filePath: string;
    try {
      [trustedRoot, filePath] = await Promise.all([
        realpath(config.attachmentsDir),
        realpath(attachment.local_path),
      ]);
    } catch {
      throw new DomainError("Arquivo do anexo indisponível", "not_found", 404);
    }
    const pathWithinRoot = relative(trustedRoot, filePath);
    if (pathWithinRoot.startsWith("..") || isAbsolute(pathWithinRoot)) {
      throw new DomainError("Caminho do anexo inválido", "not_found", 404);
    }

    const bytes = await readFile(filePath);
    const mimeType = /^[\w.+-]+\/[\w.+-]+$/.test(attachment.mime_type)
      ? attachment.mime_type
      : "application/octet-stream";
    const fileName = attachment.file_name?.trim() || "anexo";
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        "Content-Security-Policy": "sandbox",
        "Content-Type": mimeType,
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  app.notFound((context) =>
    context.json(apiError("not_found", "Rota não encontrada"), 404),
  );

  app.onError((error, context) => {
    if (error instanceof AuthError) {
      const status = authErrorStatus(error);
      if (status === 401) {
        deleteCookie(context, SESSION_COOKIE, { path: "/" });
      }
      return context.json(
        apiError(error.code, error.message, error.details),
        status,
      );
    }
    if (error instanceof DomainError) {
      return context.json(
        apiError(error.code, error.message, error.details),
        error.statusCode as 400 | 401 | 403 | 404 | 409 | 429 | 503,
      );
    }
    if (error instanceof AutomationApiError) {
      const status = {
        invalid: 400,
        not_found: 404,
        conflict: 409,
      }[error.kind] as 400 | 404 | 409;
      return context.json(apiError(`automation_${error.kind}`, error.message), status);
    }
    if (error instanceof AutomationValidationError) {
      return context.json(
        apiError("automation_invalid", error.message, error.issues),
        400,
      );
    }
    if (error instanceof ConnectedAppSettingsError) {
      const status = {
        invalid: 400,
        not_found: 404,
        conflict: 409,
        unavailable: 503,
      }[error.kind] as 400 | 404 | 409 | 503;
      return context.json(apiError(`automation_app_${error.kind}`, error.message), status);
    }
    if (error instanceof z.ZodError) {
      return context.json(
        apiError("validation_error", "Entrada inválida", error.issues),
        400,
      );
    }
    if (error instanceof SyntaxError) {
      return context.json(apiError("invalid_json", "JSON inválido"), 400);
    }

    console.error("Erro inesperado na API", error);
    return context.json(apiError("internal_error", "Erro interno"), 500);
  });

  return app;
}

function authErrorStatus(
  error: AuthError,
): 400 | 401 | 403 | 404 | 409 | 429 {
  switch (error.code) {
    case "invalid_input":
      return 400;
    case "authentication_required":
    case "session_expired":
    case "invalid_credentials":
      return 401;
    case "forbidden":
      return 403;
    case "user_not_found":
      return 404;
    case "account_locked":
      return 429;
    case "setup_required":
    case "setup_already_completed":
    case "username_taken":
    case "last_owner_protected":
      return 409;
  }
}

export function startApiServer(options: StartApiServerOptions = {}): ServerType {
  const config = loadConfig();
  const ownsDatabase = !options.store && !options.database;
  const database = options.database ?? (options.store ? undefined : createDatabase(config.databasePath));
  const store = options.store ?? new SupportStore(database as SupportDatabase);
  const operationalDatabase = database ?? store.database;
  const runtimeState =
    options.runtimeState ?? new RuntimeStateFile(config.runtimeStatePath);
  const authService =
    options.authService ?? new LocalAuthService(operationalDatabase);
  const setupChallenges =
    options.setupChallenges ?? new SetupChallengeService(operationalDatabase);
  const secretVault = new LocalSecretVault(pathForSecrets(config.dataDir));
  const notifications =
    options.notifications ??
    new NotificationService(operationalDatabase);
  const automationRuntime =
    options.automationRuntime ??
    new AutomationRuntime(operationalDatabase, store, secretVault, {
      notifications,
    });
  const automationApi = new AutomationApiService(
    operationalDatabase,
    automationRuntime,
  );
  if (
    ownsDatabase &&
    authService?.getSetupStatus().required &&
    !setupChallenges.hasActive()
  ) {
    const issued = setupChallenges.issue();
    console.log("Código de configuração inicial (válido por 30 minutos):");
    console.log(issued.token);
  }
  const channels = new ChannelService(store, secretVault);
  const app = createApiApp(store, runtimeState, options.qrReader, {
    channels,
    auth: authService,
    setupChallenges,
    localAccessToken:
      options.localAccessToken ?? new LocalAccessToken(config.localAccessTokenPath),
    localSettings:
      options.localSettings ?? new LocalSettingsFile(config.localSettingsPath),
    storageUsage:
      options.storageUsage ??
      new LocalStorageUsageService({
        dataDirectory: config.dataDir,
        databasePath: config.databasePath,
        attachmentsDirectory: config.attachmentsDir,
        backupsDirectory: config.backupsDir,
        logsDirectory: config.logsDir,
      }),
    audioTranscription:
      options.audioTranscription ??
      new AudioTranscriptionService(operationalDatabase, {
        modelsDirectory: resolve(config.dataDir, "models", "transcription"),
      }),

    requestShutdown: options.requestShutdown,
    whatsappQrController: options.whatsappQrController,
    automations: automationApi,
    notifications,
    attachmentsDirectory: options.attachmentsDirectory ?? config.attachmentsDir,
  });
  const host = options.host ?? config.apiHost;
  const port = options.port ?? config.apiPort;
  const server = serve({ fetch: app.fetch, hostname: host, port });
  automationRuntime.start();
  const channelTimer = setInterval(() => channels.processPending(), 1_000);
  channelTimer.unref();
  channels.processPending();

  server.once("close", () => {
    clearInterval(channelTimer);
    void automationRuntime.stop().finally(() => {
      if (ownsDatabase && database) database.close();
    });
  });

  return server;
}

function pathForSecrets(dataDir: string): string {
  return resolve(dataDir, "secrets");
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && fileURLToPath(import.meta.url) === resolve(entry));
}

if (isEntrypoint()) {
  const config = loadConfig();
  startApiServer({ host: config.apiHost, port: config.apiPort });
  console.log(`Threadmark API em ${config.apiUrl}`);
}
