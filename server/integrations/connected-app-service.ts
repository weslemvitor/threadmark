import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { SupportDatabase } from "../db/index.js";
import { LocalSecretVault } from "../runtime/secret-vault.js";
import { customHttpConfigSchema } from "./connectors/custom-http.js";
import { slackWebhookConfigSchema } from "./connectors/slack-webhook.js";
import { assertResolvedDestinationAllowed } from "./http-executor.js";
import { publicHeaderSchema, safeHttpUrlSchema } from "./validation.js";

export const CONNECTED_APP_TYPES = ["slack_webhook", "custom_http"] as const;
export type ConnectedAppType = (typeof CONNECTED_APP_TYPES)[number];
export type ConnectedAppStatus = "active" | "disabled" | "error";

export interface ConnectedAppDto {
  id: string;
  type: ConnectedAppType;
  name: string;
  description: string | null;
  status: ConnectedAppStatus;
  secretConfigured: boolean;
  endpointPreview: string | null;
  lastTestAt: string | null;
  lastTestSucceeded: boolean | null;
  lastTestMessage: string | null;
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
}

export interface ResolvedConnectedApp {
  id: string;
  type: ConnectedAppType;
  providerId: "slack-webhook" | "custom-http";
  config: Record<string, unknown>;
}

type ConnectedAppRow = {
  id: string;
  provider_type: ConnectedAppType;
  name: string;
  description: string | null;
  enabled: number;
  config_json: string;
  secret_ref: string | null;
  secret_configured: number;
  last_tested_at: string | null;
  last_test_status: "success" | "failed" | null;
  last_test_message: string | null;
  created_at: string;
  updated_at: string;
};

type StoredConfig = {
  endpoint?: string;
  endpointPreview: string;
  publicHeaders: Array<{ name: string; value: string }>;
};

const writeSchema = z
  .object({
    type: z.enum(CONNECTED_APP_TYPES),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1_000).nullable().optional(),
    enabled: z.boolean().default(true),
    endpoint: z.string().trim().min(1).max(2_000),
    secret: z.string().trim().max(16_384).optional(),
    headers: z.record(z.string(), z.string().max(8_192)).default({}),
  })
  .strict();

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
    const stored = await this.prepareStoredConfig(id, parsed, secretRef, false);
    const now = new Date().toISOString();
    try {
      this.database
        .prepare(
          `INSERT INTO connected_apps (
             id, provider_type, name, description, enabled, config_json,
             secret_ref, secret_configured, created_by, updated_by,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          parsed.type,
          parsed.name,
          parsed.description ?? null,
          parsed.enabled ? 1 : 0,
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
      id,
      parsed,
      secretRef,
      Boolean(existing.secret_configured),
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
        async (hostname) => {
          const { lookup } = await import("node:dns/promises");
          return lookup(hostname, { all: true, verbatim: true });
        },
      );
      const now = new Date().toISOString();
      const message = "Configuração e destino validados; nenhuma ação externa foi executada.";
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
    return { id, type: row.provider_type, providerId: "custom-http", config: parsed };
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
    id: string,
    input: ReturnType<ConnectedAppService["parseWrite"]>,
    secretRef: string,
    hadSecret: boolean,
  ): Promise<{ config: StoredConfig; secretConfigured: boolean }> {
    const secret = input.secret?.trim();
    if (input.type === "slack_webhook") {
      await this.secrets.set(secretRef, input.endpoint);
      return {
        config: {
          endpointPreview: maskEndpoint(input.endpoint),
          publicHeaders: [],
        },
        secretConfigured: true,
      };
    }
    if (secret) await this.secrets.set(secretRef, normalizeAuthorization(secret));
    return {
      config: {
        endpoint: input.endpoint,
        endpointPreview: previewEndpoint(input.endpoint),
        publicHeaders: Object.entries(input.headers).map(([name, value]) => ({ name, value })),
      },
      secretConfigured: Boolean(secret || hadSecret),
    };
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
    lastTestAt: row.last_tested_at,
    lastTestSucceeded:
      row.last_test_status === null ? null : row.last_test_status === "success",
    lastTestMessage: row.last_test_message,
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
