import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { createDatabase, type SupportDatabase } from "../server/db/index.js";
import type {
  InvestigationTurnResult,
  SupportAnalysis,
} from "../server/agent/types.js";
import { SupportStore } from "../server/domain/index.js";

const databases: SupportDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture() {
  const database = createDatabase(":memory:");
  databases.push(database);
  const store = new SupportStore(database);
  const account = store.upsertAccount({
    id: "reply-flow-account",
    phoneNumber: "+5547999999999",
    displayName: "Conta local",
  });
  const client = store.upsertClient({
    id: "reply-flow-client",
    name: "Organização de teste",
    slug: "organizacao-reply-flow",
    kind: "agency",
  });
  const group = store.upsertGroup({
    id: "reply-flow-group",
    accountId: account.id,
    clientId: client.id,
    externalJid: "120363000031@g.us",
    subject: "Conversa de teste",
  });
  const external = store.upsertParticipant({
    id: "reply-flow-external",
    externalJid: "5547888888888@s.whatsapp.net",
    phoneE164: "+5547888888888",
    displayName: "Cliente",
  });
  const staff = store.upsertParticipant({
    id: "reply-flow-staff",
    externalJid: "5547999999999@s.whatsapp.net",
    phoneE164: "+5547999999999",
    displayName: "Suporte",
  });
  store.setStaffMember(staff.id, "Suporte");
  store.addGroupParticipant(group.id, external.id);
  store.addGroupParticipant(group.id, staff.id);

  let messageSequence = 0;
  function message(input: {
    senderId?: string;
    occurredAt: string;
    text: string;
    quotedExternalId?: string | null;
  }) {
    messageSequence += 1;
    return store.upsertMessage({
      id: `reply-flow-message-${messageSequence}`,
      externalId: `reply-flow-external-${messageSequence}`,
      providerMessageId: `reply-flow-provider-${messageSequence}`,
      groupId: group.id,
      senderId: input.senderId ?? external.id,
      occurredAt: input.occurredAt,
      text: input.text,
      messageType: "text",
      triageKind: "demand",
      quotedExternalId: input.quotedExternalId ?? null,
    });
  }

  function ticket(input: {
    id: string;
    occurredAt: string;
    title?: string;
    summary?: string;
    categoryId?: string;
    affectedStoreId?: string;
  }) {
    const source = message({
      occurredAt: input.occurredAt,
      text: input.summary ?? "Cliente relata pedidos ausentes.",
    });
    return store.createTicket({
      id: input.id,
      groupId: group.id,
      sourceMessageId: source.id,
      affectedStoreId: input.affectedStoreId,
      title: input.title ?? "Pedidos ausentes",
      summary: input.summary ?? "Cliente relata pedidos ausentes.",
      categories: input.categoryId
        ? [{ categoryId: input.categoryId, source: "manual" }]
        : [],
      createdAt: input.occurredAt,
    });
  }

  return { database, store, client, group, external, staff, message, ticket };
}

function analysis(
  overrides: Partial<SupportAnalysis> = {},
): SupportAnalysis {
  return {
    createTicket: true,
    outcome: "reply_ready",
    relation: "new",
    relatedTicketId: null,
    title: "Pedidos ausentes",
    summary: "Cliente relata pedidos ausentes.",
    affectedEcommerce: null,
    priority: "normal",
    categories: {
      contactReason: ["Problema"],
      productArea: ["Pedidos"],
      platform: [],
      symptom: ["Pedidos ausentes"],
    },
    evidence: [],
    suggestedResponse: "Estamos verificando os pedidos informados.",
    missingInformation: [],
    nextAction: "Revisar e copiar a resposta sugerida.",
    confidence: 0.9,
    ...overrides,
  };
}

function threadResult(
  overrides: Partial<InvestigationTurnResult> = {},
): InvestigationTurnResult {
  return {
    assistantMessage: "A investigação foi concluída com as evidências disponíveis.",
    phase: "conclusion",
    threadSummary: "Investigação concluída.",
    evidence: [],
    suggestedResponse: "Estamos verificando os pedidos informados.",
    nextAction: "Acompanhar o processamento.",
    confidence: 0.9,
    toolRequests: [],
    ...overrides,
  };
}

test("contexto separa demanda sem resposta, respostas enviadas e precedentes validados", () => {
  const current = fixture();
  const sharedCategory = current.store.upsertCategory({
    id: "reply-flow-shared-category",
    facet: "symptom",
    slug: "pedidos-ausentes",
    label: "Pedidos ausentes",
  });
  const otherCategory = current.store.upsertCategory({
    id: "reply-flow-other-category",
    facet: "symptom",
    slug: "dados-incorretos",
    label: "Dados incorretos",
  });
  const primaryStore = current.store.upsertStore({
    id: "reply-flow-primary-store",
    clientId: current.client.id,
    name: "Loja principal",
  });
  const otherStore = current.store.upsertStore({
    id: "reply-flow-other-store",
    clientId: current.client.id,
    name: "Outra loja",
  });

  const sharedPrecedent = current.ticket({
    id: "reply-flow-precedent-shared",
    occurredAt: "2026-07-18T10:00:00.000Z",
    title: "Integração deixou de importar pedidos",
    summary: "Pedidos não chegaram após renovar a integração.",
    categoryId: sharedCategory.id,
    affectedStoreId: primaryStore.id,
  });
  current.store.recordSentResponse({
    ticketId: sharedPrecedent.id,
    body: "Reconectamos a conta e os pedidos voltaram a processar.",
    sentAt: "2026-07-18T10:20:00.000Z",
  });
  current.store.updateTicketStatus(sharedPrecedent.id, {
    status: "resolved",
    actor: "Operador",
    resolution: {
      summary: "A conta foi reconectada e a fila voltou a processar.",
      rootCause: "Token expirado",
      outcome: "Processamento normalizado",
      validatedBy: "Operador",
    },
  });

  const recentPrecedent = current.ticket({
    id: "reply-flow-precedent-recent",
    occurredAt: "2026-07-20T10:00:00.000Z",
    title: "Dashboard com valor divergente",
    summary: "Valor divergente no dashboard.",
    categoryId: otherCategory.id,
  });
  current.store.updateTicketStatus(recentPrecedent.id, {
    status: "resolved",
    actor: "Operador",
    resolution: {
      summary: "O filtro de período foi corrigido.",
      validatedBy: "Operador",
    },
  });

  const otherStorePrecedent = current.ticket({
    id: "reply-flow-precedent-other-store",
    occurredAt: "2026-07-20T11:00:00.000Z",
    title: "Pedidos ausentes em outra loja",
    summary: "Incidente específico de outra loja da mesma agência.",
    categoryId: sharedCategory.id,
    affectedStoreId: otherStore.id,
  });
  current.store.updateTicketStatus(otherStorePrecedent.id, {
    status: "resolved",
    actor: "Operador",
    resolution: {
      summary: "A outra loja foi reconectada.",
      validatedBy: "Operador",
    },
  });

  const ticket = current.ticket({
    id: "reply-flow-current-ticket",
    occurredAt: "2026-07-21T10:00:00.000Z",
    categoryId: sharedCategory.id,
    affectedStoreId: primaryStore.id,
  });
  current.store.recordSentResponse({
    ticketId: ticket.id,
    body: "Vou verificar os pedidos para você.",
    sentAt: "2026-07-21T10:05:00.000Z",
  });
  const followUp = current.message({
    occurredAt: "2026-07-21T10:10:00.000Z",
    text: "Consegue verificar também o pedido 123?",
  });
  current.store.attachMessageToTicket(ticket.id, followUp.id);

  const context = current.store.getInvestigationContext(ticket.id);

  assert.deepEqual(context.conversationState, {
    lastExternalMessageAt: "2026-07-21T10:10:00.000Z",
    lastSentResponseAt: "2026-07-21T10:05:00.000Z",
    unansweredExternalMessageIds: [followUp.id],
    hasUnansweredExternalMessages: true,
  });
  assert.deepEqual(context.sentResponses, [
    {
      id: context.sentResponses[0]?.id,
      messageId: null,
      body: "Vou verificar os pedidos para você.",
      sentAt: "2026-07-21T10:05:00.000Z",
    },
  ]);
  assert.equal(context.resolvedPrecedents[0]?.ticketId, sharedPrecedent.id);
  assert.deepEqual(context.resolvedPrecedents[0]?.affectedStore, {
    id: primaryStore.id,
    name: "Loja principal",
  });
  assert.deepEqual(context.resolvedPrecedents[0]?.categories, ["Pedidos ausentes"]);
  assert.deepEqual(context.resolvedPrecedents[0]?.resolution, {
    summary: "A conta foi reconectada e a fila voltou a processar.",
    rootCause: "Token expirado",
    outcome: "Processamento normalizado",
    validatedAt: context.resolvedPrecedents[0]?.resolution.validatedAt,
  });
  assert.equal(
    context.resolvedPrecedents[0]?.finalResponse,
    "Reconectamos a conta e os pedidos voltaram a processar.",
  );
  assert.ok(
    context.resolvedPrecedents.some(
      (precedent) => precedent.ticketId === recentPrecedent.id,
    ),
  );
  assert.equal(
    context.resolvedPrecedents.some(
      (precedent) => precedent.ticketId === otherStorePrecedent.id,
    ),
    false,
  );
});

test("estado temporal desempata mensagens do mesmo segundo pela ordem persistida", () => {
  const current = fixture();
  const occurredAt = "2026-07-21T10:30:00.000Z";
  const ticket = current.ticket({
    id: "reply-flow-same-second-ticket",
    occurredAt,
  });
  const source = current.database
    .prepare("SELECT source_message_id FROM tickets WHERE id = ?")
    .get(ticket.id) as { source_message_id: string };
  const sourceProvider = current.database
    .prepare("SELECT provider_message_id FROM messages WHERE id = ?")
    .get(source.source_message_id) as { provider_message_id: string };
  const reply = current.message({
    senderId: current.staff.id,
    occurredAt,
    text: "Vou verificar este caso.",
    quotedExternalId: sourceProvider.provider_message_id,
  });
  current.store.captureStaffResponse(reply.id);
  const followUp = current.message({
    occurredAt,
    text: "Também confira o pedido 456.",
  });
  current.store.attachMessageToTicket(ticket.id, followUp.id);

  assert.deepEqual(
    current.store.getInvestigationContext(ticket.id).conversationState,
    {
      lastExternalMessageAt: occurredAt,
      lastSentResponseAt: occurredAt,
      unansweredExternalMessageIds: [followUp.id],
      hasUnansweredExternalMessages: true,
    },
  );
  assert.deepEqual(
    current.store
      .getInvestigationContext(ticket.id)
      .messages.map((message) => message.id),
    [source.source_message_id, reply.id, followUp.id],
  );

  const manualTicket = current.ticket({
    id: "reply-flow-same-second-manual-ticket",
    occurredAt: "2026-07-21T10:40:00.000Z",
  });
  current.store.recordSentResponse({
    ticketId: manualTicket.id,
    body: "Resposta registrada sem vínculo com uma mensagem.",
    sentAt: "2026-07-21T10:40:00.000Z",
  });
  assert.equal(
    current.store.getInvestigationContext(manualTicket.id).conversationState
      .hasUnansweredExternalMessages,
    true,
    "sem messageId não há ordem segura dentro do mesmo timestamp",
  );
});

test("timeline preserva a ordem de ingestão para mensagens do mesmo segundo", () => {
  const current = fixture();
  const occurredAt = "2026-07-21T10:50:00.000Z";
  const ticket = current.ticket({
    id: "reply-flow-timeline-order-ticket",
    occurredAt,
  });
  const source = current.database
    .prepare("SELECT source_message_id FROM tickets WHERE id = ?")
    .get(ticket.id) as { source_message_id: string };
  const first = current.store.upsertMessage({
    id: "zz-reply-flow-first-same-second",
    externalId: "reply-flow-first-same-second",
    providerMessageId: "reply-flow-provider-first-same-second",
    groupId: current.group.id,
    senderId: current.external.id,
    occurredAt,
    text: "Primeira mensagem do mesmo segundo.",
    messageType: "text",
    triageKind: "demand",
  });
  const second = current.store.upsertMessage({
    id: "aa-reply-flow-second-same-second",
    externalId: "reply-flow-second-same-second",
    providerMessageId: "reply-flow-provider-second-same-second",
    groupId: current.group.id,
    senderId: current.external.id,
    occurredAt,
    text: "Segunda mensagem do mesmo segundo.",
    messageType: "text",
    triageKind: "continuation",
  });
  current.store.attachMessageToTicket(ticket.id, first.id);
  current.store.attachMessageToTicket(ticket.id, second.id);

  assert.deepEqual(
    current.store
      .getTicketDetail(ticket.id)
      .timeline.filter((item) => item.type === "message")
      .map((item) => item.id),
    [source.source_message_id, first.id, second.id],
  );
});

test("roteamento de tópico usa a última mensagem real quando timestamps empatam", () => {
  const current = fixture();
  const ticket = current.ticket({
    id: "reply-flow-topic-order-ticket",
    occurredAt: "2026-07-21T10:55:00.000Z",
  });
  const secondExternal = current.store.upsertParticipant({
    id: "reply-flow-second-external",
    externalJid: "5547777777777@s.whatsapp.net",
    phoneE164: "+5547777777777",
    displayName: "Outra pessoa cliente",
  });
  current.store.addGroupParticipant(current.group.id, secondExternal.id);
  const occurredAt = "2026-07-21T10:56:00.000Z";
  const first = current.store.upsertMessage({
    id: "zz-reply-flow-topic-first",
    externalId: "reply-flow-topic-first",
    groupId: current.group.id,
    senderId: current.external.id,
    occurredAt,
    text: "Primeiro detalhe do problema.",
    messageType: "text",
  });
  const second = current.store.upsertMessage({
    id: "aa-reply-flow-topic-second",
    externalId: "reply-flow-topic-second",
    groupId: current.group.id,
    senderId: secondExternal.id,
    occurredAt,
    text: "Segundo detalhe do problema.",
    messageType: "text",
  });
  current.store.attachMessageToTicket(ticket.id, first.id);
  current.store.attachMessageToTicket(ticket.id, second.id);

  const candidate = current.store.listTopicTicketCandidates(
    current.group.id,
    "2026-07-21T10:50:00.000Z",
    "2026-07-21T11:00:00.000Z",
  )[0];
  assert.equal(candidate?.lastSenderId, secondExternal.id);
  assert.ok(
    (candidate?.topicText.indexOf("Primeiro detalhe") ?? -1) <
      (candidate?.topicText.indexOf("Segundo detalhe") ?? -1),
  );
});

test("resposta capturada e novo contexto supersedem sugestões candidatas", () => {
  const current = fixture();
  const ticket = current.ticket({
    id: "reply-flow-stale-ticket",
    occurredAt: "2026-07-21T11:00:00.000Z",
  });
  current.store.addSuggestion({
    id: "reply-flow-candidate-before-response",
    ticketId: ticket.id,
    body: "Resposta ainda não enviada.",
    confidence: 0.8,
  });
  const source = current.database
    .prepare("SELECT source_message_id FROM tickets WHERE id = ?")
    .get(ticket.id) as { source_message_id: string };
  const sourceProvider = current.database
    .prepare("SELECT provider_message_id FROM messages WHERE id = ?")
    .get(source.source_message_id) as { provider_message_id: string };
  const reply = current.message({
    senderId: current.staff.id,
    occurredAt: "2026-07-21T11:05:00.000Z",
    text: "Já respondi ao cliente.",
    quotedExternalId: sourceProvider.provider_message_id,
  });

  current.store.captureStaffResponse(reply.id);
  assert.equal(
    current.store
      .getTicketDetail(ticket.id)
      .suggestions.find((item) => item.id === "reply-flow-candidate-before-response")
      ?.status,
    "superseded",
  );

  current.store.addSuggestion({
    id: "reply-flow-candidate-before-context",
    ticketId: ticket.id,
    body: "Resposta baseada no contexto antigo.",
    confidence: 0.7,
  });
  current.store.queueInvestigation(ticket.id, undefined, {
    trigger: "context_changed",
  });
  assert.equal(
    current.store
      .getTicketDetail(ticket.id)
      .suggestions.find((item) => item.id === "reply-flow-candidate-before-context")
      ?.status,
    "superseded",
  );

  current.store.addSuggestion({
    id: "reply-flow-candidate-before-customer-message",
    ticketId: ticket.id,
    body: "Resposta anterior à nova mensagem do cliente.",
    confidence: 0.7,
  });
  current.store.queueInvestigation(ticket.id, undefined, {
    trigger: "new_customer_message",
  });
  assert.equal(
    current.store
      .getTicketDetail(ticket.id)
      .suggestions.find(
        (item) => item.id === "reply-flow-candidate-before-customer-message",
      )?.status,
    "superseded",
  );
});

test("mensagem da equipe anexada manualmente vira resposta enviada idempotente", () => {
  const current = fixture();
  const ticket = current.ticket({
    id: "reply-flow-manual-staff-attach-ticket",
    occurredAt: "2025-07-21T11:30:00.000Z",
  });
  current.store.addSuggestion({
    id: "reply-flow-before-manual-staff-attach",
    ticketId: ticket.id,
    body: "Minuta anterior ao envio real.",
    confidence: 0.8,
  });
  const staffMessage = current.message({
    senderId: current.staff.id,
    occurredAt: "2025-07-21T11:35:00.000Z",
    text: "Vou verificar esse pedido e retorno em seguida.",
  });

  current.store.attachMessageToTicket(ticket.id, staffMessage.id, "Operador");
  current.store.attachMessageToTicket(ticket.id, staffMessage.id, "Operador");

  const detail = current.store.getTicketDetail(ticket.id);
  assert.equal(detail.sentResponses.length, 1);
  assert.equal(detail.sentResponses[0]?.messageId, staffMessage.id);
  assert.equal(
    detail.suggestions.find(
      (item) => item.id === "reply-flow-before-manual-staff-attach",
    )?.status,
    "superseded",
  );
});

test("anexo em lote pela conversa registra resposta sem enfileirar análise automática", () => {
  const current = fixture();
  const ticket = current.ticket({
    id: "reply-flow-batch-staff-attach-ticket",
    occurredAt: "2025-07-21T11:36:00.000Z",
  });
  const staffMessage = current.message({
    senderId: current.staff.id,
    occurredAt: "2025-07-21T11:37:00.000Z",
    text: "Confirmei no grupo que vou investigar.",
  });

  const attached = current.store.attachConversationMessages(current.group.id, {
    messageIds: [staffMessage.id],
    ticketId: ticket.id,
    clientRequestId: "reply-flow-batch-staff-attach",
    actor: "Operador",
  });

  assert.equal(attached.ticket?.sentResponses.length, 1);
  assert.equal(attached.ticket?.sentResponses[0]?.messageId, staffMessage.id);
  assert.equal(
    (current.database
      .prepare(
        `SELECT COUNT(*) AS count FROM investigation_jobs
         WHERE ticket_id = ? AND state = 'queued'`,
      )
      .get(ticket.id) as { count: number }).count,
    0,
  );
});

test("captura repetida da mesma resposta não cria rerun e não altera captured_at", () => {
  const current = fixture();
  const ticket = current.ticket({
    id: "reply-flow-idempotent-capture-ticket",
    occurredAt: "2025-07-21T11:38:00.000Z",
  });
  const source = current.database
    .prepare(
      `SELECT message.provider_message_id
       FROM tickets ticket
       JOIN messages message ON message.id = ticket.source_message_id
       WHERE ticket.id = ?`,
    )
    .get(ticket.id) as { provider_message_id: string };
  const staffMessage = current.message({
    senderId: current.staff.id,
    occurredAt: "2025-07-21T11:39:00.000Z",
    text: "Vou investigar e retorno.",
    quotedExternalId: source.provider_message_id,
  });
  const queued = current.store.queueInvestigation(ticket.id);
  assert.equal(current.store.claimNextInvestigationJob()?.id, queued.jobId);

  assert.equal(current.store.captureStaffResponse(staffMessage.id)?.responseCaptured, true);
  const captured = current.database
    .prepare(
      `SELECT captured_at FROM sent_responses
       WHERE ticket_id = ? AND message_id = ?`,
    )
    .get(ticket.id, staffMessage.id) as { captured_at: string };
  assert.equal(current.store.captureStaffResponse(staffMessage.id)?.responseCaptured, true);

  assert.equal(
    (current.database
      .prepare(
        `SELECT captured_at FROM sent_responses
         WHERE ticket_id = ? AND message_id = ?`,
      )
      .get(ticket.id, staffMessage.id) as { captured_at: string }).captured_at,
    captured.captured_at,
  );
  assert.equal(
    (current.database
      .prepare(
        `SELECT COUNT(*) AS count FROM ticket_events
         WHERE ticket_id = ? AND event_type = 'investigation_rerun_requested'`,
      )
      .get(ticket.id) as { count: number }).count,
    0,
  );
});

test("captura histórica preserva minuta mais nova e só pede reanálise quando a invalida", () => {
  const current = fixture();
  const ticket = current.ticket({
    id: "reply-flow-historical-staff-ticket",
    occurredAt: "2025-07-21T11:30:00.000Z",
  });
  const source = current.database
    .prepare(
      `SELECT message.provider_message_id
       FROM tickets ticket
       JOIN messages message ON message.id = ticket.source_message_id
       WHERE ticket.id = ?`,
    )
    .get(ticket.id) as { provider_message_id: string };
  current.store.addSuggestion({
    id: "reply-flow-current-candidate",
    ticketId: ticket.id,
    body: "Conecte novamente a conta para atualizar os pedidos.",
    confidence: 0.9,
    createdAt: "2025-07-21T11:40:00.000Z",
  });
  const earlierReply = current.message({
    senderId: current.staff.id,
    occurredAt: "2025-07-21T11:35:00.000Z",
    text: "Vou verificar por aqui.",
    quotedExternalId: source.provider_message_id,
  });

  const preserved = current.store.captureHistoricalStaffResponse(earlierReply.id);

  assert.deepEqual(preserved, {
    ticketId: ticket.id,
    responseCaptured: true,
    reanalysisRequired: false,
  });
  assert.equal(
    current.store.getTicketDetail(ticket.id).suggestions.find(
      (suggestion) => suggestion.id === "reply-flow-current-candidate",
    )?.status,
    "candidate",
  );
  assert.equal(
    (current.database
      .prepare(
        `SELECT COUNT(*) AS count FROM investigation_jobs
         WHERE ticket_id = ?`,
      )
      .get(ticket.id) as { count: number }).count,
    0,
  );

  const copiedReply = current.message({
    senderId: current.staff.id,
    occurredAt: "2025-07-21T11:36:00.000Z",
    text: "Conecte novamente a conta para atualizar os pedidos.",
    quotedExternalId: source.provider_message_id,
  });
  const invalidated = current.store.captureHistoricalStaffResponse(copiedReply.id);

  assert.deepEqual(invalidated, {
    ticketId: ticket.id,
    responseCaptured: true,
    reanalysisRequired: true,
  });
  assert.equal(
    current.store.getTicketDetail(ticket.id).suggestions.find(
      (suggestion) => suggestion.id === "reply-flow-current-candidate",
    )?.status,
    "superseded",
  );

  current.store.addSuggestion({
    id: "reply-flow-next-candidate",
    ticketId: ticket.id,
    body: "Aguarde a sincronização terminar.",
    confidence: 0.9,
    createdAt: "2025-07-21T11:40:00.000Z",
  });
  const laterReply = current.message({
    senderId: current.staff.id,
    occurredAt: "2025-07-21T11:41:00.000Z",
    text: "A integração foi normalizada.",
    quotedExternalId: source.provider_message_id,
  });
  const invalidatedByTime = current.store.captureHistoricalStaffResponse(
    laterReply.id,
  );

  assert.equal(invalidatedByTime?.reanalysisRequired, true);
  assert.equal(
    current.store.getTicketDetail(ticket.id).suggestions.find(
      (suggestion) => suggestion.id === "reply-flow-next-candidate",
    )?.status,
    "superseded",
  );
  assert.equal(
    (current.database
      .prepare(
        `SELECT COUNT(*) AS count FROM investigation_jobs
         WHERE ticket_id = ?`,
      )
      .get(ticket.id) as { count: number }).count,
    0,
  );
});

test("captura histórica no mesmo instante da candidata segue o corte temporal da UI", () => {
  const current = fixture();
  const ticket = current.ticket({
    id: "reply-flow-historical-staff-same-time-ticket",
    occurredAt: "2025-07-21T12:00:00.000Z",
  });
  const source = current.database
    .prepare(
      `SELECT message.provider_message_id
       FROM tickets ticket
       JOIN messages message ON message.id = ticket.source_message_id
       WHERE ticket.id = ?`,
    )
    .get(ticket.id) as { provider_message_id: string };
  current.store.addSuggestion({
    id: "reply-flow-same-time-candidate",
    ticketId: ticket.id,
    body: "Minuta ainda não enviada.",
    confidence: 0.9,
    createdAt: "2025-07-21T12:05:00.000Z",
  });
  const simultaneousReply = current.message({
    senderId: current.staff.id,
    occurredAt: "2025-07-21T12:05:00.000Z",
    text: "Resposta diferente enviada no mesmo segundo.",
    quotedExternalId: source.provider_message_id,
  });

  const result = current.store.captureHistoricalStaffResponse(
    simultaneousReply.id,
  );

  assert.equal(result?.reanalysisRequired, true);
  assert.equal(
    current.store.getTicketDetail(ticket.id).suggestions.find(
      (suggestion) => suggestion.id === "reply-flow-same-time-candidate",
    )?.status,
    "superseded",
  );
});

test("ACK e resposta final invalidam orientação legada sem reanálise automática", () => {
  const current = fixture();
  const ticket = current.ticket({
    id: "reply-flow-response-after-analysis-ticket",
    occurredAt: "2025-07-21T11:39:30.000Z",
  });
  const source = current.database
    .prepare(
      `SELECT message.provider_message_id
       FROM tickets ticket
       JOIN messages message ON message.id = ticket.source_message_id
       WHERE ticket.id = ?`,
    )
    .get(ticket.id) as { provider_message_id: string };
  const first = current.store.queueInvestigation(ticket.id);
  current.store.completeInvestigationJob(
    first.jobId,
    analysis({ suggestedResponse: "Minuta automática inicial." }),
  );
  const ack = current.message({
    senderId: current.staff.id,
    occurredAt: "2025-07-21T11:40:00.000Z",
    text: "Vou verificar.",
    quotedExternalId: source.provider_message_id,
  });

  current.store.captureStaffResponse(ack.id);
  const afterAck = current.store.getTicketDetail(ticket.id);
  assert.equal(
    afterAck.suggestions.find((item) => item.body === "Minuta automática inicial.")
      ?.status,
    "superseded",
  );
  assert.equal(
    (current.database
      .prepare(
        `SELECT COUNT(*) AS count FROM investigation_jobs
         WHERE ticket_id = ? AND state = 'queued'`,
      )
      .get(ticket.id) as { count: number }).count,
    0,
  );
  const finalResponse = current.message({
    senderId: current.staff.id,
    occurredAt: "2025-07-21T11:41:00.000Z",
    text: "Identificamos e corrigimos a causa.",
    quotedExternalId: source.provider_message_id,
  });

  current.store.captureStaffResponse(finalResponse.id);
  current.store.captureStaffResponse(finalResponse.id);

  const afterFinal = current.store.getTicketDetail(ticket.id);
  assert.equal(afterFinal.sentResponses.length, 2);
  assert.equal(
    (current.database
      .prepare(
        `SELECT COUNT(*) AS count FROM investigation_jobs
         WHERE ticket_id = ? AND state = 'queued'`,
      )
      .get(ticket.id) as { count: number }).count,
    0,
  );
});

test("anexo enviado pela equipe participa do estado temporal sem texto inventado", () => {
  const current = fixture();
  const ticket = current.ticket({
    id: "reply-flow-staff-attachment-ticket",
    occurredAt: "2025-07-21T11:40:00.000Z",
  });
  const attachmentMessage = current.message({
    senderId: current.staff.id,
    occurredAt: "2025-07-21T11:45:00.000Z",
    text: "",
  });
  current.store.upsertAttachment({
    id: "reply-flow-staff-attachment",
    messageId: attachmentMessage.id,
    kind: "image",
    mimeType: "image/png",
    fileName: "comprovante.png",
    localPath: "/tmp/threadmark/comprovante.png",
    sha256: "reply-flow-staff-attachment-sha",
  });

  current.store.attachMessageToTicket(
    ticket.id,
    attachmentMessage.id,
    "Operador",
  );

  const context = current.store.getInvestigationContext(ticket.id);
  assert.equal(context.conversationState.lastSentResponseAt, "2025-07-21T11:45:00.000Z");
  assert.equal(context.conversationState.hasUnansweredExternalMessages, false);
  assert.equal(context.sentResponses.length, 0);
  assert.deepEqual(
    current.database
      .prepare(
        `SELECT json_extract(data_json, '$.responseKind') AS responseKind
         FROM ticket_events
         WHERE ticket_id = ? AND event_type = 'staff_response_captured'`,
      )
      .get(ticket.id),
    { responseKind: "attachment" },
  );
});

test("anexo da equipe baixado após a captura completa a resposta uma única vez", () => {
  const current = fixture();
  const ticket = current.ticket({
    id: "reply-flow-late-staff-attachment-ticket",
    occurredAt: "2025-07-21T11:46:00.000Z",
  });
  const source = current.database
    .prepare(
      `SELECT message.provider_message_id
       FROM tickets ticket
       JOIN messages message ON message.id = ticket.source_message_id
       WHERE ticket.id = ?`,
    )
    .get(ticket.id) as { provider_message_id: string };
  const attachmentMessage = current.message({
    senderId: current.staff.id,
    occurredAt: "2025-07-21T11:47:00.000Z",
    text: "",
    quotedExternalId: source.provider_message_id,
  });
  current.store.upsertAttachment({
    id: "reply-flow-late-staff-attachment",
    messageId: attachmentMessage.id,
    kind: "image",
    mimeType: "image/png",
    localPath: "unavailable://reply-flow-late-staff-attachment",
    sha256: "pending-reply-flow-late-staff-attachment",
    sourceKey: "reply-flow-late-staff-attachment-source",
    available: false,
  });
  const queued = current.store.queueInvestigation(ticket.id);
  assert.equal(current.store.claimNextInvestigationJob()?.id, queued.jobId);
  assert.equal(
    current.store.captureStaffResponse(attachmentMessage.id)?.responseCaptured,
    false,
  );

  const availableAttachment = {
    id: "reply-flow-late-staff-attachment",
    messageId: attachmentMessage.id,
    kind: "image" as const,
    mimeType: "image/png",
    fileName: "evidencia.png",
    localPath: "/tmp/threadmark/evidencia.png",
    sha256: "reply-flow-late-staff-attachment-sha",
    sourceKey: "reply-flow-late-staff-attachment-source",
    available: true,
  };
  current.store.upsertAttachment(availableAttachment);
  current.store.upsertAttachment(availableAttachment);

  assert.equal(
    current.store.getInvestigationContext(ticket.id).conversationState
      .lastSentResponseAt,
    "2025-07-21T11:47:00.000Z",
  );
  assert.equal(
    (current.database
      .prepare(
        `SELECT COUNT(*) AS count FROM ticket_events
         WHERE ticket_id = ? AND event_type = 'staff_response_captured'`,
      )
      .get(ticket.id) as { count: number }).count,
    1,
  );
  assert.equal(
    (current.database
      .prepare(
        `SELECT COUNT(*) AS count FROM ticket_events
         WHERE ticket_id = ? AND event_type = 'investigation_rerun_requested'`,
      )
      .get(ticket.id) as { count: number }).count,
    0,
  );
});

test("desvincular resposta enviada invalida contexto sem enfileirar análise automática", () => {
  const current = fixture();
  const ticket = current.ticket({
    id: "reply-flow-detach-response-ticket",
    occurredAt: "2025-07-21T11:50:00.000Z",
  });
  const staffMessage = current.message({
    senderId: current.staff.id,
    occurredAt: "2025-07-21T11:55:00.000Z",
    text: "O pedido foi reprocessado.",
  });
  current.store.attachMessageToTicket(ticket.id, staffMessage.id, "Operador");
  current.store.addSuggestion({
    id: "reply-flow-before-detach",
    ticketId: ticket.id,
    body: "Não deveria sobreviver ao novo contexto.",
    confidence: 0.7,
  });

  const detail = current.store.detachMessageFromTicket(
    ticket.id,
    staffMessage.id,
    "Operador",
  );

  assert.equal(detail.sentResponses.length, 0);
  assert.equal(
    detail.suggestions.find((item) => item.id === "reply-flow-before-detach")
      ?.status,
    "superseded",
  );
  assert.equal(
    (current.database
      .prepare(
        `SELECT COUNT(*) AS count FROM investigation_jobs
         WHERE ticket_id = ? AND state = 'queued'`,
      )
      .get(ticket.id) as { count: number }).count,
    0,
  );
});

test("resolver durante investigação cancela job e descarta conclusão tardia", () => {
  const current = fixture();
  const ticket = current.ticket({
    id: "reply-flow-resolve-running-ticket",
    occurredAt: "2025-07-21T12:00:00.000Z",
  });
  current.store.addSuggestion({
    id: "reply-flow-before-resolution",
    ticketId: ticket.id,
    body: "Minuta que deve ser encerrada com o ticket.",
    confidence: 0.8,
  });
  const queued = current.store.queueInvestigation(ticket.id);
  assert.equal(current.store.claimNextInvestigationJob()?.id, queued.jobId);

  current.store.updateTicketStatus(ticket.id, {
    status: "resolved",
    actor: "Operador",
    resolution: {
      summary: "O pedido voltou a processar.",
      validatedBy: "Operador",
    },
  });
  const afterResolution = current.store.completeInvestigationJob(
    queued.jobId,
    analysis({ suggestedResponse: "Resultado tardio que não pode aparecer." }),
  );

  assert.equal(afterResolution.status, "resolved");
  assert.equal(
    afterResolution.suggestions.some(
      (item) => item.body === "Resultado tardio que não pode aparecer.",
    ),
    false,
  );
  assert.equal(
    afterResolution.suggestions.find(
      (item) => item.id === "reply-flow-before-resolution",
    )?.status,
    "superseded",
  );
  assert.deepEqual(
    current.database
      .prepare(
        `SELECT state, error FROM investigation_jobs WHERE id = ?`,
      )
      .get(queued.jobId),
    {
      state: "failed",
      error: "Ticket resolvido; investigação automática cancelada.",
    },
  );
  assert.throws(
    () => current.store.queueInvestigation(ticket.id),
    /resolvidos ou arquivados/i,
  );
});

test("minuta duplicada é suprimida sem promover o ticket para já respondido", () => {
  const current = fixture();
  const ticket = current.ticket({
    id: "reply-flow-already-answered-ticket",
    occurredAt: "2026-07-21T12:00:00.000Z",
  });
  current.store.recordSentResponse({
    ticketId: ticket.id,
    body: "Os pedidos já foram reprocessados e estão disponíveis.",
    sentAt: "2026-07-21T12:05:00.000Z",
  });
  current.store.addSuggestion({
    id: "reply-flow-old-candidate",
    ticketId: ticket.id,
    body: "Sugestão anterior.",
    confidence: 0.6,
  });
  const queued = current.store.queueInvestigation(ticket.id);

  const detail = current.store.completeInvestigationJob(
    queued.jobId,
    analysis({
      suggestedResponse: "Os pedidos já foram reprocessados e estão disponíveis.",
      missingInformation: ["ID de outro pedido"],
    }),
  );

  assert.equal(
    detail.latestInvestigation?.outcome,
    "technical_investigation_required",
  );
  assert.equal(detail.latestInvestigation?.suggestedResponse, null);
  assert.deepEqual(detail.latestInvestigation?.missingInformation, [
    "ID de outro pedido",
  ]);
  assert.match(detail.latestInvestigation?.nextAction ?? "", /minuta repete/i);
  assert.equal(
    detail.suggestions.find((item) => item.id === "reply-flow-old-candidate")?.status,
    "superseded",
  );
  assert.equal(
    detail.suggestions.filter((item) => item.status === "candidate").length,
    0,
  );

  const rerun = current.store.queueInvestigation(ticket.id);
  const withoutSuggestion = current.store.completeInvestigationJob(
    rerun.jobId,
    analysis({
      outcome: "technical_investigation_required",
      suggestedResponse: null,
      nextAction: "Consultar o banco novamente.",
    }),
  );
  assert.equal(
    withoutSuggestion.latestInvestigation?.outcome,
    "technical_investigation_required",
  );
  assert.equal(
    withoutSuggestion.latestInvestigation?.nextAction,
    "Consultar o banco novamente.",
  );
});

test("already_answered só é preservado com resposta coerente e sem demanda pendente", () => {
  const current = fixture();
  const answered = current.ticket({
    id: "reply-flow-model-answered-ticket",
    occurredAt: "2026-07-21T12:06:00.000Z",
  });
  current.store.recordSentResponse({
    ticketId: answered.id,
    body: "Os pedidos foram reprocessados e o cliente recebeu a confirmação.",
    sentAt: "2026-07-21T12:07:00.000Z",
  });
  const answeredJob = current.store.queueInvestigation(answered.id);
  const validated = current.store.completeInvestigationJob(
    answeredJob.jobId,
    analysis({
      outcome: "already_answered",
      suggestedResponse: null,
      missingInformation: [],
      nextAction: "Acompanhar apenas se o cliente retornar.",
    }),
  );
  assert.equal(validated.latestInvestigation?.outcome, "already_answered");
  assert.equal(
    validated.latestInvestigation?.nextAction,
    "Acompanhar apenas se o cliente retornar.",
  );

  const unanswered = current.ticket({
    id: "reply-flow-invalid-answered-ticket",
    occurredAt: "2026-07-21T12:08:00.000Z",
  });
  const unansweredJob = current.store.queueInvestigation(unanswered.id);
  const degraded = current.store.completeInvestigationJob(
    unansweredJob.jobId,
    analysis({
      outcome: "already_answered",
      suggestedResponse: null,
      missingInformation: [],
      nextAction: "Não responder.",
    }),
  );
  assert.equal(
    degraded.latestInvestigation?.outcome,
    "technical_investigation_required",
  );
  assert.match(degraded.latestInvestigation?.nextAction ?? "", /não há evidência/i);
});

test("ack não elimina uma conclusão materialmente nova nem investigação técnica", () => {
  const current = fixture();
  const ticket = current.ticket({
    id: "reply-flow-ack-ticket",
    occurredAt: "2026-07-21T12:15:00.000Z",
  });
  current.store.recordSentResponse({
    ticketId: ticket.id,
    body: "Vou verificar.",
    sentAt: "2026-07-21T12:16:00.000Z",
  });
  const first = current.store.queueInvestigation(ticket.id);
  const concluded = current.store.completeInvestigationJob(
    first.jobId,
    analysis({
      suggestedResponse:
        "Identificamos um token expirado, reconectamos a conta e os pedidos voltaram.",
    }),
  );
  assert.equal(concluded.latestInvestigation?.outcome, "reply_ready");
  assert.equal(
    concluded.latestInvestigation?.suggestedResponse,
    "Identificamos um token expirado, reconectamos a conta e os pedidos voltaram.",
  );

  const rerun = current.store.queueInvestigation(ticket.id);
  const technical = current.store.completeInvestigationJob(
    rerun.jobId,
    analysis({
      outcome: "technical_investigation_required",
      suggestedResponse: null,
      nextAction: "Consultar os logs da integração.",
    }),
  );
  assert.equal(
    technical.latestInvestigation?.outcome,
    "technical_investigation_required",
  );
  assert.equal(
    technical.latestInvestigation?.nextAction,
    "Consultar os logs da integração.",
  );
});

test("dedupe conservador não confunde instruções opostas com a mesma resposta", () => {
  const current = fixture();
  const ticket = current.ticket({
    id: "reply-flow-negation-ticket",
    occurredAt: "2026-07-21T12:20:00.000Z",
  });
  current.store.recordSentResponse({
    ticketId: ticket.id,
    body: "Não remova a integração; apenas reconecte a conta.",
    sentAt: "2026-07-21T12:21:00.000Z",
  });
  const queued = current.store.queueInvestigation(ticket.id);
  const proposed =
    "Não reconecte a integração; apenas remova a conta.";

  const detail = current.store.completeInvestigationJob(
    queued.jobId,
    analysis({ suggestedResponse: proposed }),
  );

  assert.equal(detail.latestInvestigation?.outcome, "reply_ready");
  assert.equal(detail.latestInvestigation?.suggestedResponse, proposed);
  assert.equal(
    detail.suggestions.some(
      (suggestion) => suggestion.status === "candidate" && suggestion.body === proposed,
    ),
    true,
  );
});

test("minuta repetida não oculta uma nova mensagem externa pendente", () => {
  const current = fixture();
  const ticket = current.ticket({
    id: "reply-flow-new-demand-ticket",
    occurredAt: "2026-07-21T12:30:00.000Z",
  });
  current.store.recordSentResponse({
    ticketId: ticket.id,
    body: "Estamos verificando os pedidos informados.",
    sentAt: "2026-07-21T12:35:00.000Z",
  });
  const followUp = current.message({
    occurredAt: "2026-07-21T12:40:00.000Z",
    text: "Também preciso entender por que o pedido 999 foi duplicado.",
  });
  current.store.attachMessageToTicket(ticket.id, followUp.id);
  const queued = current.store.queueInvestigation(ticket.id);

  const detail = current.store.completeInvestigationJob(
    queued.jobId,
    analysis({
      suggestedResponse: "Estamos verificando os pedidos informados.",
      missingInformation: ["Identificador interno do pedido 999"],
    }),
  );

  assert.equal(
    detail.latestInvestigation?.outcome,
    "technical_investigation_required",
  );
  assert.equal(detail.latestInvestigation?.suggestedResponse, null);
  assert.deepEqual(detail.latestInvestigation?.missingInformation, [
    "Identificador interno do pedido 999",
  ]);
  assert.match(detail.latestInvestigation?.nextAction ?? "", /minuta repete/i);
});

test("conclusão stale é descartada sem criar rerun automático", () => {
  const current = fixture();
  const ticket = current.ticket({
    id: "reply-flow-rerun-race-ticket",
    occurredAt: "2026-07-21T12:50:00.000Z",
  });
  const first = current.store.queueInvestigation(ticket.id);
  const running = current.store.claimNextInvestigationJob();
  assert.equal(running?.id, first.jobId);

  const followUp = current.message({
    occurredAt: "2026-07-21T12:55:00.000Z",
    text: "Nova informação: o problema acontece somente no pedido 999.",
  });
  current.store.attachMessageToTicket(ticket.id, followUp.id);
  const coalesced = current.store.queueInvestigation(ticket.id, undefined, {
    trigger: "new_customer_message",
  });
  assert.equal(coalesced.jobId, first.jobId);
  current.store.addSuggestion({
    id: "reply-flow-current-context-candidate",
    ticketId: ticket.id,
    body: "Resposta válida baseada no pedido 999.",
    confidence: 0.95,
  });

  const detail = current.store.completeInvestigationJob(
    first.jobId,
    analysis({
      summary: "Resumo obsoleto anterior à nova informação.",
      evidence: [
        {
          source: "conversation",
          summary: "Evidência do snapshot antigo.",
          reference: "snapshot-antigo",
        },
      ],
      suggestedResponse: "Resposta obsoleta anterior ao pedido 999.",
      nextAction: "Copiar a resposta obsoleta.",
      confidence: 0.99,
    }),
  );

  assert.equal(
    detail.suggestions.find(
      (item) => item.id === "reply-flow-current-context-candidate",
    )?.status,
    "candidate",
  );
  assert.equal(
    detail.suggestions.some(
      (item) => item.body === "Resposta obsoleta anterior ao pedido 999.",
    ),
    false,
  );
  const staleResult = current.database
    .prepare("SELECT result_json FROM investigation_jobs WHERE id = ?")
    .get(first.jobId) as { result_json: string };
  const parsed = JSON.parse(staleResult.result_json) as SupportAnalysis;
  assert.equal(parsed.outcome, "technical_investigation_required");
  assert.equal(parsed.suggestedResponse, null);
  assert.equal(parsed.summary, "O contexto mudou durante a investigação e o resultado anterior foi descartado.");
  assert.deepEqual(parsed.evidence, []);
  assert.deepEqual(parsed.missingInformation, []);
  assert.equal(parsed.confidence, 0);
  assert.match(parsed.nextAction, /contexto mudou/i);
  assert.deepEqual(
    current.database
      .prepare(
        `SELECT state, COUNT(*) AS count
         FROM investigation_jobs WHERE ticket_id = ?
         GROUP BY state ORDER BY state`,
      )
      .all(ticket.id),
    [{ state: "completed", count: 1 }],
  );
});

test("resposta capturada durante job running impede publicação do resultado antigo", () => {
  const current = fixture();
  const ticket = current.ticket({
    id: "reply-flow-response-during-running-ticket",
    occurredAt: "2026-07-21T13:20:00.000Z",
  });
  const queued = current.store.queueInvestigation(ticket.id);
  assert.equal(current.store.claimNextInvestigationJob()?.id, queued.jobId);
  const source = current.database
    .prepare("SELECT source_message_id FROM tickets WHERE id = ?")
    .get(ticket.id) as { source_message_id: string };
  const sourceProvider = current.database
    .prepare("SELECT provider_message_id FROM messages WHERE id = ?")
    .get(source.source_message_id) as { provider_message_id: string };
  const reply = current.message({
    senderId: current.staff.id,
    occurredAt: "2026-07-21T13:25:00.000Z",
    text: "Vou verificar este caso antes de responder definitivamente.",
    quotedExternalId: sourceProvider.provider_message_id,
  });

  current.store.captureStaffResponse(reply.id);
  const runningJob = current.database
    .prepare(
      `SELECT state, started_at AS startedAt,
              rerun_requested AS rerunRequested
       FROM investigation_jobs WHERE id = ?`,
    )
    .get(queued.jobId) as {
    state: string;
    startedAt: string;
    rerunRequested: number;
  };
  assert.equal(runningJob.state, "running");
  assert.equal(runningJob.rerunRequested, 0);

  const changedAt = new Date(Date.parse(runningJob.startedAt) + 1_000).toISOString();
  current.database
    .prepare(
      `UPDATE investigation_jobs
       SET rerun_requested = 0, rerun_instructions = NULL
       WHERE id = ?`,
    )
    .run(queued.jobId);
  current.database
    .prepare(
      `UPDATE sent_responses SET captured_at = ?
       WHERE ticket_id = ? AND message_id = ?`,
    )
    .run(changedAt, ticket.id, reply.id);
  current.database
    .prepare(
      `UPDATE ticket_messages SET added_at = ?
       WHERE ticket_id = ? AND message_id = ?`,
    )
    .run(changedAt, ticket.id, reply.id);

  const detail = current.store.completeInvestigationJob(
    queued.jobId,
    analysis({
      suggestedResponse:
        "Identificamos a causa e você deve reconectar a conta agora.",
    }),
  );
  assert.equal(
    detail.suggestions.some(
      (item) =>
        item.status === "candidate" &&
        item.body === "Identificamos a causa e você deve reconectar a conta agora.",
    ),
    false,
  );
  assert.deepEqual(
    current.database
      .prepare(
        `SELECT state, COUNT(*) AS count
         FROM investigation_jobs WHERE ticket_id = ?
         GROUP BY state ORDER BY state`,
      )
      .all(ticket.id),
    [{ state: "completed", count: 1 }],
  );
});

test("anexo atualizado durante job invalida a minuta sem enfileirar nova análise", () => {
  const current = fixture();
  const ticket = current.ticket({
    id: "reply-flow-attachment-race-ticket",
    occurredAt: "2025-07-21T13:28:00.000Z",
  });
  const source = current.database
    .prepare("SELECT source_message_id FROM tickets WHERE id = ?")
    .get(ticket.id) as { source_message_id: string };
  current.store.upsertAttachment({
    id: "reply-flow-attachment-race",
    messageId: source.source_message_id,
    kind: "image",
    mimeType: "image/png",
    fileName: "erro.png",
    localPath: "/tmp/threadmark/erro.png",
    sha256: "reply-flow-attachment-race-sha",
    sourceKey: "reply-flow-attachment-race-source",
    extractedText: null,
  });
  const queued = current.store.queueInvestigation(ticket.id);
  assert.equal(current.store.claimNextInvestigationJob()?.id, queued.jobId);
  const running = current.database
    .prepare("SELECT started_at FROM investigation_jobs WHERE id = ?")
    .get(queued.jobId) as { started_at: string };
  current.database
    .prepare("UPDATE investigation_jobs SET started_at = ? WHERE id = ?")
    .run(
      new Date(Date.parse(running.started_at) - 1_000).toISOString(),
      queued.jobId,
    );
  current.store.upsertAttachment({
    id: "reply-flow-attachment-race",
    messageId: source.source_message_id,
    kind: "image",
    mimeType: "image/png",
    fileName: "erro.png",
    localPath: "/tmp/threadmark/erro.png",
    sha256: "reply-flow-attachment-race-sha",
    sourceKey: "reply-flow-attachment-race-source",
    extractedText: "Erro de token expirado",
  });

  const detail = current.store.completeInvestigationJob(
    queued.jobId,
    analysis({
      suggestedResponse: "Reconecte a conta com base no anexo antigo.",
    }),
  );

  assert.equal(
    detail.suggestions.some(
      (item) => item.body === "Reconecte a conta com base no anexo antigo.",
    ),
    false,
  );
  const persisted = current.database
    .prepare("SELECT result_json FROM investigation_jobs WHERE id = ?")
    .get(queued.jobId) as { result_json: string };
  assert.equal(
    (JSON.parse(persisted.result_json) as SupportAnalysis).outcome,
    "technical_investigation_required",
  );
  assert.deepEqual(
    current.database
      .prepare(
        `SELECT state, COUNT(*) AS count
         FROM investigation_jobs WHERE ticket_id = ?
         GROUP BY state ORDER BY state`,
      )
      .all(ticket.id),
    [{ state: "completed", count: 1 }],
  );
});

test("OCR tardio invalida orientação legada sem enfileirar análise automática", () => {
  const current = fixture();
  const ticket = current.ticket({
    id: "reply-flow-late-ocr-ticket",
    occurredAt: "2025-07-21T13:28:30.000Z",
  });
  const source = current.database
    .prepare("SELECT source_message_id FROM tickets WHERE id = ?")
    .get(ticket.id) as { source_message_id: string };
  const queued = current.store.queueInvestigation(ticket.id);
  current.store.completeInvestigationJob(
    queued.jobId,
    analysis({ suggestedResponse: "Minuta anterior ao conteúdo do print." }),
  );
  const attachment = {
    id: "reply-flow-late-ocr-attachment",
    messageId: source.source_message_id,
    kind: "image" as const,
    mimeType: "image/png",
    fileName: "erro.png",
    localPath: "/tmp/threadmark/late-ocr.png",
    sha256: "reply-flow-late-ocr-sha",
    sourceKey: "reply-flow-late-ocr-source",
    extractedText: "Token expirado no painel",
    available: true,
  };

  current.store.upsertAttachment(attachment);
  current.store.upsertAttachment(attachment);

  const detail = current.store.getTicketDetail(ticket.id);
  assert.equal(detail.nextAction, null);
  assert.equal(
    detail.suggestions.find(
      (item) => item.body === "Minuta anterior ao conteúdo do print.",
    )?.status,
    "superseded",
  );
  assert.equal(
    (current.database
      .prepare(
        `SELECT COUNT(*) AS count FROM investigation_jobs
         WHERE ticket_id = ? AND state = 'queued'`,
      )
      .get(ticket.id) as { count: number }).count,
    0,
  );
  assert.equal(
    (current.database
      .prepare(
        `SELECT COUNT(*) AS count FROM ticket_events
         WHERE ticket_id = ? AND event_type = 'investigation_queued'`,
      )
      .get(ticket.id) as { count: number }).count,
    1,
    "somente o job legado original permanece no histórico",
  );
});

test("replay idêntico de mensagem e anexo não invalida investigação em andamento", () => {
  const current = fixture();
  const ticket = current.ticket({
    id: "reply-flow-idempotent-replay-ticket",
    occurredAt: "2025-07-21T13:29:00.000Z",
  });
  const source = current.database
    .prepare(
      `SELECT id, external_id, provider_message_id, group_id, sender_id,
              occurred_at, text, message_type, quoted_external_id, updated_at
       FROM messages WHERE id = (
         SELECT source_message_id FROM tickets WHERE id = ?
       )`,
    )
    .get(ticket.id) as {
    id: string;
    external_id: string;
    provider_message_id: string | null;
    group_id: string;
    sender_id: string;
    occurred_at: string;
    text: string;
    message_type: string;
    quoted_external_id: string | null;
    updated_at: string;
  };
  current.store.upsertAttachment({
    id: "reply-flow-idempotent-attachment",
    messageId: source.id,
    kind: "image",
    mimeType: "image/png",
    fileName: "erro.png",
    localPath: "/tmp/threadmark/idempotent.png",
    sha256: "reply-flow-idempotent-sha",
    sourceKey: "reply-flow-idempotent-source",
    extractedText: "Erro já extraído",
  });
  const beforeAttachment = current.database
    .prepare("SELECT updated_at FROM attachments WHERE id = ?")
    .get("reply-flow-idempotent-attachment") as { updated_at: string };
  const queued = current.store.queueInvestigation(ticket.id);
  assert.equal(current.store.claimNextInvestigationJob()?.id, queued.jobId);

  current.store.upsertMessage({
    id: source.id,
    externalId: source.external_id,
    providerMessageId: source.provider_message_id,
    groupId: source.group_id,
    senderId: source.sender_id,
    occurredAt: source.occurred_at,
    text: source.text,
    messageType: source.message_type,
    quotedExternalId: source.quoted_external_id,
  });
  current.store.upsertAttachment({
    id: "reply-flow-idempotent-attachment",
    messageId: source.id,
    kind: "image",
    mimeType: "image/png",
    fileName: "erro.png",
    localPath: "/tmp/threadmark/idempotent.png",
    sha256: "reply-flow-idempotent-sha",
    sourceKey: "reply-flow-idempotent-source",
    extractedText: "Erro já extraído",
  });

  assert.equal(
    (current.database
      .prepare("SELECT updated_at FROM messages WHERE id = ?")
      .get(source.id) as { updated_at: string }).updated_at,
    source.updated_at,
  );
  assert.equal(
    (current.database
      .prepare("SELECT updated_at FROM attachments WHERE id = ?")
      .get("reply-flow-idempotent-attachment") as { updated_at: string }).updated_at,
    beforeAttachment.updated_at,
  );
  const detail = current.store.completeInvestigationJob(
    queued.jobId,
    analysis({ suggestedResponse: "Minuta válida após replay idêntico." }),
  );
  assert.equal(detail.latestInvestigation?.outcome, "reply_ready");
  assert.equal(
    detail.suggestions.some(
      (item) => item.body === "Minuta válida após replay idêntico.",
    ),
    true,
  );
  assert.equal(
    (current.database
      .prepare(
        `SELECT COUNT(*) AS count FROM investigation_jobs
         WHERE ticket_id = ? AND state = 'queued'`,
      )
      .get(ticket.id) as { count: number }).count,
    0,
  );
});

test("sugestões persistem o modelo realmente executado em cada fluxo", () => {
  const current = fixture();
  const automaticTicket = current.ticket({
    id: "reply-flow-real-automatic-model-ticket",
    occurredAt: "2025-07-21T12:40:00.000Z",
  });
  const automaticJob = current.store.queueInvestigation(automaticTicket.id);
  assert.equal(
    current.store.claimNextInvestigationJob()?.id,
    automaticJob.jobId,
  );
  current.database
    .prepare("UPDATE investigation_jobs SET ai_model = ? WHERE id = ?")
    .run("gpt-5-mini", automaticJob.jobId);
  current.store.completeInvestigationJob(
    automaticJob.jobId,
    analysis({ suggestedResponse: "Minuta criada pelo modelo automático real." }),
  );

  const automaticSuggestion = current.store
    .getTicketDetail(automaticTicket.id)
    .suggestions.find(
      (suggestion) =>
        suggestion.body === "Minuta criada pelo modelo automático real.",
  );
  assert.equal(automaticSuggestion?.model, "gpt-5-mini");
  assert.equal(automaticSuggestion?.promptVersion, "support-analysis-v2");

  const deepTicket = current.ticket({
    id: "reply-flow-real-deep-model-ticket",
    occurredAt: "2025-07-21T12:50:00.000Z",
  });
  const thread = current.store.getOrCreateInvestigationThread(deepTicket.id);
  current.store.addInvestigationThreadMessage(thread.id, {
    body: "Investigue profundamente e prepare uma resposta.",
  });
  const deepJob = current.store.claimNextAgentJob();
  assert.equal(deepJob?.kind, "thread_turn");
  if (!deepJob || deepJob.kind !== "thread_turn") {
    assert.fail("turno profundo não reivindicado");
  }
  current.database
    .prepare("UPDATE investigation_thread_jobs SET ai_model = ? WHERE id = ?")
    .run("claude-sonnet-4", deepJob.id);
  current.store.completeInvestigationThreadJob(
    deepJob.id,
    threadResult({
      suggestedResponse: "Minuta criada pelo modelo profundo real.",
    }),
  );

  const deepSuggestion = current.store
    .getTicketDetail(deepTicket.id)
    .suggestions.find(
      (suggestion) =>
        suggestion.body === "Minuta criada pelo modelo profundo real.",
    );
  assert.equal(deepSuggestion?.model, "claude-sonnet-4");
  assert.equal(deepSuggestion?.promptVersion, "investigation-thread-v1");
});

test("sala profunda preserva a conclusão mas não republica resposta já enviada", () => {
  const current = fixture();
  const ticket = current.ticket({
    id: "reply-flow-thread-ticket",
    occurredAt: "2025-07-21T13:00:00.000Z",
  });
  current.store.recordSentResponse({
    ticketId: ticket.id,
    body: "Estamos verificando os pedidos informados.",
    sentAt: "2025-07-21T13:05:00.000Z",
  });
  const followUp = current.message({
    occurredAt: "2025-07-21T13:10:00.000Z",
    text: "Enquanto isso, confirme a causa no banco.",
  });
  current.store.attachMessageToTicket(ticket.id, followUp.id);

  const thread = current.store.getOrCreateInvestigationThread(ticket.id);
  current.store.addInvestigationThreadMessage(thread.id, {
    body: "Confirme tecnicamente a causa, sem repetir o que já foi enviado.",
  });
  const claimed = current.store.claimNextAgentJob();
  assert.equal(claimed?.kind, "thread_turn");
  if (!claimed || claimed.kind !== "thread_turn") assert.fail("turno não reivindicado");

  const completed = current.store.completeInvestigationThreadJob(
    claimed.id,
    threadResult(),
  );

  assert.equal(completed.status, "concluded");
  assert.equal(completed.messages.at(-1)?.role, "assistant");
  assert.equal(
    completed.messages.at(-1)?.body,
    "A investigação foi concluída com as evidências disponíveis.",
  );
  assert.equal(completed.messages.at(-1)?.suggestedResponse, null);
  assert.equal(
    current.store
      .getTicketDetail(ticket.id)
      .suggestions.filter((item) => item.status === "candidate").length,
    0,
  );
});

test("conclusão profunda sem minuta invalida candidata automática anterior", () => {
  const current = fixture();
  const ticket = current.ticket({
    id: "reply-flow-deep-conclusion-without-draft-ticket",
    occurredAt: "2025-07-21T13:20:00.000Z",
  });
  current.store.addSuggestion({
    id: "reply-flow-automatic-candidate-before-deep",
    ticketId: ticket.id,
    body: "Minuta automática anterior à investigação profunda.",
    confidence: 0.7,
  });
  const thread = current.store.getOrCreateInvestigationThread(ticket.id);
  current.store.addInvestigationThreadMessage(thread.id, {
    body: "Conclua tecnicamente sem preparar uma resposta ao cliente.",
  });
  const claimed = current.store.claimNextAgentJob();
  assert.equal(claimed?.kind, "thread_turn");
  if (!claimed || claimed.kind !== "thread_turn") assert.fail("turno não reivindicado");

  const completed = current.store.completeInvestigationThreadJob(
    claimed.id,
    threadResult({ suggestedResponse: null }),
  );

  assert.equal(completed.status, "concluded");
  assert.equal(
    current.store
      .getTicketDetail(ticket.id)
      .suggestions.find(
        (item) => item.id === "reply-flow-automatic-candidate-before-deep",
      )?.status,
    "superseded",
  );
});

test("sala profunda preserva auditoria mas suprime minuta após mudança de contexto", () => {
  const current = fixture();
  const ticket = current.ticket({
    id: "reply-flow-stale-thread-ticket",
    occurredAt: "2025-07-21T13:30:00.000Z",
  });
  const thread = current.store.getOrCreateInvestigationThread(ticket.id);
  current.database
    .prepare("UPDATE investigation_threads SET summary = ? WHERE id = ?")
    .run("Checkpoint confiável anterior.", thread.id);
  current.store.addInvestigationThreadMessage(thread.id, {
    body: "Investigue a causa deste caso.",
  });
  const claimed = current.store.claimNextAgentJob();
  assert.equal(claimed?.kind, "thread_turn");
  if (!claimed || claimed.kind !== "thread_turn") assert.fail("turno não reivindicado");
  const running = current.database
    .prepare(
      "SELECT started_at FROM investigation_thread_jobs WHERE id = ?",
    )
    .get(claimed.id) as { started_at: string };
  const changedAt = new Date(Date.parse(running.started_at) + 1_000).toISOString();
  const followUp = current.message({
    occurredAt: "2025-07-21T13:35:00.000Z",
    text: "Nova informação recebida enquanto a sala investigava.",
  });
  current.store.attachMessageToTicket(ticket.id, followUp.id);
  current.database
    .prepare(
      `UPDATE ticket_messages SET added_at = ?
       WHERE ticket_id = ? AND message_id = ?`,
    )
    .run(changedAt, ticket.id, followUp.id);
  current.store.recordSentResponse({
    ticketId: ticket.id,
    body: "Avisei ao cliente que a nova informação será considerada.",
    sentAt: changedAt,
    capturedAt: changedAt,
  });

  const completed = current.store.completeInvestigationThreadJob(
    claimed.id,
    threadResult({
      assistantMessage: "Conclusão obsoleta do snapshot anterior.",
      threadSummary: "Resumo obsoleto do snapshot anterior.",
      evidence: [
        {
          source: "conversation",
          summary: "Evidência anterior.",
          reference: "mensagem-antiga",
        },
      ],
      suggestedResponse: "Minuta calculada antes da nova informação.",
    }),
  );

  assert.equal(completed.messages.at(-1)?.role, "assistant");
  assert.equal(
    completed.messages.at(-1)?.body,
    "O contexto do ticket mudou durante esta investigação. A conclusão anterior foi descartada; continue a análise considerando as mensagens, respostas e anexos atuais.",
  );
  assert.equal(completed.summary, "Checkpoint confiável anterior.");
  assert.deepEqual(completed.messages.at(-1)?.evidence, []);
  assert.equal(completed.messages.at(-1)?.suggestedResponse, null);
  assert.equal(completed.status, "active");
  assert.equal(completed.messages.at(-1)?.phase, "analysis");
  assert.match(completed.messages.at(-1)?.nextAction ?? "", /contexto mudou/i);
  const persistedTurn = current.database
    .prepare("SELECT result_json FROM investigation_thread_jobs WHERE id = ?")
    .get(claimed.id) as { result_json: string };
  const sanitizedTurn = JSON.parse(
    persistedTurn.result_json,
  ) as InvestigationTurnResult;
  assert.equal(sanitizedTurn.confidence, 0);
  assert.deepEqual(sanitizedTurn.evidence, []);
  assert.equal(sanitizedTurn.threadSummary, "Checkpoint confiável anterior.");
  assert.equal(
    current.store
      .getTicketDetail(ticket.id)
      .suggestions.filter((item) => item.status === "candidate").length,
    0,
  );
  const event = current.database
    .prepare(
      `SELECT data_json FROM ticket_events
       WHERE ticket_id = ? AND event_type = 'investigation_thread_turn_completed'
       ORDER BY occurred_at DESC, rowid DESC LIMIT 1`,
    )
    .get(ticket.id) as { data_json: string };
  assert.equal(
    (JSON.parse(event.data_json) as { staleCompletion?: boolean }).staleCompletion,
    true,
  );
});
