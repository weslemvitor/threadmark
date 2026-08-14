import { spawn } from "node:child_process";
import { opendir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type {
  LocalToolConfigMap,
  LocalToolDto,
  LocalToolOperation,
  LocalToolResolvedConfig,
  LocalToolTestResult,
} from "../../shared/contracts.js";
import type {
  InvestigationToolDescriptor,
  InvestigationToolRequest,
  InvestigationToolResult,
} from "../agent/types.js";
import { LocalToolService } from "./local-tool-service.js";
import {
  runPostgresReadonly,
  type PostgresQueryRequest,
  type PostgresRunner,
} from "./postgres-readonly-runner.js";

export type { PostgresQueryRequest, PostgresRunner };

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TOOL_OUTPUT_BYTES = 80_000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_TOOL_RESULTS_PER_TURN = 5;
const SKIPPED_DIRECTORIES = new Set([
  ".aws",
  ".data",
  ".git",
  ".next",
  ".ssh",
  "auth",
  "certs",
  "credentials",
  "dist",
  "keys",
  "node_modules",
  "session",
  "sessions",
]);
const SENSITIVE_FILE_NAMES = new Set([
  ".npmrc",
  "authorized_keys",
  "credentials",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "known_hosts",
]);
const SENSITIVE_FILE_EXTENSIONS = new Set([
  ".cer",
  ".crt",
  ".der",
  ".jks",
  ".key",
  ".p12",
  ".pem",
  ".pfx",
]);

const relativePathSchema = z
  .string()
  .trim()
  .max(4_096)
  .default(".")
  .refine((value) => !path.isAbsolute(value) && !value.includes("\0"), {
    message: "O caminho deve ser relativo à raiz autorizada.",
  });

const listFilesSchema = z.object({
  path: relativePathSchema.optional(),
  maxDepth: z.number().int().min(0).max(8).default(4),
  maxFiles: z.number().int().min(1).max(500).default(200),
}).strict();

const searchFilesSchema = z.object({
  query: z.string().trim().min(1).max(500),
  path: relativePathSchema.optional(),
  glob: z.string().trim().min(1).max(300).optional(),
  caseSensitive: z.boolean().default(false),
  maxResults: z.number().int().min(1).max(200).default(80),
}).strict();

const readFilesSchema = z.object({
  paths: z.array(relativePathSchema).min(1).max(10),
  startLine: z.number().int().min(1).max(1_000_000).default(1),
  maxLines: z.number().int().min(1).max(1_000).default(250),
}).strict();

const readSkillSchema = z.object({}).strict();

const describeSchemaSchema = z.object({
  schema: z.string().trim().min(1).max(255).optional(),
  table: z.string().trim().min(1).max(255).optional(),
  maxRows: z.number().int().min(1).max(500).default(200),
}).strict();

const readonlyQuerySchema = z.object({
  query: z.string().trim().min(1).max(50_000),
  maxRows: z.number().int().min(1).max(500).default(200),
  timeoutMs: z.number().int().min(1_000).max(30_000).default(15_000),
}).strict();

const queryLogsSchema = z.object({
  logGroup: z.string().trim().min(1).max(512),
  filterPattern: z.string().max(1_024).optional(),
  startTime: z.string().datetime({ offset: true }).optional(),
  endTime: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(200).default(100),
}).strict();

const readMetricsSchema = z.object({
  namespace: z.string().trim().min(1).max(255),
  metricName: z.string().trim().min(1).max(255),
  dimensions: z.array(z.object({
    name: z.string().trim().min(1).max(255),
    value: z.string().trim().min(1).max(1_024),
  }).strict()).max(20).default([]),
  statistic: z.enum(["Average", "Sum", "Minimum", "Maximum", "SampleCount"]).default("Average"),
  periodSeconds: z.number().int().min(60).max(86_400).default(300),
  startTime: z.string().datetime({ offset: true }).optional(),
  endTime: z.string().datetime({ offset: true }).optional(),
}).strict();

const readDeploymentsSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  target: z.enum(["production", "preview"]).optional(),
  state: z.enum(["BUILDING", "ERROR", "INITIALIZING", "QUEUED", "READY", "CANCELED"]).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
}).strict();

const readVercelLogsSchema = z.object({
  deploymentId: z.string().trim().regex(/^[A-Za-z0-9._-]{1,255}$/),
}).strict();

const OPERATION_HELP: Record<LocalToolOperation, {
  description: string;
  argumentsExample: string;
}> = {
  list_files: {
    description: "Lista caminhos dentro da raiz autorizada, com profundidade e quantidade limitadas.",
    argumentsExample: '{"path":"server","maxDepth":3,"maxFiles":200}',
  },
  search_files: {
    description: "Busca texto nos arquivos da raiz autorizada sem executar o conteúdo encontrado.",
    argumentsExample: '{"query":"nomeDaMetrica","path":"server","glob":"*.ts","caseSensitive":false,"maxResults":80}',
  },
  read_files: {
    description: "Lê trechos limitados de até dez arquivos dentro da raiz autorizada.",
    argumentsExample: '{"paths":["server/modulo.ts"],"startLine":1,"maxLines":250}',
  },
  read_skill: {
    description: "Lê a skill de investigação configurada como metodologia, sem executar comandos dela.",
    argumentsExample: "{}",
  },
  describe_schema: {
    description: "Lista tabelas e colunas do banco configurado, em modo somente leitura.",
    argumentsExample: '{"schema":"public","table":"orders","maxRows":200}',
  },
  query_readonly: {
    description: "Executa um único SELECT/WITH limitado, com transação readonly e timeout.",
    argumentsExample: '{"query":"SELECT id, status FROM orders WHERE id = 42","maxRows":200,"timeoutMs":15000}',
  },
  query_logs: {
    description: "Filtra eventos do CloudWatch em um log group autorizado e numa janela temporal limitada.",
    argumentsExample: '{"logGroup":"/aws/lambda/api","filterPattern":"ERROR","startTime":"2026-07-18T12:00:00Z","endTime":"2026-07-18T13:00:00Z","limit":100}',
  },
  read_metrics: {
    description: "Lê uma série de métrica CloudWatch em janela máxima de sete dias.",
    argumentsExample: '{"namespace":"AWS/Lambda","metricName":"Errors","dimensions":[{"name":"FunctionName","value":"api"}],"statistic":"Sum","periodSeconds":300}',
  },
  read_deployments: {
    description: "Lista deployments do projeto Vercel configurado.",
    argumentsExample: '{"limit":20,"target":"production","state":"READY"}',
  },
  read_logs: {
    description: "Lê o stream de runtime logs de um deployment do projeto Vercel configurado.",
    argumentsExample: '{"deploymentId":"dpl_example"}',
  },
};

export interface DeepToolExecutorOptions {
  timeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
  commandRunner?: CommandRunner;
  postgresRunner?: PostgresRunner;
  now?: () => Date;
}

export interface CommandRequest {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export type CommandRunner = (request: CommandRequest) => Promise<string>;

interface ExecutionPayload {
  summary: string;
  content: string;
  reference: string | null;
}

/**
 * Trusted broker between an isolated model and explicitly configured local tools.
 * The model can only request typed operations; credentials never cross this boundary.
 */
export class DeepToolExecutor {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly commandRunner: CommandRunner;
  private readonly postgresRunner: PostgresRunner;
  private readonly now: () => Date;

  constructor(
    private readonly tools: LocalToolService,
    options: DeepToolExecutorOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.commandRunner = options.commandRunner ?? runCommand;
    this.postgresRunner = options.postgresRunner ?? runPostgresReadonly;
    this.now = options.now ?? (() => new Date());
  }

  descriptors(): InvestigationToolDescriptor[] {
    return this.tools.listEnabledForDeep().map((tool) => ({
      id: tool.id,
      name: tool.name,
      type: tool.type,
      description: tool.description,
      scope: describeScope(tool),
      operations: tool.allowedOperations.map((operation) => ({
        name: operation,
        ...OPERATION_HELP[operation],
      })),
    }));
  }

  async executeMany(
    requests: InvestigationToolRequest[],
    signal?: AbortSignal,
  ): Promise<InvestigationToolResult[]> {
    if (requests.length > MAX_TOOL_RESULTS_PER_TURN) {
      throw new Error(`Cada turno permite no máximo ${MAX_TOOL_RESULTS_PER_TURN} ferramentas.`);
    }
    const results: InvestigationToolResult[] = [];
    for (const request of requests) {
      signal?.throwIfAborted();
      results.push(await this.execute(request, signal));
    }
    return results;
  }

  async execute(
    request: InvestigationToolRequest,
    signal?: AbortSignal,
  ): Promise<InvestigationToolResult> {
    signal?.throwIfAborted();
    const executedAt = this.now().toISOString();
    const registered = this.tools
      .listEnabledForDeep()
      .find((tool) => tool.id === request.toolId);
    if (!registered) {
      return failedResult(request, "Ferramenta indisponível ou não autorizada.", executedAt);
    }
    if (!registered.allowedOperations.includes(request.operation as LocalToolOperation)) {
      return failedResult(request, "Operação não autorizada para esta ferramenta.", executedAt, registered.name);
    }

    let argumentsValue: unknown;
    try {
      argumentsValue = JSON.parse(request.argumentsJson) as unknown;
    } catch {
      return failedResult(request, "argumentsJson não contém um objeto JSON válido.", executedAt, registered.name);
    }

    try {
      const resolved = await this.tools.getSecretConfig(registered.id);
      if (!resolved.allowedOperations.includes(request.operation as LocalToolOperation)) {
        return failedResult(
          request,
          "Operação removida da autorização antes da execução.",
          executedAt,
          registered.name,
        );
      }
      const payload = await this.dispatch(
        resolved,
        request.operation as LocalToolOperation,
        argumentsValue,
        signal,
      );
      return {
        requestId: request.requestId,
        toolId: registered.id,
        toolName: registered.name,
        operation: request.operation,
        argumentsJson: request.argumentsJson,
        purpose: request.purpose,
        status: "success",
        summary: payload.summary,
        content: truncateUtf8(payload.content, MAX_TOOL_OUTPUT_BYTES),
        reference: payload.reference
          ? `${payload.reference}:request:${encodeURIComponent(request.requestId)}`
          : null,
        executedAt,
      };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      return failedResult(
        request,
        safeExecutionError(error),
        executedAt,
        registered.name,
      );
    }
  }

  /** Performs one bounded, readonly connection probe without exposing credentials. */
  async test(toolId: string, signal?: AbortSignal): Promise<LocalToolTestResult> {
    const checkedAt = this.now().toISOString();
    let mode: LocalToolTestResult["mode"] = "connection";
    let result: LocalToolTestResult;
    try {
      signal?.throwIfAborted();
      const tool = await this.tools.resolveForTest(toolId);
      mode = isFilesystemTool(tool) ? "filesystem" : "connection";
      await this.testResolvedTool(tool, signal);
      result = {
        ok: true,
        message: testSuccessMessage(tool.type),
        checkedAt,
        mode,
      };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      result = {
        ok: false,
        message: safeExecutionError(error),
        checkedAt,
        mode,
      };
    }
    this.tools.recordTestResult(toolId, result);
    return result;
  }

  private async testResolvedTool(
    tool: LocalToolResolvedConfig,
    signal?: AbortSignal,
  ): Promise<void> {
    if (tool.type === "codebase" || tool.type === "knowledge") {
      const root = (tool.config as LocalToolConfigMap["codebase"]).rootPath;
      await listFiles(root, { path: ".", maxDepth: 0, maxFiles: 1 }, tool.id, signal);
      return;
    }
    if (tool.type === "debugger_skill") {
      const configured = (tool.config as LocalToolConfigMap["debugger_skill"]).skillPath;
      await readSkill(configured, tool.id, signal);
      return;
    }
    if (tool.type === "postgres_readonly") {
      await this.runPostgres(tool, "SELECT 1 AS ok", this.timeoutMs, signal);
      return;
    }
    if (tool.type === "clickhouse_readonly") {
      await this.fetchClickhouse(tool, "SELECT 1 AS ok FORMAT JSONEachRow", {}, this.timeoutMs, signal);
      return;
    }
    if (tool.type === "aws_cloudwatch") {
      const config = tool.config as LocalToolConfigMap["aws_cloudwatch"];
      await this.commandRunner({
        command: "aws",
        args: [
          "logs",
          "describe-log-groups",
          "--region",
          config.region,
          "--log-group-name-prefix",
          config.logGroupPrefixes[0]!,
          "--max-items",
          "1",
          "--no-paginate",
          "--output",
          "json",
          "--no-cli-pager",
        ],
        env: awsEnvironment(tool),
        timeoutMs: this.timeoutMs,
        maxOutputBytes: MAX_TOOL_OUTPUT_BYTES,
        signal,
      });
      return;
    }
    if (tool.type === "vercel") {
      await this.readVercelDeployments(tool, { limit: 1 }, signal);
      return;
    }
    throw new Error("Tipo de ferramenta não suportado pelo teste de conexão.");
  }

  private async dispatch(
    tool: LocalToolResolvedConfig,
    operation: LocalToolOperation,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<ExecutionPayload> {
    if (tool.type === "codebase" || tool.type === "knowledge") {
      const root = (tool.config as LocalToolConfigMap["codebase"]).rootPath;
      if (operation === "list_files") return listFiles(root, listFilesSchema.parse(args), tool.id, signal);
      if (operation === "search_files") {
        return searchFiles(root, searchFilesSchema.parse(args), tool.id, this.commandRunner, this.timeoutMs, signal);
      }
      if (operation === "read_files") return readFiles(root, readFilesSchema.parse(args), tool.id, signal);
    }

    if (tool.type === "debugger_skill" && operation === "read_skill") {
      readSkillSchema.parse(args);
      const configured = (tool.config as LocalToolConfigMap["debugger_skill"]).skillPath;
      return readSkill(configured, tool.id, signal);
    }

    if (tool.type === "postgres_readonly") {
      if (operation === "describe_schema") {
        return this.describePostgres(tool, describeSchemaSchema.parse(args), signal);
      }
      if (operation === "query_readonly") {
        return this.queryPostgres(tool, readonlyQuerySchema.parse(args), signal);
      }
    }

    if (tool.type === "clickhouse_readonly") {
      if (operation === "describe_schema") {
        return this.describeClickhouse(tool, describeSchemaSchema.parse(args), signal);
      }
      if (operation === "query_readonly") {
        return this.queryClickhouse(tool, readonlyQuerySchema.parse(args), signal);
      }
    }

    if (tool.type === "aws_cloudwatch") {
      if (operation === "query_logs") {
        return this.queryCloudwatchLogs(tool, queryLogsSchema.parse(args), signal);
      }
      if (operation === "read_metrics") {
        return this.readCloudwatchMetrics(tool, readMetricsSchema.parse(args), signal);
      }
    }

    if (tool.type === "vercel") {
      if (operation === "read_deployments") {
        return this.readVercelDeployments(tool, readDeploymentsSchema.parse(args), signal);
      }
      if (operation === "read_logs") {
        return this.readVercelLogs(tool, readVercelLogsSchema.parse(args), signal);
      }
    }

    throw new Error("A combinação de ferramenta e operação não é suportada.");
  }

  private async describePostgres(
    tool: LocalToolResolvedConfig,
    args: z.infer<typeof describeSchemaSchema>,
    signal?: AbortSignal,
  ): Promise<ExecutionPayload> {
    const filters = ["table_schema NOT IN ('pg_catalog', 'information_schema')"];
    if (args.schema) filters.push(`table_schema = ${postgresLiteral(args.schema)}`);
    if (args.table) filters.push(`table_name = ${postgresLiteral(args.table)}`);
    const query = `SELECT table_schema, table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE ${filters.join(" AND ")}
ORDER BY table_schema, table_name, ordinal_position
LIMIT ${args.maxRows}`;
    const content = await this.runPostgres(tool, query, this.timeoutMs, signal);
    return {
      summary: "Esquema PostgreSQL lido em modo somente leitura.",
      content,
      reference: `tool:${tool.id}:postgres-schema`,
    };
  }

  private async queryPostgres(
    tool: LocalToolResolvedConfig,
    args: z.infer<typeof readonlyQuerySchema>,
    signal?: AbortSignal,
  ): Promise<ExecutionPayload> {
    const query = assertReadonlySql(args.query, "PostgreSQL");
    const wrapped = `SELECT * FROM (${query}) AS threadmark_readonly_query LIMIT ${args.maxRows}`;
    const content = await this.runPostgres(
      tool,
      wrapped,
      Math.min(args.timeoutMs + 5_000, 35_000),
      signal,
      args.timeoutMs,
      Math.min(args.timeoutMs, 5_000),
    );
    return {
      summary: `Consulta PostgreSQL readonly concluída (máximo ${args.maxRows} linhas).`,
      content,
      reference: `tool:${tool.id}:postgres-query`,
    };
  }

  private async runPostgres(
    tool: LocalToolResolvedConfig,
    query: string,
    timeoutMs: number,
    signal?: AbortSignal,
    statementTimeoutMs?: number,
    lockTimeoutMs?: number,
  ): Promise<string> {
    const config = tool.config as LocalToolConfigMap["postgres_readonly"];
    const secrets = tool.secrets as { password?: string };
    try {
      return await this.postgresRunner({
        config,
        password: secrets.password,
        query,
        timeoutMs,
        statementTimeoutMs,
        lockTimeoutMs,
        maxOutputBytes: MAX_TOOL_OUTPUT_BYTES,
        signal,
      });
    } catch (error) {
      throw redactKnownSecretError(error, secrets.password);
    }
  }

  private async describeClickhouse(
    tool: LocalToolResolvedConfig,
    args: z.infer<typeof describeSchemaSchema>,
    signal?: AbortSignal,
  ): Promise<ExecutionPayload> {
    const config = tool.config as LocalToolConfigMap["clickhouse_readonly"];
    const filters = ["database = {database:String}"];
    if (args.table) filters.push("table = {table:String}");
    const query = `SELECT database, table, name, type
FROM system.columns
WHERE ${filters.join(" AND ")}
ORDER BY database, table, position
LIMIT ${args.maxRows}
FORMAT JSONEachRow`;
    const content = await this.fetchClickhouse(tool, query, {
      database: args.schema ?? config.database,
      ...(args.table ? { table: args.table } : {}),
    }, this.timeoutMs, signal);
    return {
      summary: "Esquema ClickHouse lido em modo somente leitura.",
      content,
      reference: `tool:${tool.id}:clickhouse-schema`,
    };
  }

  private async queryClickhouse(
    tool: LocalToolResolvedConfig,
    args: z.infer<typeof readonlyQuerySchema>,
    signal?: AbortSignal,
  ): Promise<ExecutionPayload> {
    const query = assertReadonlySql(args.query, "ClickHouse");
    const wrapped = `SELECT * FROM (${query}) LIMIT ${args.maxRows} FORMAT JSONEachRow`;
    const content = await this.fetchClickhouse(tool, wrapped, {}, args.timeoutMs, signal);
    return {
      summary: `Consulta ClickHouse readonly concluída (máximo ${args.maxRows} linhas).`,
      content,
      reference: `tool:${tool.id}:clickhouse-query`,
    };
  }

  private async fetchClickhouse(
    tool: LocalToolResolvedConfig,
    query: string,
    parameters: Record<string, string>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const config = tool.config as LocalToolConfigMap["clickhouse_readonly"];
    const secrets = tool.secrets as { password?: string };
    const url = new URL(config.baseUrl);
    url.searchParams.set("database", config.database);
    url.searchParams.set("readonly", "2");
    url.searchParams.set("max_execution_time", String(Math.ceil(timeoutMs / 1_000)));
    url.searchParams.set("max_result_rows", "500");
    url.searchParams.set("result_overflow_mode", "break");
    for (const [name, value] of Object.entries(parameters)) {
      url.searchParams.set(`param_${name}`, value);
    }
    const headers: Record<string, string> = {
      "content-type": "text/plain; charset=utf-8",
      "x-clickhouse-user": config.username,
    };
    if (secrets.password) headers["x-clickhouse-key"] = secrets.password;
    return boundedFetchText(this.fetchImpl, url, {
      method: "POST",
      redirect: "error",
      headers,
      body: query,
    }, timeoutMs, signal);
  }

  private async queryCloudwatchLogs(
    tool: LocalToolResolvedConfig,
    args: z.infer<typeof queryLogsSchema>,
    signal?: AbortSignal,
  ): Promise<ExecutionPayload> {
    const config = tool.config as LocalToolConfigMap["aws_cloudwatch"];
    if (!config.logGroupPrefixes.some((prefix) => args.logGroup.startsWith(prefix))) {
      throw new Error("O log group solicitado não pertence aos prefixos autorizados.");
    }
    const range = boundedTimeRange(args.startTime, args.endTime, 24 * 60 * 60 * 1_000, 7 * 24 * 60 * 60 * 1_000, this.now());
    const commandArgs = [
      "logs", "filter-log-events",
      "--region", config.region,
      "--log-group-name", args.logGroup,
      "--start-time", String(range.start.getTime()),
      "--end-time", String(range.end.getTime()),
      "--limit", String(args.limit),
      "--max-items", String(args.limit),
      "--no-paginate",
      "--output", "json",
      "--no-cli-pager",
    ];
    if (args.filterPattern) commandArgs.push("--filter-pattern", args.filterPattern);
    const content = await this.commandRunner({
      command: "aws",
      args: commandArgs,
      env: awsEnvironment(tool),
      timeoutMs: this.timeoutMs,
      maxOutputBytes: MAX_TOOL_OUTPUT_BYTES,
      signal,
    });
    return {
      summary: `CloudWatch Logs consultado em ${args.logGroup} (${args.limit} eventos no máximo).`,
      content,
      reference: `tool:${tool.id}:cloudwatch-logs:${args.logGroup}`,
    };
  }

  private async readCloudwatchMetrics(
    tool: LocalToolResolvedConfig,
    args: z.infer<typeof readMetricsSchema>,
    signal?: AbortSignal,
  ): Promise<ExecutionPayload> {
    const config = tool.config as LocalToolConfigMap["aws_cloudwatch"];
    const range = boundedTimeRange(args.startTime, args.endTime, 60 * 60 * 1_000, 7 * 24 * 60 * 60 * 1_000, this.now());
    const commandArgs = [
      "cloudwatch", "get-metric-statistics",
      "--region", config.region,
      "--namespace", args.namespace,
      "--metric-name", args.metricName,
      "--start-time", range.start.toISOString(),
      "--end-time", range.end.toISOString(),
      "--period", String(args.periodSeconds),
      "--statistics", args.statistic,
      "--no-paginate",
      "--output", "json",
      "--no-cli-pager",
    ];
    if (args.dimensions.length) {
      commandArgs.push("--dimensions", ...args.dimensions.map((item) => `Name=${item.name},Value=${item.value}`));
    }
    const content = await this.commandRunner({
      command: "aws",
      args: commandArgs,
      env: awsEnvironment(tool),
      timeoutMs: this.timeoutMs,
      maxOutputBytes: MAX_TOOL_OUTPUT_BYTES,
      signal,
    });
    return {
      summary: `Métrica ${args.namespace}/${args.metricName} lida no CloudWatch.`,
      content,
      reference: `tool:${tool.id}:cloudwatch-metric:${args.namespace}/${args.metricName}`,
    };
  }

  private async readVercelDeployments(
    tool: LocalToolResolvedConfig,
    args: z.infer<typeof readDeploymentsSchema>,
    signal?: AbortSignal,
  ): Promise<ExecutionPayload> {
    const config = tool.config as LocalToolConfigMap["vercel"];
    if (!config.projectId) throw new Error("Configure um projectId para limitar esta ferramenta Vercel.");
    const url = new URL("https://api.vercel.com/v6/deployments");
    url.searchParams.set("projectId", config.projectId);
    url.searchParams.set("limit", String(args.limit));
    if (config.teamId) url.searchParams.set("teamId", config.teamId);
    if (args.target) url.searchParams.set("target", args.target);
    if (args.state) url.searchParams.set("state", args.state);
    if (args.since) url.searchParams.set("since", String(new Date(args.since).getTime()));
    if (args.until) url.searchParams.set("until", String(new Date(args.until).getTime()));
    const content = await this.fetchVercel(tool, url, signal);
    return {
      summary: `Deployments do projeto Vercel consultados (${args.limit} no máximo).`,
      content,
      reference: `tool:${tool.id}:vercel-deployments:${config.projectId}`,
    };
  }

  private async readVercelLogs(
    tool: LocalToolResolvedConfig,
    args: z.infer<typeof readVercelLogsSchema>,
    signal?: AbortSignal,
  ): Promise<ExecutionPayload> {
    const config = tool.config as LocalToolConfigMap["vercel"];
    if (!config.projectId) throw new Error("Configure um projectId para limitar esta ferramenta Vercel.");
    const url = new URL(
      `https://api.vercel.com/v1/projects/${encodeURIComponent(config.projectId)}/deployments/${encodeURIComponent(args.deploymentId)}/runtime-logs`,
    );
    if (config.teamId) url.searchParams.set("teamId", config.teamId);
    const content = await this.fetchVercel(tool, url, signal);
    return {
      summary: `Runtime logs do deployment ${args.deploymentId} consultados.`,
      content,
      reference: `tool:${tool.id}:vercel-runtime-logs:${args.deploymentId}`,
    };
  }

  private async fetchVercel(
    tool: LocalToolResolvedConfig,
    url: URL,
    signal?: AbortSignal,
  ): Promise<string> {
    const secrets = tool.secrets as { token?: string };
    if (!secrets.token) throw new Error("Token Vercel não configurado.");
    return boundedFetchText(this.fetchImpl, url, {
      method: "GET",
      redirect: "error",
      headers: {
        authorization: `Bearer ${secrets.token}`,
        accept: "application/json, application/x-ndjson, text/plain",
      },
    }, this.timeoutMs, signal);
  }
}

async function listFiles(
  configuredRoot: string,
  args: z.infer<typeof listFilesSchema>,
  toolId: string,
  signal?: AbortSignal,
): Promise<ExecutionPayload> {
  signal?.throwIfAborted();
  const root = await realpath(configuredRoot);
  assertPathIsSafe(root);
  const start = await resolveInsideRoot(root, args.path ?? ".");
  if (!(await stat(start)).isDirectory()) throw new Error("O caminho solicitado não é uma pasta.");
  const files: string[] = [];

  async function walk(directory: string, depth: number): Promise<void> {
    signal?.throwIfAborted();
    if (files.length >= args.maxFiles) return;
    const iterator = await opendir(directory);
    for await (const entry of iterator) {
      signal?.throwIfAborted();
      if (files.length >= args.maxFiles) break;
      const candidate = path.join(directory, entry.name);
      if (isSensitivePath(candidate, entry.isDirectory())) continue;
      let resolved: string;
      try {
        resolved = await realpath(candidate);
        assertInsideRoot(root, resolved);
        assertPathIsSafe(resolved);
      } catch {
        continue;
      }
      const relative = path.relative(root, resolved) || ".";
      if (entry.isDirectory()) {
        files.push(`${relative}/`);
        if (depth < args.maxDepth) await walk(resolved, depth + 1);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  }

  await walk(start, 0);
  return {
    summary: `${files.length} caminho(s) listado(s) dentro da raiz autorizada.`,
    content: files.join("\n") || "Nenhum arquivo encontrado.",
    reference: `tool:${toolId}:files:${path.relative(root, start) || "."}`,
  };
}

async function searchFiles(
  configuredRoot: string,
  args: z.infer<typeof searchFilesSchema>,
  toolId: string,
  commandRunner: CommandRunner,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ExecutionPayload> {
  signal?.throwIfAborted();
  const root = await realpath(configuredRoot);
  assertPathIsSafe(root);
  const target = await resolveInsideRoot(root, args.path ?? ".");
  const commandArgs = [
    "--line-number",
    "--column",
    "--no-heading",
    "--color=never",
    "--max-columns=500",
    "--max-columns-preview",
    "--max-count=20",
  ];
  if (!args.caseSensitive) commandArgs.push("--ignore-case");
  if (args.glob) commandArgs.push("--glob", args.glob);
  commandArgs.push(...sensitiveRgGlobs());
  commandArgs.push("--", args.query, target);
  let content = await commandRunner({
    command: "rg",
    args: commandArgs,
    env: minimalCommandEnvironment(),
    timeoutMs,
    maxOutputBytes: MAX_TOOL_OUTPUT_BYTES,
    signal,
  });
  const lines = content.split("\n").filter(Boolean).slice(0, args.maxResults);
  content = lines.map((line) => line.startsWith(root) ? line.slice(root.length + 1) : line).join("\n");
  return {
    summary: `${lines.length} ocorrência(s) localizada(s) dentro da raiz autorizada.`,
    content: content || "Nenhuma ocorrência encontrada.",
    reference: `tool:${toolId}:search:${args.path ?? "."}`,
  };
}

async function readFiles(
  configuredRoot: string,
  args: z.infer<typeof readFilesSchema>,
  toolId: string,
  signal?: AbortSignal,
): Promise<ExecutionPayload> {
  signal?.throwIfAborted();
  const root = await realpath(configuredRoot);
  assertPathIsSafe(root);
  const chunks: string[] = [];
  const references: string[] = [];
  for (const requested of args.paths) {
    signal?.throwIfAborted();
    const resolved = await resolveInsideRoot(root, requested);
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error(`O caminho ${requested} não é um arquivo.`);
    if (info.size > MAX_FILE_BYTES) throw new Error(`O arquivo ${requested} excede o limite de leitura.`);
    const relative = path.relative(root, resolved);
    const lines = (await readFile(resolved, { encoding: "utf8", signal })).split(/\r?\n/);
    const startIndex = args.startLine - 1;
    const selected = lines.slice(startIndex, startIndex + args.maxLines);
    chunks.push([
      `### ${relative} (linhas ${args.startLine}-${args.startLine + Math.max(0, selected.length - 1)})`,
      ...selected.map((line, index) => `${args.startLine + index}: ${line}`),
    ].join("\n"));
    references.push(relative);
  }
  return {
    summary: `${references.length} arquivo(s) lido(s) dentro da raiz autorizada.`,
    content: chunks.join("\n\n"),
    reference: `tool:${toolId}:read:${references.join(",")}`,
  };
}

async function readSkill(
  configured: string,
  toolId: string,
  signal?: AbortSignal,
): Promise<ExecutionPayload> {
  signal?.throwIfAborted();
  let resolved = await realpath(configured);
  assertPathIsSafe(resolved);
  if ((await stat(resolved)).isDirectory()) resolved = await realpath(path.join(resolved, "SKILL.md"));
  assertPathIsSafe(resolved);
  const info = await stat(resolved);
  if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error("A skill excede o limite de leitura.");
  const content = truncateUtf8(
    await readFile(resolved, { encoding: "utf8", signal }),
    MAX_TOOL_OUTPUT_BYTES,
  );
  return {
    summary: "Metodologia da skill autorizada lida sem executar seus comandos.",
    content,
    reference: `tool:${toolId}:skill`,
  };
}

async function resolveInsideRoot(root: string, relative: string): Promise<string> {
  if (path.isAbsolute(relative) || relative.includes("\0")) {
    throw new Error("Caminho fora da raiz autorizada.");
  }
  const resolved = await realpath(path.resolve(root, relative));
  assertInsideRoot(root, resolved);
  assertPathIsSafe(resolved);
  return resolved;
}

function assertInsideRoot(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Caminho fora da raiz autorizada.");
  }
}

function assertPathIsSafe(candidate: string): void {
  if (isSensitivePath(candidate)) {
    throw new Error("O caminho solicitado contém dados sensíveis e não pode ser lido.");
  }
}

function isSensitivePath(candidate: string, directoryHint = false): boolean {
  const components = path.resolve(candidate).split(path.sep).filter(Boolean);
  if (components.some((component) => SKIPPED_DIRECTORIES.has(component.toLowerCase()))) {
    return true;
  }

  const name = path.basename(candidate).toLowerCase();
  if (directoryHint) return SKIPPED_DIRECTORIES.has(name);
  if (name.startsWith(".env") && name !== ".env.example") return true;
  if (SENSITIVE_FILE_NAMES.has(name)) return true;
  if (SENSITIVE_FILE_EXTENSIONS.has(path.extname(name))) return true;
  const extension = path.extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  return /^(auth|certs?|credentials?|creds|keys?|private[-_]?key|sessions?)$/.test(stem);
}

function sensitiveRgGlobs(): string[] {
  const directories = [...SKIPPED_DIRECTORIES].flatMap((directory) => [
    "--glob",
    `!**/${directory}/**`,
  ]);
  const files = [
    ".npmrc",
    "authorized_keys",
    "credentials",
    "credentials.*",
    "creds",
    "creds.*",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "id_rsa",
    "known_hosts",
    "*.cer",
    "*.crt",
    "*.der",
    "*.jks",
    "*.key",
    "*.p12",
    "*.pem",
    "*.pfx",
    "auth",
    "auth.*",
    "session",
    "session.*",
    "sessions",
    "sessions.*",
  ].flatMap((file) => ["--glob", `!**/${file}`]);
  return [
    ...directories,
    ...files,
    "--glob",
    "!**/.env*",
  ];
}

function assertReadonlySql(value: string, database: string): string {
  const query = value.trim().replace(/;\s*$/, "");
  if (!query || query.includes("\0") || query.length > 50_000) {
    throw new Error(`Consulta ${database} inválida.`);
  }
  const policyText = stripSqlLiteralsAndComments(query);
  if (policyText.includes(";") || !/^\s*(SELECT|WITH)\b/i.test(policyText)) {
    throw new Error(`Somente uma instrução SELECT/WITH é permitida no ${database}.`);
  }
  const forbidden = /\b(ALTER|ANALYZE|ATTACH|CALL|CLUSTER|COMMENT|COPY|CREATE|DELETE|DETACH|DISCARD|DO|DROP|EXECUTE|GRANT|INSERT|KILL|LISTEN|LOAD|LOCK|MERGE|MOVE|NOTIFY|OPTIMIZE|PREPARE|PUBLISH|PURGE|REFRESH|REINDEX|RENAME|REPLACE|RESET|REVOKE|SET|START|STOP|SYSTEM|TRUNCATE|UNLISTEN|UPDATE|VACUUM)\b/i;
  if (forbidden.test(policyText) || /\bFOR\s+(UPDATE|NO\s+KEY\s+UPDATE|SHARE|KEY\s+SHARE)\b/i.test(policyText)) {
    throw new Error(`A consulta contém uma operação não permitida no ${database}.`);
  }
  if (/\bINTO\s+(TEMP|TEMPORARY|UNLOGGED|TABLE)?\b/i.test(policyText)) {
    throw new Error(`SELECT INTO não é permitido no ${database}.`);
  }
  if (database === "PostgreSQL") assertSafePostgresFunctions(policyText);
  if (database === "ClickHouse") assertSafeClickhouseFunctions(policyText);
  return query;
}

const SAFE_POSTGRES_FUNCTIONS = new Set([
  "abs", "age", "array_agg", "array_length", "array_position", "array_remove",
  "array_to_json", "array_to_string", "avg", "bool_and", "bool_or", "btrim",
  "cardinality", "cast", "ceil", "ceiling", "char_length", "chr", "coalesce",
  "concat", "concat_ws", "count", "current_database", "current_schema", "date_part",
  "date_trunc", "dense_rank", "encode", "extract", "first_value", "floor", "format",
  "generate_series", "greatest", "json_agg", "json_array_length", "json_build_array",
  "json_build_object", "json_extract_path", "json_extract_path_text", "json_object",
  "json_object_agg", "json_populate_record", "json_to_record", "json_typeof", "jsonb_agg",
  "jsonb_array_elements", "jsonb_array_elements_text", "jsonb_array_length",
  "jsonb_build_array", "jsonb_build_object", "jsonb_extract_path", "jsonb_extract_path_text",
  "jsonb_object", "jsonb_object_agg", "jsonb_path_exists", "jsonb_path_query",
  "jsonb_path_query_array", "jsonb_path_query_first", "jsonb_populate_record",
  "jsonb_to_record", "jsonb_typeof", "lag", "last_value", "lead", "least", "left",
  "length", "lower", "lpad", "ltrim", "make_date", "make_interval", "make_time",
  "make_timestamp", "make_timestamptz", "max", "md5", "min", "mod", "now", "nth_value",
  "ntile", "nullif", "octet_length", "percent_rank", "percentile_cont", "percentile_disc",
  "position", "power", "rank", "regexp_match", "regexp_matches", "regexp_replace",
  "regexp_split_to_array", "repeat", "replace", "reverse", "right", "round", "row_number",
  "rpad", "rtrim", "sha224", "sha256", "sha384", "sha512", "split_part", "sqrt",
  "string_agg", "strpos", "substring", "sum", "time_bucket", "timezone", "to_char",
  "to_date", "to_json", "to_jsonb", "to_number", "to_timestamp", "translate", "trim",
  "trunc", "unnest", "upper", "width_bucket",
]);

const SQL_PAREN_KEYWORDS = new Set([
  "all", "and", "any", "array", "as", "case", "distinct", "else", "end", "exists",
  "filter", "from", "group", "having", "in", "limit", "not", "nulls", "offset", "on",
  "or", "order", "over", "partition", "select", "then", "union", "values", "when", "where",
  "window", "with", "within",
]);

function assertSafePostgresFunctions(policyText: string): void {
  const dangerous = /\b(?:pg_catalog\s*\.\s*)?(?:pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_log_backend_memory_contexts|dblink(?:_exec)?|lo_import|lo_export)\s*\(/i;
  if (dangerous.test(policyText)) {
    throw new Error("A consulta usa uma função PostgreSQL proibida pela política readonly.");
  }

  const calls = policyText.matchAll(/\b([a-z_][a-z0-9_$]*(?:\s*\.\s*[a-z_][a-z0-9_$]*)*)\s*\(/gi);
  for (const match of calls) {
    const qualified = match[1]!.replace(/\s+/g, "").toLowerCase();
    const name = qualified.split(".").at(-1)!;
    if (SQL_PAREN_KEYWORDS.has(name) || SAFE_POSTGRES_FUNCTIONS.has(name)) continue;
    throw new Error(`A função PostgreSQL ${qualified} não está na lista readonly autorizada.`);
  }
}

function assertSafeClickhouseFunctions(policyText: string): void {
  const externalTableFunctions = /\b(?:azureblobstorage(?:cluster)?|cosn|deltalake|dictionary|executable(?:pool)?|file|filecluster|gcs|hdfs(?:cluster)?|hudi|iceberg|input|jdbc|mongodb|mysql|odbc|oss|postgresql|redis|remote|remotesecure|s3(?:cluster)?|sqlite|url|urlcluster)\s*\(/i;
  if (externalTableFunctions.test(policyText)) {
    throw new Error("A consulta usa uma table function externa proibida no ClickHouse.");
  }
}

function stripSqlLiteralsAndComments(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index]!;
    const next = value[index + 1];
    if (current === "'") {
      const quote = current;
      output += " ";
      index += 1;
      while (index < value.length) {
        if (value[index] === quote) {
          if (value[index + 1] === quote) {
            index += 2;
            continue;
          }
          break;
        }
        if (value[index] === "\\") index += 1;
        index += 1;
      }
      continue;
    }
    if (current === '"' || current === "`") {
      const quote = current;
      output += " ";
      index += 1;
      while (index < value.length) {
        if (value[index] === quote) {
          if (value[index + 1] === quote) {
            output += quote;
            index += 2;
            continue;
          }
          break;
        }
        output += value[index];
        index += 1;
      }
      output += " ";
      continue;
    }
    if (current === "-" && next === "-") {
      while (index < value.length && value[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (current === "/" && next === "*") {
      index += 2;
      while (index < value.length && !(value[index] === "*" && value[index + 1] === "/")) index += 1;
      index += 1;
      output += " ";
      continue;
    }
    if (current === "$" && /^\$[A-Za-z0-9_]*\$/.test(value.slice(index))) {
      throw new Error("Blocos SQL com dollar quoting não são permitidos.");
    }
    output += current;
  }
  return output;
}

function postgresLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function boundedTimeRange(
  startValue: string | undefined,
  endValue: string | undefined,
  defaultDurationMs: number,
  maxDurationMs: number,
  now: Date,
): { start: Date; end: Date } {
  const end = endValue ? new Date(endValue) : now;
  const start = startValue ? new Date(startValue) : new Date(end.getTime() - defaultDurationMs);
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    start >= end ||
    end.getTime() - start.getTime() > maxDurationMs ||
    end.getTime() > now.getTime() + 60_000
  ) {
    throw new Error("A janela temporal solicitada é inválida ou ampla demais.");
  }
  return { start, end };
}

function awsEnvironment(tool: LocalToolResolvedConfig): NodeJS.ProcessEnv {
  const config = tool.config as LocalToolConfigMap["aws_cloudwatch"];
  const secrets = tool.secrets as {
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
  };
  if (config.authMode === "profile") {
    return minimalCommandEnvironment({
      AWS_PROFILE: config.profile ?? "default",
      AWS_REGION: config.region,
      AWS_PAGER: "",
    });
  }
  return minimalCommandEnvironment({
    AWS_ACCESS_KEY_ID: secrets.accessKeyId,
    AWS_SECRET_ACCESS_KEY: secrets.secretAccessKey,
    AWS_SESSION_TOKEN: secrets.sessionToken,
    AWS_REGION: config.region,
    AWS_PAGER: "",
  });
}

function minimalCommandEnvironment(
  extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: process.env.NODE_ENV ?? "production",
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME,
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL,
    ...Object.fromEntries(Object.entries(extra).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
  };
}

async function runCommand(request: CommandRequest): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (request.signal?.aborted) {
      reject(request.signal.reason);
      return;
    }
    const child = spawn(request.command, request.args, {
      env: request.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let total = 0;
    let exceeded = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abortListener);
    };
    const abortListener = () => {
      aborted = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, request.timeoutMs);
    timer.unref();
    request.signal?.addEventListener("abort", abortListener, { once: true });
    if (request.signal?.aborted) abortListener();

    const collect = (target: Buffer[], chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > request.maxOutputBytes) {
        exceeded = true;
        child.kill("SIGKILL");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (aborted) return reject(request.signal?.reason ?? new Error("A operação foi cancelada."));
      if (timedOut) return reject(new Error("A ferramenta excedeu o limite de tempo."));
      if (exceeded) return reject(new Error("A ferramenta excedeu o limite de saída."));
      const errorText = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0 && code !== 1) {
        return reject(new Error(errorText || `A ferramenta encerrou com código ${code}.`));
      }
      // rg uses code 1 for a valid search with no matches.
      if (code === 1 && request.command !== "rg") {
        return reject(new Error(errorText || "A ferramenta não concluiu a leitura."));
      }
      resolve(Buffer.concat(stdout).toString("utf8").trim());
    });
  });
}

async function boundedFetchText(
  fetchImpl: typeof globalThis.fetch,
  url: URL,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const controller = new AbortController();
  if (signal?.aborted) throw signal.reason;
  const abortListener = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abortListener, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    const response = await fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`O serviço externo respondeu com HTTP ${response.status}.`);
    }
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const current = await reader.read();
      if (current.done) break;
      bytes += current.value.byteLength;
      if (bytes > MAX_TOOL_OUTPUT_BYTES) {
        await reader.cancel();
        throw new Error("O serviço externo excedeu o limite de saída.");
      }
      chunks.push(current.value);
    }
    return Buffer.concat(chunks).toString("utf8").trim();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortListener);
  }
}

function describeScope(tool: LocalToolDto): string {
  switch (tool.type) {
    case "codebase":
    case "knowledge":
      return `Raiz local: ${(tool.config as LocalToolConfigMap["codebase"]).rootPath}`;
    case "debugger_skill":
      return "Metodologia local autorizada; comandos nela não são executados automaticamente.";
    case "postgres_readonly": {
      const config = tool.config as LocalToolConfigMap["postgres_readonly"];
      return `PostgreSQL ${config.host}:${config.port}/${config.database}; a credencial deve possuir privilégios somente leitura.`;
    }
    case "clickhouse_readonly": {
      const config = tool.config as LocalToolConfigMap["clickhouse_readonly"];
      return `ClickHouse ${new URL(config.baseUrl).host}/${config.database}; readonly=2 aplicado pelo executor.`;
    }
    case "aws_cloudwatch": {
      const config = tool.config as LocalToolConfigMap["aws_cloudwatch"];
      return `CloudWatch ${config.region}; log groups restritos aos prefixos ${JSON.stringify(config.logGroupPrefixes)}.`;
    }
    case "vercel": {
      const config = tool.config as LocalToolConfigMap["vercel"];
      return `Vercel team=${config.teamId ?? "conta pessoal"}, project=${config.projectId ?? "não limitado"}.`;
    }
  }
}

function isFilesystemTool(tool: LocalToolResolvedConfig): boolean {
  return tool.type === "codebase" || tool.type === "knowledge" || tool.type === "debugger_skill";
}

function testSuccessMessage(type: LocalToolResolvedConfig["type"]): string {
  if (type === "codebase" || type === "knowledge") {
    return "Pasta acessível com as mesmas restrições de leitura da investigação profunda.";
  }
  if (type === "debugger_skill") {
    return "Skill acessível em modo somente leitura, sem executar seus comandos.";
  }
  if (type === "postgres_readonly") return "Conexão PostgreSQL readonly confirmada com SELECT 1.";
  if (type === "clickhouse_readonly") return "Conexão ClickHouse readonly confirmada com SELECT 1.";
  if (type === "aws_cloudwatch") return "Conexão AWS confirmada com uma leitura limitada de log groups.";
  return "Conexão Vercel confirmada com uma leitura limitada de deployments.";
}

function failedResult(
  request: InvestigationToolRequest,
  message: string,
  executedAt: string,
  toolName = "Ferramenta não autorizada",
): InvestigationToolResult {
  return {
    requestId: request.requestId,
    toolId: request.toolId,
    toolName,
    operation: request.operation,
    argumentsJson: request.argumentsJson,
    purpose: request.purpose,
    status: "error",
    summary: message,
    content: message,
    reference: null,
    executedAt,
  };
}

function safeExecutionError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return `Argumentos inválidos: ${error.issues[0]?.message ?? "revise o formato solicitado"}.`;
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return "O executável ou caminho necessário não está disponível nesta máquina.";
  if (code === "EACCES") return "A ferramenta não possui permissão de leitura para o recurso solicitado.";
  const message = error instanceof Error ? error.message : "A ferramenta falhou de forma segura.";
  return truncateUtf8(message.replace(/(password|token|secret|key)\s*[=:]\s*\S+/gi, "$1=[REDACTED]"), 2_000);
}

function redactKnownSecretError(error: unknown, secret?: string): Error {
  const source = error instanceof Error ? error : new Error("A ferramenta falhou de forma segura.");
  const message = secret ? source.message.replaceAll(secret, "[REDACTED]") : source.message;
  const safe = new Error(message);
  const code = (source as NodeJS.ErrnoException).code;
  if (code) (safe as NodeJS.ErrnoException).code = code;
  return safe;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  return `${bytes.subarray(0, maxBytes).toString("utf8")}\n[saída truncada pelo Threadmark]`;
}
