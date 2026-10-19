import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { SupportDatabase } from "../db/index.js";
import { LocalSecretVault } from "../runtime/secret-vault.js";
import { customHttpConfigSchema } from "./connectors/custom-http.js";
import { slackWebhookConfigSchema } from "./connectors/slack-webhook.js";
import { assertResolvedDestinationAllowed } from "./http-executor.js";
import {
  McpRemoteClient,
  type McpDiscoveredTool,
  type McpToolCallResult,
} from "./mcp-client.js";
import { publicHeaderSchema, safeHttpUrlSchema } from "./validation.js";

export const CONNECTED_APP_TYPES = [
  "slack_webhook",
  "custom_http",
  "mcp_remote",
] as const;
export type ConnectedAppType = (typeof CONNECTED_APP_TYPES)[number];
export type ConnectedAppStatus = "active" | "disabled" | "error";

export type ConnectedAppMcpTool = McpDiscoveredTool & {
  automationEnabled: boolean;
  confirmationRequired: boolean;
};

export type ConnectedAppMcpToolPermission = Pick<
  ConnectedAppMcpTool,
  "name" | "automationEnabled" | "confirmationRequired"
>;

export interface ConnectedAppDto {
  id: string;
  type: ConnectedAppType;
  name: string;
  description: string | null;
  status: ConnectedAppStatus;
  secretConfigured: boolean;
  endpointPreview: string | null;
  allowPrivateNetwork: boolean;
  lastTestAt: string | null;
  lastTestSucceeded: boolean | null;
  lastTestMessage: string | null;
  mcpTools: ConnectedAppMcpTool[];
  createdAt: string;
  updatedAt: string;
}

export interface ConnectedAppWriteInput {
  type: ConnectedAppType;
  name: string;
  description?: string | null;
  enabled?: boolean;
  endpoint: string;
  secret?: string;
  headers?: Record<string, string>;
  allowPrivateNetwork?: boolean;
  mcpTools?: ConnectedAppMcpToolPermission[];
}

export interface ResolvedConnectedApp {
  id: string;
  type: ConnectedAppType;
  providerId: "slack-webhook" | "custom-http" | "mcp-remote";
  config: Record<string, unknown>;
}

type ConnectedAppRow = {
  id: string;
  provider_type: ConnectedAppType;
  name: string;
  description: string | null;
  enabled: number;
  /** Inert legacy column retained because installed SQLite databases contain it. */
  ai_enabled: number;
  config_json: string;
  secret_ref: string | null;
  secret_configured: number;
  last_tested_at: string | null;
  last_test_status: "success" | "failed" | null;
  last_test_message: string | null;
  created_at: string;
  updated_at: string;
};

type StoredMcpTool = ConnectedAppMcpTool & {
  /** Persisted legacy authorization; parsed but never exposed or enforced. */
  aiEnabled?: boolean;
};

type StoredConfig = {
  endpoint?: string;
  endpointPreview: string;
  publicHeaders: Array<{ name: string; value: string }>;
  allowPrivateNetwork: boolean;
  mcpTools: StoredMcpTool[];
};

const mcpToolPermissionSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    // Accepted from old local clients but intentionally discarded.
    aiEnabled: z.boolean().optional(),
    automationEnabled: z.boolean(),
    confirmationRequired: z.boolean(),
  })
  .strict()
  .transform(({ aiEnabled: _legacyAiEnabled, ...permission }) => { void _legacyAiEnabled; return permission; });

const writeSchema = z
  .object({
    type: z.enum(CONNECTED_APP_TYPES),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1_000).nullable().optional(),
    enabled: z.boolean().default(true),
    // Accepted from old local clients but intentionally discarded.
    aiEnabled: z.boolean().optional(),
    endpoint: z.string().trim().min(1).max(2_000),
    secret: z.string().trim().max(16_384).optional(),
    headers: z.record(z.string(), z.string().max(8_192)).default({}),
    allowPrivateNetwork: z.boolean().default(false),
    mcpTools: z.array(mcpToolPermissionSchema).max(200).optional(),
  })
  .strict()
  .transform(({ aiEnabled: _legacyAiEnabled, ...input }) => { void _legacyAiEnabled; return input; });

export class ConnectedAppSettingsError extends Error {
  constructor(
    message: string,
    readonly kind: "invalid" | "not_found" | "conflict" | "unavailable" = "invalid",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ConnectedAppSettingsError";
  }
}

/**
 * Persistent registry for outbound integrations explicitly configured by the
 * workspace owner. SQLite stores only metadata and public configuration; URLs
 * or tokens classified as secret remain exclusively in LocalSecretVault.
 */
export class ConnectedAppService {
  constructor(
    private readonly database: SupportDatabase,
    private readonly secrets: LocalSecretVault,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
    private readonly lookup: (hostname: string) => Promise<Array<{ address: string }>> = async (hostname) => {
      const { lookup } = await import("node:dns/promises");
      return lookup(hostname, { all: true, verbatim: true });
    },
  ) {}

  list(): ConnectedAppDto[] {
    return this.rows(
      `SELECT * FROM connected_apps
       ORDER BY enabled DESC, name COLLATE NOCASE, id`,
    ).map(toDto);
  }

  get(id: string): ConnectedAppDto {
    return toDto(this.requireRow(id));
  }

  async create(input: ConnectedAppWriteInput, actor: string): Promise<ConnectedAppDto> {
    const parsed = this.parseWrite(input);
    const id = randomUUID();
    const secretRef = `connected-app:${id}:credential`;
    const stored = await this.prepareStoredConfig(parsed, secretRef, false);
    const now = new Date().toISOString();
    try {
      this.database
        .prepare(
          `INSERT INTO connected_apps (
             id, provider_type, name, description, enabled, ai_enabled, config_json,
             secret_ref, secret_configured, created_by, updated_by,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          parsed.type,
          parsed.name,
          parsed.description ?? null,
          parsed.enabled ? 1 : 0,
          0,
          JSON.stringify(stored.config),
          stored.secretConfigured ? secretRef : null,
          stored.secretConfigured ? 1 : 0,
          requiredActor(actor),
          requiredActor(actor),
          now,
          now,
        );
    } catch (error) {
      if (stored.secretConfigured) await this.secrets.delete(secretRef).catch(() => false);
      throw error;
    }
    return this.get(id);
  }

  async update(
    id: string,
    input: ConnectedAppWriteInput,
    actor: string,
  ): Promise<ConnectedAppDto> {
    const existing = this.requireRow(id);
    const existingConfig = parseStoredConfig(existing.config_json);
    const retainedEndpoint = input.endpoint.trim()
      ? input.endpoint
      : existing.provider_type === "slack_webhook"
        ? await this.secrets.get(existing.secret_ref ?? "")
        : existingConfig.endpoint;
    if (!retainedEndpoint) {
      throw new ConnectedAppSettingsError(
        "Informe novamente o endpoint porque o valor protegido não está disponível.",
      );
    }
    const parsed = this.parseWrite({ ...input, endpoint: retainedEndpoint });
    if (parsed.type !== existing.provider_type) {
      throw new ConnectedAppSettingsError(
        "O tipo do app conectado não pode ser alterado.",
        "conflict",
      );
    }
    const secretRef = existing.secret_ref ?? `connected-app:${id}:credential`;
    const stored = await this.prepareStoredConfig(
      parsed,
      secretRef,
      Boolean(existing.secret_configured),
      existingConfig,
    );
    const now = new Date().toISOString();
    this.database
      .prepare(
        `UPDATE connected_apps
         SET name = ?, description = ?, enabled = ?, config_json = ?,
             secret_ref = ?, secret_configured = ?, updated_by = ?, updated_at = ?,
             last_tested_at = NULL, last_test_status = NULL, last_test_message = NULL
         WHERE id = ?`,
      )
      .run(
        parsed.name,
        parsed.description ?? null,
        parsed.enabled ? 1 : 0,
        JSON.stringify(stored.config),
        stored.secretConfigured ? secretRef : null,
        stored.secretConfigured ? 1 : 0,
        requiredActor(actor),
        now,
        id,
      );
    return this.get(id);
  }

  async delete(id: string): Promise<void> {
    const row = this.requireRow(id);
    if (this.isReferencedByCurrentWorkflow(id)) {
      throw new ConnectedAppSettingsError(
        "Este app ainda está vinculado a um fluxo. Remova o nó antes de excluir.",
        "conflict",
      );
    }
    this.database.prepare("DELETE FROM connected_apps WHERE id = ?").run(id);
    if (row.secret_ref) await this.secrets.delete(row.secret_ref);
  }

  async validateConnection(id: string): Promise<{ ok: true; message: string }> {
    const row = this.requireRow(id);
    try {
      const resolved = await this.resolveForExecution(id);
      const endpoint =
        row.provider_type === "slack_webhook"
          ? await this.secrets.get(row.secret_ref ?? "")
          : String(resolved.config.endpoint ?? "");
      if (!endpoint) {
        throw new ConnectedAppSettingsError(
          "A credencial ou o endpoint do app não está disponível.",
          "invalid",
        );
      }
      const url = safeHttpUrlSchema.parse(endpoint);
      await assertResolvedDestinationAllowed(
        url,
        Boolean(resolved.config.allowPrivateNetwork),
        this.lookup,
      );
      const now = new Date().toISOString();
      const message = row.provider_type === "mcp_remote"
        ? await this.refreshMcpTools(row)
          : "Configuração e destino validados; nenhuma ação externa foi executada.";
      this.recordTest(id, true, message, now);
      return { ok: true, message };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Falha ao validar conexão.";
      this.recordTest(id, false, message, new Date().toISOString());
      throw new ConnectedAppSettingsError(message, "unavailable", { cause: error });
    }
  }

  async resolveForExecution(id: string): Promise<ResolvedConnectedApp> {
    const row = this.requireRow(id);
    if (!row.enabled) {
      throw new ConnectedAppSettingsError("O app conectado está desativado.", "conflict");
    }
    const config = parseStoredConfig(row.config_json);
    if (row.provider_type === "slack_webhook") {
      const parsed = slackWebhookConfigSchema.parse({
        webhookSecretRef: row.secret_ref,
        timeoutMs: 10_000,
        allowPrivateNetwork: false,
      });
      return { id, type: row.provider_type, providerId: "slack-webhook", config: parsed };
    }
    if (row.provider_type === "mcp_remote") {
      return {
        id,
        type: row.provider_type,
        providerId: "mcp-remote",
        config: {
          endpoint: config.endpoint,
          allowPrivateNetwork: config.allowPrivateNetwork,
          tools: config.mcpTools,
        },
      };
    }
    const secretHeaders = row.secret_ref
      ? [{ name: "Authorization", secretRef: row.secret_ref }]
      : [];
    const parsed = customHttpConfigSchema.parse({
      endpoint: config.endpoint,
      method: "POST",
      publicHeaders: config.publicHeaders,
      secretHeaders,
      bodyTemplate: "{{payload}}",
      idempotencyHeader: "Idempotency-Key",
      timeoutMs: 10_000,
      allowPrivateNetwork: false,
    });
    return {
      id,
      type: row.provider_type,
      providerId: "custom-http",
      config: parsed,
    };
  }

  async callMcpTool(
    id: string,
    toolName: string,
    argumentsValue: Record<string, unknown>,
    signal?: AbortSignal | "ai" | "automation",
  ): Promise<McpToolCallResult> {
    const row = this.requireRow(id);
    if (!row.enabled || row.provider_type !== "mcp_remote") {
      throw new ConnectedAppSettingsError("A conexão MCP está indisponível.", "conflict");
    }
    const config = parseStoredConfig(row.config_json);
    const tool = config.mcpTools.find((candidate) => candidate.name === toolName);
    if (!tool || !tool.automationEnabled) {
      throw new ConnectedAppSettingsError(
        `A ferramenta MCP “${toolName}” não foi autorizada para automações.`,
        "conflict",
      );
    }
    const token = row.secret_ref ? await this.secrets.get(row.secret_ref) : null;
    const client = new McpRemoteClient({ fetchImpl: this.fetchImpl, lookup: this.lookup });
    const result = await client.callTool(
      {
        endpoint: requireEndpoint(config),
        bearerToken: token,
        allowPrivateNetwork: config.allowPrivateNetwork,
      },
      tool.name,
      normalizeMcpArguments(tool.inputSchema, argumentsValue),
      // Older local clients supplied an authorization mode here. It is parsed
      // only for compatibility; MCP calls are now authorized solely above by
      // automationEnabled and never by an embedded-agent mode.
      typeof signal === "string" ? undefined : signal,
    );
    if (result.isError) {
      throw new ConnectedAppSettingsError(
        `A ferramenta MCP “${tool.title}” devolveu um erro.`,
        "unavailable",
      );
    }
    return result;
  }

  private parseWrite(input: ConnectedAppWriteInput) {
    try {
      const parsed = writeSchema.parse(input);
      const endpoint = safeHttpUrlSchema.parse(parsed.endpoint);
      if (parsed.type === "slack_webhook" && endpoint.protocol !== "https:") {
        throw new ConnectedAppSettingsError("O webhook do Slack precisa usar HTTPS.");
      }

      for (const [name, value] of Object.entries(parsed.headers)) {
        publicHeaderSchema.parse({ name, value });
      }
      return { ...parsed, endpoint: endpoint.toString() };
    } catch (error) {
      if (error instanceof ConnectedAppSettingsError) throw error;
      throw new ConnectedAppSettingsError("Configuração do app inválida.", "invalid", {
        cause: error,
      });
    }
  }

  private async prepareStoredConfig(
    input: ReturnType<ConnectedAppService["parseWrite"]>,
    secretRef: string,
    hadSecret: boolean,
    existingConfig?: StoredConfig,
  ): Promise<{ config: StoredConfig; secretConfigured: boolean }> {
    const secret = input.secret?.trim();
    if (input.type === "slack_webhook") {
      await this.secrets.set(secretRef, input.endpoint);
      return {
        config: {
          endpointPreview: maskEndpoint(input.endpoint),
          publicHeaders: [],
          allowPrivateNetwork: false,
          mcpTools: [],
        },
        secretConfigured: true,
      };
    }
    if (secret) await this.secrets.set(secretRef, normalizeAuthorization(secret));
    const permissions = new Map(input.mcpTools?.map((tool) => [tool.name, tool]));
    const existingTools = input.type === "mcp_remote" ? existingConfig?.mcpTools ?? [] : [];
    return {
      config: {
        endpoint: input.endpoint,
        endpointPreview: previewEndpoint(input.endpoint),
        publicHeaders: Object.entries(input.headers).map(([name, value]) => ({ name, value })),
        allowPrivateNetwork: input.type === "mcp_remote" && input.allowPrivateNetwork,
        mcpTools: existingTools.map((tool) => {
          const permission = permissions.get(tool.name);
          return permission ? { ...tool, ...permission } : tool;
        }),
      },
      secretConfigured: Boolean(secret || hadSecret),
    };
  }

  private async refreshMcpTools(row: ConnectedAppRow): Promise<string> {
    const config = parseStoredConfig(row.config_json);
    const token = row.secret_ref ? await this.secrets.get(row.secret_ref) : null;
    const client = new McpRemoteClient({ fetchImpl: this.fetchImpl, lookup: this.lookup });
    const discovered = await client.listTools({
      endpoint: requireEndpoint(config),
      bearerToken: token,
      allowPrivateNetwork: config.allowPrivateNetwork,
    });
    const previous = new Map(config.mcpTools.map((tool) => [tool.name, tool]));
    config.mcpTools = discovered.map((tool) => {
      const saved = previous.get(tool.name);
      return {
        ...tool,
        ...(typeof saved?.aiEnabled === "boolean" ? { aiEnabled: saved.aiEnabled } : {}),
        automationEnabled: saved?.automationEnabled ?? false,
        confirmationRequired: saved?.confirmationRequired ?? !tool.annotations.readOnlyHint,
      };
    });
    this.database
      .prepare("UPDATE connected_apps SET config_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(config), new Date().toISOString(), row.id);
    return `Servidor MCP conectado: ${config.mcpTools.length} ferramenta(s) descoberta(s). Revise quais podem ser usadas pelas automações.`;
  }

  private recordTest(id: string, succeeded: boolean, message: string, at: string): void {
    this.database
      .prepare(
        `UPDATE connected_apps
         SET last_tested_at = ?, last_test_status = ?, last_test_message = ?
         WHERE id = ?`,
      )
      .run(at, succeeded ? "success" : "failed", message.slice(0, 1_000), id);
  }

  private requireRow(id: string): ConnectedAppRow {
    const row = this.database
      .prepare("SELECT * FROM connected_apps WHERE id = ?")
      .get(id) as ConnectedAppRow | undefined;
    if (!row) throw new ConnectedAppSettingsError("App conectado não encontrado.", "not_found");
    return row;
  }

  private rows(sql: string): ConnectedAppRow[] {
    return this.database.prepare(sql).all() as ConnectedAppRow[];
  }

  private isReferencedByCurrentWorkflow(appId: string): boolean {
    const rows = this.database
      .prepare(
        `SELECT version.definition_json
         FROM automation_workflows workflow
         JOIN automation_workflow_versions version
           ON version.workflow_id = workflow.id
          AND version.version = workflow.current_version`,
      )
      .all() as Array<{ definition_json: string }>;
    return rows.some(({ definition_json }) => {
      try {
        const definition = JSON.parse(definition_json) as {
          nodes?: Array<{ type?: string; config?: { appId?: string; connectedAppId?: string } }>;
        };
        return definition.nodes?.some(
          (node) =>
            node.type === "app_action" &&
            (node.config?.appId === appId || node.config?.connectedAppId === appId),
        ) === true;
      } catch {
        return false;
      }
    });
  }
}

function toDto(row: ConnectedAppRow): ConnectedAppDto {
  const config = parseStoredConfig(row.config_json);
  return {
    id: row.id,
    type: row.provider_type,
    name: row.name,
    description: row.description,
    status: row.enabled ? (row.last_test_status === "failed" ? "error" : "active") : "disabled",
    secretConfigured: Boolean(row.secret_configured),
    endpointPreview: config.endpointPreview || null,
    allowPrivateNetwork: config.allowPrivateNetwork,
    lastTestAt: row.last_tested_at,
    lastTestSucceeded:
      row.last_test_status === null ? null : row.last_test_status === "success",
    lastTestMessage: row.last_test_message,
    mcpTools: config.mcpTools.map(toPublicMcpTool),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseStoredConfig(value: string): StoredConfig {
  try {
    const parsed = JSON.parse(value) as Partial<StoredConfig>;
    return {
      ...(parsed.endpoint ? { endpoint: parsed.endpoint } : {}),
      endpointPreview: parsed.endpointPreview ?? "",
      publicHeaders: Array.isArray(parsed.publicHeaders) ? parsed.publicHeaders : [],
      allowPrivateNetwork: parsed.allowPrivateNetwork === true,
      mcpTools: Array.isArray(parsed.mcpTools)
        ? parsed.mcpTools.filter(isStoredMcpTool).slice(0, 200)
        : [],
    };
  } catch {
    throw new ConnectedAppSettingsError("Configuração persistida do app é inválida.", "invalid");
  }
}

function requiredActor(value: string): string {
  const actor = value.trim();
  if (!actor || actor.length > 200) throw new ConnectedAppSettingsError("Responsável inválido.");
  return actor;
}



function normalizeAuthorization(value: string): string {
  return /^(?:Bearer|Basic)\s+/i.test(value) ? value : `Bearer ${value}`;
}

function previewEndpoint(value: string): string {
  const url = new URL(value);
  const path = url.pathname.length > 80 ? `${url.pathname.slice(0, 77)}…` : url.pathname;
  return `${url.origin}${path}`;
}

function maskEndpoint(value: string): string {
  const url = new URL(value);
  return `${url.origin}/••••••••`;
}

function requireEndpoint(config: StoredConfig): string {
  if (!config.endpoint) {
    throw new ConnectedAppSettingsError("O endpoint MCP não está disponível.", "invalid");
  }
  return config.endpoint;
}

function toPublicMcpTool(tool: StoredMcpTool): ConnectedAppMcpTool {
  const { aiEnabled: _legacyAiEnabled, ...publicTool } = tool;
  void _legacyAiEnabled;
  return publicTool;
}

function isStoredMcpTool(value: unknown): value is StoredMcpTool {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const tool = value as Partial<StoredMcpTool>;
  return (
    typeof tool.name === "string" &&
    typeof tool.title === "string" &&
    typeof tool.description === "string" &&
    Boolean(tool.inputSchema) &&
    typeof tool.inputSchema === "object" &&
    Boolean(tool.annotations) &&
    typeof tool.annotations === "object" &&
    (tool.aiEnabled === undefined || typeof tool.aiEnabled === "boolean") &&
    typeof tool.automationEnabled === "boolean" &&
    typeof tool.confirmationRequired === "boolean"
  );
}

function normalizeMcpArguments(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return value;
  const result = { ...value };
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === "string")
      : [],
  );
  for (const [name, property] of Object.entries(properties)) {
    if (!property || typeof property !== "object" || Array.isArray(property)) continue;
    const current = result[name];
    if (
      !required.has(name) &&
      (
        current === null ||
        current === undefined ||
        (typeof current === "string" && current.trim() === `<${name}>`)
      )
    ) {
      delete result[name];
      continue;
    }
    const type = (property as { type?: unknown }).type;
    if ((type === "object" || type === "array") && typeof current === "string") {
      try {
        result[name] = JSON.parse(current) as unknown;
      } catch {
        throw new ConnectedAppSettingsError(`O campo MCP “${name}” precisa conter JSON válido.`);
      }
    }
  }
  return result;
}
