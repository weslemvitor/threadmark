import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CodexProviderAdapter,
  StructuredSupportAgent,
} from "../server/agent/provider-agent.js";
import {
  AI_PROVIDER_CAPABILITIES,
  ProviderRequestError,
  type StructuredJsonClient,
  type StructuredJsonRequest,
} from "../server/agent/provider.js";
import { createSupportAgent } from "../server/agent/provider-factory.js";
import { SUPPORT_ANALYSIS_JSON_SCHEMA } from "../server/agent/provider-schemas.js";
import { AnthropicMessagesClient } from "../server/agent/providers/anthropic.js";
import { OllamaChatClient } from "../server/agent/providers/ollama.js";
import { OpenAIResponsesClient } from "../server/agent/providers/openai.js";
import { OpenRouterChatClient } from "../server/agent/providers/openrouter.js";
import type {
  InvestigationThreadInput,
  SupportAnalysisInput,
  TriageAnalysisInput,
} from "../server/agent/types.js";

const validAnalysis = {
  createTicket: true,
  outcome: "needs_information",
  relation: "new",
  relatedTicketId: null,
  title: "Pedidos ausentes",
  summary: "A cliente informou que pedidos não aparecem.",
  affectedEcommerce: null,
  priority: "normal",
  categories: {
    contactReason: ["Problema"],
    productArea: ["Pedidos"],
    platform: [],
    symptom: ["Pedidos ausentes"],
  },
  evidence: [{
    source: "conversation",
    summary: "Há um relato explícito de pedidos ausentes.",
    reference: "message-1",
  }],
  suggestedResponse: "Pode informar a loja e um pedido de exemplo?",
  missingInformation: ["Loja afetada", "Pedido de exemplo"],
  nextAction: "Solicitar os identificadores.",
  confidence: 0.86,
} as const;

const validTriage = {
  groups: [{
    messageIds: ["message-1"],
    kind: "demand",
    suggestedAction: "create",
    relatedTicketId: null,
    relatedSuggestionId: null,
    title: "Pedidos ausentes",
    summary: "A cliente relatou pedidos ausentes.",
    affectedEcommerce: null,
    categories: {
      contactReason: ["Problema"],
      productArea: ["Pedidos"],
      platform: [],
      symptom: ["Pedidos ausentes"],
    },
    reason: "Existe uma demanda explícita.",
    confidence: 0.91,
  }],
} as const;

const validTurn = {
  assistantMessage: "A investigação foi concluída.",
  phase: "conclusion",
  threadSummary: "Investigação concluída.",
  evidence: [{
    source: "conversation",
    summary: "A demanda foi confirmada no contexto atual do ticket.",
    reference: "message-1",
  }],
  suggestedResponse: "Resposta segura.",
  nextAction: "Revisar.",
  confidence: 0.9,
  toolRequests: [],
} as const;

function supportInput(localPath?: string): SupportAnalysisInput {
  return {
    accountName: "Cliente",
    accountType: "ecommerce",
    groupName: "Suporte Cliente",
    knownEcommerces: [],
    conversationState: {
      lastExternalMessageAt: "2026-07-18T10:00:00.000Z",
      lastSentResponseAt: null,
      unansweredExternalMessageIds: ["message-1"],
      hasUnansweredExternalMessages: true,
    },
    openTickets: [],
    sentResponses: [],
    resolvedPrecedents: [],
    messages: [{
      id: "message-1",
      author: "Cliente",
      role: "external",
      timestampUtc: "2026-07-18T10:00:00.000Z",
      text: "Meus pedidos não aparecem.",
      quotedMessageId: null,
      attachments: localPath
        ? [{
            kind: "image",
            fileName: "evidencia.png",
            mimeType: "image/png",
            localPath,
            extractedText: null,
          }]
        : [],
    }],
  };
}

function triageInput(): TriageAnalysisInput {
  const input = supportInput();
  return {
    accountName: input.accountName,
    accountType: input.accountType,
    groupName: input.groupName,
    knownEcommerces: input.knownEcommerces,
    candidateMessageIds: ["message-1"],
    messages: input.messages,
    openTickets: input.openTickets,
    pendingSuggestions: [{
      id: "suggestion-1",
      title: "Pedidos ausentes",
      summary: "O relato começou em uma mensagem anterior.",
      suggestedAction: "create",
      suggestedTicketId: null,
      lastMessageAt: "2026-07-18T09:59:00.000Z",
    }],
  };
}

function threadInput(): InvestigationThreadInput {
  return {
    threadId: "thread-1",
    currentOperatorMessageId: "operator-1",
    durableSummary: "",
    recentMessages: [{
      id: "operator-1",
      role: "operator",
      body: "Investigue o caso.",
      phase: null,
      createdAt: "2026-07-18T10:05:00.000Z",
    }],
    ticket: supportInput(),
    automaticInvestigation: null,
  };
}

function structuredRequest(): StructuredJsonRequest {
  return {
    prompt: "Devolva JSON.",
    schemaName: "result",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["ok"],
      properties: { ok: { type: "boolean" } },
    },
    model: "configured-model",
    images: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }],
  };
}

function captureFetch(payload: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json", "x-request-id": "req-1" },
    });
  };
  return { fetchImpl, calls };
}

function requestBody(call: { init: RequestInit }): Record<string, unknown> {
  if (typeof call.init.body !== "string") {
    throw new TypeError("O corpo capturado deveria ser uma string JSON.");
  }
  return JSON.parse(call.init.body) as Record<string, unknown>;
}

test("todos os provedores podem atender tarefas e codebase permanece exclusiva do Codex", () => {
  for (const [providerId, capabilities] of Object.entries(
    AI_PROVIDER_CAPABILITIES,
  )) {
    assert.equal(capabilities.structuredOutput, true);
    assert.equal(capabilities.deepInvestigation, true, providerId);
    assert.equal(capabilities.codebaseAccess, providerId === "codex", providerId);
    assert.equal(capabilities.triage, true, providerId);
    assert.equal(capabilities.automaticAnalysis, true, providerId);
  }
});

test("factory cria provedores sem persistir ou normalizar segredos", () => {
  const { fetchImpl } = captureFetch({ message: { content: '{"ok":true}' } });
  const agent = createSupportAgent({
    providerId: "ollama",
    model: "local-model",
    fetchImpl,
  });

  assert.equal(agent.providerId, "ollama");
  assert.equal(agent.capabilities.localExecution, true);
  assert.equal("$schema" in SUPPORT_ANALYSIS_JSON_SCHEMA, false);
});

test("adapter do Codex propaga o modelo configurado em cada tarefa", async () => {
  const calls: Array<{ task: string; model: string }> = [];
  const fakeCodex = {
    async analyse(_input: unknown, model: string) {
      calls.push({ task: "analyse", model });
      return validAnalysis;
    },
    async investigateThread(_input: unknown, model: string) {
      calls.push({ task: "investigateThread", model });
      return validTurn;
    },
    async triage(_input: unknown, model: string) {
      calls.push({ task: "triage", model });
      return validTriage;
    },
  };
  const adapter = new CodexProviderAdapter(fakeCodex as never, "codex-profile-model");

  await adapter.analyse(supportInput());
  await adapter.investigateThread(threadInput());
  await adapter.triage(triageInput(), "codex-triage-model");

  assert.deepEqual(calls, [
    { task: "analyse", model: "codex-profile-model" },
    { task: "investigateThread", model: "codex-profile-model" },
    { task: "triage", model: "codex-triage-model" },
  ]);
  assert.equal(adapter.providerId, "codex");
});

test("OpenAI Responses envia text.format json_schema e lê output estruturado", async () => {
  const { fetchImpl, calls } = captureFetch({
    output: [{
      type: "message",
      content: [{ type: "output_text", text: '{"ok":true}' }],
    }],
  });
  const client = new OpenAIResponsesClient({
    apiKey: "sk-private",
    baseUrl: "https://example.test/v1",
    fetchImpl,
  });

  assert.doesNotMatch(JSON.stringify(client), /sk-private/);
  assert.deepEqual(await client.generateJson(structuredRequest()), { ok: true });
  assert.equal(calls[0]?.url, "https://example.test/v1/responses");
  const body = requestBody(calls[0]!);
  assert.equal(body.store, false);
  assert.deepEqual(
    (body.text as { format: unknown }).format,
    {
      type: "json_schema",
      name: "result",
      strict: true,
      schema: structuredRequest().schema,
    },
  );
  assert.equal(
    (calls[0]?.init.headers as Record<string, string>).authorization,
    "Bearer sk-private",
  );
  assert.doesNotMatch(JSON.stringify(body), /sk-private/);
});

test("Anthropic Messages usa output_config.format e conteúdo base64", async () => {
  const { fetchImpl, calls } = captureFetch({
    content: [{ type: "text", text: '{"ok":true}' }],
  });
  const client = new AnthropicMessagesClient({
    apiKey: "anthropic-private",
    baseUrl: "https://example.test/v1",
    fetchImpl,
  });

  assert.deepEqual(await client.generateJson(structuredRequest()), { ok: true });
  const body = requestBody(calls[0]!);
  assert.deepEqual(
    (body.output_config as { format: unknown }).format,
    { type: "json_schema", schema: structuredRequest().schema },
  );
  const message = (body.messages as Array<{ content: unknown[] }>)[0]!;
  assert.equal((message.content[1] as { type: string }).type, "image");
  assert.equal(
    (calls[0]?.init.headers as Record<string, string>)["x-api-key"],
    "anthropic-private",
  );
});

test("OpenRouter usa chat completions com response_format estrito", async () => {
  const { fetchImpl, calls } = captureFetch({
    choices: [{ message: { content: '{"ok":true}' } }],
  });
  const client = new OpenRouterChatClient({
    apiKey: "openrouter-private",
    baseUrl: "https://example.test/api/v1",
    appName: "Threadmark",
    appUrl: "https://threadmark.test",
    fetchImpl,
  });

  assert.deepEqual(await client.generateJson(structuredRequest()), { ok: true });
  assert.equal(calls[0]?.url, "https://example.test/api/v1/chat/completions");
  const body = requestBody(calls[0]!);
  assert.deepEqual(body.response_format, {
    type: "json_schema",
    json_schema: {
      name: "result",
      strict: true,
      schema: structuredRequest().schema,
    },
  });
  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers["X-Title"], "Threadmark");
  assert.equal(headers["HTTP-Referer"], "https://threadmark.test");
});

test("Ollama usa /api/chat, stream false e schema no campo format", async () => {
  const { fetchImpl, calls } = captureFetch({
    message: { role: "assistant", content: '{"ok":true}' },
  });
  const client = new OllamaChatClient({
    baseUrl: "http://127.0.0.1:11434/api",
    fetchImpl,
  });

  assert.deepEqual(await client.generateJson(structuredRequest()), { ok: true });
  assert.equal(calls[0]?.url, "http://127.0.0.1:11434/api/chat");
  const body = requestBody(calls[0]!);
  assert.equal(body.stream, false);
  assert.deepEqual(body.format, structuredRequest().schema);
  const message = (body.messages as Array<{ images?: string[] }>)[0]!;
  assert.deepEqual(message.images, ["aW1hZ2U="]);
  assert.equal(
    Object.keys(calls[0]?.init.headers as Record<string, string>).some(
      (key) => key.toLowerCase() === "authorization",
    ),
    false,
  );
});

test("erros HTTP não expõem corpo da resposta nem chave da API", async () => {
  const { fetchImpl } = captureFetch(
    { error: "invalid key sk-private and conversation contents" },
    401,
  );
  const client = new OpenAIResponsesClient({
    apiKey: "sk-private",
    fetchImpl,
  });

  await assert.rejects(
    client.generateJson(structuredRequest()),
    (error: unknown) => {
      assert.ok(error instanceof ProviderRequestError);
      assert.equal(error.status, 401);
      assert.equal(error.requestId, "req-1");
      assert.doesNotMatch(String(error), /sk-private|conversation contents/);
      return true;
    },
  );
});

test("agente estruturado valida a resposta final com o schema Zod existente", async () => {
  const invalidClient: StructuredJsonClient = {
    async generateJson() {
      return { ...validAnalysis, confidence: 7 };
    },
  };
  const agent = new StructuredSupportAgent({
    providerId: "openai",
    model: "model",
    client: invalidClient,
  });

  await assert.rejects(agent.analyse(supportInput()), /confidence/i);
});

test("agente remoto limita respostas enviadas e precedentes antes do prompt", async () => {
  let receivedInput: SupportAnalysisInput | null = null;
  const client: StructuredJsonClient = {
    async generateJson(request) {
      const match = request.prompt.match(
        /<DADOS_NAO_CONFIAVEIS>\n([\s\S]+)\n<\/DADOS_NAO_CONFIAVEIS>/,
      );
      assert.ok(match?.[1]);
      receivedInput = JSON.parse(match[1]) as SupportAnalysisInput;
      return validAnalysis;
    },
  };
  const agent = new StructuredSupportAgent({
    providerId: "openai",
    model: "model",
    client,
  });
  const input = supportInput();
  input.conversationState.unansweredExternalMessageIds = Array.from(
    { length: 60 },
    (_, index) => `message-${index}-${"i".repeat(600)}`,
  );
  input.sentResponses = Array.from({ length: 40 }, (_, index) => ({
    id: `response-${index}-${"r".repeat(600)}`,
    messageId: `message-${index}-${"m".repeat(600)}`,
    body: "b".repeat(10_000),
    sentAt: "2026-07-18T10:01:00.000Z",
  }));
  input.resolvedPrecedents = Array.from({ length: 25 }, (_, index) => ({
    ticketId: `ticket-${index}-${"t".repeat(600)}`,
    title: "t".repeat(3_000),
    summary: "s".repeat(5_000),
    resolvedAt: "2026-07-17T10:00:00.000Z",
    affectedStore: {
      id: `store-${index}-${"i".repeat(600)}`,
      name: "n".repeat(600),
    },
    categories: Array.from({ length: 35 }, () => "c".repeat(300)),
    resolution: {
      summary: "r".repeat(10_000),
      rootCause: "c".repeat(5_000),
      outcome: "o".repeat(5_000),
      validatedAt: "2026-07-17T10:00:00.000Z",
    },
    finalResponse: "f".repeat(10_000),
  }));

  await agent.analyse(input);
  const bounded = receivedInput as SupportAnalysisInput | null;
  assert.ok(bounded);
  assert.equal(bounded.sentResponses.length, 30);
  assert.equal(bounded.sentResponses[0]?.id.length, 500);
  assert.equal(bounded.sentResponses[0]?.body.length, 8_000);
  assert.equal(bounded.resolvedPrecedents.length, 20);
  assert.equal(bounded.resolvedPrecedents[0]?.ticketId.length, 500);
  assert.equal(bounded.resolvedPrecedents[0]?.affectedStore?.id.length, 500);
  assert.equal(bounded.resolvedPrecedents[0]?.affectedStore?.name.length, 500);
  assert.equal(bounded.resolvedPrecedents[0]?.categories.length, 30);
  assert.equal(bounded.conversationState.unansweredExternalMessageIds.length, 50);
  assert.equal(input.sentResponses.length, 40);
  assert.equal(input.resolvedPrecedents.length, 25);
});

test("agente remoto rejeita precedente resolvido fora do contexto fornecido", async () => {
  const input = supportInput();
  input.resolvedPrecedents = [{
    ticketId: "ticket-resolvido-1",
    title: "Pedidos ausentes",
    summary: "Mesmo sintoma validado anteriormente.",
    resolvedAt: "2026-07-17T10:00:00.000Z",
    affectedStore: null,
    categories: ["Pedidos"],
    resolution: {
      summary: "A integração foi reativada.",
      rootCause: "Credencial inválida.",
      outcome: "Resolvido",
      validatedAt: "2026-07-17T10:00:00.000Z",
    },
    finalResponse: "Integração reativada.",
  }];
  const client: StructuredJsonClient = {
    async generateJson() {
      return {
        ...validAnalysis,
        evidence: [{
          source: "resolved_ticket",
          summary: "Precedente citado.",
          reference: "ticket-inventado",
        }],
      };
    },
  };
  const agent = new StructuredSupportAgent({
    providerId: "anthropic",
    model: "model",
    client,
  });

  await assert.rejects(agent.analyse(input), /ticketId exato/i);
});

test("agente remoto oferece investigação profunda contextual sem ferramentas locais", async () => {
  const requests: StructuredJsonRequest[] = [];
  const client: StructuredJsonClient = {
    async generateJson(request) {
      requests.push(request);
      return validTurn;
    },
  };
  const agent = new StructuredSupportAgent({
    providerId: "anthropic",
    model: "model",
    client,
  });

  assert.deepEqual(await agent.investigateThread(threadInput()), validTurn);
  assert.equal(requests[0]?.schemaName, "investigation_turn");
  assert.equal(requests[0]?.model, "model");
  assert.match(requests[0]?.prompt ?? "", /Investigue o caso/);
});

test("investigação profunda remota só cita precedentes recebidos no ticket", async () => {
  const input = threadInput();
  input.ticket.resolvedPrecedents = [{
    ticketId: "ticket-resolvido-1",
    title: "Pedidos ausentes",
    summary: "Mesmo sintoma em um caso anterior.",
    resolvedAt: "2026-07-17T10:00:00.000Z",
    affectedStore: null,
    categories: ["Pedidos"],
    resolution: {
      summary: "Integração reativada.",
      rootCause: "Credencial inválida.",
      outcome: "Resolvido",
      validatedAt: "2026-07-17T10:00:00.000Z",
    },
    finalResponse: "Integração reativada.",
  }];
  const client: StructuredJsonClient = {
    async generateJson() {
      return {
        ...validTurn,
        evidence: [{
          source: "resolved_ticket",
          summary: "Precedente citado.",
          reference: "ticket-inventado",
        }],
      };
    },
  };
  const agent = new StructuredSupportAgent({
    providerId: "openrouter",
    model: "model",
    client,
  });

  await assert.rejects(agent.investigateThread(input), /ticketId exato/i);
});

test("investigação profunda descarta citação de conversa inválida sem perder a sala", async () => {
  const client: StructuredJsonClient = {
    async generateJson() {
      return {
        ...validTurn,
        evidence: [{
          source: "conversation",
          summary: "Mensagem supostamente presente.",
          reference: "message-inventada",
        }],
      };
    },
  };
  const agent = new StructuredSupportAgent({
    providerId: "openai",
    model: "model",
    client,
  });

  const result = await agent.investigateThread(threadInput());
  assert.equal(result.phase, "analysis");
  assert.deepEqual(result.evidence, []);
  assert.equal(result.suggestedResponse, null);
  assert.equal(result.confidence, 0.5);
  assert.match(result.nextAction ?? "", /ID exato de uma mensagem/i);
});

test("investigação profunda audita leitura knowledge por ferramenta", async () => {
  const reference = "tool:knowledge:read:metricas.md";
  const client: StructuredJsonClient = {
    async generateJson() {
      return {
        ...validTurn,
        evidence: [{
          source: "knowledge",
          summary: "Regra documentada.",
          reference,
        }],
      };
    },
  };
  const agent = new StructuredSupportAgent({
    providerId: "openai",
    model: "model",
    client,
  });
  const input = threadInput();
  input.availableTools = [{
    id: "knowledge-tool",
    name: "Base local",
    type: "knowledge",
    description: null,
    scope: "readonly",
    operations: [],
  }];
  input.toolResults = [{
    requestId: "request-1",
    toolId: "knowledge-tool",
    toolName: "Base local",
    operation: "read_files",
    argumentsJson: "{}",
    purpose: "Confirmar a regra documentada.",
    status: "success",
    summary: "Arquivo lido.",
    content: "O total considera clientes únicos.",
    reference,
    executedAt: "2026-07-20T10:00:00.000Z",
  }];
  assert.equal(
    (await agent.investigateThread(input)).evidence[0]?.reference,
    reference,
  );

  input.availableTools[0] = {
    ...input.availableTools[0]!,
    type: "codebase",
  };
  await assert.rejects(
    agent.investigateThread(input),
    /leitura knowledge bem-sucedida/i,
  );
});

test("agente remoto só envia imagens locais dentro da raiz confiável", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "threadmark-provider-"));
  const attachmentsRoot = path.join(temporary, "attachments");
  const trusted = path.join(attachmentsRoot, "trusted.png");
  const outside = path.join(temporary, "outside.png");
  await mkdir(attachmentsRoot, { recursive: true });
  await writeFile(trusted, "trusted");
  await writeFile(outside, "outside");
  const requests: StructuredJsonRequest[] = [];
  const client: StructuredJsonClient = {
    async generateJson(request) {
      requests.push(request);
      return validAnalysis;
    },
  };
  const agent = new StructuredSupportAgent({
    providerId: "ollama",
    model: "model",
    attachmentsRoot,
    client,
  });

  try {
    const input = supportInput(trusted);
    input.messages[0]!.attachments.push({
      kind: "image",
      fileName: "outside.png",
      mimeType: "image/png",
      localPath: outside,
      extractedText: null,
    });
    await agent.analyse(input);

    assert.equal(requests[0]?.images.length, 1);
    assert.doesNotMatch(requests[0]!.prompt, new RegExp(temporary));
    assert.equal(
      Buffer.from(requests[0]!.images[0]!.dataBase64, "base64").toString(),
      "trusted",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("triagem remota mantém cobertura exata e ordem das candidatas", async () => {
  const client: StructuredJsonClient = {
    async generateJson() {
      return {
        groups: [{
          ...validTriage.groups[0],
          messageIds: ["message-2", "message-1"],
        }],
      };
    },
  };
  const agent = new StructuredSupportAgent({
    providerId: "openrouter",
    model: "model",
    client,
  });
  const input = triageInput();
  input.candidateMessageIds.push("message-2");
  input.messages.push({
    ...input.messages[0]!,
    id: "message-2",
    text: "É a mesma dúvida.",
  });

  await assert.rejects(
    agent.triage(input, ""),
    /alterou a ordem da conversa/i,
  );
});

test("triagem remota só relaciona sugestões pendentes recebidas no contexto", async () => {
  let relatedSuggestionId = "suggestion-1";
  const client: StructuredJsonClient = {
    async generateJson() {
      return {
        groups: [{
          ...validTriage.groups[0],
          kind: "continuation",
          relatedSuggestionId,
        }],
      };
    },
  };
  const agent = new StructuredSupportAgent({
    providerId: "openrouter",
    model: "model",
    client,
  });
  const input = triageInput();

  const accepted = await agent.triage(input, "");
  assert.equal(accepted.groups[0]?.relatedSuggestionId, "suggestion-1");

  relatedSuggestionId = "suggestion-fora-do-contexto";
  await assert.rejects(
    agent.triage(input, ""),
    /sugestão fora do contexto permitido/i,
  );
});

test("triagem remota limita sugestões pendentes antes de enviá-las ao provedor", async () => {
  let receivedInput: TriageAnalysisInput | null = null;
  const client: StructuredJsonClient = {
    async generateJson(request) {
      const match = request.prompt.match(
        /<DADOS_NAO_CONFIAVEIS>\n([\s\S]+)\n<\/DADOS_NAO_CONFIAVEIS>/,
      );
      assert.ok(match?.[1]);
      receivedInput = JSON.parse(match[1]) as TriageAnalysisInput;
      return validTriage;
    },
  };
  const agent = new StructuredSupportAgent({
    providerId: "openrouter",
    model: "model",
    client,
  });
  const input = triageInput();
  input.pendingSuggestions = Array.from({ length: 35 }, (_, index) => ({
    id: `suggestion-${index}-${"i".repeat(600)}`,
    title: "t".repeat(2_500),
    summary: "s".repeat(5_000),
    suggestedAction: "create" as const,
    suggestedTicketId: `ticket-${"x".repeat(600)}`,
    lastMessageAt: "2026-07-18T09:59:00.000Z",
  }));

  await agent.triage(input, "");
  const bounded = receivedInput as TriageAnalysisInput | null;
  assert.ok(bounded);
  assert.equal(bounded.pendingSuggestions.length, 30);
  assert.equal(bounded.pendingSuggestions[0]?.id.length, 500);
  assert.equal(bounded.pendingSuggestions[0]?.title.length, 2_000);
  assert.equal(bounded.pendingSuggestions[0]?.summary.length, 4_000);
  assert.equal(bounded.pendingSuggestions[0]?.suggestedTicketId?.length, 500);
});
