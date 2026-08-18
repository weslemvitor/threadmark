import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import { createDatabase, type SupportDatabase } from "../server/db/index.js";
import { InvestigationExecutionRegistry } from "../server/agent/investigation-execution-registry.js";
import { DirectoryStore, SupportStore } from "../server/domain/index.js";
import { createTestApiApp } from "../server/index.js";
import { loadConfig } from "../server/runtime/config.js";
import { offlineRuntimeState } from "../server/runtime/runtime-state.js";
import {
  TICKET_INTERNAL_NOTE_MAX_LENGTH,
  type TicketDetailDto,
} from "../shared/contracts.js";

const databases: SupportDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

function apiFixture() {
  const database = createDatabase(":memory:");
  databases.push(database);
  const store = new SupportStore(database);
  const account = store.upsertAccount({
    phoneNumber: "+5548000000000",
    displayName: "Comercial",
  });
  const client = store.upsertClient({
    name: "Cliente API",
    slug: "cliente-api",
    kind: "ecommerce",
  });
  const group = store.upsertGroup({
    accountId: account.id,
    clientId: client.id,
    externalJid: "api-test@g.us",
    subject: "Grupo API",
  });
  const participant = store.upsertParticipant({
    externalJid: "api-client@s.whatsapp.net",
    displayName: "Cliente",
  });
  store.addGroupParticipant(group.id, participant.id);
  const message = store.upsertMessage({
    externalId: "api-message",
    groupId: group.id,
    senderId: participant.id,
    occurredAt: "2026-07-16T15:00:00.000Z",
    text: "Preciso de ajuda.",
    messageType: "text",
    triageKind: "demand",
  });
  const ticket = store.createTicket({
    groupId: group.id,
    sourceMessageId: message.id,
    title: "Ajuda solicitada",
    summary: "Cliente solicita ajuda.",
  });
  return {
    app: createTestApiApp(store),
    database,
    store,
    clientId: client.id,
    groupId: group.id,
    participantId: participant.id,
    ticketId: ticket.id,
    messageId: message.id,
  };
}

function insertLocalUser(
  database: SupportDatabase,
  input: {
    id: string;
    displayName: string;
    role: "owner" | "admin" | "operator" | "viewer";
    active?: boolean;
  },
) {
  const timestamp = "2026-08-18T12:00:00.000Z";
  database
    .prepare(
      `INSERT INTO local_users (
         id, username, display_name, role, password_hash, active,
         failed_login_attempts, locked_until, last_login_at,
         password_changed_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.id,
      input.displayName,
      input.role,
      "test-password-hash",
      input.active === false ? 0 : 1,
      timestamp,
      timestamp,
      timestamp,
    );
}

test("API cria ticket manual sem mensagem e preserva idempotência", async () => {
  const { app, groupId } = apiFixture();
  const payload = {
    clientRequestId: "manual-api-request-1",
    groupId,
    title: "Ticket criado manualmente",
    summary: "Demanda isolada sem recorte de conversa.",
    priority: "urgent",
  };

  const create = await app.request("/api/tickets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(create.status, 201);
  const created = (await create.json()) as TicketDetailDto;
  assert.equal(created.title, payload.title);
  assert.equal(created.priority, "urgent");
  assert.equal(created.messageCount, 0);
  assert.equal(created.requester, null);

  const repeated = await app.request("/api/tickets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(repeated.status, 201);
  assert.equal(((await repeated.json()) as TicketDetailDto).id, created.id);

  const invalid = await app.request("/api/tickets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, title: "" }),
  });
  assert.equal(invalid.status, 400);
});

test("API lista responsáveis ativos e audita atribuição e remoção do ticket", async () => {
  const { app, database, ticketId } = apiFixture();
  insertLocalUser(database, {
    id: "operator-two",
    displayName: "Agente Dois",
    role: "operator",
  });
  insertLocalUser(database, {
    id: "viewer-readonly",
    displayName: "Pessoa somente leitura",
    role: "viewer",
  });
  insertLocalUser(database, {
    id: "inactive-operator",
    displayName: "Pessoa inativa",
    role: "operator",
    active: false,
  });

  const list = await app.request("/api/ticket-assignees");
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), [
    {
      id: "operator-two",
      displayName: "Agente Dois",
      role: "operator",
    },
  ]);

  const assignedResponse = await app.request(`/api/tickets/${ticketId}/assignee`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assigneeId: "operator-two" }),
  });
  assert.equal(assignedResponse.status, 200);
  const assigned = (await assignedResponse.json()) as TicketDetailDto;
  assert.deepEqual(assigned.assignee, {
    id: "operator-two",
    displayName: "Agente Dois",
    role: "operator",
  });
  assert.ok(
    assigned.timeline.some(
      (item) =>
        item.type === "event" &&
        item.eventType === "ticket_assigned" &&
        item.description.includes("Agente Dois"),
    ),
  );

  const invalid = await app.request(`/api/tickets/${ticketId}/assignee`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assigneeId: "viewer-readonly" }),
  });
  assert.equal(invalid.status, 400);

  const unassignedResponse = await app.request(`/api/tickets/${ticketId}/assignee`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assigneeId: null }),
  });
  assert.equal(unassignedResponse.status, 200);
  const unassigned = (await unassignedResponse.json()) as TicketDetailDto;
  assert.equal(unassigned.assignee, null);
  assert.ok(
    unassigned.timeline.some(
      (item) => item.type === "event" && item.eventType === "ticket_unassigned",
    ),
  );
});

test("API edita título, descrição, prioridade e solicitante do ticket", async () => {
  const { app, participantId, ticketId } = apiFixture();
  const response = await app.request(`/api/tickets/${ticketId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Atendimento revisado",
      summary: "Contexto detalhado e corrigido manualmente.",
      priority: "high",
      requesterId: participantId,
    }),
  });

  assert.equal(response.status, 200);
  const ticket = (await response.json()) as TicketDetailDto;
  assert.equal(ticket.title, "Atendimento revisado");
  assert.equal(ticket.summary, "Contexto detalhado e corrigido manualmente.");
  assert.equal(ticket.priority, "high");
  assert.equal(ticket.requester?.id, participantId);
  assert.equal(ticket.requesterOverrideId, participantId);
  assert.equal(ticket.requesterCandidates.length, 1);

  const invalid = await app.request(`/api/tickets/${ticketId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "",
      summary: ticket.summary,
      priority: ticket.priority,
      requesterId: participantId,
    }),
  });
  assert.equal(invalid.status, 400);
});

test("API persiste a edição completa do cliente e seus ecommerces", async () => {
  const { app, clientId } = apiFixture();

  const update = await app.request(`/api/clients/${clientId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Cliente API Renomeado",
      kind: "agency",
      notes: "Cadastro revisado pelo suporte.",
      stores: [
        {
          name: "Loja Alpha",
          businessId: "alpha-business",
          platform: "Shopify",
        },
        {
          name: "Loja Beta",
          businessId: null,
          platform: "VTEX",
        },
      ],
    }),
  });

  assert.equal(update.status, 200);
  const profile = (await update.json()) as {
    name: string;
    kind: string;
    stores: Array<{ name: string }>;
  };
  assert.equal(profile.name, "Cliente API Renomeado");
  assert.equal(profile.kind, "agency");
  assert.deepEqual(profile.stores.map((store) => store.name), ["Loja Alpha", "Loja Beta"]);

  const invalid = await app.request(`/api/clients/${clientId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "", kind: "agency", stores: [] }),
  });
  assert.equal(invalid.status, 400);
});

test("API cria categoria personalizada e permite vincular e remover do ticket", async () => {
  const { app, store, ticketId } = apiFixture();

  const create = await app.request("/api/categories", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      facet: "product",
      label: "Checkout",
      color: "#5b56d4",
    }),
  });
  assert.equal(create.status, 201);
  const category = (await create.json()) as { id: string; label: string };
  assert.equal(category.label, "Checkout");

  const attach = await app.request(`/api/tickets/${ticketId}/categories`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ categoryId: category.id }),
  });
  assert.equal(attach.status, 200);
  const attached = (await attach.json()) as TicketDetailDto;
  assert.deepEqual(attached.categories.map((item) => item.label), ["Checkout"]);

  const detach = await app.request(
    `/api/tickets/${ticketId}/categories/${category.id}`,
    { method: "DELETE" },
  );
  assert.equal(detach.status, 200);
  const detached = (await detach.json()) as TicketDetailDto;
  assert.deepEqual(detached.categories, []);
  assert.equal(
    store.listCategories().some((item) => item.id === category.id),
    true,
    "a categoria manual deve continuar no catálogo mesmo sem ticket",
  );
});

test("API associa o contexto do ticket a um cliente existente", async () => {
  const { app, store, ticketId } = apiFixture();
  const target = store.upsertClient({
    name: "Agência API",
    slug: "agencia-api",
    kind: "agency",
  });
  const targetStore = store.upsertStore({
    clientId: target.id,
    name: "Loja API",
  });

  const response = await app.request(`/api/tickets/${ticketId}/context`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientId: target.id,
      affectedStoreId: targetStore.id,
      rememberForConversation: true,
      actor: "Operador",
    }),
  });

  assert.equal(response.status, 200);
  const updated = (await response.json()) as {
    client: { id: string };
    affectedStore: { id: string } | null;
    latestInvestigation: { state: string } | null;
  };
  assert.equal(updated.client.id, target.id);
  assert.equal(updated.affectedStore?.id, targetStore.id);
  assert.equal(updated.latestInvestigation, null);
});

test("API exclui cliente da operação sem apagar o histórico", async () => {
  const { app, clientId, ticketId } = apiFixture();

  const response = await app.request(`/api/clients/${clientId}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      actor: "Operador",
      reason: "Contato sem relação com suporte",
    }),
  });

  assert.equal(response.status, 200);
  const result = (await response.json()) as {
    id: string;
    alreadyIgnored: boolean;
    preserved: { messages: number; tickets: number };
  };
  assert.equal(result.id, clientId);
  assert.equal(result.alreadyIgnored, false);
  assert.equal(result.preserved.messages, 1);
  assert.equal(result.preserved.tickets, 1);

  const [clients, tickets, detail, duplicate] = await Promise.all([
    app.request("/api/clients"),
    app.request("/api/tickets"),
    app.request(`/api/tickets/${ticketId}`),
    app.request(`/api/clients/${clientId}`, { method: "DELETE" }),
  ]);
  assert.deepEqual(await clients.json(), []);
  assert.equal(((await tickets.json()) as { total: number }).total, 0);
  assert.equal(detail.status, 200);
  assert.equal(((await duplicate.json()) as { alreadyIgnored: boolean }).alreadyIgnored, true);
});

test("API exclui ticket permanentemente e responde 404 nas leituras seguintes", async () => {
  const { app, store, ticketId, messageId } = apiFixture();
  store.upsertAttachment({
    id: "api-delete-ticket-attachment",
    messageId,
    kind: "document",
    mimeType: "text/plain",
    fileName: "contexto.txt",
    localPath: "/tmp/contexto.txt",
    sha256: "api-delete-ticket-attachment-sha",
  });
  store.queueInvestigation(ticketId);
  store.upsertTicketProductForwarding(
    ticketId,
    {
      kind: "bug",
      title: "Falha enviada ao Produto",
      description: "Contexto preservado antes da exclusão do ticket.",
    },
    "Operador",
  );

  const response = await app.request(`/api/tickets/${ticketId}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      actor: "Operador",
      reason: "Ticket gerado por engano",
    }),
  });

  assert.equal(response.status, 200);
  const result = (await response.json()) as {
    id: string;
    actor: string;
    reason: string | null;
    deleted: { investigationJobs: number };
    preserved: { messages: number; attachments: number };
  };
  assert.equal(result.id, ticketId);
  assert.equal(result.actor, "Operador");
  assert.equal(result.reason, "Ticket gerado por engano");
  assert.equal(result.deleted.investigationJobs, 1);
  assert.deepEqual(result.preserved, { messages: 1, attachments: 1 });

  const [detail, duplicate] = await Promise.all([
    app.request(`/api/tickets/${ticketId}`),
    app.request(`/api/tickets/${ticketId}`, { method: "DELETE" }),
  ]);
  assert.equal(detail.status, 404);
  assert.equal(duplicate.status, 404);
  assert.equal(
    (store.database.prepare("SELECT triage_state FROM messages WHERE id = ?").get(messageId) as { triage_state: string }).triage_state,
    "ignored",
  );
  assert.equal(
    (store.database.prepare("SELECT COUNT(*) AS count FROM attachments WHERE message_id = ?").get(messageId) as { count: number }).count,
    1,
  );
  assert.equal(
    (
      store.database
        .prepare(
          "SELECT COUNT(*) AS count FROM ticket_product_forwardings WHERE ticket_id = ?",
        )
        .get(ticketId) as { count: number }
    ).count,
    0,
  );
});

test("API desvincula mensagem sem apagar o histórico da conversa", async () => {
  const { app, store, ticketId, groupId, participantId, messageId } = apiFixture();
  const unrelated = store.upsertMessage({
    id: "api-unrelated-ticket-message",
    externalId: "api-unrelated-ticket-message",
    groupId,
    senderId: participantId,
    occurredAt: "2026-07-16T16:00:00.000Z",
    text: "Este é outro assunto.",
    messageType: "text",
  });
  store.attachMessageToTicket(ticketId, unrelated.id, "whatsapp-capture");

  const response = await app.request(
    `/api/tickets/${ticketId}/messages/${unrelated.id}`,
    { method: "DELETE" },
  );

  assert.equal(response.status, 200);
  const detail = (await response.json()) as TicketDetailDto;
  assert.equal(detail.messageCount, 1);
  assert.equal(
    detail.timeline.some((item) => item.type === "message" && item.id === unrelated.id),
    false,
  );
  assert.equal(
    (store.database.prepare("SELECT COUNT(*) AS count FROM messages WHERE id = ?").get(
      unrelated.id,
    ) as { count: number }).count,
    1,
  );
  assert.equal(
    (store.database.prepare("SELECT triage_state FROM messages WHERE id = ?").get(
      unrelated.id,
    ) as { triage_state: string }).triage_state,
    "context",
  );

  const sourceResponse = await app.request(
    `/api/tickets/${ticketId}/messages/${messageId}`,
    { method: "DELETE" },
  );
  assert.equal(sourceResponse.status, 409);
  assert.match(
    JSON.stringify(await sourceResponse.json()),
    /mensagem de origem não pode ser removida/i,
  );
});

test("runtime combina conexão do arquivo com contadores atuais do SQLite", async () => {
  const { store } = apiFixture();
  const staleRuntime = {
    ...offlineRuntimeState(new Date("2026-07-17T12:00:00.000Z")),
    phase: "online" as const,
    pid: 1234,
    whatsappConnected: true,
  };
  const app = createTestApiApp(store, {
    async read() {
      return staleRuntime;
    },
  });

  const response = await app.request("/api/runtime");
  assert.equal(response.status, 200);
  const runtime = (await response.json()) as {
    state: string;
    pid: number | null;
    groupsDiscovered: number;
    groupsSynced: number;
    privateConversations: number;
    messagesStored: number;
    ticketsCreated: number;
  };

  assert.equal(runtime.state, "online");
  assert.equal(runtime.pid, 1234);
  assert.equal(runtime.groupsDiscovered, 1);
  assert.equal(runtime.groupsSynced, 1);
  assert.equal(runtime.privateConversations, 0);
  assert.equal(runtime.messagesStored, 1);
  assert.equal(runtime.ticketsCreated, 1);
});

test("API expõe dashboard, tickets, clientes e detalhe sem rota de envio", async () => {
  const { app, ticketId } = apiFixture();

  const [health, dashboard, tickets, detail, clients, forbiddenOutbound] =
    await Promise.all([
      app.request("/health"),
      app.request("/api/dashboard"),
      app.request("/api/tickets"),
      app.request(`/api/tickets/${ticketId}`),
      app.request("/api/clients"),
      app.request("/api/messages/send", { method: "POST" }),
    ]);

  assert.equal(health.status, 200);
  assert.equal(dashboard.status, 200);
  assert.equal(tickets.status, 200);
  assert.equal(detail.status, 200);
  assert.equal(clients.status, 200);
  assert.equal(forbiddenOutbound.status, 404);
  const list = (await tickets.json()) as { total: number };
  assert.equal(list.total, 1);
});

test("API persiste o modelo econômico escolhido para a triagem no SQLite", async () => {
  const { app, store } = apiFixture();

  const initial = await app.request("/api/triage/settings");
  assert.equal(initial.status, 200);
  const initialSettings = (await initial.json()) as {
    enabled: boolean;
    model: string;
    silenceWindowSeconds: number;
    updatedBy: string;
    updatedAt: string;
  };
  assert.equal(initialSettings.enabled, true);
  assert.equal(initialSettings.model, "default");
  assert.equal(initialSettings.silenceWindowSeconds, 180);
  assert.equal(initialSettings.updatedBy, "codex-isolated-migration");
  assert.match(initialSettings.updatedAt, /^\d{4}-\d{2}-\d{2}T/);

  const updated = await app.request("/api/triage/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      enabled: true,
      model: "gpt-5.4",
      silenceWindowSeconds: 240,
      actor: "Operador",
    }),
  });
  assert.equal(updated.status, 200);
  const settings = (await updated.json()) as {
    enabled: boolean;
    model: string;
    silenceWindowSeconds: number;
    updatedBy: string;
  };
  assert.equal(settings.enabled, true);
  assert.equal(settings.model, "gpt-5.4");
  assert.equal(settings.silenceWindowSeconds, 240);
  assert.equal(settings.updatedBy, "Operador");
  assert.equal(
    (
      store.database
        .prepare(
          "SELECT silence_window_seconds FROM triage_ai_settings WHERE singleton = 1",
        )
        .get() as { silence_window_seconds: number }
    ).silence_window_seconds,
    240,
  );

  const persisted = await app.request("/api/triage/settings");
  assert.equal(persisted.status, 200);
  assert.equal(
    ((await persisted.json()) as { silenceWindowSeconds: number })
      .silenceWindowSeconds,
    240,
  );

  const invalid = await app.request("/api/triage/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, model: "modelo com espaços" }),
  });
  assert.equal(invalid.status, 400);

  for (const silenceWindowSeconds of [29, 1_801]) {
    const invalidWindow = await app.request("/api/triage/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        model: "gpt-5.4",
        silenceWindowSeconds,
      }),
    });
    assert.equal(invalidWindow.status, 400);
  }

  assert.equal(store.getTriageAiSettings().silenceWindowSeconds, 240);
});

test("API coalesce a análise manual da conversa sem criar ticket automaticamente", async () => {
  const { app, store, groupId, participantId } = apiFixture();
  const candidate = store.upsertMessage({
    externalId: "api-triage-analysis-message",
    groupId,
    senderId: participantId,
    occurredAt: "2026-07-20T16:00:00.000Z",
    text: "O dashboard não atualizou os pedidos de hoje.",
    messageType: "text",
    triageKind: "demand",
    triageState: "unreviewed",
    ingestionSource: "realtime_notify",
  });
  const ticketsBefore = (
    store.database.prepare("SELECT COUNT(*) AS count FROM tickets").get() as {
      count: number;
    }
  ).count;

  const first = await app.request(`/api/conversations/${groupId}/triage/analyze`, {
    method: "POST",
  });
  assert.equal(first.status, 200);
  const firstResult = (await first.json()) as {
    accepted: boolean;
    jobId: string | null;
    analysis: {
      state: string;
      pendingMessageCount: number;
      nextAnalysisAt: string | null;
    };
  };
  assert.equal(firstResult.accepted, true);
  assert.ok(firstResult.jobId);
  assert.equal(firstResult.analysis.state, "queued");
  assert.equal(firstResult.analysis.pendingMessageCount, 1);
  assert.equal(firstResult.analysis.nextAnalysisAt, null);

  const repeated = await app.request(
    `/api/conversations/${groupId}/triage/analyze`,
    { method: "POST" },
  );
  assert.equal(repeated.status, 200);
  const repeatedResult = (await repeated.json()) as typeof firstResult;
  assert.equal(repeatedResult.accepted, true);
  assert.equal(repeatedResult.jobId, firstResult.jobId);
  assert.equal(repeatedResult.analysis.state, "queued");

  const jobs = store.database
    .prepare(
      `SELECT job.id, job.state, job.model, job.prompt_version,
              membership.message_id, membership.active
       FROM triage_ai_jobs job
       JOIN triage_ai_job_messages membership ON membership.job_id = job.id
       WHERE job.group_id = ?`,
    )
    .all(groupId) as Array<{
    id: string;
    state: string;
    model: string;
    prompt_version: string;
    message_id: string;
    active: number;
  }>;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.id, firstResult.jobId);
  assert.equal(jobs[0]?.state, "queued");
  assert.equal(jobs[0]?.model, "default");
  assert.ok(jobs[0]?.prompt_version);
  assert.equal(jobs[0]?.message_id, candidate.id);
  assert.equal(jobs[0]?.active, 1);

  const conversation = await app.request(
    `/api/conversations/${groupId}/messages`,
  );
  assert.equal(conversation.status, 200);
  const conversationBody = (await conversation.json()) as {
    suggestionAnalysis: { state: string; pendingMessageCount: number };
  };
  assert.deepEqual(conversationBody.suggestionAnalysis, {
    state: "queued",
    pendingMessageCount: 1,
    nextAnalysisAt: null,
  });

  const ticketsAfter = (
    store.database.prepare("SELECT COUNT(*) AS count FROM tickets").get() as {
      count: number;
    }
  ).count;
  assert.equal(ticketsAfter, ticketsBefore);
});

test("API serve somente anexos disponíveis dentro da raiz local", async () => {
  const previousDataDirectory = process.env.SUPPORT_DATA_DIR;
  const testDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "threadmark-backend-api-"),
  );
  process.env.SUPPORT_DATA_DIR = testDataDirectory;

  try {
    const { app, store, messageId } = apiFixture();
    const config = loadConfig();
    const fixtureDirectory = path.join(config.attachmentsDir, `test-${randomUUID()}`);
    const filePath = path.join(fixtureDirectory, "evidencia.txt");
    await mkdir(fixtureDirectory, { recursive: true });
    await writeFile(filePath, "evidencia-local");
    const attachment = store.upsertAttachment({
      messageId,
      kind: "document",
      mimeType: "text/plain",
      fileName: "evidencia.txt",
      localPath: filePath,
      sha256: randomUUID(),
      available: true,
    });
    const response = await app.request(`/api/attachments/${attachment.id}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await response.text(), "evidencia-local");
  } finally {
    if (previousDataDirectory === undefined) {
      delete process.env.SUPPORT_DATA_DIR;
    } else {
      process.env.SUPPORT_DATA_DIR = previousDataDirectory;
    }
    await rm(testDataDirectory, { recursive: true, force: true });
  }
});

test("PATCH de status valida transições e a investigação automática não possui rota", async () => {
  const { app, ticketId } = apiFixture();

  const statusResponse = await app.request(`/api/tickets/${ticketId}/status`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "in_progress", actor: "Operador" }),
  });
  assert.equal(statusResponse.status, 200);
  const statusBody = (await statusResponse.json()) as { status: string };
  assert.equal(statusBody.status, "in_progress");

  const investigateResponse = await app.request(
    `/api/tickets/${ticketId}/investigate`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instructions: "Investigar com evidências readonly" }),
    },
  );
  assert.equal(investigateResponse.status, 404);

  const invalidResponse = await app.request(`/api/tickets/${ticketId}/status`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "sent" }),
  });
  assert.equal(invalidResponse.status, 400);

  const resolutionRequired = await app.request(`/api/tickets/${ticketId}/status`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "resolved", actor: "Operador" }),
  });
  assert.equal(resolutionRequired.status, 400);
});

test("API expõe grupos sem expor a fila legada de investigação automática", async () => {
  const { app } = apiFixture();

  const [groupsResponse, jobsResponse, invalidState] = await Promise.all([
    app.request("/api/groups"),
    app.request("/api/investigations?state=queued&limit=10"),
    app.request("/api/investigations?state=unknown"),
  ]);

  assert.equal(groupsResponse.status, 200);
  const groups = (await groupsResponse.json()) as Array<{
    subject: string;
    messageCount: number;
    openTicketCount: number;
  }>;
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.subject, "Grupo API");
  assert.equal(groups[0]?.messageCount, 1);
  assert.equal(groups[0]?.openTicketCount, 1);

  assert.equal(jobsResponse.status, 404);
  assert.equal(invalidState.status, 404);
});

test("API cria uma sala idempotente e persiste mensagens do operador", async () => {
  const { app, ticketId } = apiFixture();

  const firstResponse = await app.request(
    `/api/tickets/${ticketId}/investigation-thread`,
    { method: "POST" },
  );
  assert.equal(firstResponse.status, 200);
  const first = (await firstResponse.json()) as {
    id: string;
    ticketId: string;
    messages: unknown[];
  };
  const duplicateResponse = await app.request(
    `/api/tickets/${ticketId}/investigation-thread`,
    { method: "POST" },
  );
  const duplicate = (await duplicateResponse.json()) as { id: string };
  assert.equal(duplicate.id, first.id);

  const messageResponse = await app.request(
    `/api/investigation-threads/${first.id}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "Consulte o banco em modo readonly.",
        clientMessageId: "api-message-idempotency",
      }),
    },
  );
  assert.equal(messageResponse.status, 202);
  const queued = (await messageResponse.json()) as {
    activeTurnState: string | null;
    messages: Array<{ role: string; body: string }>;
  };
  assert.equal(queued.activeTurnState, "queued");
  assert.equal(queued.messages.length, 1);
  assert.equal(queued.messages[0]?.role, "operator");
  assert.equal(
    queued.messages[0]?.body,
    "Consulte o banco em modo readonly.",
  );

  const idempotentResponse = await app.request(
    `/api/investigation-threads/${first.id}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "Não deve duplicar.",
        clientMessageId: "api-message-idempotency",
      }),
    },
  );
  const idempotent = (await idempotentResponse.json()) as { messages: unknown[] };
  assert.equal(idempotent.messages.length, 1);

  const getResponse = await app.request(`/api/investigation-threads/${first.id}`);
  assert.equal(getResponse.status, 200);
  const persisted = (await getResponse.json()) as { messages: unknown[] };
  assert.equal(persisted.messages.length, 1);
  assert.equal(first.ticketId, ticketId);

  const invalid = await app.request(
    `/api/investigation-threads/${first.id}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "" }),
    },
  );
  assert.equal(invalid.status, 400);
});

test("API cancela turno running de forma idempotente e aborta o job específico", async () => {
  const { store, ticketId } = apiFixture();
  const registry = new InvestigationExecutionRegistry();
  const app = createTestApiApp(store, undefined, undefined, {
    investigationExecutions: registry,
  });
  const thread = store.getOrCreateInvestigationThread(ticketId);
  store.addInvestigationThreadMessage(thread.id, {
    body: "Investigue até eu clicar em parar.",
  });
  const claimed = store.claimNextAgentJob();
  assert.equal(claimed?.kind, "thread_turn");
  if (!claimed || claimed.kind !== "thread_turn") assert.fail("turno não reivindicado");
  const execution = registry.begin(claimed.id);

  const response = await app.request(
    `/api/investigation-threads/${thread.id}/cancel`,
    { method: "POST" },
  );
  assert.equal(response.status, 200);
  const cancelled = (await response.json()) as {
    activeTurnState: string | null;
    turns: Array<{
      state: string;
      cancelledAt: string | null;
      cancelledBy: string | null;
    }>;
  };
  assert.equal(execution.signal.aborted, true);
  assert.equal(cancelled.activeTurnState, null);
  assert.equal(cancelled.turns[0]?.state, "cancelled");
  assert.ok(cancelled.turns[0]?.cancelledAt);
  assert.ok(cancelled.turns[0]?.cancelledBy);

  const repeated = await app.request(
    `/api/investigation-threads/${thread.id}/cancel`,
    { method: "POST" },
  );
  assert.equal(repeated.status, 200);
  assert.equal(
    ((await repeated.json()) as { turns: Array<{ state: string }> }).turns[0]
      ?.state,
    "cancelled",
  );
  assert.equal(
    (
      store.database
        .prepare(
          `SELECT COUNT(*) AS count FROM ticket_events
           WHERE ticket_id = ? AND event_type = 'investigation_thread_turn_cancelled'`,
        )
        .get(ticketId) as { count: number }
    ).count,
    1,
  );
  execution.release();
});

test("API atualiza contexto agnóstico do ticket com schema estrito", async () => {
  const { app, store, groupId, ticketId } = apiFixture();
  const directory = new DirectoryStore(store.database);
  const type = directory
    .getSnapshot()
    .recordTypes.find((recordType) => recordType.slug === "organizacao");
  assert.ok(type);
  const record = directory.createRecord(
    {
      typeId: type.id,
      name: "Conta estratégica",
      groupIds: [groupId],
    },
    "Pessoa administradora",
  );

  const response = await app.request(
    `/api/tickets/${ticketId}/directory-context`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recordIds: [record.id] }),
    },
  );
  assert.equal(response.status, 200);
  const updated = (await response.json()) as TicketDetailDto;
  assert.deepEqual(updated.directoryContext.explicitRecordIds, [record.id]);
  assert.deepEqual(updated.directoryContext.records[0]?.sources, [
    "ticket",
    "group",
  ]);
  assert.equal(updated.latestInvestigation, null);
  assert.ok(
    updated.timeline.some(
      (item) =>
        item.type === "event" &&
        item.eventType === "ticket_directory_context_changed",
    ),
  );

  const invalid = await app.request(
    `/api/tickets/${ticketId}/directory-context`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recordIds: [record.id], actor: "Navegador" }),
    },
  );
  assert.equal(invalid.status, 400);
});

test("API salva nota interna idempotente sem aceitar ator público", async () => {
  const { app, store, ticketId } = apiFixture();
  store.database
    .prepare("UPDATE tickets SET updated_at = ? WHERE id = ?")
    .run("2026-01-01T00:00:00.000Z", ticketId);
  const request = (body: unknown) =>
    app.request(`/api/tickets/${ticketId}/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const response = await request({
    body: "Cliente confirmou que o indicador voltou ao normal.",
    clientNoteId: "note-api-idempotent",
  });
  assert.equal(response.status, 201);
  const detail = (await response.json()) as TicketDetailDto;
  const note = detail.timeline.find(
    (item) => item.type === "event" && item.eventType === "internal_note_added",
  );
  assert.equal(note?.type, "event");
  if (note?.type !== "event") assert.fail("nota interna não retornada");
  assert.equal(note.actor, "Operador local");
  assert.equal(
    note.metadata.body,
    "Cliente confirmou que o indicador voltou ao normal.",
  );
  const firstUpdatedAt = (
    store.database
      .prepare("SELECT updated_at FROM tickets WHERE id = ?")
      .get(ticketId) as { updated_at: string }
  ).updated_at;
  assert.notEqual(firstUpdatedAt, "2026-01-01T00:00:00.000Z");

  const repeated = await request({
    body: "Este texto não substitui a primeira escrita.",
    clientNoteId: "note-api-idempotent",
  });
  assert.equal(repeated.status, 201);
  assert.equal(
    (
      store.database
        .prepare(
          `SELECT COUNT(*) AS count FROM ticket_events
           WHERE ticket_id = ? AND event_type = 'internal_note_added'`,
        )
        .get(ticketId) as { count: number }
    ).count,
    1,
  );
  assert.equal(
    (
      store.database
        .prepare("SELECT updated_at FROM tickets WHERE id = ?")
        .get(ticketId) as { updated_at: string }
    ).updated_at,
    firstUpdatedAt,
  );

  const [publicActor, oversized] = await Promise.all([
    request({
      body: "Tentativa com ator público.",
      clientNoteId: "note-public-actor",
      actor: "Pessoa forjada",
    }),
    request({
      body: "x".repeat(TICKET_INTERNAL_NOTE_MAX_LENGTH + 1),
      clientNoteId: "note-too-long",
    }),
  ]);
  assert.equal(publicActor.status, 400);
  assert.equal(oversized.status, 400);
});

test("API edita e exclui nota interna com auditoria e valida seu vínculo ao ticket", async () => {
  const { app, store, ticketId, groupId, messageId } = apiFixture();
  const createdResponse = await app.request(`/api/tickets/${ticketId}/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      body: "Cliente ainda está validando o resultado.",
      clientNoteId: "note-api-crud",
    }),
  });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()) as TicketDetailDto;
  const createdNote = created.timeline.find(
    (item) => item.type === "event" && item.eventType === "internal_note_added",
  );
  assert.equal(createdNote?.type, "event");
  if (createdNote?.type !== "event") assert.fail("nota interna não retornada");
  const originalOccurredAt = createdNote.occurredAt;

  const editedResponse = await app.request(
    `/api/tickets/${ticketId}/notes/${createdNote.id}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "Cliente validou o resultado e confirmou a correção.",
        expectedUpdatedAt: originalOccurredAt,
      }),
    },
  );
  assert.equal(editedResponse.status, 200);
  const edited = (await editedResponse.json()) as TicketDetailDto;
  const editedNote = edited.timeline.find(
    (item) => item.type === "event" && item.id === createdNote.id,
  );
  assert.equal(editedNote?.type, "event");
  if (editedNote?.type !== "event") assert.fail("nota editada não retornada");
  assert.equal(
    editedNote.metadata.body,
    "Cliente validou o resultado e confirmou a correção.",
  );
  assert.equal(editedNote.metadata.updatedBy, "Operador local");
  assert.equal(typeof editedNote.metadata.updatedAt, "string");
  assert.equal(editedNote.occurredAt, originalOccurredAt);
  assert.notEqual(editedNote.metadata.updatedAt, originalOccurredAt);
  const editAudit = edited.timeline.find(
    (item) =>
      item.type === "event" && item.eventType === "internal_note_updated",
  );
  assert.equal(editAudit?.type, "event");
  if (editAudit?.type !== "event") assert.fail("auditoria da edição não retornada");
  assert.equal(editAudit.actor, "Operador local");
  assert.equal(editAudit.metadata.noteId, createdNote.id);
  assert.equal(
    editAudit.metadata.previousBody,
    "Cliente ainda está validando o resultado.",
  );

  const staleEdit = await app.request(
    `/api/tickets/${ticketId}/notes/${createdNote.id}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "Uma edição concorrente não pode sobrescrever a atual.",
        expectedUpdatedAt: originalOccurredAt,
      }),
    },
  );
  assert.equal(staleEdit.status, 409);
  const stalePayload = (await staleEdit.json()) as {
    error: {
      details: { expectedUpdatedAt: string; currentUpdatedAt: string };
    };
  };
  assert.equal(stalePayload.error.details.expectedUpdatedAt, originalOccurredAt);
  assert.equal(
    stalePayload.error.details.currentUpdatedAt,
    editedNote.metadata.updatedAt,
  );

  const ticketCreatedEvent = created.timeline.find(
    (item) => item.type === "event" && item.eventType === "ticket_created",
  );
  assert.equal(ticketCreatedEvent?.type, "event");
  if (ticketCreatedEvent?.type !== "event") {
    assert.fail("evento de criação do ticket não encontrado");
  }
  const wrongType = await app.request(
    `/api/tickets/${ticketId}/notes/${ticketCreatedEvent.id}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "Não pode editar outro tipo de evento.",
        expectedUpdatedAt: ticketCreatedEvent.occurredAt,
      }),
    },
  );
  assert.equal(wrongType.status, 400);

  const senderId = (
    store.database
      .prepare("SELECT sender_id FROM messages WHERE id = ?")
      .get(messageId) as { sender_id: string }
  ).sender_id;
  const otherMessage = store.upsertMessage({
    externalId: "api-note-other-message",
    groupId,
    senderId,
    occurredAt: "2026-07-16T15:05:00.000Z",
    text: "Outra solicitação.",
    messageType: "text",
    triageKind: "demand",
  });
  const otherTicket = store.createTicket({
    groupId,
    sourceMessageId: otherMessage.id,
    title: "Outra solicitação",
    summary: "Outro ticket usado para validar ownership da nota.",
  });
  const wrongTicket = await app.request(
    `/api/tickets/${otherTicket.id}/notes/${createdNote.id}`,
    {
      method: "DELETE",
    },
  );
  assert.equal(wrongTicket.status, 404);

  const publicActor = await app.request(
    `/api/tickets/${ticketId}/notes/${createdNote.id}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "Tentativa inválida.",
        expectedUpdatedAt: editedNote.metadata.updatedAt,
        actor: "Pessoa forjada",
      }),
    },
  );
  assert.equal(publicActor.status, 400);

  const deletedResponse = await app.request(
    `/api/tickets/${ticketId}/notes/${createdNote.id}`,
    { method: "DELETE" },
  );
  assert.equal(deletedResponse.status, 200);
  const deleted = (await deletedResponse.json()) as TicketDetailDto;
  assert.equal(
    deleted.timeline.some((item) => item.id === createdNote.id),
    false,
    "a nota excluída não deve continuar na timeline",
  );
  assert.ok(
    deleted.timeline.some(
      (item) =>
        item.type === "message" && item.id === messageId,
    ),
    "a exclusão da nota não deve remover mensagens do ticket",
  );
  const deleteAudit = deleted.timeline.find(
    (item) =>
      item.type === "event" && item.eventType === "internal_note_deleted",
  );
  assert.equal(deleteAudit?.type, "event");
  if (deleteAudit?.type !== "event") {
    assert.fail("auditoria da exclusão não retornada");
  }
  assert.equal(deleteAudit.actor, "Operador local");
  assert.equal(deleteAudit.metadata.noteId, createdNote.id);
  assert.equal(
    Object.prototype.hasOwnProperty.call(deleteAudit.metadata, "deletedBody"),
    false,
  );
  const persistedNote = store.database
    .prepare(
      `SELECT data_json FROM ticket_events
       WHERE id = ? AND ticket_id = ? AND event_type = 'internal_note_added'`,
    )
    .get(createdNote.id, ticketId) as { data_json: string } | undefined;
  assert.ok(persistedNote, "o registro original deve permanecer para auditoria");
  const persistedNoteData = JSON.parse(persistedNote.data_json) as {
    body?: string;
    deletedAt?: string;
    deletedBy?: string;
  };
  assert.equal(
    Object.prototype.hasOwnProperty.call(persistedNoteData, "body"),
    false,
  );
  assert.equal(typeof persistedNoteData.deletedAt, "string");
  assert.equal(persistedNoteData.deletedBy, "Operador local");
  const persistedEventMetadata = store.database
    .prepare("SELECT data_json FROM ticket_events WHERE ticket_id = ?")
    .all(ticketId) as Array<{ data_json: string }>;
  for (const event of persistedEventMetadata) {
    assert.equal(
      event.data_json.includes("Cliente ainda está validando o resultado."),
      false,
      "o texto original não pode permanecer em nenhuma metadata após excluir",
    );
    assert.equal(
      event.data_json.includes(
        "Cliente validou o resultado e confirmou a correção.",
      ),
      false,
      "o texto editado não pode permanecer em nenhuma metadata após excluir",
    );
  }

  const repeatedDelete = await app.request(
    `/api/tickets/${ticketId}/notes/${createdNote.id}`,
    { method: "DELETE" },
  );
  assert.equal(repeatedDelete.status, 409);
});

test("API cria, edita e resolve encaminhamento persistente ao Produto", async () => {
  const { app, store, ticketId } = apiFixture();
  const request = (body: unknown) =>
    app.request(`/api/tickets/${ticketId}/product-forwarding`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const createdResponse = await request({
    kind: "bug",
    title: "Contagem incorreta no dashboard",
    description:
      "A soma de clientes novos e recorrentes não corresponde ao total exibido.",
    externalReference: "PROD-123",
    resolveTicket: false,
  });
  assert.equal(createdResponse.status, 200);
  const created = (await createdResponse.json()) as TicketDetailDto;
  assert.equal(created.status, "new");
  assert.deepEqual(created.productForwarding, {
    kind: "bug",
    title: "Contagem incorreta no dashboard",
    description:
      "A soma de clientes novos e recorrentes não corresponde ao total exibido.",
    externalReference: "PROD-123",
    createdBy: "Operador local",
    updatedBy: "Operador local",
    createdAt: created.productForwarding?.createdAt,
    updatedAt: created.productForwarding?.updatedAt,
  });
  assert.ok(created.productForwarding?.createdAt);
  assert.ok(
    created.timeline.some(
      (item) =>
        item.type === "event" &&
        item.eventType === "ticket_forwarded_to_product" &&
        item.metadata.externalReference === "PROD-123",
    ),
  );

  const listResponse = await app.request("/api/tickets");
  assert.equal(listResponse.status, 200);
  const list = (await listResponse.json()) as {
    items: Array<{
      id: string;
      productForwarding: Record<string, unknown> | null;
    }>;
  };
  const summary = list.items.find((ticket) => ticket.id === ticketId);
  assert.equal(summary?.productForwarding?.title, "Contagem incorreta no dashboard");
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      summary?.productForwarding ?? {},
      "description",
    ),
    false,
    "a listagem deve expor somente o resumo leve",
  );

  const productEventCount = () =>
    (
      store.database
        .prepare(
          `SELECT COUNT(*) AS count FROM ticket_events
           WHERE ticket_id = ?
             AND event_type IN (
               'ticket_forwarded_to_product',
               'ticket_product_forwarding_updated'
             )`,
        )
        .get(ticketId) as { count: number }
    ).count;
  assert.equal(productEventCount(), 1);

  const repeatedResponse = await request({
    kind: "bug",
    title: "Contagem incorreta no dashboard",
    description:
      "A soma de clientes novos e recorrentes não corresponde ao total exibido.",
    externalReference: "PROD-123",
    resolveTicket: false,
  });
  assert.equal(repeatedResponse.status, 200);
  assert.equal(productEventCount(), 1, "um upsert idêntico não duplica auditoria");

  const updatedResponse = await request({
    kind: "bug",
    title: "Métrica total diverge da segmentação",
    description: "Produto deve revisar a regra de deduplicação do dashboard.",
    externalReference: "https://linear.app/example/issue/PROD-123",
    resolveTicket: true,
  });
  assert.equal(updatedResponse.status, 200);
  const updated = (await updatedResponse.json()) as TicketDetailDto;
  assert.equal(updated.status, "resolved");
  assert.equal(
    updated.productForwarding?.title,
    "Métrica total diverge da segmentação",
  );
  assert.equal(
    updated.productForwarding?.description,
    "Produto deve revisar a regra de deduplicação do dashboard.",
  );
  assert.equal(
    updated.productForwarding?.externalReference,
    "https://linear.app/example/issue/PROD-123",
  );
  assert.equal(
    updated.productForwarding?.createdAt,
    created.productForwarding?.createdAt,
  );
  assert.equal(productEventCount(), 2);
  assert.ok(
    updated.timeline.some(
      (item) =>
        item.type === "event" &&
        item.eventType === "ticket_product_forwarding_updated",
    ),
  );
  assert.ok(
    updated.timeline.some(
      (item) =>
        item.type === "event" &&
        item.eventType === "status_changed" &&
        item.toStatus === "resolved" &&
        item.metadata.reason === "forwarded_to_product_as_bug",
    ),
  );
  assert.equal(
    (
      store.database
        .prepare(
          "SELECT COUNT(*) AS count FROM ticket_product_forwardings WHERE ticket_id = ?",
        )
        .get(ticketId) as { count: number }
    ).count,
    1,
  );

  const [forgedActor, unsupportedKind] = await Promise.all([
    request({
      kind: "bug",
      title: "Título",
      description: "Descrição",
      actor: "Pessoa forjada",
    }),
    request({
      kind: "feature",
      title: "Título",
      description: "Descrição",
    }),
  ]);
  assert.equal(forgedActor.status, 400);
  assert.equal(unsupportedKind.status, 400);
});

test("API preserva bugs arquivados no historico filtrado", async () => {
  const { app, store, ticketId } = apiFixture();

  const forwardingResponse = await app.request(
    `/api/tickets/${ticketId}/product-forwarding`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "bug",
        title: "Divergencia na metrica total",
        description: "Produto precisa revisar a regra de deduplicacao.",
        externalReference: "PROD-456",
        resolveTicket: true,
      }),
    },
  );
  assert.equal(forwardingResponse.status, 200);

  store.updateTicketStatus(ticketId, {
    status: "archived",
    actor: "Operador local",
  });

  const [operationalResponse, filteredResponse, historyResponse, invalidResponse] =
    await Promise.all([
      app.request("/api/tickets"),
      app.request("/api/tickets?productForwardingKind=bug"),
      app.request(
        "/api/tickets?productForwardingKind=bug&includeArchived=true&order=created_desc&limit=200&offset=0",
      ),
      app.request(
        "/api/tickets?productForwardingKind=feature&includeArchived=true",
      ),
    ]);

  assert.equal(operationalResponse.status, 200);
  assert.equal(filteredResponse.status, 200);
  assert.equal(historyResponse.status, 200);
  assert.equal(invalidResponse.status, 400);

  const operational = (await operationalResponse.json()) as {
    items: Array<{ id: string }>;
  };
  const filtered = (await filteredResponse.json()) as {
    items: Array<{ id: string }>;
  };
  const history = (await historyResponse.json()) as {
    items: Array<{
      id: string;
      status: string;
      productForwarding: { kind: string; title: string } | null;
    }>;
    total: number;
    limit: number;
    offset: number;
  };

  assert.equal(
    operational.items.some((ticket) => ticket.id === ticketId),
    false,
    "tickets arquivados nao devem voltar para a fila operacional",
  );
  assert.equal(
    filtered.items.some((ticket) => ticket.id === ticketId),
    false,
    "o filtro continua respeitando a exclusao padrao de arquivados",
  );
  assert.deepEqual(history.items.map((ticket) => ticket.id), [ticketId]);
  assert.equal(history.items[0]?.status, "archived");
  assert.equal(history.items[0]?.productForwarding?.kind, "bug");
  assert.equal(
    history.items[0]?.productForwarding?.title,
    "Divergencia na metrica total",
  );
  assert.equal(history.total, 1);
  assert.equal(history.limit, 200);
  assert.equal(history.offset, 0);
});
