import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import {
  migrateDatabase,
  migrations,
  type SupportDatabase,
} from "../server/db/index.js";

const MIGRATION_NAME = "threadmark_ai_user_ownership";

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
  assert.ok(target, "a migração de propriedade do Threadmark AI deve existir");
  for (const migration of migrations.filter(
    (candidate) => candidate.version < target.version,
  )) {
    if (migration.disableForeignKeys) database.pragma("foreign_keys = OFF");
    try {
      database.transaction(() => {
        database.exec(migration.sql);
        database
          .prepare(
            `INSERT INTO schema_migrations (version, name, applied_at)
             VALUES (?, ?, ?)`,
          )
          .run(migration.version, migration.name, "2026-08-28T12:00:00.000Z");
      })();
    } finally {
      if (migration.disableForeignKeys) {
        database.pragma("legacy_alter_table = OFF");
        database.pragma("foreign_keys = ON");
      }
    }
  }
  return database;
}

test("migração atribui apenas conversas antigas de um único usuário", () => {
  const database = databaseBeforeMigration();
  try {
    database
      .prepare(
        `INSERT INTO local_users (
           id, username, display_name, role, password_hash, active,
           password_changed_at, created_at, updated_at
         ) VALUES (?, ?, ?, 'owner', ?, 1, ?, ?, ?)`,
      )
      .run(
        "user-one",
        "operator_one",
        "Operador Um",
        "hash-de-teste",
        "2026-08-28T12:00:00.000Z",
        "2026-08-28T12:00:00.000Z",
        "2026-08-28T12:00:00.000Z",
      );
    database
      .prepare(
        `INSERT INTO local_users (
           id, username, display_name, role, password_hash, active,
           password_changed_at, created_at, updated_at
         ) VALUES (?, ?, ?, 'operator', ?, 1, ?, ?, ?)`,
      )
      .run(
        "user-two",
        "operator_two",
        "Operador Dois",
        "hash-de-teste",
        "2026-08-28T12:00:00.000Z",
        "2026-08-28T12:00:00.000Z",
        "2026-08-28T12:00:00.000Z",
      );
    database
      .prepare(
        `INSERT INTO investigation_threads (
           id, ticket_id, scope, title, context_json, created_by, status,
           summary, created_at, updated_at
         ) VALUES (?, NULL, 'workspace', ?, '{}', ?, 'active', '', ?, ?)`,
      )
      .run(
        "legacy-thread",
        "Conversa existente",
        "Operador Um",
        "2026-08-28T12:01:00.000Z",
        "2026-08-28T12:01:00.000Z",
      );
    database
      .prepare(
        `INSERT INTO investigation_thread_messages (
           id, thread_id, role, body, context_json, actor_user_id, actor_role,
           created_at
         ) VALUES (?, ?, 'operator', ?, '{}', ?, 'owner', ?)`,
      )
      .run(
        "legacy-message",
        "legacy-thread",
        "Investigue este caso",
        "user-one",
        "2026-08-28T12:01:00.000Z",
      );
    database
      .prepare(
        `INSERT INTO investigation_threads (
           id, ticket_id, scope, title, context_json, created_by, status,
           summary, created_at, updated_at
         ) VALUES (?, NULL, 'workspace', ?, '{}', ?, 'active', '', ?, ?)`,
      )
      .run(
        "legacy-thread-without-actor",
        "Conversa anterior à autoria de mensagens",
        "Operador Dois",
        "2026-08-28T12:02:00.000Z",
        "2026-08-28T12:02:00.000Z",
      );
    database
      .prepare(
        `INSERT INTO investigation_threads (
           id, ticket_id, scope, title, context_json, created_by, status,
           summary, created_at, updated_at
         ) VALUES (?, NULL, 'workspace', ?, '{}', ?, 'active', '', ?, ?)`,
      )
      .run(
        "legacy-shared-thread",
        "Conversa compartilhada antiga",
        "Operador Um",
        "2026-08-28T12:03:00.000Z",
        "2026-08-28T12:03:00.000Z",
      );
    const insertSharedMessage = database.prepare(
      `INSERT INTO investigation_thread_messages (
         id, thread_id, role, body, context_json, actor_user_id, actor_role,
         created_at
       ) VALUES (?, 'legacy-shared-thread', 'operator', ?, '{}', ?, ?, ?)`,
    );
    insertSharedMessage.run(
      "shared-message-one",
      "Mensagem do operador um",
      "user-one",
      "owner",
      "2026-08-28T12:03:00.000Z",
    );
    insertSharedMessage.run(
      "shared-message-two",
      "Mensagem do operador dois",
      "user-two",
      "operator",
      "2026-08-28T12:04:00.000Z",
    );

    migrateDatabase(database);

    const migratedReadState = database
      .prepare(
        `SELECT last_viewed_at, updated_at
         FROM investigation_threads WHERE id = 'legacy-thread'`,
      )
      .get() as { last_viewed_at: string | null; updated_at: string };
    assert.equal(migratedReadState.last_viewed_at, migratedReadState.updated_at);

    assert.deepEqual(
      database
        .prepare(
          `SELECT created_by_user_id
           FROM investigation_threads WHERE id = 'legacy-thread'`,
        )
        .get(),
      { created_by_user_id: "user-one" },
    );
    assert.deepEqual(
      database
        .prepare(
          `SELECT created_by_user_id
           FROM investigation_threads
           WHERE id = 'legacy-thread-without-actor'`,
        )
        .get(),
      { created_by_user_id: "user-two" },
    );
    assert.deepEqual(
      database
        .prepare(
          `SELECT created_by_user_id
           FROM investigation_threads WHERE id = 'legacy-shared-thread'`,
        )
        .get(),
      { created_by_user_id: null },
    );
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }
});
