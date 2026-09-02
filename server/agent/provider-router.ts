import type { SupportDatabase } from "../db/index.js";
import type { CodexSupportAgent } from "./codex-runner.js";
import type { AiProviderSettingsService } from "./provider-settings.js";
import type { SupportAgent } from "./provider.js";
import {
  isAffirmativePreviewConfirmation,
  isRetryInstruction,
} from "./confirmation-intent.js";
import {
  investigationExecutionPolicy,
  type InvestigationExecutionPolicy,
} from "./investigation-routing.js";
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
  ModelTokenUsage,
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
const DEFAULT_MAX_CODE_SEARCH_OPERATIONS = 6;
const MAX_PREMATURE_READONLY_BLOCK_RETRIES = 1;
const MAX_INTERNAL_TOOL_LOOP_CYCLES = 2;
const MAX_MODEL_CALLS_PER_INVESTIGATION = 10;
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

const EXPLICIT_MUTATION_INTENT = /\b(?:apag\p{L}*|aplic\p{L}*|arquiv\p{L}*|atribu\p{L}*|ativ\p{L}*|atualiz\p{L}*|cri(?:ar|e|a|ou|ado|ada)|edit\p{L}*|exclu\p{L}*|ger(?:ar|e|a|ou|ado|ada)|paus\p{L}*|public\p{L}*|salv\p{L}*|vincul\p{L}*|anex\p{L}*|abr(?:ir|a|e|iu))\b/iu;

function hasExplicitMutationIntent(input: InvestigationThreadInput): boolean {
  const directives = input.activeTask?.operatorDirectives.map((item) => item.body) ?? [];
  const text = [
    input.activeTask?.objective ?? "",
    ...directives,
    input.recentMessages.find((message) => message.id === input.currentOperatorMessageId)?.body ?? "",
  ].join("\n");
  return EXPLICIT_MUTATION_INTENT.test(text);
}

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
}

/** Routes each workload to its task-specific provider and records the executed model. */
export class ConfiguredSupportAgent implements Pick<SupportAgent, "analyse" | "triage" | "investigateThread" | "generateDocumentation" | "extractKnowledge"> {
  private readonly maxToolRounds: number;
  private readonly maxToolOperations: number;
  private readonly maxSameOperation: number;
  private readonly maxCodeSearchOperations: number;
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
    if (
      executionPolicy.workload === "deep" &&
      input.investigationReadiness?.deepInvestigationEnabled === false
    ) {
      return investigationOnboardingRequiredResult(input);
    }
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
      executionPolicy.workload,
      this.codex,
    );
    this.database
      .prepare(
        `UPDATE investigation_thread_jobs
         SET ai_provider_id = ?, ai_connection_id = ?, ai_model = ?,
             ai_workload = ?
         WHERE thread_id = ? AND state = 'running'`,
      )
      .run(
        resolved.connection.providerId,
        resolved.connection.id,
        resolved.profile.model,
        executionPolicy.workload,
        input.threadId,
    );
    const registeredTools = toolsForActivePack(
      this.deepTools?.descriptors() ?? [],
      input.activeInvestigationPack ?? null,
    );
    const availableTools = toolsForExecutionPolicy(
      registeredTools,
      executionPolicy,
    );
    let usesInternalToolLoop =
      executionPolicy.workload === "deep" &&
      resolved.connection.providerId === "codex" &&
      typeof this.codex.supportsInternalToolLoop === "function" &&
      this.codex.supportsInternalToolLoop() &&
      !hasExplicitMutationIntent(input) &&
      availableTools.length > 0;
    let internalToolLoopFallbackUsed = false;
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
      toolSupportsRequest(registeredTools, pendingConfirmation)
    ) {
      const executions = await this.deepTools.executeMany([pendingConfirmation], signal);
      for (const execution of executions) {
        toolResults.push(execution);
        await input.onToolExecution?.(execution);
        const completion = completedTicketActionResult(execution, toolResults);
        if (completion) return completion;
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
    let prematureReadonlyBlockRetries = 0;
    let readonlyContinuationRequired = false;
    let usedToolRounds = 0;
    let usedToolOperations = toolResults.length;
    let usedModelCalls = this.currentInvestigationModelCalls(input.threadId);
    let usedInternalToolLoopCycles = 0;
    const appendToolResult = async (execution: InvestigationToolResult): Promise<void> => {
      toolResults.push(execution);
      await input.onToolExecution?.(execution);
    };

    while (true) {
      signal?.throwIfAborted();
      if (usedModelCalls >= MAX_MODEL_CALLS_PER_INVESTIGATION) {
        return investigationModelCallBoundaryResult(toolResults, durableSummary);
      }
      const operationAvailableTools = availableToolsWithinBudget(
        availableTools,
        operationCounts,
        maxSameOperation,
        maxCodeSearchOperations,
      );
      const forceConclusion =
        usedModelCalls >= MAX_MODEL_CALLS_PER_INVESTIGATION - 1 ||
        usedToolRounds >= maxToolRounds ||
        usedToolOperations >= maxToolOperations ||
        (
          availableTools.length > 0 &&
          toolResults.length > 0 &&
          operationAvailableTools.length === 0
        );
      const rawResult = await resolved.agent.investigateThread({
        ...input,
        durableSummary,
        investigationState: workingInvestigationState(
          input.investigationState,
          toolResults,
        ),
        availableTools: forceConclusion ? [] : operationAvailableTools,
        toolResults: boundedToolResultsForPrompt(toolResults),
        executionBudget: {
          workload: executionPolicy.workload,
          promptMode: executionPolicy.promptMode,
          maxToolRounds,
          usedToolRounds,
          maxToolOperations,
          usedToolOperations,
          forceConclusion,
          toolProtocol: usesInternalToolLoop ? "mcp" : "coordinator",
          readonlyContinuationRequired,
        },
        onModelUsage: (usage) => {
          this.recordInvestigationUsage(input.threadId, usage);
        },
      }, signal);
      usedModelCalls += 1;
      if (usesInternalToolLoop) usedInternalToolLoopCycles += 1;
      signal?.throwIfAborted();
      const internalExecutions = rawResult.toolExecutions ?? [];
      if (internalExecutions.length) usedToolRounds += 1;
      for (const execution of internalExecutions) {
        if (observedRequestIds.has(execution.requestId)) continue;
        observedRequestIds.add(execution.requestId);
        observedRequests.add(toolRequestFingerprint(execution));
        observedSemanticRequests.add(semanticToolRequestFingerprint(execution));
        const key = toolOperationKey(execution);
        operationCounts.set(key, (operationCounts.get(key) ?? 0) + 1);
        usedToolOperations += 1;
        await appendToolResult(execution);
      }
      if (
        usesInternalToolLoop &&
        !internalExecutions.length &&
        !rawResult.toolRequests.length &&
        !forceConclusion &&
        !internalToolLoopFallbackUsed
      ) {
        usesInternalToolLoop = false;
        internalToolLoopFallbackUsed = true;
        readonlyContinuationRequired = true;
        durableSummary = checkpointSummary(rawResult.threadSummary);
        this.persistInvestigationCheckpoint(input.threadId, durableSummary);
        continue;
      }
      const causalForceConclusion =
        forceConclusion ||
        (
          usesInternalToolLoop &&
          usedInternalToolLoopCycles >= MAX_INTERNAL_TOOL_LOOP_CYCLES
        );
      const result = enforceCausalCompletion(
        suppressIrrelevantWhatsAppGuardrail(
          enforceVerifiedTechnicalEvidence(
            rawResult,
            toolResults,
            availableTools,
          ),
          input,
        ),
        input,
        toolResults,
        availableTools,
        causalForceConclusion,
      );
      this.persistInvestigationState(input, result, toolResults);
      if (!result.toolRequests.length) {
        if (
          result.phase === "needs_information" &&
          !causalForceConclusion &&
          prematureReadonlyBlockRetries < MAX_PREMATURE_READONLY_BLOCK_RETRIES &&
          hasAuthorizedReadonlyOperation(operationAvailableTools)
        ) {
          prematureReadonlyBlockRetries += 1;
          readonlyContinuationRequired = true;
          durableSummary = checkpointSummary(result.threadSummary);
          this.persistInvestigationCheckpoint(input.threadId, durableSummary);
          continue;
        }
        return {
          ...result,
          toolRequests: [],
          toolExecutions: compactToolExecutions(toolResults),
        };
      }
      if (causalForceConclusion) {
        return finalizeAtExecutionBoundary(result, toolResults);
      }

      readonlyContinuationRequired = false;

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
      prematureReadonlyBlockRetries = 0;

      const readonlyRequests = pending.filter((request) => {
        const descriptor = availableTools.find((tool) => tool.id === request.toolId);
        return resolveOperationPolicy(descriptor, request.operation).effect === "read";
      });
      const mutationRequests = pending.filter(
        (request) => !readonlyRequests.includes(request),
      );
      const readonlySettled = this.deepTools
        ? await Promise.allSettled(
            readonlyRequests.map(async (request) => {
              const executions = await this.deepTools!.executeMany([request], signal);
              for (const execution of executions) await appendToolResult(execution);
              const retry = recoverableReadonlyRetryRequest(executions, request);
              if (!retry) return executions;
              observedRequestIds.add(retry.requestId);
              observedRequests.add(toolRequestFingerprint(retry));
              observedSemanticRequests.add(semanticToolRequestFingerprint(retry));
              const retried = await this.deepTools!.executeMany([retry], signal);
              for (const execution of retried) await appendToolResult(execution);
              return [...executions, ...retried];
            }),
          )
        : await Promise.allSettled(
            readonlyRequests.map(async (request) => {
              const executions = [unavailableToolResult(request)];
              for (const execution of executions) await appendToolResult(execution);
              return executions;
            }),
          );
      const failedReadonly = readonlySettled.find(
        (settled): settled is PromiseRejectedResult => settled.status === "rejected",
      );
      if (failedReadonly) throw failedReadonly.reason;
      const readonlyExecutions = readonlySettled.flatMap((settled) =>
        settled.status === "fulfilled" ? [settled.value] : []
      );
      for (const executions of readonlyExecutions) usedToolOperations += executions.length;
      for (const request of mutationRequests) {
        signal?.throwIfAborted();
        const executions = this.deepTools
          ? await this.deepTools.executeMany([request], signal)
          : [unavailableToolResult(request)];
        for (const execution of executions) await appendToolResult(execution);
        usedToolOperations += executions.length;
        for (const execution of executions) {
          const authorizedFollowUp = authorizedDraftFollowUp(
            execution,
            input.currentOperatorMessageId,
            availableTools,
          );
          if (!authorizedFollowUp) continue;
          const followUpExecutions = this.deepTools
            ? await this.deepTools.executeMany([authorizedFollowUp], signal)
            : [unavailableToolResult(authorizedFollowUp)];
          for (const followUpExecution of followUpExecutions) {
            await appendToolResult(followUpExecution);
            const completion = completedTicketActionResult(followUpExecution, toolResults);
            if (completion) return completion;
          }
          usedToolOperations += followUpExecutions.length;
        }
      }
    }
  }

  private recordInvestigationUsage(
    threadId: string,
    usage: ModelTokenUsage,
  ): void {
    this.database.prepare(
      `UPDATE investigation_thread_jobs
       SET ai_model_calls = ai_model_calls + 1,
           ai_input_tokens = ai_input_tokens + ?,
           ai_cached_input_tokens = ai_cached_input_tokens + ?,
           ai_output_tokens = ai_output_tokens + ?,
           ai_reasoning_output_tokens = ai_reasoning_output_tokens + ?
       WHERE thread_id = ? AND state = 'running'`,
    ).run(
      usage.inputTokens,
      usage.cachedInputTokens,
      usage.outputTokens,
      usage.reasoningOutputTokens,
      threadId,
    );
  }

  private currentInvestigationModelCalls(threadId: string): number {
    const row = this.database.prepare(
      `SELECT ai_model_calls
       FROM investigation_thread_jobs
       WHERE thread_id = ? AND state = 'running'
       ORDER BY requested_at DESC
       LIMIT 1`,
    ).get(threadId) as { ai_model_calls: number } | undefined;
    return row?.ai_model_calls ?? 0;
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

  private persistInvestigationState(
    input: InvestigationThreadInput,
    result: InvestigationTurnResult,
    toolResults: InvestigationToolResult[],
  ): void {
    const threadExists = this.database.prepare(
      "SELECT 1 FROM investigation_threads WHERE id = ?",
    ).get(input.threadId);
    if (!threadExists) return;
    const now = new Date().toISOString();
    const outcome = result.outcome;
    const objective = input.activeTask?.objective ??
      input.recentMessages.find((message) => message.id === input.currentOperatorMessageId)?.body ??
      "Tarefa de investigação";
    const phase = result.phase === "conclusion"
      ? "concluded"
      : result.phase === "needs_information"
        ? "blocked"
        : toolResults.length > 0
          ? "investigating"
          : "planning";
    const state = {
      objective: objective.slice(0, 4_000),
      plan: input.activeInvestigationPack?.manifest.playbooks ?? [],
      facts: result.findings.filter((finding) => finding.kind === "fact"),
      hypotheses: result.findings.filter((finding) => finding.kind === "hypothesis"),
      missingInformation: result.findings.filter(
        (finding) => finding.kind === "missing_information",
      ),
      evidence: result.evidence,
      sourceCoverage: [...new Set(result.evidence.map((item) => item.source))],
      recoverableErrors: toolResults.flatMap((execution) =>
        execution.status === "error" && execution.error
          ? [{
              toolId: execution.toolId,
              operation: execution.operation,
              code: execution.error.code,
              retryable: execution.error.retryable,
            }]
          : []
      ),
      outcome: outcome ?? null,
      nextAction: result.nextAction,
      updatedAt: now,
    };
    this.database.prepare(
      `INSERT INTO investigation_thread_states (
         thread_id, pack_id, objective, phase, root_cause_status,
         causal_classification, state_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         pack_id = excluded.pack_id,
         objective = excluded.objective,
         phase = excluded.phase,
         root_cause_status = excluded.root_cause_status,
         causal_classification = excluded.causal_classification,
         state_json = excluded.state_json,
         updated_at = excluded.updated_at`,
    ).run(
      input.threadId,
      input.activeInvestigationPack?.id ?? null,
      objective.slice(0, 4_000),
      phase,
      outcome?.rootCauseStatus ?? "unknown",
      outcome?.causalClassification ?? "unknown",
      JSON.stringify(state),
      now,
      now,
    );
  }
}

export function toolsForExecutionPolicy(
  descriptors: InvestigationToolDescriptor[],
  policy: InvestigationExecutionPolicy,
): InvestigationToolDescriptor[] {
  if (policy.promptMode === "conversation") return [];
  return descriptors;
}

function toolsForActivePack(
  descriptors: InvestigationToolDescriptor[],
  pack: NonNullable<InvestigationThreadInput["activeInvestigationPack"]> | null,
): InvestigationToolDescriptor[] {
  const selected = new Set(pack?.manifest.selectedToolIds ?? []);
  if (!selected.size) return descriptors;
  return descriptors.filter(
    (descriptor) =>
      descriptor.id === "threadmark-context" ||
      descriptor.id === "threadmark-automations" ||
      descriptor.type === "connected_app" ||
      selected.has(descriptor.id) ||
      Boolean(descriptor.configurationId && selected.has(descriptor.configurationId)),
  );
}

function investigationOnboardingRequiredResult(
  input: InvestigationThreadInput,
): InvestigationTurnResult {
  const reason = input.investigationReadiness?.reason?.trim() ||
    "Conclua o onboarding e ative um pack privado para habilitar as ferramentas de investigação profunda.";
  return {
    assistantMessage:
      `A conversa básica está disponível, mas a investigação profunda deste workspace ainda não está pronta. ${reason}`,
    phase: "needs_information",
    threadSummary: "Investigação profunda aguardando onboarding e pack ativo.",
    findings: [{
      statement: reason,
      kind: "missing_information",
      evidenceReferences: [],
    }],
    evidence: [],
    suggestedResponse: null,
    nextAction:
      "Um proprietário ou administrador deve concluir o onboarding em Configurações > Ferramentas, testar as conexões e ativar o pack.",
    confidence: 1,
    outcome: {
      objectiveStatus: "unanswered",
      rootCauseStatus: "unknown",
      causalClassification: "unknown",
      rootCause: null,
      unresolvedCriticalQuestions: [reason],
      stopReason: "external_blocker",
    },
    toolRequests: [],
    toolExecutions: [],
  };
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

function authorizedDraftFollowUp(
  execution: InvestigationToolResult,
  currentOperatorMessageId: string,
  descriptors: InvestigationToolDescriptor[],
): InvestigationToolRequest | null {
  if (execution.status !== "success") return null;
  const descriptor = descriptors.find((item) => item.id === execution.toolId);
  const operation = descriptor?.operations.find((item) => item.name === execution.operation);
  const followUpOperation = operation?.automaticFollowUpOperation;
  if (!followUpOperation) return null;
  try {
    const preview = JSON.parse(execution.content) as {
      draftId?: unknown;
      executionAuthorized?: unknown;
    };
    if (preview.executionAuthorized !== true || typeof preview.draftId !== "string") {
      return null;
    }
    return {
      requestId: `auto-follow-up:${followUpOperation}:${preview.draftId}`,
      toolId: execution.toolId,
      operation: followUpOperation,
      argumentsJson: JSON.stringify({
        confirmationMessageId: currentOperatorMessageId,
        draftId: preview.draftId,
      }),
      purpose: "Concluir a ação explicitamente autorizada pela tarefa ativa.",
    };
  } catch {
    return null;
  }
}

function completedTicketActionResult(
  execution: InvestigationToolResult,
  toolResults: InvestigationToolResult[],
): InvestigationTurnResult | null {
  if (
    execution.toolId !== "threadmark-context" ||
    execution.status !== "success" ||
    !["create_ticket_from_draft", "apply_ticket_update_draft"].includes(execution.operation) ||
    !execution.reference
  ) {
    return null;
  }
  try {
    const content = JSON.parse(execution.content) as {
      ticket?: { number?: unknown; title?: unknown; internalUrl?: unknown };
    };
    const number = content.ticket?.number;
    if (typeof number !== "number") return null;
    const updated = execution.operation === "apply_ticket_update_draft";
    const title = typeof content.ticket?.title === "string" ? content.ticket.title : null;
    const action = updated ? "atualizado" : "criado";
    const statement = `Ticket #${number} ${action} no Threadmark${title ? `: ${title}` : "."}`;
    return {
      assistantMessage: statement,
      phase: "conclusion",
      threadSummary: statement,
      findings: [{
        statement,
        kind: "fact",
        evidenceReferences: [execution.reference],
      }],
      evidence: [{
        source: "knowledge",
        summary: execution.summary,
        reference: execution.reference,
      }],
      suggestedResponse: null,
      nextAction: null,
      confidence: 1,
      toolRequests: [],
      toolExecutions: compactToolExecutions(toolResults),
    };
  } catch {
    return null;
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
  if (
    !current ||
    (!isAffirmativePreviewConfirmation(current.body) && !isRetryInstruction(current.body))
  ) return null;

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

function suppressIrrelevantWhatsAppGuardrail(
  result: InvestigationTurnResult,
  input: Pick<
    InvestigationThreadInput,
    "activeTask" | "activeInvestigationPack" | "currentOperatorMessageId" | "recentMessages"
  >,
): InvestigationTurnResult {
  const currentMessage = input.recentMessages.find(
    (message) => message.id === input.currentOperatorMessageId,
  );
  const operatorContext = [
    currentMessage?.body ?? "",
    ...(input.activeTask?.operatorDirectives.map((directive) => directive.body) ?? []),
  ].join("\n");
  if (/\bwhatsapp\b/iu.test(operatorContext)) return result;

  const irrelevantGuardrail = (value: string): boolean =>
    (
      /\bwhatsapp\b/iu.test(value) &&
      /\b(?:outbound|inbound|envio|enviar|mensage(?:m|ns)|restri(?:cao|ção)|proibid[oa]|sem)\b/iu.test(value)
    ) ||
    /\bnunca\s+(?:envie|enviar)\s+mensage(?:m|ns)\b/iu.test(value);
  const clean = (value: string): string =>
    value
      .split(/(?<=[.!?])\s+|\n+/u)
      .filter((part) => part.trim() && !irrelevantGuardrail(part))
      .join("\n")
      .trim();

  const assistantMessage = clean(result.assistantMessage);
  const threadSummary = clean(result.threadSummary);
  const nextAction = result.nextAction ? clean(result.nextAction) : null;
  const findings = (result.findings ?? []).filter(
    (finding) => !irrelevantGuardrail(finding.statement),
  );
  return {
    ...result,
    assistantMessage: assistantMessage || "Tarefa processada com segurança.",
    threadSummary:
      threadSummary || "Tarefa processada com os resultados auditáveis disponíveis.",
    findings,
    nextAction,
  };
}

function requiresCurrentOperatorConfirmation(
  descriptor: InvestigationToolDescriptor | undefined,
  request: InvestigationToolRequest,
): boolean {
  return resolveOperationPolicy(descriptor, request.operation).authorization !== "none";
}

function resolveOperationPolicy(
  descriptor: InvestigationToolDescriptor | undefined,
  operationName: string,
): { effect: "read" | "prepare" | "write"; authorization: "none" | "task" } {
  const operation = descriptor?.operations.find((item) => item.name === operationName);
  if (operation?.effect) {
    return {
      effect: operation.effect,
      authorization: operation.authorization ?? (operation.effect === "write" ? "task" : "none"),
    };
  }
  if (/^prepare_/u.test(operationName)) return { effect: "prepare", authorization: "none" };
  if (/^(?:create|apply|update|delete|set|send|publish|execute_request|archive|remove|assign)_?/u.test(operationName)) {
    return { effect: "write", authorization: "task" };
  }
  return { effect: "read", authorization: "none" };
}

function hasAuthorizedReadonlyOperation(
  descriptors: InvestigationToolDescriptor[],
): boolean {
  return descriptors.some((descriptor) =>
    descriptor.operations.some((operation) =>
      resolveOperationPolicy(descriptor, operation.name).effect === "read"
    )
  );
}

function recoverableReadonlyRetryRequest(
  executions: InvestigationToolResult[],
  original: InvestigationToolRequest,
): InvestigationToolRequest | null {
  if (executions.length !== 1) return null;
  const execution = executions[0];
  const suggestedArgumentsJson = execution?.error?.suggestedArgumentsJson;
  if (
    !execution ||
    execution.status !== "error" ||
    execution.error?.retryable !== true ||
    !suggestedArgumentsJson
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(suggestedArgumentsJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  } catch {
    return null;
  }
  return {
    requestId: `${original.requestId.slice(0, 80)}:safe-retry`,
    toolId: original.toolId,
    operation: original.operation,
    argumentsJson: suggestedArgumentsJson,
    purpose:
      `Repetição automática readonly após ${execution.error.code}; argumentos corrigidos pelo executor confiável.`,
  };
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

function workingInvestigationState(
  previous: Record<string, unknown> | null | undefined,
  results: InvestigationToolResult[],
): Record<string, unknown> {
  return {
    ...(previous ?? {}),
    executionLedger: results.slice(-64).map((result) => ({
      requestId: result.requestId,
      toolId: result.toolId,
      operation: result.operation,
      status: result.status,
      summary: result.summary.slice(0, 1_000),
      reference: result.reference,
      error: result.error
        ? {
            code: result.error.code,
            category: result.error.category,
            retryable: result.error.retryable,
          }
        : null,
      executedAt: result.executedAt,
    })),
  };
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

function investigationModelCallBoundaryResult(
  toolResults: InvestigationToolResult[],
  durableSummary: string,
): InvestigationTurnResult {
  return {
    assistantMessage:
      "Ainda não confirmado: as leituras concluídas não foram suficientes para comprovar a causa raiz. As evidências encontradas foram preservadas para uma continuação focada.",
    phase: "needs_information",
    threadSummary: checkpointSummary(durableSummary),
    findings: [{
      statement:
        "As fontes consultadas ainda não distinguem com segurança a causa do sintoma observado.",
      kind: "missing_information",
      evidenceReferences: [],
    }],
    evidence: [],
    suggestedResponse: null,
    nextAction:
      "Informe o identificador ou período exato que falta para direcionar a próxima verificação.",
    confidence: 0.3,
    outcome: {
      objectiveStatus: "partially_answered",
      rootCauseStatus: "unknown",
      causalClassification: "unknown",
      rootCause: null,
      unresolvedCriticalQuestions: [
        "Qual identificador ou período exato permite concluir a verificação restante?",
      ],
      stopReason: "evidence_exhausted",
    },
    toolRequests: [],
    toolExecutions: compactToolExecutions(toolResults),
  };
}

export function boundedToolResultsForPrompt(
  results: InvestigationToolResult[],
): InvestigationToolResult[] {
  const selected: InvestigationToolResult[] = [];
  let remaining = MAX_TOOL_RESULT_PROMPT_TOTAL_CHARS;
  const successful = results
    .filter((result) => result.status === "success" && Boolean(result.reference))
    .slice(-(MAX_TOOL_RESULTS_IN_PROMPT - 3));
  const recentErrors = results
    .filter((result) => result.status === "error")
    .slice(-3);
  const prioritized = new Set([...successful, ...recentErrors]);
  const candidates = [...prioritized];
  if (candidates.length < MAX_TOOL_RESULTS_IN_PROMPT) {
    for (let index = results.length - 1; index >= 0; index -= 1) {
      const candidate = results[index]!;
      if (prioritized.has(candidate)) continue;
      candidates.push(candidate);
      if (candidates.length >= MAX_TOOL_RESULTS_IN_PROMPT) break;
    }
  }
  candidates.sort((left, right) => results.indexOf(left) - results.indexOf(right));
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
      result.status === "success" ? MAX_SINGLE_TOOL_CONTENT_PROMPT_CHARS : 1_000,
      remaining - metadataChars,
    );
    compact.content = truncateToolContentForPrompt(result.content, contentLimit);
    remaining -= metadataChars + compact.content.length;
    selected.unshift(compact);
  }
  return selected;
}

export function availableToolsWithinBudget(
  descriptors: InvestigationToolDescriptor[],
  operationCounts: Map<string, number>,
  maxSameOperation: number,
  maxCodeSearchOperations: number,
): InvestigationToolDescriptor[] {
  return descriptors.flatMap((descriptor) => {
    const operations = descriptor.operations.filter((operation) => {
      const limit = descriptor.type === "codebase" && operation.name === "search_files"
        ? maxCodeSearchOperations
        : maxSameOperation;
      const count = operationCounts.get(toolOperationKey({
        toolId: descriptor.id,
        operation: operation.name,
      })) ?? 0;
      return count < limit;
    });
    return operations.length ? [{ ...descriptor, operations }] : [];
  });
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

function finalizeAtExecutionBoundary(
  result: InvestigationTurnResult,
  toolResults: InvestigationToolResult[],
): InvestigationTurnResult {
  const hasVerifiedEvidence = result.evidence.some((evidence) => evidence.reference) ||
    result.findings?.some((finding) =>
      finding.kind !== "hypothesis" && finding.kind !== "missing_information" &&
      finding.evidenceReferences.length > 0
    ) === true;
  const internalLimitPattern = /\b(?:orcamento|orçamento|limite|budget|tool rounds?|operacoes? disponiveis?)\b/iu;
  const assistantMessage = internalLimitPattern.test(result.assistantMessage)
    ? hasVerifiedEvidence
      ? "Concluí esta etapa com as evidências verificadas disponíveis. Os pontos ainda não confirmados permanecem identificados como lacunas."
      : "Não foi possível confirmar a causa com as evidências disponíveis nesta etapa."
    : result.assistantMessage;
  const nextAction = result.nextAction && !internalLimitPattern.test(result.nextAction)
    ? result.nextAction
    : hasVerifiedEvidence
      ? "Revisar as lacunas não verificadas antes de executar qualquer alteração."
      : "Fornecer a menor informação indispensável que não pôde ser localizada nas fontes autorizadas.";
  return {
    ...result,
    assistantMessage,
    phase: hasVerifiedEvidence ? "conclusion" : "needs_information",
    nextAction,
    confidence: hasVerifiedEvidence ? result.confidence : Math.min(result.confidence, 0.5),
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

function truncateToolContentForPrompt(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const firstMarker = "\n[… trecho intermediário selecionado …]\n";
  const secondMarker = "\n[… final do resultado …]\n";
  const available = Math.max(0, limit - firstMarker.length - secondMarker.length);
  const chunkLength = Math.floor(available / 3);
  const middleStart = Math.max(0, Math.floor((value.length - chunkLength) / 2));
  return [
    value.slice(0, chunkLength),
    firstMarker,
    value.slice(middleStart, middleStart + chunkLength),
    secondMarker,
    value.slice(-chunkLength),
  ].join("");
}

function enforceVerifiedTechnicalEvidence(
  result: InvestigationTurnResult,
  executions: InvestigationToolResult[],
  descriptors: InvestigationToolDescriptor[],
): InvestigationTurnResult {
  type EvidenceSource = InvestigationTurnResult["evidence"][number]["source"];
  const descriptorsById = new Map(
    descriptors.map((descriptor) => [descriptor.id, descriptor] as const),
  );
  const successfulSourcesByReference = new Map<string, Set<EvidenceSource>>();
  for (const execution of executions) {
    if (execution.status !== "success" || !execution.reference) continue;
    const descriptor = descriptorsById.get(execution.toolId);
    if (!descriptor || descriptor.type === "debugger_skill") continue;
    const source = TOOL_EVIDENCE_SOURCE[descriptor.type] as EvidenceSource;
    const sources = successfulSourcesByReference.get(execution.reference) ?? new Set<EvidenceSource>();
    sources.add(source);
    successfulSourcesByReference.set(execution.reference, sources);
  }
  const normalizedEvidence = result.evidence.map((evidence) => {
    if (!evidence.reference) return evidence;
    const verifiedSources = successfulSourcesByReference.get(evidence.reference);
    if (!verifiedSources || verifiedSources.size !== 1) return evidence;
    const [verifiedSource] = verifiedSources;
    return verifiedSource === evidence.source
      ? evidence
      : { ...evidence, source: verifiedSource };
  });
  const normalizedResult = normalizedEvidence.every(
    (evidence, index) => evidence === result.evidence[index],
  )
    ? result
    : { ...result, evidence: normalizedEvidence };
  const invalidTechnicalEvidence = normalizedResult.evidence.filter(
    (evidence) => {
      if (!TECHNICAL_EVIDENCE_SOURCES.has(evidence.source)) return false;
      if (!evidence.reference) return true;
      return !successfulSourcesByReference
        .get(evidence.reference)
        ?.has(evidence.source);
    },
  );
  if (!invalidTechnicalEvidence.length) return normalizedResult;

  const verifiedEvidence = normalizedResult.evidence.filter(
    (evidence) => !invalidTechnicalEvidence.includes(evidence),
  );
  const blocksOperationalResponse =
    normalizedResult.phase === "conclusion" || Boolean(normalizedResult.suggestedResponse);
  return {
    ...normalizedResult,
    assistantMessage:
      "A orientação técnica não foi liberada porque as referências apresentadas não correspondem a uma execução local concluída com sucesso.",
    phase: blocksOperationalResponse ? "needs_information" : normalizedResult.phase,
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
    confidence: Math.min(normalizedResult.confidence, 0.5),
    toolRequests: blocksOperationalResponse ? [] : normalizedResult.toolRequests,
  };
}

export function enforceCausalCompletion(
  result: InvestigationTurnResult,
  input: Pick<
    InvestigationThreadInput,
    "activeTask" | "activeInvestigationPack" | "currentOperatorMessageId" | "recentMessages"
  >,
  executions: InvestigationToolResult[],
  descriptors: InvestigationToolDescriptor[],
  forceConclusion = false,
): InvestigationTurnResult {
  const outcome = result.outcome;
  // Legacy/custom agents created before the causal contract remain compatible.
  // Every bundled provider schema now requires this object.
  if (!outcome || !requiresRootCauseInvestigation(input)) return result;

  const descriptorById = new Map(
    descriptors.map((descriptor) => [descriptor.id, descriptor] as const),
  );
  const technicalReferences = new Set(
    executions.flatMap((execution) => {
      if (execution.status !== "success" || !execution.reference) return [];
      const descriptor = descriptorById.get(execution.toolId);
      if (!descriptor || descriptor.type === "knowledge" || descriptor.type === "debugger_skill") {
        return [];
      }
      return [execution.reference];
    }),
  );
  const declaredRootCauseReferences = new Set(
    outcome.rootCauseEvidenceReferences ?? [],
  );
  const causalFacts = result.findings.filter(
    (finding) =>
      finding.kind === "fact" &&
      finding.evidenceReferences.some((reference) =>
        declaredRootCauseReferences.has(reference) && technicalReferences.has(reference)
      ),
  );
  const technicalSourceByReference = new Map(
    executions.flatMap((execution) => {
      if (execution.status !== "success" || !execution.reference) return [];
      const descriptor = descriptorById.get(execution.toolId);
      if (!descriptor || descriptor.type === "knowledge" || descriptor.type === "debugger_skill") {
        return [];
      }
      return [[execution.reference, descriptor.type] as const];
    }),
  );
  const causalSourceTypes = new Set(
    [...declaredRootCauseReferences].flatMap((reference) => {
      const source = technicalSourceByReference.get(reference);
      return source ? [source] : [];
    }),
  );
  const requiredIndependentSources = Math.max(
    2,
    Math.min(
      3,
      input.activeInvestigationPack?.manifest.sourcePolicy.minimumIndependentSources ?? 2,
    ),
  );
  const confirmed =
    outcome.objectiveStatus === "answered" &&
    outcome.rootCauseStatus === "confirmed" &&
    outcome.causalClassification !== "unknown" &&
    outcome.causalClassification !== "not_applicable" &&
    Boolean(outcome.rootCause?.trim()) &&
    outcome.stopReason === "cause_confirmed" &&
    causalFacts.length > 0 &&
    causalSourceTypes.size >= requiredIndependentSources;
  const probableAfterExhaustion =
    outcome.objectiveStatus !== "unanswered" &&
    outcome.rootCauseStatus === "probable" &&
    Boolean(outcome.rootCause?.trim()) &&
    outcome.stopReason === "evidence_exhausted" &&
    causalFacts.length > 0;

  if (confirmed || probableAfterExhaustion) {
    const prefix = confirmed ? "Motivo confirmado:" : "Causa mais provável:";
    const assistantMessage = new RegExp(`^${prefix}`, "iu").test(result.assistantMessage.trim())
      ? result.assistantMessage
      : `${prefix} ${outcome.rootCause!.trim()}\n\n${result.assistantMessage.trim()}`;
    return {
      ...result,
      assistantMessage,
      phase: "conclusion",
      toolRequests: [],
    };
  }

  const missing = outcome.unresolvedCriticalQuestions.length
    ? outcome.unresolvedCriticalQuestions
    : ["A evidência atual ainda não diferencia a causa raiz do sintoma observado."];
  const canContinueReadonly = !forceConclusion && hasAuthorizedReadonlyOperation(descriptors);
  const readonlyToolRequests = canContinueReadonly
    ? result.toolRequests.filter((request) =>
        resolveOperationPolicy(
          descriptorById.get(request.toolId),
          request.operation,
        ).effect === "read"
      )
    : [];
  const willContinueReadonly = readonlyToolRequests.length > 0;
  const downgradedRootCauseStatus =
    Boolean(outcome.rootCause?.trim()) && technicalReferences.size > 0
      ? "probable" as const
      : "unknown" as const;
  if (!canContinueReadonly && downgradedRootCauseStatus === "probable") {
    const originalDetail = result.assistantMessage
      .trim()
      .replace(/^Motivo confirmado:\s*/iu, "");
    return {
      ...result,
      assistantMessage:
        `Causa mais provável: ${outcome.rootCause!.trim()}\n\n${originalDetail}`,
      phase: "conclusion",
      findings: [
        ...result.findings.filter((finding) => finding.kind !== "missing_information"),
        ...missing.slice(0, 5).map((statement) => ({
          statement,
          kind: "missing_information" as const,
          evidenceReferences: [],
        })),
      ],
      nextAction: result.nextAction ?? missing[0]!,
      confidence: Math.min(result.confidence, 0.75),
      outcome: {
        ...outcome,
        objectiveStatus: outcome.objectiveStatus === "answered"
          ? "partially_answered"
          : outcome.objectiveStatus,
        rootCauseStatus: "probable",
        rootCauseEvidenceReferences: [...declaredRootCauseReferences].filter(
          (reference) => technicalReferences.has(reference),
        ),
        unresolvedCriticalQuestions: missing,
        stopReason: "evidence_exhausted",
      },
      toolRequests: [],
    };
  }
  return {
    ...result,
    assistantMessage: canContinueReadonly
      ? "Ainda não confirmado: a investigação encontrou sinais do problema, mas ainda não comprovou a causa raiz. Vou continuar pelas fontes readonly disponíveis."
      : `Ainda não confirmado: as evidências disponíveis não comprovam a causa raiz.\n\n${result.assistantMessage
        .trim()
        .replace(/^(?:Motivo confirmado|Causa mais provável|Ainda não confirmado):\s*/iu, "")}`,
    phase: willContinueReadonly ? "analysis" : "needs_information",
    findings: [
      ...result.findings.filter((finding) => finding.kind !== "missing_information"),
      ...missing.slice(0, 5).map((statement) => ({
        statement,
        kind: "missing_information" as const,
        evidenceReferences: [],
      })),
    ],
    suggestedResponse: null,
    nextAction: canContinueReadonly
      ? "Cruzar a próxima fonte readonly capaz de confirmar ou eliminar a hipótese causal."
      : missing[0]!,
    confidence: Math.min(result.confidence, probableAfterExhaustion ? 0.75 : 0.55),
    outcome: {
      ...outcome,
      objectiveStatus: outcome.objectiveStatus === "answered"
        ? "partially_answered"
        : outcome.objectiveStatus,
      rootCauseStatus: downgradedRootCauseStatus,
      causalClassification: downgradedRootCauseStatus === "probable"
        ? outcome.causalClassification
        : "unknown",
      rootCause: downgradedRootCauseStatus === "probable" ? outcome.rootCause : null,
      unresolvedCriticalQuestions: missing,
      stopReason: "evidence_exhausted",
    },
    toolRequests: readonlyToolRequests,
  };
}

function requiresRootCauseInvestigation(
  input: Pick<
    InvestigationThreadInput,
    "activeTask" | "currentOperatorMessageId" | "recentMessages"
  >,
): boolean {
  const current = input.recentMessages.find(
    (message) => message.id === input.currentOperatorMessageId,
  )?.body ?? "";
  const task = input.activeTask?.operatorDirectives.map((item) => item.body).join("\n") ?? "";
  return /\b(?:investig\p{L}*|diagnostic\p{L}*|causa|motivo|por\s+que|porque|raiz|falh\p{L}*|erro|problema|nao\s+(?:envi\p{L}*|carreg\p{L}*|aparec\p{L}*|funcion\p{L}*)|não\s+(?:envi\p{L}*|carreg\p{L}*|aparec\p{L}*|funcion\p{L}*)|sem\s+(?:dados|produtos?|mensagens?))\b/iu
    .test(`${current}\n${task}`);
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
