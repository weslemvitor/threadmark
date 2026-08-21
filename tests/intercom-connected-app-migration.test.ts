import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { migrateDatabase, migrations } from "../server/db/index.js";

test("migração transforma a antiga API de artigos em conexão nativa do Intercom", () => {
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
    for (const migration of migrations.filter((item) => item.version < 55)) {
      if (migration.disableForeignKeys) database.pragma("foreign_keys = OFF");
      database.transaction(() => {
        database.exec(migration.sql);
        database.prepare(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        ).run(migration.version, migration.name, "2026-08-20T17:00:00.000Z");
      })();
      if (migration.disableForeignKeys) database.pragma("foreign_keys = ON");
    }
    database.prepare(`
      INSERT INTO connected_apps (
        id, provider_type, name, description, enabled, config_json,
        secret_ref, secret_configured, last_tested_at, last_test_status,
        last_test_message, created_by, updated_by, created_at, updated_at, ai_enabled
      ) VALUES (
        'intercom-legacy', 'custom_http', 'Intercom', NULL, 1, ?,
        'connected-app:intercom-legacy:credential', 1, NULL, NULL,
        NULL, 'Operador', 'Operador', '2026-08-20T17:00:00.000Z',
        '2026-08-20T17:00:00.000Z', 1
      )
    `).run(JSON.stringify({
      endpoint: "https://api.intercom.io/articles",
      endpointPreview: "https://api.intercom.io/articles",
      publicHeaders: [{ name: "Intercom-Version", value: "2.16" }],
    }));

    migrateDatabase(database);
    migrateDatabase(database);

    const row = database.prepare(`
      SELECT provider_type, config_json, ai_enabled, secret_configured
      FROM connected_apps WHERE id = 'intercom-legacy'
    `).get() as {
      provider_type: string;
      config_json: string;
      ai_enabled: number;
      secret_configured: number;
    };
    const config = JSON.parse(row.config_json) as { endpoint: string; endpointPreview: string };
    assert.equal(row.provider_type, "intercom");
    assert.equal(config.endpoint, "https://api.intercom.io/");
    assert.equal(config.endpointPreview, "https://api.intercom.io/");
    assert.equal(row.ai_enabled, 1);
    assert.equal(row.secret_configured, 1);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }
});
