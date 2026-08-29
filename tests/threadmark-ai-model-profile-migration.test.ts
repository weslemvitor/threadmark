import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import {
  migrateDatabase,
  migrations,
  type SupportDatabase,
} from "../server/db/index.js";

const MIGRATION_NAME = "threadmark_ai_models_by_workload";

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
  assert.ok(target);
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

test("migração cria o perfil rápido a partir do mesmo provedor e modelo profundo", () => {
  const database = databaseBeforeMigration();
  try {
    database
      .prepare(
        `INSERT INTO ai_provider_connections (
           id, provider_id, label, base_url, secret_ref, secret_last_four,
           enabled, config_json, created_by, updated_by, created_at, updated_at
         ) VALUES (?, 'ollama', ?, ?, NULL, NULL, 1, '{}', ?, ?, ?, ?)`,
      )
      .run(
        "ollama-local",
        "Ollama local",
        "http://127.0.0.1:11434/api",
        "owner",
        "owner",
        "2026-08-28T12:00:00.000Z",
        "2026-08-28T12:00:00.000Z",
      );
    database
      .prepare(
        `UPDATE ai_task_profiles
         SET connection_id = ?, model = ?, enabled = 1, updated_by = ?
         WHERE task_kind = 'deep'`,
      )
      .run("ollama-local", "qwen-local", "owner");

    migrateDatabase(database);

    assert.deepEqual(
      database
        .prepare(
          `SELECT task_kind, connection_id, model, enabled
           FROM ai_task_profiles WHERE task_kind IN ('quick', 'deep')
           ORDER BY task_kind`,
        )
        .all(),
      [
        {
          task_kind: "deep",
          connection_id: "ollama-local",
          model: "qwen-local",
          enabled: 1,
        },
        {
          task_kind: "quick",
          connection_id: "ollama-local",
          model: "qwen-local",
          enabled: 1,
        },
      ],
    );
    const jobColumns = database.pragma(
      "table_info(investigation_thread_jobs)",
    ) as Array<{ name: string }>;
    assert.ok(jobColumns.some((column) => column.name === "ai_workload"));
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }
});
