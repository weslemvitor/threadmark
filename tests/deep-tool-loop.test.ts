import assert from "node:assert/strict";
import test from "node:test";

import type { CodexSupportAgent } from "../server/agent/codex-runner.js";
import type { AiProviderSettingsService } from "../server/agent/provider-settings.js";
import { ConfiguredSupportAgent, type DeepInvestigationToolBroker } from "../server/agent/provider-router.js";
import type { SupportAgent } from "../server/agent/provider.js";
import type { InvestigationThreadInput } from "../server/agent/types.js";
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

test("roteador bloqueia requestId já auditado e evidência com origem diferente da ferramenta", async () => {
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
    assert.equal(result.phase, "needs_information");
    assert.equal(result.suggestedResponse, null);
    assert.equal(result.evidence.length, 0);
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
    assert.equal(turns, 2);
    assert.match(checkpointSeen, /aguardando evidência local auditável/);
    assert.doesNotMatch(checkpointSeen, /Banco indisponível/);
    assert.deepEqual(result.evidence, []);
  } finally {
    database.close();
  }
});
