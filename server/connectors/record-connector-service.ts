import { randomUUID } from "node:crypto";

import {
  RECORD_CONNECTOR_INPUT_TYPES,
  RECORD_CONNECTOR_METHODS,
  type DirectoryFieldValue,
  type DirectoryRecordDto,
  type ExecuteRecordConnectorInput,
  type ExecuteRecordConnectorResponse,
  type RecordConnectorDto,
  type RecordConnectorExecutionValue,
  type RecordConnectorFieldMappingDto,
  type RecordConnectorInputFieldDto,
  type RecordConnectorSummaryDto,
  type RecordConnectorWriteInput,
} from "../../shared/contracts.js";
import type { SupportDatabase } from "../db/index.js";
import {
  ConflictError,
  DirectoryStore,
  DomainError,
  NotFoundError,
  SupportStore,
  ValidationError,
} from "../domain/index.js";
import { LocalSecretVault } from "../runtime/secret-vault.js";

const MAX_TEMPLATE_LENGTH = 50_000;
const MAX_RESPONSE_LENGTH = 1_000_000;
const EXECUTION_TIMEOUT_MS = 15_000;

type ConnectorRow = {
  id: string;
  name: string;
  description: string | null;
  enabled: number;
  method: RecordConnectorDto["method"];
  url_template: string;
  headers_template: string;
  body_template: string;
  target_record_type_id: string;
  record_name_path: string;
  record_description_path: string | null;
  input_fields_json: string;
  field_mappings_json: string;
  secret_ref: string | null;
  token_last_four: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

type TemplateContext = {
  ticket: Record<string, unknown>;
  input: Record<string, RecordConnectorExecutionValue>;
  token: string;
  response?: unknown;
};

export class RecordConnectorService {
  private readonly directory: DirectoryStore;

  constructor(
    private readonly database: SupportDatabase,
    private readonly support: SupportStore,
    private readonly secrets: LocalSecretVault,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.directory = new DirectoryStore(database);
  }

  list(): RecordConnectorDto[] {
    return this.rows(
      `SELECT * FROM record_connectors
       WHERE archived_at IS NULL
       ORDER BY enabled DESC, name COLLATE NOCASE, id`,
    ).map(connectorDto);
  }

  listEnabled(): RecordConnectorSummaryDto[] {
    return this.rows(
      `SELECT * FROM record_connectors
       WHERE archived_at IS NULL AND enabled = 1
       ORDER BY name COLLATE NOCASE, id`,
    ).map((row) => {
      const connector = connectorDto(row);
      return {
        id: connector.id,
        name: connector.name,
        description: connector.description,
        method: connector.method,
        targetRecordTypeId: connector.targetRecordTypeId,
        inputFields: connector.inputFields,
      };
    });
  }

  async create(
    input: RecordConnectorWriteInput,
    actor: string,
  ): Promise<RecordConnectorDto> {
    const normalized = this.normalizeInput(input);
    const id = randomUUID();
    const secretRef = input.token?.trim() ? `record-connector:${id}` : null;
    if (secretRef) await this.secrets.set(secretRef, input.token!.trim());
    const timestamp = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO record_connectors (
           id, name, description, enabled, method, url_template,
           headers_template, body_template, target_record_type_id,
           record_name_path, record_description_path, input_fields_json,
           field_mappings_json, secret_ref, token_last_four, archived_at,
           created_by, updated_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      )
      .run(
        id,
        normalized.name,
        normalized.description,
        Number(normalized.enabled),
        normalized.method,
        normalized.urlTemplate,
        normalized.headersTemplate,
        normalized.bodyTemplate,
        normalized.targetRecordTypeId,
        normalized.recordNamePath,
        normalized.recordDescriptionPath,
        JSON.stringify(normalized.inputFields),
        JSON.stringify(normalized.fieldMappings),
        secretRef,
        secretLastFour(input.token),
        requiredText(actor, "Responsável", 160),
        requiredText(actor, "Responsável", 160),
        timestamp,
        timestamp,
      );
    return this.get(id);
  }

  async update(
    id: string,
    input: RecordConnectorWriteInput,
    actor: string,
  ): Promise<RecordConnectorDto> {
    const current = this.requireRow(id);
    if (current.archived_at) {
      throw new ConflictError("O conector está arquivado", { id });
    }
    const normalized = this.normalizeInput(input);
    let secretRef = current.secret_ref;
    let tokenLastFour = current.token_last_four;
    if (input.token === null) {
      if (secretRef) await this.secrets.delete(secretRef);
      secretRef = null;
      tokenLastFour = null;
    } else if (input.token?.trim()) {
      secretRef ??= `record-connector:${id}`;
      await this.secrets.set(secretRef, input.token.trim());
      tokenLastFour = secretLastFour(input.token);
    }
    this.database
      .prepare(
        `UPDATE record_connectors
         SET name = ?, description = ?, enabled = ?, method = ?,
             url_template = ?, headers_template = ?, body_template = ?,
             target_record_type_id = ?, record_name_path = ?,
             record_description_path = ?, input_fields_json = ?,
             field_mappings_json = ?, secret_ref = ?, token_last_four = ?,
             updated_by = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        normalized.name,
        normalized.description,
        Number(normalized.enabled),
        normalized.method,
        normalized.urlTemplate,
        normalized.headersTemplate,
        normalized.bodyTemplate,
        normalized.targetRecordTypeId,
        normalized.recordNamePath,
        normalized.recordDescriptionPath,
        JSON.stringify(normalized.inputFields),
        JSON.stringify(normalized.fieldMappings),
        secretRef,
        tokenLastFour,
        requiredText(actor, "Responsável", 160),
        new Date().toISOString(),
        id,
      );
    return this.get(id);
  }

  async archive(id: string, actor: string): Promise<void> {
    const row = this.requireRow(id);
    if (row.archived_at) return;
    const timestamp = new Date().toISOString();
    this.database
      .prepare(
        `UPDATE record_connectors
         SET enabled = 0, archived_at = ?, updated_by = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(timestamp, requiredText(actor, "Responsável", 160), timestamp, id);
  }

  async execute(
    connectorId: string,
    ticketId: string,
    input: ExecuteRecordConnectorInput,
    actor: string,
  ): Promise<ExecuteRecordConnectorResponse> {
    const connector = connectorDto(this.requireRow(connectorId));
    if (connector.archivedAt || !connector.enabled) {
      throw new ConflictError("Este conector não está disponível", {
        connectorId,
      });
    }
    const clientRequestId = requiredText(
      input.clientRequestId,
      "Identificador da solicitação",
      200,
    );
    const values = validateExecutionValues(connector.inputFields, input.values);
    const repeated = this.database
      .prepare(
        `SELECT status, record_id, http_status
         FROM record_connector_executions
         WHERE connector_id = ? AND ticket_id = ? AND client_request_id = ?`,
      )
      .get(connectorId, ticketId, clientRequestId) as
      | {
          status: "running" | "succeeded" | "failed";
          record_id: string | null;
          http_status: number | null;
        }
      | undefined;
    if (repeated?.status === "succeeded" && repeated.record_id) {
      return {
        ticket: this.support.getTicketDetail(ticketId),
        record: this.record(repeated.record_id),
        connectorId,
        httpStatus: repeated.http_status ?? 200,
      };
    }
    if (repeated) {
      throw new ConflictError(
        repeated.status === "running"
          ? "Esta criação ainda está em andamento"
          : "Esta tentativa já falhou; inicie uma nova criação",
      );
    }

    const executionId = randomUUID();
    const responsible = requiredText(actor, "Responsável", 160);
    const startedAt = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO record_connector_executions (
           id, connector_id, ticket_id, client_request_id, status,
           requested_by, started_at
         ) VALUES (?, ?, ?, ?, 'running', ?, ?)`,
      )
      .run(
        executionId,
        connectorId,
        ticketId,
        clientRequestId,
        responsible,
        startedAt,
      );

    let createdRecord: DirectoryRecordDto | null = null;
    try {
      const ticket = this.support.getTicketDetail(ticketId);
      const token = await this.readToken(connectorId);
      const context: TemplateContext = {
        ticket: ticketTemplateData(ticket),
        input: values,
        token,
      };
      const url = renderString(connector.urlTemplate, context);
      assertAllowedUrl(url);
      const headers = renderedHeaders(connector.headersTemplate, context);
      const body = renderJsonTemplate(
        connector.bodyTemplate,
        context,
        "Body",
      );
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), EXECUTION_TIMEOUT_MS);
      let response: Response;
      try {
        response = await this.fetcher(url, {
          method: connector.method,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            ...headers,
          },
          body: JSON.stringify(body),
          redirect: "error",
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) {
        throw new DomainError(
          `A API externa respondeu com status ${response.status}.`,
          "record_connector_failed",
          502,
        );
      }
      const responseText = await response.text();
      if (responseText.length > MAX_RESPONSE_LENGTH) {
        throw new DomainError(
          "A resposta da API externa excedeu o limite permitido.",
          "record_connector_failed",
          502,
        );
      }
      let responseData: unknown;
      try {
        responseData = responseText ? JSON.parse(responseText) : {};
      } catch {
        throw new DomainError(
          "A API externa não devolveu JSON válido.",
          "record_connector_failed",
          502,
        );
      }
      const resultContext: TemplateContext = {
        ...context,
        response: responseData,
      };
      const recordName = pathText(
        resultContext,
        connector.recordNamePath,
        "nome do registro",
        true,
      );
      const recordDescription = connector.recordDescriptionPath
        ? pathText(
            resultContext,
            connector.recordDescriptionPath,
            "descrição do registro",
            false,
          )
        : null;
      const recordValues: Record<string, DirectoryFieldValue> = {};
      for (const mapping of connector.fieldMappings) {
        const value = resolvePath(resultContext, mapping.valuePath);
        if (value !== undefined) {
          recordValues[mapping.fieldId] = value as DirectoryFieldValue;
        }
      }
      createdRecord = this.directory.createRecord(
        {
          typeId: connector.targetRecordTypeId,
          name: recordName,
          slug: `${recordName}-${executionId.slice(0, 8)}`,
          description: recordDescription,
          values: recordValues,
        },
        responsible,
      );
      const explicitRecordIds = this.support.getTicketDetail(ticketId)
        .directoryContext.explicitRecordIds;
      const updatedTicket = this.support.updateTicketDirectoryContext(
        ticketId,
        {
          recordIds: [...new Set([...explicitRecordIds, createdRecord.id])],
        },
        responsible,
      );
      this.database
        .prepare(
          `UPDATE record_connector_executions
           SET status = 'succeeded', http_status = ?, record_id = ?,
               finished_at = ?
           WHERE id = ?`,
        )
        .run(
          response.status,
          createdRecord.id,
          new Date().toISOString(),
          executionId,
        );
      return {
        ticket: updatedTicket,
        record: createdRecord,
        connectorId,
        httpStatus: response.status,
      };
    } catch (error) {
      if (createdRecord) {
        try {
          this.directory.archiveRecord(createdRecord.id, "connector-compensation");
        } catch {
          // A auditoria abaixo preserva o erro mesmo se a compensação local falhar.
        }
      }
      const safeMessage = connectorErrorMessage(error);
      this.database
        .prepare(
          `UPDATE record_connector_executions
           SET status = 'failed', error = ?, finished_at = ?
           WHERE id = ?`,
        )
        .run(safeMessage, new Date().toISOString(), executionId);
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        safeMessage,
        "record_connector_failed",
        502,
      );
    }
  }

  private get(id: string): RecordConnectorDto {
    return connectorDto(this.requireRow(id));
  }

  private requireRow(id: string): ConnectorRow {
    const row = this.database
      .prepare("SELECT * FROM record_connectors WHERE id = ?")
      .get(id) as ConnectorRow | undefined;
    if (!row) throw new NotFoundError("Conector de registros", id);
    return row;
  }

  private rows(sql: string): ConnectorRow[] {
    return this.database.prepare(sql).all() as ConnectorRow[];
  }

  private record(id: string): DirectoryRecordDto {
    const record = this.directory
      .getSnapshot()
      .records.find((candidate) => candidate.id === id);
    if (!record) throw new NotFoundError("Registro do Diretório", id);
    return record;
  }

  private async readToken(id: string): Promise<string> {
    const row = this.requireRow(id);
    if (!row.secret_ref) return "";
    return (await this.secrets.get(row.secret_ref)) ?? "";
  }

  private normalizeInput(
    input: RecordConnectorWriteInput,
  ): RecordConnectorWriteInput & {
    description: string | null;
    enabled: boolean;
    recordDescriptionPath: string | null;
  } {
    if (!RECORD_CONNECTOR_METHODS.includes(input.method)) {
      throw new ValidationError("Método HTTP inválido");
    }
    const urlTemplate = requiredText(
      input.urlTemplate,
      "URL",
      MAX_TEMPLATE_LENGTH,
    );
    assertAllowedUrl(renderString(urlTemplate, emptyTemplateContext()));
    parseJsonTemplate(input.headersTemplate, "Headers");
    parseJsonTemplate(input.bodyTemplate, "Body");
    const snapshot = this.directory.getSnapshot();
    const targetType = snapshot.recordTypes.find(
      (type) => type.id === input.targetRecordTypeId && !type.archivedAt,
    );
    if (!targetType) {
      throw new ValidationError("Selecione um tipo de registro ativo");
    }
    const typeFields = new Set(
      snapshot.fields
        .filter(
          (field) =>
            field.recordTypeId === targetType.id && !field.archivedAt,
        )
        .map((field) => field.id),
    );
    const fieldMappings = validateFieldMappings(
      input.fieldMappings,
      typeFields,
    );
    const inputFields = validateInputFields(input.inputFields);
    return {
      ...input,
      name: requiredText(input.name, "Nome", 120),
      description: optionalText(input.description, 1_000),
      enabled: input.enabled !== false,
      urlTemplate,
      headersTemplate: boundedTemplate(input.headersTemplate, "Headers"),
      bodyTemplate: boundedTemplate(input.bodyTemplate, "Body"),
      targetRecordTypeId: targetType.id,
      recordNamePath: requiredPath(input.recordNamePath, "Caminho do nome"),
      recordDescriptionPath: input.recordDescriptionPath?.trim()
        ? requiredPath(
            input.recordDescriptionPath,
            "Caminho da descrição",
          )
        : null,
      inputFields,
      fieldMappings,
    };
  }
}

function connectorDto(row: ConnectorRow): RecordConnectorDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: Boolean(row.enabled),
    method: row.method,
    urlTemplate: row.url_template,
    headersTemplate: row.headers_template,
    bodyTemplate: row.body_template,
    targetRecordTypeId: row.target_record_type_id,
    recordNamePath: row.record_name_path,
    recordDescriptionPath: row.record_description_path,
    inputFields: parsedArray<RecordConnectorInputFieldDto>(
      row.input_fields_json,
    ),
    fieldMappings: parsedArray<RecordConnectorFieldMappingDto>(
      row.field_mappings_json,
    ),
    hasToken: Boolean(row.secret_ref),
    tokenLastFour: row.token_last_four,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parsedArray<T>(value: string): T[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function requiredText(value: string, field: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized) throw new ValidationError(`${field} é obrigatório`);
  if (normalized.length > maximum) {
    throw new ValidationError(`${field} deve ter no máximo ${maximum} caracteres`);
  }
  return normalized;
}

function optionalText(
  value: string | null | undefined,
  maximum: number,
): string | null {
  const normalized = value?.trim() ?? "";
  if (!normalized) return null;
  if (normalized.length > maximum) {
    throw new ValidationError(`O texto deve ter no máximo ${maximum} caracteres`);
  }
  return normalized;
}

function boundedTemplate(value: string, label: string): string {
  if (value.length > MAX_TEMPLATE_LENGTH) {
    throw new ValidationError(`${label} excede o limite permitido`);
  }
  return value.trim() || "{}";
}

function parseJsonTemplate(value: string, label: string): unknown {
  const normalized = boundedTemplate(value, label);
  try {
    return JSON.parse(normalized);
  } catch {
    throw new ValidationError(`${label} precisa ser um JSON válido`);
  }
}

function validateInputFields(
  fields: RecordConnectorInputFieldDto[],
): RecordConnectorInputFieldDto[] {
  if (fields.length > 30) {
    throw new ValidationError("Um conector pode ter no máximo 30 campos");
  }
  const keys = new Set<string>();
  return fields.map((field) => {
    const key = requiredPath(field.key, "Chave do campo");
    if (key.includes(".")) {
      throw new ValidationError("A chave do campo não pode conter ponto", {
        key,
      });
    }
    if (keys.has(key)) {
      throw new ValidationError("Existem campos com a mesma chave", { key });
    }
    keys.add(key);
    if (!RECORD_CONNECTOR_INPUT_TYPES.includes(field.type)) {
      throw new ValidationError("Tipo de campo inválido", { key });
    }
    return {
      key,
      label: requiredText(field.label, "Rótulo do campo", 120),
      type: field.type,
      required: Boolean(field.required),
      placeholder: optionalText(field.placeholder, 300),
    };
  });
}

function validateFieldMappings(
  mappings: RecordConnectorFieldMappingDto[],
  allowedFieldIds: Set<string>,
): RecordConnectorFieldMappingDto[] {
  const fields = new Set<string>();
  return mappings.map((mapping) => {
    if (!allowedFieldIds.has(mapping.fieldId)) {
      throw new ValidationError(
        "Um mapeamento aponta para um campo de outro tipo de registro",
        { fieldId: mapping.fieldId },
      );
    }
    if (fields.has(mapping.fieldId)) {
      throw new ValidationError("Um campo foi mapeado mais de uma vez", {
        fieldId: mapping.fieldId,
      });
    }
    fields.add(mapping.fieldId);
    return {
      fieldId: mapping.fieldId,
      valuePath: requiredPath(mapping.valuePath, "Caminho do valor"),
    };
  });
}

function requiredPath(value: string, label: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 500 ||
    !/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(normalized)
  ) {
    throw new ValidationError(`${label} é inválido`);
  }
  return normalized;
}

function validateExecutionValues(
  fields: RecordConnectorInputFieldDto[],
  values: Record<string, RecordConnectorExecutionValue>,
): Record<string, RecordConnectorExecutionValue> {
  const fieldByKey = new Map(fields.map((field) => [field.key, field]));
  for (const key of Object.keys(values)) {
    if (!fieldByKey.has(key)) {
      throw new ValidationError("A execução contém um campo desconhecido", {
        key,
      });
    }
  }
  const normalized: Record<string, RecordConnectorExecutionValue> = {};
  for (const field of fields) {
    const value = values[field.key];
    const empty = value === undefined || value === null || value === "";
    if (field.required && empty) {
      throw new ValidationError(`${field.label} é obrigatório`);
    }
    if (empty) {
      normalized[field.key] = null;
      continue;
    }
    if (
      (field.type === "text" && typeof value !== "string") ||
      (field.type === "number" &&
        (typeof value !== "number" || !Number.isFinite(value))) ||
      (field.type === "boolean" && typeof value !== "boolean")
    ) {
      throw new ValidationError(`Valor inválido para ${field.label}`);
    }
    normalized[field.key] = value;
  }
  return normalized;
}

function emptyTemplateContext(): TemplateContext {
  return {
    ticket: {
      id: "ticket",
      number: 0,
      title: "",
      summary: "",
      status: "new",
      priority: "normal",
      client: { id: "", name: "" },
      group: { id: "", subject: "" },
      requester: { id: "", name: "", phone: "" },
    },
    input: {},
    token: "",
  };
}

function ticketTemplateData(
  ticket: ReturnType<SupportStore["getTicketDetail"]>,
): Record<string, unknown> {
  return {
    id: ticket.id,
    number: ticket.number,
    title: ticket.title,
    summary: ticket.summary,
    status: ticket.status,
    priority: ticket.priority,
    client: { id: ticket.client.id, name: ticket.client.name },
    group: { id: ticket.group.id, subject: ticket.group.subject },
    requester: ticket.requester
      ? {
          id: ticket.requester.id,
          name: ticket.requester.displayName,
          phone: ticket.requester.phoneE164,
        }
      : null,
  };
}

function renderJsonTemplate(
  template: string,
  context: TemplateContext,
  label: string,
): unknown {
  return renderValue(parseJsonTemplate(template, label), context);
}

function renderValue(value: unknown, context: TemplateContext): unknown {
  if (typeof value === "string") {
    const exact = /^\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}$/.exec(value);
    if (exact) return resolvePath(context, exact[1]!) ?? null;
    return renderString(value, context);
  }
  if (Array.isArray(value)) {
    return value.map((item) => renderValue(item, context));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        renderValue(nested, context),
      ]),
    );
  }
  return value;
}

function renderString(value: string, context: TemplateContext): string {
  return value.replace(
    /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g,
    (_match, path: string) => {
      const resolved = resolvePath(context, path);
      return resolved === undefined || resolved === null ? "" : String(resolved);
    },
  );
}

function resolvePath(source: unknown, path: string): unknown {
  let current = source;
  for (const part of path.split(".")) {
    if (
      part === "__proto__" ||
      part === "prototype" ||
      part === "constructor" ||
      !current ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function renderedHeaders(
  template: string,
  context: TemplateContext,
): Record<string, string> {
  const rendered = renderJsonTemplate(template, context, "Headers");
  if (!rendered || typeof rendered !== "object" || Array.isArray(rendered)) {
    throw new ValidationError("Headers precisa ser um objeto JSON");
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(rendered)) {
    if (typeof value !== "string") {
      throw new ValidationError(`O header ${key} precisa ser texto`);
    }
    if (/[\r\n]/.test(key) || /[\r\n]/.test(value)) {
      throw new ValidationError("Header HTTP inválido");
    }
    headers[key] = value;
  }
  return headers;
}

function assertAllowedUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError("A URL do conector é inválida");
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new ValidationError(
      "Use HTTPS; HTTP é permitido somente para serviços locais",
    );
  }
}

function pathText(
  context: TemplateContext,
  path: string,
  label: string,
  required: boolean,
): string {
  const value = resolvePath(context, path);
  if (value === undefined || value === null || value === "") {
    if (required) {
      throw new DomainError(
        `A resposta não contém o ${label} configurado.`,
        "record_connector_mapping_failed",
        502,
      );
    }
    return "";
  }
  return typeof value === "string" ? value : String(value);
}

function secretLastFour(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized ? normalized.slice(-4) : null;
}

function connectorErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "A API externa excedeu o tempo limite.";
  }
  if (error instanceof DomainError) return error.message.slice(0, 1_000);
  return "Não foi possível concluir a criação pela API externa.";
}
