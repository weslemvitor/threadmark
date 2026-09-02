import assert from "node:assert/strict";
import test from "node:test";

import type { CodexSupportAgent } from "../server/agent/codex-runner.js";
import type { AiProviderSettingsService } from "../server/agent/provider-settings.js";
import {
  availableToolsWithinBudget,
  boundedToolResultsForPrompt,
  ConfiguredSupportAgent,
  enforceCausalCompletion,
  toolsForExecutionPolicy,
  type DeepInvestigationToolBroker,
} from "../server/agent/provider-router.js";
import type { SupportAgent } from "../server/agent/provider.js";
import { investigationExecutionPolicy } from "../server/agent/investigation-routing.js";
import type {
  InvestigationThreadInput,
  InvestigationToolDescriptor,
  InvestigationToolRequest,
  InvestigationToolResult,
} from "../server/agent/types.js";
import { createDatabase } from "../server/db/index.js";

function input(): InvestigationThreadInput {
  return {
    threadId: "thread-tools",
    currentOperatorMessageId: "operator-1",
    durableSummary: "",
    recentMessages: [{
      id: "operator-1",
      role: "operator",
      body: "Confirme a regra no código.",
      phase: null,
      createdAt: "2026-07-18T20:00:00.000Z",
    }],
    ticket: {
      ticketId: "ticket-tools",
      accountName: "Cliente",
      accountType: "ecommerce",
      groupName: "Suporte",
      knownEcommerces: [],
      conversationState: {
        lastExternalMessageAt: null,
        lastSentResponseAt: null,
        unansweredExternalMessageIds: [],
        hasUnansweredExternalMessages: false,
      },
      messages: [],
      sentResponses: [],
      openTickets: [],
      resolvedPrecedents: [],
    },
    automaticInvestigation: null,
  };
}

function settingsForDeepAgent(agent: SupportAgent): AiProviderSettingsService {
  return {
    async createAgentForTask() {
      return {
        agent,
        profile: {
          taskKind: "deep" as const,
          connectionId: "codex",
          model: "default",
          enabled: true,
          updatedAt: "2026-07-20T14:00:00.000Z",
        },
        connection: {
          id: "codex",
          label: "Codex",
          providerId: "codex" as const,
          baseUrl: null,
          enabled: true,
          hasSecret: false,
          secretLastFour: null,
          capabilities: {
            automaticAnalysis: true,
            triage: true,
            structuredOutput: true,
            vision: true,
            localTools: false,
            codebaseAccess: false,
            deepInvestigation: true,
          },
          createdAt: "2026-07-20T14:00:00.000Z",
          updatedAt: "2026-07-20T14:00:00.000Z",
        },
      };
    },
  } as unknown as AiProviderSettingsService;
}

test("investigação profunda orienta onboarding sem impedir a conversa básica", async () => {
  const database = createDatabase(":memory:");
  let providerCalled = false;
  const settings = {
    async createAgentForTask() {
      providerCalled = true;
      throw new Error("o provedor não deveria ser chamado antes do onboarding");
    },
  } as unknown as AiProviderSettingsService;
  const configured = new ConfiguredSupportAgent(
    database,
    settings,
    {} as CodexSupportAgent,
  );
  const blockedInput = input();
  blockedInput.recentMessages[0]!.body =
    "Investigue no banco e nos logs por que o processamento falhou.";
  blockedInput.investigationReadiness = {
    deepInvestigationEnabled: false,
    reason: "Ative um pack privado validado.",
  };

  try {
    const result = await configured.investigateThread(blockedInput);
    assert.equal(providerCalled, false);
    assert.equal(result.phase, "needs_information");
    assert.match(result.assistantMessage, /conversa básica está disponível/i);
    assert.match(result.assistantMessage, /Ative um pack privado validado/i);
    assert.equal(result.outcome?.stopReason, "external_blocker");
  } finally {
    database.close();
  }
});

test("loop MCP tenta uma síntese final antes de rebaixar confirmação sem duas referências diretas", async () => {
  const database = createDatabase(":memory:");
  let modelCalls = 0;
  let externalBrokerCalls = 0;
  const audited: InvestigationToolResult[] = [];
  const databaseResult: InvestigationToolResult = {
    requestId: "mcp-db",
    toolId: "db-mcp",
    toolName: "Banco readonly",
    operation: "query_readonly",
    argumentsJson: '{"query":"SELECT reason FROM failures LIMIT 1"}',
    purpose: "Confirmar o motivo persistido.",
    status: "success",
    summary: "Motivo consultado.",
    content: "reason=missing_configuration",
    reference: "tool:db:mcp-db",
    executedAt: "2026-09-01T16:00:00.000Z",
  };
  const awsResult: InvestigationToolResult = {
    requestId: "mcp-aws",
    toolId: "aws-mcp",
    toolName: "CloudWatch readonly",
    operation: "query_logs",
    argumentsJson: '{"query":"missing_configuration"}',
    purpose: "Cruzar o motivo nos logs.",
    status: "success",
    summary: "Logs consultados.",
    content: "delivery blocked: missing_configuration",
    reference: "tool:aws:mcp-aws",
    executedAt: "2026-09-01T16:00:01.000Z",
  };
  const modelAgent = {
    async investigateThread(current: InvestigationThreadInput) {
      modelCalls += 1;
      assert.equal(current.executionBudget?.toolProtocol, "mcp");
      return {
        assistantMessage:
          "Motivo confirmado: a configuração obrigatória ausente bloqueou a entrega.",
        phase: "conclusion" as const,
        threadSummary: "Causa confirmada no banco e nos logs.",
        findings: [{
          statement: "A configuração obrigatória estava ausente.",
          kind: "fact" as const,
          evidenceReferences: [databaseResult.reference!, awsResult.reference!],
        }],
        evidence: [
          { source: "database" as const, summary: "Motivo persistido.", reference: databaseResult.reference },
          { source: "aws" as const, summary: "Bloqueio registrado.", reference: awsResult.reference },
        ],
        suggestedResponse: null,
        nextAction: "Cadastrar a configuração obrigatória.",
        confidence: 0.95,
        outcome: {
          objectiveStatus: "answered" as const,
          rootCauseStatus: "confirmed" as const,
          causalClassification: "configuration" as const,
          rootCause: "A configuração obrigatória ausente bloqueou a entrega.",
          rootCauseEvidenceReferences: [databaseResult.reference!],
          unresolvedCriticalQuestions: [],
          stopReason: "cause_confirmed" as const,
        },
        toolRequests: [],
        toolExecutions: [databaseResult, awsResult],
      };
    },
  } as unknown as SupportAgent;
  const descriptors: InvestigationToolDescriptor[] = [
    {
      id: "db-mcp",
      name: "Banco readonly",
      type: "postgres_readonly",
      description: null,
      scope: "teste",
      operations: [{
        name: "query_readonly",
        description: "Consulta SQL readonly.",
        argumentsExample: "{}",
        effect: "read",
      }],
    },
    {
      id: "aws-mcp",
      name: "CloudWatch readonly",
      type: "aws_cloudwatch",
      description: null,
      scope: "teste",
      operations: [{
        name: "query_logs",
        description: "Consulta logs.",
        argumentsExample: "{}",
        effect: "read",
      }],
    },
  ];
  const broker: DeepInvestigationToolBroker = {
    descriptors: () => descriptors,
    async executeMany() {
      externalBrokerCalls += 1;
      return [];
    },
  };
  const configured = new ConfiguredSupportAgent(
    database,
    settingsForDeepAgent(modelAgent),
    { supportsInternalToolLoop: () => true } as unknown as CodexSupportAgent,
    broker,
  );
  const current = input();
  current.recentMessages[0]!.body =
    "Investigue no banco e nos logs por que a campanha não enviou.";
  current.onToolExecution = async (result) => {
    audited.push(result);
  };

  try {
    const result = await configured.investigateThread(current);
    assert.equal(modelCalls, 2);
    assert.equal(externalBrokerCalls, 0);
    assert.equal(audited.length, 2);
    assert.equal(result.phase, "conclusion");
    assert.equal(result.outcome?.rootCauseStatus, "probable");
    assert.match(result.assistantMessage, /^Causa mais provável:/);
    assert.deepEqual(result.toolExecutions?.map((item) => item.requestId), [
      "mcp-db",
      "mcp-aws",
    ]);
  } finally {
    database.close();
  }
});

test("loop MCP retoma uma vez quando a primeira execução termina em estado intermediário", async () => {
  const database = createDatabase(":memory:");
  let modelCalls = 0;
  let externalBrokerCalls = 0;
  const databaseResult: InvestigationToolResult = {
    requestId: "mcp-network-db",
    toolId: "db-mcp",
    toolName: "Banco readonly",
    operation: "query_readonly",
    argumentsJson: '{"query":"SELECT network_blocked FROM stores LIMIT 1"}',
    purpose: "Confirmar o estado persistido da loja.",
    status: "success",
    summary: "Estado persistido consultado.",
    content: "network_blocked=true",
    reference: "tool:db:mcp-network",
    executedAt: "2026-09-02T16:00:00.000Z",
  };
  const logResult: InvestigationToolResult = {
    requestId: "mcp-network-log",
    toolId: "aws-mcp",
    toolName: "CloudWatch readonly",
    operation: "query_logs",
    argumentsJson: '{"query":"network blocked"}',
    purpose: "Cruzar o bloqueio com a tentativa real.",
    status: "success",
    summary: "Tentativa bloqueada localizada.",
    content: "request rejected by network policy",
    reference: "tool:aws:mcp-network",
    executedAt: "2026-09-02T16:00:01.000Z",
  };
  const modelAgent = {
    async investigateThread(current: InvestigationThreadInput) {
      modelCalls += 1;
      assert.equal(current.executionBudget?.toolProtocol, "mcp");
      if (modelCalls === 1) {
        return {
          assistantMessage: "Ainda não confirmado: encontrei o bloqueio configurado e vou confrontar a execução.",
          phase: "analysis" as const,
          threadSummary: "Bloqueio persistido confirmado; falta confrontar os logs.",
          findings: [{
            statement: "A loja está marcada com bloqueio de rede.",
            kind: "fact" as const,
            evidenceReferences: [databaseResult.reference!],
          }],
          evidence: [{
            source: "database" as const,
            summary: databaseResult.summary,
            reference: databaseResult.reference,
          }],
          suggestedResponse: null,
          nextAction: "Confrontar a tentativa nos logs.",
          confidence: 0.55,
          outcome: {
            objectiveStatus: "partially_answered" as const,
            rootCauseStatus: "unknown" as const,
            causalClassification: "unknown" as const,
            rootCause: null,
            rootCauseEvidenceReferences: [],
            unresolvedCriticalQuestions: ["O bloqueio impediu uma tentativa real?"],
            stopReason: "evidence_exhausted" as const,
          },
          toolRequests: [],
          toolExecutions: [databaseResult],
        };
      }
      assert.equal(current.executionBudget?.readonlyContinuationRequired, true);
      return {
        assistantMessage: "Motivo confirmado: a política de rede ativa rejeitou a tentativa da loja.",
        phase: "conclusion" as const,
        threadSummary: "Bloqueio confirmado no estado persistido e nos logs.",
        findings: [{
          statement: "A política de rede ativa rejeitou a tentativa da loja.",
          kind: "fact" as const,
          evidenceReferences: [databaseResult.reference!, logResult.reference!],
        }],
        evidence: [{
          source: "database" as const,
          summary: databaseResult.summary,
          reference: databaseResult.reference,
        }, {
          source: "aws" as const,
          summary: logResult.summary,
          reference: logResult.reference,
        }],
        suggestedResponse: null,
        nextAction: "Orientar a liberação da política de rede.",
        confidence: 0.96,
        outcome: {
          objectiveStatus: "answered" as const,
          rootCauseStatus: "confirmed" as const,
          causalClassification: "configuration" as const,
          rootCause: "A política de rede ativa rejeitou a tentativa da loja.",
          rootCauseEvidenceReferences: [databaseResult.reference!, logResult.reference!],
          unresolvedCriticalQuestions: [],
          stopReason: "cause_confirmed" as const,
        },
        toolRequests: [],
        toolExecutions: [logResult],
      };
    },
  } as unknown as SupportAgent;
  const broker: DeepInvestigationToolBroker = {
    descriptors: () => [{
      id: "db-mcp",
      name: "Banco readonly",
      type: "postgres_readonly",
      description: null,
      scope: "teste",
      operations: [{
        name: "query_readonly",
        description: "Consulta SQL readonly.",
        argumentsExample: "{}",
        effect: "read",
      }],
    }, {
      id: "aws-mcp",
      name: "CloudWatch readonly",
      type: "aws_cloudwatch",
      description: null,
      scope: "teste",
      operations: [{
        name: "query_logs",
        description: "Consulta logs readonly.",
        argumentsExample: "{}",
        effect: "read",
      }],
    }],
    async executeMany() {
      externalBrokerCalls += 1;
      return [];
    },
  };
  const configured = new ConfiguredSupportAgent(
    database,
    settingsForDeepAgent(modelAgent),
    { supportsInternalToolLoop: () => true } as unknown as CodexSupportAgent,
    broker,
  );
  const current = input();
  current.recentMessages[0]!.body =
    "A Maloa está com problema de bloqueio de rede, como podemos ajudar ela a resolver? Ela diz que não tem, mas ficou claro que tem.";

  try {
    const result = await configured.investigateThread(current);
    assert.equal(modelCalls, 2);
    assert.equal(externalBrokerCalls, 0);
    assert.equal(result.phase, "conclusion");
    assert.equal(result.outcome?.rootCauseStatus, "confirmed");
    assert.deepEqual(result.toolExecutions?.map((item) => item.requestId), [
      "mcp-network-db",
      "mcp-network-log",
    ]);
  } finally {
    database.close();
  }
});

test("loop MCP sem execução real recua uma vez para o coordenador tipado", async () => {
  const database = createDatabase(":memory:");
  let modelCalls = 0;
  let brokerCalls = 0;
  const modelAgent = {
    async investigateThread(current: InvestigationThreadInput) {
      modelCalls += 1;
      if (modelCalls === 1) {
        assert.equal(current.executionBudget?.toolProtocol, "mcp");
        return {
          assistantMessage: "Ainda não confirmado: a leitura técnica não ocorreu.",
          phase: "needs_information" as const,
          threadSummary: "MCP não executou leituras.",
          findings: [], evidence: [], suggestedResponse: null,
          nextAction: "Consultar o código.", confidence: 0.2,
          outcome: {
            objectiveStatus: "partially_answered" as const,
            rootCauseStatus: "unknown" as const,
            causalClassification: "unknown" as const,
            rootCause: null,
            unresolvedCriticalQuestions: ["Qual regra foi aplicada?"],
            stopReason: "external_blocker" as const,
          },
          toolRequests: [],
        };
      }
      assert.equal(current.executionBudget?.toolProtocol, "coordinator");
      if (!(current.toolResults?.length)) {
        return {
          assistantMessage: "Vou consultar a regra.",
          phase: "analysis" as const,
          threadSummary: "Fallback coordenado ativo.",
          findings: [], evidence: [], suggestedResponse: null,
          nextAction: "Ler código.", confidence: 0.4,
          outcome: {
            objectiveStatus: "partially_answered" as const,
            rootCauseStatus: "unknown" as const,
            causalClassification: "unknown" as const,
            rootCause: null,
            unresolvedCriticalQuestions: ["Qual regra foi aplicada?"],
            stopReason: "not_applicable" as const,
          },
          toolRequests: [{
            requestId: "fallback-code",
            toolId: "code-fallback",
            operation: "read_files",
            argumentsJson: '{"paths":["rule.ts"]}',
            purpose: "Confirmar a regra.",
          }],
        };
      }
      const reference = current.toolResults[0]!.reference!;
      return {
        assistantMessage: "Causa mais provável: a regra lida explica o comportamento.",
        phase: "conclusion" as const,
        threadSummary: "Regra confirmada por leitura auditada.",
        findings: [{ statement: "A regra explica o comportamento.", kind: "fact" as const, evidenceReferences: [reference] }],
        evidence: [{ source: "code" as const, summary: "Regra lida.", reference }],
        suggestedResponse: null, nextAction: null, confidence: 0.8,
        outcome: {
          objectiveStatus: "answered" as const,
          rootCauseStatus: "probable" as const,
          causalClassification: "code" as const,
          rootCause: "A regra lida explica o comportamento.",
          unresolvedCriticalQuestions: [],
          stopReason: "evidence_exhausted" as const,
        },
        toolRequests: [],
      };
    },
  } as unknown as SupportAgent;
  const broker: DeepInvestigationToolBroker = {
    descriptors: () => [{
      id: "code-fallback",
      name: "Código readonly",
      type: "codebase",
      description: null,
      scope: "teste",
      operations: [{
        name: "read_files",
        description: "Lê arquivos.",
        argumentsExample: "{}",
        effect: "read",
      }],
    }],
    async executeMany([request]) {
      brokerCalls += 1;
      return [{
        ...request!,
        toolName: "Código readonly",
        status: "success",
        summary: "Regra lida.",
        content: "RULE=true",
        reference: "tool:code:fallback",
        executedAt: "2026-09-01T16:00:00.000Z",
      }];
    },
  };
  const configured = new ConfiguredSupportAgent(
    database,
    settingsForDeepAgent(modelAgent),
    { supportsInternalToolLoop: () => true } as unknown as CodexSupportAgent,
    broker,
  );

  try {
    const result = await configured.investigateThread(input());
    assert.equal(modelCalls, 3);
    assert.equal(brokerCalls, 1);
    assert.equal(result.phase, "conclusion");
    assert.equal(result.toolExecutions?.[0]?.requestId, "fallback-code");
  } finally {
    database.close();
  }
});

test("intenção explícita de mutação permanece no coordenador autorizado", async () => {
  const database = createDatabase(":memory:");
  const modelAgent = {
    async investigateThread(current: InvestigationThreadInput) {
      assert.equal(current.executionBudget?.toolProtocol, "coordinator");
      return {
        assistantMessage: "Vou manter a atualização no fluxo autorizado.",
        phase: "conclusion" as const,
        threadSummary: "Mutação roteada pelo coordenador.",
        findings: [], evidence: [], suggestedResponse: null,
        nextAction: null, confidence: 0.8, toolRequests: [],
      };
    },
  } as unknown as SupportAgent;
  const broker: DeepInvestigationToolBroker = {
    descriptors: () => [{
      id: "context",
      name: "Contexto",
      type: "knowledge",
      description: null,
      scope: "teste",
      operations: [{ name: "read_files", description: "Lê.", argumentsExample: "{}", effect: "read" }],
    }],
    async executeMany() { return []; },
  };
  const configured = new ConfiguredSupportAgent(
    database,
    settingsForDeepAgent(modelAgent),
    { supportsInternalToolLoop: () => true } as unknown as CodexSupportAgent,
    broker,
  );
  const current = input();
  current.recentMessages[0]!.body = "Investigue o caso e atualize o ticket com o resultado.";

  try {
    await configured.investigateThread(current);
  } finally {
    database.close();
  }
});

test("conversa trivial usa o perfil rápido do provedor sem ferramentas", async () => {
  const database = createDatabase(":memory:");
  database.prepare(`
    INSERT INTO investigation_threads (
      id, scope, title, created_by, created_at, updated_at
    ) VALUES ('thread-tools', 'workspace', 'Conversa trivial', 'operator-local', ?, ?)
  `).run("2026-08-27T12:00:00.000Z", "2026-08-27T12:00:00.000Z");
  database.prepare(`
    INSERT INTO investigation_thread_messages (
      id, thread_id, role, body, created_at
    ) VALUES ('operator-1', 'thread-tools', 'operator', 'Qual é o meu nome?', ?)
  `).run("2026-08-27T12:00:01.000Z");
  database.prepare(`
    INSERT INTO investigation_thread_jobs (
      id, thread_id, operator_message_id, state, requested_at, started_at
    ) VALUES ('job-quick', 'thread-tools', 'operator-1', 'running', ?, ?)
  `).run("2026-08-27T12:00:01.000Z", "2026-08-27T12:00:02.000Z");
  let selectedTask: string | undefined;
  let observedBudget: InvestigationThreadInput["executionBudget"];
  const modelAgent = {
    async investigateThread(current: InvestigationThreadInput) {
      observedBudget = current.executionBudget;
      await current.onModelUsage?.({
        inputTokens: 2_400,
        cachedInputTokens: 1_800,
        outputTokens: 120,
        reasoningOutputTokens: 30,
      });
      return {
        assistantMessage: "Você é o Operador local.",
        phase: "conclusion" as const,
        threadSummary: "Identidade do operador respondida pela conversa.",
        evidence: [],
        suggestedResponse: null,
        nextAction: "Nenhuma.",
        confidence: 0.9,
        toolRequests: [],
      };
    },
  } as unknown as SupportAgent;
  const settings = {
    async createAgentForTask(
      task: string,
    ) {
      selectedTask = task;
      return {
        agent: modelAgent,
        profile: {
          taskKind: "quick" as const,
          connectionId: "openrouter",
          model: "modelo-rapido-do-provedor",
          enabled: true,
          updatedAt: "2026-08-27T12:00:00.000Z",
        },
        connection: {
          id: "openrouter",
          label: "OpenRouter",
          providerId: "openrouter" as const,
          baseUrl: "https://openrouter.ai/api/v1",
          enabled: true,
          hasSecret: true,
          secretLastFour: "1234",
          capabilities: {
            automaticAnalysis: true,
            triage: true,
            structuredOutput: true,
            vision: true,
            localTools: false,
            codebaseAccess: false,
            deepInvestigation: true,
          },
          createdAt: "2026-08-27T12:00:00.000Z",
          updatedAt: "2026-08-27T12:00:00.000Z",
        },
      };
    },
  } as unknown as AiProviderSettingsService;
  const quickInput = input();
  quickInput.recentMessages[0]!.body = "Qual é o meu nome?";
  const configured = new ConfiguredSupportAgent(
    database,
    settings,
    {} as CodexSupportAgent,
  );

  try {
    await configured.investigateThread(quickInput);
    assert.equal(selectedTask, "quick");
    assert.equal(observedBudget?.workload, "quick");
    assert.equal(observedBudget?.promptMode, "conversation");
    assert.equal(observedBudget?.maxToolRounds, 0);
    assert.equal(observedBudget?.maxToolOperations, 0);
    assert.deepEqual(
      database.prepare(`
        SELECT ai_provider_id, ai_connection_id, ai_model, ai_workload,
               ai_model_calls, ai_input_tokens, ai_cached_input_tokens,
               ai_output_tokens, ai_reasoning_output_tokens
        FROM investigation_thread_jobs
        WHERE id = 'job-quick'
      `).get(),
      {
        ai_provider_id: "openrouter",
        ai_connection_id: "openrouter",
        ai_model: "modelo-rapido-do-provedor",
        ai_workload: "quick",
        ai_model_calls: 1,
        ai_input_tokens: 2_400,
        ai_cached_input_tokens: 1_800,
        ai_output_tokens: 120,
        ai_reasoning_output_tokens: 30,
      },
    );
  } finally {
    database.close();
  }
});

test("resposta omite guardrail de WhatsApp quando a tarefa não trata do canal", async () => {
  const database = createDatabase(":memory:");
  const modelAgent = {
    async investigateThread() {
      return {
        assistantMessage:
          "Revisão das automações concluída. WhatsApp outbound permanece proibido.",
        phase: "conclusion" as const,
        threadSummary:
          "Automações revisadas. A restrição de WhatsApp outbound foi preservada.",
        findings: [{
          statement: "WhatsApp outbound permanece proibido.",
          kind: "fact" as const,
          evidenceReferences: [],
        }],
        evidence: [],
        suggestedResponse: null,
        nextAction: "Aplicar os ajustes sem WhatsApp outbound.",
        confidence: 0.9,
        toolRequests: [],
      };
    },
  } as unknown as SupportAgent;
  const current = input();
  current.recentMessages[0]!.body = "Revise as automações existentes.";
  const configured = new ConfiguredSupportAgent(
    database,
    settingsForDeepAgent(modelAgent),
    {} as CodexSupportAgent,
  );

  try {
    const result = await configured.investigateThread(current);
    assert.equal(result.assistantMessage, "Revisão das automações concluída.");
    assert.doesNotMatch(result.threadSummary, /whatsapp/iu);
    assert.doesNotMatch(result.nextAction ?? "", /whatsapp/iu);
    assert.deepEqual(result.findings, []);
  } finally {
    database.close();
  }
});

test("agente adaptativo recebe o catálogo autorizado e conversa trivial não recebe ferramentas", () => {
  const descriptors = [
    { id: "threadmark-context", name: "Contexto", type: "knowledge", description: "", scope: "", operations: [] },
    { id: "threadmark-automations", name: "Automações", type: "knowledge", description: "", scope: "", operations: [] },
    { id: "connected-app:intercom", name: "Intercom", type: "connected_app", description: "", scope: "", operations: [] },
    { id: "local-tool:codebase:app", name: "Codebase", type: "codebase", description: "", scope: "", operations: [] },
  ] as InvestigationToolDescriptor[];
  const current = input();
  current.recentMessages[0]!.body = "Analise as automações criadas.";
  const policy = investigationExecutionPolicy(current);
  assert.deepEqual(
    toolsForExecutionPolicy(descriptors, policy).map((tool) => tool.id),
    descriptors.map((tool) => tool.id),
  );

  current.recentMessages[0]!.body = "Qual é o meu nome?";
  const conversationPolicy = investigationExecutionPolicy(current);
  assert.deepEqual(
    toolsForExecutionPolicy(descriptors, conversationPolicy),
    [],
  );
});

test("app conectado exige confirmação explícita da mensagem atual antes da execução", async () => {
  const database = createDatabase(":memory:");
  let turns = 0;
  const modelAgent = {
    async investigateThread(current: InvestigationThreadInput) {
      turns += 1;
      if (turns === 1) {
        return {
          assistantMessage: "Vou publicar o artigo.",
          phase: "analysis" as const,
          threadSummary: "Publicação solicitada sem confirmação válida.",
          evidence: [],
          suggestedResponse: null,
          nextAction: "Publicar no Intercom.",
          confidence: 0.7,
          toolRequests: [{
            requestId: "intercom-with-stale-confirmation",
            toolId: "connected-app:intercom",
            operation: "create_article",
            argumentsJson: JSON.stringify({
              confirmationMessageId: "operator-antigo",
              title: "Artigo",
              description: "Resumo",
              body: "<p>Conteúdo</p>",
              authorId: "admin-1",
              collectionId: "collection-1",
            }),
            purpose: "Criar documentação.",
          }],
        };
      }
      assert.equal(current.toolResults?.[0]?.status, "error");
      assert.match(current.toolResults?.[0]?.summary ?? "", /mensagem atual/i);
      return {
        assistantMessage: "Não executei a ação porque falta uma solicitação explícita nesta mensagem.",
        phase: "conclusion" as const,
        threadSummary: "Ação externa bloqueada com segurança.",
        evidence: [],
        suggestedResponse: null,
        nextAction: "Peça explicitamente a criação do artigo.",
        confidence: 0.9,
        toolRequests: [],
      };
    },
  } as unknown as SupportAgent;
  let brokerExecutions = 0;
  const broker: DeepInvestigationToolBroker = {
    descriptors() {
      return [{
        id: "connected-app:intercom",
        name: "Intercom",
        type: "connected_app",
        description: "Intercom autorizado",
        scope: "API externa",
        operations: [{
          name: "create_article",
          description: "Cria um artigo",
          argumentsExample: "{}",
        }],
      }];
    },
    async executeMany() {
      brokerExecutions += 1;
      return [];
    },
  };
  const configured = new ConfiguredSupportAgent(
    database,
    settingsForDeepAgent(modelAgent),
    {} as CodexSupportAgent,
    broker,
  );

  try {
    const result = await configured.investigateThread(input());
    assert.equal(turns, 2);
    assert.equal(brokerExecutions, 0);
    assert.equal(result.toolExecutions?.[0]?.status, "error");
  } finally {
    database.close();
  }
});

test("ordem explícita conclui criação após a prévia sem depender de outra rodada do modelo", async () => {
  const database = createDatabase(":memory:");
  const executedOperations: string[] = [];
  let modelTurns = 0;
  const modelAgent = {
    async investigateThread() {
      modelTurns += 1;
      if (modelTurns === 1) {
        return {
          assistantMessage: "Vou preparar o ticket.",
          phase: "analysis" as const,
          threadSummary: "Criação solicitada.",
          evidence: [],
          suggestedResponse: null,
          nextAction: "Preparar e criar.",
          confidence: 0.9,
          toolRequests: [{
            requestId: "prepare-explicit-ticket",
            toolId: "threadmark-context",
            operation: "prepare_ticket_draft",
            argumentsJson: "{}",
            purpose: "Preparar o ticket solicitado.",
          }],
        };
      }
      assert.fail("o recibo confiável deve concluir sem outra rodada do modelo");
    },
  } as unknown as SupportAgent;
  const broker: DeepInvestigationToolBroker = {
    descriptors: () => [{
      id: "threadmark-context",
      name: "Contexto do Threadmark",
      type: "knowledge",
      description: "Tickets locais",
      scope: "SQLite",
      operations: [{
        name: "prepare_ticket_draft",
        description: "Prepara",
        argumentsExample: "{}",
        effect: "prepare",
        authorization: "none",
        automaticFollowUpOperation: "create_ticket_from_draft",
      }, {
        name: "create_ticket_from_draft",
        description: "Cria",
        argumentsExample: "{}",
        effect: "write",
        authorization: "task",
      }],
    }],
    async executeMany(requests) {
      return requests.map((request) => {
        executedOperations.push(request.operation);
        return {
          requestId: request.requestId,
          toolId: request.toolId,
          toolName: "Contexto do Threadmark",
          operation: request.operation,
          argumentsJson: request.argumentsJson,
          purpose: request.purpose,
          status: "success" as const,
          summary: request.operation === "prepare_ticket_draft"
            ? "Prévia preparada."
            : "Ticket criado.",
          content: request.operation === "prepare_ticket_draft"
            ? JSON.stringify({ draftId: "draft-1", executionAuthorized: true })
            : JSON.stringify({ created: true, ticket: { number: 241 } }),
          reference: `tool:threadmark-context:${request.operation}`,
          executedAt: "2026-08-28T17:00:00.000Z",
        };
      });
    },
  };
  const current = input();
  current.recentMessages[0]!.body = "Crie o ticket agora.";
  const configured = new ConfiguredSupportAgent(
    database,
    settingsForDeepAgent(modelAgent),
    {} as CodexSupportAgent,
    broker,
  );

  try {
    const result = await configured.investigateThread(current);
    assert.equal(result.phase, "conclusion");
    assert.equal(modelTurns, 1);
    assert.match(result.assistantMessage, /Ticket #241 criado/);
    assert.deepEqual(executedOperations, [
      "prepare_ticket_draft",
      "create_ticket_from_draft",
    ]);
  } finally {
    database.close();
  }
});

test("ordem explícita aplica automaticamente a prévia de automação autorizada", async () => {
  const database = createDatabase(":memory:");
  const executedOperations: string[] = [];
  let modelTurns = 0;
  const modelAgent = {
    async investigateThread(current: InvestigationThreadInput) {
      modelTurns += 1;
      if (modelTurns === 1) {
        return {
          assistantMessage: "Vou preparar a automação.",
          phase: "analysis" as const,
          threadSummary: "Criação da automação solicitada.",
          evidence: [],
          suggestedResponse: null,
          nextAction: "Preparar e aplicar.",
          confidence: 0.9,
          toolRequests: [{
            requestId: "prepare-explicit-automation",
            toolId: "threadmark-automations",
            operation: "prepare_automation_draft",
            argumentsJson: JSON.stringify({ operatorMessageId: "operator-1" }),
            purpose: "Preparar a automação solicitada.",
          }],
        };
      }
      assert.equal(current.toolResults?.at(-1)?.operation, "apply_automation_draft");
      return {
        assistantMessage: "Automação criada.",
        phase: "conclusion" as const,
        threadSummary: "Automação criada e auditada.",
        evidence: [],
        suggestedResponse: null,
        nextAction: null,
        confidence: 1,
        toolRequests: [],
      };
    },
  } as unknown as SupportAgent;
  const broker: DeepInvestigationToolBroker = {
    descriptors: () => [{
      id: "threadmark-automations",
      name: "Automações do Threadmark",
      type: "knowledge",
      description: "Fluxos internos",
      scope: "SQLite",
      operations: [{
        name: "prepare_automation_draft",
        description: "Prepara a automação.",
        argumentsExample: "{}",
        effect: "prepare",
        authorization: "none",
        automaticFollowUpOperation: "apply_automation_draft",
      }, {
        name: "apply_automation_draft",
        description: "Aplica a automação.",
        argumentsExample: "{}",
        effect: "write",
        authorization: "task",
      }],
    }],
    async executeMany(requests) {
      return requests.map((request) => {
        executedOperations.push(request.operation);
        return {
          requestId: request.requestId,
          toolId: request.toolId,
          toolName: "Automações do Threadmark",
          operation: request.operation,
          argumentsJson: request.argumentsJson,
          purpose: request.purpose,
          status: "success" as const,
          summary: request.operation === "prepare_automation_draft"
            ? "Prévia de automação preparada."
            : "Automação aplicada.",
          content: request.operation === "prepare_automation_draft"
            ? JSON.stringify({ draftId: "automation-draft-1", executionAuthorized: true })
            : JSON.stringify({ draftId: "automation-draft-1", workflowId: "workflow-1" }),
          reference: `tool:threadmark-automations:${request.operation}`,
          executedAt: "2026-08-28T17:10:00.000Z",
        };
      });
    },
  };
  const current = input();
  current.recentMessages[0]!.body = "Crie essa automação agora.";
  const configured = new ConfiguredSupportAgent(
    database,
    settingsForDeepAgent(modelAgent),
    {} as CodexSupportAgent,
    broker,
  );

  try {
    const result = await configured.investigateThread(current);
    assert.equal(result.phase, "conclusion");
    assert.equal(modelTurns, 2);
    assert.deepEqual(executedOperations, [
      "prepare_automation_draft",
      "apply_automation_draft",
    ]);
  } finally {
    database.close();
  }
});

test("confirmação natural aplica deterministicamente a última prévia pendente", async () => {
  const database = createDatabase(":memory:");
  database.prepare(`
    INSERT INTO investigation_threads (
      id, scope, title, created_by, created_at, updated_at
    ) VALUES ('thread-confirmation', 'workspace', 'Conversa', 'operator-local', ?, ?)
  `).run("2026-08-26T17:00:00.000Z", "2026-08-26T17:00:00.000Z");
  database.prepare(`
    INSERT INTO investigation_thread_messages (
      id, thread_id, role, body, created_at
    ) VALUES ('operator-preview', 'thread-confirmation', 'operator', 'Prepare a automação.', ?)
  `).run("2026-08-26T17:00:01.000Z");
  database.prepare(`
    INSERT INTO investigation_thread_jobs (
      id, thread_id, operator_message_id, state, requested_at, finished_at
    ) VALUES ('job-preview', 'thread-confirmation', 'operator-preview', 'completed', ?, ?)
  `).run("2026-08-26T17:00:01.000Z", "2026-08-26T17:00:03.000Z");
  database.prepare(`
    INSERT INTO investigation_thread_messages (
      id, thread_id, role, body, phase, job_id, created_at
    ) VALUES (
      'assistant-preview', 'thread-confirmation', 'assistant',
      'Prévia preparada. Confirma?', 'analysis', 'job-preview', ?
    )
  `).run("2026-08-26T17:00:03.000Z");
  database.prepare(`
    UPDATE investigation_thread_jobs
    SET assistant_message_id = 'assistant-preview'
    WHERE id = 'job-preview'
  `).run();
  database.prepare(`
    INSERT INTO investigation_thread_messages (
      id, thread_id, role, body, created_at
    ) VALUES ('operator-confirmation', 'thread-confirmation', 'operator', 'Pode daler', ?)
  `).run("2026-08-26T17:00:04.000Z");
  database.prepare(`
    INSERT INTO threadmark_ai_automation_drafts (
      id, thread_id, operator_message_id, intent, name, definition_json,
      state, created_by, created_at, updated_at
    ) VALUES (
      'automation-draft-1', 'thread-confirmation', 'operator-preview', 'create',
      'Fluxo de teste', '{}', 'pending', 'operator-local', ?, ?
    )
  `).run("2026-08-26T17:00:02.000Z", "2026-08-26T17:00:02.000Z");
  database.prepare(`
    INSERT INTO investigation_thread_tool_executions (
      id, job_id, request_id, tool_id, tool_name, operation, arguments_json,
      purpose, status, summary, content, executed_at, recorded_at
    ) VALUES (
      'execution-preview', 'job-preview', 'prepare-preview', 'threadmark-automations',
      'Automações do Threadmark', 'prepare_automation_draft', '{}', 'Preparar',
      'success', 'Prévia preparada', ?, ?, ?
    )
  `).run(
    JSON.stringify({ draftId: "automation-draft-1" }),
    "2026-08-26T17:00:02.000Z",
    "2026-08-26T17:00:02.000Z",
  );

  let receivedRequest: InvestigationToolRequest | null = null;
  const broker: DeepInvestigationToolBroker = {
    descriptors() {
      return [{
        id: "threadmark-automations",
        name: "Automações do Threadmark",
        type: "knowledge",
        description: "Fluxos internos",
        scope: "SQLite local",
        operations: [{
          name: "apply_automation_draft",
          description: "Aplica uma prévia",
          argumentsExample: "{}",
        }],
      }];
    },
    async executeMany(requests) {
      receivedRequest = requests[0] ?? null;
      return requests.map((request) => ({
        ...request,
        toolName: "Automações do Threadmark",
        status: "success" as const,
        summary: "Prévia aplicada.",
        content: "{}",
        reference: null,
        executedAt: "2026-08-26T17:00:05.000Z",
      }));
    },
  };
  const modelAgent = {
    async investigateThread(current: InvestigationThreadInput) {
      assert.equal(current.toolResults?.[0]?.status, "success");
      assert.match(current.toolResults?.[0]?.summary ?? "", /aplicada/i);
      return {
        assistantMessage: "A prévia foi aplicada.",
        phase: "conclusion" as const,
        threadSummary: "Prévia confirmada e aplicada.",
        evidence: [],
        suggestedResponse: null,
        nextAction: null,
        confidence: 1,
        toolRequests: [],
      };
    },
  } as unknown as SupportAgent;
  const configured = new ConfiguredSupportAgent(
    database,
    settingsForDeepAgent(modelAgent),
    {} as CodexSupportAgent,
    broker,
  );

  try {
    const current = input();
    current.threadId = "thread-confirmation";
    current.currentOperatorMessageId = "operator-confirmation";
    current.recentMessages = [{
      id: "operator-confirmation",
      role: "operator",
      body: "Pode daler",
      phase: null,
      createdAt: "2026-08-26T17:00:04.000Z",
    }];
    await configured.investigateThread(current);
    const executedRequest = receivedRequest as InvestigationToolRequest | null;
    assert.ok(executedRequest);
    assert.equal(executedRequest.operation, "apply_automation_draft");
    assert.deepEqual(JSON.parse(executedRequest.argumentsJson), {
      confirmationMessageId: "operator-confirmation",
      draftId: "automation-draft-1",
    });
  } finally {
    database.close();
  }
});

test("mutação de automação rejeita confirmação de uma mensagem anterior", async () => {
  const database = createDatabase(":memory:");
  let turns = 0;
  const modelAgent = {
    async investigateThread(current: InvestigationThreadInput) {
      turns += 1;
      if (turns === 1) {
        return {
          assistantMessage: "Vou ativar o fluxo.",
          phase: "analysis" as const,
          threadSummary: "Ativação solicitada com confirmação antiga.",
          evidence: [],
          suggestedResponse: null,
          nextAction: "Ativar automação.",
          confidence: 0.7,
          toolRequests: [{
            requestId: "automation-stale-confirmation",
            toolId: "threadmark-automations",
            operation: "set_automation_status",
            argumentsJson: JSON.stringify({
              confirmationMessageId: "operator-antigo",
              automationId: "workflow-1",
              status: "active",
            }),
            purpose: "Ativar a automação.",
          }],
        };
      }
      assert.equal(current.toolResults?.[0]?.status, "error");
      assert.match(current.toolResults?.[0]?.summary ?? "", /mensagem atual/i);
      return {
        assistantMessage: "Não ativei o fluxo porque a confirmação não veio desta mensagem.",
        phase: "conclusion" as const,
        threadSummary: "Mutação interna bloqueada com segurança.",
        evidence: [],
        suggestedResponse: null,
        nextAction: "Peça explicitamente a ativação.",
        confidence: 0.9,
        toolRequests: [],
      };
    },
  } as unknown as SupportAgent;
  let brokerExecutions = 0;
  const broker: DeepInvestigationToolBroker = {
    descriptors() {
      return [{
        id: "threadmark-automations",
        name: "Automações do Threadmark",
        type: "knowledge",
        description: "Fluxos internos",
        scope: "SQLite local",
        operations: [{
          name: "set_automation_status",
          description: "Ativa ou pausa",
          argumentsExample: "{}",
        }],
      }];
    },
    async executeMany() {
      brokerExecutions += 1;
      return [];
    },
  };
  const configured = new ConfiguredSupportAgent(
    database,
    settingsForDeepAgent(modelAgent),
    {} as CodexSupportAgent,
    broker,
  );

  try {
    const result = await configured.investigateThread(input());
    assert.equal(turns, 2);
    assert.equal(brokerExecutions, 0);
    assert.equal(result.toolExecutions?.[0]?.status, "error");
  } finally {
    database.close();
  }
});

test("leitura nativa do Intercom não exige confirmação de mutação", async () => {
  const database = createDatabase(":memory:");
  let turns = 0;
  let brokerExecutions = 0;
  const modelAgent = {
    async investigateThread(current: InvestigationThreadInput) {
      turns += 1;
      if (turns === 1) {
        return {
          assistantMessage: "Vou localizar a conversa.",
          phase: "analysis" as const,
          threadSummary: "Busca readonly pendente.",
          evidence: [],
          suggestedResponse: null,
          nextAction: "Consultar o Intercom.",
          confidence: 0.5,
          toolRequests: [{
            requestId: "intercom-read-without-confirmation",
            toolId: "connected-app:intercom",
            operation: "search_conversations",
            argumentsJson: JSON.stringify({ query: "Pessoa Cliente", limit: 5 }),
            purpose: "Localizar conversa recente.",
          }],
        };
      }
      assert.equal(current.toolResults?.[0]?.status, "success");
      return {
        assistantMessage: "Conversa localizada.",
        phase: "conclusion" as const,
        threadSummary: "Conversa localizada em leitura readonly.",
        evidence: [],
        suggestedResponse: null,
        nextAction: "Revisar a conversa.",
        confidence: 0.9,
        toolRequests: [],
      };
    },
  } as unknown as SupportAgent;
  const broker: DeepInvestigationToolBroker = {
    descriptors() {
      return [{
        id: "connected-app:intercom",
        name: "Intercom",
        type: "connected_app",
        description: "Intercom autorizado",
        scope: "API externa readonly",
        operations: [{
          name: "search_conversations",
          description: "Busca conversas",
          argumentsExample: "{}",
        }],
      }];
    },
    async executeMany(requests) {
      brokerExecutions += 1;
      return [{
        requestId: requests[0]!.requestId,
        toolId: requests[0]!.toolId,
        toolName: "Intercom",
        operation: requests[0]!.operation,
        argumentsJson: requests[0]!.argumentsJson,
        purpose: requests[0]!.purpose,
        status: "success",
        summary: "Uma conversa localizada.",
        content: '{"conversations":[{"id":"987"}]}',
        reference: "tool:connected-app:intercom:search_conversations:request:read-1",
        executedAt: "2026-08-20T12:00:01.000Z",
      }];
    },
  };
  const configured = new ConfiguredSupportAgent(
    database,
    settingsForDeepAgent(modelAgent),
    {} as CodexSupportAgent,
    broker,
  );

  try {
    const result = await configured.investigateThread(input());
    assert.equal(result.assistantMessage, "Conversa localizada.");
    assert.equal(turns, 2);
    assert.equal(brokerExecutions, 1);
  } finally {
    database.close();
  }
});

test("roteador executa pedido tipado fora do modelo e devolve o resultado no turno seguinte", async () => {
  const database = createDatabase(":memory:");
  const modelInputs: InvestigationThreadInput[] = [];
  const modelAgent = {
    async investigateThread(current: InvestigationThreadInput) {
      modelInputs.push(current);
      if (modelInputs.length === 1) {
        return {
          assistantMessage: "Preciso confirmar a implementação.",
          phase: "analysis" as const,
          threadSummary: "Leitura do código pendente.",
          evidence: [],
          suggestedResponse: null,
          nextAction: "Ler a função da métrica.",
          confidence: 0.4,
          toolRequests: [{
            requestId: "request-1",
            toolId: "code-tool",
            operation: "read_files",
            argumentsJson: '{"paths":["metrics.ts"]}',
            purpose: "Confirmar a fórmula.",
          }],
        };
      }
      assert.equal(current.toolResults?.[0]?.status, "success");
      assert.match(current.toolResults?.[0]?.content ?? "", /recorrentes/);
      return {
        assistantMessage: "A regra foi confirmada no código.",
        phase: "conclusion" as const,
        threadSummary: "Fórmula confirmada.",
        evidence: [{
          source: "code" as const,
          summary: "A função soma clientes recorrentes e novos após deduplicação.",
          reference: "tool:code-tool:read:metrics.ts",
        }],
        suggestedResponse: "O total considera a união deduplicada dos dois conjuntos.",
        nextAction: "Revisar a resposta.",
        confidence: 0.95,
        toolRequests: [],
      };
    },
  } as unknown as SupportAgent;
  const settings = {
    async createAgentForTask() {
      return {
        agent: modelAgent,
        profile: {
          taskKind: "deep" as const,
          connectionId: "builtin-codex",
          model: "default",
          enabled: true,
          updatedAt: "2026-07-18T20:00:00.000Z",
        },
        connection: {
          id: "builtin-codex",
          label: "Codex CLI",
          providerId: "codex" as const,
          baseUrl: null,
          enabled: true,
          hasSecret: false,
          secretLastFour: null,
          capabilities: {
            automaticAnalysis: true,
            triage: true,
            structuredOutput: true,
            vision: true,
            localTools: false,
            codebaseAccess: false,
            deepInvestigation: true,
          },
          createdAt: "2026-07-18T20:00:00.000Z",
          updatedAt: "2026-07-18T20:00:00.000Z",
        },
      };
    },
  } as unknown as AiProviderSettingsService;
  const broker: DeepInvestigationToolBroker = {
    descriptors() {
      return [{
        id: "code-tool",
        name: "Código",
        type: "codebase",
        description: "Código autorizado",
        scope: "raiz local",
        operations: [{
          name: "read_files",
          description: "Lê arquivos",
          argumentsExample: '{"paths":["metrics.ts"]}',
        }],
      }];
    },
    async executeMany(requests) {
      assert.equal(requests.length, 1);
      return [{
        requestId: requests[0]!.requestId,
        toolId: "code-tool",
        toolName: "Código",
        operation: "read_files",
        argumentsJson: requests[0]!.argumentsJson,
        purpose: requests[0]!.purpose,
        status: "success",
        summary: "Arquivo lido.",
        content: "42: return recorrentes + novos;",
        reference: "tool:code-tool:read:metrics.ts",
        executedAt: "2026-07-18T20:00:01.000Z",
      }];
    },
  };
  const configured = new ConfiguredSupportAgent(
    database,
    settings,
    {} as CodexSupportAgent,
    broker,
  );

  try {
    const audited: string[] = [];
    const currentInput = input();
    currentInput.onToolExecution = (execution) => {
      audited.push(execution.requestId);
    };
    const result = await configured.investigateThread(currentInput);
    assert.equal(modelInputs.length, 2);
    assert.equal(modelInputs[0]?.availableTools?.[0]?.id, "code-tool");
    assert.equal(result.phase, "conclusion");
    assert.equal(result.toolRequests.length, 0);
    assert.equal(result.toolExecutions?.length, 1);
    assert.equal(result.toolExecutions?.[0]?.operation, "read_files");
    assert.deepEqual(audited, ["request-1"]);
  } finally {
    database.close();
  }
});

test("agente usa descoberta no código para orientar consulta no banco e concluir com ambas as evidências", async () => {
  const database = createDatabase(":memory:");
  const observedTools: string[] = [];
  let modelTurns = 0;
  const modelAgent = {
    async investigateThread(current: InvestigationThreadInput) {
      modelTurns += 1;
      if (modelTurns === 1) {
        return {
          assistantMessage: "Vou localizar a regra de negócio.",
          phase: "analysis" as const,
          threadSummary: "Objetivo: localizar a regra. Próximo passo: buscar o cálculo no código.",
          evidence: [],
          suggestedResponse: null,
          nextAction: "Buscar o cálculo no código.",
          confidence: 0.3,
          toolRequests: [{
            requestId: "chain-code",
            toolId: "codebase",
            operation: "search_files",
            argumentsJson: '{"query":"customer_total","path":"src"}',
            purpose: "Localizar a regra e seus identificadores.",
          }],
        };
      }
      if (modelTurns === 2) {
        assert.match(current.durableSummary, /buscar o cálculo no código/i);
        assert.match(current.toolResults?.[0]?.content ?? "", /customer_metrics/);
        return {
          assistantMessage: "A regra apontou a tabela; vou confrontar os dados.",
          phase: "analysis" as const,
          threadSummary: "Código: customer_total lê customer_metrics por business_id. Próximo passo: consultar a linha afetada.",
          evidence: [],
          suggestedResponse: null,
          nextAction: "Consultar customer_metrics em modo readonly.",
          confidence: 0.55,
          toolRequests: [{
            requestId: "chain-database",
            toolId: "debugger",
            operation: "query_readonly",
            argumentsJson: '{"query":"SELECT total FROM customer_metrics WHERE business_id = 42 LIMIT 1"}',
            purpose: "Confrontar o valor persistido com a regra localizada.",
          }],
        };
      }

      assert.match(current.durableSummary, /customer_metrics por business_id/i);
      assert.equal(current.toolResults?.length, 2);
      return {
        assistantMessage: "A divergência foi localizada entre o valor persistido e a regra de cálculo.",
        phase: "conclusion" as const,
        threadSummary: "Regra e dado confrontados; causa localizada.",
        evidence: [
          { source: "code" as const, summary: "Regra localizada.", reference: "tool:codebase:search:customer-total" },
          { source: "database" as const, summary: "Valor persistido confirmado.", reference: "tool:debugger:query:customer-total" },
        ],
        suggestedResponse: "Identificamos a origem da divergência e o caso pode seguir para correção.",
        nextAction: "Encaminhar a evidência técnica.",
        confidence: 0.94,
        toolRequests: [],
      };
    },
  } as unknown as SupportAgent;
  const broker: DeepInvestigationToolBroker = {
    descriptors: () => [{
      id: "codebase",
      name: "Código",
      type: "codebase",
      description: null,
      scope: "raiz local",
      operations: [{
        name: "search_files",
        description: "Busca no código",
        argumentsExample: '{"query":"customer_total","path":"src"}',
      }],
    }, {
      id: "debugger",
      name: "PostgreSQL",
      type: "postgres_readonly",
      description: null,
      scope: "somente leitura",
      operations: [{
        name: "query_readonly",
        description: "Executa SELECT",
        argumentsExample: '{"query":"SELECT 1"}',
      }],
    }],
    async executeMany(requests) {
      const request = requests[0]!;
      observedTools.push(request.toolId);
      if (request.toolId === "codebase") {
        return [{
          requestId: request.requestId,
          toolId: request.toolId,
          toolName: "Código",
          operation: request.operation,
          argumentsJson: request.argumentsJson,
          purpose: request.purpose,
          status: "success",
          summary: "Regra localizada.",
          content: "customer_total lê customer_metrics usando business_id",
          reference: "tool:codebase:search:customer-total",
          executedAt: "2026-07-20T14:00:00.000Z",
        }];
      }
      return [{
        requestId: request.requestId,
        toolId: request.toolId,
        toolName: "Debugger",
        operation: request.operation,
        argumentsJson: request.argumentsJson,
        purpose: request.purpose,
        status: "success",
        summary: "Valor persistido consultado.",
        content: "total\n37",
        reference: "tool:debugger:query:customer-total",
        executedAt: "2026-07-20T14:01:00.000Z",
      }];
    },
  };
  const configured = new ConfiguredSupportAgent(
    database,
    settingsForDeepAgent(modelAgent),
    {} as CodexSupportAgent,
    broker,
  );

  try {
    const result = await configured.investigateThread(input());
    assert.deepEqual(observedTools, ["codebase", "debugger"]);
    assert.equal(modelTurns, 3);
    assert.equal(result.phase, "conclusion");
    assert.equal(result.evidence.length, 2);
  } finally {
    database.close();
  }
});

test("investigação profunda continua além do antigo limite de quatro rodadas enquanto há progresso", async () => {
  const database = createDatabase(":memory:");
  let modelTurns = 0;
  let brokerCalls = 0;
  const modelAgent = {
    async investigateThread(current: InvestigationThreadInput) {
      modelTurns += 1;
      if (modelTurns <= 6) {
        assert.equal(current.toolResults?.length, modelTurns - 1);
        return {
          assistantMessage: `Coletando evidência ${modelTurns}.`,
          phase: "analysis" as const,
          threadSummary: `Investigação avançou até a evidência ${modelTurns}.`,
          evidence: [],
          suggestedResponse: null,
          nextAction: "Continuar a investigação.",
          confidence: 0.4,
          toolRequests: [{
            requestId: `request-${modelTurns}`,
            toolId: "debugger",
            operation: "query_readonly",
            argumentsJson: JSON.stringify({
              query: `SELECT ${modelTurns} AS evidence_index`,
            }),
            purpose: `Coletar evidência ${modelTurns}.`,
          }],
        };
      }

      return {
        assistantMessage: "A investigação chegou a uma conclusão sustentada.",
        phase: "conclusion" as const,
        threadSummary: "Seis evidências foram coletadas antes da conclusão.",
        evidence: [],
        suggestedResponse: "A causa foi confirmada após a investigação completa.",
        nextAction: "Revisar a conclusão.",
        confidence: 0.9,
        toolRequests: [],
      };
    },
  } as unknown as SupportAgent;
  const settings = {
    async createAgentForTask() {
      return {
        agent: modelAgent,
        profile: { taskKind: "deep", connectionId: "codex", model: "default", enabled: true, updatedAt: "2026-07-20T14:00:00.000Z" },
        connection: {
          id: "codex", label: "Codex", providerId: "codex", baseUrl: null, enabled: true,
          hasSecret: false, secretLastFour: null,
          capabilities: { automaticAnalysis: true, triage: true, structuredOutput: true, vision: true, localTools: false, codebaseAccess: false, deepInvestigation: true },
          createdAt: "2026-07-20T14:00:00.000Z", updatedAt: "2026-07-20T14:00:00.000Z",
        },
      };
    },
  } as unknown as AiProviderSettingsService;
  const broker: DeepInvestigationToolBroker = {
    descriptors: () => [],
    async executeMany(requests) {
      brokerCalls += 1;
      const request = requests[0]!;
      return [{
        requestId: request.requestId,
        toolId: request.toolId,
        toolName: "Debugger",
        operation: request.operation,
        argumentsJson: request.argumentsJson,
        purpose: request.purpose,
        status: "success",
        summary: `Evidência ${brokerCalls} coletada.`,
        content: `evidence_index\n${brokerCalls}`,
        reference: `tool:debugger:query:${brokerCalls}`,
        executedAt: `2026-07-20T14:0${brokerCalls}:00.000Z`,
      }];
    },
  };
  const configured = new ConfiguredSupportAgent(
    database,
    settings,
    {} as CodexSupportAgent,
    broker,
  );

  try {
    const result = await configured.investigateThread(input());
    assert.equal(modelTurns, 7);
    assert.equal(brokerCalls, 6);
    assert.equal(result.phase, "conclusion");
    assert.equal(result.toolExecutions?.length, 6);
    assert.doesNotMatch(result.assistantMessage, /limite seguro de rodadas/);
  } finally {
    database.close();
  }
});

test("investigação longa respeita cancelamento explícito depois do antigo limite", async () => {
  const database = createDatabase(":memory:");
  const controller = new AbortController();
  let modelTurns = 0;
  let brokerCalls = 0;
  const modelAgent = {
    async investigateThread() {
      modelTurns += 1;
      return {
        assistantMessage: `Leitura ${modelTurns} pendente.`,
        phase: "analysis" as const,
        threadSummary: `Leituras realizadas: ${modelTurns - 1}.`,
        evidence: [],
        suggestedResponse: null,
        nextAction: "Continuar.",
        confidence: 0.4,
        toolRequests: [{
          requestId: `cancel-request-${modelTurns}`,
          toolId: "debugger",
          operation: "query_readonly",
          argumentsJson: JSON.stringify({ query: `SELECT ${modelTurns}` }),
          purpose: "Continuar a coleta.",
        }],
      };
    },
  } as unknown as SupportAgent;
  const broker: DeepInvestigationToolBroker = {
    descriptors: () => [],
    async executeMany(requests) {
      brokerCalls += 1;
      if (brokerCalls === 6) {
        controller.abort(new Error("Interrompida pelo operador."));
      }
      const request = requests[0]!;
      return [{
        requestId: request.requestId,
        toolId: request.toolId,
        toolName: "Debugger",
        operation: request.operation,
        argumentsJson: request.argumentsJson,
        purpose: request.purpose,
        status: "success",
        summary: "Leitura concluída.",
        content: "ok",
        reference: `tool:debugger:query:${brokerCalls}`,
        executedAt: "2026-07-20T14:00:00.000Z",
      }];
    },
  };
  const configured = new ConfiguredSupportAgent(
    database,
    settingsForDeepAgent(modelAgent),
    {} as CodexSupportAgent,
    broker,
  );

  try {
    await assert.rejects(
      configured.investigateThread(input(), controller.signal),
      /Interrompida pelo operador/,
    );
    assert.equal(modelTurns, 6);
    assert.equal(brokerCalls, 6);
  } finally {
    database.close();
  }
});

test("proteção de estagnação encerra somente repetição sem nova operação", async () => {
  const database = createDatabase(":memory:");
  let modelTurns = 0;
  let brokerCalls = 0;
  const modelAgent = {
    async investigateThread() {
      modelTurns += 1;
      return {
        assistantMessage: "Vou repetir a mesma consulta.",
        phase: "analysis" as const,
        threadSummary: "O agente ainda não refinou a consulta.",
        evidence: [{
          source: "code" as const,
          summary: "Referência inventada durante a repetição.",
          reference: "tool:debugger:query:not-executed",
        }],
        suggestedResponse: null,
        nextAction: "Repetir.",
        confidence: 0.4,
        toolRequests: [{
          requestId: `stalled-${modelTurns}`,
          toolId: "debugger",
          operation: "query_readonly",
          argumentsJson: '{"query":"SELECT 1"}',
          purpose: "Repetir a mesma consulta.",
        }],
      };
    },
  } as unknown as SupportAgent;
  const broker: DeepInvestigationToolBroker = {
    descriptors: () => [],
    async executeMany(requests) {
      brokerCalls += 1;
      const request = requests[0]!;
      return [{
        requestId: request.requestId,
        toolId: request.toolId,
        toolName: "Debugger",
        operation: request.operation,
        argumentsJson: request.argumentsJson,
        purpose: request.purpose,
        status: "success",
        summary: "Leitura concluída.",
        content: "1",
        reference: "tool:debugger:query:one",
        executedAt: "2026-07-20T14:00:00.000Z",
      }];
    },
  };
  const configured = new ConfiguredSupportAgent(
    database,
    settingsForDeepAgent(modelAgent),
    {} as CodexSupportAgent,
    broker,
  );

  try {
    const result = await configured.investigateThread(input());
    assert.equal(brokerCalls, 1);
    assert.equal(modelTurns, 4);
    assert.equal(result.phase, "needs_information");
    assert.match(result.assistantMessage, /entrou em repetição/);
    assert.deepEqual(result.evidence, []);
    assert.equal(result.toolExecutions?.length, 4);
  } finally {
    database.close();
  }
});

test("roteador bloqueia requestId já auditado e normaliza a origem pela referência da ferramenta", async () => {
  const database = createDatabase(":memory:");
  let brokerCalls = 0;
  const audited: string[] = [];
  let turns = 0;
  const modelAgent = {
    async investigateThread(current: InvestigationThreadInput) {
      turns += 1;
      if (turns === 1) {
        assert.equal(current.toolResults?.[0]?.requestId, "already-audited");
        return {
          assistantMessage: "Vou tentar novamente.",
          phase: "analysis" as const,
          threadSummary: "Nova leitura solicitada.",
          evidence: [],
          suggestedResponse: null,
          nextAction: "Ler outro arquivo.",
          confidence: 0.4,
          toolRequests: [{
            requestId: "already-audited",
            toolId: "code-tool",
            operation: "read_files",
            argumentsJson: '{"paths":["other.ts"]}',
            purpose: "Reusar identificador.",
          }],
        };
      }
      assert.equal(current.toolResults?.at(-1)?.status, "error");
      return {
        assistantMessage: "A causa foi confirmada.",
        phase: "conclusion" as const,
        threadSummary: "Causa supostamente confirmada.",
        evidence: [{
          source: "database" as const,
          summary: "Uma leitura de código foi rotulada incorretamente como banco.",
          reference: "tool:code-tool:read:metrics.ts",
        }],
        suggestedResponse: "Problema confirmado.",
        nextAction: "Enviar resposta.",
        confidence: 0.99,
        toolRequests: [],
      };
    },
  } as unknown as SupportAgent;
  const settings = {
    async createAgentForTask() {
      return {
        agent: modelAgent,
        profile: { taskKind: "deep", connectionId: "codex", model: "default", enabled: true, updatedAt: "2026-07-18T20:00:00.000Z" },
        connection: {
          id: "codex", label: "Codex", providerId: "codex", baseUrl: null, enabled: true,
          hasSecret: false, secretLastFour: null,
          capabilities: { automaticAnalysis: true, triage: true, structuredOutput: true, vision: true, localTools: false, codebaseAccess: false, deepInvestigation: true },
          createdAt: "2026-07-18T20:00:00.000Z", updatedAt: "2026-07-18T20:00:00.000Z",
        },
      };
    },
  } as unknown as AiProviderSettingsService;
  const broker: DeepInvestigationToolBroker = {
    descriptors: () => [{
      id: "code-tool",
      name: "Código",
      type: "codebase",
      description: null,
      scope: "raiz local",
      operations: [{
        name: "read_files",
        description: "Lê arquivos",
        argumentsExample: '{"paths":["metrics.ts"]}',
      }],
    }],
    async executeMany() {
      brokerCalls += 1;
      return [];
    },
  };
  const configured = new ConfiguredSupportAgent(database, settings, {} as CodexSupportAgent, broker);
  const currentInput = input();
  currentInput.toolResults = [{
    requestId: "already-audited",
    toolId: "code-tool",
    toolName: "Código",
    operation: "read_files",
    argumentsJson: '{"paths":["metrics.ts"]}',
    purpose: "Leitura anterior.",
    status: "success",
    summary: "Arquivo lido.",
    content: "conteúdo",
    reference: "tool:code-tool:read:metrics.ts",
    executedAt: "2026-07-18T20:00:00.000Z",
  }];
  currentInput.onToolExecution = (execution) => {
    audited.push(execution.requestId);
  };

  try {
    const result = await configured.investigateThread(currentInput);
    assert.equal(brokerCalls, 0);
    assert.deepEqual(audited, ["already-audited"]);
    assert.equal(result.phase, "conclusion");
    assert.equal(result.suggestedResponse, "Problema confirmado.");
    assert.deepEqual(result.evidence, [{
      source: "code",
      summary: "Uma leitura de código foi rotulada incorretamente como banco.",
      reference: "tool:code-tool:read:metrics.ts",
    }]);
  } finally {
    database.close();
  }
});

test("roteador não publica minuta em needs_information sustentada por evidência técnica inventada", async () => {
  const database = createDatabase(":memory:");
  const modelAgent = {
    async investigateThread() {
      return {
        assistantMessage: "O banco falhou e ainda preciso de informações.",
        phase: "needs_information" as const,
        threadSummary: "Falha de banco supostamente identificada.",
        evidence: [{
          source: "database" as const,
          summary: "Consulta que nunca foi executada.",
          reference: "tool:debugger:query:not-executed",
        }],
        suggestedResponse: "Identificamos uma falha no banco.",
        nextAction: "Enviar a orientação ao cliente.",
        confidence: 0.95,
        toolRequests: [],
      };
    },
  } as unknown as SupportAgent;
  const configured = new ConfiguredSupportAgent(
    database,
    settingsForDeepAgent(modelAgent),
    {} as CodexSupportAgent,
    { descriptors: () => [], executeMany: async () => [] },
  );

  try {
    const result = await configured.investigateThread(input());
    assert.equal(result.phase, "needs_information");
    assert.equal(result.suggestedResponse, null);
    assert.deepEqual(result.evidence, []);
    assert.match(result.assistantMessage, /não foi liberada/);
    assert.ok(result.confidence <= 0.5);
  } finally {
    database.close();
  }
});

test("roteador neutraliza alegação técnica inventada antes de persistir checkpoint intermediário", async () => {
  const database = createDatabase(":memory:");
  let turns = 0;
  let checkpointSeen = "";
  const modelAgent = {
    async investigateThread(current: InvestigationThreadInput) {
      turns += 1;
      if (turns === 1) {
        return {
          assistantMessage: "O banco falhou.",
          phase: "analysis" as const,
          threadSummary: "Banco indisponível segundo uma consulta inventada.",
          evidence: [{
            source: "database" as const,
            summary: "Consulta ainda não executada.",
            reference: "tool:debugger:query:not-executed",
          }],
          suggestedResponse: null,
          nextAction: "Consultar o banco de verdade.",
          confidence: 0.9,
          toolRequests: [{
            requestId: "verify-database",
            toolId: "debugger",
            operation: "query_readonly",
            argumentsJson: '{"query":"SELECT 1"}',
            purpose: "Verificar o banco.",
          }],
        };
      }
      checkpointSeen = current.durableSummary;
      return {
        assistantMessage: "Ainda não há conclusão técnica.",
        phase: "needs_information" as const,
        threadSummary: current.durableSummary,
        evidence: [],
        suggestedResponse: null,
        nextAction: "Continuar a investigação.",
        confidence: 0.4,
        toolRequests: [],
      };
    },
  } as unknown as SupportAgent;
  const broker: DeepInvestigationToolBroker = {
    descriptors: () => [{
      id: "debugger",
      name: "Debugger",
      type: "postgres_readonly",
      description: null,
      scope: "banco readonly",
      operations: [{
        name: "query_readonly",
        description: "Executa SELECT",
        argumentsExample: '{"query":"SELECT 1"}',
      }],
    }],
    async executeMany(requests) {
      const request = requests[0]!;
      return [{
        requestId: request.requestId,
        toolId: request.toolId,
        toolName: "Debugger",
        operation: request.operation,
        argumentsJson: request.argumentsJson,
        purpose: request.purpose,
        status: "success",
        summary: "Consulta concluída.",
        content: "1",
        reference: "tool:debugger:query:verified",
        executedAt: "2026-07-20T14:00:00.000Z",
      }];
    },
  };
  const configured = new ConfiguredSupportAgent(
    database,
    settingsForDeepAgent(modelAgent),
    {} as CodexSupportAgent,
    broker,
  );

  try {
    const result = await configured.investigateThread(input());
    assert.equal(turns, 3);
    assert.match(checkpointSeen, /aguardando evidência local auditável/);
    assert.doesNotMatch(checkpointSeen, /Banco indisponível/);
    assert.deepEqual(result.evidence, []);
  } finally {
    database.close();
  }
});

test("roteador encerra a exploração ao atingir o orçamento e pede síntese ao modelo", async () => {
  const database = createDatabase(":memory:");
  let modelTurns = 0;
  let brokerCalls = 0;
  const modelAgent = {
    async investigateThread(current: InvestigationThreadInput) {
      modelTurns += 1;
      if (current.executionBudget?.forceConclusion) {
        assert.equal(current.availableTools?.length, 0);
        return {
          assistantMessage: "Sintetizei as evidências disponíveis sem continuar varrendo o código.",
          phase: "conclusion" as const,
          threadSummary: "A exploração foi encerrada no orçamento seguro.",
          findings: [],
          evidence: [],
          suggestedResponse: null,
          nextAction: "Revisar a síntese.",
          confidence: 0.7,
          toolRequests: [],
        };
      }
      return {
        assistantMessage: `Busca ${modelTurns}.`,
        phase: "analysis" as const,
        threadSummary: `Foram realizadas ${modelTurns - 1} buscas.`,
        findings: [],
        evidence: [],
        suggestedResponse: null,
        nextAction: "Continuar buscando.",
        confidence: 0.4,
        toolRequests: [{
          requestId: `budget-${modelTurns}`,
          toolId: "codebase",
          operation: "search_files",
          argumentsJson: JSON.stringify({ query: `regra_${modelTurns}`, path: "server" }),
          purpose: "Localizar mais uma regra.",
        }],
      };
    },
  } as unknown as SupportAgent;
  const broker: DeepInvestigationToolBroker = {
    descriptors: () => [{
      id: "codebase",
      name: "Código",
      type: "codebase",
      description: null,
      scope: "raiz local",
      operations: [{
        name: "search_files",
        description: "Busca no código",
        argumentsExample: '{"query":"regra","path":"server"}',
      }],
    }],
    async executeMany(requests) {
      brokerCalls += 1;
      const request = requests[0]!;
      return [{
        requestId: request.requestId,
        toolId: request.toolId,
        toolName: "Código",
        operation: request.operation,
        argumentsJson: request.argumentsJson,
        purpose: request.purpose,
        status: "success",
        summary: "Busca concluída.",
        content: "resultado",
        reference: `tool:codebase:search:${brokerCalls}`,
        executedAt: "2026-08-26T15:00:00.000Z",
      }];
    },
  };
  const configured = new ConfiguredSupportAgent(
    database,
    settingsForDeepAgent(modelAgent),
    {} as CodexSupportAgent,
    broker,
    { maxToolOperations: 3, maxToolRounds: 10 },
  );

  try {
    const result = await configured.investigateThread(input());
    assert.equal(brokerCalls, 3);
    assert.equal(modelTurns, 4);
    assert.equal(result.phase, "conclusion");
    assert.match(result.assistantMessage, /sem continuar varrendo/i);
    assert.equal(result.toolExecutions?.length, 3);
  } finally {
    database.close();
  }
});

test("roteador bloqueia repetição semântica que altera apenas limites da busca", async () => {
  const database = createDatabase(":memory:");
  let modelTurns = 0;
  let brokerCalls = 0;
  const modelAgent = {
    async investigateThread(current: InvestigationThreadInput) {
      modelTurns += 1;
      if (modelTurns <= 2) {
        return {
          assistantMessage: "Vou procurar a mesma regra novamente.",
          phase: "analysis" as const,
          threadSummary: "Busca pela regra de faturamento.",
          findings: [],
          evidence: [],
          suggestedResponse: null,
          nextAction: "Buscar no código.",
          confidence: 0.4,
          toolRequests: [{
            requestId: `semantic-${modelTurns}`,
            toolId: "codebase",
            operation: "search_files",
            argumentsJson: JSON.stringify({
              query: "calculo faturamento aprovado",
              path: "server",
              maxResults: modelTurns === 1 ? 20 : 80,
            }),
            purpose: "Localizar a fórmula.",
          }],
        };
      }
      assert.match(current.toolResults?.at(-1)?.summary ?? "", /semanticamente repetida/i);
      return {
        assistantMessage: "Usei o resultado já disponível.",
        phase: "conclusion" as const,
        threadSummary: "A busca duplicada foi evitada.",
        findings: [],
        evidence: [],
        suggestedResponse: null,
        nextAction: "Revisar o resultado existente.",
        confidence: 0.7,
        toolRequests: [],
      };
    },
  } as unknown as SupportAgent;
  const broker: DeepInvestigationToolBroker = {
    descriptors: () => [{
      id: "codebase",
      name: "Código",
      type: "codebase",
      description: null,
      scope: "raiz local",
      operations: [{ name: "search_files", description: "Busca", argumentsExample: "{}" }],
    }],
    async executeMany(requests) {
      brokerCalls += 1;
      const request = requests[0]!;
      return [{
        requestId: request.requestId,
        toolId: request.toolId,
        toolName: "Código",
        operation: request.operation,
        argumentsJson: request.argumentsJson,
        purpose: request.purpose,
        status: "success",
        summary: "Regra localizada.",
        content: "resultado",
        reference: "tool:codebase:search:faturamento",
        executedAt: "2026-08-26T15:00:00.000Z",
      }];
    },
  };
  const configured = new ConfiguredSupportAgent(
    database,
    settingsForDeepAgent(modelAgent),
    {} as CodexSupportAgent,
    broker,
  );

  try {
    const result = await configured.investigateThread(input());
    assert.equal(modelTurns, 3);
    assert.equal(brokerCalls, 1);
    assert.equal(result.phase, "conclusion");
  } finally {
    database.close();
  }
});

test("consulta explícita ao banco por pedidos usa investigação profunda", () => {
  for (const body of [
    "Procure no banco e me dê o order id de pelo menos 2 pedidos na loja Danzi.",
    "Você deve procurar pelo ecommerce_id da Danzi para buscar os ecommerce_orders.",
  ]) {
    const current = input();
    current.recentMessages[0]!.body = body;
    const policy = investigationExecutionPolicy(current);
    assert.equal(policy.workload, "deep");
    assert.equal(policy.maxToolRounds, 8);
    assert.equal(policy.maxToolOperations, 16);
  }
});

test("janela do prompt preserva evidências bem-sucedidas quando erros recentes se acumulam", () => {
  const successes = Array.from({ length: 12 }, (_, index): InvestigationToolResult => ({
    requestId: `success-${index}`,
    toolId: "codebase",
    toolName: "Codebase",
    operation: index < 6 ? "search_files" : "read_files",
    argumentsJson: "{}",
    purpose: "Localizar e ler a implementação.",
    status: "success",
    summary: "Leitura concluída.",
    content: `evidência-${index}`,
    reference: `tool:codebase:result:${index}`,
    executedAt: `2026-08-27T20:00:${String(index).padStart(2, "0")}.000Z`,
  }));
  const errors = Array.from({ length: 10 }, (_, index): InvestigationToolResult => ({
    requestId: `error-${index}`,
    toolId: "codebase",
    toolName: "Codebase",
    operation: "search_files",
    argumentsJson: "{}",
    purpose: "Busca repetida.",
    status: "error",
    summary: "Limite da operação atingido.",
    content: "Limite da operação atingido.",
    reference: null,
    executedAt: `2026-08-27T20:01:${String(index).padStart(2, "0")}.000Z`,
  }));

  const selected = boundedToolResultsForPrompt([...successes, ...errors]);

  assert.equal(selected.length, 15);
  assert.equal(selected.filter((result) => result.status === "success").length, 12);
  assert.equal(selected.filter((result) => result.status === "error").length, 3);
  assert.deepEqual(
    selected.filter((result) => result.status === "success").map((result) => result.reference),
    successes.map((result) => result.reference),
  );
});

test("resultado extenso preserva início, trecho central e final no prompt", () => {
  const content = [
    "INÍCIO DA CONVERSA",
    "x".repeat(8_000),
    "EVIDÊNCIA CENTRAL: migração da Loja Integrada para Shopify",
    "y".repeat(8_000),
    "FIM DA CONVERSA",
  ].join("\n");
  const selected = boundedToolResultsForPrompt([{
    requestId: "long-conversation",
    toolId: "connected-app:intercom",
    toolName: "Intercom",
    operation: "get_conversation",
    argumentsJson: '{"conversationId":"123"}',
    purpose: "Ler a conversa completa.",
    status: "success",
    summary: "Conversa carregada.",
    content,
    reference: "tool:connected-app:intercom:get_conversation:123",
    executedAt: "2026-08-28T17:00:00.000Z",
  }]);

  assert.match(selected[0]?.content ?? "", /INÍCIO DA CONVERSA/);
  assert.match(selected[0]?.content ?? "", /EVIDÊNCIA CENTRAL/);
  assert.match(selected[0]?.content ?? "", /FIM DA CONVERSA/);
  assert.ok((selected[0]?.content.length ?? Infinity) <= 8_000);
});

test("operações esgotadas deixam de ser oferecidas sem ocultar outras leituras", () => {
  const descriptors = [{
    id: "local-tool:codebase:produto",
    name: "Codebase",
    type: "codebase" as const,
    description: null,
    scope: "código readonly",
    operations: [{
      name: "search_files",
      description: "Busca",
      argumentsExample: "{}",
    }, {
      name: "read_files",
      description: "Leitura",
      argumentsExample: "{}",
    }],
  }];
  const counts = new Map<string, number>([
    ["local-tool:codebase:produto\u0000search_files", 5],
    ["local-tool:codebase:produto\u0000read_files", 2],
  ]);

  const available = availableToolsWithinBudget(descriptors, counts, 8, 5);

  assert.equal(available.length, 1);
  assert.deepEqual(available[0]!.operations.map((operation) => operation.name), ["read_files"]);
});

test("bloqueio prematuro é reavaliado quando ainda existe leitura autorizada", async () => {
  const database = createDatabase(":memory:");
  let modelTurns = 0;
  let brokerCalls = 0;
  const modelAgent = {
    async investigateThread(current: InvestigationThreadInput) {
      modelTurns += 1;
      if (modelTurns === 1) {
        return {
          assistantMessage: "Preciso que você autorize uma consulta ao banco.",
          phase: "needs_information" as const,
          threadSummary: "Ainda não consultei a fonte disponível.",
          findings: [],
          evidence: [],
          suggestedResponse: null,
          nextAction: "Autorizar a leitura.",
          confidence: 0.1,
          toolRequests: [],
        };
      }
      if (modelTurns === 2) {
        assert.equal(current.executionBudget?.readonlyContinuationRequired, true);
        return {
          assistantMessage: "Vou consultar diretamente a fonte autorizada.",
          phase: "analysis" as const,
          threadSummary: "Consulta readonly solicitada.",
          findings: [],
          evidence: [],
          suggestedResponse: null,
          nextAction: "Consultar pedidos.",
          confidence: 0.3,
          toolRequests: [{
            requestId: "orders-readonly-1",
            toolId: "debugger",
            operation: "query_readonly",
            argumentsJson: JSON.stringify({
              query: "SELECT order_id FROM ecommerce_orders WHERE ecommerce_id = 'store-1' LIMIT 2",
              maxRows: 2,
            }),
            purpose: "Localizar dois pedidos da loja.",
          }],
        };
      }
      return {
        assistantMessage: "Encontrei dois pedidos da loja.",
        phase: "conclusion" as const,
        threadSummary: "Dois pedidos confirmados no banco.",
        findings: [{
          statement: "A loja possui os pedidos 1001 e 1002.",
          kind: "fact" as const,
          evidenceReferences: ["tool:debugger:query:orders"],
        }],
        evidence: [{
          source: "database" as const,
          reference: "tool:debugger:query:orders",
          excerpt: "order_id: 1001, 1002",
        }],
        suggestedResponse: null,
        nextAction: "Nenhuma.",
        confidence: 0.95,
        toolRequests: [],
      };
    },
  } as unknown as SupportAgent;
  const broker: DeepInvestigationToolBroker = {
    descriptors: () => [{
      id: "debugger",
      name: "Debugger",
      type: "postgres_readonly",
      description: null,
      scope: "banco readonly",
      operations: [{
        name: "query_readonly",
        description: "Executa SELECT limitado",
        argumentsExample: '{"query":"SELECT 1","maxRows":1}',
      }],
    }],
    async executeMany(requests) {
      brokerCalls += 1;
      const request = requests[0]!;
      return [{
        requestId: request.requestId,
        toolId: request.toolId,
        toolName: "Debugger",
        operation: request.operation,
        argumentsJson: request.argumentsJson,
        purpose: request.purpose,
        status: "success",
        summary: "Consulta concluída.",
        content: "order_id\n1001\n1002",
        reference: "tool:debugger:query:orders",
        executedAt: "2026-08-27T20:00:00.000Z",
      }];
    },
  };
  const configured = new ConfiguredSupportAgent(
    database,
    settingsForDeepAgent(modelAgent),
    {} as CodexSupportAgent,
    broker,
  );
  const current = input();
  current.recentMessages[0]!.body = "Procure no banco dois pedidos da loja Danzi.";

  try {
    const result = await configured.investigateThread(current);
    assert.equal(modelTurns, 3);
    assert.equal(brokerCalls, 1);
    assert.equal(result.phase, "conclusion");
    assert.match(result.assistantMessage, /dois pedidos/i);
  } finally {
    database.close();
  }
});

test("retomada no limite usa as evidências persistidas e não reabre o orçamento", async () => {
  const database = createDatabase(":memory:");
  let modelCalls = 0;
  let brokerCalls = 0;
  const modelAgent = {
    async investigateThread(current: InvestigationThreadInput) {
      modelCalls += 1;
      assert.equal(current.executionBudget?.forceConclusion, true);
      return {
        assistantMessage: "Ainda tentaria uma nova leitura.",
        phase: "analysis" as const,
        threadSummary: "A evidência persistida já atingiu o limite desta execução.",
        findings: [],
        evidence: [],
        suggestedResponse: null,
        nextAction: "Executar outra consulta.",
        confidence: 0.4,
        outcome: {
          objectiveStatus: "partially_answered" as const,
          rootCauseStatus: "unknown" as const,
          causalClassification: "unknown" as const,
          rootCause: null,
          unresolvedCriticalQuestions: ["Qual mecanismo causou a divergência?"],
          stopReason: "evidence_exhausted" as const,
        },
        toolRequests: [{
          requestId: `resume-read-${modelCalls}`,
          toolId: "resume-db",
          operation: "query_readonly",
          argumentsJson: JSON.stringify({ query: `SELECT ${modelCalls}`, maxRows: 1 }),
          purpose: "Tentar ampliar a investigação retomada.",
        }],
      };
    },
  } as unknown as SupportAgent;
  const broker: DeepInvestigationToolBroker = {
    descriptors: () => [{
      id: "resume-db",
      name: "Banco readonly",
      type: "postgres_readonly",
      description: null,
      scope: "Banco de teste",
      operations: [{
        name: "query_readonly",
        description: "Executa SELECT limitado.",
        argumentsExample: "{}",
        effect: "read",
        authorization: "none",
      }],
    }],
    async executeMany() {
      brokerCalls += 1;
      return [];
    },
  };
  const configured = new ConfiguredSupportAgent(
    database,
    settingsForDeepAgent(modelAgent),
    {} as CodexSupportAgent,
    broker,
    { maxToolOperations: 1 },
  );
  const current = input();
  current.toolResults = [{
    requestId: "persisted-read",
    toolId: "resume-db",
    toolName: "Banco readonly",
    operation: "query_readonly",
    argumentsJson: JSON.stringify({ query: "SELECT 1", maxRows: 1 }),
    purpose: "Leitura concluída antes da retomada.",
    status: "success",
    summary: "Evidência persistida.",
    content: "value=1",
    reference: "tool:resume-db:persisted",
    executedAt: "2026-09-01T17:00:00.000Z",
  }];
  current.recentMessages[0]!.body =
    "Investigue por que os dados ficaram divergentes.";

  try {
    const result = await configured.investigateThread(current);
    assert.equal(modelCalls, 1);
    assert.equal(brokerCalls, 0);
    assert.equal(result.phase, "needs_information");
    assert.equal(result.toolExecutions?.length, 1);
  } finally {
    database.close();
  }
});

test("retentativas compartilham um teto global de chamadas ao modelo", async () => {
  const database = createDatabase(":memory:");
  let modelCalls = 0;
  const configured = new ConfiguredSupportAgent(
    database,
    settingsForDeepAgent({
      async investigateThread() {
        modelCalls += 1;
        return {
          assistantMessage: "Não deveria executar outra chamada.",
          phase: "conclusion" as const,
          threadSummary: "",
          findings: [],
          evidence: [],
          suggestedResponse: null,
          nextAction: null,
          confidence: 0,
          toolRequests: [],
        };
      },
    } as unknown as SupportAgent),
    {} as CodexSupportAgent,
  );
  database.prepare(
    `INSERT INTO investigation_threads (id, scope, created_at, updated_at)
     VALUES ('thread-tools', 'workspace', '2026-09-01T12:00:00.000Z', '2026-09-01T12:00:00.000Z')`,
  ).run();
  database.prepare(
    `INSERT INTO investigation_thread_messages
       (id, thread_id, role, body, created_at)
     VALUES ('operator-1', 'thread-tools', 'operator', 'Investigue.', '2026-09-01T12:00:00.000Z')`,
  ).run();
  database.prepare(
    `INSERT INTO investigation_thread_jobs
       (id, thread_id, operator_message_id, state, requested_at, ai_model_calls)
     VALUES ('job-limit', 'thread-tools', 'operator-1', 'running', '2026-09-01T12:00:00.000Z', 10)`,
  ).run();

  try {
    const result = await configured.investigateThread(input());
    assert.equal(modelCalls, 0);
    assert.equal(result.phase, "needs_information");
    assert.doesNotMatch(
      `${result.assistantMessage} ${result.nextAction ?? ""}`,
      /orçamento|limite|budget/i,
    );
  } finally {
    database.close();
  }
});

test("orçamento interno encerra com síntese sem reabrir ciclos autônomos", async () => {
  const database = createDatabase(":memory:");
  let modelTurns = 0;
  let brokerCalls = 0;
  const modelAgent = {
    async investigateThread(current: InvestigationThreadInput) {
      modelTurns += 1;
      if (modelTurns === 1) {
        return analysisRequest("cycle-first", "SELECT 1 AS first_value");
      }
      if (modelTurns === 2) {
        assert.equal(current.executionBudget?.forceConclusion, true);
        return analysisRequest("cycle-second", "SELECT 2 AS second_value");
      }
      assert.fail("O coordenador não deve abrir um novo ciclo autônomo.");
    },
  } as unknown as SupportAgent;
  const analysisRequest = (requestId: string, query: string) => ({
    assistantMessage: "Continuando a investigação.",
    phase: "analysis" as const,
    threadSummary: "Investigação readonly em andamento.",
    findings: [],
    evidence: [],
    suggestedResponse: null,
    nextAction: "Executar a próxima leitura.",
    confidence: 0.4,
    toolRequests: [{
      requestId,
      toolId: "debugger",
      operation: "query_readonly",
      argumentsJson: JSON.stringify({ query, maxRows: 1 }),
      purpose: "Validar a hipótese atual.",
    }],
  });
  const broker: DeepInvestigationToolBroker = {
    descriptors: () => [{
      id: "debugger",
      name: "Debugger readonly",
      type: "postgres_readonly",
      description: null,
      scope: "banco readonly",
      operations: [{
        name: "query_readonly",
        description: "Executa SELECT limitado.",
        argumentsExample: '{}',
        effect: "read",
        authorization: "none",
      }],
    }],
    async executeMany(requests) {
      brokerCalls += 1;
      const request = requests[0]!;
      return [{
        requestId: request.requestId,
        toolId: request.toolId,
        toolName: "Debugger readonly",
        operation: request.operation,
        argumentsJson: request.argumentsJson,
        purpose: request.purpose,
        status: "success" as const,
        summary: "Consulta concluída.",
        content: String(brokerCalls),
        reference: `tool:debugger:cycle:${brokerCalls}`,
        executedAt: "2026-08-28T20:00:00.000Z",
      }];
    },
  };
  const configured = new ConfiguredSupportAgent(
    database,
    settingsForDeepAgent(modelAgent),
    {} as CodexSupportAgent,
    broker,
    { maxToolOperations: 1, maxToolRounds: 4 },
  );

  try {
    const result = await configured.investigateThread(input());
    assert.equal(result.phase, "needs_information");
    assert.equal(brokerCalls, 1);
    assert.equal(modelTurns, 2);
    assert.doesNotMatch(result.assistantMessage, /orçamento|limite|tente novamente/i);
  } finally {
    database.close();
  }
});

test("encerramento terminal do primeiro ciclo oculta limites internos e preserva evidência", async () => {
  const database = createDatabase(":memory:");
  let modelTurns = 0;
  let brokerCalls = 0;
  const modelAgent = {
    async investigateThread(current: InvestigationThreadInput) {
      modelTurns += 1;
      const reference = current.toolResults?.at(-1)?.reference ?? null;
      if (current.executionBudget?.forceConclusion) {
        return {
          assistantMessage: "O orçamento e o limite de operações acabaram; tente novamente.",
          phase: "analysis" as const,
          threadSummary: "A última leitura confirmou um registro.",
          findings: reference
            ? [{
                statement: "A consulta encontrou um registro confirmado.",
                kind: "fact" as const,
                evidenceReferences: [reference],
              }]
            : [],
          evidence: reference
            ? [{
                source: "database" as const,
                summary: "Registro confirmado pela consulta readonly.",
                reference,
              }]
            : [],
          suggestedResponse: null,
          nextAction: "O limite foi atingido; tente novamente.",
          confidence: 0.8,
          toolRequests: [{
            requestId: `terminal-force-${modelTurns}`,
            toolId: "debugger-terminal",
            operation: "query_readonly",
            argumentsJson: JSON.stringify({ query: `SELECT ${modelTurns}`, maxRows: 1 }),
            purpose: "Solicitar mais uma verificação antes da síntese.",
          }],
        };
      }
      return {
        assistantMessage: "Executando a leitura autorizada.",
        phase: "analysis" as const,
        threadSummary: "Leitura readonly em andamento.",
        findings: [],
        evidence: [],
        suggestedResponse: null,
        nextAction: "Consultar o registro.",
        confidence: 0.4,
        toolRequests: [{
          requestId: `terminal-read-${modelTurns}`,
          toolId: "debugger-terminal",
          operation: "query_readonly",
          argumentsJson: JSON.stringify({ query: `SELECT ${modelTurns}`, maxRows: 1 }),
          purpose: "Consultar o registro.",
        }],
      };
    },
  } as unknown as SupportAgent;
  const broker: DeepInvestigationToolBroker = {
    descriptors: () => [{
      id: "debugger-terminal",
      name: "Banco readonly",
      type: "postgres_readonly",
      description: null,
      scope: "Banco de teste",
      operations: [{
        name: "query_readonly",
        description: "Executa SELECT limitado.",
        argumentsExample: "{}",
        effect: "read",
        authorization: "none",
      }],
    }],
    async executeMany(requests) {
      brokerCalls += 1;
      const request = requests[0]!;
      return [{
        requestId: request.requestId,
        toolId: request.toolId,
        toolName: "Banco readonly",
        operation: request.operation,
        argumentsJson: request.argumentsJson,
        purpose: request.purpose,
        status: "success" as const,
        summary: "Consulta concluída.",
        content: `registro-${brokerCalls}`,
        reference: `tool:debugger-terminal:query:${brokerCalls}`,
        executedAt: "2026-08-28T20:20:00.000Z",
      }];
    },
  };
  const configured = new ConfiguredSupportAgent(
    database,
    settingsForDeepAgent(modelAgent),
    {} as CodexSupportAgent,
    broker,
    { maxToolOperations: 1, maxToolRounds: 4 },
  );

  try {
    const result = await configured.investigateThread(input());
    assert.equal(brokerCalls, 1);
    assert.equal(result.phase, "conclusion");
    assert.match(result.assistantMessage, /evidências verificadas/i);
    assert.doesNotMatch(
      `${result.assistantMessage} ${result.nextAction ?? ""}`,
      /orçamento|limite|budget|tente novamente/i,
    );
    assert.equal(result.evidence.length, 1);
  } finally {
    database.close();
  }
});

test("leituras internas e de apps independentes executam em paralelo", async () => {
  const database = createDatabase(":memory:");
  let turns = 0;
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  let releaseBoth!: () => void;
  const bothStarted = new Promise<void>((resolve) => {
    releaseBoth = resolve;
  });
  const modelAgent = {
    async investigateThread() {
      turns += 1;
      if (turns === 1) {
        return {
          assistantMessage: "Vou cruzar as duas fontes.",
          phase: "analysis" as const,
          threadSummary: "Leituras independentes solicitadas.",
          findings: [],
          evidence: [],
          suggestedResponse: null,
          nextAction: "Cruzar as fontes.",
          confidence: 0.4,
          toolRequests: [{
            requestId: "parallel-local",
            toolId: "threadmark-context",
            operation: "search_support_context",
            argumentsJson: '{"query":"cliente","scope":"all","limit":5}',
            purpose: "Consultar o contexto local.",
          }, {
            requestId: "parallel-app",
            toolId: "connected-app:crm",
            operation: "search_records",
            argumentsJson: '{"input":{"query":"cliente"}}',
            purpose: "Consultar o app autorizado.",
          }],
        };
      }
      return {
        assistantMessage: "As fontes foram cruzadas.",
        phase: "conclusion" as const,
        threadSummary: "Duas fontes consultadas.",
        findings: [],
        evidence: [],
        suggestedResponse: null,
        nextAction: null,
        confidence: 0.8,
        toolRequests: [],
      };
    },
  } as unknown as SupportAgent;
  const broker: DeepInvestigationToolBroker = {
    descriptors: () => [
      {
        id: "threadmark-context",
        name: "Contexto local",
        type: "knowledge",
        description: null,
        scope: "SQLite",
        operations: [{
          name: "search_support_context",
          description: "Busca local.",
          argumentsExample: '{}',
          effect: "read",
          authorization: "none",
        }],
      },
      {
        id: "connected-app:crm",
        name: "CRM",
        type: "connected_app",
        description: null,
        scope: "App autorizado",
        operations: [{
          name: "search_records",
          description: "Busca externa.",
          argumentsExample: '{}',
          effect: "read",
          authorization: "none",
        }],
      },
    ],
    async executeMany(requests) {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (calls === 2) releaseBoth();
      await bothStarted;
      active -= 1;
      const request = requests[0]!;
      return [{
        requestId: request.requestId,
        toolId: request.toolId,
        toolName: request.toolId,
        operation: request.operation,
        argumentsJson: request.argumentsJson,
        purpose: request.purpose,
        status: "success" as const,
        summary: "Leitura concluída.",
        content: "resultado",
        reference: `tool:${request.toolId}:${request.requestId}`,
        executedAt: "2026-08-28T20:00:00.000Z",
      }];
    },
  };
  const configured = new ConfiguredSupportAgent(
    database,
    settingsForDeepAgent(modelAgent),
    {} as CodexSupportAgent,
    broker,
  );

  try {
    const result = await configured.investigateThread(input());
    assert.equal(result.phase, "conclusion");
    assert.equal(calls, 2);
    assert.equal(maxActive, 2);
  } finally {
    database.close();
  }
});

test("leitura concluída permanece auditada quando outra leitura paralela falha", async () => {
  const database = createDatabase(":memory:");
  let releaseSlowSuccess!: () => void;
  const failureStarted = new Promise<void>((resolve) => {
    releaseSlowSuccess = resolve;
  });
  const audited: string[] = [];
  const modelAgent = {
    async investigateThread() {
      return {
        assistantMessage: "Vou consultar as duas fontes.",
        phase: "analysis" as const,
        threadSummary: "Leituras paralelas em andamento.",
        findings: [],
        evidence: [],
        suggestedResponse: null,
        nextAction: "Cruzar resultados.",
        confidence: 0.3,
        toolRequests: [{
          requestId: "parallel-audited-success",
          toolId: "local-read",
          operation: "search",
          argumentsJson: "{}",
          purpose: "Concluir uma leitura auditável.",
        }, {
          requestId: "parallel-rejection",
          toolId: "remote-read",
          operation: "search",
          argumentsJson: "{}",
          purpose: "Simular falha concorrente.",
        }],
      };
    },
  } as unknown as SupportAgent;
  const broker: DeepInvestigationToolBroker = {
    descriptors: () => ["local-read", "remote-read"].map((id) => ({
      id,
      name: id,
      type: "knowledge" as const,
      description: null,
      scope: "readonly",
      operations: [{
        name: "search",
        description: "Consulta readonly.",
        argumentsExample: "{}",
        effect: "read" as const,
        authorization: "none" as const,
      }],
    })),
    async executeMany(requests) {
      const request = requests[0]!;
      if (request.requestId === "parallel-rejection") {
        releaseSlowSuccess();
        throw new Error("fonte remota indisponível");
      }
      await failureStarted;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return [{
        requestId: request.requestId,
        toolId: request.toolId,
        toolName: request.toolId,
        operation: request.operation,
        argumentsJson: request.argumentsJson,
        purpose: request.purpose,
        status: "success" as const,
        summary: "Leitura local concluída.",
        content: "resultado preservado",
        reference: "tool:local-read:search:1",
        executedAt: "2026-08-28T20:10:00.000Z",
      }];
    },
  };
  const configured = new ConfiguredSupportAgent(
    database,
    settingsForDeepAgent(modelAgent),
    {} as CodexSupportAgent,
    broker,
  );
  const current = input();
  current.onToolExecution = (execution) => {
    audited.push(execution.requestId);
  };

  try {
    await assert.rejects(
      configured.investigateThread(current),
      /fonte remota indisponível/,
    );
    assert.deepEqual(audited, ["parallel-audited-success"]);
  } finally {
    database.close();
  }
});

test("coordenador corrige e repete uma leitura com erro contratual recuperável", async () => {
  const database = createDatabase(":memory:");
  const requests: InvestigationToolRequest[] = [];
  const audited: InvestigationToolResult[] = [];
  let modelCalls = 0;
  const modelAgent = {
    async investigateThread(current: InvestigationThreadInput) {
      modelCalls += 1;
      if (!current.toolResults?.some((result) => result.status === "success")) {
        return {
          assistantMessage: "Vou consultar os logs da campanha.",
          phase: "analysis" as const,
          threadSummary: "Objetivo: confirmar a falha da campanha nos logs.",
          findings: [],
          evidence: [],
          suggestedResponse: null,
          nextAction: "Consultar logs.",
          confidence: 0.2,
          toolRequests: [{
            requestId: "logs-future",
            toolId: "campaign-logs",
            operation: "query_logs",
            argumentsJson: JSON.stringify({
              logGroup: "/aws/lambda/campaign",
              endTime: "2026-09-01T16:00:00.000Z",
            }),
            purpose: "Confirmar o erro de envio.",
          }],
        };
      }
      const evidence = current.toolResults.find((result) => result.status === "success")!;
      return {
        assistantMessage: "Motivo confirmado: o processamento foi ignorado por variável ausente.",
        phase: "conclusion" as const,
        threadSummary: "Causa confirmada nos logs: variável ausente.",
        findings: [{
          statement: "O processamento foi ignorado por variável ausente.",
          kind: "fact" as const,
          evidenceReferences: [evidence.reference!],
        }],
        evidence: [{
          source: "aws" as const,
          summary: evidence.summary,
          reference: evidence.reference,
        }],
        suggestedResponse: null,
        nextAction: "Corrigir o fallback antes de reenviar.",
        confidence: 0.98,
        toolRequests: [],
      };
    },
  } as unknown as SupportAgent;
  const broker: DeepInvestigationToolBroker = {
    descriptors: () => [{
      id: "campaign-logs",
      name: "Logs de campanhas",
      type: "aws_cloudwatch",
      description: null,
      scope: "readonly",
      operations: [{
        name: "query_logs",
        description: "Consulta logs.",
        argumentsExample: "{}",
        effect: "read",
        authorization: "none",
      }],
    }],
    async executeMany(current) {
      const request = current[0]!;
      requests.push(request);
      if (requests.length === 1) {
        return [{
          requestId: request.requestId,
          toolId: request.toolId,
          toolName: "Logs de campanhas",
          operation: request.operation,
          argumentsJson: request.argumentsJson,
          purpose: request.purpose,
          status: "error",
          error: {
            code: "TIME_RANGE_IN_FUTURE",
            category: "invalid_time_range",
            retryable: true,
            suggestedArgumentsJson: JSON.stringify({
              logGroup: "/aws/lambda/campaign",
              endTime: "2026-08-31T16:00:00.000Z",
            }),
          },
          summary: "Janela corrigível.",
          content: "Janela corrigível.",
          reference: null,
          executedAt: "2026-08-31T16:00:00.000Z",
        }];
      }
      return [{
        requestId: request.requestId,
        toolId: request.toolId,
        toolName: "Logs de campanhas",
        operation: request.operation,
        argumentsJson: request.argumentsJson,
        purpose: request.purpose,
        status: "success",
        summary: "Logs consultados no intervalo corrigido.",
        content: "missing_variable_fallback",
        reference: "tool:campaign-logs:query:corrected",
        executedAt: "2026-08-31T16:00:01.000Z",
      }];
    },
  };
  const configured = new ConfiguredSupportAgent(
    database,
    settingsForDeepAgent(modelAgent),
    {} as CodexSupportAgent,
    broker,
  );
  const current = input();
  current.recentMessages[0]!.body = "Investigue por que a campanha não enviou.";
  current.onToolExecution = (execution) => {
    audited.push(execution);
  };

  try {
    const result = await configured.investigateThread(current);
    assert.equal(result.phase, "conclusion");
    assert.equal(modelCalls, 2);
    assert.equal(requests.length, 2);
    assert.equal(requests[1]?.requestId, "logs-future:safe-retry");
    assert.equal(
      JSON.parse(requests[1]!.argumentsJson).endTime,
      "2026-08-31T16:00:00.000Z",
    );
    assert.deepEqual(audited.map((item) => item.status), ["error", "success"]);
  } finally {
    database.close();
  }
});

test("verificador causal rejeita conclusão que descreve apenas onde o fluxo parou", () => {
  const current = input();
  current.recentMessages[0]!.body = "Investigue por que a campanha não enviou as mensagens.";
  const result = enforceCausalCompletion({
    assistantMessage: "O fluxo parou no nó de carrinho.",
    phase: "conclusion",
    threadSummary: "O nó de carrinho permaneceu processando.",
    findings: [{
      statement: "O nó de carrinho permaneceu processando.",
      kind: "fact",
      evidenceReferences: ["tool:db:node-state"],
    }],
    evidence: [{
      source: "database",
      summary: "Estado do nó consultado.",
      reference: "tool:db:node-state",
    }],
    suggestedResponse: null,
    nextAction: "Revisar o nó.",
    confidence: 0.9,
    outcome: {
      objectiveStatus: "partially_answered",
      rootCauseStatus: "unknown",
      causalClassification: "unknown",
      rootCause: null,
      unresolvedCriticalQuestions: [
        "Qual condição fez os destinatários serem ignorados?",
      ],
      stopReason: "evidence_exhausted",
    },
    toolRequests: [],
  }, current, [{
    requestId: "node-state",
    toolId: "db",
    toolName: "Banco readonly",
    operation: "query_readonly",
    argumentsJson: "{}",
    purpose: "Consultar estado.",
    status: "success",
    summary: "Estado consultado.",
    content: "DOING",
    reference: "tool:db:node-state",
    executedAt: "2026-08-31T16:00:00.000Z",
  }], [{
    id: "db",
    name: "Banco readonly",
    type: "postgres_readonly",
    description: null,
    scope: "readonly",
    operations: [{
      name: "query_readonly",
      description: "Consulta.",
      argumentsExample: "{}",
      effect: "read",
      authorization: "none",
    }],
  }]);

  assert.equal(result.phase, "needs_information");
  assert.match(result.assistantMessage, /^Ainda não confirmado:/);
  assert.match(result.nextAction ?? "", /Cruzar a próxima fonte readonly/i);
  assert.ok(result.findings.some((finding) =>
    finding.kind === "missing_information" && /condição/i.test(finding.statement)
  ));
});

test("verificador causal conclui como provável quando só uma fonte técnica sustenta a causa", async () => {
  const database = createDatabase(":memory:");
  let modelCalls = 0;
  let brokerCalls = 0;
  const reference = "tool:db:root-cause";
  const modelAgent = {
    async investigateThread(current: InvestigationThreadInput) {
      modelCalls += 1;
      if (!current.toolResults?.length) {
        return {
          assistantMessage: "Vou consultar a fonte readonly disponível.",
          phase: "analysis" as const,
          threadSummary: "A causa ainda precisa ser confirmada no banco.",
          findings: [],
          evidence: [],
          suggestedResponse: null,
          nextAction: "Consultar o motivo da falha.",
          confidence: 0.4,
          outcome: {
            objectiveStatus: "partially_answered" as const,
            rootCauseStatus: "unknown" as const,
            causalClassification: "unknown" as const,
            rootCause: null,
            unresolvedCriticalQuestions: ["Qual condição causou a falha?"],
            stopReason: "needs_more_evidence" as const,
          },
          toolRequests: [{
            requestId: "root-cause-read",
            toolId: "db-root-cause",
            operation: "query_readonly",
            argumentsJson: JSON.stringify({ query: "SELECT failure_reason LIMIT 1", maxRows: 1 }),
            purpose: "Confirmar a causa raiz da falha.",
          }],
        };
      }
      return {
        assistantMessage: "Causa mais provável: a configuração ausente causou a falha.",
        phase: "conclusion" as const,
        threadSummary: "Causa provável encontrada no banco.",
        findings: [{
          statement: "A configuração obrigatória estava ausente.",
          kind: "fact" as const,
          evidenceReferences: [reference],
        }],
        evidence: [{
          source: "database" as const,
          summary: "Motivo da falha consultado.",
          reference,
        }],
        suggestedResponse: null,
        nextAction: "Corrigir a configuração obrigatória.",
        confidence: 0.95,
        outcome: {
          objectiveStatus: "answered" as const,
          rootCauseStatus: "probable" as const,
          causalClassification: "configuration" as const,
          rootCause: "A configuração obrigatória estava ausente.",
          rootCauseEvidenceReferences: [reference],
          unresolvedCriticalQuestions: [],
          stopReason: "evidence_exhausted" as const,
        },
        toolRequests: [],
      };
    },
  } as unknown as SupportAgent;
  const broker: DeepInvestigationToolBroker = {
    descriptors: () => [{
      id: "db-root-cause",
      name: "Banco readonly",
      type: "postgres_readonly",
      description: null,
      scope: "Banco de teste",
      operations: [{
        name: "query_readonly",
        description: "Executa SELECT limitado.",
        argumentsExample: "{}",
        effect: "read",
        authorization: "none",
      }],
    }],
    async executeMany(requests) {
      brokerCalls += 1;
      const request = requests[0]!;
      return [{
        requestId: request.requestId,
        toolId: request.toolId,
        toolName: "Banco readonly",
        operation: request.operation,
        argumentsJson: request.argumentsJson,
        purpose: request.purpose,
        status: "success" as const,
        summary: "Motivo consultado.",
        content: "failure_reason=missing_required_config",
        reference,
        executedAt: "2026-09-01T15:45:00.000Z",
      }];
    },
  };
  const configured = new ConfiguredSupportAgent(
    database,
    settingsForDeepAgent(modelAgent),
    {} as CodexSupportAgent,
    broker,
  );
  const current = input();
  current.recentMessages[0]!.body = "Investigue por que o processamento falhou.";

  try {
    const result = await configured.investigateThread(current);
    assert.equal(brokerCalls, 1);
    assert.equal(modelCalls, 2);
    assert.equal(result.phase, "conclusion");
    assert.match(result.assistantMessage, /^Causa mais provável:/);
    assert.equal(result.outcome?.rootCauseStatus, "probable");
  } finally {
    database.close();
  }
});

test("verificador causal libera causa confirmada com duas fontes técnicas independentes", () => {
  const current = input();
  current.recentMessages[0]!.body = "Investigue o motivo da campanha não enviar.";
  const reference = "tool:db:skip-reason";
  const codeReference = "tool:code:fallback-rule";
  const result = enforceCausalCompletion({
    assistantMessage: "A maioria foi ignorada antes do envio.",
    phase: "conclusion",
    threadSummary: "Causa confirmada por motivo de skip.",
    findings: [{
      statement: "1.418 destinatários foram ignorados porque firstName não tinha fallback.",
      kind: "fact",
      evidenceReferences: [reference, codeReference],
    }],
    evidence: [
      { source: "database", summary: "Motivos reconciliados.", reference },
      { source: "code", summary: "Contrato da variável confirmado.", reference: codeReference },
    ],
    suggestedResponse: null,
    nextAction: "Adicionar fallback e reenviar somente aos elegíveis.",
    confidence: 0.99,
    outcome: {
      objectiveStatus: "answered",
      rootCauseStatus: "confirmed",
      causalClassification: "configuration",
      rootCause: "O template exigia firstName sem fallback.",
      rootCauseEvidenceReferences: [reference, codeReference],
      unresolvedCriticalQuestions: [],
      stopReason: "cause_confirmed",
    },
    toolRequests: [],
  }, current, [{
    requestId: "skip-reason",
    toolId: "db",
    toolName: "Banco readonly",
    operation: "query_readonly",
    argumentsJson: "{}",
    purpose: "Reconciliar motivos.",
    status: "success",
    summary: "Motivos reconciliados.",
    content: "missing_variable_fallback=1418",
    reference,
    executedAt: "2026-08-31T16:00:00.000Z",
  }, {
    requestId: "fallback-rule",
    toolId: "code",
    toolName: "Código",
    operation: "search_files",
    argumentsJson: "{}",
    purpose: "Confirmar o contrato da variável.",
    status: "success",
    summary: "Contrato consultado.",
    content: "firstName.required=true; fallback=false",
    reference: codeReference,
    executedAt: "2026-08-31T16:00:01.000Z",
  }], [{
    id: "db",
    name: "Banco readonly",
    type: "postgres_readonly",
    description: null,
    scope: "readonly",
    operations: [],
  }, {
    id: "code",
    name: "Código",
    type: "codebase",
    description: null,
    scope: "readonly",
    operations: [],
  }]);

  assert.equal(result.phase, "conclusion");
  assert.match(result.assistantMessage, /^Motivo confirmado:/);
  assert.equal(result.outcome?.causalClassification, "configuration");
});

test("pack pode exigir duas fontes técnicas independentes antes de confirmar causa", () => {
  const current = input();
  current.recentMessages[0]!.body = "Investigue o motivo da campanha não enviar.";
  current.activeInvestigationPack = {
    id: "pack-two-sources",
    name: "Pack privado",
    status: "active",
    version: 1,
    manifest: {
      domain: "Domínio de teste",
      purpose: "Exigir confirmação cruzada.",
      goals: ["Confirmar a causa."],
      selectedToolIds: ["db", "code"],
      vocabulary: [],
      sourcePolicy: {
        preferredToolTypes: ["postgres_readonly", "codebase"],
        minimumIndependentSources: 2,
        preferExactIdentifiers: true,
      },
      responsePolicy: {
        verdictFirst: true,
        includeDecisiveNumbers: true,
        separateUnknowns: true,
        includeCustomerDraft: false,
      },
      playbooks: [],
    },
    readiness: {
      state: "ready",
      deepInvestigationEnabled: true,
      messages: [],
      toolChecks: [],
      model: { connectionId: "codex", model: "default", status: "ready" },
      checkedAt: "2026-08-31T16:00:00.000Z",
    },
    createdByUserId: null,
    createdAt: "2026-08-31T16:00:00.000Z",
    updatedAt: "2026-08-31T16:00:00.000Z",
    activatedAt: "2026-08-31T16:00:00.000Z",
  };
  const reference = "tool:db:skip-reason";
  const result = enforceCausalCompletion({
    assistantMessage: "O template não tinha fallback.",
    phase: "conclusion",
    threadSummary: "Uma fonte indicou a causa.",
    findings: [{
      statement: "1.600 destinatários ficaram sem a variável obrigatória.",
      kind: "fact",
      evidenceReferences: [reference],
    }],
    evidence: [{ source: "database", summary: "Motivos reconciliados.", reference }],
    suggestedResponse: null,
    nextAction: "Confirmar a regra no código.",
    confidence: 0.9,
    outcome: {
      objectiveStatus: "answered",
      rootCauseStatus: "confirmed",
      causalClassification: "configuration",
      rootCause: "O template exigia uma variável sem fallback.",
      unresolvedCriticalQuestions: [],
      stopReason: "cause_confirmed",
    },
    toolRequests: [],
  }, current, [{
    requestId: "skip-reason",
    toolId: "db",
    toolName: "Banco readonly",
    operation: "query_readonly",
    argumentsJson: "{}",
    purpose: "Reconciliar motivos.",
    status: "success",
    summary: "Motivos reconciliados.",
    content: "missing_variable=1600",
    reference,
    executedAt: "2026-08-31T16:00:00.000Z",
  }], [{
    id: "db",
    name: "Banco readonly",
    type: "postgres_readonly",
    description: null,
    scope: "readonly",
    operations: [{
      name: "query_readonly",
      description: "Consulta.",
      argumentsExample: "{}",
      effect: "read",
      authorization: "none",
    }],
  }]);

  assert.equal(result.phase, "needs_information");
  assert.match(result.nextAction ?? "", /próxima fonte readonly/i);
  assert.doesNotMatch(result.assistantMessage, /^Motivo confirmado:/);
});

test("verificador causal não usa fatos técnicos alheios para confirmar a causa raiz", () => {
  const current = input();
  current.recentMessages[0]!.body = "Investigue por que as notas de agosto não sincronizaram.";
  current.activeInvestigationPack = {
    id: "pack-causal-sources",
    name: "Pack privado",
    status: "active",
    version: 1,
    manifest: {
      domain: "Integrações",
      purpose: "Investigar causa com confirmação cruzada.",
      goals: ["Confirmar a causa."],
      selectedToolIds: ["db", "code"],
      vocabulary: [],
      sourcePolicy: {
        preferredToolTypes: ["postgres_readonly", "codebase"],
        minimumIndependentSources: 2,
        preferExactIdentifiers: true,
      },
      responsePolicy: {
        verdictFirst: true,
        includeDecisiveNumbers: true,
        separateUnknowns: true,
        includeCustomerDraft: false,
      },
      playbooks: [],
    },
    readiness: {
      state: "ready",
      deepInvestigationEnabled: true,
      messages: [],
      toolChecks: [],
      model: { connectionId: "codex", model: "default", status: "ready" },
      checkedAt: "2026-09-01T16:00:00.000Z",
    },
    createdByUserId: null,
    createdAt: "2026-09-01T16:00:00.000Z",
    updatedAt: "2026-09-01T16:00:00.000Z",
    activatedAt: "2026-09-01T16:00:00.000Z",
  };
  const dbReference = "tool:db:invoice-gap";
  const codeReference = "tool:code:sync-flow";
  const result = enforceCausalCompletion({
    assistantMessage: "O 429 causou a lacuna histórica.",
    phase: "conclusion",
    threadSummary: "A lacuna e o fluxo foram consultados; o 429 histórico segue sem log.",
    findings: [
      {
        statement: "Existem datas sem notas no banco.",
        kind: "fact",
        evidenceReferences: [dbReference],
      },
      {
        statement: "O fluxo atual trata HTTP 429 com retry.",
        kind: "fact",
        evidenceReferences: [codeReference],
      },
    ],
    evidence: [
      { source: "database", summary: "Lacuna de notas atual.", reference: dbReference },
      { source: "code", summary: "Comportamento atual do retry.", reference: codeReference },
      { source: "conversation", summary: "Relato anterior de 429.", reference: "ticket:323" },
    ],
    suggestedResponse: null,
    nextAction: null,
    confidence: 0.94,
    outcome: {
      objectiveStatus: "answered",
      rootCauseStatus: "confirmed",
      causalClassification: "provider",
      rootCause: "O rate limit 429 interrompeu a sincronização histórica.",
      rootCauseEvidenceReferences: ["ticket:323"],
      unresolvedCriticalQuestions: [],
      stopReason: "cause_confirmed",
    },
    toolRequests: [],
  }, current, [
    {
      requestId: "invoice-gap",
      toolId: "db",
      toolName: "Banco readonly",
      operation: "query_readonly",
      argumentsJson: "{}",
      purpose: "Medir a lacuna.",
      status: "success",
      summary: "Lacuna consultada.",
      content: "missing_dates=14",
      reference: dbReference,
      executedAt: "2026-09-01T16:00:00.000Z",
    },
    {
      requestId: "sync-flow",
      toolId: "code",
      toolName: "Código",
      operation: "search_files",
      argumentsJson: "{}",
      purpose: "Entender o fluxo.",
      status: "success",
      summary: "Fluxo consultado.",
      content: "retryAfter429()",
      reference: codeReference,
      executedAt: "2026-09-01T16:00:00.000Z",
    },
  ], [
    {
      id: "db",
      name: "Banco readonly",
      type: "postgres_readonly",
      description: null,
      scope: "readonly",
      operations: [],
    },
    {
      id: "code",
      name: "Código",
      type: "codebase",
      description: null,
      scope: "readonly",
      operations: [],
    },
  ], true);

  assert.equal(result.phase, "conclusion");
  assert.match(result.assistantMessage, /^Causa mais provável:/);
  assert.equal(result.outcome?.rootCauseStatus, "probable");
  assert.match(result.assistantMessage, /429 causou a lacuna histórica/i);
});
