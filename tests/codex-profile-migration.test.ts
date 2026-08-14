import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { migrations } from "../server/db/schema.js";

function databaseAt(version: number): Database.Database {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  for (const migration of migrations.filter((item) => item.version <= version)) {
    database.exec(migration.sql);
    database
      .prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      )
      .run(migration.version, migration.name, "2026-07-18T12:00:00.000Z");
  }
  return database;
}

function applyMigration21(database: Database.Database): void {
  const migration = migrations.find((item) => item.version === 21);
  assert.ok(migration);
  database.exec(migration.sql);
}

test("migração 21 restaura somente perfis Codex desativados pela migração de segurança", () => {
  const database = databaseAt(20);
  try {
    const before = database
      .prepare(
        `SELECT task_kind, connection_id, enabled, updated_by
         FROM ai_task_profiles ORDER BY task_kind`,
      )
      .all();
    assert.deepEqual(before, [
      { task_kind: "automatic", connection_id: null, enabled: 0, updated_by: "security-migration" },
      { task_kind: "deep", connection_id: "builtin-codex", enabled: 1, updated_by: "migration" },
      { task_kind: "triage", connection_id: null, enabled: 0, updated_by: "security-migration" },
    ]);

    applyMigration21(database);

    const restored = database
      .prepare(
        `SELECT task_kind, connection_id, enabled
         FROM ai_task_profiles ORDER BY task_kind`,
      )
      .all();
    assert.deepEqual(restored, [
      { task_kind: "automatic", connection_id: "builtin-codex", enabled: 1 },
      { task_kind: "deep", connection_id: "builtin-codex", enabled: 1 },
      { task_kind: "triage", connection_id: "builtin-codex", enabled: 1 },
    ]);
    assert.deepEqual(
      database
        .prepare("SELECT enabled, model FROM triage_ai_settings WHERE singleton = 1")
        .get(),
      { enabled: 1, model: "default" },
    );
  } finally {
    database.close();
  }
});

test("migração 21 preserva perfil que o operador desativou depois da migração de segurança", () => {
  const database = databaseAt(20);
  try {
    database
      .prepare(
        `UPDATE ai_task_profiles
         SET updated_by = 'owner-local'
         WHERE task_kind = 'automatic'`,
      )
      .run();

    applyMigration21(database);

    assert.deepEqual(
      database
        .prepare(
          `SELECT connection_id, enabled, updated_by
           FROM ai_task_profiles WHERE task_kind = 'automatic'`,
        )
        .get(),
      { connection_id: null, enabled: 0, updated_by: "owner-local" },
    );
  } finally {
    database.close();
  }
});
