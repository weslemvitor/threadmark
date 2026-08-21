import type { SupportDatabase } from "../db/index.js";
import type { CodexSupportAgent } from "./codex-runner.js";
import type { AiProviderSettingsService } from "./provider-settings.js";
import type { SupportAgent } from "./provider.js";
import type {
  InvestigationToolDescriptor,
  DocumentationDraftInput,
  DocumentationDraftResult,
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

/** Routes each workload to its task-specific provider and records the executed model. */
export class ConfiguredSupportAgent implements Pick<SupportAgent, "analyse" | "triage" | "investigateThread" | "generateDocumentation"> {
  constructor(
    private readonly database: SupportDatabase,
    private readonly settings: AiProviderSettingsService,
    private readonly codex: CodexSupportAgent,
    private readonly deepTools?: DeepInvestigationToolBroker,
  ) {}

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

  async investigateThread(
    input: InvestigationThreadInput,
    signal?: AbortSignal,
  ): Promise<InvestigationTurnResult> {
    const resolved = await this.settings.createAgentForTask("deep", this.codex);
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
    const observedRequestIds = new Set(toolResults.map((result) => result.requestId));
    const observedRequests = new Set(toolResults.map(toolRequestFingerprint));
    let durableSummary = input.durableSummary;
    let consecutiveStalledRounds = 0;
    const appendToolResult = async (execution: InvestigationToolResult): Promise<void> => {
      toolResults.push(execution);
      await input.onToolExecution?.(execution);
    };

    while (true) {
      signal?.throwIfAborted();
      const rawResult = await resolved.agent.investigateThread({
        ...input,
        durableSummary,
        availableTools,
        toolResults: boundedToolResultsForPrompt(toolResults),
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
        const descriptor = availableTools.find((tool) => tool.id === request.toolId);
        if (
          requiresCurrentOperatorConfirmation(descriptor, request) &&
          !hasCurrentOperatorConfirmation(request, input.currentOperatorMessageId)
        ) {
          await appendToolResult(connectedAppConfirmationRequiredResult(request));
          continue;
        }
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

      for (const request of pending) {
        signal?.throwIfAborted();
        if (this.deepTools) {
          const executions = await this.deepTools.executeMany([request], signal);
          for (const execution of executions) await appendToolResult(execution);
        } else {
          await appendToolResult(unavailableToolResult(request));
        }
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

function requiresCurrentOperatorConfirmation(
  descriptor: InvestigationToolDescriptor | undefined,
  request: InvestigationToolRequest,
): boolean {
  if (request.toolId === "threadmark-context") {
    return request.operation === "create_ticket_from_draft";
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
    normalizedArguments = JSON.stringify(JSON.parse(normalizedArguments));
  } catch {
    // The executor will return the typed validation error to the model.
  }
  return `${request.toolId}\u0000${request.operation}\u0000${normalizedArguments}`;
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
