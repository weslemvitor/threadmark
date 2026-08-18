import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { migrateDatabase, migrations } from "../server/db/index.js";

const REMOVED_TABLES = [
  "record_connector_executions",
  "record_connectors",
  "ticket_record_links",
  "directory_record_links",
  "directory_field_values",
  "directory_group_links",
  "directory_person_links",
  "directory_segments",
  "directory_field_definitions",
  "directory_records",
  "directory_record_types",
];

test("migração remove registros e segmentos sem afetar grupos, pessoas e tickets", () => {
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
    for (const migration of migrations.filter((item) => item.version <= 38)) {
      database.transaction(() => {
        database.exec(migration.sql);
        database.prepare(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        ).run(migration.version, migration.name, "2026-08-18T14:00:00.000Z");
      })();
    }

    migrateDatabase(database);
    migrateDatabase(database);

    const placeholders = REMOVED_TABLES.map(() => "?").join(", ");
    const removedTables = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (${placeholders})
    `).all(...REMOVED_TABLES);
    assert.deepEqual(removedTables, []);

    const preservedTables = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('whatsapp_groups', 'participants', 'tickets')
      ORDER BY name
    `).all() as Array<{ name: string }>;
    assert.deepEqual(preservedTables.map((row) => row.name), [
      "participants",
      "tickets",
      "whatsapp_groups",
    ]);
    assert.equal(
      (database.prepare(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 39",
      ).get() as { count: number }).count,
      1,
    );
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }
});
