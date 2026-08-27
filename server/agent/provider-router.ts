import type { SupportDatabase } from "../db/index.js";
import type { CodexSupportAgent } from "./codex-runner.js";
import type { AiProviderSettingsService } from "./provider-settings.js";
import type { SupportAgent } from "./provider.js";
import { isAffirmativePreviewConfirmation } from "./confirmation-intent.js";
import { investigationExecutionPolicy } from "./investigation-routing.js";
import type {
  InvestigationToolDescriptor,
  DocumentationDraftInput,
  DocumentationDraftResult,
  KnowledgeExtractionInput,
  KnowledgeExtractionResult,
  InvestigationToolRequest,
  InvestigationToolResult,
  InvestigationThreadInput,
  InvestigationTurnResult,
  SupportAnalysis,
  SupportAnalysisInput,
  TriageAnalysis,
  TriageAnalysisInput,
} from "./types.js";

const MAX_CONSECUTIVE_STALLED_TOOL_ROUNDS = 3;
const MAX_TOOL_RESULTS_IN_PROMPT = 15;
const MAX_TOOL_RESULT_PROMPT_TOTAL_CHARS = 30_000;
const MAX_SINGLE_TOOL_CONTENT_PROMPT_CHARS = 8_000;
const MAX_PERSISTED_TOOL_CONTENT_CHARS = 4_000;
const MAX_CHECKPOINT_SUMMARY_CHARS = 24_000;
const DEFAULT_MAX_TOOL_ROUNDS = 8;
const DEFAULT_MAX_TOOL_OPERATIONS = 24;
const DEFAULT_MAX_SAME_OPERATION = 8;
const DEFAULT_MAX_CODE_SEARCH_OPERATIONS = 5;
const TECHNICAL_EVIDENCE_SOURCES = new Set([
  "database",
  "clickhouse",
  "aws",
  "code",
  "deployment",
  "external_app",
]);

const TOOL_EVIDENCE_SOURCE = {
  codebase: "code",
  knowledge: "knowledge",
  postgres_readonly: "database",
  clickhouse_readonly: "clickhouse",
  aws_cloudwatch: "aws",
  vercel: "deployment",
  connected_app: "external_app",
} as const;

export interface DeepInvestigationToolBroker {
  descriptors(): InvestigationToolDescriptor[];
  executeMany(
    requests: InvestigationToolRequest[],
    signal?: AbortSignal,
  ): Promise<InvestigationToolResult[]>;
}

export interface DeepInvestigationCoordinatorOptions {
  maxToolRounds?: number;
  maxToolOperations?: number;
  maxSameOperation?: number;
  maxCodeSearchOperations?: number;
  quickModel?: string;
}

/** Routes each workload to its task-specific provider and records the executed model. */
export class ConfiguredSupportAgent implements Pick<SupportAgent, "analyse" | "triage" | "investigateThread" | "generateDocumentation" | "extractKnowledge"> {
  private readonly maxToolRounds: number;
  private readonly maxToolOperations: number;
  private readonly maxSameOperation: number;
  private readonly maxCodeSearchOperations: number;
  private readonly quickModel: string;

  constructor(
    private readonly database: SupportDatabase,
    private readonly settings: AiProviderSettingsService,
    private readonly codex: CodexSupportAgent,
    private readonly deepTools?: DeepInvestigationToolBroker,
    options: DeepInvestigationCoordinatorOptions = {},
  ) {
    this.maxToolRounds = boundedPositiveInteger(
      options.maxToolRounds,
      DEFAULT_MAX_TOOL_ROUNDS,
      "maxToolRounds",
    );
    this.maxToolOperations = boundedPositiveInteger(
      options.maxToolOperations,
      DEFAULT_MAX_TOOL_OPERATIONS,
      "maxToolOperations",
    );
    this.maxSameOperation = boundedPositiveInteger(
      options.maxSameOperation,
      DEFAULT_MAX_SAME_OPERATION,
      "maxSameOperation",
    );
    this.maxCodeSearchOperations = boundedPositiveInteger(
      options.maxCodeSearchOperations,
      DEFAULT_MAX_CODE_SEARCH_OPERATIONS,
      "maxCodeSearchOperations",
    );
    this.quickModel = options.quickModel?.trim() || "gpt-5.6-terra";
  }

  async analyse(input: SupportAnalysisInput, signal?: AbortSignal): Promise<SupportAnalysis> {
    const resolved = await this.settings.createAgentForTask("automatic", this.codex);
    if (input.ticketId) {
      this.database
        .prepare(
          `UPDATE investigation_jobs
           SET ai_provider_id = ?, ai_connection_id = ?, ai_model = ?
           WHERE ticket_id = ? AND state = 'running'`,
        )
        .run(
          resolved.connection.providerId,
          resolved.connection.id,
          resolved.profile.model,
          input.ticketId,
        );
    }
    return resolved.agent.analyse(input, signal);
  }

  async triage(input: TriageAnalysisInput, _model: string, signal?: AbortSignal): Promise<TriageAnalysis> {
    const resolved = await this.settings.createAgentForTask("triage", this.codex);
    const firstCandidateId = input.candidateMessageIds[0];
    if (firstCandidateId) {
      this.database
        .prepare(
          `UPDATE triage_ai_jobs
           SET provider_id = ?, connection_id = ?, model = ?, updated_at = ?
           WHERE id = (
             SELECT membership.job_id
             FROM triage_ai_job_messages membership
             JOIN triage_ai_jobs job ON job.id = membership.job_id
             WHERE membership.message_id = ?
               AND membership.active = 1
               AND job.state = 'running'
             ORDER BY job.requested_at DESC, job.id DESC
             LIMIT 1
           )`,
        )
        .run(
          resolved.connection.providerId,
          resolved.connection.id,
          resolved.profile.model,
          new Date().toISOString(),
          firstCandidateId,
        );
    }
    return resolved.agent.triage(input, resolved.profile.model, signal);
  }

  async generateDocumentation(
    input: DocumentationDraftInput,
    signal?: AbortSignal,
  ): Promise<DocumentationDraftResult> {
    const resolved = await this.settings.createAgentForTask("documentation", this.codex);
    this.database
      .prepare(
        `UPDATE documentation_generation_jobs
         SET ai_provider_id = ?, ai_connection_id = ?, ai_model = ?
         WHERE draft_id = ? AND state = 'running'`,
      )
      .run(
        resolved.connection.providerId,
        resolved.connection.id,
        resolved.profile.model,
        input.draftId,
      );
    return resolved.agent.generateDocumentation(input, signal);
  }

  async extractKnowledge(
    input: KnowledgeExtractionInput,
    signal?: AbortSignal,
  ): Promise<KnowledgeExtractionResult> {
    const resolved = await this.settings.createAgentForTask("documentation", this.codex);
    this.database
      .prepare(
        `UPDATE documentation_generation_jobs
         SET ai_provider_id = ?, ai_connection_id = ?, ai_model = ?
         WHERE draft_id = ? AND state = 'running'`,
      )
      .run(
        resolved.connection.providerId,
        resolved.connection.id,
        resolved.profile.model,
        input.draftId,
      );
    if (!resolved.agent.extractKnowledge) {
      throw new Error("O provedor selecionado não oferece extração estruturada de conhecimento.");
    }
    return resolved.agent.extractKnowledge(input, signal);
  }

  async investigateThread(
    input: InvestigationThreadInput,
    signal?: AbortSignal,
  ): Promise<InvestigationTurnResult> {
    const executionPolicy = investigationExecutionPolicy(input);
    const maxToolRounds = Math.min(
      this.maxToolRounds,
      executionPolicy.maxToolRounds,
    );
    const maxToolOperations = Math.min(
      this.maxToolOperations,
      executionPolicy.maxToolOperations,
    );
    const maxSameOperation = Math.min(
      this.maxSameOperation,
      executionPolicy.maxSameOperation,
    );
    const maxCodeSearchOperations = Math.min(
      this.maxCodeSearchOperations,
      executionPolicy.maxCodeSearchOperations,
    );
    const resolved = await this.settings.createAgentForTask(
      "deep",
      this.codex,
      executionPolicy.workload === "quick"
        ? { codexModelOverride: this.quickModel }
        : {},
    );
    this.database
      .prepare(
        `UPDATE investigation_thread_jobs
         SET ai_provider_id = ?, ai_connection_id = ?, ai_model = ?
         WHERE thread_id = ? AND state = 'running'`,
      )
      .run(
        resolved.connection.providerId,
        resolved.connection.id,
        resolved.profile.model,
        input.threadId,
    );
    const availableTools = this.deepTools?.descriptors() ?? [];
    const toolResults: InvestigationToolResult[] = [...(input.toolResults ?? [])];
    const pendingConfirmation = resolvePendingDraftConfirmation(
      this.database,
      input.threadId,
      input.currentOperatorMessageId,
    );
    if (
      pendingConfirmation &&
      this.deepTools &&
      !toolResults.some((result) => result.requestId === pendingConfirmation.requestId) &&
      toolSupportsRequest(availableTools, pendingConfirmation)
    ) {
      const executions = await this.deepTools.executeMany([pendingConfirmation], signal);
      for (const execution of executions) {
        toolResults.push(execution);
        await input.onToolExecution?.(execution);
      }
    }
    const observedRequestIds = new Set(toolResults.map((result) => result.requestId));
    const observedRequests = new Set(toolResults.map(toolRequestFingerprint));
    const observedSemanticRequests = new Set(
      toolResults.map(semanticToolRequestFingerprint),
    );
    const operationCounts = countToolOperations(toolResults);
    let durableSummary = input.durableSummary;
    let consecutiveStalledRounds = 0;
    let usedToolRounds = 0;
    let usedToolOperations = toolResults.length;
    const appendToolResult = async (execution: InvestigationToolResult): Promise<void> => {
      toolResults.push(execution);
      await input.onToolExecution?.(execution);
    };

    while (true) {
      signal?.throwIfAborted();
      const forceConclusion =
        usedToolRounds >= maxToolRounds ||
        usedToolOperations >= maxToolOperations;
      const rawResult = await resolved.agent.investigateThread({
        ...input,
        durableSummary,
        availableTools: forceConclusion ? [] : availableTools,
        toolResults: boundedToolResultsForPrompt(toolResults),
        executionBudget: {
          workload: executionPolicy.workload,
          maxToolRounds,
          usedToolRounds,
          maxToolOperations,
          usedToolOperations,
          forceConclusion,
        },
      }, signal);
      signal?.throwIfAborted();
      const result = enforceVerifiedTechnicalEvidence(
        rawResult,
        toolResults,
        availableTools,
      );
      if (!result.toolRequests.length) {
        return {
          ...result,
          toolRequests: [],
          toolExecutions: compactToolExecutions(toolResults),
        };
      }
      if (forceConclusion) {
        return budgetExhaustedInvestigationResult(result, toolResults);
      }

      usedToolRounds += 1;

      durableSummary = checkpointSummary(result.threadSummary);
      this.persistInvestigationCheckpoint(input.threadId, durableSummary);

      const pending: InvestigationToolRequest[] = [];
      for (const request of result.toolRequests) {
        if (observedRequestIds.has(request.requestId)) {
          await appendToolResult(duplicateToolRequestIdResult(request));
          continue;
        }
        observedRequestIds.add(request.requestId);
        const fingerprint = toolRequestFingerprint(request);
        if (observedRequests.has(fingerprint)) {
          await appendToolResult(repeatedToolRequestResult(request));
          continue;
        }
        observedRequests.add(fingerprint);
        const semanticFingerprint = semanticToolRequestFingerprint(request);
        if (observedSemanticRequests.has(semanticFingerprint)) {
          await appendToolResult(semanticallyRepeatedToolRequestResult(request));
          continue;
        }
        observedSemanticRequests.add(semanticFingerprint);
        const descriptor = availableTools.find((tool) => tool.id === request.toolId);
        if (
          requiresCurrentOperatorConfirmation(descriptor, request) &&
          !hasCurrentOperatorConfirmation(request, input.currentOperatorMessageId)
        ) {
          await appendToolResult(connectedAppConfirmationRequiredResult(request));
          continue;
        }
        const operationKey = toolOperationKey(request);
        const operationLimit = descriptor?.type === "codebase" &&
            request.operation === "search_files"
          ? maxCodeSearchOperations
          : maxSameOperation;
        const operationCount = operationCounts.get(operationKey) ?? 0;
        if (operationCount >= operationLimit) {
          await appendToolResult(operationBudgetReachedResult(request, operationLimit));
          continue;
        }
        if (usedToolOperations + pending.length >= maxToolOperations) {
          break;
        }
        operationCounts.set(operationKey, operationCount + 1);
        pending.push(request);
      }

      if (!pending.length) {
        consecutiveStalledRounds += 1;
        if (
          consecutiveStalledRounds >= MAX_CONSECUTIVE_STALLED_TOOL_ROUNDS
        ) {
          return enforceVerifiedTechnicalEvidence(
            stalledInvestigationResult(result, toolResults),
            toolResults,
            availableTools,
          );
        }
        continue;
      }
      consecutiveStalledRounds = 0;

      const readonlyRequests = pending.filter((request) => {
        const descriptor = availableTools.find((tool) => tool.id === request.toolId);
        return descriptor?.type !== "connected_app" &&
          request.toolId !== "threadmark-context" &&
          request.toolId !== "threadmark-automations" &&
          !requiresCurrentOperatorConfirmation(descriptor, request);
      });
      const mutationRequests = pending.filter(
        (request) => !readonlyRequests.includes(request),
      );
      const readonlyExecutions = this.deepTools
        ? await Promise.all(
            readonlyRequests.map((request) =>
              this.deepTools!.executeMany([request], signal),
            ),
          )
        : readonlyRequests.map((request) => [unavailableToolResult(request)]);
      for (const executions of readonlyExecutions) {
        for (const execution of executions) await appendToolResult(execution);
        usedToolOperations += executions.length;
      }
      for (const request of mutationRequests) {
        signal?.throwIfAborted();
        const executions = this.deepTools
          ? await this.deepTools.executeMany([request], signal)
          : [unavailableToolResult(request)];
        for (const execution of executions) await appendToolResult(execution);
        usedToolOperations += executions.length;
      }
    }
  }

  private persistInvestigationCheckpoint(
    threadId: string,
    summary: string,
  ): void {
    this.database
      .prepare(
        `UPDATE investigation_threads
         SET summary = ?, updated_at = ?
         WHERE id = ? AND status = 'active'`,
      )
      .run(summary, new Date().toISOString(), threadId);
  }
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > 500) {
    throw new RangeError(`${label} deve ser um inteiro entre 1 e 500`);
  }
  return resolved;
}

function hasCurrentOperatorConfirmation(
  request: InvestigationToolRequest,
  currentOperatorMessageId: string,
): boolean {
  try {
    const parsed = JSON.parse(request.argumentsJson) as { confirmationMessageId?: unknown };
    return parsed.confirmationMessageId === currentOperatorMessageId;
  } catch {
    return false;
  }
}

interface PendingDraftConfirmationRow {
  draft_id: string;
  operator_message_id: string;
  tool_id: string;
  operation: string;
}

function resolvePendingDraftConfirmation(
  database: SupportDatabase,
  threadId: string,
  currentOperatorMessageId: string,
): InvestigationToolRequest | null {
  const current = database.prepare(
    `SELECT rowid AS message_order, body
     FROM investigation_thread_messages
     WHERE id = ? AND thread_id = ? AND role = 'operator'`,
  ).get(currentOperatorMessageId, threadId) as
    | { message_order: number; body: string }
    | undefined;
  if (!current || !isAffirmativePreviewConfirmation(current.body)) return null;

  const previous = database.prepare(
    `SELECT rowid AS message_order, role, job_id
     FROM investigation_thread_messages
     WHERE thread_id = ? AND rowid < ?
     ORDER BY rowid DESC
     LIMIT 1`,
  ).get(threadId, current.message_order) as
    | { message_order: number; role: "operator" | "assistant"; job_id: string | null }
    | undefined;
  if (!previous || previous.role !== "assistant" || !previous.job_id) return null;

  const draft = database.prepare(
    `SELECT draft_id, operator_message_id, tool_id, operation
     FROM (
       SELECT id AS draft_id, operator_message_id,
              'threadmark-context' AS tool_id,
              'create_ticket_from_draft' AS operation,
              created_at
       FROM threadmark_ai_ticket_drafts
       WHERE thread_id = ? AND state = 'pending'
       UNION ALL
       SELECT id AS draft_id, operator_message_id,
              'threadmark-context' AS tool_id,
              'apply_ticket_update_draft' AS operation,
              created_at
       FROM threadmark_ai_ticket_update_drafts
       WHERE thread_id = ? AND state = 'pending'
       UNION ALL
       SELECT id AS draft_id, operator_message_id,
              'threadmark-automations' AS tool_id,
              'apply_automation_draft' AS operation,
              created_at
       FROM threadmark_ai_automation_drafts
       WHERE thread_id = ? AND state = 'pending'
     )
     ORDER BY created_at DESC, draft_id DESC
     LIMIT 1`,
  ).get(threadId, threadId, threadId) as PendingDraftConfirmationRow | undefined;
  if (!draft) return null;

  const source = database.prepare(
    `SELECT rowid AS message_order
     FROM investigation_thread_messages
     WHERE id = ? AND thread_id = ? AND role = 'operator'`,
  ).get(draft.operator_message_id, threadId) as { message_order: number } | undefined;
  if (!source || source.message_order >= previous.message_order) return null;

  const presented = database.prepare(
    `SELECT 1
     FROM investigation_thread_tool_executions
     WHERE job_id = ? AND status = 'success'
       AND (instr(content, ?) > 0 OR instr(COALESCE(reference, ''), ?) > 0)
     LIMIT 1`,
  ).get(previous.job_id, draft.draft_id, draft.draft_id);
  if (!presented) return null;

  return {
    requestId: `confirmed-preview:${currentOperatorMessageId}`,
    toolId: draft.tool_id,
    operation: draft.operation,
    argumentsJson: JSON.stringify({
      confirmationMessageId: currentOperatorMessageId,
      draftId: draft.draft_id,
    }),
    purpose: "Aplicar a última prévia confirmada pelo operador.",
  };
}

function toolSupportsRequest(
  descriptors: InvestigationToolDescriptor[],
  request: InvestigationToolRequest,
): boolean {
  const descriptor = descriptors.find((candidate) => candidate.id === request.toolId);
  return descriptor?.operations.some((operation) => operation.name === request.operation) ?? false;
}

function requiresCurrentOperatorConfirmation(
  descriptor: InvestigationToolDescriptor | undefined,
  request: InvestigationToolRequest,
): boolean {
  if (request.toolId === "threadmark-context") {
    return [
      "create_ticket_from_draft",
      "apply_ticket_update_draft",
    ].includes(request.operation);
  }
  if (request.toolId === "threadmark-automations") {
    return [
      "apply_automation_draft",
      "set_automation_status",
      "delete_automation",
    ].includes(request.operation);
  }
  if (descriptor?.type !== "connected_app") return false;
  return ["execute_request", "send_message", "create_article"].includes(request.operation);
}

function connectedAppConfirmationRequiredResult(
  request: InvestigationToolRequest,
): InvestigationToolResult {
  const message =
    "A ação não foi executada: confirmationMessageId deve ser o ID da mensagem atual do operador que pediu explicitamente esta ação.";
  return {
    requestId: request.requestId,
    toolId: request.toolId,
    toolName:
      request.toolId === "threadmark-automations"
        ? "Automações do Threadmark"
        : "App conectado",
    operation: request.operation,
    argumentsJson: request.argumentsJson,
    purpose: request.purpose,
    status: "error",
    summary: message,
    content: message,
    reference: null,
    executedAt: new Date().toISOString(),
  };
}

function checkpointSummary(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= MAX_CHECKPOINT_SUMMARY_CHARS) return normalized;
  return normalized.slice(0, MAX_CHECKPOINT_SUMMARY_CHARS);
}

function stalledInvestigationResult(
  result: InvestigationTurnResult,
  toolResults: InvestigationToolResult[],
): InvestigationTurnResult {
  return {
    ...result,
    assistantMessage:
      "A investigação entrou em repetição sem solicitar uma nova operação válida. As leituras já realizadas foram preservadas, mas o agente precisa de uma nova orientação para prosseguir com segurança.",
    phase: "needs_information",
    findings: [{
      statement: "A investigação repetiu operações sem produzir uma nova verificação válida.",
      kind: "missing_information",
      evidenceReferences: [],
    }],
    suggestedResponse: null,
    nextAction:
      "Revise as operações repetidas e oriente um novo caminho de investigação.",
    confidence: Math.min(result.confidence, 0.5),
    toolRequests: [],
    toolExecutions: compactToolExecutions(toolResults),
  };
}

function boundedToolResultsForPrompt(
  results: InvestigationToolResult[],
): InvestigationToolResult[] {
  const selected: InvestigationToolResult[] = [];
  let remaining = MAX_TOOL_RESULT_PROMPT_TOTAL_CHARS;
  const candidates = results.slice(-MAX_TOOL_RESULTS_IN_PROMPT);
  for (let index = candidates.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const result = candidates[index]!;
    const compact = {
      ...result,
      argumentsJson: truncatePromptField(result.argumentsJson, 2_000),
      purpose: truncatePromptField(result.purpose, 500),
      summary: truncatePromptField(result.summary, 1_000),
      content: "",
    };
    const metadataChars = JSON.stringify(compact).length;
    if (metadataChars >= remaining) continue;
    const contentLimit = Math.min(
      MAX_SINGLE_TOOL_CONTENT_PROMPT_CHARS,
      remaining - metadataChars,
    );
    compact.content = truncatePromptField(result.content, contentLimit);
    remaining -= metadataChars + compact.content.length;
    selected.unshift(compact);
  }
  return selected;
}

function compactToolExecutions(
  results: InvestigationToolResult[],
): InvestigationToolResult[] {
  return results.map((result) => ({
    ...result,
    argumentsJson: result.argumentsJson.slice(0, 4_000),
    purpose: result.purpose.slice(0, 1_000),
    summary: result.summary.slice(0, 2_000),
    content: result.content.slice(0, MAX_PERSISTED_TOOL_CONTENT_CHARS),
  }));
}

function toolRequestFingerprint(request: InvestigationToolRequest): string {
  let normalizedArguments = request.argumentsJson.trim();
  try {
    normalizedArguments = stableJson(JSON.parse(normalizedArguments));
  } catch {
    // The executor will return the typed validation error to the model.
  }
  return `${request.toolId}\u0000${request.operation}\u0000${normalizedArguments}`;
}

const SEMANTICALLY_IRRELEVANT_ARGUMENTS = new Set([
  "limit",
  "maxFiles",
  "maxLines",
  "maxResults",
  "maxRows",
  "timeoutMs",
  "caseSensitive",
]);

function semanticToolRequestFingerprint(
  request: Pick<InvestigationToolRequest, "toolId" | "operation" | "argumentsJson">,
): string {
  try {
    const parsed = JSON.parse(request.argumentsJson) as unknown;
    return `${request.toolId}\u0000${request.operation}\u0000${stableJson(
      stripSemanticNoise(parsed),
    )}`;
  } catch {
    return toolRequestFingerprint(request as InvestigationToolRequest);
  }
}

function stripSemanticNoise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSemanticNoise);
  if (!value || typeof value !== "object") {
    return typeof value === "string"
      ? value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("pt-BR")
      : value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SEMANTICALLY_IRRELEVANT_ARGUMENTS.has(key))
      .map(([key, item]) => [key, stripSemanticNoise(item)]),
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function toolOperationKey(
  request: Pick<InvestigationToolRequest, "toolId" | "operation">,
): string {
  return `${request.toolId}\u0000${request.operation}`;
}

function countToolOperations(
  results: InvestigationToolResult[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const result of results) {
    const key = toolOperationKey(result);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function repeatedToolRequestResult(
  request: InvestigationToolRequest,
): InvestigationToolResult {
  const message = "Solicitação repetida bloqueada; use o resultado anterior ou refine a consulta.";
  return {
    requestId: request.requestId,
    toolId: request.toolId,
    toolName: "Ferramenta autorizada",
    operation: request.operation,
    argumentsJson: request.argumentsJson,
    purpose: request.purpose,
    status: "error",
    summary: message,
    content: message,
    reference: null,
    executedAt: new Date().toISOString(),
  };
}

function semanticallyRepeatedToolRequestResult(
  request: InvestigationToolRequest,
): InvestigationToolResult {
  const message =
    "Solicitação semanticamente repetida bloqueada; alterar apenas paginação, limite ou timeout não produz uma nova verificação.";
  return coordinatorErrorResult(request, message);
}

function operationBudgetReachedResult(
  request: InvestigationToolRequest,
  limit: number,
): InvestigationToolResult {
  const message =
    `A operação ${request.operation} atingiu o limite seguro de ${limit} execuções. Use as evidências existentes ou escolha outra hipótese materialmente diferente.`;
  return coordinatorErrorResult(request, message);
}

function coordinatorErrorResult(
  request: InvestigationToolRequest,
  message: string,
): InvestigationToolResult {
  return {
    requestId: request.requestId,
    toolId: request.toolId,
    toolName: "Coordenador do Threadmark AI",
    operation: request.operation,
    argumentsJson: request.argumentsJson,
    purpose: request.purpose,
    status: "error",
    summary: message,
    content: message,
    reference: null,
    executedAt: new Date().toISOString(),
  };
}

function budgetExhaustedInvestigationResult(
  result: InvestigationTurnResult,
  toolResults: InvestigationToolResult[],
): InvestigationTurnResult {
  return {
    ...result,
    assistantMessage:
      "A exploração automática atingiu o orçamento seguro deste turno. Preservei as evidências encontradas, mas a IA não produziu a síntese final solicitada.",
    phase: "needs_information",
    findings: [{
      statement: "A investigação precisa de um foco mais específico para continuar sem repetir buscas.",
      kind: "missing_information",
      evidenceReferences: [],
    }],
    suggestedResponse: null,
    nextAction: "Informe qual hipótese ou área deve ser aprofundada na próxima mensagem.",
    confidence: Math.min(result.confidence, 0.5),
    toolRequests: [],
    toolExecutions: compactToolExecutions(toolResults),
  };
}

function duplicateToolRequestIdResult(
  request: InvestigationToolRequest,
): InvestigationToolResult {
  const message = "requestId já utilizado nesta investigação; a reexecução foi bloqueada.";
  return {
    requestId: request.requestId,
    toolId: request.toolId,
    toolName: "Ferramenta autorizada",
    operation: request.operation,
    argumentsJson: request.argumentsJson,
    purpose: request.purpose,
    status: "error",
    summary: message,
    content: message,
    reference: null,
    executedAt: new Date().toISOString(),
  };
}

function truncatePromptField(value: string, limit: number): string {
  if (value.length <= limit) return value;
  if (limit <= 20) return value.slice(0, limit);
  return `${value.slice(0, limit - 20)}\n[conteúdo truncado]`;
}

function enforceVerifiedTechnicalEvidence(
  result: InvestigationTurnResult,
  executions: InvestigationToolResult[],
  descriptors: InvestigationToolDescriptor[],
): InvestigationTurnResult {
  const descriptorsById = new Map(
    descriptors.map((descriptor) => [descriptor.id, descriptor] as const),
  );
  const successfulSourcesByReference = new Map<string, Set<string>>();
  for (const execution of executions) {
    if (execution.status !== "success" || !execution.reference) continue;
    const descriptor = descriptorsById.get(execution.toolId);
    if (!descriptor || descriptor.type === "debugger_skill") continue;
    const source = TOOL_EVIDENCE_SOURCE[descriptor.type];
    const sources = successfulSourcesByReference.get(execution.reference) ?? new Set<string>();
    sources.add(source);
    successfulSourcesByReference.set(execution.reference, sources);
  }
  const invalidTechnicalEvidence = result.evidence.filter(
    (evidence) => {
      if (!TECHNICAL_EVIDENCE_SOURCES.has(evidence.source)) return false;
      if (!evidence.reference) return true;
      return !successfulSourcesByReference
        .get(evidence.reference)
        ?.has(evidence.source);
    },
  );
  if (!invalidTechnicalEvidence.length) return result;

  const verifiedEvidence = result.evidence.filter(
    (evidence) => !invalidTechnicalEvidence.includes(evidence),
  );
  const blocksOperationalResponse =
    result.phase === "conclusion" || Boolean(result.suggestedResponse);
  return {
    ...result,
    assistantMessage:
      "A orientação técnica não foi liberada porque as referências apresentadas não correspondem a uma execução local concluída com sucesso.",
    phase: blocksOperationalResponse ? "needs_information" : result.phase,
    threadSummary: "Orientação técnica aguardando evidência local auditável.",
    findings: [{
      statement: "A orientação técnica ainda não possui uma referência local validada.",
      kind: "missing_information",
      evidenceReferences: [],
    }],
    evidence: verifiedEvidence,
    suggestedResponse: null,
    nextAction:
      "Execute novamente a ferramenta necessária e cite exatamente a referência retornada pelo Threadmark.",
    confidence: Math.min(result.confidence, 0.5),
    toolRequests: blocksOperationalResponse ? [] : result.toolRequests,
  };
}

function unavailableToolResult(
  request: InvestigationToolRequest,
): InvestigationToolResult {
  const message = "Nenhum executor local foi autorizado para esta investigação.";
  return {
    requestId: request.requestId,
    toolId: request.toolId,
    toolName: "Ferramenta indisponível",
    operation: request.operation,
    argumentsJson: request.argumentsJson,
    purpose: request.purpose,
    status: "error",
    summary: message,
    content: message,
    reference: null,
    executedAt: new Date().toISOString(),
  };
}
