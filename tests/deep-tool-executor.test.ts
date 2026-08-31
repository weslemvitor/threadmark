import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDatabase } from "../server/db/index.js";
import { SupportStore } from "../server/domain/index.js";
import { ConnectedAppService } from "../server/integrations/index.js";
import { LocalSecretVault } from "../server/runtime/secret-vault.js";
import {
  DeepToolExecutor,
  type PostgresQueryRequest,
} from "../server/tools/deep-tool-executor.js";
import { LocalToolService } from "../server/tools/local-tool-service.js";

test("auditoria limita resultados extensos sem bloquear o turno do Threadmark AI", () => {
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);

  try {
    const thread = store.createThreadmarkAiThread({}, "Pessoa Proprietária");
    store.addInvestigationThreadMessage(thread.id, {
      body: "Investigue os registros extensos sem interromper o atendimento.",
    });
    const claimed = store.claimNextAgentJob();
    assert.equal(claimed?.kind, "thread_turn");
    if (!claimed || claimed.kind !== "thread_turn") assert.fail("turno não reivindicado");

    const persisted = store.appendInvestigationThreadToolExecution(claimed.id, {
      requestId: "large-audit-result",
      toolId: "codebase",
      toolName: "Código local",
      operation: "search_code",
      argumentsJson: JSON.stringify({ query: "resultado" }),
      purpose: "Validar o limite seguro da auditoria.",
      status: "success",
      summary: "Busca concluída com muitos resultados.",
      content: `início\n${"x".repeat(60_000)}\nfim`,
      reference: "local-tool:codebase:large-audit-result",
      executedAt: "2026-08-28T17:00:00.000Z",
    });

    assert.ok(persisted.content.length <= 50_000);
    assert.match(persisted.content, /^início/);
    assert.match(persisted.content, /conteúdo excedente omitido da auditoria/i);
    assert.match(persisted.content, /fim$/);
  } finally {
    database.close();
  }
});

test("app conectado autorizado fica disponível ao Threadmark AI sem expor o segredo", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "threadmark-connected-app-tool-"));
  const database = createDatabase(":memory:");
  const vault = new LocalSecretVault(path.join(temporary, "secrets"));
  const localTools = new LocalToolService(database, vault);
  const connectedApps = new ConnectedAppService(database, vault);
  const app = await connectedApps.create({
    type: "intercom",
    name: "Intercom",
    description: "Cria rascunhos de documentação.",
    enabled: true,
    aiEnabled: true,
    endpoint: "https://api.intercom.io/",
    secret: "intercom-test-token",
  }, "Teste");
  let observedAuthorization = "";
  let observedBody = "";
  let externalCalls = 0;
  const store = new SupportStore(database);
  const thread = store.createThreadmarkAiThread({}, "Pessoa Proprietária");
  store.addInvestigationThreadMessage(thread.id, {
    body: "Crie a documentação como rascunho no Intercom.",
  });
  const operatorMessage = store.getThreadmarkAiThread(thread.id).messages.find(
    (message) => message.role === "operator",
  );
  assert.ok(operatorMessage);
  const executor = new DeepToolExecutor(localTools, {
    database,
    connectedApps,
    integrationVault: vault,
    integrationLookup: async () => [{ address: "93.184.216.34" }],
    fetchImpl: async (_input, init) => {
      externalCalls += 1;
      observedAuthorization = new Headers(init?.headers).get("authorization") ?? "";
      observedBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ id: "article-42", state: "draft" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  try {
    const descriptor = executor.descriptors().find((item) => item.id === `connected-app:${app.id}`);
    assert.ok(descriptor);
    assert.equal(descriptor.type, "connected_app");
    assert.deepEqual(descriptor.operations.map((item) => item.name), [
      "search_conversations",
      "get_conversation",
      "get_current_admin",
      "list_collections",
      "create_article",
    ]);
    assert.doesNotMatch(JSON.stringify(descriptor), /intercom-test-token/);

    const result = await executor.execute({
      requestId: "intercom-create-1",
      toolId: descriptor.id,
      operation: "create_article",
      argumentsJson: JSON.stringify({
        confirmationMessageId: operatorMessage.id,
        title: "Como configurar",
        description: "Orientação revisável",
        body: "<p>Passo a passo</p>",
        authorId: "admin-42",
        collectionId: "collection-12",
      }),
      purpose: "Criar o rascunho solicitado explicitamente pelo operador.",
    });

    assert.equal(result.status, "success");
    assert.match(result.content, /article-42/);
    assert.equal(observedAuthorization, "Bearer intercom-test-token");
    assert.match(observedBody, /Como configurar/);
    assert.deepEqual(JSON.parse(observedBody), {
      title: "Como configurar",
      description: "Orientação revisável",
      body: "<p>Passo a passo</p>",
      author_id: "admin-42",
      state: "draft",
      parent_id: "collection-12",
      parent_type: "collection",
    });
    assert.doesNotMatch(JSON.stringify(result), /intercom-test-token/);

    database.prepare(
      "UPDATE investigation_thread_jobs SET state = 'completed', finished_at = requested_at, result_json = '{}' WHERE thread_id = ? AND state IN ('queued', 'running')",
    ).run(thread.id);
    const retryThread = store.addThreadmarkAiMessage(thread.id, { body: "Tenta novamente" });
    const retryMessage = retryThread.messages.filter((message) => message.role === "operator").at(-1);
    assert.ok(retryMessage);
    const retried = await executor.execute({
      requestId: "intercom-create-retry",
      toolId: descriptor.id,
      operation: "create_article",
      argumentsJson: JSON.stringify({
        confirmationMessageId: retryMessage.id,
        title: "Como configurar novamente",
        description: "Retomada da tarefa ativa",
        body: "<p>Passo a passo revisado</p>",
        authorId: "admin-42",
        collectionId: "collection-12",
      }),
      purpose: "Retomar a ação externa explicitamente solicitada na mesma tarefa.",
    });
    assert.equal(retried.status, "success", retried.summary);

    const retryJob = store.claimNextAgentJob();
    assert.equal(retryJob?.kind, "thread_turn");
    if (!retryJob || retryJob.kind !== "thread_turn") assert.fail("turno de repetição não reivindicado");
    store.appendInvestigationThreadToolExecution(retryJob.id, retried);
    database.prepare(
      "UPDATE investigation_thread_jobs SET state = 'completed', finished_at = requested_at, result_json = '{}' WHERE id = ?",
    ).run(retryJob.id);
    const completedRetryThread = store.addThreadmarkAiMessage(thread.id, { body: "Tenta novamente" });
    const completedRetryMessage = completedRetryThread.messages
      .filter((message) => message.role === "operator")
      .at(-1);
    assert.ok(completedRetryMessage);
    const completedRetry = await executor.execute({
      requestId: "intercom-create-after-success",
      toolId: descriptor.id,
      operation: "create_article",
      argumentsJson: JSON.stringify({
        confirmationMessageId: completedRetryMessage.id,
        title: "Não deve duplicar",
        description: "A ação anterior já terminou",
        body: "<p>Não executar</p>",
        authorId: "admin-42",
        collectionId: "collection-12",
      }),
      purpose: "Comprovar que uma repetição não reutiliza autorização já consumida.",
    });
    assert.equal(completedRetry.status, "error");
    assert.equal(externalCalls, 2);

    database.prepare(
      "UPDATE investigation_thread_jobs SET state = 'completed', finished_at = requested_at, result_json = '{}' WHERE thread_id = ? AND state IN ('queued', 'running')",
    ).run(thread.id);
    const questionThread = store.addThreadmarkAiMessage(thread.id, {
      body: "Como criar uma documentação no Intercom?",
    });
    const questionMessage = questionThread.messages.filter((message) => message.role === "operator").at(-1);
    assert.ok(questionMessage);
    const questionMutation = await executor.execute({
      requestId: "intercom-question-must-not-write",
      toolId: descriptor.id,
      operation: "create_article",
      argumentsJson: JSON.stringify({
        confirmationMessageId: questionMessage.id,
        title: "Não deve criar",
        description: "Pergunta não é autorização",
        body: "<p>Não executar</p>",
        authorId: "admin-42",
        collectionId: "collection-12",
      }),
      purpose: "Comprovar que uma pergunta não autoriza escrita.",
    });
    assert.equal(questionMutation.status, "error");
    assert.equal(externalCalls, 2);

    database.prepare(
      "UPDATE investigation_thread_jobs SET state = 'completed', finished_at = requested_at, result_json = '{}' WHERE thread_id = ? AND state IN ('queued', 'running')",
    ).run(thread.id);
    const ticketThread = store.addThreadmarkAiMessage(thread.id, {
      body: "Crie um ticket no Threadmark.",
    });
    const ticketMessage = ticketThread.messages.filter((message) => message.role === "operator").at(-1);
    assert.ok(ticketMessage);
    const crossTargetMutation = await executor.execute({
      requestId: "intercom-ticket-intent-must-not-write",
      toolId: descriptor.id,
      operation: "create_article",
      argumentsJson: JSON.stringify({
        confirmationMessageId: ticketMessage.id,
        title: "Não deve criar artigo",
        description: "O alvo solicitado era um ticket",
        body: "<p>Não executar</p>",
        authorId: "admin-42",
        collectionId: "collection-12",
      }),
      purpose: "Comprovar que autorização de ticket não autoriza escrita no Intercom.",
    });
    assert.equal(crossTargetMutation.status, "error");
    assert.equal(externalCalls, 2);
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("ação no Slack exige identificar o app além da mensagem a enviar", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "threadmark-slack-target-"));
  const database = createDatabase(":memory:");
  const vault = new LocalSecretVault(path.join(temporary, "secrets"));
  const localTools = new LocalToolService(database, vault);
  const connectedApps = new ConnectedAppService(database, vault);
  const app = await connectedApps.create({
    type: "slack_webhook",
    name: "Slack do suporte",
    enabled: true,
    aiEnabled: true,
    endpoint: "https://hooks.slack.com/services/test/test/test",
  }, "Teste");
  let externalCalls = 0;
  const executor = new DeepToolExecutor(localTools, {
    database,
    connectedApps,
    integrationVault: vault,
    integrationLookup: async () => [{ address: "93.184.216.34" }],
    fetchImpl: async () => {
      externalCalls += 1;
      return new Response("ok", { status: 200 });
    },
  });
  const store = new SupportStore(database);
  const thread = store.createThreadmarkAiThread({}, "Pessoa Proprietária");

  try {
    store.addInvestigationThreadMessage(thread.id, { body: "Envie a mensagem." });
    const genericMessage = store.getThreadmarkAiThread(thread.id).messages.find(
      (message) => message.role === "operator",
    );
    assert.ok(genericMessage);
    const blocked = await executor.execute({
      requestId: "slack-generic-target",
      toolId: `connected-app:${app.id}`,
      operation: "send_message",
      argumentsJson: JSON.stringify({
        confirmationMessageId: genericMessage.id,
        text: "Mensagem de teste",
      }),
      purpose: "Comprovar que a mensagem sem o app não autoriza envio.",
    });
    assert.equal(blocked.status, "error");
    assert.equal(externalCalls, 0);

    database.prepare(
      "UPDATE investigation_thread_jobs SET state = 'completed', finished_at = requested_at, result_json = '{}' WHERE thread_id = ? AND state IN ('queued', 'running')",
    ).run(thread.id);
    const explicitThread = store.addThreadmarkAiMessage(thread.id, {
      body: "Envie a mensagem no Slack do suporte.",
    });
    const explicitMessage = explicitThread.messages.filter((message) => message.role === "operator").at(-1);
    assert.ok(explicitMessage);
    const allowed = await executor.execute({
      requestId: "slack-explicit-target",
      toolId: `connected-app:${app.id}`,
      operation: "send_message",
      argumentsJson: JSON.stringify({
        confirmationMessageId: explicitMessage.id,
        text: "Mensagem de teste",
      }),
      purpose: "Enviar ao Slack explicitamente identificado.",
    });
    assert.equal(allowed.status, "success", allowed.summary);
    assert.equal(externalCalls, 1);
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Threadmark AI recebe somente ferramentas MCP autorizadas e executa sem expor o token", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "threadmark-mcp-ai-tool-"));
  const database = createDatabase(":memory:");
  const vault = new LocalSecretVault(path.join(temporary, "secrets"));
  const localTools = new LocalToolService(database, vault);
  let observedMcpArguments: Record<string, unknown> | null = null;
  let mcpToolCalls = 0;
  const connectedApps = new ConnectedAppService(
    database,
    vault,
    async (_input, init) => {
      const request = JSON.parse(String(init?.body ?? "{}")) as {
        id?: string | number;
        method?: string;
        params?: { arguments?: Record<string, unknown> };
      };
      if (request.method === "tools/call") {
        mcpToolCalls += 1;
        observedMcpArguments = request.params?.arguments ?? null;
      }
      if (request.id === undefined) return new Response(null, { status: 202 });
      const result = request.method === "initialize"
        ? {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "mock", version: "1.0.0" },
          }
        : request.method === "tools/list"
          ? {
              tools: [{
                name: "search_projects",
                title: "Buscar projetos",
                description: "Lista projetos por nome.",
                inputSchema: {
                  type: "object",
                  properties: {
                    workspaceId: { type: "string" },
                    query: { type: "string" },
                    cursor: { type: "string" },
                  },
                  required: ["workspaceId"],
                },
                annotations: { readOnlyHint: true, destructiveHint: false },
              }, {
                name: "delete_project",
                title: "Excluir projeto",
                description: "Exclui um projeto.",
                inputSchema: { type: "object" },
                annotations: { readOnlyHint: false, destructiveHint: true },
              }],
            }
          : request.method === "tools/call"
            ? { structuredContent: { projects: [{ id: "project-1", name: "Suporte" }] }, content: [] }
            : {};
      return Response.json({ jsonrpc: "2.0", id: request.id, result }, {
        headers: { "mcp-session-id": "ai-test" },
      });
    },
    async () => [{ address: "93.184.216.34" }],
  );

  try {
    const created = await connectedApps.create({
      type: "mcp_remote",
      name: "Projetos MCP",
      enabled: true,
      aiEnabled: true,
      endpoint: "https://mcp.example.com/mcp",
      secret: "ai-mcp-secret",
    }, "Teste");
    await connectedApps.validateConnection(created.id);
    await connectedApps.update(created.id, {
      type: "mcp_remote",
      name: "Projetos MCP",
      enabled: true,
      aiEnabled: true,
      endpoint: "",
      mcpTools: [{
        name: "search_projects",
        aiEnabled: true,
        automationEnabled: false,
        confirmationRequired: false,
      }, {
        name: "delete_project",
        aiEnabled: true,
        automationEnabled: false,
        confirmationRequired: true,
      }],
    }, "Teste");
    const executor = new DeepToolExecutor(localTools, {
      database,
      connectedApps,
      integrationVault: vault,
    });
    const descriptor = executor.descriptors().find(
      (candidate) => candidate.id === `connected-app:${created.id}`,
    );
    assert.ok(descriptor);
    assert.deepEqual(descriptor.operations.map((operation) => operation.name), [
      "search_projects",
      "delete_project",
    ]);
    const searchOperation = descriptor.operations.find((operation) => operation.name === "search_projects");
    assert.ok(searchOperation);
    assert.deepEqual(JSON.parse(searchOperation.argumentsExample), {
      input: { workspaceId: "<workspaceId>" },
    });
    assert.match(searchOperation.description, /Campos opcionais: query:string, cursor:string/);
    assert.doesNotMatch(JSON.stringify(descriptor), /ai-mcp-secret/);

    const result = await executor.execute({
      requestId: "mcp-search-1",
      toolId: descriptor.id,
      operation: "search_projects",
      argumentsJson: JSON.stringify({
        input: {
          workspaceId: "workspace-1",
          query: "Suporte",
          cursor: null,
        },
      }),
      purpose: "Localizar o projeto solicitado.",
    });
    assert.equal(result.status, "success");
    assert.deepEqual(observedMcpArguments, {
      workspaceId: "workspace-1",
      query: "Suporte",
    });
    assert.match(result.content, /project-1/);
    assert.doesNotMatch(JSON.stringify(result), /ai-mcp-secret/);

    const store = new SupportStore(database);
    const thread = store.createThreadmarkAiThread({}, "Pessoa Proprietária");
    store.addInvestigationThreadMessage(thread.id, {
      body: "Exclua o projeto.",
    });
    const ticketMessage = store.getThreadmarkAiThread(thread.id).messages.find(
      (message) => message.role === "operator",
    );
    assert.ok(ticketMessage);
    const blockedMutation = await executor.execute({
      requestId: "mcp-delete-cross-target",
      toolId: descriptor.id,
      operation: "delete_project",
      argumentsJson: JSON.stringify({
        confirmationMessageId: ticketMessage.id,
        input: { projectId: "project-1" },
      }),
      purpose: "Comprovar que o objeto sem o app de destino não autoriza a mutação.",
    });
    assert.equal(blockedMutation.status, "error");
    assert.equal(mcpToolCalls, 1);

    database.prepare(
      "UPDATE investigation_thread_jobs SET state = 'completed', finished_at = requested_at, result_json = '{}' WHERE thread_id = ? AND state IN ('queued', 'running')",
    ).run(thread.id);
    const archiveThread = store.addThreadmarkAiMessage(thread.id, {
      body: "Arquive o projeto no Projetos MCP.",
    });
    const archiveMessage = archiveThread.messages.filter((message) => message.role === "operator").at(-1);
    assert.ok(archiveMessage);
    const wrongVerbMutation = await executor.execute({
      requestId: "mcp-delete-wrong-verb",
      toolId: descriptor.id,
      operation: "delete_project",
      argumentsJson: JSON.stringify({
        confirmationMessageId: archiveMessage.id,
        input: { projectId: "project-1" },
      }),
      purpose: "Comprovar que arquivar não autoriza excluir.",
    });
    assert.equal(wrongVerbMutation.status, "error");
    assert.equal(mcpToolCalls, 1);

    database.prepare(
      "UPDATE investigation_thread_jobs SET state = 'completed', finished_at = requested_at, result_json = '{}' WHERE thread_id = ? AND state IN ('queued', 'running')",
    ).run(thread.id);
    const deleteThread = store.addThreadmarkAiMessage(thread.id, {
      body: "Exclua o projeto no Projetos MCP.",
    });
    const deleteMessage = deleteThread.messages.filter((message) => message.role === "operator").at(-1);
    assert.ok(deleteMessage);
    const allowedMutation = await executor.execute({
      requestId: "mcp-delete-explicit-target",
      toolId: descriptor.id,
      operation: "delete_project",
      argumentsJson: JSON.stringify({
        confirmationMessageId: deleteMessage.id,
        input: { projectId: "project-1" },
      }),
      purpose: "Excluir o projeto explicitamente solicitado.",
    });
    assert.equal(allowedMutation.status, "success", allowedMutation.summary);
    assert.equal(mcpToolCalls, 2);
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("contexto interno pesquisa tickets, resoluções e conversas sem SQL livre", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "threadmark-context-tool-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const account = store.upsertAccount({
    id: "context-account",
    phoneNumber: "+5548999999000",
    displayName: "Comercial",
  });
  const client = store.upsertClient({
    id: "context-client",
    name: "Loja Contexto",
    slug: "loja-contexto",
    kind: "ecommerce",
  });
  const group = store.upsertGroup({
    id: "context-group",
    accountId: account.id,
    clientId: client.id,
    externalJid: "context@g.us",
    subject: "Atendimento Métricas",
  });
  const participant = store.upsertParticipant({
    id: "context-participant",
    externalJid: "context-user@s.whatsapp.net",
    displayName: "Cliente Contexto",
  });
  store.addGroupParticipant(group.id, participant.id);
  const message = store.upsertMessage({
    id: "context-message",
    externalId: "context-message-external",
    groupId: group.id,
    senderId: participant.id,
    occurredAt: "2026-08-20T12:00:00.000Z",
    text: "Como funciona o ROAS Global no dashboard?",
    messageType: "text",
    triageKind: "demand",
  });
  const ticket = store.createTicket({
    id: "context-ticket",
    groupId: group.id,
    sourceMessageId: message.id,
    title: "Dúvida sobre ROAS Global",
    summary: "Cliente pediu a definição da métrica.",
  });
  database.prepare("UPDATE tickets SET number = 305 WHERE id = ?").run(ticket.id);
  store.upsertAttachment({
    id: "context-image",
    messageId: message.id,
    kind: "image",
    mimeType: "image/jpeg",
    fileName: "metricas.jpg",
    localPath: path.join(temporary, "metricas.jpg"),
    sizeBytes: 100,
    sha256: "context-image-sha",
    available: true,
  });
  store.upsertMessage({
    id: "unrelated-sensitive-message",
    externalId: "unrelated-sensitive-message-external",
    groupId: group.id,
    senderId: participant.id,
    occurredAt: "2026-08-20T13:00:00.000Z",
    text: "Referência 305 em outro assunto. OPENAI_API_KEY=sk-should-never-reach-the-model",
    messageType: "text",
    triageKind: "context",
  });
  store.recordResolution({
    ticketId: ticket.id,
    summary: "Explicamos que a métrica consolida o retorno dos canais configurados.",
    validatedBy: "Operador",
  });
  store.createCategory({ facet: "reason", label: "Dúvida" });
  store.createCategory({ facet: "product", label: "Dashboard" });
  const service = new LocalToolService(
    database,
    new LocalSecretVault(path.join(temporary, "secrets")),
  );
  const executor = new DeepToolExecutor(service, { database });

  try {
    const descriptor = executor.descriptors()[0];
    assert.equal(descriptor?.id, "threadmark-context");
    assert.deepEqual(descriptor?.operations.map((item) => item.name), [
      "search_support_context",
      "search_ticket_groups",
      "list_ticket_categories",
      "prepare_ticket_draft",
      "create_ticket_from_draft",
      "prepare_ticket_update_draft",
      "apply_ticket_update_draft",
    ]);

    const groups = await executor.execute({
      requestId: "threadmark-groups-1",
      toolId: "threadmark-context",
      operation: "search_ticket_groups",
      argumentsJson: JSON.stringify({ query: "Cliente Metricas Ecommerce", limit: 10 }),
      purpose: "Localizar o grupo apesar das diferenças de pontuação.",
    });
    assert.equal(groups.status, "success");
    const groupResults = JSON.parse(groups.content) as { groups: Array<{ id: string }> };
    assert.equal(groupResults.groups[0]?.id, group.id);

    const categories = await executor.execute({
      requestId: "threadmark-categories-fuzzy-1",
      toolId: "threadmark-context",
      operation: "list_ticket_categories",
      argumentsJson: JSON.stringify({
        query: "duvida dashboard roas",
        facets: ["contactReason", "productArea"],
        limit: 10,
      }),
      purpose: "Localizar categorias por termos independentes.",
    });
    assert.equal(categories.status, "success");
    assert.match(categories.content, /Dashboard/i);

    const result = await executor.execute({
      requestId: "threadmark-search-1",
      toolId: "threadmark-context",
      operation: "search_support_context",
      argumentsJson: JSON.stringify({ query: "ROAS Global", scope: "all", limit: 10 }),
      purpose: "Localizar o histórico já resolvido.",
    });
    assert.equal(result.status, "success");
    assert.match(result.content, /Dúvida sobre ROAS Global/);
    assert.match(result.content, /consolida o retorno/);
    assert.match(result.content, /Como funciona o ROAS Global/);
    assert.match(result.reference ?? "", /threadmark-search-1$/);

    const exactTicket = await executor.execute({
      requestId: "threadmark-ticket-305",
      toolId: "threadmark-context",
      operation: "search_support_context",
      argumentsJson: JSON.stringify({ query: "305", scope: "all", limit: 10 }),
      purpose: "Carregar apenas o ticket e suas mensagens de origem.",
    });
    assert.equal(exactTicket.status, "success");
    const exactContext = JSON.parse(exactTicket.content) as {
      tickets: Array<{ number: number }>;
      messages: Array<{
        id: string;
        attachments: Array<{ id: string; kind: string }>;
      }>;
    };
    assert.deepEqual(exactContext.tickets.map((item) => item.number), [305]);
    assert.deepEqual(exactContext.messages.map((item) => item.id), [message.id]);
    assert.equal(exactContext.messages[0]?.attachments[0]?.id, "context-image");
    assert.equal(exactContext.messages[0]?.attachments[0]?.kind, "image");
    assert.doesNotMatch(exactTicket.content, /should-never-reach-the-model/);

    const redactedSearch = await executor.execute({
      requestId: "threadmark-sensitive-search",
      toolId: "threadmark-context",
      operation: "search_support_context",
      argumentsJson: JSON.stringify({ query: "Referência", scope: "conversations", limit: 10 }),
      purpose: "Garantir que resultados locais não exponham credenciais ao modelo.",
    });
    assert.equal(redactedSearch.status, "success");
    assert.match(redactedSearch.content, /OPENAI_API_KEY=\[REDACTED\]/);
    assert.doesNotMatch(redactedSearch.content, /should-never-reach-the-model/);

    const aliasResult = await executor.execute({
      requestId: "threadmark-search-alias-1",
      toolId: "threadmark-context",
      operation: "search_support_context",
      argumentsJson: JSON.stringify({ query: "ROAS Global", scope: "messages", limit: 10 }),
      purpose: "Aceitar o alias natural de busca por mensagens.",
    });
    assert.equal(aliasResult.status, "success");
    assert.match(aliasResult.content, /Como funciona o ROAS Global/);

    const categoryAliasResult = await executor.execute({
      requestId: "threadmark-category-alias-1",
      toolId: "threadmark-context",
      operation: "list_ticket_categories",
      argumentsJson: JSON.stringify({
        query: "duvida dashboard",
        facets: ["contact_reason", "product_area"],
        limit: 10,
      }),
      purpose: "Aceitar aliases snake_case das facetas.",
    });
    assert.equal(categoryAliasResult.status, "success");
    assert.match(categoryAliasResult.content, /Dashboard/i);

    const unsupported = await executor.execute({
      requestId: "threadmark-search-2",
      toolId: "threadmark-context",
      operation: "query_readonly",
      argumentsJson: JSON.stringify({ query: "DELETE FROM tickets" }),
      purpose: "Operação não permitida.",
    });
    assert.equal(unsupported.status, "error");
    assert.match(unsupported.summary, /não autorizada/i);
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Intercom autorizado permite somente leituras nativas limitadas sem expor o token", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "threadmark-intercom-read-"));
  const database = createDatabase(":memory:");
  const vault = new LocalSecretVault(path.join(temporary, "secrets"));
  const localTools = new LocalToolService(database, vault);
  const connectedApps = new ConnectedAppService(database, vault);
  const app = await connectedApps.create({
    type: "intercom",
    name: "Intercom",
    enabled: true,
    aiEnabled: true,
    endpoint: "https://api.intercom.io/",
    secret: "intercom-read-token",
  }, "Teste");
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  const executor = new DeepToolExecutor(localTools, {
    connectedApps,
    integrationVault: vault,
    fetchImpl: (async (input, init) => {
      const url = new URL(String(input));
      requests.push({ url, init: init ?? {} });
      if (url.pathname === "/conversations/search") {
        return new Response(JSON.stringify({
          total_count: 1,
          conversations: [{
            id: "987",
            title: "Ajuda com campanhas",
            state: "open",
            priority: "high",
            created_at: 1_776_662_400,
            updated_at: 1_776_666_000,
            source: {
              subject: "Campanhas",
              body: "<p>Não consigo criar uma campanha.</p>",
              author: { id: "contact-1", name: "Pessoa Cliente", email: "cliente@example.test" },
            },
          }],
        }), { status: 200 });
      }
      if (url.pathname === "/me") {
        return Response.json({
          type: "admin",
          id: "admin-42",
          name: "Autor Teste",
          email: "autor@example.test",
        });
      }
      if (url.pathname === "/help_center/collections") {
        return Response.json({
          type: "list",
          total_count: 1,
          data: [{ id: "collection-12", name: "Métricas", description: "Ajuda de métricas" }],
        });
      }
      return new Response(JSON.stringify({
        id: "987",
        state: "open",
        source: {
          id: "source-1",
          body: "Mensagem inicial",
          author: { id: "contact-1", type: "user", name: "Pessoa Cliente" },
        },
        conversation_parts: {
          conversation_parts: [{
            id: "part-1",
            part_type: "comment",
            created_at: 1_776_666_000,
            body: "<p>Preciso liberar o acesso.</p>",
            author: { id: "contact-1", type: "user", name: "Pessoa Cliente" },
          }],
        },
      }), { status: 200 });
    }) as typeof globalThis.fetch,
  });

  try {
    const toolId = `connected-app:${app.id}`;
    const search = await executor.execute({
      requestId: "intercom-search-1",
      toolId,
      operation: "search_conversations",
      argumentsJson: JSON.stringify({
        query: "Pessoa Cliente",
        contentQuery: "liberar acesso",
        limit: 5,
      }),
      purpose: "Localizar a conversa recente do cliente.",
    });
    assert.equal(search.status, "success");
    assert.match(search.content, /Pessoa Cliente/);
    assert.match(search.content, /Não consigo criar uma campanha/);
    assert.match(search.content, /contentMatches/);
    assert.match(search.content, /Preciso liberar o acesso/);

    const conversation = await executor.execute({
      requestId: "intercom-get-1",
      toolId,
      operation: "get_conversation",
      argumentsJson: JSON.stringify({ conversationId: "987" }),
      purpose: "Ler o contexto integral da conversa escolhida.",
    });
    assert.equal(conversation.status, "success");
    assert.match(conversation.content, /Preciso liberar o acesso/);
    const admins = await executor.execute({
      requestId: "intercom-admins-1",
      toolId,
      operation: "get_current_admin",
      argumentsJson: "{}",
      purpose: "Descobrir um authorId válido.",
    });
    assert.equal(admins.status, "success");
    assert.match(admins.content, /admin-42/);
    const collections = await executor.execute({
      requestId: "intercom-collections-1",
      toolId,
      operation: "list_collections",
      argumentsJson: JSON.stringify({ limit: 50 }),
      purpose: "Escolher a coleção de destino.",
    });
    assert.equal(collections.status, "success");
    assert.match(collections.content, /collection-12/);
    assert.equal(requests[0]?.url.pathname, "/conversations/search");
    assert.equal(requests[0]?.init.method, "POST");
    const searchBody = JSON.parse(String(requests[0]?.init.body)) as {
      query: { value: Array<{ field: string; operator: string; value: string }> };
    };
    assert.deepEqual(searchBody.query.value, [
      { field: "source.author.name", operator: "~", value: "Pessoa Cliente" },
      { field: "source.subject", operator: "~", value: "Pessoa Cliente" },
      { field: "source.body", operator: "~", value: "Pessoa Cliente" },
    ]);
    assert.equal(requests[1]?.url.pathname, "/conversations/987");
    assert.equal(requests[1]?.url.searchParams.get("display_as"), "plaintext");
    assert.equal(requests[2]?.url.pathname, "/conversations/987");
    assert.equal(requests[2]?.url.searchParams.get("display_as"), "plaintext");
    assert.equal(requests[3]?.url.pathname, "/me");
    assert.equal(requests[4]?.url.pathname, "/help_center/collections");
    assert.equal(new Headers(requests[0]?.init.headers).get("authorization"), "Bearer intercom-read-token");
    assert.doesNotMatch(JSON.stringify(search), /intercom-read-token/);
    assert.doesNotMatch(JSON.stringify(conversation), /intercom-read-token/);
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Threadmark AI prepara prévia e cria ticket idempotente somente após confirmação posterior", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "threadmark-ai-ticket-draft-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const account = store.upsertAccount({
    id: "ai-ticket-account",
    phoneNumber: "+5548999999111",
    displayName: "Comercial",
  });
  const client = store.upsertClient({
    id: "ai-ticket-client",
    name: "Cliente Intercom",
    slug: "cliente-intercom",
    kind: "ecommerce",
  });
  const group = store.upsertGroup({
    id: "ai-ticket-group",
    accountId: account.id,
    clientId: client.id,
    externalJid: "ai-ticket@g.us",
    subject: "Cliente Intercom & Suporte",
  });
  const participant = store.upsertParticipant({
    id: "ai-ticket-participant",
    externalJid: "5548999999333@s.whatsapp.net",
    phoneE164: "+5548999999333",
    displayName: "Pessoa Cliente",
  });
  store.addGroupParticipant(group.id, participant.id);
  const sourceMessage = store.upsertMessage({
    id: "ai-ticket-source-message",
    externalId: "ai-ticket-source-message-external",
    groupId: group.id,
    senderId: participant.id,
    occurredAt: "2026-08-20T12:00:00.000Z",
    text: "Não consigo criar campanhas e preciso que liberem meu acesso.",
    messageType: "text",
    triageKind: "demand",
  });
  const productCategory = store.createCategory({
    facet: "product",
    label: "CRM",
    color: "#6554e8",
  });
  const symptomCategory = store.createCategory({
    facet: "symptom",
    label: "Acesso indisponível",
    color: "#ef4444",
  });
  const secondarySymptomCategory = store.createCategory({
    facet: "symptom",
    label: "Falha de integração",
    color: "#f97316",
  });
  const thread = store.createThreadmarkAiThread({}, "Pessoa Proprietária");
  const withRequest = store.addInvestigationThreadMessage(thread.id, {
    body: "Transforme a conversa 987 do Intercom em um ticket do Threadmark.",
  });
  const requestMessage = withRequest.messages.find((message) => message.role === "operator");
  assert.ok(requestMessage);
  const executor = new DeepToolExecutor(
    new LocalToolService(database, new LocalSecretVault(path.join(temporary, "secrets"))),
    { database, supportStore: store },
  );

  try {
    const inventedCategory = await executor.execute({
      requestId: "prepare-ticket-invalid-category",
      toolId: "threadmark-context",
      operation: "prepare_ticket_draft",
      argumentsJson: JSON.stringify({
        operatorMessageId: requestMessage.id,
        groupId: group.id,
        title: "Acesso para criar campanhas",
        summary: "Tentativa com categoria inventada.",
        priority: "high",
        categoryIds: ["categoria-inventada"],
        messageIds: [sourceMessage.id],
      }),
      purpose: "Garantir que apenas o catálogo real seja aceito.",
    });
    assert.equal(inventedCategory.status, "error");
    assert.match(inventedCategory.summary, /Categoria\(s\) inexistente/i);

    const draft = await executor.execute({
      requestId: "prepare-ticket-1",
      toolId: "threadmark-context",
      operation: "prepare_ticket_draft",
      argumentsJson: JSON.stringify({
        operatorMessageId: requestMessage.id,
        groupId: group.id,
        title: "Acesso para criar campanhas",
        summary: "A pessoa cliente informou no Intercom que não consegue criar campanhas e pediu liberação de acesso.",
        priority: "high",
        categoryIds: [productCategory.id, symptomCategory.id, secondarySymptomCategory.id],
        messageIds: [sourceMessage.id],
        sourceMessages: [{
          id: "intercom-part-987-1",
          author: "Pessoa Cliente",
          authorRole: "customer",
          body: "No Intercom também confirmei que preciso da liberação para criar campanhas.",
          occurredAt: "2026-08-20T12:05:00.000Z",
        }],
        externalSource: { type: "intercom_conversation", id: "987" },
      }),
      purpose: "Preparar a prévia solicitada sem criar o ticket.",
    });
    assert.equal(draft.status, "success");
    assert.match(draft.summary, /nenhum ticket foi criado/i);
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM tickets").get() as { total: number }).total, 0);
    const draftId = (JSON.parse(draft.content) as { draftId: string }).draftId;

    database.prepare(
      `UPDATE investigation_thread_jobs
       SET state = 'completed', finished_at = requested_at, result_json = '{}'
       WHERE thread_id = ?`,
    ).run(thread.id);
    const withConfirmation = store.addInvestigationThreadMessage(thread.id, {
      body: "Pode criar esse ticket exatamente como está na prévia.",
    });
    const confirmation = withConfirmation.messages
      .filter((message) => message.role === "operator")
      .at(-1);
    assert.ok(confirmation);

    const created = await executor.execute({
      requestId: "create-ticket-1",
      toolId: "threadmark-context",
      operation: "create_ticket_from_draft",
      argumentsJson: JSON.stringify({
        confirmationMessageId: confirmation.id,
        draftId,
      }),
      purpose: "Criar o ticket confirmado pelo operador.",
    });
    assert.equal(created.status, "success");
    assert.match(created.summary, /Ticket #1 criado/);
    const ticket = store.getTicketDetail("threadmark-ai-ticket:" + draftId);
    assert.equal(ticket.title, "Acesso para criar campanhas");
    assert.equal(ticket.priority, "high");
    assert.equal(ticket.group.id, group.id);
    assert.equal(ticket.messageCount, 2);
    assert.deepEqual(
      ticket.timeline
        .filter((item) => item.type === "message")
        .map((message) => message.text),
      [
        "Não consigo criar campanhas e preciso que liberem meu acesso.",
        "No Intercom também confirmei que preciso da liberação para criar campanhas.",
      ],
    );
    assert.deepEqual(
      ticket.categories.map((category) => category.label).sort(),
      ["Acesso indisponível", "CRM"],
    );
    const persistedDraft = database.prepare(
      `SELECT state, external_source_type, external_source_id, created_ticket_id,
              category_ids_json, message_ids_json, source_messages_json
       FROM threadmark_ai_ticket_drafts WHERE id = ?`,
    ).get(draftId) as {
      state: string;
      external_source_type: string;
      external_source_id: string;
      created_ticket_id: string;
      category_ids_json: string;
      message_ids_json: string;
      source_messages_json: string;
    };
    assert.deepEqual(persistedDraft, {
      state: "created",
      external_source_type: "intercom_conversation",
      external_source_id: "987",
      created_ticket_id: ticket.id,
      category_ids_json: JSON.stringify([productCategory.id, symptomCategory.id].sort()),
      message_ids_json: JSON.stringify([sourceMessage.id]),
      source_messages_json: JSON.stringify([{
        id: "intercom-part-987-1",
        author: "Pessoa Cliente",
        authorRole: "customer",
        body: "No Intercom também confirmei que preciso da liberação para criar campanhas.",
        occurredAt: "2026-08-20T12:05:00.000Z",
      }]),
    });

    const replay = await executor.execute({
      requestId: "create-ticket-2",
      toolId: "threadmark-context",
      operation: "create_ticket_from_draft",
      argumentsJson: JSON.stringify({
        confirmationMessageId: confirmation.id,
        draftId,
      }),
      purpose: "Repetição idempotente da mesma confirmação.",
    });
    assert.equal(replay.status, "success");
    assert.match(replay.summary, /já havia sido criado/i);
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM tickets").get() as { total: number }).total, 1);
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("ordem explícita cria ticket interno na mesma execução sem confirmação duplicada", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "threadmark-ai-internal-ticket-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const account = store.upsertAccount({
    id: "ai-internal-account",
    phoneNumber: "+5548999999000",
    displayName: "Comercial",
  });
  const client = store.upsertClient({
    id: "ai-internal-client",
    name: "Cliente interno de teste",
    slug: "cliente-interno-teste",
    kind: "ecommerce",
  });
  const group = store.upsertGroup({
    id: "ai-internal-group",
    accountId: account.id,
    clientId: client.id,
    externalJid: "ai-internal@g.us",
    subject: "Cliente interno & Suporte",
  });
  const staff = store.upsertParticipant({
    id: "ai-internal-staff",
    externalJid: "5548999999222@s.whatsapp.net",
    phoneE164: "+5548999999222",
    displayName: "Pessoa da equipe",
  });
  store.setStaffMember(staff.id, "Pessoa da equipe");
  store.addGroupParticipant(group.id, staff.id);
  const sourceMessage = store.upsertMessage({
    id: "ai-internal-source-message",
    externalId: "ai-internal-source-message-external",
    groupId: group.id,
    senderId: staff.id,
    occurredAt: "2026-08-26T12:00:00.000Z",
    text: "Migração confirmada para a nova operação.",
    messageType: "text",
  });
  const thread = store.createThreadmarkAiThread({}, "Pessoa Proprietária");
  const request = store.addInvestigationThreadMessage(thread.id, {
    body: "Crie um ticket a partir da mensagem interna que confirma a migração.",
  }).messages.filter((message) => message.role === "operator").at(-1);
  assert.ok(request);
  const executor = new DeepToolExecutor(
    new LocalToolService(database, new LocalSecretVault(path.join(temporary, "secrets"))),
    { database, supportStore: store },
  );

  try {
    const prepared = await executor.execute({
      requestId: "prepare-internal-ticket",
      toolId: "threadmark-context",
      operation: "prepare_ticket_draft",
      argumentsJson: JSON.stringify({
        operatorMessageId: request.id,
        groupId: group.id,
        title: "Migração da operação",
        summary: "A equipe confirmou a migração para a nova operação.",
        priority: "normal",
        messageIds: [sourceMessage.id],
      }),
      purpose: "Preparar uma demanda operacional interna solicitada pelo operador.",
    });
    assert.equal(prepared.status, "success");
    const preview = JSON.parse(prepared.content) as {
      draftId: string;
      sourceMessageCount: number;
      sourceKind: string;
    };
    assert.equal(preview.sourceMessageCount, 1);
    assert.equal(preview.sourceKind, "internal_manual");

    const created = await executor.execute({
      requestId: "create-internal-ticket",
      toolId: "threadmark-context",
      operation: "create_ticket_from_draft",
      argumentsJson: JSON.stringify({
        confirmationMessageId: request.id,
        draftId: preview.draftId,
      }),
      purpose: "Executar a ordem explícita de criação sem pedir confirmação duplicada.",
    });
    assert.equal(created.status, "success");
    const ticket = database.prepare(
      `SELECT source_message_id FROM tickets WHERE id = ?`,
    ).get(`threadmark-ai-ticket:${preview.draftId}`) as { source_message_id: string | null };
    assert.equal(ticket.source_message_id, null);
    assert.equal(store.getTicketDetail(`threadmark-ai-ticket:${preview.draftId}`).messageCount, 1);
    const triage = database.prepare(
      `SELECT triage_kind, triage_state FROM messages WHERE id = ?`,
    ).get(sourceMessage.id) as { triage_kind: string; triage_state: string };
    assert.deepEqual(triage, { triage_kind: "context", triage_state: "context" });

    const retry = { id: "retry-explicit-ticket-creation" };
    database.prepare(
      `INSERT INTO investigation_thread_messages (
         id, thread_id, role, body, created_at
       ) VALUES (?, ?, 'operator', 'Tenta novamente', ?)`,
    ).run(retry.id, thread.id, new Date(Date.now() + 1_000).toISOString());
    const retrySourceMessage = store.upsertMessage({
      id: "ai-internal-retry-source-message",
      externalId: "ai-internal-retry-source-message-external",
      groupId: group.id,
      senderId: staff.id,
      occurredAt: "2026-08-26T12:01:00.000Z",
      text: "A migração deve ser revalidada.",
      messageType: "text",
    });
    const retriedDraft = await executor.execute({
      requestId: "prepare-retried-ticket",
      toolId: "threadmark-context",
      operation: "prepare_ticket_draft",
      argumentsJson: JSON.stringify({
        operatorMessageId: retry.id,
        groupId: group.id,
        title: "Migração da operação revalidada",
        summary: "A tarefa explícita anterior deve continuar autorizada ao tentar novamente.",
        priority: "normal",
        messageIds: [retrySourceMessage.id],
      }),
      purpose: "Repetir a criação solicitada anteriormente.",
    });
    const retriedPreview = JSON.parse(retriedDraft.content) as { draftId: string };
    const retriedCreation = await executor.execute({
      requestId: "create-retried-ticket",
      toolId: "threadmark-context",
      operation: "create_ticket_from_draft",
      argumentsJson: JSON.stringify({
        confirmationMessageId: retry.id,
        draftId: retriedPreview.draftId,
      }),
      purpose: "Concluir a repetição da ordem explícita anterior.",
    });
    assert.equal(retriedCreation.status, "success");
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Threadmark AI atualiza metadados e categorias somente após confirmação posterior", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "threadmark-ai-ticket-update-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const account = store.upsertAccount({
    id: "ai-update-account",
    phoneNumber: "+5548999999222",
    displayName: "Comercial",
  });
  const client = store.upsertClient({
    id: "ai-update-client",
    name: "Cliente Atualização",
    slug: "cliente-atualizacao",
    kind: "ecommerce",
  });
  const group = store.upsertGroup({
    id: "ai-update-group",
    accountId: account.id,
    clientId: client.id,
    externalJid: "ai-update@g.us",
    subject: "Cliente Atualização & Suporte",
  });
  const originalCategory = store.createCategory({ facet: "reason", label: "Dúvida" });
  const productCategory = store.createCategory({ facet: "product", label: "Dashboard" });
  const symptomCategory = store.createCategory({ facet: "symptom", label: "Dados incorretos" });
  const ticket = store.createManualTicket({
    clientRequestId: "ai-update-ticket",
    groupId: group.id,
    title: "Dúvida genérica",
    summary: "Cliente relatou uma dúvida.",
    priority: "normal",
    actor: "Pessoa Proprietária",
  });
  store.attachCategoryToTicket(ticket.id, originalCategory.id, "Pessoa Proprietária");
  const thread = store.createThreadmarkAiThread({}, "Pessoa Proprietária");
  const request = store.addInvestigationThreadMessage(thread.id, {
    body: `Atualize o ticket #${ticket.number}: o problema real são dados incorretos no Dashboard.`,
  }).messages.filter((message) => message.role === "operator").at(-1);
  assert.ok(request);
  const executor = new DeepToolExecutor(
    new LocalToolService(database, new LocalSecretVault(path.join(temporary, "secrets"))),
    { database, supportStore: store },
  );

  try {
    const catalog = await executor.execute({
      requestId: "list-categories-1",
      toolId: "threadmark-context",
      operation: "list_ticket_categories",
      argumentsJson: JSON.stringify({ query: "Dashboard", limit: 20 }),
      purpose: "Usar somente categorias existentes no catálogo.",
    });
    assert.equal(catalog.status, "success");
    assert.match(catalog.content, /Dashboard/);

    const prepared = await executor.execute({
      requestId: "prepare-update-1",
      toolId: "threadmark-context",
      operation: "prepare_ticket_update_draft",
      argumentsJson: JSON.stringify({
        operatorMessageId: request.id,
        ticketId: ticket.id,
        title: "Dados incorretos no Dashboard",
        summary: "O cliente identificou divergência nos dados exibidos no Dashboard.",
        priority: "high",
        addCategoryIds: [productCategory.id, symptomCategory.id],
        removeCategoryIds: [originalCategory.id],
      }),
      purpose: "Preparar a atualização para confirmação.",
    });
    assert.equal(prepared.status, "success");
    assert.match(prepared.summary, /nenhuma alteração foi aplicada/i);
    const draftId = (JSON.parse(prepared.content) as { draftId: string }).draftId;
    const beforeConfirmation = store.getTicketDetail(ticket.id);
    assert.equal(beforeConfirmation.title, "Dúvida genérica");
    assert.deepEqual(beforeConfirmation.categories.map((category) => category.label), ["Dúvida"]);

    database.prepare(
      `UPDATE investigation_thread_jobs
       SET state = 'completed', finished_at = requested_at, result_json = '{}'
       WHERE thread_id = ?`,
    ).run(thread.id);
    const confirmation = store.addInvestigationThreadMessage(thread.id, {
      body: "Confirmo, pode atualizar o ticket conforme a prévia.",
    }).messages.filter((message) => message.role === "operator").at(-1);
    assert.ok(confirmation);

    const applied = await executor.execute({
      requestId: "apply-update-1",
      toolId: "threadmark-context",
      operation: "apply_ticket_update_draft",
      argumentsJson: JSON.stringify({
        confirmationMessageId: confirmation.id,
        draftId,
      }),
      purpose: "Aplicar a atualização confirmada.",
    });
    assert.equal(applied.status, "success");
    assert.match(applied.summary, new RegExp(`Ticket #${ticket.number} atualizado`));
    const updated = store.getTicketDetail(ticket.id);
    assert.equal(updated.title, "Dados incorretos no Dashboard");
    assert.equal(updated.summary, "O cliente identificou divergência nos dados exibidos no Dashboard.");
    assert.equal(updated.priority, "high");
    assert.deepEqual(
      updated.categories.map((category) => category.label).sort(),
      ["Dados incorretos", "Dashboard"],
    );

    const replay = await executor.execute({
      requestId: "apply-update-2",
      toolId: "threadmark-context",
      operation: "apply_ticket_update_draft",
      argumentsJson: JSON.stringify({ confirmationMessageId: confirmation.id, draftId }),
      purpose: "Repetição idempotente da atualização.",
    });
    assert.equal(replay.status, "success");
    assert.match(replay.summary, /já havia sido atualizado/i);
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("ordem explícita anexa mensagens locais e externas sem confirmação duplicada", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "threadmark-ai-ticket-attach-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const account = store.upsertAccount({
    id: "ai-attach-account",
    phoneNumber: "+5548999999333",
    displayName: "Comercial",
  });
  const client = store.upsertClient({
    id: "ai-attach-client",
    name: "Cliente Anexo",
    slug: "cliente-anexo",
    kind: "ecommerce",
  });
  const group = store.upsertGroup({
    id: "ai-attach-group",
    accountId: account.id,
    clientId: client.id,
    externalJid: "ai-attach@g.us",
    subject: "Cliente Anexo & Suporte",
  });
  const participant = store.upsertParticipant({
    id: "ai-attach-participant",
    externalJid: "ai-attach-user@s.whatsapp.net",
    displayName: "Pessoa Cliente",
  });
  store.addGroupParticipant(group.id, participant.id);
  const localMessage = store.upsertMessage({
    id: "ai-attach-message",
    externalId: "ai-attach-message-external",
    groupId: group.id,
    senderId: participant.id,
    occurredAt: "2026-08-25T12:00:00.000Z",
    text: "O Google Ads continua desconectado e o GA4 também caiu.",
    messageType: "text",
    triageKind: "demand",
  });
  const ticket = store.createManualTicket({
    clientRequestId: "ai-attach-ticket",
    groupId: group.id,
    title: "Desconexão do Google Ads",
    summary: "Cliente relatou desconexão da conta de anúncios.",
    priority: "high",
    actor: "Pessoa Proprietária",
  });
  const thread = store.createThreadmarkAiThread({}, "Pessoa Proprietária");
  const request = store.addInvestigationThreadMessage(thread.id, {
    body: `Anexe ao ticket #${ticket.number} a mensagem local e as duas mensagens da conversa 240 do Intercom.`,
  }).messages.filter((message) => message.role === "operator").at(-1);
  assert.ok(request);
  const vault = new LocalSecretVault(path.join(temporary, "secrets"));
  const connectedApps = new ConnectedAppService(database, vault);
  await connectedApps.create({
    type: "intercom",
    name: "Intercom",
    description: "Conversa externa de teste.",
    enabled: true,
    aiEnabled: true,
    endpoint: "https://api.intercom.io/",
    secret: "intercom-attach-test-token",
  }, "Teste");
  const executor = new DeepToolExecutor(
    new LocalToolService(database, vault),
    {
      database,
      supportStore: store,
      connectedApps,
      integrationVault: vault,
      fetchImpl: async () => new Response(JSON.stringify({
        id: "240",
        created_at: 1_777_118_700,
        updated_at: 1_777_118_760,
        source: {
          id: "intercom-part-240-4",
          created_at: 1_777_118_700,
          author: { id: "customer-1", type: "user", name: "Pessoa Cliente" },
          body: "O GA4 também aparece desconectado.",
        },
        conversation_parts: {
          conversation_parts: [{
            id: "intercom-part-240-5",
            created_at: 1_777_118_760,
            part_type: "comment",
            author: { id: "support-1", type: "admin", name: "Pessoa Suporte" },
            body: "Vou reunir as evidências no mesmo atendimento.",
          }],
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    },
  );

  try {
    const archivedTicket = store.createManualTicket({
      clientRequestId: "ai-attach-archived-ticket",
      groupId: group.id,
      title: "Atendimento já arquivado",
      summary: "Ticket usado para validar o limite de segurança.",
      actor: "Pessoa Proprietária",
    });
    store.updateTicketStatus(archivedTicket.id, { status: "in_progress" });
    store.updateTicketStatus(archivedTicket.id, {
      status: "resolved",
      resolution: {
        summary: "Demanda concluída.",
        outcome: "Contexto preservado para o teste.",
      },
    });
    store.updateTicketStatus(archivedTicket.id, { status: "archived" });
    const archivedAttempt = await executor.execute({
      requestId: "prepare-attach-archived",
      toolId: "threadmark-context",
      operation: "prepare_ticket_update_draft",
      argumentsJson: JSON.stringify({
        operatorMessageId: request.id,
        ticketId: archivedTicket.id,
        messageIds: [localMessage.id],
      }),
      purpose: "Validar que ticket arquivado continua imutável.",
    });
    assert.equal(archivedAttempt.status, "error");
    assert.match(archivedAttempt.summary, /ticket arquivado/i);

    const prepared = await executor.execute({
      requestId: "prepare-attach-1",
      toolId: "threadmark-context",
      operation: "prepare_ticket_update_draft",
      argumentsJson: JSON.stringify({
        operatorMessageId: request.id,
        ticketId: ticket.id,
        messageIds: [localMessage.id],
        sourceMessages: [],
        externalSource: { type: "intercom_conversation", id: "240" },
      }),
      purpose: "Preparar o anexo das mensagens sem alterar o ticket.",
    });
    assert.equal(prepared.status, "success");
    assert.match(prepared.summary, /nenhuma alteração foi aplicada/i);
    const preview = JSON.parse(prepared.content) as {
      draftId: string;
      changes: { messages: { local: number; external: number; total: number } };
    };
    assert.deepEqual(preview.changes.messages, { local: 1, external: 2, total: 3 });
    assert.equal(store.getTicketDetail(ticket.id).messageCount, 0);

    const applied = await executor.execute({
      requestId: "apply-attach-explicit-request",
      toolId: "threadmark-context",
      operation: "apply_ticket_update_draft",
      argumentsJson: JSON.stringify({
        confirmationMessageId: request.id,
        draftId: preview.draftId,
      }),
      purpose: "Executar o anexo explicitamente solicitado pelo operador.",
    });
    assert.equal(applied.status, "success");
    const updated = store.getTicketDetail(ticket.id);
    assert.equal(updated.messageCount, 3);
    assert.deepEqual(
      updated.timeline
        .filter((item) => item.type === "message")
        .map((message) => message.text)
        .sort(),
      [
        "O Google Ads continua desconectado e o GA4 também caiu.",
        "O GA4 também aparece desconectado.",
        "Vou reunir as evidências no mesmo atendimento.",
      ].sort(),
    );

    const replay = await executor.execute({
      requestId: "apply-attach-2",
      toolId: "threadmark-context",
      operation: "apply_ticket_update_draft",
      argumentsJson: JSON.stringify({
        confirmationMessageId: request.id,
        draftId: preview.draftId,
      }),
      purpose: "Repetir a confirmação sem duplicar mensagens.",
    });
    assert.equal(replay.status, "success");
    assert.match(replay.summary, /já havia sido atualizado/i);
    assert.equal(store.getTicketDetail(ticket.id).messageCount, 3);
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("executor profundo lê somente dentro da raiz explicitamente autorizada", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "threadmark-deep-tool-"));
  const root = path.join(temporary, "code");
  const outside = path.join(temporary, "outside.txt");
  await mkdir(path.join(root, "server"), { recursive: true });
  await mkdir(path.join(root, ".data"), { recursive: true });
  await mkdir(path.join(root, "auth"), { recursive: true });
  await writeFile(path.join(root, "server", "metric.ts"), "export const total = recurring + newCustomers;\n");
  await writeFile(path.join(root, ".env"), "TOKEN=never-expose\n");
  await writeFile(path.join(root, ".env.example"), "TOKEN=example\n");
  await writeFile(path.join(root, ".data", "session.json"), "secret session\n");
  await writeFile(path.join(root, "auth", "credentials.json"), "secret credentials\n");
  await writeFile(outside, "segredo fora da raiz\n");
  await mkdir(path.join(root, "server", "generated"), { recursive: true });
  await Promise.all(Array.from({ length: 160 }, (_, index) =>
    writeFile(
      path.join(root, "server", "generated", `long-module-${index}.ts`),
      Array.from({ length: 20 }, (__, line) =>
        `export const searchable_${index}_${line} = "distinctive-search-term";`,
      ).join("\n"),
    )
  ));
  const database = createDatabase(":memory:");
  const service = new LocalToolService(
    database,
    new LocalSecretVault(path.join(temporary, "secrets")),
  );
  const tool = await service.create({
    type: "codebase",
    name: "Código do produto",
    description: "Regras de negócio",
    config: { rootPath: root },
    allowedOperations: ["list_files", "search_files", "read_files"],
  }, "test");
  const executor = new DeepToolExecutor(service);

  try {
    const descriptor = executor.descriptors()[0];
    assert.equal(descriptor?.id, "local-tool:codebase:codigo-do-produto");
    assert.doesNotMatch(descriptor?.id ?? "", /[0-9a-f]{8}-[0-9a-f-]{27}/i);
    assert.deepEqual(descriptor?.operations.map((item) => item.name), [
      "list_files",
      "search_files",
      "read_files",
    ]);

    const read = await executor.execute({
      requestId: "read-1",
      toolId: tool.id,
      operation: "read_files",
      argumentsJson: JSON.stringify({ paths: ["server/metric.ts"], maxLines: 20 }),
      purpose: "Confirmar a fórmula.",
    });
    assert.equal(read.status, "success");
    assert.match(read.content, /recurring \+ newCustomers/);
    assert.match(read.content, /1: export const total/);

    const traversal = await executor.execute({
      requestId: "read-2",
      toolId: tool.id,
      operation: "read_files",
      argumentsJson: JSON.stringify({ paths: ["../outside.txt"] }),
      purpose: "Tentar sair da raiz.",
    });
    assert.equal(traversal.status, "error");
    assert.doesNotMatch(traversal.content, /segredo fora da raiz/);
    assert.match(traversal.summary, /raiz autorizada/i);

    const sensitive = await executor.execute({
      requestId: "read-sensitive",
      toolId: tool.id,
      operation: "read_files",
      argumentsJson: JSON.stringify({ paths: [".env"] }),
      purpose: "Tentar ler segredo.",
    });
    assert.equal(sensitive.status, "error");
    assert.doesNotMatch(sensitive.content, /never-expose/);
    assert.match(sensitive.summary, /sensíveis/i);

    const example = await executor.execute({
      requestId: "read-example",
      toolId: tool.id,
      operation: "read_files",
      argumentsJson: JSON.stringify({ paths: [".env.example"] }),
      purpose: "Ler template público.",
    });
    assert.equal(example.status, "success");
    assert.match(example.content, /TOKEN=example/);

    const listing = await executor.execute({
      requestId: "list-sensitive",
      toolId: tool.id,
      operation: "list_files",
      argumentsJson: JSON.stringify({ path: ".", maxDepth: 3, maxFiles: 300 }),
      purpose: "Listar arquivos permitidos.",
    });
    assert.equal(listing.status, "success");
    assert.match(listing.content, /^\.env\.example$/m);
    assert.doesNotMatch(listing.content, /^\.env$/m);
    assert.doesNotMatch(listing.content, /^\.data\//m);
    assert.doesNotMatch(listing.content, /^auth\//m);

    const boundedSearch = await executor.execute({
      requestId: "search-bounded-output",
      toolId: tool.id,
      operation: "search_files",
      argumentsJson: JSON.stringify({
        query: "distinctive-search-term",
        path: "server",
        glob: "*.ts",
        maxResults: 5,
      }),
      purpose: "Encontrar os primeiros arquivos sem acumular toda a saída do repositório.",
    });
    assert.equal(boundedSearch.status, "success");
    assert.equal(boundedSearch.content.split("\n").length, 5);
    assert.match(boundedSearch.summary, /5 ocorrência/);

    const recoveredSearch = await executor.execute({
      requestId: "search-missing-path-fallback",
      toolId: tool.id,
      operation: "search_files",
      argumentsJson: JSON.stringify({
        query: "recurring",
        path: "caminho-inexistente",
        glob: "*.ts",
        maxResults: 10,
      }),
      purpose: "Recuperar uma suposição incorreta sobre a estrutura do repositório.",
    });
    assert.equal(recoveredSearch.status, "success");
    assert.match(recoveredSearch.summary, /busca foi recuperada na raiz autorizada/i);
    assert.match(recoveredSearch.content, /server\/metric\.ts/);
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("PostgreSQL usa o driver interno, rejeita mutações e aplica limites readonly", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "threadmark-postgres-tool-"));
  const database = createDatabase(":memory:");
  const service = new LocalToolService(
    database,
    new LocalSecretVault(path.join(temporary, "secrets")),
  );
  const tool = await service.create({
    type: "postgres_readonly",
    name: "Produção readonly",
    config: {
      host: "db.internal",
      port: 5432,
      database: "app",
      username: "support_readonly",
      sslMode: "require",
    },
    secrets: { password: "database-password" },
    allowedOperations: ["describe_schema", "query_readonly"],
  }, "test");
  const postgresRequests: PostgresQueryRequest[] = [];
  let postgresFailure: Error | null = null;
  const executor = new DeepToolExecutor(service, {
    async commandRunner() {
      throw new Error("O executor PostgreSQL não deve chamar um binário externo.");
    },
    async postgresRunner(request) {
      postgresRequests.push(request);
      if (postgresFailure) throw postgresFailure;
      return "id,status\n42,paid";
    },
  });

  try {
    const mutation = await executor.execute({
      requestId: "sql-1",
      toolId: tool.id,
      operation: "query_readonly",
      argumentsJson: JSON.stringify({ query: "DELETE FROM orders" }),
      purpose: "Operação proibida.",
    });
    assert.equal(mutation.status, "error");
    assert.equal(postgresRequests.length, 0);

    for (const dangerousQuery of [
      "SELECT pg_read_file('/etc/passwd')",
      "SELECT pg_catalog.pg_ls_dir('.')",
      "SELECT pg_terminate_backend(42)",
      "SELECT dblink('foreign', 'SELECT 1')",
      "SELECT public.custom_support_function()",
    ]) {
      const dangerous = await executor.execute({
        requestId: `danger-${postgresRequests.length}-${dangerousQuery.length}`,
        toolId: tool.id,
        operation: "query_readonly",
        argumentsJson: JSON.stringify({ query: dangerousQuery }),
        purpose: "Operação proibida.",
      });
      assert.equal(dangerous.status, "error", dangerousQuery);
      assert.equal(postgresRequests.length, 0, dangerousQuery);
    }

    const select = await executor.execute({
      requestId: "sql-2",
      toolId: tool.id,
      operation: "query_readonly",
      argumentsJson: JSON.stringify({
        query: "SELECT id, status FROM orders WHERE id = 42",
        maxRows: 10,
      }),
      purpose: "Confirmar pedido.",
    });
    assert.equal(select.status, "success");
    assert.equal(postgresRequests.length, 1);
    const selectRequest = postgresRequests[0]!;
    assert.deepEqual(selectRequest.config, {
      host: "db.internal",
      port: 5432,
      database: "app",
      username: "support_readonly",
      sslMode: "require",
    });
    assert.equal(selectRequest.password, "database-password");
    assert.equal(
      selectRequest.query,
      "SELECT * FROM (SELECT id, status FROM orders WHERE id = 42) AS threadmark_readonly_query LIMIT 10",
    );
    assert.equal(selectRequest.timeoutMs, 20_000);
    assert.equal(selectRequest.statementTimeoutMs, 15_000);
    assert.equal(selectRequest.lockTimeoutMs, 5_000);
    assert.equal(select.content, "id,status\n42,paid");
    assert.match(select.reference ?? "", /:request:sql-2$/);
    assert.doesNotMatch(JSON.stringify(select), /database-password/);

    const groupedSelect = await executor.execute({
      requestId: "sql-group-by",
      toolId: tool.id,
      operation: "query_readonly",
      argumentsJson: JSON.stringify({
        query: "SELECT status, COUNT(*) AS total FROM orders GROUP BY status ORDER BY (COUNT(*) - 1) DESC",
        maxRows: 20,
      }),
      purpose: "Reconciliar os resultados por status sem alterar dados.",
    });
    assert.equal(groupedSelect.status, "success");
    assert.match(postgresRequests.at(-1)?.query ?? "", /GROUP BY status ORDER BY \(COUNT\(\*\) - 1\) DESC/);

    const secondSelect = await executor.execute({
      requestId: "sql-3",
      toolId: tool.id,
      operation: "query_readonly",
      argumentsJson: JSON.stringify({ query: "SELECT id FROM orders WHERE id = 43" }),
      purpose: "Confirmar outro pedido.",
    });
    assert.equal(secondSelect.status, "success");
    assert.notEqual(secondSelect.reference, select.reference);
    assert.match(secondSelect.reference ?? "", /:request:sql-3$/);

    const connection = await executor.test(tool.id);
    assert.equal(connection.ok, true);
    assert.equal(connection.mode, "connection");
    assert.equal(postgresRequests.at(-1)?.query, "SELECT 1 AS ok");
    assert.equal(service.get(tool.id).lastTestStatus, "success");

    const schema = await executor.execute({
      requestId: "sql-schema",
      toolId: tool.id,
      operation: "describe_schema",
      argumentsJson: JSON.stringify({ schema: "public", table: "orders", maxRows: 25 }),
      purpose: "Inspecionar o schema autorizado.",
    });
    assert.equal(schema.status, "success");
    assert.match(postgresRequests.at(-1)?.query ?? "", /FROM information_schema\.columns/);
    assert.match(postgresRequests.at(-1)?.query ?? "", /table_schema = 'public'/);
    assert.match(postgresRequests.at(-1)?.query ?? "", /table_name = 'orders'/);
    assert.match(postgresRequests.at(-1)?.query ?? "", /LIMIT 25$/);

    postgresFailure = new Error(
      "Conexão recusada para database-password; password=database-password",
    );
    const failed = await executor.execute({
      requestId: "sql-failure",
      toolId: tool.id,
      operation: "query_readonly",
      argumentsJson: JSON.stringify({ query: "SELECT id FROM orders" }),
      purpose: "Validar erro seguro.",
    });
    assert.equal(failed.status, "error");
    assert.match(failed.summary, /Conexão recusada/i);
    assert.doesNotMatch(JSON.stringify(failed), /database-password/);
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("PostgreSQL padrão tenta conexão pelo driver pg sem executar psql", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "threadmark-postgres-driver-"));
  const database = createDatabase(":memory:");
  const service = new LocalToolService(
    database,
    new LocalSecretVault(path.join(temporary, "secrets")),
  );
  const tool = await service.create({
    type: "postgres_readonly",
    name: "PostgreSQL via driver",
    config: {
      host: "127.0.0.1",
      port: 1,
      database: "threadmark_unavailable",
      username: "threadmark_readonly",
      sslMode: "disable",
    },
    secrets: { password: "driver-password-must-stay-secret" },
    allowedOperations: ["query_readonly"],
  }, "test");
  let commandExecutions = 0;
  const executor = new DeepToolExecutor(service, {
    timeoutMs: 1_000,
    async commandRunner() {
      commandExecutions += 1;
      throw new Error("psql foi executado indevidamente");
    },
  });

  try {
    const connection = await executor.test(tool.id);
    assert.equal(connection.ok, false);
    assert.equal(connection.mode, "connection");
    assert.equal(commandExecutions, 0);
    assert.doesNotMatch(connection.message, /psql foi executado/i);
    assert.doesNotMatch(connection.message, /driver-password-must-stay-secret/);
    assert.equal(service.get(tool.id).lastTestStatus, "failed");
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("ClickHouse recebe readonly=2 e nunca expõe a credencial no resultado", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "threadmark-clickhouse-tool-"));
  const database = createDatabase(":memory:");
  const service = new LocalToolService(
    database,
    new LocalSecretVault(path.join(temporary, "secrets")),
  );
  const tool = await service.create({
    type: "clickhouse_readonly",
    name: "Analytics readonly",
    config: {
      baseUrl: "https://clickhouse.example.test",
      database: "analytics",
      username: "support",
    },
    secrets: { password: "clickhouse-password" },
    allowedOperations: ["query_readonly"],
  }, "test");
  let receivedUrl: URL | null = null;
  let receivedInit: RequestInit | null = null;
  const executor = new DeepToolExecutor(service, {
    fetchImpl: (async (input, init) => {
      receivedUrl = new URL(String(input));
      receivedInit = init ?? null;
      return new Response('{"id":42}\n', { status: 200 });
    }) as typeof globalThis.fetch,
  });

  try {
    const result = await executor.execute({
      requestId: "ch-1",
      toolId: tool.id,
      operation: "query_readonly",
      argumentsJson: JSON.stringify({ query: "SELECT id FROM orders", maxRows: 10 }),
      purpose: "Confirmar pedido.",
    });
    assert.equal(result.status, "success");
    const capturedUrl = receivedUrl as URL | null;
    const capturedInit = receivedInit as RequestInit | null;
    assert.equal(capturedUrl?.searchParams.get("readonly"), "2");
    assert.equal(capturedInit?.redirect, "error");
    assert.equal((capturedInit?.headers as Record<string, string>)["x-clickhouse-key"], "clickhouse-password");
    assert.doesNotMatch(JSON.stringify(result), /clickhouse-password/);

    const externalFunction = await executor.execute({
      requestId: "ch-external",
      toolId: tool.id,
      operation: "query_readonly",
      argumentsJson: JSON.stringify({ query: "SELECT * FROM s3('https://example.test/data.csv')" }),
      purpose: "Tentar acessar fonte externa.",
    });
    assert.equal(externalFunction.status, "error");
    assert.match(externalFunction.summary, /table function externa/i);
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("CloudWatch limita uma página sem combinar flags incompatíveis da AWS CLI", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "threadmark-cloudwatch-tool-"));
  const database = createDatabase(":memory:");
  const service = new LocalToolService(
    database,
    new LocalSecretVault(path.join(temporary, "secrets")),
  );
  const logGroup = "/aws/lambda/example-prod-processInboundWebhook";
  const tool = await service.create({
    type: "aws_cloudwatch",
    name: "WhatsApp inbound readonly",
    config: {
      region: "eu-central-1",
      authMode: "profile",
      profile: "default",
      logGroupPrefixes: [logGroup],
    },
    allowedOperations: ["query_logs"],
  }, "test");
  const commandArguments: string[][] = [];
  const executor = new DeepToolExecutor(service, {
    async commandRunner(request) {
      commandArguments.push(request.args);
      return "{}";
    },
  });

  try {
    const connection = await executor.test(tool.id);
    assert.equal(connection.ok, true);

    const query = await executor.execute({
      requestId: "aws-logs-1",
      toolId: tool.id,
      operation: "query_logs",
      argumentsJson: JSON.stringify({ logGroup, limit: 25 }),
      purpose: "Consultar erros de recebimento do WhatsApp.",
    });
    assert.equal(query.status, "success");
    assert.equal(commandArguments.length, 2);
    for (const args of commandArguments) {
      assert.ok(args.includes("--limit"));
      assert.ok(args.includes("--no-paginate"));
      assert.ok(!args.includes("--max-items"));
    }
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
