import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import {
  migrateDatabase,
  migrations,
  type SupportDatabase,
} from "../server/db/index.js";
import { SupportStore } from "../server/domain/index.js";

const CANCELLATION_MIGRATION_NAME = "investigation_thread_cancellation";

function databaseBeforeCancellation(): SupportDatabase {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  const target = migrations.find(
    (migration) => migration.name === CANCELLATION_MIGRATION_NAME,
  );
  assert.ok(target, "a migração de cancelamento deve existir");
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
        .run(migration.version, migration.name, "2026-07-20T14:00:00.000Z");
    })();
  }
  return database;
}

test("migração adiciona cancelamento sem reconstruir jobs nem perder turno running", () => {
  const database = databaseBeforeCancellation();
  try {
    const support = new SupportStore(database);
    const account = support.upsertAccount({
      id: "cancel-migration-account",
      phoneNumber: "+5547000000028",
      displayName: "Conta local",
    });
    const client = support.upsertClient({
      id: "cancel-migration-client",
      name: "Organização de teste",
      slug: "organizacao-cancelamento",
      kind: "ecommerce",
    });
    const group = support.upsertGroup({
      id: "cancel-migration-group",
      accountId: account.id,
      clientId: client.id,
      externalJid: "120363000028@g.us",
      subject: "Grupo de teste",
    });
    const participant = support.upsertParticipant({
      id: "cancel-migration-participant",
      externalJid: "5547999999928@s.whatsapp.net",
      displayName: "Pessoa solicitante",
    });
    support.addGroupParticipant(group.id, participant.id);
    const message = support.upsertMessage({
      id: "cancel-migration-message",
      externalId: "cancel-migration-message",
      groupId: group.id,
      senderId: participant.id,
      occurredAt: "2026-07-20T14:10:00.000Z",
      text: "Investigue este caso.",
      messageType: "text",
    });
    const ticket = support.createTicket({
      id: "cancel-migration-ticket",
      groupId: group.id,
      sourceMessageId: message.id,
      title: "Caso para investigação",
      summary: "Turno existente antes da migração.",
    });
    const timestamp = "2026-07-20T14:11:00.000Z";
    database
      .prepare(
        `INSERT INTO investigation_threads
          (id, ticket_id, status, summary, created_at, updated_at)
         VALUES ('cancel-migration-thread', ?, 'active', '', ?, ?)`,
      )
      .run(ticket.id, timestamp, timestamp);
    database
      .prepare(
        `INSERT INTO investigation_thread_messages
          (id, thread_id, role, body, created_at)
         VALUES ('cancel-migration-operator', 'cancel-migration-thread',
                 'operator', 'Continue investigando.', ?)`,
      )
      .run(timestamp);
    database
      .prepare(
        `INSERT INTO investigation_thread_jobs
          (id, thread_id, operator_message_id, state, requested_at,
           started_at, claimed_at, lease_expires_at, attempt_count)
         VALUES ('cancel-migration-job', 'cancel-migration-thread',
                 'cancel-migration-operator', 'running', ?, ?, ?, ?, 1)`,
      )
      .run(
        timestamp,
        timestamp,
        timestamp,
        "2026-07-20T14:21:00.000Z",
      );

    migrateDatabase(database);
    migrateDatabase(database);

    const row = database
      .prepare(
        `SELECT state, cancelled_at, cancelled_by
         FROM investigation_thread_jobs WHERE id = 'cancel-migration-job'`,
      )
      .get() as {
      state: string;
      cancelled_at: string | null;
      cancelled_by: string | null;
    };
    assert.deepEqual(row, {
      state: "running",
      cancelled_at: null,
      cancelled_by: null,
    });
    assert.equal(
      (
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM schema_migrations WHERE name = ?`,
          )
          .get(CANCELLATION_MIGRATION_NAME) as { count: number }
      ).count,
      1,
    );
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }
});
