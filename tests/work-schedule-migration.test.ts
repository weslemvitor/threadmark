import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import { migrateDatabase, migrations } from "../server/db/index.js";

function applyMigrationsBeforeChannels(database: Database.Database): void {
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  for (const migration of migrations.filter(({ version }) => version < 74)) {
    if (migration.disableForeignKeys) database.pragma("foreign_keys = OFF");
    try {
      database.transaction(() => {
        database.exec(migration.sql);
        if (migration.disableForeignKeys) {
          const violations = database.pragma("foreign_key_check") as unknown[];
          assert.equal(violations.length, 0);
        }
        database
          .prepare(
            "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
          )
          .run(migration.version, migration.name, "2026-10-19T00:00:00.000Z");
      })();
    } finally {
      if (migration.disableForeignKeys) {
        database.pragma("legacy_alter_table = OFF");
        database.pragma("foreign_keys = ON");
      }
    }
  }
}

test("reconcilia a versão 74 antiga de horários e aplica a migration de canais", () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  try {
    applyMigrationsBeforeChannels(database);
    const legacySchedule = migrations.find(
      ({ name }) => name === "workspace_work_schedule",
    );
    assert.ok(legacySchedule);
    database.exec(legacySchedule.sql);
    database
      .prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      )
      .run(74, "workspace_work_schedule", "2026-10-19T00:00:00.000Z");

    migrateDatabase(database);

    assert.deepEqual(
      database
        .prepare(
          "SELECT version, name FROM schema_migrations WHERE version IN (74, 75) ORDER BY version",
        )
        .all(),
      [
        { version: 74, name: "configurable_inbound_channels" },
        { version: 75, name: "workspace_work_schedule" },
      ],
    );
    const settingsColumns = database.pragma(
      "table_info(local_app_settings)",
    ) as Array<{ name: string }>;
    assert.ok(settingsColumns.some(({ name }) => name === "work_schedule_json"));
    assert.equal(
      (database
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'channel_connections'",
        )
        .get() as { count: number }).count,
      1,
    );
  } finally {
    database.close();
  }
});
