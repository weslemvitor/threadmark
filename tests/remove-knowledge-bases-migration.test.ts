import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { migrateDatabase, migrations } from "../server/db/index.js";
import { SupportStore } from "../server/domain/index.js";

test("migração remove somente a biblioteca de bases e preserva dados operacionais", () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");

  try {
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    for (const migration of migrations.filter((item) => item.version <= 36)) {
      database.transaction(() => {
        database.exec(migration.sql);
        database.prepare(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        ).run(migration.version, migration.name, "2026-08-13T10:00:00.000Z");
      })();
    }

    const store = new SupportStore(database);
    const account = store.upsertAccount({
      id: "migration-account",
      phoneNumber: "+5547000000000",
      displayName: "Conta local",
    });
    const client = store.upsertClient({
      id: "migration-client",
      name: "Organização local",
      slug: "organizacao-local",
      kind: "ecommerce",
    });
    const group = store.upsertGroup({
      id: "migration-group",
      accountId: account.id,
      clientId: client.id,
      externalJid: "120363000000@g.us",
      subject: "Suporte local",
    });
    const participant = store.upsertParticipant({
      id: "migration-participant",
      externalJid: "5547888888888@s.whatsapp.net",
      displayName: "Pessoa cliente",
    });
    store.addGroupParticipant(group.id, participant.id);
    const message = store.upsertMessage({
      id: "migration-message",
      externalId: "migration-message",
      groupId: group.id,
      senderId: participant.id,
      occurredAt: "2026-08-13T10:00:00.000Z",
      text: "Preciso de ajuda.",
      messageType: "text",
    });
    const ticket = store.createTicket({
      id: "migration-ticket",
      groupId: group.id,
      sourceMessageId: message.id,
      title: "Atendimento preservado",
      summary: "Os dados operacionais não podem ser apagados.",
    });
    store.recordResolution({
      ticketId: ticket.id,
      summary: "Resumo preservado durante a migração.",
      validatedBy: "Operador",
    });

    database.prepare(`
      INSERT INTO knowledge_candidates (
        id, ticket_id, client_id, store_id, kind, title, content, status,
        source, created_by, updated_by, status_changed_at, status_changed_by,
        archived_at, import_fingerprint, created_at, updated_at
      ) VALUES (
        'legacy-knowledge', NULL, NULL, NULL, 'faq', 'Base antiga',
        'Conteúdo removido.', 'approved', 'manual', 'Operador', 'Operador',
        '2026-08-13T10:00:00.000Z', 'Operador', NULL, NULL,
        '2026-08-13T10:00:00.000Z', '2026-08-13T10:00:00.000Z'
      )
    `).run();
    database.prepare(`
      INSERT INTO knowledge_candidate_events (
        id, knowledge_candidate_id, event_type, actor, from_status, to_status,
        reason, data_json, occurred_at
      ) VALUES (
        'legacy-event', 'legacy-knowledge', 'created', 'Operador', NULL,
        'approved', NULL, '{}', '2026-08-13T10:00:00.000Z'
      )
    `).run();

    migrateDatabase(database);
    migrateDatabase(database);

    const removedTables = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'knowledge_candidates',
        'knowledge_candidate_events',
        'knowledge_assessments'
      )
    `).all();
    assert.deepEqual(removedTables, []);
    assert.equal(store.getTicketDetail(ticket.id).title, "Atendimento preservado");
    assert.equal(store.getTicketDetail(ticket.id).resolution?.summary, "Resumo preservado durante a migração.");
    assert.equal(store.getTicketDetail(ticket.id).messageCount, 1);
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 37").get() as { count: number }).count,
      1,
    );
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }
});
