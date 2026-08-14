import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import {
  migrateDatabase,
  migrations,
  type SupportDatabase,
} from "../server/db/index.js";
import { SupportStore } from "../server/domain/index.js";

const MIGRATION_NAME = "supersede_answered_suggestions";

function databaseBeforeMigration(): SupportDatabase {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  const target = migrations.find((migration) => migration.name === MIGRATION_NAME);
  assert.ok(target, "a migração de sugestões respondidas deve existir");
  for (const migration of migrations.filter(
    (candidate) => candidate.version < target.version,
  )) {
    database.transaction(() => {
      database.exec(migration.sql);
      database
        .prepare(
          `INSERT INTO schema_migrations (version, name, applied_at)
           VALUES (?, ?, ?)`,
        )
        .run(migration.version, migration.name, "2026-07-21T14:00:00.000Z");
    })();
  }
  return database;
}

test("migração desativa todas as orientações automáticas candidatas", () => {
  const database = databaseBeforeMigration();
  try {
    const store = new SupportStore(database);
    const account = store.upsertAccount({
      id: "answered-migration-account",
      phoneNumber: "+5547999999999",
      displayName: "Conta local",
    });
    const client = store.upsertClient({
      id: "answered-migration-client",
      name: "Organização de teste",
      slug: "organizacao-answered-migration",
      kind: "agency",
    });
    const group = store.upsertGroup({
      id: "answered-migration-group",
      accountId: account.id,
      clientId: client.id,
      externalJid: "120363000032@g.us",
      subject: "Conversa de teste",
    });
    const participant = store.upsertParticipant({
      id: "answered-migration-participant",
      externalJid: "5547888888888@s.whatsapp.net",
      displayName: "Cliente",
    });
    store.addGroupParticipant(group.id, participant.id);
    const message = store.upsertMessage({
      id: "answered-migration-message",
      externalId: "answered-migration-message",
      groupId: group.id,
      senderId: participant.id,
      occurredAt: "2026-07-21T14:00:00.000Z",
      text: "Como resolvemos este caso?",
      messageType: "text",
    });
    const ticket = store.createTicket({
      id: "answered-migration-ticket",
      groupId: group.id,
      sourceMessageId: message.id,
      title: "Dúvida",
      summary: "Cliente pediu uma orientação.",
    });

    store.addSuggestion({
      id: "candidate-followed-by-response",
      ticketId: ticket.id,
      body: "Resposta enviada depois da sugestão.",
      confidence: 0.8,
      createdAt: "2026-07-21T14:01:00.000Z",
    });
    store.addSuggestion({
      id: "candidate-exactly-matches-earlier-response",
      ticketId: ticket.id,
      body: "Orientação que já tinha sido enviada.",
      confidence: 0.8,
      createdAt: "2026-07-21T14:10:00.000Z",
    });
    store.addSuggestion({
      id: "candidate-still-valid",
      ticketId: ticket.id,
      body: "Nova orientação ainda não enviada.",
      confidence: 0.8,
      createdAt: "2026-07-21T14:20:00.000Z",
    });
    store.addSuggestion({
      id: "candidate-before-new-external-context",
      ticketId: ticket.id,
      body: "Orientação baseada no contexto anterior.",
      confidence: 0.8,
      createdAt: "2026-07-21T14:10:00.000Z",
    });
    store.addSuggestion({
      id: "accepted-before-new-external-context",
      ticketId: ticket.id,
      body: "Resposta já aceita pelo operador.",
      confidence: 0.8,
      status: "accepted",
      createdAt: "2026-07-21T14:10:00.000Z",
    });
    store.addSuggestion({
      id: "rejected-before-new-external-context",
      ticketId: ticket.id,
      body: "Resposta rejeitada pelo operador.",
      confidence: 0.8,
      status: "rejected",
      createdAt: "2026-07-21T14:10:00.000Z",
    });
    store.addSuggestion({
      id: "superseded-before-new-external-context",
      ticketId: ticket.id,
      body: "Resposta já substituída antes da migração.",
      confidence: 0.8,
      status: "superseded",
      createdAt: "2026-07-21T14:10:00.000Z",
    });
    store.recordSentResponse({
      ticketId: ticket.id,
      body: "Resposta distinta enviada depois.",
      sentAt: "2026-07-21T14:05:00.000Z",
    });
    store.recordSentResponse({
      ticketId: ticket.id,
      body: "Orientação que já tinha sido enviada.",
      sentAt: "2026-07-21T13:55:00.000Z",
    });
    const followUp = store.upsertMessage({
      id: "answered-migration-follow-up",
      externalId: "answered-migration-follow-up",
      groupId: group.id,
      senderId: participant.id,
      occurredAt: "2026-07-21T14:15:00.000Z",
      text: "Chegou uma nova informação para este ticket.",
      messageType: "text",
    });
    store.attachMessageToTicket(ticket.id, followUp.id);
    database
      .prepare(
        `UPDATE ticket_messages SET added_at = ?
         WHERE ticket_id = ? AND message_id = ?`,
      )
      .run("2026-07-21T14:15:00.000Z", ticket.id, followUp.id);

    const ackSource = store.upsertMessage({
      id: "answered-migration-ack-source",
      externalId: "answered-migration-ack-source",
      groupId: group.id,
      senderId: participant.id,
      occurredAt: "2026-07-21T15:00:00.000Z",
      text: "Pode investigar este outro caso?",
      messageType: "text",
    });
    const ackTicket = store.createTicket({
      id: "answered-migration-ack-ticket",
      groupId: group.id,
      sourceMessageId: ackSource.id,
      title: "Caso em investigação",
      summary: "A equipe acusou recebimento, mas ainda investiga.",
    });
    store.recordSentResponse({
      ticketId: ackTicket.id,
      body: "Vou verificar.",
      sentAt: "2026-07-21T15:05:00.000Z",
      capturedAt: "2026-07-21T15:20:00.000Z",
    });
    store.addSuggestion({
      id: "candidate-at-response-timestamp",
      ticketId: ackTicket.id,
      body: "Minuta diferente criada no mesmo segundo da resposta.",
      confidence: 0.9,
      createdAt: "2026-07-21T15:05:00.000Z",
    });
    store.addSuggestion({
      id: "candidate-after-ack-still-valid",
      ticketId: ackTicket.id,
      body: "Identificamos a causa e corrigimos o processamento.",
      confidence: 0.9,
      createdAt: "2026-07-21T15:10:00.000Z",
    });

    const untouchedSource = store.upsertMessage({
      id: "answered-migration-untouched-source",
      externalId: "answered-migration-untouched-source",
      groupId: group.id,
      senderId: participant.id,
      occurredAt: "2026-07-21T16:00:00.000Z",
      text: "Ainda preciso de uma resposta neste caso.",
      messageType: "text",
    });
    const untouchedTicket = store.createTicket({
      id: "answered-migration-untouched-ticket",
      groupId: group.id,
      sourceMessageId: untouchedSource.id,
      title: "Caso ainda sem resposta",
      summary: "Nenhuma resposta ou contexto novo foi registrado.",
    });
    store.addSuggestion({
      id: "candidate-without-response-still-valid",
      ticketId: untouchedTicket.id,
      body: "Orientação ainda válida para o cliente.",
      confidence: 0.9,
      createdAt: "2026-07-21T16:10:00.000Z",
    });

    migrateDatabase(database);
    migrateDatabase(database);

    assert.deepEqual(
      database
        .prepare("SELECT id, status FROM suggestions ORDER BY id")
        .all(),
      [
        {
          id: "accepted-before-new-external-context",
          status: "accepted",
        },
        {
          id: "candidate-after-ack-still-valid",
          status: "superseded",
        },
        {
          id: "candidate-at-response-timestamp",
          status: "superseded",
        },
        {
          id: "candidate-before-new-external-context",
          status: "superseded",
        },
        {
          id: "candidate-exactly-matches-earlier-response",
          status: "superseded",
        },
        {
          id: "candidate-followed-by-response",
          status: "superseded",
        },
        { id: "candidate-still-valid", status: "superseded" },
        {
          id: "candidate-without-response-still-valid",
          status: "superseded",
        },
        {
          id: "rejected-before-new-external-context",
          status: "rejected",
        },
        {
          id: "superseded-before-new-external-context",
          status: "superseded",
        },
      ],
    );
    assert.equal(
      (
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM schema_migrations WHERE name = ?",
          )
          .get(MIGRATION_NAME) as { count: number }
      ).count,
      1,
    );
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }
});
