import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { createDatabase, type SupportDatabase } from "../server/db/index.js";
import { ConflictError, SupportStore } from "../server/domain/index.js";
import { createTestApiApp } from "../server/index.js";

const databases: SupportDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture() {
  const database = createDatabase(":memory:");
  databases.push(database);
  const store = new SupportStore(database);
  const account = store.upsertAccount({
    id: "account",
    phoneNumber: "+5548999999999",
    displayName: "Comercial",
  });
  const client = store.upsertClient({
    id: "client",
    name: "Cliente Conversa",
    slug: "cliente-conversa",
    kind: "ecommerce",
  });
  const group = store.upsertGroup({
    id: "conversation",
    accountId: account.id,
    clientId: client.id,
    externalJid: "120363000099@g.us",
    subject: "Acme + Cliente Conversa",
  });
  const customer = store.upsertParticipant({
    id: "customer",
    externalJid: "5511999999999@s.whatsapp.net",
    displayName: "Cliente",
  });
  const staff = store.upsertParticipant({
    id: "staff",
    externalJid: "5548999999999@s.whatsapp.net",
    displayName: "Operador",
  });
  store.setStaffMember(staff.id, "Operador");
  store.addGroupParticipant(group.id, customer.id);
  store.addGroupParticipant(group.id, staff.id);

  const addExternal = (id: string, occurredAt: string, text: string) =>
    store.upsertMessage({
      id,
      externalId: `external-${id}`,
      groupId: group.id,
      senderId: customer.id,
      occurredAt,
      text,
      messageType: "conversation",
      triageKind: "unclassified",
      triageState: "unreviewed",
      ingestionSource: "realtime_notify",
    }).id;
  const addStaff = (id: string, occurredAt: string, text: string) =>
    store.upsertMessage({
      id,
      externalId: `staff-${id}`,
      groupId: group.id,
      senderId: staff.id,
      occurredAt,
      text,
      messageType: "conversation",
      ingestionSource: "realtime_notify",
    }).id;

  return { database, store, groupId: group.id, addExternal, addStaff };
}

test("social isolado é reversível e vira contexto do bloco quando a demanda chega em até dois minutos", () => {
  const current = fixture();
  const greeting = current.addExternal(
    "greeting",
    "2026-07-17T12:00:00.000Z",
    "Bom dia, pessoal",
  );
  const demand = current.addExternal(
    "demand",
    "2026-07-17T12:00:40.000Z",
    "Não estamos conseguindo integrar a Loja Fictícia Ômega",
  );
  const detail = current.addExternal(
    "detail",
    "2026-07-17T12:01:30.000Z",
    "Esse é o cliente",
  );

  const social = current.store.collapseTriageMessage(greeting, {
    kind: "social",
    reason: "Saudação isolada",
  });
  assert.equal(social.state, "ignored");
  assert.equal(current.store.listConversationTriageBlocks(current.groupId).items.length, 0);

  const block = current.store.recordTriageSuggestion(demand, {
    kind: "demand",
    suggestedAction: "create",
    suggestedTicketId: null,
    title: "Falha na integração da Loja Fictícia Ômega",
    summary: "Cliente não consegue integrar a Loja Fictícia Ômega.",
    confidence: 0.86,
    reason: "Demanda explícita",
    affectedStoreId: null,
    actor: "triage",
  });
  current.store.recordTriageSuggestion(detail, {
    kind: "uncertain",
    suggestedAction: "create",
    suggestedTicketId: null,
    title: "Detalhe da integração",
    summary: "Esse é o cliente",
    confidence: 0.5,
    reason: "Fragmento adjacente",
    affectedStoreId: null,
    actor: "triage",
  });

  const pending = current.store.listConversationTriageBlocks(current.groupId).items;
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.id, block.id);
  assert.deepEqual(pending[0]?.messageIds, [greeting, demand, detail]);
  assert.equal(pending[0]?.suggestedAction, "create");
  assert.equal(current.store.listTriageCandidates().length, 0);
  assert.deepEqual(
    current.database
      .prepare("SELECT id, triage_state FROM messages ORDER BY occurred_at")
      .all(),
    [
      { id: greeting, triage_state: "unreviewed" },
      { id: demand, triage_state: "unreviewed" },
      { id: detail, triage_state: "unreviewed" },
    ],
  );
});

test("fila exibe somente sugestões com confiança igual ou superior a 90%", () => {
  const current = fixture();
  const belowThreshold = current.addExternal(
    "below-confidence-threshold",
    "2026-07-17T12:10:00.000Z",
    "Talvez exista uma divergência",
  );
  const atThreshold = current.addExternal(
    "at-confidence-threshold",
    "2026-07-17T12:13:00.000Z",
    "Os pedidos não aparecem no dashboard",
  );
  const aboveThreshold = current.addExternal(
    "above-confidence-threshold",
    "2026-07-17T12:16:00.000Z",
    "A integração retornou um erro confirmado",
  );

  const hidden = current.store.recordTriageSuggestion(belowThreshold, {
    kind: "uncertain",
    suggestedAction: "create",
    suggestedTicketId: null,
    title: "Possível divergência",
    summary: "A mensagem ainda não possui confiança suficiente.",
    confidence: 0.8999,
    reason: "Abaixo do limite visual",
    affectedStoreId: null,
  });
  const visibleAtThreshold = current.store.recordTriageSuggestion(atThreshold, {
    kind: "demand",
    suggestedAction: "create",
    suggestedTicketId: null,
    title: "Pedidos ausentes",
    summary: "Os pedidos não aparecem no dashboard.",
    confidence: 0.9,
    reason: "No limite visual",
    affectedStoreId: null,
  });
  const visibleAboveThreshold = current.store.recordTriageSuggestion(
    aboveThreshold,
    {
      kind: "demand",
      suggestedAction: "create",
      suggestedTicketId: null,
      title: "Erro de integração",
      summary: "A integração retornou um erro confirmado.",
      confidence: 0.97,
      reason: "Acima do limite visual",
      affectedStoreId: null,
    },
  );

  assert.deepEqual(
    current.store
      .listConversationTriageBlocks(current.groupId)
      .items.map((block) => block.id),
    [visibleAtThreshold.id, visibleAboveThreshold.id],
  );
  assert.deepEqual(
    current.store
      .getConversationMessages(current.groupId)
      .suggestedBlocks.map((block) => block.id),
    [visibleAtThreshold.id, visibleAboveThreshold.id],
  );
  assert.deepEqual(
    current.database
      .prepare(
        `SELECT id, confidence, state
         FROM triage_blocks ORDER BY first_message_at`,
      )
      .all(),
    [
      { id: hidden.id, confidence: 0.8999, state: "pending" },
      { id: visibleAtThreshold.id, confidence: 0.9, state: "pending" },
      { id: visibleAboveThreshold.id, confidence: 0.97, state: "pending" },
    ],
  );
});

test("criação confirmada aceita contexto staff e não inicia investigação automática", () => {
  const current = fixture();
  const first = current.addExternal(
    "first",
    "2026-07-17T13:00:00.000Z",
    "Os pedidos sumiram",
  );
  const staff = current.addStaff(
    "staff-context",
    "2026-07-17T13:00:20.000Z",
    "Vou verificar os pedidos.",
  );
  const second = current.addExternal(
    "second",
    "2026-07-17T13:00:40.000Z",
    "A loja é a Loja Fictícia Ômega",
  );

  const input = {
    messageIds: [first, staff, second],
    title: "Pedidos ausentes da Loja Fictícia Ômega",
    clientRequestId: "create-fictional-omega-1",
    actor: "Operador",
  };
  const created = current.store.createTicketFromConversation(current.groupId, input);
  const repeated = current.store.createTicketFromConversation(current.groupId, input);

  assert.equal(repeated.ticket?.id, created.ticket?.id);
  assert.equal(repeated.blockId, created.blockId);
  assert.equal(repeated.investigationJobId, created.investigationJobId);
  assert.equal(
    (current.database.prepare("SELECT COUNT(*) AS count FROM tickets").get() as { count: number }).count,
    1,
  );
  assert.equal(
    (current.database.prepare("SELECT COUNT(*) AS count FROM investigation_jobs").get() as { count: number }).count,
    0,
  );
  assert.deepEqual(
    current.database
      .prepare("SELECT id, triage_state FROM messages ORDER BY occurred_at")
      .all(),
    [
      { id: first, triage_state: "ticketed" },
      { id: staff, triage_state: "context" },
      { id: second, triage_state: "ticketed" },
    ],
  );
  assert.equal(created.ticket?.messageCount, 3);
});

test("seleção parcial recorta o bloco pendente e mantém somente as mensagens restantes", () => {
  const current = fixture();
  const first = current.addExternal(
    "partial-first",
    "2026-07-17T13:30:00.000Z",
    "A integração começou a falhar",
  );
  const selected = current.addExternal(
    "partial-selected",
    "2026-07-17T13:30:30.000Z",
    "A loja afetada é a Loja Fictícia Ômega",
  );
  const last = current.addExternal(
    "partial-last",
    "2026-07-17T13:31:00.000Z",
    "Também apareceu uma dúvida sobre o relatório",
  );
  for (const [messageId, title] of [
    [first, "Falha na integração"],
    [selected, "Loja afetada"],
    [last, "Dúvida sobre relatório"],
  ] as const) {
    current.store.recordTriageSuggestion(messageId, {
      kind: "demand",
      suggestedAction: "create",
      suggestedTicketId: null,
      title,
      summary: title,
      confidence: 0.95,
      reason: "Demanda explícita",
      affectedStoreId: null,
    });
  }

  const initial = current.store.listConversationTriageBlocks(current.groupId).items;
  assert.equal(initial.length, 1);
  assert.deepEqual(initial[0]?.messageIds, [first, selected, last]);

  current.store.createTicketFromConversation(current.groupId, {
    messageIds: [selected],
    clientRequestId: "partial-create-1",
  });

  const pending = current.store.listConversationTriageBlocks(current.groupId).items;
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0]?.messageIds, [first, last]);
  assert.equal(pending[0]?.summary.includes("Loja Fictícia Ômega"), false);
  assert.deepEqual(
    current.database
      .prepare("SELECT id, triage_state FROM messages ORDER BY occurred_at")
      .all(),
    [
      { id: first, triage_state: "unreviewed" },
      { id: selected, triage_state: "ticketed" },
      { id: last, triage_state: "unreviewed" },
    ],
  );
  const messages = current.store.getConversationMessages(current.groupId);
  assert.deepEqual(messages.suggestedBlocks[0]?.messageIds, [first, last]);
});

test("ignore e context rejeitam mensagens ticketed; restore afeta somente mensagens externas", () => {
  const current = fixture();
  const external = current.addExternal(
    "external",
    "2026-07-17T14:00:00.000Z",
    "Talvez seja um problema",
  );
  const staff = current.addStaff(
    "staff",
    "2026-07-17T14:00:20.000Z",
    "Mensagem interna",
  );
  current.store.ignoreConversationMessages(current.groupId, {
    messageIds: [external, staff],
    clientRequestId: "ignore-1",
  });
  current.store.restoreConversationMessages(current.groupId, {
    messageIds: [external, staff],
    clientRequestId: "restore-1",
  });
  assert.deepEqual(
    current.database
      .prepare("SELECT id, triage_kind, triage_state FROM messages ORDER BY occurred_at")
      .all(),
    [
      { id: external, triage_kind: "unclassified", triage_state: "unreviewed" },
      { id: staff, triage_kind: "context", triage_state: "context" },
    ],
  );

  current.store.createTicketFromConversation(current.groupId, {
    messageIds: [external],
    clientRequestId: "ticket-after-restore",
  });
  assert.throws(
    () =>
      current.store.ignoreConversationMessages(current.groupId, {
        messageIds: [external],
      }),
    ConflictError,
  );
  assert.equal(
    (current.database.prepare("SELECT triage_state FROM messages WHERE id = ?").get(external) as { triage_state: string }).triage_state,
    "ticketed",
  );
});

test("ação global mantém pendências como contexto sem apagar histórico ou bloquear mensagens futuras", () => {
  const current = fixture();
  const first = current.addExternal(
    "bulk-context-first",
    "2026-07-17T14:30:00.000Z",
    "Primeira pendência global",
  );
  const second = current.addExternal(
    "bulk-context-second",
    "2026-07-17T14:30:30.000Z",
    "Segunda pendência global",
  );
  current.store.recordTriageSuggestion(first, {
    kind: "demand",
    suggestedAction: "create",
    suggestedTicketId: null,
    title: "Pendência agrupada",
    summary: "Duas mensagens aguardam revisão.",
    confidence: 0.96,
    reason: "Teste da limpeza global",
    affectedStoreId: null,
  });
  current.store.recordTriageSuggestion(second, {
    kind: "continuation",
    suggestedAction: "create",
    suggestedTicketId: null,
    title: "Pendência agrupada",
    summary: "Duas mensagens aguardam revisão.",
    confidence: 0.96,
    reason: "Teste da limpeza global",
    affectedStoreId: null,
    suggestionGroupId: current.store
      .listConversationTriageBlocks(current.groupId, true)
      .items[0]!.id,
  });

  assert.equal(current.store.listConversations().pendingTotal, 2);
  const cleared = current.store.contextualizePendingMessages({
    actor: "Operador",
  });

  assert.deepEqual(cleared, {
    contextualizedMessageCount: 2,
    conversationCount: 1,
    resolvedBlockCount: 1,
  });
  assert.equal(current.store.listConversations().pendingTotal, 0);
  assert.deepEqual(
    current.database
      .prepare("SELECT id, triage_state FROM messages ORDER BY occurred_at")
      .all(),
    [
      { id: first, triage_state: "context" },
      { id: second, triage_state: "context" },
    ],
  );
  assert.equal(
    current.store.listConversationTriageBlocks(current.groupId).items.length,
    0,
  );

  current.addExternal(
    "bulk-context-future",
    "2026-07-17T14:31:00.000Z",
    "Nova mensagem depois da limpeza",
  );
  assert.equal(current.store.listConversations().pendingTotal, 1);
});

test("ação por conversa mantém somente suas pendências como contexto", () => {
  const current = fixture();
  const selectedMessage = current.addExternal(
    "conversation-context-selected",
    "2026-07-17T14:40:00.000Z",
    "Pendência da conversa selecionada",
  );
  const otherGroup = current.store.upsertGroup({
    id: "conversation-other",
    accountId: "account",
    clientId: "client",
    externalJid: "120363000100@g.us",
    subject: "Outro grupo",
  });
  current.store.addGroupParticipant(otherGroup.id, "customer");
  const otherMessage = current.store.upsertMessage({
    id: "conversation-context-other",
    externalId: "external-conversation-context-other",
    groupId: otherGroup.id,
    senderId: "customer",
    occurredAt: "2026-07-17T14:40:30.000Z",
    text: "Pendência de outra conversa",
    messageType: "conversation",
    triageKind: "unclassified",
    triageState: "unreviewed",
    ingestionSource: "realtime_notify",
  }).id;

  const contextualized = current.store.contextualizePendingMessages({
    actor: "Operador",
    conversationId: current.groupId,
  });

  assert.deepEqual(contextualized, {
    contextualizedMessageCount: 1,
    conversationCount: 1,
    resolvedBlockCount: 0,
  });
  assert.deepEqual(
    current.database
      .prepare("SELECT id, triage_state FROM messages ORDER BY occurred_at")
      .all(),
    [
      { id: selectedMessage, triage_state: "context" },
      { id: otherMessage, triage_state: "unreviewed" },
    ],
  );
  assert.equal(current.store.listConversations().pendingTotal, 1);
});

test("API lista conversa completa paginada e cria ticket em lote", async () => {
  const current = fixture();
  const first = current.addExternal(
    "api-first",
    "2026-07-17T15:00:00.000Z",
    "Erro na integração",
  );
  const second = current.addExternal(
    "api-second",
    "2026-07-17T15:00:30.000Z",
    "É a Loja Fictícia Ômega",
  );
  const app = createTestApiApp(current.store);

  const list = await app.request("/api/conversations?limit=10");
  assert.equal(list.status, 200);
  assert.equal(((await list.json()) as { items: unknown[] }).items.length, 1);

  const page = await app.request(
    `/api/conversations/${current.groupId}/messages?limit=1`,
  );
  assert.equal(page.status, 200);
  const firstPage = (await page.json()) as {
    items: Array<{ id: string }>;
    nextCursor: string | null;
    hasMore: boolean;
  };
  assert.equal(firstPage.items.length, 1);
  assert.equal(firstPage.hasMore, true);
  assert.ok(firstPage.nextCursor);

  const create = await app.request(
    `/api/conversations/${current.groupId}/triage/tickets`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messageIds: [first, second],
        clientRequestId: "api-create-1",
      }),
    },
  );
  assert.equal(create.status, 201);
  const result = (await create.json()) as {
    ticket: { messageCount: number };
    investigationJobId: string | null;
  };
  assert.equal(result.ticket.messageCount, 2);
  assert.equal(result.investigationJobId, null);

  const linkedTickets = await app.request(
    `/api/conversations/${current.groupId}/tickets?limit=1&status=triage`,
  );
  assert.equal(linkedTickets.status, 200);
  const linkedTicketsBody = (await linkedTickets.json()) as {
    items: Array<{ id: string; status: string }>;
    total: number;
    summary: { all: number; active: number; resolved: number; cancelled: number; archived: number };
    nextCursor: string | null;
    hasMore: boolean;
  };
  assert.equal(linkedTicketsBody.total, 1);
  assert.equal(linkedTicketsBody.items.length, 1);
  assert.equal(linkedTicketsBody.items[0]?.status, "triage");
  assert.deepEqual(linkedTicketsBody.summary, {
    all: 1,
    active: 1,
    resolved: 0,
    cancelled: 0,
    archived: 0,
  });
  assert.equal(linkedTicketsBody.nextCursor, null);
  assert.equal(linkedTicketsBody.hasMore, false);

  current.addExternal(
    "api-clear-all",
    "2026-07-17T15:01:00.000Z",
    "Pendência para limpar pela API",
  );
  const keepConversation = await app.request(
    `/api/conversations/${current.groupId}/triage/context-all`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  assert.equal(keepConversation.status, 200);
  assert.deepEqual(await keepConversation.json(), {
    contextualizedMessageCount: 1,
    conversationCount: 1,
    resolvedBlockCount: 0,
  });

  current.addExternal(
    "api-context-all",
    "2026-07-17T15:01:30.000Z",
    "Outra pendência para manter globalmente",
  );
  const keepAll = await app.request("/api/conversations/triage/context-all", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(keepAll.status, 200);
  assert.deepEqual(await keepAll.json(), {
    contextualizedMessageCount: 1,
    conversationCount: 1,
    resolvedBlockCount: 0,
  });
  const refreshedList = await app.request("/api/conversations?limit=10");
  assert.equal(refreshedList.status, 200);
  assert.equal(
    ((await refreshedList.json()) as { pendingTotal: number }).pendingTotal,
    0,
  );
});

test("API filtra conversas globalmente e rejeita cursor reutilizado com outros filtros", async () => {
  const current = fixture();
  current.addExternal(
    "group-search",
    "2026-07-17T16:00:00.000Z",
    "Falha na integração da loja principal",
  );
  const directClient = current.store.upsertClient({
    id: "direct-client",
    name: "Contato Direto",
    slug: "contato-direto",
    kind: "ecommerce",
  });
  const direct = current.store.upsertGroup({
    id: "direct-conversation",
    accountId: "account",
    clientId: directClient.id,
    externalJid: "5511888888888@s.whatsapp.net",
    subject: "Contato Direto",
  });
  const participant = current.store.upsertParticipant({
    id: "direct-participant",
    externalJid: "5511888888888@s.whatsapp.net",
    displayName: "Pessoa Individual",
  });
  current.store.addGroupParticipant(direct.id, participant.id);
  current.store.upsertMessage({
    id: "direct-search",
    externalId: "external-direct-search",
    groupId: direct.id,
    senderId: participant.id,
    occurredAt: "2026-07-17T16:01:00.000Z",
    text: "Tenho uma dúvida individual sobre cobrança",
    messageType: "conversation",
    triageKind: "unclassified",
    triageState: "unreviewed",
    ingestionSource: "realtime_notify",
  });
  const app = createTestApiApp(current.store);

  const filtered = await app.request(
    "/api/conversations?scope=direct&attention=pending&q=individual&limit=10",
  );
  assert.equal(filtered.status, 200);
  const filteredBody = (await filtered.json()) as {
    items: Array<{ id: string; scope: string }>;
    total: number;
  };
  assert.equal(filteredBody.total, 1);
  assert.deepEqual(filteredBody.items.map((item) => item.id), [direct.id]);
  assert.equal(filteredBody.items[0]?.scope, "direct");

  const firstPage = await app.request("/api/conversations?limit=1");
  assert.equal(firstPage.status, 200);
  const firstPageBody = (await firstPage.json()) as { nextCursor: string | null };
  assert.ok(firstPageBody.nextCursor);
  const invalidReuse = await app.request(
    `/api/conversations?limit=1&q=outro&cursor=${encodeURIComponent(firstPageBody.nextCursor!)}`,
  );
  assert.equal(invalidReuse.status, 400);
});

test("silenciar sugestões preserva histórico e tickets manuais sem reabrir pendências antigas", async () => {
  const current = fixture();
  const messageId = current.addExternal(
    "mute-message",
    "2026-07-17T17:00:00.000Z",
    "Precisamos verificar a integração",
  );
  current.store.recordTriageSuggestion(messageId, {
    kind: "demand",
    suggestedAction: "create",
    suggestedTicketId: null,
    title: "Verificar integração",
    summary: "Precisamos verificar a integração",
    confidence: 0.82,
    reason: "no_candidate",
    affectedStoreId: null,
  });

  const muted = current.store.setConversationSuggestionsMuted(current.groupId, {
    muted: true,
    actor: "Operador",
  });
  assert.equal(muted.conversation.suggestionsMuted, true);
  assert.equal(muted.conversation.pendingCount, 0);
  assert.equal(muted.contextualizedMessageCount, 1);
  assert.equal(muted.resolvedBlockCount, 1);
  assert.equal(current.store.listConversationTriageBlocks(current.groupId).items.length, 0);
  assert.equal(current.store.listTriageCandidates().length, 0);
  assert.throws(
    () => current.store.restoreConversationMessages(current.groupId, {
      messageIds: [messageId],
    }),
    ConflictError,
  );

  const manualTicket = current.store.createTicketFromConversation(current.groupId, {
    messageIds: [messageId],
    title: "Ticket criado manualmente",
  });
  assert.ok(manualTicket.ticket);
  assert.equal(manualTicket.ticket?.messageCount, 1);

  const racedMessage = current.addExternal(
    "mute-race",
    "2026-07-17T17:01:00.000Z",
    "Mensagem selecionada pelo worker antes do silenciamento",
  );
  const raced = current.store.recordTriageSuggestion(racedMessage, {
    kind: "uncertain",
    suggestedAction: "create",
    suggestedTicketId: null,
    title: "Mensagem em corrida",
    summary: "Mensagem em corrida",
    confidence: 0.35,
    reason: "no_candidate",
    affectedStoreId: null,
  });
  assert.equal(raced.state, "context");
  assert.equal(current.store.listConversationTriageBlocks(current.groupId).items.length, 0);
  assert.equal(
    (current.database.prepare("SELECT triage_state FROM messages WHERE id = ?").get(racedMessage) as { triage_state: string }).triage_state,
    "context",
  );

  const app = createTestApiApp(current.store);
  const resumed = await app.request(
    `/api/conversations/${current.groupId}/suggestion-settings`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ muted: false, actor: "Operador" }),
    },
  );
  assert.equal(resumed.status, 200);
  const resumedBody = (await resumed.json()) as {
    conversation: { suggestionsMuted: boolean; pendingCount: number };
  };
  assert.equal(resumedBody.conversation.suggestionsMuted, false);
  assert.equal(resumedBody.conversation.pendingCount, 0);

  const future = current.addExternal(
    "after-resume",
    "2026-07-17T17:02:00.000Z",
    "Agora há um novo problema",
  );
  assert.deepEqual(current.store.listTriageCandidates().map((item) => item.id), [future]);
});
