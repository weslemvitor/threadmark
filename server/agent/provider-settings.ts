import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { SupportDatabase } from "../db/index.js";
import { LocalSecretVault } from "../runtime/secret-vault.js";
import type { CodexSupportAgent } from "./codex-runner.js";
import {
  createSupportAgent,
  type SupportAgentProviderConfig,
} from "./provider-factory.js";
import {
  AI_PROVIDER_CAPABILITIES,
  type AiProviderId,
  type SupportAgent,
} from "./provider.js";

const execFileAsync = promisify(execFile);

export type AiProviderSettingsErrorKind =
  | "invalid"
  | "not_found"
  | "conflict"
  | "unavailable";

export class AiProviderSettingsError extends Error {
  constructor(
    message: string,
    readonly kind: AiProviderSettingsErrorKind = "invalid",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AiProviderSettingsError";
  }
}

export type AiTaskKind = "triage" | "automatic" | "deep";

export interface AiConnectionDto {
  id: string;
  label: string;
  providerId: AiProviderId;
  baseUrl: string | null;
  enabled: boolean;
  hasSecret: boolean;
  secretLastFour: string | null;
  capabilities: {
    automaticAnalysis: boolean;
    triage: boolean;
    structuredOutput: boolean;
    vision: boolean;
    localTools: boolean;
    codebaseAccess: boolean;
    deepInvestigation: boolean;
  };
  createdAt: string;
  updatedAt: string;
}

export interface AiTaskProfileDto {
  taskKind: AiTaskKind;
  connectionId: string | null;
  model: string;
  enabled: boolean;
  updatedAt: string;
}

export interface AiConnectionWriteInput {
  label: string;
  providerId: AiProviderId;
  baseUrl?: string | null;
  enabled?: boolean;
  apiKey?: string;
}

interface ConnectionRow {
  id: string;
  provider_id: AiProviderId;
  label: string;
  base_url: string | null;
  secret_ref: string | null;
  secret_last_four: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface ProfileRow {
  task_kind: AiTaskKind;
  connection_id: string | null;
  model: string;
  enabled: number;
  updated_at: string;
}

export class AiProviderSettingsService {
  constructor(
    private readonly database: SupportDatabase,
    private readonly secrets: LocalSecretVault,
    private readonly options: { codexBin?: string; attachmentsRoot?: string } = {},
  ) {}

  listConnections(): AiConnectionDto[] {
    return (this.database
      .prepare(
        `SELECT id, provider_id, label, base_url, secret_ref, secret_last_four,
                enabled, created_at, updated_at
         FROM ai_provider_connections
         ORDER BY CASE provider_id WHEN 'codex' THEN 0 ELSE 1 END,
                  label COLLATE NOCASE, id`,
      )
      .all() as ConnectionRow[]).map(connectionDto);
  }

  async createConnection(
    input: AiConnectionWriteInput,
    actor: string,
  ): Promise<AiConnectionDto> {
    const providerId = validateProvider(input.providerId);
    if (providerId === "codex") {
      throw new AiProviderSettingsError(
        "O Codex CLI integrado já está disponível e não precisa de outra conexão.",
        "conflict",
      );
    }
    const label = requiredText(input.label, "Nome da conexão", 120);
    const baseUrl = validateBaseUrl(providerId, input.baseUrl);
    const apiKey = input.apiKey?.trim() || null;
    if (AI_PROVIDER_CAPABILITIES[providerId].requiresApiKey && !apiKey) {
      throw new AiProviderSettingsError("Informe a chave de API para este provedor.");
    }
    const id = randomUUID();
    const secretRef = apiKey ? `ai-provider:${id}` : null;
    if (secretRef && apiKey) await this.secrets.set(secretRef, apiKey);
    const now = new Date().toISOString();
    try {
      this.database
        .prepare(
          `INSERT INTO ai_provider_connections (
             id, provider_id, label, base_url, secret_ref, secret_last_four,
             enabled, config_json, created_by, updated_by, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)`,
        )
        .run(
          id,
          providerId,
          label,
          baseUrl,
          secretRef,
          apiKey ? apiKey.slice(-4) : null,
          input.enabled === false ? 0 : 1,
          actor,
          actor,
          now,
          now,
        );
    } catch (error) {
      if (secretRef) await this.secrets.delete(secretRef).catch(() => undefined);
      throw error;
    }
    return this.getConnection(id);
  }

  async updateConnection(
    id: string,
    input: Partial<AiConnectionWriteInput>,
    actor: string,
  ): Promise<AiConnectionDto> {
    const current = this.requireConnectionRow(id);
    if (input.providerId && input.providerId !== current.provider_id) {
      throw new AiProviderSettingsError("O provedor de uma conexão existente não pode ser alterado.");
    }
    const label = input.label === undefined
      ? current.label
      : requiredText(input.label, "Nome da conexão", 120);
    const baseUrl = input.baseUrl === undefined
      ? current.base_url
      : validateBaseUrl(current.provider_id, input.baseUrl);
    const enabled = input.enabled === undefined ? current.enabled : input.enabled ? 1 : 0;
    if (!enabled && current.enabled && this.activeProfileCount(id) > 0) {
      throw new AiProviderSettingsError(
        "Desative ou altere os perfis que usam esta conexão antes de desativá-la.",
        "conflict",
      );
    }
    const apiKey = input.apiKey?.trim() || null;
    let secretRef = current.secret_ref;
    let secretLastFour = current.secret_last_four;
    if (apiKey) {
      secretRef ??= `ai-provider:${id}`;
      await this.secrets.set(secretRef, apiKey);
      secretLastFour = apiKey.slice(-4);
    }
    if (
      enabled &&
      AI_PROVIDER_CAPABILITIES[current.provider_id].requiresApiKey &&
      !secretRef
    ) {
      throw new AiProviderSettingsError("Informe a chave de API antes de ativar esta conexão.");
    }
    this.database
      .prepare(
        `UPDATE ai_provider_connections
         SET label = ?, base_url = ?, secret_ref = ?, secret_last_four = ?,
             enabled = ?, updated_by = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        label,
        baseUrl,
        secretRef,
        secretLastFour,
        enabled,
        actor,
        new Date().toISOString(),
        id,
      );
    return this.getConnection(id);
  }

  async deleteConnection(id: string): Promise<void> {
    const current = this.requireConnectionRow(id);
    if (id === "builtin-codex") {
      throw new AiProviderSettingsError(
        "A conexão integrada do Codex não pode ser excluída.",
        "conflict",
      );
    }
    this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE ai_task_profiles
           SET connection_id = NULL, enabled = 0, updated_at = ?
           WHERE connection_id = ?`,
        )
        .run(new Date().toISOString(), id);
      this.database.prepare("DELETE FROM ai_provider_connections WHERE id = ?").run(id);
    })();
    if (current.secret_ref) await this.secrets.delete(current.secret_ref);
  }

  getProfiles(): AiTaskProfileDto[] {
    return (this.database
      .prepare(
        `SELECT task_kind, connection_id, model, enabled, updated_at
         FROM ai_task_profiles
         ORDER BY CASE task_kind WHEN 'triage' THEN 0 WHEN 'automatic' THEN 1 ELSE 2 END`,
      )
      .all() as ProfileRow[]).map(profileDto);
  }

  assertTaskReady(taskKind: AiTaskKind): void {
    const profile = this.getProfiles().find((item) => item.taskKind === taskKind);
    if (!profile?.enabled || !profile.connectionId) {
      throw new AiProviderSettingsError(
        `${taskLabel(taskKind)} está desativada nas configurações de IA.`,
        "conflict",
      );
    }
    const connection = this.requireConnectionRow(profile.connectionId);
    if (!connection.enabled) {
      throw new AiProviderSettingsError(
        "A conexão de IA selecionada está desativada.",
        "conflict",
      );
    }
    assertProviderSupportsTask(taskKind, connection.provider_id);
  }

  updateProfiles(
    profiles: Array<Omit<AiTaskProfileDto, "updatedAt">>,
    actor: string,
  ): AiTaskProfileDto[] {
    const byTask = new Map(profiles.map((profile) => [profile.taskKind, profile]));
    const now = new Date().toISOString();
    this.database.transaction(() => {
      for (const taskKind of ["triage", "automatic", "deep"] as const) {
        const profile = byTask.get(taskKind);
        if (!profile) continue;
        const model = requiredText(profile.model, "Modelo", 200);
        const connection = profile.connectionId
          ? this.requireConnectionRow(profile.connectionId)
          : null;
        if (profile.enabled && (!connection || !connection.enabled)) {
          throw new AiProviderSettingsError(`Selecione uma conexão ativa para ${taskLabel(taskKind)}.`);
        }
        if (connection) assertProviderSupportsTask(taskKind, connection.provider_id);
        this.database
          .prepare(
            `INSERT INTO ai_task_profiles (
               task_kind, connection_id, model, enabled, updated_by, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(task_kind) DO UPDATE SET
               connection_id = excluded.connection_id,
               model = excluded.model,
               enabled = excluded.enabled,
               updated_by = excluded.updated_by,
               updated_at = excluded.updated_at`,
          )
          .run(
            taskKind,
            profile.connectionId,
            model,
            profile.enabled ? 1 : 0,
            actor,
            now,
            now,
          );
        if (taskKind === "triage") {
          this.database
            .prepare(
              `UPDATE triage_ai_settings
               SET enabled = ?, model = ?, updated_by = ?, updated_at = ?
               WHERE singleton = 1`,
            )
            .run(profile.enabled ? 1 : 0, model, actor, now);
        }
      }
    })();
    return this.getProfiles();
  }

  async createAgentForTask(
    taskKind: AiTaskKind,
    codexAgent: CodexSupportAgent,
  ): Promise<{ agent: SupportAgent; profile: AiTaskProfileDto; connection: AiConnectionDto }> {
    const profile = this.getProfiles().find((item) => item.taskKind === taskKind);
    if (!profile?.enabled || !profile.connectionId) {
      throw new AiProviderSettingsError(
        `${taskLabel(taskKind)} está desativada nas configurações de IA.`,
        "conflict",
      );
    }
    const row = this.requireConnectionRow(profile.connectionId);
    if (!row.enabled) {
      throw new AiProviderSettingsError(
        "A conexão de IA selecionada está desativada.",
        "conflict",
      );
    }
    assertProviderSupportsTask(taskKind, row.provider_id);
    const config = await this.providerConfig(row, profile.model, codexAgent);
    return {
      agent: createSupportAgent(config),
      profile,
      connection: connectionDto(row),
    };
  }

  async testConnection(id: string): Promise<{ ok: true; message: string; models: string[] }> {
    const connection = this.requireConnectionRow(id);
    if (connection.provider_id === "codex") {
      try {
        const { stdout } = await execFileAsync(this.options.codexBin ?? "codex", ["--version"], {
          timeout: 10_000,
        });
        let models = ["default"];
        try {
          const catalog = await execFileAsync(
            this.options.codexBin ?? "codex",
            ["debug", "models"],
            { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 },
          );
          models = extractCodexModelIds(JSON.parse(catalog.stdout) as unknown);
        } catch {
          // A versão continua utilizável mesmo quando o catálogo não pode ser atualizado.
        }
        return {
          ok: true,
          message: `${stdout.trim() || "Codex CLI disponível."} Catálogo de modelos do Codex carregado.`,
          models,
        };
      } catch (error) {
        throw new AiProviderSettingsError(
          "Não foi possível executar o Codex CLI configurado.",
          "unavailable",
          { cause: error },
        );
      }
    }
    const apiKey = connection.secret_ref
      ? await this.secrets.get(connection.secret_ref)
      : null;
    if (AI_PROVIDER_CAPABILITIES[connection.provider_id].requiresApiKey && !apiKey) {
      throw new AiProviderSettingsError("A conexão não possui uma chave de API válida.");
    }
    const { url, headers } = modelDiscoveryRequest(connection, apiKey);
    let response: Response;
    let body: unknown;
    try {
      response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) {
        throw new AiProviderSettingsError(
          `O provedor recusou o teste (${response.status}).`,
          "unavailable",
        );
      }
      body = (await response.json()) as unknown;
    } catch (error) {
      if (error instanceof AiProviderSettingsError) throw error;
      throw new AiProviderSettingsError(
        "Não foi possível acessar o provedor. Confira a URL, a rede e a credencial.",
        "unavailable",
        { cause: error },
      );
    }
    return {
      ok: true,
      message: "Conexão validada sem armazenar a resposta do provedor.",
      models: extractModelIds(connection.provider_id, body).slice(0, 100),
    };
  }

  private async providerConfig(
    connection: ConnectionRow,
    model: string,
    codexAgent: CodexSupportAgent,
  ): Promise<SupportAgentProviderConfig> {
    if (connection.provider_id === "codex") {
      return { providerId: "codex", agent: codexAgent, model };
    }
    const apiKey = connection.secret_ref
      ? await this.secrets.get(connection.secret_ref)
      : null;
    const common = {
      model,
      ...(connection.base_url ? { baseUrl: connection.base_url } : {}),
      ...(this.options.attachmentsRoot
        ? { attachmentsRoot: this.options.attachmentsRoot }
        : {}),
    };
    switch (connection.provider_id) {
      case "openai":
      case "anthropic":
      case "openrouter":
        if (!apiKey) throw new AiProviderSettingsError("A chave da conexão de IA não está disponível.");
        return { providerId: connection.provider_id, apiKey, ...common } as SupportAgentProviderConfig;
      case "ollama":
        return { providerId: "ollama", ...common };
    }
  }

  private getConnection(id: string): AiConnectionDto {
    return connectionDto(this.requireConnectionRow(id));
  }

  private requireConnectionRow(id: string): ConnectionRow {
    const row = this.database
      .prepare(
        `SELECT id, provider_id, label, base_url, secret_ref, secret_last_four,
                enabled, created_at, updated_at
         FROM ai_provider_connections WHERE id = ?`,
      )
      .get(id) as ConnectionRow | undefined;
    if (!row) {
      throw new AiProviderSettingsError(
        "Conexão de IA não encontrada.",
        "not_found",
      );
    }
    return row;
  }

  private activeProfileCount(connectionId: string): number {
    return (
      this.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM ai_task_profiles
           WHERE connection_id = ? AND enabled = 1`,
        )
        .get(connectionId) as { count: number }
    ).count;
  }
}

function connectionDto(row: ConnectionRow): AiConnectionDto {
  const capabilities = AI_PROVIDER_CAPABILITIES[row.provider_id];
  return {
    id: row.id,
    label: row.label,
    providerId: row.provider_id,
    baseUrl: row.base_url,
    enabled: Boolean(row.enabled),
    hasSecret: Boolean(row.secret_ref),
    secretLastFour: row.secret_last_four,
    capabilities: {
      automaticAnalysis: capabilities.automaticAnalysis,
      triage: capabilities.triage,
      structuredOutput: capabilities.structuredOutput,
      vision: capabilities.imageInput !== "none",
      localTools: capabilities.codebaseAccess,
      codebaseAccess: capabilities.codebaseAccess,
      deepInvestigation: capabilities.deepInvestigation,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function profileDto(row: ProfileRow): AiTaskProfileDto {
  return {
    taskKind: row.task_kind,
    connectionId: row.connection_id,
    model: row.model,
    enabled: Boolean(row.enabled),
    updatedAt: row.updated_at,
  };
}

function validateProvider(value: string): AiProviderId {
  if (value in AI_PROVIDER_CAPABILITIES) return value as AiProviderId;
  throw new AiProviderSettingsError("Provedor de IA inválido.");
}

function validateBaseUrl(provider: AiProviderId, value?: string | null): string | null {
  const normalized = value?.trim() || null;
  if (!normalized || provider === "codex") return null;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new AiProviderSettingsError("A URL base da conexão é inválida.");
  }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (provider === "ollama" && !loopback) {
    throw new AiProviderSettingsError("Por segurança, o Ollama deve usar um endereço local.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new AiProviderSettingsError("Use HTTPS ou um endereço HTTP estritamente local.");
  }
  return url.toString().replace(/\/$/, "");
}

function requiredText(value: string, label: string, max: number): string {
  const normalized = value?.trim();
  if (!normalized) throw new AiProviderSettingsError(`${label} é obrigatório.`);
  if (normalized.length > max) throw new AiProviderSettingsError(`${label} excede ${max} caracteres.`);
  return normalized;
}

function taskLabel(task: AiTaskKind): string {
  return task === "triage"
    ? "A triagem"
    : task === "automatic"
      ? "A investigação automática"
      : "A investigação profunda";
}

function assertProviderSupportsTask(
  taskKind: AiTaskKind,
  providerId: AiProviderId,
): void {
  const capabilities = AI_PROVIDER_CAPABILITIES[providerId];
  const supported = taskKind === "deep"
    ? capabilities.deepInvestigation
    : taskKind === "triage"
      ? capabilities.triage
      : capabilities.automaticAnalysis;
  if (!supported || !capabilities.structuredOutput) {
    throw new AiProviderSettingsError(
      `${taskLabel(taskKind)} não é suportada por esta conexão de IA.`,
    );
  }
}

export function extractCodexModelIds(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ["default"];
  }
  const models = (value as { models?: unknown }).models;
  if (!Array.isArray(models)) return ["default"];
  const ids = models.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const candidate = entry as { slug?: unknown; visibility?: unknown };
    if (candidate.visibility === "hide" || typeof candidate.slug !== "string") {
      return [];
    }
    const slug = candidate.slug.trim();
    return slug ? [slug] : [];
  });
  return ["default", ...new Set(ids)];
}

function modelDiscoveryRequest(
  connection: ConnectionRow,
  apiKey: string | null,
): { url: string; headers: Record<string, string> } {
  const base = connection.base_url ?? {
    openai: "https://api.openai.com/v1",
    anthropic: "https://api.anthropic.com/v1",
    openrouter: "https://openrouter.ai/api/v1",
    ollama: "http://127.0.0.1:11434/api",
    codex: "",
  }[connection.provider_id];
  if (connection.provider_id === "ollama") {
    return { url: `${base}/tags`, headers: { Accept: "application/json" } };
  }
  if (connection.provider_id === "anthropic") {
    return {
      url: `${base}/models`,
      headers: {
        Accept: "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": apiKey ?? "",
      },
    };
  }
  return {
    url: `${base}/models`,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey ?? ""}`,
    },
  };
}

function extractModelIds(provider: AiProviderId, body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  const items = provider === "ollama" ? record.models : record.data;
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const candidate = item as Record<string, unknown>;
      const value = candidate.id ?? candidate.name ?? candidate.model;
      return typeof value === "string" ? value : null;
    })
    .filter((value): value is string => Boolean(value));
}
