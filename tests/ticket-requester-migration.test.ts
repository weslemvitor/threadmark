import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import {
  migrateDatabase,
  migrations,
  type SupportDatabase,
} from "../server/db/index.js";

const MIGRATION_NAME = "editable_ticket_requester";

test("migração adiciona solicitante editável sem alterar tickets existentes", () => {
  const database = new Database(":memory:") as SupportDatabase;
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

  try {
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
          .run(migration.version, migration.name, "2026-07-23T13:00:00.000Z");
      })();
    }

    database.exec(`
      INSERT INTO whatsapp_accounts
        (id, phone_number, display_name, created_at, updated_at)
      VALUES
        ('account', '+5547999999999', 'Conta local',
         '2026-07-23T13:00:00.000Z', '2026-07-23T13:00:00.000Z');
      INSERT INTO clients
        (id, name, slug, kind, created_at, updated_at)
      VALUES
        ('client', 'Organização', 'organizacao', 'agency',
         '2026-07-23T13:00:00.000Z', '2026-07-23T13:00:00.000Z');
      INSERT INTO whatsapp_groups
        (id, account_id, client_id, external_jid, subject, created_at, updated_at)
      VALUES
        ('group', 'account', 'client', '120363000033@g.us', 'Grupo',
         '2026-07-23T13:00:00.000Z', '2026-07-23T13:00:00.000Z');
      INSERT INTO tickets
        (number, id, client_id, group_id, title, summary, status, priority,
         needs_review, first_message_at, last_message_at, created_at, updated_at)
      VALUES
        (1, 'ticket', 'client', 'group', 'Título preservado',
         'Descrição preservada', 'triage', 'normal', 1,
         '2026-07-23T13:00:00.000Z', '2026-07-23T13:00:00.000Z',
         '2026-07-23T13:00:00.000Z', '2026-07-23T13:00:00.000Z');
    `);

    migrateDatabase(database);

    const columns = database
      .prepare("PRAGMA table_info(tickets)")
      .all() as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === "requester_id"));
    assert.deepEqual(
      database
        .prepare(
          "SELECT title, summary, requester_id FROM tickets WHERE id = 'ticket'",
        )
        .get(),
      {
        title: "Título preservado",
        summary: "Descrição preservada",
        requester_id: null,
      },
    );
  } finally {
    database.close();
  }
});
