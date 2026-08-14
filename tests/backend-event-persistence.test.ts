import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { createDatabase, type SupportDatabase } from "../server/db/index.js";
import { SupportStore } from "../server/domain/index.js";
import { createTestApiApp } from "../server/index.js";
import type { TicketDetailDto, TimelineEventDto } from "../shared/contracts.js";

const databases: SupportDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture() {
  const database = createDatabase(":memory:");
  databases.push(database);
  const store = new SupportStore(database);
  const account = store.upsertAccount({
    id: "account-events",
    phoneNumber: "+5548999999999",
    displayName: "Comercial",
  });
  const client = store.upsertClient({
    id: "client-events",
    name: "Cliente Eventos",
    slug: "cliente-eventos",
    kind: "ecommerce",
  });
  const group = store.upsertGroup({
    id: "group-events",
    accountId: account.id,
    clientId: client.id,
    externalJid: "events@g.us",
    subject: "Suporte Cliente Eventos",
  });
  const participant = store.upsertParticipant({
    id: "participant-events",
    externalJid: "events@s.whatsapp.net",
    displayName: "Cliente",
  });
  store.addGroupParticipant(group.id, participant.id);
  const message = store.upsertMessage({
    id: "message-events",
    externalId: "wa-events",
    groupId: group.id,
    senderId: participant.id,
    occurredAt: "2026-07-17T01:00:00.000Z",
    text: "O total de clientes não fecha.",
    messageType: "text",
    triageKind: "demand",
  });
  const ticket = store.createTicket({
    id: "ticket-events",
    groupId: group.id,
    sourceMessageId: message.id,
    title: "Divergência no total de clientes",
    summary: "Cliente questiona a composição da métrica.",
    status: "triage",
  });
  return { database, store, ticketId: ticket.id };
}

function events(detail: TicketDetailDto): TimelineEventDto[] {
  return detail.timeline.filter(
    (item): item is TimelineEventDto => item.type === "event",
  );
}

test("timeline persiste e expõe eventos descritivos da sala manual e do status", async () => {
  const current = fixture();

  const thread = current.store.getOrCreateInvestigationThread(current.ticketId);
  current.store.getOrCreateInvestigationThread(current.ticketId);
  current.store.addInvestigationThreadMessage(thread.id, {
    body: "Confirme a regra na codebase.",
  });
  const failedTurn = current.store.claimNextAgentJob();
  assert.equal(failedTurn?.kind, "thread_turn");
  if (!failedTurn) assert.fail("turno aprofundado não reivindicado");
  current.store.failInvestigationThreadJob(failedTurn.id, "Falha controlada");

  current.store.addInvestigationThreadMessage(thread.id, {
    body: "Tente novamente somente com o contexto salvo.",
  });
  const completedTurn = current.store.claimNextAgentJob();
  assert.equal(completedTurn?.kind, "thread_turn");
  if (!completedTurn) assert.fail("segundo turno aprofundado não reivindicado");
  current.store.completeInvestigationThreadJob(completedTurn.id, {
    assistantMessage: "Regra confirmada.",
    phase: "conclusion",
    threadSummary: "Regra da métrica confirmada.",
    evidence: [],
    suggestedResponse: "A composição foi confirmada.",
    nextAction: "Revisar resposta.",
    confidence: 0.93,
    toolRequests: [],
  });

  current.store.updateTicketStatus(current.ticketId, {
    status: "in_progress",
    actor: "Operador",
    reason: "Investigação em andamento",
  });

  const response = await createTestApiApp(current.store).request(
    `/api/tickets/${current.ticketId}`,
  );
  assert.equal(response.status, 200);
  const timelineEvents = events((await response.json()) as TicketDetailDto);
  const eventTypes = timelineEvents.map((event) => event.eventType);

  for (const expected of [
    "ticket_created",
    "investigation_thread_created",
    "investigation_thread_message_queued",
    "investigation_thread_turn_started",
    "investigation_thread_turn_completed",
    "investigation_thread_turn_failed",
    "status_changed",
  ]) {
    assert.ok(eventTypes.includes(expected), `evento ausente: ${expected}`);
  }

  assert.equal(
    eventTypes.filter((type) => type === "investigation_thread_created").length,
    1,
    "reabrir a mesma sala não duplica o evento de criação",
  );
  assert.ok(timelineEvents.every((event) => event.description.length > 0));
  assert.ok(timelineEvents.every((event) => event.metadata !== event.data));
  assert.deepEqual(
    timelineEvents.map((event) => event.metadata),
    timelineEvents.map((event) => event.data),
  );

  const status = timelineEvents.find((event) => event.eventType === "status_changed");
  assert.equal(status?.fromStatus, "triage");
  assert.equal(status?.toStatus, "in_progress");
  assert.match(status?.description ?? "", /Em triagem.*Em andamento.*Operador/);

  const persistedRows = current.database
    .prepare("SELECT data_json FROM ticket_events WHERE ticket_id = ?")
    .all(current.ticketId) as Array<{ data_json: string }>;
  assert.ok(
    persistedRows.every((row) => {
      const parsed = JSON.parse(row.data_json) as { description?: unknown };
      return typeof parsed.description === "string" && parsed.description.length > 0;
    }),
    "a descrição fica no SQLite, não existe apenas como apresentação da API",
  );
});
