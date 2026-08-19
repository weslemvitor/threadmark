import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { migrateDatabase, migrations } from "../server/db/index.js";

const MIGRATION_NAME = "single_current_automation_definition";
const DRY_RUN_MIGRATION_NAME = "remove_persisted_automation_dry_runs";

test("migração consolida a definição atual e preserva snapshot somente em execuções abertas", () => {
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
    const target = migrations.find((migration) => migration.name === MIGRATION_NAME);
    assert.ok(target);
    for (const migration of migrations.filter((candidate) => candidate.version < target.version)) {
      database.transaction(() => {
        database.exec(migration.sql);
        database.prepare(`
          INSERT INTO schema_migrations (version, name, applied_at)
          VALUES (?, ?, '2026-08-19T10:00:00.000Z')
        `).run(migration.version, migration.name);
      })();
    }

    database.prepare(`
      INSERT INTO automation_workflows (
        id, name, description, status, current_version,
        created_by, updated_by, created_at, updated_at
      ) VALUES (
        'archive-flow', 'Arquivar tickets', NULL, 'active', 3,
        'Operador', 'Operador', '2026-08-19T10:00:00.000Z', '2026-08-19T12:00:00.000Z'
      )
    `).run();
    const insertVersion = database.prepare(`
      INSERT INTO automation_workflow_versions (
        workflow_id, version, definition_json, created_by, created_at
      ) VALUES ('archive-flow', ?, ?, 'Operador', ?)
    `);
    insertVersion.run(1, definition("old-action"), "2026-08-19T10:00:00.000Z");
    insertVersion.run(2, definition("running-action"), "2026-08-19T11:00:00.000Z");
    insertVersion.run(3, definition("current-action"), "2026-08-19T12:00:00.000Z");

    const insertRun = database.prepare(`
      INSERT INTO automation_runs (
        id, workflow_id, workflow_version, event_id, idempotency_key,
        status, input_json, created_at, updated_at, finished_at
      ) VALUES (?, 'archive-flow', ?, NULL, ?, ?, '{}', ?, ?, ?)
    `);
    insertRun.run(
      "open-run",
      2,
      "open-run-key",
      "waiting",
      "2026-08-19T11:30:00.000Z",
      "2026-08-19T11:30:00.000Z",
      null,
    );
    insertRun.run(
      "completed-run",
      3,
      "completed-run-key",
      "completed",
      "2026-08-19T12:10:00.000Z",
      "2026-08-19T12:11:00.000Z",
      "2026-08-19T12:11:00.000Z",
    );

    migrateDatabase(database);
    migrateDatabase(database);

    const workflow = database.prepare(`
      SELECT current_version FROM automation_workflows WHERE id = 'archive-flow'
    `).get() as { current_version: number };
    assert.equal(workflow.current_version, 1);
    const versions = database.prepare(`
      SELECT version, definition_json
      FROM automation_workflow_versions
      WHERE workflow_id = 'archive-flow'
    `).all() as Array<{ version: number; definition_json: string }>;
    assert.deepEqual(versions, [{ version: 1, definition_json: definition("current-action") }]);

    const runs = database.prepare(`
      SELECT id, workflow_version, definition_json
      FROM automation_runs
      ORDER BY id
    `).all() as Array<{
      id: string;
      workflow_version: number;
      definition_json: string | null;
    }>;
    assert.deepEqual(runs, [
      { id: "completed-run", workflow_version: 1, definition_json: null },
      { id: "open-run", workflow_version: 1, definition_json: definition("running-action") },
    ]);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }
});

test("migração remove somente Dry Runs persistidos e preserva execuções reais", () => {
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
    const target = migrations.find(
      (migration) => migration.name === DRY_RUN_MIGRATION_NAME,
    );
    assert.ok(target);
    for (const migration of migrations.filter((candidate) => candidate.version < target.version)) {
      database.transaction(() => {
        database.exec(migration.sql);
        database.prepare(`
          INSERT INTO schema_migrations (version, name, applied_at)
          VALUES (?, ?, '2026-08-19T10:00:00.000Z')
        `).run(migration.version, migration.name);
      })();
    }

    database.prepare(`
      INSERT INTO automation_workflows (
        id, name, description, status, current_version,
        created_by, updated_by, created_at, updated_at
      ) VALUES (
        'dry-run-cleanup', 'Limpar testes', NULL, 'active', 1,
        'Operador', 'Operador', '2026-08-19T10:00:00.000Z', '2026-08-19T10:00:00.000Z'
      )
    `).run();
    database.prepare(`
      INSERT INTO automation_workflow_versions (
        workflow_id, version, definition_json, created_by, created_at
      ) VALUES (
        'dry-run-cleanup', 1, ?, 'Operador', '2026-08-19T10:00:00.000Z'
      )
    `).run(definition("notify"));
    const insertRun = database.prepare(`
      INSERT INTO automation_runs (
        id, workflow_id, workflow_version, event_id, idempotency_key,
        status, input_json, created_at, updated_at, finished_at
      ) VALUES (?, 'dry-run-cleanup', 1, NULL, ?, 'completed', ?, ?, ?, ?)
    `);
    insertRun.run(
      "dry-run",
      "dry-run:key",
      JSON.stringify({ dryRun: true }),
      "2026-08-19T10:01:00.000Z",
      "2026-08-19T10:01:00.000Z",
      "2026-08-19T10:01:00.000Z",
    );
    insertRun.run(
      "real-run",
      "real-run:key",
      JSON.stringify({ ticketId: "ticket-example" }),
      "2026-08-19T10:02:00.000Z",
      "2026-08-19T10:02:00.000Z",
      "2026-08-19T10:02:00.000Z",
    );

    migrateDatabase(database);
    migrateDatabase(database);

    assert.deepEqual(
      database.prepare(`SELECT id FROM automation_runs ORDER BY id`).all(),
      [{ id: "real-run" }],
    );
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }
});

function definition(actionId: string): string {
  return JSON.stringify({
    nodes: [
      { id: "trigger", type: "trigger", config: { eventType: "ticket_resolved" } },
      { id: actionId, type: "internal_action", config: { actionId } },
    ],
    edges: [{ id: "edge", source: "trigger", target: actionId }],
  });
}
