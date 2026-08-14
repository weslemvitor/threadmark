import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import {
  migrateDatabase,
  migrations,
  type SupportDatabase,
} from "../server/db/index.js";
import { SupportStore } from "../server/domain/index.js";

const MIGRATION_NAME = "deliberate_triage_and_knowledge_assessments";

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
  assert.ok(target, "a migração deliberada deve existir");
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
        .run(migration.version, migration.name, "2026-07-20T16:00:00.000Z");
    })();
  }
  return database;
}

test("migração preserva configuração da IA e adiciona estado deliberado idempotente", () => {
  const database = databaseBeforeMigration();
  try {
    database
      .prepare(
        `UPDATE triage_ai_settings
         SET enabled = 1, model = 'modelo-existente', updated_by = 'Operador'`,
      )
      .run();

    migrateDatabase(database);
    migrateDatabase(database);

    assert.deepEqual(
      database
        .prepare(
          `SELECT enabled, model, updated_by, silence_window_seconds
           FROM triage_ai_settings WHERE singleton = 1`,
        )
        .get(),
      {
        enabled: 1,
        model: "modelo-existente",
        updated_by: "Operador",
        silence_window_seconds: 180,
      },
    );
    const tables = database
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name = 'triage_context_waits'`,
      )
      .all();
    assert.deepEqual(tables, [{ name: "triage_context_waits" }]);
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

test("ações manuais continuam funcionando antes da migração do estado de espera", () => {
  const database = databaseBeforeMigration();
  try {
    const store = new SupportStore(database);
    const account = store.upsertAccount({
      id: "pre-wait-account",
      phoneNumber: "+5547999999999",
      displayName: "Conta local",
    });
    const client = store.upsertClient({
      id: "pre-wait-client",
      name: "Organização local",
      slug: "organizacao-local-pre-wait",
      kind: "agency",
    });
    const group = store.upsertGroup({
      id: "pre-wait-group",
      accountId: account.id,
      clientId: client.id,
      externalJid: "120363000999@g.us",
      subject: "Conversa pré-migração",
    });
    const participant = store.upsertParticipant({
      id: "pre-wait-participant",
      externalJid: "5547888888888@s.whatsapp.net",
      phoneE164: "+5547888888888",
      displayName: "Cliente",
    });
    store.addGroupParticipant(group.id, participant.id);
    const message = store.upsertMessage({
      id: "pre-wait-message",
      externalId: "wa-pre-wait-message",
      groupId: group.id,
      senderId: participant.id,
      occurredAt: "2026-07-20T10:00:00.000Z",
      text: "Mensagem para ignorar antes da migração.",
      messageType: "conversation",
      triageKind: "unclassified",
      triageState: "unreviewed",
      ingestionSource: "realtime_notify",
    }).id;

    store.ignoreConversationMessages(group.id, {
      messageIds: [message],
      clientRequestId: "pre-wait-ignore",
    });

    assert.deepEqual(
      database
        .prepare("SELECT triage_state FROM messages WHERE id = ?")
        .get(message),
      { triage_state: "ignored" },
    );
  } finally {
    database.close();
  }
});
