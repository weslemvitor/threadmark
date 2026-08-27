import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
import type { SupportDatabase } from "../db/index.js";
import { SupportStore } from "../domain/index.js";
import {
  ConnectedAppService,
  createCustomHttpExecutor,
  createSlackWebhookExecutor,
  customHttpConfigSchema,
  slackWebhookConfigSchema,
  type IntegrationHostLookup,
  type IntegrationSecretVault,
} from "../integrations/index.js";
import type {
  InvestigationToolDescriptor,
  InvestigationToolRequest,
  InvestigationToolResult,
} from "../agent/types.js";
import { isAffirmativePreviewConfirmation } from "../agent/confirmation-intent.js";
import { LocalToolService } from "./local-tool-service.js";
import {
  THREADMARK_AUTOMATIONS_TOOL_ID,
  ThreadmarkAutomationTool,
} from "./threadmark-automation-tool.js";
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
const THREADMARK_CONTEXT_TOOL_ID = "threadmark-context";
const CONNECTED_APP_TOOL_PREFIX = "connected-app:";
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

const searchSupportContextSchema = z.object({
  query: z.string().trim().min(2).max(300),
  scope: z.enum(["all", "tickets", "conversations", "resolutions"]).default("all"),
  limit: z.number().int().min(1).max(20).default(10),
}).strict();

const listTicketCategoriesSchema = z.object({
  query: z.string().trim().min(1).max(200).optional(),
  facets: z.array(z.enum(["reason", "product", "platform", "symptom", "root_cause", "resolution"]))
    .max(6)
    .optional(),
  limit: z.number().int().min(1).max(200).default(100),
}).strict();

const externalTicketSourceMessageSchema = z.object({
  id: z.string().trim().min(1).max(200),
  author: z.string().trim().min(1).max(200),
  authorRole: z.enum(["customer", "support"]),
  body: z.string().trim().min(1).max(20_000),
  occurredAt: z.string().datetime({ offset: true }).optional(),
}).strict();

const externalTicketSourceSchema = z.object({
  type: z.literal("intercom_conversation"),
  id: z.string().trim().min(1).max(200),
}).strict();

const prepareThreadmarkTicketDraftSchema = z.object({
  operatorMessageId: z.string().trim().min(1).max(200),
  groupId: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(20_000),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  categoryIds: z.array(z.string().trim().min(1).max(200)).max(12).default([]),
  messageIds: z.array(z.string().trim().min(1).max(200)).max(500).default([]),
  sourceMessages: z.array(externalTicketSourceMessageSchema).max(100).default([]),
  externalSource: externalTicketSourceSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.messageIds.length === 0 && value.sourceMessages.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Inclua ao menos uma mensagem de origem no ticket.",
      path: ["messageIds"],
    });
  }
  if (value.sourceMessages.length > 0 && !value.externalSource) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Mensagens externas exigem a identificação da conversa de origem.",
      path: ["externalSource"],
    });
  }
});

const createThreadmarkTicketFromDraftSchema = z.object({
  confirmationMessageId: z.string().trim().min(1).max(200),
  draftId: z.string().trim().min(1).max(200),
}).strict();

const prepareThreadmarkTicketUpdateDraftSchema = z.object({
  operatorMessageId: z.string().trim().min(1).max(200),
  ticketId: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(200).optional(),
  summary: z.string().trim().min(1).max(20_000).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  addCategoryIds: z.array(z.string().trim().min(1).max(200)).max(12).default([]),
  removeCategoryIds: z.array(z.string().trim().min(1).max(200)).max(12).default([]),
  messageIds: z.array(z.string().trim().min(1).max(200)).max(500).default([]),
  sourceMessages: z.array(externalTicketSourceMessageSchema).max(100).default([]),
  externalSource: externalTicketSourceSchema.optional(),
}).strict().superRefine((value, context) => {
  const hasChange =
    value.title !== undefined ||
    value.summary !== undefined ||
    value.priority !== undefined ||
    value.addCategoryIds.length > 0 ||
    value.removeCategoryIds.length > 0 ||
    value.messageIds.length > 0 ||
    value.sourceMessages.length > 0;
  if (!hasChange) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Informe ao menos uma alteração para o ticket.",
    });
  }
  if (value.sourceMessages.length > 0 && !value.externalSource) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Mensagens externas exigem a identificação da conversa de origem.",
      path: ["externalSource"],
    });
  }
});

const applyThreadmarkTicketUpdateDraftSchema = z.object({
  confirmationMessageId: z.string().trim().min(1).max(200),
  draftId: z.string().trim().min(1).max(200),
}).strict();

const searchIntercomConversationsSchema = z.object({
  query: z.string().trim().min(2).max(200),
  limit: z.number().int().min(1).max(20).default(10),
}).strict();

const getIntercomConversationSchema = z.object({
  conversationId: z.string().trim().regex(/^\d{1,30}$/),
}).strict();

const getIntercomCurrentAdminSchema = z.object({}).strict();

const listIntercomCollectionsSchema = z.object({
  limit: z.number().int().min(1).max(150).default(50),
}).strict();

const createIntercomArticleSchema = z.object({
  confirmationMessageId: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(255),
  description: z.string().trim().max(500).default(""),
  body: z.string().trim().min(1).max(100_000),
  authorId: z.string().trim().min(1).max(200),
  collectionId: z.string().trim().min(1).max(200),
}).strict();

const connectedAppRequestSchema = z.object({
  confirmationMessageId: z.string().trim().min(1).max(200),
  payload: z.record(z.string(), z.unknown()),
}).strict();

const connectedAppMessageSchema = z.object({
  confirmationMessageId: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1).max(4_000),
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
  /** Enables the built-in bounded, readonly Threadmark context search. */
  database?: SupportDatabase;
  supportStore?: SupportStore;
  /** Apps are opt-in and remain unavailable unless both registry and vault are provided. */
  connectedApps?: ConnectedAppService;
  integrationVault?: IntegrationSecretVault;
  integrationLookup?: IntegrationHostLookup;
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
  private readonly database: SupportDatabase | null;
  private readonly supportStore: SupportStore | null;
  private readonly connectedApps: ConnectedAppService | null;
  private readonly integrationVault: IntegrationSecretVault | null;
  private readonly integrationLookup?: IntegrationHostLookup;
  private readonly automationTool: ThreadmarkAutomationTool | null;

  constructor(
    private readonly tools: LocalToolService,
    options: DeepToolExecutorOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.commandRunner = options.commandRunner ?? runCommand;
    this.postgresRunner = options.postgresRunner ?? runPostgresReadonly;
    this.now = options.now ?? (() => new Date());
    this.database = options.database ?? null;
    this.supportStore = options.supportStore ?? (this.database ? new SupportStore(this.database) : null);
    this.connectedApps = options.connectedApps ?? null;
    this.integrationVault = options.integrationVault ?? null;
    this.integrationLookup = options.integrationLookup;
    this.automationTool = this.database
      ? new ThreadmarkAutomationTool(this.database, this.connectedApps)
      : null;
  }

  descriptors(): InvestigationToolDescriptor[] {
    const configured = this.tools.listEnabledForDeep().map((tool) => ({
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
    const connected = this.connectedAppDescriptors();
    if (!this.database) return [...configured, ...connected];
    return [
      {
        id: THREADMARK_CONTEXT_TOOL_ID,
        name: "Contexto do Threadmark",
        type: "knowledge" as const,
        description:
          "Pesquisa tickets, resoluções e mensagens armazenados no SQLite local do Threadmark.",
        scope: "SQLite operacional local; consultas prontas, limitadas e somente leitura.",
        operations: [{
          name: "search_support_context",
          description:
            "Busca por número do ticket, título, cliente, grupo, mensagem ou conteúdo da resolução. Tickets encontrados incluem suas categorias atuais.",
          argumentsExample:
            '{"query":"ROAS Global","scope":"all","limit":10}',
        }, {
          name: "list_ticket_categories",
          description:
            "Lista o catálogo real de categorias do SQLite. Consulte antes de criar ou atualizar tickets e use somente IDs cujo significado tenha relação direta com o problema comprovado.",
          argumentsExample:
            '{"query":"Dashboard","facets":["product","symptom"],"limit":50}',
        }, {
          name: "prepare_ticket_draft",
          description:
            "Persiste uma prévia de ticket vinculada a um grupo existente, às mensagens que originaram a demanda e a categorias reais já consultadas. Para conversas locais use messageIds retornados pela busca; uma mensagem interna da equipe pode ser usada quando o operador pedir explicitamente um ticket operacional, mas nunca como gatilho automático. Para Intercom use sourceMessages copiados da leitura autorizada. Não cria o ticket e não exige confirmação.",
          argumentsExample:
            '{"operatorMessageId":"<currentOperatorMessageId>","groupId":"<groupId encontrado>","title":"Título","summary":"Descrição completa","priority":"normal","categoryIds":["<categoryId real>"],"messageIds":[],"sourceMessages":[{"id":"<id real da mensagem>","author":"Cliente","authorRole":"customer","body":"Texto original","occurredAt":"2026-08-24T12:00:00.000Z"}],"externalSource":{"type":"intercom_conversation","id":"123"}}',
        }, {
          name: "create_ticket_from_draft",
          description:
            "Cria no SQLite um ticket a partir de um rascunho já apresentado. Exige confirmação explícita na mensagem atual.",
          argumentsExample:
            '{"confirmationMessageId":"<currentOperatorMessageId>","draftId":"<id do rascunho apresentado>"}',
        }, {
          name: "prepare_ticket_update_draft",
          description:
            "Prepara uma prévia auditável para atualizar título, descrição, prioridade, categorias e anexar mensagens locais ou do Intercom a um ticket existente. Use messageIds retornados pela busca para mensagens locais ou sourceMessages copiados da conversa externa autorizada. Não altera nada antes da confirmação.",
          argumentsExample:
            '{"operatorMessageId":"<currentOperatorMessageId>","ticketId":"<ticketId encontrado>","title":"Título corrigido","addCategoryIds":["<categoryId real>"],"removeCategoryIds":[],"messageIds":["<messageId real>"],"sourceMessages":[],"externalSource":null}',
        }, {
          name: "apply_ticket_update_draft",
          description:
            "Aplica uma atualização de ticket já apresentada. Exige confirmação explícita posterior e rejeita uma prévia desatualizada.",
          argumentsExample:
            '{"confirmationMessageId":"<currentOperatorMessageId>","draftId":"<id do rascunho apresentado>"}',
        }],
      },
      this.automationTool!.descriptor(),
      ...configured,
      ...connected,
    ];
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
    if (request.toolId.startsWith(CONNECTED_APP_TOOL_PREFIX)) {
      return this.executeConnectedApp(request, executedAt, signal);
    }
    if (request.toolId === THREADMARK_CONTEXT_TOOL_ID) {
      return this.executeThreadmarkContext(request, executedAt, signal);
    }
    if (request.toolId === THREADMARK_AUTOMATIONS_TOOL_ID && this.automationTool) {
      signal?.throwIfAborted();
      return this.automationTool.execute(request, executedAt);
    }
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

  private connectedAppDescriptors(): InvestigationToolDescriptor[] {
    if (!this.connectedApps || !this.integrationVault) return [];
    return this.connectedApps.listEnabledForAi().map((app) => {
      const intercom = this.connectedApps?.nativeProvider(app.id) === "intercom";
      if (app.type === "mcp_remote") {
        const operations = app.mcpTools
          .filter((tool) => tool.aiEnabled)
          .map((tool) => ({
            name: tool.name,
            description: `${tool.description}${tool.confirmationRequired ? " Exige pedido explícito na mensagem atual do operador." : ""}`,
            argumentsExample: JSON.stringify({
              ...(tool.confirmationRequired
                ? { confirmationMessageId: "<currentOperatorMessageId>" }
                : {}),
              input: mcpSchemaExample(tool.inputSchema),
            }),
          }));
        return {
          id: `${CONNECTED_APP_TOOL_PREFIX}${app.id}`,
          name: app.name,
          type: "connected_app" as const,
          description: app.description,
          scope: `Servidor MCP autorizado pelo proprietário; destino ${app.endpointPreview ?? "protegido"}. Somente as ferramentas selecionadas nesta conexão estão disponíveis.`,
          operations,
        };
      }
      const mutationOperations = intercom
        ? [{
            name: "create_article",
            description:
              "Cria um artigo em estado de rascunho no Help Center do Intercom. Exige autor e coleção obtidos pelas leituras autorizadas e pedido explícito na mensagem atual.",
            argumentsExample:
              '{"confirmationMessageId":"<currentOperatorMessageId>","title":"Título","description":"Resumo","body":"<p>Conteúdo revisado</p>","authorId":"123","collectionId":"456"}',
          }]
        : app.type === "slack_webhook"
          ? [{
            name: "send_message",
            description:
              "Envia uma mensagem ao Slack configurado. Use somente quando a mensagem atual do operador pedir explicitamente o envio.",
            argumentsExample:
              '{"confirmationMessageId":"<currentOperatorMessageId>","text":"Mensagem a enviar"}',
          }]
        : [{
            name: "execute_request",
            description:
              "Executa a requisição externa configurada com o payload informado. Use somente quando a mensagem atual do operador pedir explicitamente a ação.",
            argumentsExample:
              '{"confirmationMessageId":"<currentOperatorMessageId>","payload":{"title":"Título","body":"<p>Conteúdo</p>","state":"draft"}}',
          }];
      const readonlyOperations = intercom ? [{
        name: "search_conversations",
        description:
          "Busca conversas recentes do Intercom por nome, e-mail, assunto ou termo e devolve somente dados limitados.",
        argumentsExample: '{"query":"Nome do cliente","limit":10}',
      }, {
        name: "get_conversation",
        description:
          "Lê uma conversa específica do Intercom em texto simples, incluindo até 100 partes recentes.",
        argumentsExample: '{"conversationId":"123456789"}',
      }, {
        name: "get_current_admin",
        description:
          "Obtém o administrador associado ao token, incluindo o authorId válido para criar um artigo.",
        argumentsExample: '{}',
      }, {
        name: "list_collections",
        description:
          "Lista as coleções disponíveis no Help Center, incluindo seus IDs para vincular um artigo.",
        argumentsExample: '{"limit":50}',
      }] : [];
      return {
        id: `${CONNECTED_APP_TOOL_PREFIX}${app.id}`,
        name: app.name,
        type: "connected_app" as const,
        description: app.description,
        scope: `${intercom ? "Intercom" : app.type === "slack_webhook" ? "Slack" : "API externa"} autorizado pelo proprietário; destino ${app.endpointPreview ?? "protegido"}. Leituras nativas são limitadas; ações externas exigem pedido explícito na mensagem atual.`,
        operations: [...readonlyOperations, ...mutationOperations],
      };
    });
  }

  private async executeConnectedApp(
    request: InvestigationToolRequest,
    executedAt: string,
    signal?: AbortSignal,
  ): Promise<InvestigationToolResult> {
    const appId = request.toolId.slice(CONNECTED_APP_TOOL_PREFIX.length);
    const app = this.connectedApps?.listEnabledForAi().find((item) => item.id === appId);
    if (!app || !this.connectedApps || !this.integrationVault) {
      return failedResult(request, "App indisponível ou não autorizado para o Threadmark AI.", executedAt);
    }
    if (app.type === "mcp_remote") {
      return this.executeMcpOperation(app.id, app.name, request, executedAt, signal);
    }
    if (this.connectedApps.nativeProvider(app.id) === "intercom") {
      const operations = new Set([
        "search_conversations",
        "get_conversation",
        "get_current_admin",
        "list_collections",
        "create_article",
      ]);
      if (!operations.has(request.operation)) {
        return failedResult(request, "Operação não autorizada para o Intercom.", executedAt, app.name);
      }
      return this.executeIntercomOperation(app.id, app.name, request, executedAt, signal);
    }
    const expectedOperation = app.type === "slack_webhook" ? "send_message" : "execute_request";
    if (request.operation !== expectedOperation) {
      return failedResult(
        request,
        "Operação não autorizada para este app conectado.",
        executedAt,
        app.name,
      );
    }
    try {
      const rawArguments = JSON.parse(request.argumentsJson) as unknown;
      const resolved = await this.connectedApps.resolveForExecution(app.id);
      const context = {
        executionId: request.requestId,
        idempotencyKey: `threadmark-ai:${request.requestId}`,
        automationId: "threadmark-ai",
        nodeId: request.toolId,
        ...(signal ? { signal } : {}),
      };
      const executorOptions = {
        fetchImpl: this.fetchImpl,
        ...(this.integrationLookup ? { lookup: this.integrationLookup } : {}),
      };
      const result = app.type === "slack_webhook"
        ? await createSlackWebhookExecutor(this.integrationVault, executorOptions).execute(
            slackWebhookConfigSchema.parse(resolved.config),
            { text: connectedAppMessageSchema.parse(rawArguments).text },
            context,
          )
        : await createCustomHttpExecutor(this.integrationVault, executorOptions).execute(
            customHttpConfigSchema.parse(resolved.config),
            { variables: { payload: connectedAppRequestSchema.parse(rawArguments).payload } },
            context,
          );
      const content = truncateUtf8(JSON.stringify(result.output, null, 2), MAX_TOOL_OUTPUT_BYTES);
      if (!result.ok) {
        return {
          requestId: request.requestId,
          toolId: request.toolId,
          toolName: app.name,
          operation: request.operation,
          argumentsJson: request.argumentsJson,
          purpose: request.purpose,
          status: "error",
          summary: `${app.name} recusou a ação com status ${result.status}.`,
          content,
          reference: null,
          executedAt,
        };
      }
      return {
        requestId: request.requestId,
        toolId: request.toolId,
        toolName: app.name,
        operation: request.operation,
        argumentsJson: request.argumentsJson,
        purpose: request.purpose,
        status: "success",
        summary: `${app.name} concluiu a ação externa com status ${result.status}.`,
        content,
        reference: `tool:${request.toolId}:${request.operation}:request:${encodeURIComponent(request.requestId)}`,
        executedAt,
      };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      return failedResult(request, safeExecutionError(error), executedAt, app.name);
    }
  }

  private async executeMcpOperation(
    appId: string,
    appName: string,
    request: InvestigationToolRequest,
    executedAt: string,
    signal?: AbortSignal,
  ): Promise<InvestigationToolResult> {
    try {
      if (!this.connectedApps) throw new Error("A conexão MCP não está disponível.");
      const app = this.connectedApps.get(appId);
      const tool = app.mcpTools.find(
        (candidate) => candidate.name === request.operation && candidate.aiEnabled,
      );
      if (!tool) throw new Error("Ferramenta MCP não autorizada para o Threadmark AI.");
      const raw = JSON.parse(request.argumentsJson) as unknown;
      if (!isRecord(raw)) throw new Error("Os argumentos da ferramenta MCP devem ser um objeto.");
      if (tool.confirmationRequired) {
        if (!this.database) throw new Error("O contexto do operador não está disponível.");
        const confirmationMessageId = stringValue(raw.confirmationMessageId);
        if (!confirmationMessageId) {
          throw new Error("A ação MCP exige a mensagem atual do operador como confirmação.");
        }
        const operator = findThreadmarkAiOperator(this.database, confirmationMessageId);
        if (!isExplicitExternalActionRequest(operator.messageBody)) {
          throw new Error("A mensagem atual não pede explicitamente esta ação externa.");
        }
      }
      const input = isRecord(raw.input)
        ? raw.input
        : Object.fromEntries(
            Object.entries(raw).filter(([key]) => key !== "confirmationMessageId"),
          );
      const result = await this.connectedApps.callMcpTool(
        appId,
        tool.name,
        input,
        "ai",
        signal,
      );
      const output = result.structuredContent ?? result.content;
      return {
        requestId: request.requestId,
        toolId: request.toolId,
        toolName: appName,
        operation: request.operation,
        argumentsJson: request.argumentsJson,
        purpose: request.purpose,
        status: "success",
        summary: `${appName} executou “${tool.title}” via MCP.`,
        content: truncateUtf8(JSON.stringify(output, null, 2), MAX_TOOL_OUTPUT_BYTES),
        reference: `tool:${request.toolId}:${request.operation}:request:${encodeURIComponent(request.requestId)}`,
        executedAt,
      };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      return failedResult(request, safeExecutionError(error), executedAt, appName);
    }
  }

  private async executeIntercomOperation(
    appId: string,
    appName: string,
    request: InvestigationToolRequest,
    executedAt: string,
    signal?: AbortSignal,
  ): Promise<InvestigationToolResult> {
    try {
      const rawArguments = JSON.parse(request.argumentsJson) as unknown;
      const connection = await this.resolveIntercomConnection(appId);
      let url: URL;
      let init: RequestInit;
      if (request.operation === "search_conversations") {
        const args = searchIntercomConversationsSchema.parse(rawArguments);
        url = new URL("/conversations/search", connection.origin);
        init = {
          method: "POST",
          headers: connection.headers,
          body: JSON.stringify(buildIntercomSearch(args.query, args.limit)),
        };
      } else if (request.operation === "get_conversation") {
        const args = getIntercomConversationSchema.parse(rawArguments);
        url = new URL(`/conversations/${encodeURIComponent(args.conversationId)}`, connection.origin);
        url.searchParams.set("display_as", "plaintext");
        init = { method: "GET", headers: connection.headers };
      } else if (request.operation === "get_current_admin") {
        getIntercomCurrentAdminSchema.parse(rawArguments);
        url = new URL("/me", connection.origin);
        init = { method: "GET", headers: connection.headers };
      } else if (request.operation === "list_collections") {
        const args = listIntercomCollectionsSchema.parse(rawArguments);
        url = new URL("/help_center/collections", connection.origin);
        url.searchParams.set("per_page", String(args.limit));
        init = { method: "GET", headers: connection.headers };
      } else if (request.operation === "create_article") {
        const args = createIntercomArticleSchema.parse(rawArguments);
        url = new URL("/articles", connection.origin);
        init = {
          method: "POST",
          headers: connection.headers,
          body: JSON.stringify({
            title: args.title,
            description: args.description,
            body: args.body,
            author_id: args.authorId,
            state: "draft",
            parent_id: args.collectionId,
            parent_type: "collection",
          }),
        };
      } else {
        return failedResult(request, "Operação do Intercom não autorizada.", executedAt, appName);
      }
      const responseText = await boundedFetchText(
        this.fetchImpl,
        url,
        init,
        this.timeoutMs,
        signal,
      );
      const parsed = JSON.parse(responseText) as unknown;
      const content = request.operation === "search_conversations"
        ? sanitizeIntercomSearchResult(parsed)
        : request.operation === "get_conversation"
          ? sanitizeIntercomConversation(parsed)
          : request.operation === "get_current_admin"
            ? sanitizeIntercomCurrentAdmin(parsed)
            : request.operation === "list_collections"
              ? sanitizeIntercomCollections(parsed)
              : sanitizeIntercomArticle(parsed);
      const count = request.operation === "search_conversations" || request.operation === "list_collections"
        ? Number(content.totalCount ?? 0)
        : 1;
      return {
        requestId: request.requestId,
        toolId: `${CONNECTED_APP_TOOL_PREFIX}${appId}`,
        toolName: appName,
        operation: request.operation,
        argumentsJson: request.argumentsJson,
        purpose: request.purpose,
        status: "success",
        summary: request.operation === "search_conversations"
          ? `Intercom consultado em modo somente leitura: ${count} conversa(s) encontrada(s).`
          : request.operation === "get_conversation"
            ? "Conversa do Intercom carregada em modo somente leitura."
            : request.operation === "get_current_admin"
              ? "Autor associado ao token do Intercom carregado."
              : request.operation === "list_collections"
                ? `${count} coleção(ões) disponível(is) no Help Center.`
                : "Rascunho criado no Intercom e mantido fora de publicação.",
        content: truncateUtf8(JSON.stringify(content, null, 2), MAX_TOOL_OUTPUT_BYTES),
        reference: `tool:${CONNECTED_APP_TOOL_PREFIX}${appId}:${request.operation}:request:${encodeURIComponent(request.requestId)}`,
        executedAt,
      };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      return failedResult(request, safeExecutionError(error), executedAt, appName);
    }
  }

  private async resolveIntercomConnection(appId: string): Promise<{
    origin: string;
    headers: Headers;
  }> {
    if (!this.connectedApps || !this.integrationVault) {
      throw new Error("A conexão do Intercom não está disponível.");
    }
    if (this.connectedApps.nativeProvider(appId) !== "intercom") {
      throw new Error("Este app não é uma conexão nativa do Intercom.");
    }
    const resolved = await this.connectedApps.resolveForExecution(appId);
    const endpoint = new URL(String(resolved.config.endpoint ?? ""));
    const secretHeaders = Array.isArray(resolved.config.secretHeaders)
      ? resolved.config.secretHeaders as Array<{ name?: unknown; secretRef?: unknown }>
      : [];
    const authorizationHeader = secretHeaders.find(
      (header) => String(header.name).toLowerCase() === "authorization",
    );
    const secretRef = typeof authorizationHeader?.secretRef === "string"
      ? authorizationHeader.secretRef
      : "";
    const authorization = secretRef ? await this.integrationVault.get(secretRef) : null;
    if (!authorization) throw new Error("A credencial do Intercom não está disponível.");
    const headers = new Headers({
      Accept: "application/json",
      Authorization: authorization,
      "Content-Type": "application/json",
      "Intercom-Version": "2.16",
    });
    const publicHeaders = Array.isArray(resolved.config.publicHeaders)
      ? resolved.config.publicHeaders as Array<{ name?: unknown; value?: unknown }>
      : [];
    for (const header of publicHeaders) {
      if (typeof header.name === "string" && typeof header.value === "string") {
        headers.set(header.name, header.value);
      }
    }
    return { origin: endpoint.origin, headers };
  }

  private executeThreadmarkContext(
    request: InvestigationToolRequest,
    executedAt: string,
    signal?: AbortSignal,
  ): InvestigationToolResult {
    if (!this.database) {
      return failedResult(
        request,
        "A busca interna do Threadmark não está disponível neste processo.",
        executedAt,
        "Contexto do Threadmark",
      );
    }
    let rawArguments: unknown;
    try {
      rawArguments = JSON.parse(request.argumentsJson) as unknown;
    } catch {
      return failedResult(
        request,
        "argumentsJson não contém um objeto JSON válido.",
        executedAt,
        "Contexto do Threadmark",
      );
    }

    try {
      signal?.throwIfAborted();
      if (request.operation === "prepare_ticket_draft") {
        return this.prepareThreadmarkTicketDraft(request, rawArguments, executedAt);
      }
      if (request.operation === "create_ticket_from_draft") {
        return this.createThreadmarkTicketFromDraft(request, rawArguments, executedAt);
      }
      if (request.operation === "prepare_ticket_update_draft") {
        return this.prepareThreadmarkTicketUpdateDraft(request, rawArguments, executedAt);
      }
      if (request.operation === "apply_ticket_update_draft") {
        return this.applyThreadmarkTicketUpdateDraft(request, rawArguments, executedAt);
      }
      if (request.operation === "list_ticket_categories") {
        if (!this.supportStore) throw new Error("O catálogo de categorias não está disponível.");
        const args = listTicketCategoriesSchema.parse(rawArguments);
        const facets = new Set(args.facets ?? []);
        const categories = this.supportStore
          .listCategories({ query: args.query, includeEmpty: true })
          .filter((category) => facets.size === 0 || facets.has(category.facet))
          .slice(0, args.limit);
        return {
          requestId: request.requestId,
          toolId: THREADMARK_CONTEXT_TOOL_ID,
          toolName: "Contexto do Threadmark",
          operation: request.operation,
          argumentsJson: request.argumentsJson,
          purpose: request.purpose,
          status: "success",
          summary: `${categories.length} categoria(s) existente(s) encontrada(s).`,
          content: JSON.stringify({ categories }, null, 2),
          reference: `tool:${THREADMARK_CONTEXT_TOOL_ID}:categories:request:${encodeURIComponent(request.requestId)}`,
          executedAt,
        };
      }
      if (request.operation !== "search_support_context") {
        return failedResult(
          request,
          "Operação não autorizada para o contexto do Threadmark.",
          executedAt,
          "Contexto do Threadmark",
        );
      }
      const args = searchSupportContextSchema.parse(rawArguments);
      const result = searchThreadmarkContext(this.database, args);
      signal?.throwIfAborted();
      return {
        requestId: request.requestId,
        toolId: THREADMARK_CONTEXT_TOOL_ID,
        toolName: "Contexto do Threadmark",
        operation: request.operation,
        argumentsJson: request.argumentsJson,
        purpose: request.purpose,
        status: "success",
        summary: `Busca local concluída: ${result.tickets.length} ticket(s) e ${result.messages.length} mensagem(ns).`,
        content: truncateUtf8(JSON.stringify(result, null, 2), MAX_TOOL_OUTPUT_BYTES),
        reference: `tool:${THREADMARK_CONTEXT_TOOL_ID}:search:request:${encodeURIComponent(request.requestId)}`,
        executedAt,
      };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      return failedResult(
        request,
        safeExecutionError(error),
        executedAt,
        "Contexto do Threadmark",
      );
    }
  }

  private prepareThreadmarkTicketDraft(
    request: InvestigationToolRequest,
    rawArguments: unknown,
    executedAt: string,
  ): InvestigationToolResult {
    if (!this.database) {
      return failedResult(request, "O SQLite do Threadmark não está disponível.", executedAt, "Contexto do Threadmark");
    }
    const args = prepareThreadmarkTicketDraftSchema.parse(rawArguments);
    const operator = findThreadmarkAiOperator(this.database, args.operatorMessageId);
    const group = findActiveTicketGroup(this.database, args.groupId);
    const categories = resolveTicketCategories(this.database, args.categoryIds);
    validateAiCategorySelection(categories);
    const categoryIds = categories.map((category) => category.id).sort();
    const localMessages = resolveThreadmarkTicketSourceMessages(
      this.database,
      args.groupId,
      args.messageIds,
    );
    const sourceMessages = normalizeExternalTicketSourceMessages(
      args.sourceMessages,
      executedAt,
    );
    const fingerprint = JSON.stringify({
      operatorMessageId: args.operatorMessageId,
      groupId: args.groupId,
      title: args.title,
      summary: args.summary,
      priority: args.priority,
      categoryIds,
      messageIds: localMessages.messageIds,
      sourceMessages,
      externalSource: args.externalSource ?? null,
    });
    const draftId = `threadmark-ai-draft:${createHash("sha256").update(fingerprint).digest("hex").slice(0, 32)}`;
    this.database
      .prepare(
        `INSERT OR IGNORE INTO threadmark_ai_ticket_drafts (
           id, thread_id, operator_message_id, group_id, title, summary,
           priority, external_source_type, external_source_id, state,
           created_ticket_id, created_by, created_at, updated_at, category_ids_json,
           message_ids_json, source_messages_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        draftId,
        operator.threadId,
        args.operatorMessageId,
        args.groupId,
        args.title,
        args.summary,
        args.priority,
        args.externalSource?.type ?? null,
        args.externalSource?.id ?? null,
        operator.actor,
        executedAt,
        executedAt,
        JSON.stringify(categoryIds),
        JSON.stringify(localMessages.messageIds),
        JSON.stringify(sourceMessages),
      );
    const preview = {
      draftId,
      state: "pending",
      title: args.title,
      summary: args.summary,
      priority: args.priority,
      group: { id: group.id, name: group.subject, clientName: group.clientName },
      categories,
      sourceMessageCount: localMessages.messageIds.length + sourceMessages.length,
      sourceKind: localMessages.firstExternalMessageId
        ? "external"
        : localMessages.messageIds.length > 0
          ? "internal_manual"
          : "external_import",
      messageIds: localMessages.messageIds,
      sourceMessages,
      externalSource: args.externalSource ?? null,
      confirmationRequired:
        "Apresente esta prévia ao operador e aguarde uma nova mensagem confirmando explicitamente a criação.",
    };
    return {
      requestId: request.requestId,
      toolId: THREADMARK_CONTEXT_TOOL_ID,
      toolName: "Contexto do Threadmark",
      operation: request.operation,
      argumentsJson: request.argumentsJson,
      purpose: request.purpose,
      status: "success",
      summary: `Rascunho de ticket preparado para ${group.subject}; nenhum ticket foi criado.`,
      content: JSON.stringify(preview, null, 2),
      reference: `tool:${THREADMARK_CONTEXT_TOOL_ID}:ticket-draft:${encodeURIComponent(draftId)}:request:${encodeURIComponent(request.requestId)}`,
      executedAt,
    };
  }

  private createThreadmarkTicketFromDraft(
    request: InvestigationToolRequest,
    rawArguments: unknown,
    executedAt: string,
  ): InvestigationToolResult {
    if (!this.database || !this.supportStore) {
      return failedResult(request, "O SQLite do Threadmark não está disponível.", executedAt, "Contexto do Threadmark");
    }
    const args = createThreadmarkTicketFromDraftSchema.parse(rawArguments);
    const operator = findThreadmarkAiOperator(this.database, args.confirmationMessageId);
    if (!isExplicitTicketConfirmation(operator.messageBody)) {
      throw new Error("A mensagem atual não confirma explicitamente a criação do ticket.");
    }
    const draft = this.database
      .prepare(
        `SELECT id, thread_id, group_id, title, summary, priority, state,
                created_ticket_id, created_by, created_at,
                external_source_type, external_source_id, category_ids_json,
                message_ids_json, source_messages_json
         FROM threadmark_ai_ticket_drafts WHERE id = ?`,
      )
      .get(args.draftId) as ThreadmarkAiTicketDraftRow | undefined;
    if (!draft || draft.thread_id !== operator.threadId) {
      throw new Error("O rascunho não pertence a esta conversa do Threadmark AI.");
    }
    if (Date.parse(operator.messageCreatedAt) < Date.parse(draft.created_at)) {
      throw new Error("A confirmação precisa ser posterior à prévia do ticket.");
    }
    if (draft.state === "created" && draft.created_ticket_id) {
      const existing = this.supportStore.getTicketDetail(draft.created_ticket_id);
      return successfulCreatedTicketResult(request, existing, draft, executedAt, true);
    }
    findActiveTicketGroup(this.database, draft.group_id);
    const categories = resolveTicketCategories(this.database, parseJsonStringArray(draft.category_ids_json));
    const localMessages = resolveThreadmarkTicketSourceMessages(
      this.database,
      draft.group_id,
      parseJsonStringArray(draft.message_ids_json),
    );
    const sourceMessages = parseExternalTicketSourceMessages(draft.source_messages_json);
    if (localMessages.messageIds.length === 0 && sourceMessages.length === 0) {
      throw new Error("O rascunho não possui mensagens de origem para anexar ao ticket.");
    }
    const ticket = this.database.transaction(() => {
      const created = this.supportStore!.createTicket({
        id: `threadmark-ai-ticket:${draft.id}`,
        groupId: draft.group_id,
        sourceMessageId: localMessages.firstExternalMessageId,
        messageIds: localMessages.messageIds,
        title: draft.title,
        summary: draft.summary,
        status: "triage",
        priority: draft.priority,
        confidence: null,
        needsReview: false,
        categories: categories.map((category) => ({
          categoryId: category.id,
          source: "ai" as const,
          confidence: 1,
        })),
        actor: draft.created_by,
      });
      if (sourceMessages.length > 0 && draft.external_source_type && draft.external_source_id) {
        this.supportStore!.attachExternalSourceMessagesToTicket(created.id, {
          sourceType: draft.external_source_type,
          sourceConversationId: draft.external_source_id,
          messages: sourceMessages,
          createdAt: executedAt,
        });
      }
      this.database!
        .prepare(
          `UPDATE threadmark_ai_ticket_drafts
           SET state = 'created', created_ticket_id = ?, updated_at = ?
           WHERE id = ? AND state = 'pending'`,
        )
        .run(created.id, executedAt, draft.id);
      return created;
    })();
    return successfulCreatedTicketResult(request, ticket, draft, executedAt, false);
  }

  private prepareThreadmarkTicketUpdateDraft(
    request: InvestigationToolRequest,
    rawArguments: unknown,
    executedAt: string,
  ): InvestigationToolResult {
    if (!this.database || !this.supportStore) {
      return failedResult(request, "O SQLite do Threadmark não está disponível.", executedAt, "Contexto do Threadmark");
    }
    const args = prepareThreadmarkTicketUpdateDraftSchema.parse(rawArguments);
    const operator = findThreadmarkAiOperator(this.database, args.operatorMessageId);
    const ticket = this.supportStore.getTicketDetail(args.ticketId);
    const hasRequestedMessages = args.messageIds.length > 0 || args.sourceMessages.length > 0;
    if (hasRequestedMessages && ticket.status === "archived") {
      throw new Error("Não é possível anexar mensagens a um ticket arquivado.");
    }
    const localMessages = resolveThreadmarkTicketMessagesForAttachment(
      this.database,
      ticket.id,
      ticket.group.id,
      args.messageIds,
    );
    const normalizedSourceMessages = normalizeExternalTicketSourceMessages(
      args.sourceMessages,
      executedAt,
    );
    const sourceMessages = args.externalSource
      ? resolveNewExternalTicketSourceMessages(
          this.database,
          ticket.id,
          args.externalSource.type,
          args.externalSource.id,
          normalizedSourceMessages,
        )
      : [];
    const requestedAdds = resolveTicketCategories(this.database, args.addCategoryIds);
    const requestedRemovals = resolveTicketCategories(this.database, args.removeCategoryIds);
    const rawConflicts = requestedAdds
      .map((category) => category.id)
      .filter((categoryId) => requestedRemovals.some((category) => category.id === categoryId));
    if (rawConflicts.length) {
      throw new Error("Uma categoria não pode ser adicionada e removida na mesma prévia.");
    }
    const currentCategoryIds = ticket.categories.map((category) => category.id).sort();
    const currentCategorySet = new Set(currentCategoryIds);
    const addCategories = requestedAdds.filter((category) => !currentCategorySet.has(category.id));
    const removeCategories = requestedRemovals.filter((category) => currentCategorySet.has(category.id));
    const addIds = addCategories.map((category) => category.id).sort();
    const removeIds = removeCategories.map((category) => category.id).sort();
    if (addIds.length || removeIds.length) {
      const removed = new Set(removeIds);
      validateAiCategorySelection([
        ...ticket.categories.filter((category) => !removed.has(category.id)),
        ...addCategories,
      ]);
    }

    const title = args.title !== undefined && args.title !== ticket.title ? args.title : null;
    const summary = args.summary !== undefined && args.summary !== ticket.summary ? args.summary : null;
    const priority = args.priority !== undefined && args.priority !== ticket.priority ? args.priority : null;
    if (
      title === null && summary === null && priority === null &&
      !addIds.length && !removeIds.length &&
      !localMessages.messageIds.length && !sourceMessages.length
    ) {
      throw new Error("A prévia não contém nenhuma alteração em relação ao ticket atual.");
    }
    const fingerprint = JSON.stringify({
      operatorMessageId: args.operatorMessageId,
      ticketId: ticket.id,
      title,
      summary,
      priority,
      addIds,
      removeIds,
      messageIds: localMessages.messageIds,
      sourceMessages,
      externalSource: args.externalSource ?? null,
      baseUpdatedAt: ticket.updatedAt,
      currentCategoryIds,
    });
    const draftId = `threadmark-ai-ticket-update:${createHash("sha256").update(fingerprint).digest("hex").slice(0, 32)}`;
    this.database.prepare(
      `INSERT OR IGNORE INTO threadmark_ai_ticket_update_drafts (
         id, thread_id, operator_message_id, ticket_id, title, summary, priority,
         add_category_ids_json, remove_category_ids_json, base_updated_at,
         base_category_ids_json, state, created_by, created_at, updated_at,
         message_ids_json, source_messages_json, external_source_type, external_source_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      draftId,
      operator.threadId,
      args.operatorMessageId,
      ticket.id,
      title,
      summary,
      priority,
      JSON.stringify(addIds),
      JSON.stringify(removeIds),
      ticket.updatedAt,
      JSON.stringify(currentCategoryIds),
      operator.actor,
      executedAt,
      executedAt,
      JSON.stringify(localMessages.messageIds),
      JSON.stringify(sourceMessages),
      args.externalSource?.type ?? null,
      args.externalSource?.id ?? null,
    );
    const preview = {
      draftId,
      state: "pending",
      ticket: { id: ticket.id, number: ticket.number, title: ticket.title },
      changes: {
        title: title === null ? null : { from: ticket.title, to: title },
        summary: summary === null ? null : { from: ticket.summary, to: summary },
        priority: priority === null ? null : { from: ticket.priority, to: priority },
        addCategories,
        removeCategories,
        messages: {
          local: localMessages.messageIds.length,
          external: sourceMessages.length,
          total: localMessages.messageIds.length + sourceMessages.length,
        },
        externalSource: sourceMessages.length > 0 ? args.externalSource ?? null : null,
      },
      confirmationRequired:
        "Apresente esta prévia ao operador e aguarde uma nova mensagem confirmando explicitamente a atualização.",
    };
    return {
      requestId: request.requestId,
      toolId: THREADMARK_CONTEXT_TOOL_ID,
      toolName: "Contexto do Threadmark",
      operation: request.operation,
      argumentsJson: request.argumentsJson,
      purpose: request.purpose,
      status: "success",
      summary: `Prévia de atualização do ticket #${ticket.number} preparada; nenhuma alteração foi aplicada.`,
      content: JSON.stringify(preview, null, 2),
      reference: `tool:${THREADMARK_CONTEXT_TOOL_ID}:ticket-update-draft:${encodeURIComponent(draftId)}:request:${encodeURIComponent(request.requestId)}`,
      executedAt,
    };
  }

  private applyThreadmarkTicketUpdateDraft(
    request: InvestigationToolRequest,
    rawArguments: unknown,
    executedAt: string,
  ): InvestigationToolResult {
    if (!this.database || !this.supportStore) {
      return failedResult(request, "O SQLite do Threadmark não está disponível.", executedAt, "Contexto do Threadmark");
    }
    const args = applyThreadmarkTicketUpdateDraftSchema.parse(rawArguments);
    const operator = findThreadmarkAiOperator(this.database, args.confirmationMessageId);
    if (!isExplicitTicketUpdateConfirmation(operator.messageBody)) {
      throw new Error("A mensagem atual não confirma explicitamente a atualização do ticket.");
    }
    const draft = this.database.prepare(
      `SELECT id, thread_id, ticket_id, title, summary, priority,
              add_category_ids_json, remove_category_ids_json, base_updated_at,
              base_category_ids_json, state, created_by, created_at,
              message_ids_json, source_messages_json,
              external_source_type, external_source_id
       FROM threadmark_ai_ticket_update_drafts WHERE id = ?`,
    ).get(args.draftId) as ThreadmarkAiTicketUpdateDraftRow | undefined;
    if (!draft || draft.thread_id !== operator.threadId) {
      throw new Error("O rascunho não pertence a esta conversa do Threadmark AI.");
    }
    if (Date.parse(operator.messageCreatedAt) < Date.parse(draft.created_at)) {
      throw new Error("A confirmação precisa ser posterior à prévia da atualização.");
    }
    const current = this.supportStore.getTicketDetail(draft.ticket_id);
    if (draft.state === "applied") {
      return successfulUpdatedTicketResult(request, current, executedAt, true);
    }
    const currentCategoryIds = current.categories.map((category) => category.id).sort();
    if (
      current.updatedAt !== draft.base_updated_at ||
      JSON.stringify(currentCategoryIds) !== JSON.stringify(parseJsonStringArray(draft.base_category_ids_json).sort())
    ) {
      throw new Error("O ticket mudou depois da prévia. Gere uma nova prévia antes de atualizar.");
    }
    const addCategoryIds = parseJsonStringArray(draft.add_category_ids_json);
    const removeCategoryIds = parseJsonStringArray(draft.remove_category_ids_json);
    const messageIds = parseJsonStringArray(draft.message_ids_json);
    const sourceMessages = parseExternalTicketSourceMessages(draft.source_messages_json);
    if ((messageIds.length > 0 || sourceMessages.length > 0) && current.status === "archived") {
      throw new Error("Não é possível anexar mensagens a um ticket arquivado.");
    }
    const localMessages = resolveThreadmarkTicketMessagesForAttachment(
      this.database,
      current.id,
      current.group.id,
      messageIds,
    );
    const externalMessages = draft.external_source_type && draft.external_source_id
      ? resolveNewExternalTicketSourceMessages(
          this.database,
          current.id,
          draft.external_source_type,
          draft.external_source_id,
          sourceMessages,
        )
      : [];
    if (sourceMessages.length > 0 && (!draft.external_source_type || !draft.external_source_id)) {
      throw new Error("O rascunho perdeu a identificação da conversa externa de origem.");
    }
    resolveTicketCategories(this.database, [...addCategoryIds, ...removeCategoryIds]);
    const updated = this.database.transaction(() => {
      let result = current;
      if (draft.title !== null || draft.summary !== null || draft.priority !== null) {
        result = this.supportStore!.updateTicketMetadata(draft.ticket_id, {
          title: draft.title ?? current.title,
          summary: draft.summary ?? current.summary,
          priority: draft.priority ?? current.priority,
          requesterId: current.requesterOverrideId,
        }, draft.created_by);
      }
      if (addCategoryIds.length || removeCategoryIds.length) {
        result = this.supportStore!.updateTicketCategoriesFromAi(
          draft.ticket_id,
          { addCategoryIds, removeCategoryIds },
          draft.created_by,
        );
      }
      if (localMessages.messageIds.length > 0) {
        this.supportStore!.attachConversationMessages(current.group.id, {
          ticketId: current.id,
          messageIds: localMessages.messageIds,
          clientRequestId: draft.id,
          actor: draft.created_by,
          reason: "Mensagens anexadas pelo Threadmark AI após confirmação explícita.",
        });
        result = this.supportStore!.getTicketDetail(current.id);
      }
      if (externalMessages.length > 0 && draft.external_source_type && draft.external_source_id) {
        this.supportStore!.attachExternalSourceMessagesToTicket(current.id, {
          sourceType: draft.external_source_type,
          sourceConversationId: draft.external_source_id,
          messages: externalMessages,
          createdAt: executedAt,
        });
        result = this.supportStore!.getTicketDetail(current.id);
      }
      this.database!.prepare(
        `UPDATE threadmark_ai_ticket_update_drafts
         SET state = 'applied', updated_at = ? WHERE id = ? AND state = 'pending'`,
      ).run(executedAt, draft.id);
      return result;
    })();
    return successfulUpdatedTicketResult(request, updated, executedAt, false);
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
          "--limit",
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

interface ThreadmarkAiTicketDraftRow {
  id: string;
  thread_id: string;
  group_id: string;
  title: string;
  summary: string;
  priority: "low" | "normal" | "high" | "urgent";
  state: "pending" | "created";
  created_ticket_id: string | null;
  created_by: string;
  created_at: string;
  external_source_type: "intercom_conversation" | null;
  external_source_id: string | null;
  category_ids_json: string;
  message_ids_json: string;
  source_messages_json: string;
}

interface ExternalTicketSourceMessage {
  id: string;
  author: string;
  authorRole: "customer" | "support";
  body: string;
  occurredAt: string;
}

interface ThreadmarkAiTicketUpdateDraftRow {
  id: string;
  thread_id: string;
  ticket_id: string;
  title: string | null;
  summary: string | null;
  priority: "low" | "normal" | "high" | "urgent" | null;
  add_category_ids_json: string;
  remove_category_ids_json: string;
  base_updated_at: string;
  base_category_ids_json: string;
  message_ids_json: string;
  source_messages_json: string;
  external_source_type: "intercom_conversation" | null;
  external_source_id: string | null;
  state: "pending" | "applied";
  created_by: string;
  created_at: string;
}

interface ThreadmarkTicketCategory {
  id: string;
  facet: "reason" | "product" | "platform" | "symptom" | "root_cause" | "resolution";
  slug: string;
  label: string;
  color: string | null;
}

function findThreadmarkAiOperator(
  database: SupportDatabase,
  messageId: string,
): {
  threadId: string;
  actor: string;
  messageBody: string;
  messageCreatedAt: string;
} {
  const row = database
    .prepare(
      `SELECT message.thread_id, message.body, message.created_at,
              COALESCE(thread.created_by, 'Operador local') AS actor
       FROM investigation_thread_messages message
       JOIN investigation_threads thread ON thread.id = message.thread_id
       WHERE message.id = ? AND message.role = 'operator'
         AND thread.scope = 'workspace'`,
    )
    .get(messageId) as
    | { thread_id: string; body: string; created_at: string; actor: string }
    | undefined;
  if (!row) throw new Error("A mensagem do operador não pertence ao Threadmark AI.");
  return {
    threadId: row.thread_id,
    actor: row.actor,
    messageBody: row.body,
    messageCreatedAt: row.created_at,
  };
}

function findActiveTicketGroup(
  database: SupportDatabase,
  groupId: string,
): { id: string; subject: string; clientName: string } {
  const row = database
    .prepare(
      `SELECT support_group.id, support_group.subject, client.name AS client_name
       FROM whatsapp_groups support_group
       JOIN clients client ON client.id = support_group.client_id
       WHERE support_group.id = ? AND client.ignored_at IS NULL`,
    )
    .get(groupId) as
    | { id: string; subject: string; client_name: string }
    | undefined;
  if (!row) throw new Error("O grupo escolhido não existe ou foi removido da operação.");
  return { id: row.id, subject: row.subject, clientName: row.client_name };
}

function isExplicitTicketConfirmation(message: string): boolean {
  return isAffirmativePreviewConfirmation(message);
}

function isExplicitTicketUpdateConfirmation(message: string): boolean {
  return isAffirmativePreviewConfirmation(message);
}

function parseJsonStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("A lista persistida é inválida.");
  }
  return [...new Set(parsed)];
}

function resolveThreadmarkTicketSourceMessages(
  database: SupportDatabase,
  groupId: string,
  messageIds: readonly string[],
): { messageIds: string[]; firstExternalMessageId: string | null } {
  const uniqueIds = [...new Set(messageIds.map((id) => id.trim()).filter(Boolean))];
  if (!uniqueIds.length) return { messageIds: [], firstExternalMessageId: null };
  const placeholders = uniqueIds.map(() => "?").join(", ");
  const rows = database.prepare(
    `SELECT message.id, message.group_id, message.occurred_at,
            CASE WHEN staff.participant_id IS NULL THEN 0 ELSE 1 END AS is_staff,
            (SELECT ticket.number
             FROM ticket_messages membership
             JOIN tickets ticket ON ticket.id = membership.ticket_id
             WHERE membership.message_id = message.id
             ORDER BY ticket.number LIMIT 1) AS linked_ticket_number
     FROM messages message
     LEFT JOIN staff_members staff
       ON staff.participant_id = message.sender_id AND staff.active = 1
     WHERE message.id IN (${placeholders})
     ORDER BY message.occurred_at, message.rowid`,
  ).all(...uniqueIds) as Array<{
    id: string;
    group_id: string;
    occurred_at: string;
    is_staff: number;
    linked_ticket_number: number | null;
  }>;
  if (rows.length !== uniqueIds.length) {
    const found = new Set(rows.map((row) => row.id));
    const missing = uniqueIds.find((id) => !found.has(id));
    throw new Error(`A mensagem ${missing ?? "informada"} não existe no Threadmark.`);
  }
  const foreign = rows.find((row) => row.group_id !== groupId);
  if (foreign) {
    throw new Error(`A mensagem ${foreign.id} não pertence ao grupo escolhido.`);
  }
  const linked = rows.find((row) => row.linked_ticket_number !== null);
  if (linked) {
    throw new Error(
      `A mensagem ${linked.id} já está vinculada ao ticket #${linked.linked_ticket_number}.`,
    );
  }
  const firstExternal = rows.find((row) => !row.is_staff);
  return {
    messageIds: rows.map((row) => row.id),
    firstExternalMessageId: firstExternal?.id ?? null,
  };
}

function resolveThreadmarkTicketMessagesForAttachment(
  database: SupportDatabase,
  ticketId: string,
  groupId: string,
  messageIds: readonly string[],
): { messageIds: string[] } {
  const uniqueIds = [...new Set(messageIds.map((id) => id.trim()).filter(Boolean))];
  if (!uniqueIds.length) return { messageIds: [] };
  const placeholders = uniqueIds.map(() => "?").join(", ");
  const rows = database.prepare(
    `SELECT message.id, message.group_id, message.occurred_at,
            (SELECT membership.ticket_id
             FROM ticket_messages membership
             WHERE membership.message_id = message.id
             ORDER BY membership.ticket_id LIMIT 1) AS linked_ticket_id,
            (SELECT ticket.number
             FROM ticket_messages membership
             JOIN tickets ticket ON ticket.id = membership.ticket_id
             WHERE membership.message_id = message.id
             ORDER BY ticket.number LIMIT 1) AS linked_ticket_number
     FROM messages message
     WHERE message.id IN (${placeholders})
     ORDER BY message.occurred_at, message.rowid`,
  ).all(...uniqueIds) as Array<{
    id: string;
    group_id: string;
    occurred_at: string;
    linked_ticket_id: string | null;
    linked_ticket_number: number | null;
  }>;
  if (rows.length !== uniqueIds.length) {
    const found = new Set(rows.map((row) => row.id));
    const missing = uniqueIds.find((id) => !found.has(id));
    throw new Error(`A mensagem ${missing ?? "informada"} não existe no Threadmark.`);
  }
  const foreign = rows.find((row) => row.group_id !== groupId);
  if (foreign) {
    throw new Error(`A mensagem ${foreign.id} não pertence à conversa do ticket.`);
  }
  const linkedElsewhere = rows.find(
    (row) => row.linked_ticket_id !== null && row.linked_ticket_id !== ticketId,
  );
  if (linkedElsewhere) {
    throw new Error(
      `A mensagem ${linkedElsewhere.id} já está vinculada ao ticket #${linkedElsewhere.linked_ticket_number}.`,
    );
  }
  return {
    messageIds: rows
      .filter((row) => row.linked_ticket_id === null)
      .map((row) => row.id),
  };
}

function normalizeExternalTicketSourceMessages(
  messages: ReadonlyArray<{
    id: string;
    author: string;
    authorRole: "customer" | "support";
    body: string;
    occurredAt?: string;
  }>,
  fallbackOccurredAt: string,
): ExternalTicketSourceMessage[] {
  const seen = new Set<string>();
  return messages.flatMap((message) => {
    if (seen.has(message.id)) return [];
    seen.add(message.id);
    return [{
      id: message.id,
      author: message.author,
      authorRole: message.authorRole,
      body: message.body,
      occurredAt: message.occurredAt ?? fallbackOccurredAt,
    }];
  });
}

function resolveNewExternalTicketSourceMessages(
  database: SupportDatabase,
  ticketId: string,
  sourceType: "intercom_conversation",
  sourceConversationId: string,
  messages: readonly ExternalTicketSourceMessage[],
): ExternalTicketSourceMessage[] {
  if (!messages.length) return [];
  const messageIds = messages.map((message) => message.id);
  const placeholders = messageIds.map(() => "?").join(", ");
  const rows = database.prepare(
    `SELECT ticket_id, external_message_id
     FROM ticket_external_messages
     WHERE source_type = ? AND source_conversation_id = ?
       AND external_message_id IN (${placeholders})`,
  ).all(sourceType, sourceConversationId, ...messageIds) as Array<{
    ticket_id: string;
    external_message_id: string;
  }>;
  const linkedElsewhere = rows.find((row) => row.ticket_id !== ticketId);
  if (linkedElsewhere) {
    throw new Error(
      `A mensagem externa ${linkedElsewhere.external_message_id} já pertence a outro ticket.`,
    );
  }
  const alreadyAttached = new Set(
    rows.filter((row) => row.ticket_id === ticketId).map((row) => row.external_message_id),
  );
  return messages.filter((message) => !alreadyAttached.has(message.id));
}

function parseExternalTicketSourceMessages(value: string): ExternalTicketSourceMessage[] {
  const parsed = JSON.parse(value) as unknown;
  const schema = z.array(z.object({
    id: z.string().trim().min(1).max(200),
    author: z.string().trim().min(1).max(200),
    authorRole: z.enum(["customer", "support"]),
    body: z.string().trim().min(1).max(20_000),
    occurredAt: z.string().datetime({ offset: true }),
  }).strict()).max(100);
  return schema.parse(parsed);
}

function resolveTicketCategories(
  database: SupportDatabase,
  categoryIds: string[],
): ThreadmarkTicketCategory[] {
  const uniqueIds = [...new Set(categoryIds)];
  if (!uniqueIds.length) return [];
  const placeholders = uniqueIds.map(() => "?").join(", ");
  const rows = database.prepare(
    `SELECT id, facet, slug, label, color FROM categories WHERE id IN (${placeholders})`,
  ).all(...uniqueIds) as ThreadmarkTicketCategory[];
  const byId = new Map(rows.map((category) => [category.id, category]));
  const missing = uniqueIds.filter((categoryId) => !byId.has(categoryId));
  if (missing.length) {
    throw new Error(`Categoria(s) inexistente(s): ${missing.join(", ")}. Consulte list_ticket_categories antes de preparar a alteração.`);
  }
  return uniqueIds.map((categoryId) => byId.get(categoryId)!);
}

function validateAiCategorySelection(
  categories: Array<{ facet: ThreadmarkTicketCategory["facet"] }>,
): void {
  const counts = new Map<ThreadmarkTicketCategory["facet"], number>();
  for (const category of categories) {
    counts.set(category.facet, (counts.get(category.facet) ?? 0) + 1);
  }
  for (const [facet, count] of counts) {
    const maximum = facet === "platform" ? 3 : 1;
    if (count > maximum) {
      throw new Error(`A classificação automática permite no máximo ${maximum} categoria(s) da faceta ${facet}.`);
    }
  }
}

function successfulCreatedTicketResult(
  request: InvestigationToolRequest,
  ticket: {
    id: string;
    number: number;
    title: string;
    status: string;
    priority: string;
    client: { name: string };
    group: { subject: string };
    categories?: Array<{ id: string; facet: string; label: string }>;
  },
  draft: ThreadmarkAiTicketDraftRow,
  executedAt: string,
  idempotentReplay: boolean,
): InvestigationToolResult {
  const content = {
    created: true,
    idempotentReplay,
    ticket: {
      id: ticket.id,
      number: ticket.number,
      title: ticket.title,
      status: ticket.status,
      priority: ticket.priority,
      clientName: ticket.client.name,
      groupName: ticket.group.subject,
      categories: ticket.categories ?? [],
      internalUrl: `/tickets/${ticket.number}`,
    },
    source: draft.external_source_id
      ? { type: draft.external_source_type, id: draft.external_source_id }
      : null,
  };
  return {
    requestId: request.requestId,
    toolId: THREADMARK_CONTEXT_TOOL_ID,
    toolName: "Contexto do Threadmark",
    operation: request.operation,
    argumentsJson: request.argumentsJson,
    purpose: request.purpose,
    status: "success",
    summary: idempotentReplay
      ? `O ticket #${ticket.number} já havia sido criado por esta confirmação.`
      : `Ticket #${ticket.number} criado no Threadmark após confirmação explícita.`,
    content: JSON.stringify(content, null, 2),
    reference: `tool:${THREADMARK_CONTEXT_TOOL_ID}:ticket:${encodeURIComponent(ticket.id)}:request:${encodeURIComponent(request.requestId)}`,
    executedAt,
  };
}

function successfulUpdatedTicketResult(
  request: InvestigationToolRequest,
  ticket: {
    id: string;
    number: number;
    title: string;
    summary: string;
    status: string;
    priority: string;
    categories: Array<{ id: string; facet: string; label: string }>;
  },
  executedAt: string,
  idempotentReplay: boolean,
): InvestigationToolResult {
  return {
    requestId: request.requestId,
    toolId: THREADMARK_CONTEXT_TOOL_ID,
    toolName: "Contexto do Threadmark",
    operation: request.operation,
    argumentsJson: request.argumentsJson,
    purpose: request.purpose,
    status: "success",
    summary: idempotentReplay
      ? `O ticket #${ticket.number} já havia sido atualizado por esta confirmação.`
      : `Ticket #${ticket.number} atualizado no Threadmark após confirmação explícita.`,
    content: JSON.stringify({
      updated: true,
      idempotentReplay,
      ticket: {
        id: ticket.id,
        number: ticket.number,
        title: ticket.title,
        summary: ticket.summary,
        status: ticket.status,
        priority: ticket.priority,
        categories: ticket.categories,
        internalUrl: `/tickets/${ticket.number}`,
      },
    }, null, 2),
    reference: `tool:${THREADMARK_CONTEXT_TOOL_ID}:ticket:${encodeURIComponent(ticket.id)}:request:${encodeURIComponent(request.requestId)}`,
    executedAt,
  };
}

function buildIntercomSearch(query: string, limit: number): Record<string, unknown> {
  const filters: Array<Record<string, unknown>> = [
    { field: "source.author.name", operator: "=", value: query },
    { field: "source.subject", operator: "=", value: query },
  ];
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(query)) {
    filters.push({ field: "source.author.email", operator: "=", value: query });
  }
  return {
    query: filters.length === 1
      ? filters[0]
      : { operator: "OR", value: filters },
    pagination: { per_page: limit },
    sort: { field: "updated_at", order: "descending" },
  };
}

function sanitizeIntercomSearchResult(value: unknown): Record<string, unknown> {
  const root = asRecord(value);
  const conversations = Array.isArray(root.conversations) ? root.conversations : [];
  return {
    totalCount: finiteNumber(root.total_count) ?? conversations.length,
    conversations: conversations.slice(0, 20).map((item) => {
      const conversation = asRecord(item);
      const source = asRecord(conversation.source);
      const author = asRecord(source.author);
      return {
        id: limitedString(conversation.id, 200),
        title: limitedString(conversation.title, 500),
        state: limitedString(conversation.state, 50),
        priority: limitedString(conversation.priority, 50),
        createdAt: intercomTimestamp(conversation.created_at),
        updatedAt: intercomTimestamp(conversation.updated_at),
        contact: {
          id: limitedString(author.id, 200),
          name: limitedString(author.name, 300),
          email: limitedString(author.email, 320),
        },
        subject: limitedString(source.subject, 500),
        preview: limitedIntercomText(source.body, 2_000),
      };
    }),
  };
}

function sanitizeIntercomConversation(value: unknown): Record<string, unknown> {
  const conversation = asRecord(value);
  const source = asRecord(conversation.source);
  const sourceAuthor = asRecord(source.author);
  const partsContainer = asRecord(conversation.conversation_parts);
  const parts = Array.isArray(partsContainer.conversation_parts)
    ? partsContainer.conversation_parts
    : [];
  return {
    id: limitedString(conversation.id, 200),
    title: limitedString(conversation.title, 500),
    state: limitedString(conversation.state, 50),
    priority: limitedString(conversation.priority, 50),
    createdAt: intercomTimestamp(conversation.created_at),
    updatedAt: intercomTimestamp(conversation.updated_at),
    source: {
      id: limitedString(source.id, 200),
      createdAt: intercomTimestamp(source.created_at ?? conversation.created_at),
      author: {
        id: limitedString(sourceAuthor.id, 200),
        type: limitedString(sourceAuthor.type, 50),
        name: limitedString(sourceAuthor.name, 300),
        email: limitedString(sourceAuthor.email, 320),
      },
      body: limitedIntercomText(source.body, 8_000),
    },
    parts: parts.slice(-100).map((item) => {
      const part = asRecord(item);
      const author = asRecord(part.author);
      return {
        id: limitedString(part.id, 200),
        createdAt: intercomTimestamp(part.created_at),
        type: limitedString(part.part_type, 80),
        author: {
          id: limitedString(author.id, 200),
          type: limitedString(author.type, 50),
          name: limitedString(author.name, 300),
          email: limitedString(author.email, 320),
        },
        body: limitedIntercomText(part.body, 8_000),
      };
    }),
  };
}

function sanitizeIntercomCurrentAdmin(value: unknown): Record<string, unknown> {
  const admin = asRecord(value);
  return {
    id: limitedString(admin.id, 200),
    name: limitedString(admin.name, 300),
    email: limitedString(admin.email, 320),
    jobTitle: limitedString(admin.job_title, 300),
    awayModeEnabled: Boolean(admin.away_mode_enabled),
  };
}

function sanitizeIntercomCollections(value: unknown): Record<string, unknown> {
  const root = asRecord(value);
  const collections = Array.isArray(root.data) ? root.data : [];
  return {
    totalCount: finiteNumber(root.total_count) ?? collections.length,
    collections: collections.slice(0, 150).map((item) => {
      const collection = asRecord(item);
      return {
        id: limitedString(collection.id, 200),
        name: limitedString(collection.name, 500),
        description: limitedIntercomText(collection.description, 2_000),
        parentId: limitedString(collection.parent_id, 200),
        helpCenterId: limitedString(collection.help_center_id, 200),
        updatedAt: intercomTimestamp(collection.updated_at),
      };
    }),
  };
}

function sanitizeIntercomArticle(value: unknown): Record<string, unknown> {
  const article = asRecord(value);
  const author = asRecord(article.author);
  return {
    id: limitedString(article.id, 200),
    title: limitedString(article.title, 500),
    state: limitedString(article.state, 50),
    url: limitedString(article.url, 2_000),
    parentId: limitedString(article.parent_id, 200),
    parentType: limitedString(article.parent_type, 80),
    author: {
      id: limitedString(author.id ?? article.author_id, 200),
      name: limitedString(author.name, 300),
    },
    createdAt: intercomTimestamp(article.created_at),
    updatedAt: intercomTimestamp(article.updated_at),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function limitedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  return normalized ? truncatePlainText(normalized, maxLength) : null;
}

function limitedIntercomText(value: unknown, maxLength: number): string | null {
  const source = limitedString(value, maxLength * 2);
  if (!source) return null;
  return truncatePlainText(
    source
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    maxLength,
  );
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function intercomTimestamp(value: unknown): string | null {
  const seconds = finiteNumber(value);
  return seconds === null ? null : new Date(seconds * 1_000).toISOString();
}

function searchThreadmarkContext(
  database: SupportDatabase,
  args: z.infer<typeof searchSupportContextSchema>,
): {
  query: string;
  scope: typeof args.scope;
  tickets: Array<Record<string, unknown>>;
  messages: Array<Record<string, unknown>>;
} {
  const normalizedQuery = args.query.trim();
  const ticketNumberMatch = normalizedQuery.match(/^#?(\d{1,9})$/);
  const ticketNumber = ticketNumberMatch ? Number(ticketNumberMatch[1]) : null;
  const pattern = `%${escapeSqliteLike(normalizedQuery.toLocaleLowerCase("pt-BR"))}%`;
  const includeTickets = args.scope !== "conversations";
  const includeMessages = args.scope === "all" || args.scope === "conversations";
  const resolutionOnly = args.scope === "resolutions" ? 1 : 0;

  const ticketRows = includeTickets
    ? database
        .prepare(
          `SELECT ticket.id, ticket.number, ticket.group_id, ticket.title, ticket.summary,
                  ticket.status, ticket.priority, ticket.updated_at,
                  client.name AS client_name, support_group.subject AS group_name,
                  resolution.summary AS resolution_summary,
                  resolution.root_cause, resolution.outcome,
                  (SELECT json_group_array(json_object(
                            'id', category.id,
                            'facet', category.facet,
                            'label', category.label
                          ))
                   FROM ticket_categories membership
                   JOIN categories category ON category.id = membership.category_id
                   WHERE membership.ticket_id = ticket.id) AS categories_json,
                  (SELECT response.body
                   FROM sent_responses response
                   WHERE response.ticket_id = ticket.id
                   ORDER BY response.sent_at DESC, response.id DESC LIMIT 1)
                    AS last_sent_response
           FROM tickets ticket
           JOIN clients client ON client.id = ticket.client_id
           JOIN whatsapp_groups support_group ON support_group.id = ticket.group_id
           LEFT JOIN resolutions resolution ON resolution.ticket_id = ticket.id
           WHERE (? = 0 OR resolution.id IS NOT NULL)
             AND (
               ticket.number = ?
               OR lower(ticket.title) LIKE ? ESCAPE '\\'
               OR lower(ticket.summary) LIKE ? ESCAPE '\\'
               OR lower(client.name) LIKE ? ESCAPE '\\'
               OR lower(support_group.subject) LIKE ? ESCAPE '\\'
               OR lower(COALESCE(resolution.summary, '')) LIKE ? ESCAPE '\\'
               OR lower(COALESCE(resolution.root_cause, '')) LIKE ? ESCAPE '\\'
               OR lower(COALESCE(resolution.outcome, '')) LIKE ? ESCAPE '\\'
               OR EXISTS (
                 SELECT 1
                 FROM ticket_messages membership
                 JOIN messages message ON message.id = membership.message_id
                 WHERE membership.ticket_id = ticket.id
                   AND lower(COALESCE(message.text, '')) LIKE ? ESCAPE '\\'
               )
             )
           ORDER BY CASE WHEN ticket.number = ? THEN 0 ELSE 1 END,
                    ticket.updated_at DESC, ticket.number DESC
           LIMIT ?`,
        )
        .all(
          resolutionOnly,
          ticketNumber,
          pattern,
          pattern,
          pattern,
          pattern,
          pattern,
          pattern,
          pattern,
          pattern,
          ticketNumber,
          args.limit,
        ) as Array<{
        id: string;
        number: number;
        group_id: string;
        title: string;
        summary: string;
        status: string;
        priority: string;
        updated_at: string;
        client_name: string;
        group_name: string;
        resolution_summary: string | null;
        root_cause: string | null;
        outcome: string | null;
        categories_json: string;
        last_sent_response: string | null;
      }>
    : [];

  const messageRows = includeMessages
    ? database
        .prepare(
          `SELECT message.id, message.occurred_at, message.text,
                  message.message_type, participant.display_name AS author,
                  support_group.id AS group_id,
                  support_group.subject AS group_name,
                  client.name AS client_name,
                  GROUP_CONCAT(DISTINCT ticket.number) AS ticket_numbers
           FROM messages message
           JOIN participants participant ON participant.id = message.sender_id
           JOIN whatsapp_groups support_group ON support_group.id = message.group_id
           JOIN clients client ON client.id = support_group.client_id
           LEFT JOIN ticket_messages membership ON membership.message_id = message.id
           LEFT JOIN tickets ticket ON ticket.id = membership.ticket_id
           WHERE lower(COALESCE(message.text, '')) LIKE ? ESCAPE '\\'
              OR lower(participant.display_name) LIKE ? ESCAPE '\\'
              OR lower(support_group.subject) LIKE ? ESCAPE '\\'
              OR lower(client.name) LIKE ? ESCAPE '\\'
           GROUP BY message.id
           ORDER BY message.occurred_at DESC, message.id DESC
           LIMIT ?`,
        )
        .all(pattern, pattern, pattern, pattern, args.limit) as Array<{
        id: string;
        occurred_at: string;
        text: string | null;
        message_type: string;
        author: string;
        group_id: string;
        group_name: string;
        client_name: string;
        ticket_numbers: string | null;
      }>
    : [];

  return {
    query: normalizedQuery,
    scope: args.scope,
    tickets: ticketRows.map((row) => ({
      id: row.id,
      number: row.number,
      groupId: row.group_id,
      title: row.title,
      summary: truncatePlainText(row.summary, 2_000),
      status: row.status,
      priority: row.priority,
      clientName: row.client_name,
      groupName: row.group_name,
      categories: parseTicketSearchCategories(row.categories_json),
      resolution: row.resolution_summary
        ? {
            summary: truncatePlainText(row.resolution_summary, 2_000),
            rootCause: row.root_cause ? truncatePlainText(row.root_cause, 1_000) : null,
            outcome: row.outcome ? truncatePlainText(row.outcome, 1_000) : null,
          }
        : null,
      lastSentResponse: row.last_sent_response
        ? truncatePlainText(row.last_sent_response, 2_000)
        : null,
      updatedAt: row.updated_at,
    })),
    messages: messageRows.map((row) => ({
      id: row.id,
      occurredAt: row.occurred_at,
      text: row.text ? truncatePlainText(row.text, 2_000) : null,
      messageType: row.message_type,
      author: row.author,
      groupId: row.group_id,
      groupName: row.group_name,
      clientName: row.client_name,
      ticketNumbers: row.ticket_numbers
        ? row.ticket_numbers.split(",").map(Number).filter(Number.isFinite)
        : [],
    })),
  };
}

function parseTicketSearchCategories(value: string): Array<Record<string, string>> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((category): category is Record<string, string> =>
      typeof category === "object" &&
      category !== null &&
      typeof (category as Record<string, unknown>).id === "string" &&
      typeof (category as Record<string, unknown>).facet === "string" &&
      typeof (category as Record<string, unknown>).label === "string"
    );
  } catch {
    return [];
  }
}

function escapeSqliteLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function truncatePlainText(value: string, maxCharacters: number): string {
  return value.length <= maxCharacters
    ? value
    : `${value.slice(0, Math.max(0, maxCharacters - 20))}\n[conteúdo truncado]`;
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
    return "Pasta acessível com as mesmas restrições de leitura do Threadmark AI.";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function mcpSchemaExample(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  return Object.fromEntries(
    Object.entries(properties).slice(0, 20).map(([name, candidate]) => {
      const property = isRecord(candidate) ? candidate : {};
      if (Array.isArray(property.enum) && property.enum.length) return [name, property.enum[0]];
      if (property.type === "boolean") return [name, false];
      if (property.type === "number" || property.type === "integer") return [name, 0];
      if (property.type === "array") return [name, []];
      if (property.type === "object") return [name, {}];
      return [name, `<${name}>`];
    }),
  );
}

function isExplicitExternalActionRequest(message: string): boolean {
  const normalized = message
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/\s+/g, " ")
    .trim();
  if (/\b(?:nao|nunca)\s+(?:crie|envie|execute|publique|altere|atualize)\b/.test(normalized)) {
    return false;
  }
  return /\b(?:pode\s+|por\s+favor\s+)?(?:crie|criar|envie|enviar|execute|executar|publique|publicar|altere|alterar|atualize|atualizar)\b/.test(normalized);
}
