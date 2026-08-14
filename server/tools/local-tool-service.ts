import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { z } from "zod";

import type {
  LocalToolConfigMap,
  LocalToolDto,
  LocalToolOperation,
  LocalToolResolvedConfig,
  LocalToolSecretConfigMap,
  LocalToolTestResult,
  LocalToolType,
  LocalToolWriteInput,
} from "../../shared/contracts.js";
import type { SupportDatabase } from "../db/index.js";
import { LocalSecretVault } from "../runtime/secret-vault.js";

export type { LocalToolWriteInput } from "../../shared/contracts.js";

export const LOCAL_TOOL_OPERATION_POLICY = {
  codebase: ["list_files", "search_files", "read_files"],
  knowledge: ["list_files", "search_files", "read_files"],
  debugger_skill: ["read_skill"],
  postgres_readonly: ["describe_schema", "query_readonly"],
  clickhouse_readonly: ["describe_schema", "query_readonly"],
  aws_cloudwatch: ["query_logs", "read_metrics"],
  vercel: ["read_deployments", "read_logs"],
} as const satisfies Record<LocalToolType, readonly LocalToolOperation[]>;

const SECRET_FIELDS = {
  codebase: [],
  knowledge: [],
  debugger_skill: [],
  postgres_readonly: ["password"],
  clickhouse_readonly: ["password"],
  aws_cloudwatch: ["accessKeyId", "secretAccessKey", "sessionToken"],
  vercel: ["token"],
} as const satisfies Record<LocalToolType, readonly string[]>;

export type LocalToolSettingsErrorKind =
  | "invalid"
  | "not_found"
  | "conflict"
  | "unavailable";

export class LocalToolSettingsError extends Error {
  constructor(
    message: string,
    readonly kind: LocalToolSettingsErrorKind = "invalid",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LocalToolSettingsError";
  }
}

interface LocalToolRow {
  id: string;
  type: LocalToolType;
  name: string;
  description: string | null;
  enabled: number;
  deep_enabled: number;
  allowed_operations_json: string;
  config_json: string;
  secret_ref: string | null;
  secret_fields_json: string;
  last_tested_at: string | null;
  last_test_status: "success" | "failed" | null;
  last_test_message: string | null;
  legacy_source_ref: string | null;
  created_at: string;
  updated_at: string;
}

type ToolSecretDocument = Record<string, string>;

type LocalToolUpdateInput = Partial<Omit<LocalToolWriteInput, "type">> & {
  type?: LocalToolType;
};

const absolutePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .refine(isAbsolute, "Informe um caminho absoluto");

const configSchemas = {
  codebase: z.object({ rootPath: absolutePathSchema }).strict(),
  knowledge: z.object({ rootPath: absolutePathSchema }).strict(),
  debugger_skill: z.object({ skillPath: absolutePathSchema }).strict(),
  postgres_readonly: z
    .object({
      host: z.string().trim().min(1).max(255),
      port: z.number().int().min(1).max(65_535).default(5_432),
      database: z.string().trim().min(1).max(255),
      username: z.string().trim().min(1).max(255),
      sslMode: z.enum(["disable", "prefer", "require", "verify-full"]).default("require"),
    })
    .strict(),
  clickhouse_readonly: z
    .object({
      baseUrl: z
        .url()
        .max(2_000)
        .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
          message: "Use uma URL HTTP ou HTTPS",
        }),
      database: z.string().trim().min(1).max(255),
      username: z.string().trim().min(1).max(255),
    })
    .strict(),
  aws_cloudwatch: z
    .object({
      region: z.string().trim().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/),
      authMode: z.enum(["profile", "access_key"]),
      profile: z.string().trim().min(1).max(255).nullable(),
      logGroupPrefixes: z
        .array(z.string().trim().min(1).max(512))
        .min(1, "Informe ao menos um prefixo de log group")
        .max(100),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.authMode === "profile" && !value.profile) {
        context.addIssue({ code: "custom", path: ["profile"], message: "Informe o perfil AWS" });
      }
    }),
  vercel: z
    .object({
      teamId: z.string().trim().min(1).max(255).nullable(),
      projectId: z.string().trim().min(1).max(255).nullable(),
    })
    .strict()
    .superRefine((value, context) => {
      if (!value.projectId) {
        context.addIssue({
          code: "custom",
          path: ["projectId"],
          message: "Informe o projeto Vercel para limitar o escopo",
        });
      }
    }),
} satisfies Record<LocalToolType, z.ZodType>;

/**
 * Persistent registry for explicitly authorized deep-investigation tools.
 *
 * This service stores only non-secret metadata in SQLite. Decrypted values are
 * available exclusively through getSecretConfig(), which must never be exposed
 * by an HTTP response. No method in this class executes a tool operation.
 */
export class LocalToolService {
  constructor(
    private readonly database: SupportDatabase,
    private readonly secrets: LocalSecretVault,
  ) {}

  list(): LocalToolDto[] {
    return this.rows(
      `SELECT * FROM local_tools
       ORDER BY enabled DESC, deep_enabled DESC, name COLLATE NOCASE, id`,
    ).map(toolDto);
  }

  listEnabledForDeep(): LocalToolDto[] {
    return this.rows(
      `SELECT * FROM local_tools
       WHERE enabled = 1 AND deep_enabled = 1
       ORDER BY type, name COLLATE NOCASE, id`,
    ).map(toolDto);
  }

  get(id: string): LocalToolDto {
    return toolDto(this.requireRow(id));
  }

  async getSecretConfig(id: string): Promise<LocalToolResolvedConfig> {
    const row = this.requireRow(id);
    if (!row.enabled || !row.deep_enabled) {
      throw new LocalToolSettingsError(
        "A ferramenta não está ativa para investigação aprofundada.",
        "conflict",
      );
    }
    return this.resolveSecretConfig(row);
  }

  /** Internal-only resolution used by the trusted connection tester. */
  async resolveForTest(id: string): Promise<LocalToolResolvedConfig> {
    return this.resolveSecretConfig(this.requireRow(id));
  }

  async create(
    input: LocalToolWriteInput,
    actor: string,
  ): Promise<LocalToolDto> {
    return (await this.createStored(input, actor, null)).tool;
  }

  async importLegacy(
    input: LocalToolWriteInput,
    actor: string,
    sourceReference: string,
  ): Promise<{ tool: LocalToolDto; created: boolean }> {
    if (input.type !== "codebase" && input.type !== "knowledge") {
      throw new LocalToolSettingsError(
        "Somente pastas de código e conhecimento podem ser recuperadas do ambiente legado.",
      );
    }
    return this.createStored(
      input,
      actor,
      requiredText(sourceReference, "Referência de origem", 500),
    );
  }

  findByLegacySourceRef(sourceReference: string): LocalToolDto | null {
    const row = this.database
      .prepare("SELECT * FROM local_tools WHERE legacy_source_ref = ?")
      .get(sourceReference) as LocalToolRow | undefined;
    return row ? toolDto(row) : null;
  }

  private async createStored(
    input: LocalToolWriteInput,
    actor: string,
    legacySourceRef: string | null,
  ): Promise<{ tool: LocalToolDto; created: boolean }> {
    if (legacySourceRef) {
      const existing = this.findByLegacySourceRef(legacySourceRef);
      if (existing) return { tool: existing, created: false };
    }
    const type = input.type;
    const name = requiredText(input.name, "Nome", 120);
    const description = optionalText(input.description, 1_000);
    const config = parseConfig(type, input.config);
    const allowedOperations = validateOperations(
      type,
      input.allowedOperations ?? [...LOCAL_TOOL_OPERATION_POLICY[type]],
    );
    const enabled = input.enabled !== false;
    const deepEnabled = input.deepEnabled !== false;
    assertUsefulDeepScope(deepEnabled, allowedOperations);
    const secretDocument = mergeSecretPatch(type, {}, input.secrets);
    assertSecretRequirements(type, config, secretDocument);

    const id = randomUUID();
    const secretRef = Object.keys(secretDocument).length > 0 ? `local-tool:${id}` : null;
    if (secretRef) await this.secrets.set(secretRef, JSON.stringify(secretDocument));
    const now = new Date().toISOString();
    try {
      this.database
        .prepare(
          `INSERT INTO local_tools (
             id, type, name, description, enabled, deep_enabled,
             allowed_operations_json, config_json, secret_ref, secret_fields_json,
             legacy_source_ref, created_by, updated_by, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          type,
          name,
          description,
          enabled ? 1 : 0,
          deepEnabled ? 1 : 0,
          JSON.stringify(allowedOperations),
          JSON.stringify(config),
          secretRef,
          JSON.stringify(Object.keys(secretDocument).sort()),
          legacySourceRef,
          requiredText(actor, "Responsável", 200),
          requiredText(actor, "Responsável", 200),
          now,
          now,
        );
    } catch (error) {
      if (secretRef) await this.secrets.delete(secretRef).catch(() => undefined);
      if (legacySourceRef) {
        const existing = this.findByLegacySourceRef(legacySourceRef);
        if (existing) return { tool: existing, created: false };
      }
      throw error;
    }
    return { tool: this.get(id), created: true };
  }

  async update(
    id: string,
    input: LocalToolUpdateInput,
    actor: string,
  ): Promise<LocalToolDto> {
    const current = this.requireRow(id);
    if (input.type && input.type !== current.type) {
      throw new LocalToolSettingsError("O tipo de uma ferramenta existente não pode ser alterado.");
    }
    const currentDto = toolDto(current);
    const name = input.name === undefined
      ? current.name
      : requiredText(input.name, "Nome", 120);
    const description = input.description === undefined
      ? current.description
      : optionalText(input.description, 1_000);
    const config = input.config === undefined
      ? currentDto.config
      : parseConfig(current.type, input.config);
    const allowedOperations = input.allowedOperations === undefined
      ? currentDto.allowedOperations
      : validateOperations(current.type, input.allowedOperations);
    const enabled = input.enabled ?? Boolean(current.enabled);
    const deepEnabled = input.deepEnabled ?? Boolean(current.deep_enabled);
    assertUsefulDeepScope(deepEnabled, allowedOperations);

    const previousSecrets = await this.readSecrets(current);
    const secretDocument = mergeSecretPatch(current.type, previousSecrets, input.secrets);
    assertSecretRequirements(current.type, config, secretDocument);
    const nextSecretRef = Object.keys(secretDocument).length > 0
      ? current.secret_ref ?? `local-tool:${id}`
      : null;
    if (nextSecretRef) await this.secrets.set(nextSecretRef, JSON.stringify(secretDocument));

    try {
      this.database
        .prepare(
          `UPDATE local_tools
           SET name = ?, description = ?, enabled = ?, deep_enabled = ?,
               allowed_operations_json = ?, config_json = ?, secret_ref = ?,
               secret_fields_json = ?, updated_by = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          name,
          description,
          enabled ? 1 : 0,
          deepEnabled ? 1 : 0,
          JSON.stringify(allowedOperations),
          JSON.stringify(config),
          nextSecretRef,
          JSON.stringify(Object.keys(secretDocument).sort()),
          requiredText(actor, "Responsável", 200),
          new Date().toISOString(),
          id,
        );
    } catch (error) {
      await this.restoreSecrets(current.secret_ref, previousSecrets, nextSecretRef);
      throw error;
    }
    if (!nextSecretRef && current.secret_ref) await this.secrets.delete(current.secret_ref);
    return this.get(id);
  }

  async delete(id: string): Promise<void> {
    const current = this.requireRow(id);
    const previousSecret = current.secret_ref
      ? await this.secrets.get(current.secret_ref)
      : null;
    if (current.secret_ref) await this.secrets.delete(current.secret_ref);
    try {
      this.database.prepare("DELETE FROM local_tools WHERE id = ?").run(id);
    } catch (error) {
      if (current.secret_ref && previousSecret) {
        await this.secrets.set(current.secret_ref, previousSecret);
      }
      throw error;
    }
  }

  async test(id: string): Promise<LocalToolTestResult> {
    const row = this.requireRow(id);
    const checkedAt = new Date().toISOString();
    let result: LocalToolTestResult;
    try {
      const resolved = await this.resolveSecretConfig(row);
      assertSecretRequirements(row.type, resolved.config, resolved.secrets);
      result = await testToolConfiguration(resolved, checkedAt);
    } catch (error) {
      result = {
        ok: false,
        message: safeTestError(error),
        checkedAt,
        mode: isFilesystemType(row.type) ? "filesystem" : "configuration",
      };
    }
    this.recordTestResult(id, result);
    return result;
  }

  recordTestResult(id: string, result: LocalToolTestResult): void {
    this.requireRow(id);
    this.database
      .prepare(
        `UPDATE local_tools
         SET last_tested_at = ?, last_test_status = ?, last_test_message = ?
         WHERE id = ?`,
      )
      .run(
        result.checkedAt,
        result.ok ? "success" : "failed",
        result.message.slice(0, 2_000),
        id,
      );
  }

  private rows(sql: string): LocalToolRow[] {
    return this.database.prepare(sql).all() as LocalToolRow[];
  }

  private requireRow(id: string): LocalToolRow {
    const row = this.database
      .prepare("SELECT * FROM local_tools WHERE id = ?")
      .get(id) as LocalToolRow | undefined;
    if (!row) throw new LocalToolSettingsError("Ferramenta não encontrada.", "not_found");
    return row;
  }

  private async readSecrets(row: LocalToolRow): Promise<ToolSecretDocument> {
    if (!row.secret_ref) return {};
    const value = await this.secrets.get(row.secret_ref);
    if (!value) {
      throw new LocalToolSettingsError(
        "A credencial desta ferramenta não está disponível no cofre local.",
        "unavailable",
      );
    }
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      return Object.fromEntries(
        Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );
    } catch {
      throw new LocalToolSettingsError("A credencial local desta ferramenta é inválida.", "unavailable");
    }
  }

  private async resolveSecretConfig(row: LocalToolRow): Promise<LocalToolResolvedConfig> {
    return {
      ...toolDto(row),
      secrets: (await this.readSecrets(row)) as LocalToolSecretConfigMap[LocalToolType],
    };
  }

  private async restoreSecrets(
    previousRef: string | null,
    previousSecrets: ToolSecretDocument,
    nextRef: string | null,
  ): Promise<void> {
    if (previousRef) {
      await this.secrets.set(previousRef, JSON.stringify(previousSecrets));
      return;
    }
    if (nextRef) await this.secrets.delete(nextRef);
  }
}

function parseConfig<T extends LocalToolType>(
  type: T,
  value: unknown,
): LocalToolConfigMap[T] {
  const result = configSchemas[type].safeParse(value);
  if (!result.success) {
    throw new LocalToolSettingsError(
      result.error.issues[0]?.message ?? "Configuração da ferramenta inválida.",
    );
  }
  return result.data as LocalToolConfigMap[T];
}

function validateOperations(
  type: LocalToolType,
  operations: readonly LocalToolOperation[],
): LocalToolOperation[] {
  const policy = new Set<LocalToolOperation>(LOCAL_TOOL_OPERATION_POLICY[type]);
  const unique = [...new Set(operations)];
  const invalid = unique.find((operation) => !policy.has(operation));
  if (invalid) {
    throw new LocalToolSettingsError(
      `A operação ${invalid} não é permitida para ferramentas deste tipo.`,
    );
  }
  return unique;
}

function mergeSecretPatch(
  type: LocalToolType,
  current: ToolSecretDocument,
  patch: LocalToolWriteInput["secrets"] | undefined,
): ToolSecretDocument {
  if (!patch) return { ...current };
  const allowed = new Set<string>(SECRET_FIELDS[type]);
  const next = { ...current };
  for (const [field, value] of Object.entries(patch)) {
    if (!allowed.has(field)) {
      throw new LocalToolSettingsError(`O campo secreto ${field} não pertence a esta ferramenta.`);
    }
    if (value === null) {
      delete next[field];
      continue;
    }
    if (typeof value !== "string" || value.length === 0 || value.length > 20_000) {
      throw new LocalToolSettingsError(`A credencial ${field} é inválida.`);
    }
    next[field] = value;
  }
  return next;
}

function assertSecretRequirements(
  type: LocalToolType,
  config: LocalToolConfigMap[LocalToolType],
  secrets: ToolSecretDocument,
): void {
  if (type === "aws_cloudwatch") {
    const aws = config as LocalToolConfigMap["aws_cloudwatch"];
    if (
      aws.authMode === "access_key" &&
      (!secrets.accessKeyId || !secrets.secretAccessKey)
    ) {
      throw new LocalToolSettingsError("Informe a Access Key ID e a Secret Access Key da AWS.");
    }
  }
  if (type === "vercel" && !secrets.token) {
    throw new LocalToolSettingsError("Informe o token somente leitura da Vercel.");
  }
}

function assertUsefulDeepScope(
  deepEnabled: boolean,
  operations: LocalToolOperation[],
): void {
  if (deepEnabled && operations.length === 0) {
    throw new LocalToolSettingsError(
      "Selecione pelo menos uma operação para habilitar a ferramenta na investigação profunda.",
    );
  }
}

function toolDto(row: LocalToolRow): LocalToolDto {
  const type = row.type;
  return {
    id: row.id,
    type,
    name: row.name,
    description: row.description,
    enabled: Boolean(row.enabled),
    deepEnabled: Boolean(row.deep_enabled),
    allowedOperations: parseStoredOperations(type, row.allowed_operations_json),
    config: parseConfig(type, parseJson(row.config_json, {})),
    secretFields: parseStringArray(row.secret_fields_json),
    lastTestedAt: row.last_tested_at,
    lastTestStatus: row.last_test_status,
    lastTestMessage: row.last_test_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseStoredOperations(
  type: LocalToolType,
  value: string,
): LocalToolOperation[] {
  const parsed = parseStringArray(value) as LocalToolOperation[];
  return validateOperations(type, parsed);
}

function parseStringArray(value: string): string[] {
  const parsed = parseJson(value, []);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

function parseJson(value: string, fallback: unknown): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return fallback;
  }
}

async function testToolConfiguration(
  tool: LocalToolResolvedConfig,
  checkedAt: string,
): Promise<LocalToolTestResult> {
  if (tool.type === "codebase" || tool.type === "knowledge") {
    const config = tool.config as LocalToolConfigMap["codebase"];
    await assertReadablePath(config.rootPath, "directory");
    return {
      ok: true,
      message: "Pasta acessível em modo somente leitura.",
      checkedAt,
      mode: "filesystem",
    };
  }
  if (tool.type === "debugger_skill") {
    const config = tool.config as LocalToolConfigMap["debugger_skill"];
    await assertReadableSkill(config.skillPath);
    return {
      ok: true,
      message: "Skill acessível em modo somente leitura.",
      checkedAt,
      mode: "filesystem",
    };
  }
  return {
    ok: true,
    message: "Formato da configuração validado; use o teste de conexão da interface para consultar o serviço externo.",
    checkedAt,
    mode: "configuration",
  };
}

async function assertReadablePath(
  candidate: string,
  expected: "directory" | "file",
): Promise<void> {
  const resolved = await realpath(candidate);
  const info = await stat(resolved);
  if (expected === "directory" ? !info.isDirectory() : !info.isFile()) {
    throw new Error(expected === "directory" ? "O caminho não é uma pasta." : "O caminho não é um arquivo.");
  }
  await access(resolved, fsConstants.R_OK);
}

async function assertReadableSkill(candidate: string): Promise<void> {
  const resolved = await realpath(candidate);
  const info = await stat(resolved);
  if (info.isDirectory()) {
    await assertReadablePath(join(resolved, "SKILL.md"), "file");
    return;
  }
  await assertReadablePath(resolved, "file");
}

function safeTestError(error: unknown): string {
  if (error instanceof LocalToolSettingsError) return error.message;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return "O caminho configurado não existe.";
  if (code === "EACCES") return "O caminho configurado não possui permissão de leitura.";
  return error instanceof Error && /não é (uma pasta|um arquivo)/.test(error.message)
    ? error.message
    : "Não foi possível validar a ferramenta local.";
}

function isFilesystemType(type: LocalToolType): boolean {
  return type === "codebase" || type === "knowledge" || type === "debugger_skill";
}

function requiredText(value: string, label: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new LocalToolSettingsError(`${label} inválido.`);
  }
  return normalized;
}

function optionalText(value: string | null | undefined, max: number): string | null {
  const normalized = value?.trim() || null;
  if (normalized && normalized.length > max) {
    throw new LocalToolSettingsError("Descrição muito longa.");
  }
  return normalized;
}
