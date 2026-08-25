import assert from "node:assert/strict";
import test from "node:test";

import { createDatabase, migrateDatabase } from "../server/db/index.js";
import { SupportStore } from "../server/domain/index.js";

test("migração remove stubs técnicos sem excluir ticket ou mensagem real", () => {
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  try {
    const account = store.upsertAccount({
      id: "stub-cleanup-account",
      phoneNumber: "+5511999999999",
      displayName: "Acme Comercial",
    });
    const client = store.upsertClient({
      id: "stub-cleanup-client",
      name: "Cliente Fictício",
      slug: "cliente-ficticio-stub-cleanup",
      kind: "ecommerce",
    });
    const group = store.upsertGroup({
      id: "stub-cleanup-group",
      accountId: account.id,
      clientId: client.id,
      externalJid: "120363000000000000@g.us",
      subject: "Cliente Fictício & Acme",
    });
    const participant = store.upsertParticipant({
      id: "stub-cleanup-participant",
      externalJid: "5511888888888@s.whatsapp.net",
      phoneE164: "+5511888888888",
      displayName: "Pessoa Fictícia",
    });
    const system = store.upsertMessage({
      id: "stub-cleanup-system-message",
      externalId: "stub-cleanup-system-external",
      providerMessageId: "stub-cleanup-system-provider",
      groupId: group.id,
      senderId: participant.id,
      occurredAt: "2026-08-24T12:00:00.000Z",
      text: '{"id":"900000000000108@lid","admin":null}',
      messageType: "system",
      triageKind: "information",
      triageState: "ignored",
      raw: {
        messageStubType: 27,
        messageStubParameters: [
          '{"id":"900000000000108@lid","admin":null}',
        ],
      },
    });
    store.upsertMessage({
      id: "stub-cleanup-real-message",
      externalId: "stub-cleanup-real-external",
      providerMessageId: "stub-cleanup-real-provider",
      groupId: group.id,
      senderId: participant.id,
      occurredAt: "2026-08-24T12:01:00.000Z",
      text: "Mensagem real preservada",
      messageType: "conversation",
      triageKind: "context",
      triageState: "context",
      raw: { message: { conversation: "Mensagem real preservada" } },
    });
    const ticket = store.createTicket({
      id: "stub-cleanup-ticket",
      groupId: group.id,
      sourceMessageId: system.id,
      title: "Ticket preservado",
      summary: "A referência técnica deve sair sem apagar o ticket.",
    });

    database.prepare("DELETE FROM schema_migrations WHERE version = 60").run();
    migrateDatabase(database);

    assert.deepEqual(
      database.prepare("SELECT id, text FROM messages ORDER BY id").all(),
      [
        {
          id: "stub-cleanup-real-message",
          text: "Mensagem real preservada",
        },
      ],
    );
    assert.equal(store.getTicketDetail(ticket.id).messageCount, 0);
    assert.equal(
      (
        database
          .prepare("SELECT source_message_id FROM tickets WHERE id = ?")
          .get(ticket.id) as { source_message_id: string | null }
      ).source_message_id,
      null,
    );
  } finally {
    database.close();
  }
});
