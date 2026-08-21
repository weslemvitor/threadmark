import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { createDatabase, migrateDatabase, type SupportDatabase } from "../server/db/index.js";
import { migrations } from "../server/db/schema.js";
import {
  ConflictError,
  SupportStore,
  ValidationError,
} from "../server/domain/index.js";
import { resolveConfiguredStaffIdentities } from "../server/runtime/staff-identities.js";

interface Fixture {
  database: SupportDatabase;
  store: SupportStore;
  clientId: string;
  groupId: string;
  storeId: string;
  externalParticipantId: string;
  staffParticipantId: string;
  externalMessageId: string;
  staffMessageId: string;
}

const databases: SupportDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

function fixture(): Fixture {
  const database = createDatabase(":memory:");
  databases.push(database);
  const store = new SupportStore(database);
  const account = store.upsertAccount({
    id: "account",
    phoneNumber: "+5548999999999",
    displayName: "Acme Comercial",
  });
  const client = store.upsertClient({
    id: "client",
    name: "Agência Teste",
    slug: "agencia-teste",
    kind: "agency",
  });
  const ecommerce = store.upsertStore({
    id: "store",
    clientId: client.id,
    name: "Loja Teste",
    businessId: "business-test",
    platform: "VTEX",
  });
  const group = store.upsertGroup({
    id: "group",
    accountId: account.id,
    clientId: client.id,
    externalJid: "120363000000@g.us",
    subject: "Acme + Agência Teste",
  });
  const external = store.upsertParticipant({
    id: "external",
    externalJid: "5511999999999@s.whatsapp.net",
    phoneE164: "+5511999999999",
    displayName: "Cliente",
  });
  const staff = store.upsertParticipant({
    id: "staff",
    externalJid: "5548999999999@s.whatsapp.net",
    phoneE164: "+5548999999999",
    displayName: "Operador",
  });
  store.setStaffMember(staff.id, "Operador");
  store.addGroupParticipant(group.id, external.id);
  store.addGroupParticipant(group.id, staff.id);

  const externalMessage = store.upsertMessage({
    id: "message-external",
    externalId: "wa-message-1",
    providerMessageId: "wa-provider-1",
    groupId: group.id,
    senderId: external.id,
    occurredAt: "2026-07-16T12:00:00.000Z",
    text: "Os pedidos não estão aparecendo.",
    messageType: "text",
    triageKind: "demand",
  });
  const staffMessage = store.upsertMessage({
    id: "message-staff",
    externalId: "wa-message-2",
    groupId: group.id,
    senderId: staff.id,
    occurredAt: "2026-07-16T12:05:00.000Z",
    text: "Vou verificar.",
    messageType: "text",
    triageKind: "demand",
  });

  return {
    database,
    store,
    clientId: client.id,
    groupId: group.id,
    storeId: ecommerce.id,
    externalParticipantId: external.id,
    staffParticipantId: staff.id,
    externalMessageId: externalMessage.id,
    staffMessageId: staffMessage.id,
  };
}

test("ticket manual é idempotente e não inventa mensagem de origem", () => {
  const current = fixture();
  const created = current.store.createManualTicket({
    clientRequestId: "manual-ticket-request-1",
    groupId: current.groupId,
    title: "Divergência identificada manualmente",
    summary: "Caso isolado registrado pelo suporte sem mensagem selecionada.",
    priority: "high",
    actor: "Operador",
  });
  const repeated = current.store.createManualTicket({
    clientRequestId: "manual-ticket-request-1",
    groupId: current.groupId,
    title: "Título que não deve duplicar",
    summary: "A repetição deve devolver o ticket original.",
    actor: "Operador",
  });

  assert.equal(repeated.id, created.id);
  assert.equal(created.messageCount, 0);
  assert.equal(created.requester, null);
  assert.equal(created.priority, "high");
  const stored = current.database
    .prepare("SELECT source_message_id, status, needs_review FROM tickets WHERE id = ?")
    .get(created.id) as {
      source_message_id: string | null;
      status: string;
      needs_review: number;
    };
  assert.equal(stored.source_message_id, null);
  assert.equal(stored.status, "triage");
  assert.equal(stored.needs_review, 0);
  const event = current.database
    .prepare("SELECT data_json FROM ticket_events WHERE ticket_id = ? AND event_type = 'ticket_created'")
    .get(created.id) as { data_json: string };
  const eventData = JSON.parse(event.data_json) as Record<string, unknown>;
  assert.equal(eventData.sourceMessageId, null);
  assert.equal(eventData.origin, "manual");
});

test("tickets da conversa usam cursor, busca e contadores por ciclo", () => {
  const current = fixture();
  const create = (id: string, title: string) =>
    current.store.createManualTicket({
      clientRequestId: `request-${id}`,
      groupId: current.groupId,
      title,
      summary: `Resumo de ${title}`,
      actor: "Operador",
    });

  create("ticket-conversation-1", "Primeiro ticket ativo");
  create("ticket-conversation-2", "Segundo ticket ativo");
  create("ticket-conversation-3", "Terceiro ticket ativo");
  const resolved = create("ticket-conversation-4", "Falha de integração resolvida");
  const archived = create("ticket-conversation-5", "Histórico arquivado");

  for (const ticket of [resolved, archived]) {
    current.store.updateTicketStatus(ticket.id, {
      status: "in_progress",
      actor: "Operador",
    });
    current.store.updateTicketStatus(ticket.id, {
      status: "resolved",
      actor: "Operador",
      resolution: {
        summary: "Demanda concluída.",
        outcome: "Cliente confirmou a solução.",
      },
    });
  }
  current.store.updateTicketStatus(archived.id, { status: "archived" });

  const activeStatuses = [
    "new",
    "triage",
    "in_progress",
    "waiting_customer",
    "blocked",
  ] as const;
  const firstPage = current.store.listConversationTickets(current.groupId, {
    statuses: [...activeStatuses],
    limit: 2,
  });

  assert.equal(firstPage.items.length, 2);
  assert.equal(firstPage.total, 3);
  assert.equal(firstPage.summary.all, 5);
  assert.equal(firstPage.summary.active, 3);
  assert.equal(firstPage.summary.resolved, 1);
  assert.equal(firstPage.summary.archived, 1);
  assert.equal(firstPage.hasMore, true);
  assert.ok(firstPage.nextCursor);

  const secondPage = current.store.listConversationTickets(current.groupId, {
    statuses: [...activeStatuses],
    limit: 2,
    cursor: firstPage.nextCursor ?? undefined,
  });
  assert.equal(secondPage.items.length, 1);
  assert.equal(secondPage.hasMore, false);
  assert.equal(
    new Set([...firstPage.items, ...secondPage.items].map((ticket) => ticket.id)).size,
    3,
  );

  const searched = current.store.listConversationTickets(current.groupId, {
    query: "integração",
  });
  assert.deepEqual(searched.items.map((ticket) => ticket.id), [resolved.id]);
  assert.throws(
    () =>
      current.store.listConversationTickets(current.groupId, {
        statuses: [...activeStatuses],
        query: "outro filtro",
        cursor: firstPage.nextCursor ?? undefined,
      }),
    ValidationError,
  );
});

test("metadados do ticket podem ser editados com solicitante válido e auditoria", () => {
  const current = fixture();
  const ticket = current.store.createManualTicket({
    clientRequestId: "manual-ticket-editable-metadata",
    groupId: current.groupId,
    title: "Título original",
    summary: "Descrição original.",
    priority: "normal",
    actor: "Operador",
  });

  const updated = current.store.updateTicketMetadata(
    ticket.id,
    {
      title: "Título revisado",
      summary: "Descrição completa revisada pelo suporte.",
      priority: "urgent",
      requesterId: current.externalParticipantId,
    },
    "Operador de teste",
  );

  assert.equal(updated.title, "Título revisado");
  assert.equal(updated.summary, "Descrição completa revisada pelo suporte.");
  assert.equal(updated.priority, "urgent");
  assert.equal(updated.requester?.id, current.externalParticipantId);
  assert.equal(updated.requesterOverrideId, current.externalParticipantId);
  assert.deepEqual(
    updated.requesterCandidates.map((candidate) => candidate.id),
    [current.externalParticipantId],
  );

  const stored = current.database
    .prepare(
      `SELECT title, summary, priority, requester_id
       FROM tickets WHERE id = ?`,
    )
    .get(ticket.id) as {
    title: string;
    summary: string;
    priority: string;
    requester_id: string | null;
  };
  assert.deepEqual(stored, {
    title: "Título revisado",
    summary: "Descrição completa revisada pelo suporte.",
    priority: "urgent",
    requester_id: current.externalParticipantId,
  });

  const event = updated.timeline.find(
    (item) =>
      item.type === "event" && item.eventType === "ticket_metadata_updated",
  );
  assert.ok(event && event.type === "event");
  assert.equal(
    event.description,
    "Operador de teste atualizou título, descrição, prioridade, solicitante do ticket.",
  );

  const automatic = current.store.updateTicketMetadata(
    ticket.id,
    {
      title: updated.title,
      summary: updated.summary,
      priority: updated.priority,
      requesterId: null,
    },
    "Operador de teste",
  );
  assert.equal(automatic.requesterOverrideId, null);
  assert.equal(automatic.requester, null);
});

test("edição do ticket rejeita equipe e pessoas fora da conversa como solicitante", () => {
  const current = fixture();
  const ticket = current.store.createManualTicket({
    clientRequestId: "manual-ticket-requester-guard",
    groupId: current.groupId,
    title: "Solicitante protegido",
    summary: "Valida as opções permitidas.",
    actor: "Operador",
  });
  const outsider = current.store.upsertParticipant({
    id: "outsider",
    externalJid: "5511888888888@s.whatsapp.net",
    phoneE164: "+5511888888888",
    displayName: "Pessoa de outro grupo",
  });

  for (const requesterId of [current.staffParticipantId, outsider.id]) {
    assert.throws(
      () =>
        current.store.updateTicketMetadata(ticket.id, {
          title: ticket.title,
          summary: ticket.summary,
          priority: ticket.priority,
          requesterId,
        }),
      ValidationError,
    );
  }
});

test("upsert de participante não rebaixa nome humano para fallback placeholder", () => {
  const database = createDatabase(":memory:");
  databases.push(database);
  const store = new SupportStore(database);
  const externalJid = "900000000000103@lid";
  const participant = store.upsertParticipant({
    id: "participant-with-human-name",
    externalJid,
    phoneE164: null,
    displayName: "Pessoa Fictícia Épsilon",
  });

  store.upsertParticipant({
    externalJid,
    phoneE164: null,
    displayName: "Participante 900000000000103",
  });

  assert.deepEqual(
    database
      .prepare(
        `SELECT id, display_name
         FROM participants
         WHERE external_jid = ?`,
      )
      .get(externalJid),
    {
      id: participant.id,
      display_name: "Pessoa Fictícia Épsilon",
    },
  );
});

test("edição manual do cliente e das lojas persiste sem apagar o histórico", () => {
  const current = fixture();
  const ticket = current.store.createTicket({
    id: "ticket-client-profile",
    groupId: current.groupId,
    sourceMessageId: current.externalMessageId,
    affectedStoreId: current.storeId,
    title: "Pedidos ausentes",
    summary: "Cliente relata pedidos ausentes.",
  });

  const updated = current.store.updateClientProfile(current.clientId, {
    name: "Agência Renomeada",
    kind: "agency",
    notes: "Nome validado manualmente pelo suporte.",
    stores: [
      {
        id: current.storeId,
        name: "Loja Principal",
        businessId: "business-main",
        platform: "VTEX",
      },
      {
        name: "Nova Loja",
        businessId: "business-new",
        platform: "Shopify",
      },
    ],
  });

  assert.equal(updated.name, "Agência Renomeada");
  assert.deepEqual(
    updated.stores.map((store) => store.name),
    ["Loja Principal", "Nova Loja"],
  );

  current.store.upsertClient({
    name: "Acme + Agência Teste",
    slug: "agencia-teste",
    kind: "ecommerce",
    notes: "Nome automático vindo do grupo.",
  });
  assert.equal(
    current.store.listClients().find((client) => client.id === current.clientId)?.name,
    "Agência Renomeada",
  );

  const newStore = updated.stores.find((store) => store.name === "Nova Loja");
  assert.ok(newStore);
  current.store.updateClientProfile(current.clientId, {
    name: "Agência Renomeada",
    kind: "agency",
    notes: "Nome validado manualmente pelo suporte.",
    stores: [{ ...newStore, name: "Nova Loja Atualizada" }],
  });

  const listed = current.store.listClients().find((client) => client.id === current.clientId);
  assert.deepEqual(listed?.stores.map((store) => store.name), ["Nova Loja Atualizada"]);
  assert.equal(current.store.getTicketDetail(ticket.id).affectedStore?.name, "Loja Principal");

  const secondMessage = current.store.upsertMessage({
    externalId: "wa-message-archived-store",
    groupId: current.groupId,
    senderId: current.externalParticipantId,
    occurredAt: "2026-07-16T13:00:00.000Z",
    text: "Outro problema.",
    messageType: "text",
    triageKind: "demand",
  });
  assert.throws(
    () =>
      current.store.createTicket({
        groupId: current.groupId,
        sourceMessageId: secondMessage.id,
        affectedStoreId: current.storeId,
        title: "Loja arquivada",
        summary: "Não deve aceitar loja arquivada em ticket novo.",
      }),
    /Loja não encontrad/,
  );
});

test("lista de clientes conta apenas pessoas ativas em grupos reais e unifica telefone e LID", () => {
  const current = fixture();
  const phoneJid = "5511999999999@s.whatsapp.net";
  const lidJid = "123456789012345@lid";
  const lidParticipant = current.store.upsertParticipant({
    id: "external-lid-alias",
    externalJid: lidJid,
    phoneE164: "+5511999999999",
    displayName: "Cliente pelo LID",
  });
  current.store.upsertIdentityLink({
    phoneJid,
    lidJid,
    source: "teste",
    observedAt: "2026-07-16T12:10:00.000Z",
  });
  current.store.addGroupParticipant(current.groupId, lidParticipant.id);

  const removed = current.store.upsertParticipant({
    id: "removed-participant",
    externalJid: "5511777777777@s.whatsapp.net",
    phoneE164: "+5511777777777",
    displayName: "Participante removido",
  });
  current.store.addGroupParticipant(current.groupId, removed.id);
  current.store.deactivateGroupParticipants(
    current.groupId,
    [removed.id],
    "2026-07-16T12:20:00.000Z",
  );

  const directConversation = current.store.upsertGroup({
    id: "direct-conversation",
    accountId: "account",
    clientId: current.clientId,
    externalJid: "5511666666666@s.whatsapp.net",
    subject: "Conversa privada",
    monitored: false,
  });
  const directParticipant = current.store.upsertParticipant({
    id: "direct-participant",
    externalJid: "5511666666666@s.whatsapp.net",
    phoneE164: "+5511666666666",
    displayName: "Contato privado",
  });
  current.store.addGroupParticipant(directConversation.id, directParticipant.id);

  const client = current.store
    .listClients()
    .find((item) => item.id === current.clientId);

  assert.equal(client?.participantCount, 2);
});

test("exclusão operacional oculta o cliente e preserva tickets e mensagens", () => {
  const current = fixture();
  const ticket = current.store.createTicket({
    id: "ticket-client-archive",
    groupId: current.groupId,
    sourceMessageId: current.externalMessageId,
    title: "Cliente que não deve ser monitorado",
    summary: "Contato removido da operação.",
  });

  const ignored = current.store.ignoreClient(current.clientId, {
    actor: "Operador",
    reason: "Contato sem relação com suporte",
  });

  assert.equal(ignored.id, current.clientId);
  assert.equal(ignored.alreadyIgnored, false);
  assert.equal(ignored.preserved.tickets, 1);
  assert.equal(ignored.preserved.messages, 2);
  assert.equal(current.store.listClients().some((client) => client.id === current.clientId), false);
  assert.equal(current.store.listTickets().total, 0);
  assert.equal(current.store.getTicketDetail(ticket.id).status, "new");
  assert.equal(
    (current.database.prepare("SELECT monitored FROM whatsapp_groups WHERE id = ?").get(current.groupId) as { monitored: number }).monitored,
    0,
  );
  assert.equal(
    (current.database.prepare("SELECT COUNT(*) AS count FROM messages WHERE group_id = ?").get(current.groupId) as { count: number }).count,
    2,
  );
  assert.equal(current.store.ignoreClient(current.clientId).alreadyIgnored, true);
});

test("exclusão permanente do ticket remove derivados e preserva mensagens sem recriação", () => {
  const current = fixture();
  const category = current.store.upsertCategory({
    id: "category-ticket-delete",
    facet: "reason",
    slug: "duvida-invalida",
    label: "Dúvida inválida",
  });
  const ticket = current.store.createTicket({
    id: "ticket-permanent-delete",
    groupId: current.groupId,
    sourceMessageId: current.externalMessageId,
    title: "Ticket criado indevidamente",
    summary: "A mensagem não deveria ter virado ticket.",
    categories: [{ categoryId: category.id, source: "manual" }],
  });
  current.store.attachMessageToTicket(ticket.id, current.staffMessageId, "Operador");
  current.store.upsertAttachment({
    id: "attachment-preserved-after-ticket-delete",
    messageId: current.externalMessageId,
    kind: "image",
    mimeType: "image/png",
    fileName: "evidencia.png",
    localPath: "/tmp/evidencia.png",
    sha256: "attachment-delete-ticket-sha",
  });
  current.store.addSuggestion({
    id: "suggestion-ticket-delete",
    ticketId: ticket.id,
    body: "Sugestão que deve ser removida.",
    confidence: 0.8,
  });
  current.store.recordSentResponse({
    id: "sent-response-ticket-delete",
    ticketId: ticket.id,
    body: "Resposta registrada que deve ser removida.",
    sentAt: "2026-07-16T12:15:00.000Z",
  });
  current.store.recordResolution({
    ticketId: ticket.id,
    summary: "Resolução derivada que deve ser removida.",
    validatedBy: "Operador",
  });
  current.database
    .prepare(
      `INSERT INTO evidence_queries
        (id, ticket_id, source, operation, parameters_json, success, created_at)
       VALUES (?, ?, 'sqlite', 'ticket_delete_test', '{}', 1, ?)`,
    )
    .run("evidence-ticket-delete", ticket.id, "2026-07-16T12:20:00.000Z");
  current.store.queueInvestigation(ticket.id);
  const thread = current.store.getOrCreateInvestigationThread(ticket.id);
  current.store.addInvestigationThreadMessage(thread.id, {
    body: "Investigue este ticket antes da exclusão.",
    clientMessageId: "delete-ticket-message",
  });
  const triageTimestamp = "2026-07-16T12:25:00.000Z";
  current.database
    .prepare(
      `INSERT INTO triage_blocks
        (id, group_id, sender_id, state, triage_kind, suggested_action,
         confirmed_ticket_id, title, summary, created_by,
         first_message_at, last_message_at, created_at, updated_at)
       VALUES (?, ?, ?, 'ticketed', 'demand', 'create', ?, ?, ?, 'triage', ?, ?, ?, ?)`,
    )
    .run(
      "block-ticket-delete-direct",
      current.groupId,
      current.externalParticipantId,
      ticket.id,
      "Bloco confirmado no ticket",
      "Vínculo direto que deve ser removido.",
      triageTimestamp,
      triageTimestamp,
      triageTimestamp,
      triageTimestamp,
    );
  current.database
    .prepare(
      `INSERT INTO triage_blocks
        (id, group_id, sender_id, state, triage_kind, suggested_action,
         title, summary, created_by,
         first_message_at, last_message_at, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 'uncertain', 'attach', ?, ?, 'triage', ?, ?, ?, ?)`,
    )
    .run(
      "block-ticket-delete-json",
      current.groupId,
      current.staffParticipantId,
      "Bloco com referência histórica",
      "UUID do ticket aparece somente no evento JSON.",
      triageTimestamp,
      triageTimestamp,
      triageTimestamp,
      triageTimestamp,
    );
  current.database
    .prepare(
      `INSERT INTO triage_block_messages
        (block_id, message_id, active, added_at, updated_at)
       VALUES (?, ?, 1, ?, ?), (?, ?, 1, ?, ?)`,
    )
    .run(
      "block-ticket-delete-direct",
      current.externalMessageId,
      triageTimestamp,
      triageTimestamp,
      "block-ticket-delete-json",
      current.staffMessageId,
      triageTimestamp,
      triageTimestamp,
    );
  current.database
    .prepare(
      `INSERT INTO triage_block_events
        (id, block_id, event_type, actor, message_ids_json, data_json, occurred_at)
       VALUES (?, ?, 'suggestion_recorded', 'triage', '[]', ?, ?)`,
    )
    .run(
      "event-ticket-delete-json",
      "block-ticket-delete-json",
      JSON.stringify({ suggestedTicketId: ticket.id }),
      triageTimestamp,
    );

  const result = current.store.deleteTicket(ticket.id, {
    actor: "Operador",
    reason: "Falso positivo da triagem",
  });

  assert.equal(result.id, ticket.id);
  assert.equal(result.actor, "Operador");
  assert.equal(result.reason, "Falso positivo da triagem");
  assert.equal(result.deleted.categories, 1);
  assert.equal(result.deleted.suggestions, 1);
  assert.equal(result.deleted.sentResponses, 2);
  assert.equal(result.deleted.resolutions, 1);
  assert.equal(result.deleted.evidenceQueries, 1);
  assert.equal(result.deleted.investigationJobs, 1);
  assert.equal(result.deleted.investigationThreads, 1);
  assert.equal(result.deleted.investigationThreadMessages, 1);
  assert.equal(result.deleted.investigationThreadJobs, 1);
  assert.equal(result.preserved.messages, 2);
  assert.equal(result.preserved.attachments, 1);

  for (const table of [
    "tickets",
    "ticket_messages",
    "ticket_events",
    "ticket_categories",
    "suggestions",
    "sent_responses",
    "resolutions",
    "evidence_queries",
    "investigation_jobs",
    "investigation_threads",
    "investigation_thread_messages",
    "investigation_thread_jobs",
    "triage_blocks",
    "triage_block_messages",
    "triage_block_events",
    "categories",
  ]) {
    const count = current.database
      .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
      .get() as { count: number };
    assert.equal(count.count, 0, `${table} deveria estar vazio`);
  }
  assert.equal(
    (current.database.prepare("SELECT COUNT(*) AS count FROM messages").get() as { count: number }).count,
    2,
  );
  assert.equal(
    (current.database.prepare("SELECT COUNT(*) AS count FROM attachments").get() as { count: number }).count,
    1,
  );
  assert.deepEqual(
    current.database
      .prepare("SELECT id, triage_kind, triage_state FROM messages ORDER BY id")
      .all(),
    [
      { id: current.externalMessageId, triage_kind: "demand", triage_state: "ignored" },
      { id: current.staffMessageId, triage_kind: "context", triage_state: "context" },
    ],
  );

  current.store.upsertMessage({
    id: current.externalMessageId,
    externalId: "wa-message-1",
    providerMessageId: "wa-provider-1",
    groupId: current.groupId,
    senderId: current.externalParticipantId,
    occurredAt: "2026-07-16T12:00:00.000Z",
    text: "Os pedidos não estão aparecendo.",
    messageType: "text",
    triageKind: "demand",
    triageState: "unreviewed",
  });
  assert.equal(
    (
      current.database
        .prepare("SELECT triage_state FROM messages WHERE id = ?")
        .get(current.externalMessageId) as { triage_state: string }
    ).triage_state,
    "ignored",
  );
  assert.equal(current.store.listTriageCandidates().length, 0);
  assert.throws(() => current.store.deleteTicket(ticket.id), /Ticket não encontrado/);
  assert.deepEqual(current.database.pragma("foreign_key_check"), []);
});

test("ticket privado pode ser associado a cliente e ecommerce existentes", () => {
  const current = fixture();
  const target = current.store.upsertClient({
    id: "target-client",
    name: "Agência Destino",
    slug: "agencia-destino",
    kind: "agency",
  });
  const targetStore = current.store.upsertStore({
    id: "target-store",
    clientId: target.id,
    name: "Loja Destino",
    businessId: "destination-business",
  });
  const ticket = current.store.createTicket({
    id: "ticket-context-association",
    groupId: current.groupId,
    sourceMessageId: current.externalMessageId,
    title: "Cliente ainda não identificado",
    summary: "Contato privado precisa ser associado.",
    status: "triage",
    needsReview: true,
  });

  const updated = current.store.updateTicketContext(ticket.id, {
    clientId: target.id,
    affectedStoreId: targetStore.id,
    rememberForConversation: true,
    actor: "Operador",
  });

  assert.equal(updated.client.id, target.id);
  assert.equal(updated.affectedStore?.id, targetStore.id);
  assert.equal(updated.needsReview, true);
  assert.equal(updated.latestInvestigation, null);
  assert.equal(
    (
      current.database
        .prepare(
          "SELECT client_id, client_link_source FROM whatsapp_groups WHERE id = ?",
        )
        .get(current.groupId) as {
        client_id: string;
        client_link_source: string;
      }
    ).client_id,
    target.id,
  );
  assert.equal(
    (
      current.database
        .prepare("SELECT client_link_source FROM whatsapp_groups WHERE id = ?")
        .get(current.groupId) as { client_link_source: string }
    ).client_link_source,
    "manual",
  );
  const contextEvent = updated.timeline.find(
    (item) => item.type === "event" && item.eventType === "ticket_context_changed",
  );
  assert.equal(contextEvent?.type, "event");
  if (contextEvent?.type !== "event") assert.fail("Evento de associação não encontrado");
  assert.match(contextEvent.description, /Agência Destino/);

  assert.throws(
    () =>
      current.store.updateTicketContext(ticket.id, {
        clientId: target.id,
        affectedStoreId: current.storeId,
        rememberForConversation: true,
      }),
    /ecommerce não pertence/i,
  );
});

test("migração inicial é idempotente", () => {
  const database = createDatabase(":memory:");
  databases.push(database);

  migrateDatabase(database);
  migrateDatabase(database);

  const migrationCount = database
    .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
    .get() as { count: number };
  assert.equal(migrationCount.count, migrations.length);
  assert.doesNotThrow(() => database.prepare("SELECT * FROM tickets LIMIT 1").all());
});

test("mensagem externa é deduplicada e mensagem de funcionário vira somente contexto", () => {
  const current = fixture();

  const duplicate = current.store.upsertMessage({
    id: "different-local-id",
    externalId: "wa-message-1",
    groupId: current.groupId,
    senderId: current.externalParticipantId,
    occurredAt: "2026-07-16T12:00:00.000Z",
    text: "Os pedidos não estão aparecendo desde ontem.",
    messageType: "text",
    triageKind: "demand",
  });

  assert.deepEqual(duplicate, { id: current.externalMessageId, inserted: false });
  const count = current.database
    .prepare("SELECT COUNT(*) AS count FROM messages WHERE external_id = 'wa-message-1'")
    .get() as { count: number };
  assert.equal(count.count, 1);

  const staffTriage = current.database
    .prepare("SELECT triage_kind, triage_state FROM messages WHERE id = ?")
    .get(current.staffMessageId) as { triage_kind: string; triage_state: string };
  assert.deepEqual(staffTriage, { triage_kind: "context", triage_state: "context" });
  assert.throws(
    () =>
      current.store.createTicket({
        groupId: current.groupId,
        sourceMessageId: current.staffMessageId,
        title: "Não deve existir",
        summary: "Funcionário não abre ticket.",
      }),
    ValidationError,
  );
});

test("reconciliação de equipe mantém somente configurados e a conta comercial", () => {
  const database = createDatabase(":memory:");
  databases.push(database);
  const store = new SupportStore(database);
  const configured = store.upsertParticipant({
    id: "staff-configured",
    externalJid: "5511900000004@s.whatsapp.net",
    phoneE164: "+5511900000004",
    displayName: "Operador Fictício Alfa",
  });
  const stale = store.upsertParticipant({
    id: "staff-stale",
    externalJid: "5511999999999@s.whatsapp.net",
    phoneE164: "+5511999999999",
    displayName: "Contato do cliente",
  });
  const self = store.upsertParticipant({
    id: "staff-self",
    externalJid: "self:commercial-account",
    displayName: "Acme Comercial",
  });
  store.setStaffMember(configured.id, "Operador Fictício Alfa");
  store.setStaffMember(stale.id, "Contato do cliente");
  store.setStaffMember(self.id, "Acme Comercial");

  assert.deepEqual(store.reconcileStaffMembers([configured.id]), {
    activated: 0,
    deactivated: 1,
    active: 2,
    restoredMessages: 0,
  });
  assert.deepEqual(
    database
      .prepare(
        `SELECT participant_id, active
         FROM staff_members
         ORDER BY participant_id`,
      )
      .all(),
    [
      { participant_id: configured.id, active: 1 },
      { participant_id: self.id, active: 1 },
      { participant_id: stale.id, active: 0 },
    ],
  );
});

test("reconciliação restaura somente notificações recentes suprimidas por staff antigo", () => {
  const current = fixture();
  const stale = current.store.upsertParticipant({
    id: "stale-realtime-staff",
    externalJid: "5511977777777@s.whatsapp.net",
    phoneE164: "+5511977777777",
    displayName: "Contato do cliente",
  });
  current.store.setStaffMember(stale.id, "Contato do cliente");
  current.store.addGroupParticipant(current.groupId, stale.id);
  current.store.upsertMessage({
    id: "stale-realtime-message",
    externalId: "stale-realtime-message",
    groupId: current.groupId,
    senderId: stale.id,
    occurredAt: "2026-07-17T18:00:00.000Z",
    text: "Os pedidos não apareceram.",
    messageType: "text",
    ingestionSource: "realtime_notify",
  });

  assert.deepEqual(
    current.store.reconcileStaffMembers([current.staffParticipantId]),
    {
      activated: 0,
      deactivated: 1,
      active: 1,
      restoredMessages: 1,
    },
  );
  assert.deepEqual(
    current.database
      .prepare(
        `SELECT triage_kind, triage_state
         FROM messages
         WHERE id = 'stale-realtime-message'`,
      )
      .get(),
    { triage_kind: "unclassified", triage_state: "unreviewed" },
  );
});

test("lista de equipe expande telefone configurado para aliases PN e LID", () => {
  const database = createDatabase(":memory:");
  databases.push(database);
  const store = new SupportStore(database);
  const phone = store.upsertParticipant({
    id: "staff-phone-alias",
    externalJid: "5511900000004@s.whatsapp.net",
    phoneE164: "+5511900000004",
    displayName: "Operador Fictício Alfa",
  });
  const lid = store.upsertParticipant({
    id: "staff-lid-alias",
    externalJid: "900000000000108@lid",
    phoneE164: "+5511900000004",
    displayName: "Operador Fictício Alfa",
  });
  store.upsertIdentityLink({
    phoneJid: "5511900000004@s.whatsapp.net",
    lidJid: "900000000000108@lid",
    source: "lid-mapping.update",
    observedAt: "2026-07-17T18:00:00.000Z",
  });

  const resolved = resolveConfiguredStaffIdentities(store, ["55 (11) 90000-0004"]);
  assert.deepEqual(new Set(resolved.participantIds), new Set([phone.id, lid.id]));
  assert.deepEqual(
    new Set(resolved.policyIdentities),
    new Set([
      "5511900000004@s.whatsapp.net",
      "900000000000108@lid",
    ]),
  );
});

test("criação de ticket é idempotente pela mensagem de origem", () => {
  const current = fixture();
  const first = current.store.createTicket({
    id: "ticket-first",
    groupId: current.groupId,
    sourceMessageId: current.externalMessageId,
    messageIds: [current.staffMessageId],
    affectedStoreId: current.storeId,
    title: "Pedidos ausentes",
    summary: "Cliente relata pedidos ausentes.",
  });
  const duplicate = current.store.createTicket({
    id: "ticket-duplicate",
    groupId: current.groupId,
    sourceMessageId: current.externalMessageId,
    title: "Outro título",
    summary: "Não deve criar outro ticket.",
  });

  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.messageCount, 2);
  const count = current.database
    .prepare("SELECT COUNT(*) AS count FROM tickets")
    .get() as { count: number };
  assert.equal(count.count, 1);
  assert.equal(current.store.listTriageCandidates().length, 0);
});

test("resposta manual de funcionário é capturada e vinculada pelo quoted message", () => {
  const current = fixture();
  const ticket = current.store.createTicket({
    id: "ticket-response-capture",
    groupId: current.groupId,
    sourceMessageId: current.externalMessageId,
    title: "Pedidos ausentes",
    summary: "Cliente relata pedidos ausentes.",
  });
  const reply = current.store.upsertMessage({
    id: "message-staff-reply",
    externalId: "wa-message-3",
    providerMessageId: "wa-provider-3",
    groupId: current.groupId,
    senderId: current.staffParticipantId,
    occurredAt: "2026-07-16T12:10:00.000Z",
    text: "Identifiquei a divergência e estou validando os IDs.",
    messageType: "text",
    quotedExternalId: "wa-provider-1",
  });

  assert.deepEqual(current.store.captureStaffResponse(reply.id), {
    ticketId: ticket.id,
    responseCaptured: true,
  });
  const detail = current.store.getTicketDetail(ticket.id);
  assert.equal(detail.sentResponses.length, 1);
  assert.equal(detail.sentResponses[0]?.messageId, reply.id);
  assert.equal(
    detail.timeline.filter((item) => item.type === "message").length,
    2,
  );
});

test("mensagem sem citação de outro membro da equipe não é anexada por proximidade", () => {
  const current = fixture();
  const ticket = current.store.createTicket({
    id: "ticket-non-self-response",
    groupId: current.groupId,
    sourceMessageId: current.externalMessageId,
    title: "Pedidos ausentes",
    summary: "Cliente relata pedidos ausentes.",
  });

  assert.equal(current.store.captureStaffResponse(current.staffMessageId), null);
  const detail = current.store.getTicketDetail(ticket.id);
  assert.equal(detail.messageCount, 1);
  assert.equal(detail.sentResponses.length, 0);
});

test("conta comercial não vincula resposta sem citação apenas por proximidade", () => {
  const current = fixture();
  const ticket = current.store.createTicket({
    id: "ticket-self-response",
    groupId: current.groupId,
    sourceMessageId: current.externalMessageId,
    title: "Pedidos ausentes",
    summary: "Cliente relata pedidos ausentes.",
  });
  const self = current.store.upsertParticipant({
    id: "self-commercial-account",
    externalJid: "self:commercial-account",
    displayName: "Acme Comercial",
  });
  current.store.setStaffMember(self.id, "Acme Comercial");
  current.store.addGroupParticipant(current.groupId, self.id);
  const reply = current.store.upsertMessage({
    id: "message-self-reply",
    externalId: "wa-message-self-reply",
    groupId: current.groupId,
    senderId: self.id,
    occurredAt: "2026-07-16T12:06:00.000Z",
    text: "Vou verificar por aqui.",
    messageType: "text",
  });

  assert.equal(current.store.captureStaffResponse(reply.id), null);
  const detail = current.store.getTicketDetail(ticket.id);
  assert.equal(detail.messageCount, 1);
  assert.equal(detail.sentResponses.length, 0);
});

test("desvinculação remove somente o contexto do ticket e preserva mensagem e anexo", () => {
  const current = fixture();
  const ticket = current.store.createTicket({
    id: "ticket-detach-message",
    groupId: current.groupId,
    sourceMessageId: current.externalMessageId,
    title: "Pedidos ausentes",
    summary: "Cliente relata pedidos ausentes.",
  });
  current.store.attachMessageToTicket(ticket.id, current.staffMessageId, "whatsapp-capture");
  current.store.recordSentResponse({
    ticketId: ticket.id,
    messageId: current.staffMessageId,
    body: "Vou verificar.",
    sentAt: "2026-07-16T12:05:00.000Z",
  });
  current.store.upsertAttachment({
    id: "detached-message-attachment",
    messageId: current.staffMessageId,
    kind: "document",
    mimeType: "text/plain",
    fileName: "contexto.txt",
    localPath: "/tmp/contexto.txt",
    sha256: "detached-message-attachment-sha",
  });

  const beforeDetach = current.store.getTicketDetail(ticket.id);
  const sourceTimelineMessage = beforeDetach.timeline.find(
    (item) => item.type === "message" && item.id === current.externalMessageId,
  );
  const removableTimelineMessage = beforeDetach.timeline.find(
    (item) => item.type === "message" && item.id === current.staffMessageId,
  );
  assert.equal(sourceTimelineMessage?.type === "message" && sourceTimelineMessage.canDetach, false);
  assert.equal(
    removableTimelineMessage?.type === "message" && removableTimelineMessage.canDetach,
    true,
  );

  const detail = current.store.detachMessageFromTicket(
    ticket.id,
    current.staffMessageId,
    "Operador",
  );

  assert.equal(detail.messageCount, 1);
  assert.equal(detail.lastMessageAt, "2026-07-16T12:00:00.000Z");
  assert.equal(detail.sentResponses.length, 0);
  assert.deepEqual(
    detail.timeline
      .filter((item) => item.type === "message")
      .map((message) => message.id),
    [current.externalMessageId],
  );
  assert.equal(
    (current.database.prepare("SELECT COUNT(*) AS count FROM messages WHERE id = ?").get(
      current.staffMessageId,
    ) as { count: number }).count,
    1,
  );
  assert.equal(
    (current.database.prepare("SELECT COUNT(*) AS count FROM attachments WHERE message_id = ?").get(
      current.staffMessageId,
    ) as { count: number }).count,
    1,
  );
  assert.deepEqual(
    current.database
      .prepare("SELECT triage_kind, triage_state FROM messages WHERE id = ?")
      .get(current.staffMessageId),
    { triage_kind: "context", triage_state: "context" },
  );
  assert.deepEqual(
    current.database
      .prepare(
        `SELECT event_type, actor, json_extract(data_json, '$.messageId') AS message_id
         FROM ticket_events
         WHERE ticket_id = ? AND event_type = 'message_detached'`,
      )
      .get(ticket.id),
    {
      event_type: "message_detached",
      actor: "Operador",
      message_id: current.staffMessageId,
    },
  );
});

test("mensagem de origem não pode ser desvinculada do ticket", () => {
  const current = fixture();
  const ticket = current.store.createTicket({
    id: "ticket-source-detach",
    groupId: current.groupId,
    sourceMessageId: current.externalMessageId,
    title: "Pedidos ausentes",
    summary: "Cliente relata pedidos ausentes.",
  });

  assert.throws(
    () => current.store.detachMessageFromTicket(ticket.id, current.externalMessageId),
    ConflictError,
  );
  assert.equal(current.store.getTicketDetail(ticket.id).messageCount, 1);
});

test("transições de status preservam o ciclo manual e rejeitam saltos inválidos", () => {
  const current = fixture();
  const ticket = current.store.createTicket({
    id: "ticket-status",
    groupId: current.groupId,
    sourceMessageId: current.externalMessageId,
    title: "Pedidos ausentes",
    summary: "Cliente relata pedidos ausentes.",
  });

  const inProgress = current.store.updateTicketStatus(ticket.id, {
    status: "in_progress",
    actor: "Operador",
  });
  assert.equal(inProgress.status, "in_progress");

  const resolved = current.store.updateTicketStatus(ticket.id, {
    status: "resolved",
    actor: "Operador",
    resolution: {
      summary: "Sincronização refeita e pedidos confirmados.",
      outcome: "Cliente confirmou a normalização.",
    },
  });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.resolution?.validatedBy, "Operador");

  const archived = current.store.updateTicketStatus(ticket.id, {
    status: "archived",
  });
  assert.equal(archived.status, "archived");
  assert.equal(archived.resolvedAt, resolved.resolvedAt);
  assert.throws(
    () => current.store.updateTicketStatus(ticket.id, { status: "in_progress" }),
    ConflictError,
  );

  const before = current.database
    .prepare("SELECT COUNT(*) AS count FROM ticket_events WHERE ticket_id = ?")
    .get(ticket.id) as { count: number };
  current.store.updateTicketStatus(ticket.id, { status: "archived" });
  const after = current.database
    .prepare("SELECT COUNT(*) AS count FROM ticket_events WHERE ticket_id = ?")
    .get(ticket.id) as { count: number };
  assert.equal(after.count, before.count);
});

test("ticket arquivado pode ser restaurado para resolvido sem perder a resolução", () => {
  const current = fixture();
  const ticket = current.store.createTicket({
    id: "ticket-restore-from-archive",
    groupId: current.groupId,
    sourceMessageId: current.externalMessageId,
    title: "Atendimento precisa continuar",
    summary: "O cliente enviou novo contexto após o arquivamento.",
  });
  const resolved = current.store.updateTicketStatus(ticket.id, {
    status: "resolved",
    actor: "Operador",
    resolution: { summary: "Primeira conclusão registrada." },
  });
  const archived = current.store.updateTicketStatus(ticket.id, {
    status: "archived",
    actor: "Operador",
  });

  const restored = current.store.updateTicketStatus(ticket.id, {
    status: "resolved",
    actor: "Operador",
  });

  assert.equal(restored.status, "resolved");
  assert.equal(restored.archivedAt, null);
  assert.equal(restored.resolvedAt, resolved.resolvedAt);
  assert.equal(restored.resolution?.summary, "Primeira conclusão registrada.");
  assert.ok(archived.archivedAt);
  const restoreEvent = current.database
    .prepare(
      `SELECT from_status, to_status
       FROM ticket_events
       WHERE ticket_id = ? AND from_status = 'archived'
       ORDER BY occurred_at DESC
       LIMIT 1`,
    )
    .get(ticket.id) as { from_status: string; to_status: string };
  assert.deepEqual(restoreEvent, {
    from_status: "archived",
    to_status: "resolved",
  });
});

test("ticket cancelado é terminal, aparece no dashboard e restaura como cancelado", () => {
  const current = fixture();
  const ticket = current.store.createTicket({
    id: "ticket-cancelled",
    groupId: current.groupId,
    sourceMessageId: current.externalMessageId,
    title: "Demanda cancelada",
    summary: "O solicitante desistiu antes da execução.",
  });

  const cancelled = current.store.updateTicketStatus(ticket.id, {
    status: "cancelled",
    actor: "Operador",
    reason: "Solicitante desistiu da demanda.",
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.resolvedAt, null);
  assert.equal(cancelled.resolution, null);

  const dashboard = current.store.getDashboard();
  assert.equal(dashboard.totals.open, 0);
  assert.equal(
    dashboard.statusCounts.find((item) => item.status === "cancelled")?.count,
    1,
  );

  const archived = current.store.updateTicketStatus(ticket.id, {
    status: "archived",
    actor: "Operador",
  });
  assert.equal(archived.status, "archived");
  assert.ok(archived.archivedAt);

  const restored = current.store.updateTicketStatus(ticket.id, {
    status: "resolved",
    actor: "Operador",
  });
  assert.equal(restored.status, "cancelled");
  assert.equal(restored.archivedAt, null);
  assert.equal(restored.resolvedAt, null);
});

test("ticket reaberto pode reutilizar ou editar a resolução existente sem duplicá-la", () => {
  const current = fixture();
  const ticket = current.store.createTicket({
    id: "ticket-reopened-resolution",
    groupId: current.groupId,
    sourceMessageId: current.externalMessageId,
    title: "Campanha continua sem enviar",
    summary: "O atendimento precisou continuar após a primeira conclusão.",
  });

  const firstResolution = current.store.updateTicketStatus(ticket.id, {
    status: "resolved",
    actor: "Operador",
    resolution: { summary: "Envio normalizado e confirmado pelo cliente." },
  }).resolution;
  assert.ok(firstResolution);

  current.store.updateTicketStatus(ticket.id, {
    status: "in_progress",
    actor: "Operador",
  });
  const reused = current.store.updateTicketStatus(ticket.id, {
    status: "resolved",
    actor: "Operador",
  });
  assert.equal(reused.resolution?.id, firstResolution.id);
  assert.equal(reused.resolution?.summary, firstResolution.summary);
  assert.equal(reused.resolution?.validatedAt, firstResolution.validatedAt);

  current.store.updateTicketStatus(ticket.id, {
    status: "in_progress",
    actor: "Operador",
  });
  const edited = current.store.updateTicketStatus(ticket.id, {
    status: "resolved",
    actor: "Operador",
    resolution: {
      summary: "Envio normalizado; as mensagens adicionais também foram confirmadas.",
    },
  });
  assert.equal(edited.resolution?.id, firstResolution.id);
  assert.equal(
    edited.resolution?.summary,
    "Envio normalizado; as mensagens adicionais também foram confirmadas.",
  );
  assert.equal(
    (
      current.database
        .prepare("SELECT COUNT(*) AS count FROM resolutions WHERE ticket_id = ?")
        .get(ticket.id) as { count: number }
    ).count,
    1,
  );
});

test("job de investigação é reivindicado atomicamente e persiste a análise completa", () => {
  const current = fixture();
  current.store.upsertAttachment({
    id: "attachment",
    messageId: current.externalMessageId,
    kind: "image",
    mimeType: "image/png",
    fileName: "erro.png",
    localPath: "/tmp/threadmark/erro.png",
    sha256: "test-sha",
    extractedText: "Pedido 123 não encontrado",
  });
  const ticket = current.store.createTicket({
    id: "ticket-investigation",
    groupId: current.groupId,
    sourceMessageId: current.externalMessageId,
    title: "Demanda em revisão",
    summary: "Aguardando investigação.",
  });
  const queued = current.store.queueInvestigation(ticket.id, "Validar pedidos do dia");

  const claimed = current.store.claimNextInvestigationJob();
  assert.deepEqual(claimed, {
    id: queued.jobId,
    ticketId: ticket.id,
    instructions: "Validar pedidos do dia",
  });
  assert.equal(current.store.claimNextInvestigationJob(), null);
  const context = current.store.getInvestigationContext(ticket.id);
  assert.equal(context.accountName, "Agência Teste");
  assert.deepEqual(context.knownEcommerces, ["Loja Teste"]);
  assert.equal(context.messages[0]?.attachments[0]?.localPath, "/tmp/threadmark/erro.png");

  const result = current.store.completeInvestigationJob(queued.jobId, {
    createTicket: true,
    relation: "new",
    relatedTicketId: null,
    title: "Pedidos VTEX ausentes",
    summary: "Cliente relata pedidos ausentes na Loja Teste.",
    affectedEcommerce: "Loja Teste",
    priority: "high",
    categories: {
      contactReason: ["Problema"],
      productArea: ["Tracking"],
      platform: ["VTEX"],
      symptom: ["Pedidos ausentes"],
    },
    evidence: [
      { source: "conversation", summary: "Print cita o pedido 123.", reference: "erro.png" },
    ],
    suggestedResponse: "Recebemos o exemplo e estamos validando a sincronização.",
    missingInformation: ["Período exato"],
    nextAction: "Consultar os IDs do período em modo somente leitura.",
    confidence: 0.91,
    outcome: "needs_information",
  });

  assert.equal(result.title, "Pedidos VTEX ausentes");
  assert.equal(result.affectedStore?.name, "Loja Teste");
  assert.equal(result.nextAction, "Consultar os IDs do período em modo somente leitura.");
  assert.deepEqual(
    result.categories.map((category) => category.facet).sort(),
    ["platform", "product", "reason", "symptom"],
  );
  assert.equal(result.suggestions[0]?.confidence, 0.91);
  assert.equal(result.latestInvestigation?.id, queued.jobId);
  assert.equal(result.latestInvestigation?.state, "completed");
  assert.equal(result.latestInvestigation?.outcome, "needs_information");
  assert.equal(result.latestInvestigation?.confidence, 0.91);
  assert.equal(
    result.latestInvestigation?.evidence[0]?.summary,
    "Print cita o pedido 123.",
  );
  assert.equal(
    result.latestInvestigation?.suggestedResponse,
    "Recebemos o exemplo e estamos validando a sincronização.",
  );
  const job = current.database
    .prepare("SELECT state, result_json FROM investigation_jobs WHERE id = ?")
    .get(queued.jobId) as { state: string; result_json: string };
  assert.equal(job.state, "completed");
  assert.match(job.result_json, /Pedidos VTEX ausentes/);
});

test("detalhe expõe conclusão técnica sem criar uma resposta falsa", () => {
  const current = fixture();
  const ticket = current.store.createTicket({
    id: "ticket-technical-investigation",
    groupId: current.groupId,
    sourceMessageId: current.externalMessageId,
    title: "Pedidos ausentes",
    summary: "Cliente relata pedidos ausentes.",
  });
  const queued = current.store.queueInvestigation(
    ticket.id,
    "Consultar banco e logs em modo somente leitura",
  );

  const result = current.store.completeInvestigationJob(queued.jobId, {
    createTicket: true,
    relation: "new",
    relatedTicketId: null,
    title: "Pedidos ausentes exigem investigação técnica",
    summary: "A conversa não permite concluir a causa.",
    affectedEcommerce: "Loja Teste",
    priority: "high",
    categories: {
      contactReason: ["Problema"],
      productArea: ["Pedidos"],
      platform: [],
      symptom: ["Pedidos ausentes"],
    },
    evidence: [
      {
        source: "conversation",
        summary: "O cliente informou que pedidos estão ausentes.",
        reference: "wa-message-1",
      },
    ],
    suggestedResponse: null,
    missingInformation: [],
    nextAction: "Consultar os pedidos e os logs da integração.",
    confidence: 0.72,
    outcome: "technical_investigation_required",
  });

  assert.equal(result.suggestions.length, 0);
  assert.deepEqual(result.latestInvestigation, {
    id: queued.jobId,
    state: "completed",
    instructions: "Consultar banco e logs em modo somente leitura",
    requestedAt: result.latestInvestigation?.requestedAt,
    startedAt: null,
    finishedAt: result.latestInvestigation?.finishedAt,
    error: null,
    outcome: "technical_investigation_required",
    confidence: 0.72,
    evidence: [
      {
        source: "conversation",
        summary: "O cliente informou que pedidos estão ausentes.",
        reference: "wa-message-1",
      },
    ],
    missingInformation: [],
    nextAction: "Consultar os pedidos e os logs da integração.",
    suggestedResponse: null,
  });
});

test("resultado legado recebe fallback seguro de outcome", () => {
  const current = fixture();
  const ticket = current.store.createTicket({
    id: "ticket-legacy-investigation",
    groupId: current.groupId,
    sourceMessageId: current.externalMessageId,
    title: "Ticket legado",
    summary: "Resultado anterior à classificação por outcome.",
  });
  const queued = current.store.queueInvestigation(ticket.id);
  current.database
    .prepare(
      `UPDATE investigation_jobs
       SET state = 'completed', finished_at = ?, result_json = ?
       WHERE id = ?`,
    )
    .run(
      "2026-07-16T13:00:00.000Z",
      JSON.stringify({
        confidence: 0.63,
        evidence: [],
        missingInformation: ["ID do pedido"],
        nextAction: "Solicitar o ID ao cliente.",
        suggestedResponse: "Pode nos informar o ID do pedido?",
      }),
      queued.jobId,
    );

  const needsInformation = current.store.getTicketDetail(ticket.id).latestInvestigation;
  assert.equal(needsInformation?.outcome, "needs_information");

  current.database
    .prepare("UPDATE investigation_jobs SET result_json = ? WHERE id = ?")
    .run(
      JSON.stringify({
        confidence: 0.63,
        evidence: [],
        missingInformation: [],
        nextAction: "Enviar a orientação.",
        suggestedResponse: "Oriente o cliente a atualizar o período.",
      }),
      queued.jobId,
    );
  assert.equal(
    current.store.getTicketDetail(ticket.id).latestInvestigation?.outcome,
    "reply_ready",
  );

  current.database
    .prepare("UPDATE investigation_jobs SET result_json = ? WHERE id = ?")
    .run(
      JSON.stringify({
        confidence: 0.63,
        evidence: [],
        missingInformation: [],
        nextAction: "Investigar banco e logs.",
        suggestedResponse: null,
      }),
      queued.jobId,
    );
  assert.equal(
    current.store.getTicketDetail(ticket.id).latestInvestigation?.outcome,
    "technical_investigation_required",
  );
});

test("jobs em execução podem ser recuperados depois de reinício", () => {
  const current = fixture();
  const ticket = current.store.createTicket({
    id: "ticket-recovery",
    groupId: current.groupId,
    sourceMessageId: current.externalMessageId,
    title: "Ticket",
    summary: "Resumo",
  });
  const queued = current.store.queueInvestigation(ticket.id);
  assert.equal(current.store.claimNextInvestigationJob()?.id, queued.jobId);

  assert.equal(current.store.recoverRunningInvestigationJobs(), 1);
  assert.equal(current.store.claimNextInvestigationJob()?.id, queued.jobId);
});

test("read models operacionais expõem grupos e fila de investigações", () => {
  const current = fixture();
  const ticket = current.store.createTicket({
    id: "ticket-operations",
    groupId: current.groupId,
    sourceMessageId: current.externalMessageId,
    title: "Falha operacional",
    summary: "Cliente relata uma falha.",
    priority: "high",
  });
  const queued = current.store.queueInvestigation(
    ticket.id,
    "Validar a causa com evidências",
  );

  const latestInvestigation = current.store.getTicketDetail(ticket.id).latestInvestigation;
  assert.equal(latestInvestigation?.id, queued.jobId);
  assert.equal(latestInvestigation?.state, "queued");
  assert.equal(latestInvestigation?.instructions, "Validar a causa com evidências");
  assert.equal(latestInvestigation?.outcome, null);
  assert.equal(latestInvestigation?.suggestedResponse, null);

  const groups = current.store.listOperationalGroups();
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0], {
    id: current.groupId,
    subject: "Acme + Agência Teste",
    externalJid: "120363000000@g.us",
    client: {
      id: current.clientId,
      name: "Agência Teste",
      kind: "agency",
    },
    monitored: true,
    messageCount: 2,
    openTicketCount: 1,
    lastMessageAt: "2026-07-16T12:05:00.000Z",
    historyOldestAt: null,
    historyNewestAt: null,
    historyComplete: false,
  });

  const jobs = current.store.listInvestigationJobs({
    states: ["queued"],
    limit: 10,
  });
  assert.equal(jobs.items.length, 1);
  assert.equal(jobs.items[0]?.ticketNumber, ticket.number);
  assert.equal(jobs.items[0]?.clientName, "Agência Teste");
  assert.equal(jobs.items[0]?.instructions, "Validar a causa com evidências");
  assert.equal(
    jobs.counts.find((item) => item.state === "queued")?.count,
    1,
  );
});
