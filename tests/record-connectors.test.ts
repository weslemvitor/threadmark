import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { RecordConnectorService } from "../server/connectors/record-connector-service.js";
import {
  createDatabase,
  migrateDatabase,
  migrations,
  type SupportDatabase,
} from "../server/db/index.js";
import { DirectoryStore, SupportStore } from "../server/domain/index.js";
import { createTestApiApp } from "../server/index.js";
import { LocalSecretVault } from "../server/runtime/secret-vault.js";
import type {
  ExecuteRecordConnectorResponse,
  RecordConnectorDto,
} from "../shared/contracts.js";

function seedTicket(database: SupportDatabase) {
  const support = new SupportStore(database);
  const account = support.upsertAccount({
    id: "connector-account",
    phoneNumber: "+5547000000000",
    displayName: "Conta local",
  });
  const client = support.upsertClient({
    id: "connector-client",
    name: "Organização de teste",
    slug: "organizacao-de-teste",
    kind: "ecommerce",
  });
  const group = support.upsertGroup({
    id: "connector-group",
    accountId: account.id,
    clientId: client.id,
    externalJid: "120363000035@g.us",
    subject: "Grupo de teste",
  });
  const participant = support.upsertParticipant({
    id: "connector-participant",
    externalJid: "5547999999999@s.whatsapp.net",
    displayName: "Pessoa solicitante",
  });
  support.addGroupParticipant(group.id, participant.id);
  const message = support.upsertMessage({
    id: "connector-message",
    externalId: "connector-message",
    groupId: group.id,
    senderId: participant.id,
    occurredAt: "2026-07-24T15:00:00.000Z",
    text: "Precisamos permitir OAuth no Magento.",
    messageType: "text",
    triageKind: "demand",
  });
  const ticket = support.createTicket({
    id: "connector-ticket",
    groupId: group.id,
    sourceMessageId: message.id,
    title: "OAuth para Magento",
    summary: "Cliente precisa integrar o Magento sem desabilitar o MFA.",
  });
  return { support, ticket };
}

test("migração 35 cria conectores agnósticos e auditoria de execução", () => {
  const target = migrations.find(
    (migration) => migration.name === "agnostic_record_connectors",
  );
  assert.ok(target);
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  try {
    for (const migration of migrations.filter(
      (migration) => migration.version < target.version,
    )) {
      database.exec(migration.sql);
      database
        .prepare(
          `INSERT INTO schema_migrations (version, name, applied_at)
           VALUES (?, ?, ?)`,
        )
        .run(migration.version, migration.name, "2026-07-24T15:00:00.000Z");
    }
    migrateDatabase(database);
    migrateDatabase(database);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    assert.deepEqual(
      database
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table'
             AND name IN ('record_connectors', 'record_connector_executions')
           ORDER BY name`,
        )
        .all(),
      [
        { name: "record_connector_executions" },
        { name: "record_connectors" },
      ],
    );
  } finally {
    database.close();
  }
});

test("execução HTTP cria um registro real do Diretório e o vincula ao ticket", async () => {
  const database = createDatabase(":memory:");
  const secretsDirectory = await mkdtemp(
    path.join(tmpdir(), "threadmark-record-connectors-"),
  );
  try {
    const { support, ticket } = seedTicket(database);
    const directory = new DirectoryStore(database);
    const recordType = directory.createRecordType({
      name: "Card externo",
      pluralName: "Cards externos",
      slug: "card-externo",
    });
    const urlField = directory.createField({
      recordTypeId: recordType.id,
      key: "url",
      label: "URL",
      type: "url",
      required: true,
    });
    const statusField = directory.createField({
      recordTypeId: recordType.id,
      key: "status",
      label: "Status",
      type: "text",
      required: false,
    });

    let calls = 0;
    const service = new RecordConnectorService(
      database,
      support,
      new LocalSecretVault(secretsDirectory),
      (async (_input, init) => {
        calls += 1;
        assert.equal(init?.method, "POST");
        assert.equal(
          new Headers(init?.headers).get("Authorization"),
          "Bearer secret-linear-token",
        );
        assert.deepEqual(JSON.parse(String(init?.body)), {
          title: "OAuth Magento",
          description:
            "Cliente precisa integrar o Magento sem desabilitar o MFA.",
        });
        return new Response(
          JSON.stringify({
            identifier: "ADS-56",
            title: "OAuth Magento",
            url: "https://linear.app/example/issue/APP-56/oauth-magento",
            state: { name: "Done" },
          }),
          {
            status: 201,
            headers: { "content-type": "application/json" },
          },
        );
      }) as typeof fetch,
    );
    const created = await service.create(
      {
        name: "Criar card",
        description: "Cria um card em qualquer API compatível.",
        method: "POST",
        urlTemplate: "https://api.linear.app/issues",
        headersTemplate:
          '{"Authorization":"Bearer {{token}}"}',
        bodyTemplate:
          '{"title":"{{input.title}}","description":"{{ticket.summary}}"}',
        targetRecordTypeId: recordType.id,
        recordNamePath: "response.identifier",
        recordDescriptionPath: "response.title",
        inputFields: [
          {
            key: "title",
            label: "Título",
            type: "text",
            required: true,
            placeholder: null,
          },
        ],
        fieldMappings: [
          { fieldId: urlField.id, valuePath: "response.url" },
          { fieldId: statusField.id, valuePath: "response.state.name" },
        ],
        token: "secret-linear-token",
      },
      "Operador de teste",
    );
    assert.equal(created.hasToken, true);
    assert.equal(created.tokenLastFour, "oken");
    assert.doesNotMatch(JSON.stringify(created), /secret-linear-token/);
    assert.doesNotMatch(
      JSON.stringify(
        database
          .prepare("SELECT * FROM record_connectors WHERE id = ?")
          .get(created.id),
      ),
      /secret-linear-token/,
    );

    const app = createTestApiApp(support, undefined, undefined, {
      recordConnectors: service,
    });
    const catalogResponse = await app.request("/api/record-connectors");
    assert.equal(catalogResponse.status, 200);
    assert.equal(
      ((await catalogResponse.json()) as { items: RecordConnectorDto[] }).items
        .length,
      1,
    );

    const execute = () =>
      app.request(
        `/api/tickets/${ticket.id}/record-connectors/${created.id}/execute`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            clientRequestId: "create-card-1",
            values: { title: "OAuth Magento" },
          }),
        },
      );
    const response = await execute();
    assert.equal(response.status, 200);
    const result = (await response.json()) as ExecuteRecordConnectorResponse;
    assert.equal(result.httpStatus, 201);
    assert.equal(result.record.name, "ADS-56");
    assert.equal(
      result.record.values[urlField.id],
      "https://linear.app/example/issue/APP-56/oauth-magento",
    );
    assert.equal(result.record.values[statusField.id], "Done");
    assert.deepEqual(result.ticket.directoryContext.explicitRecordIds, [
      result.record.id,
    ]);
    assert.equal(
      result.ticket.directoryContext.records[0]?.name,
      "ADS-56",
    );

    const repeated = await execute();
    assert.equal(repeated.status, 200);
    assert.equal(calls, 1, "o clientRequestId deve impedir criação duplicada");
    assert.equal(
      (
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM record_connector_executions",
          )
          .get() as { count: number }
      ).count,
      1,
    );
  } finally {
    database.close();
    await rm(secretsDirectory, { recursive: true, force: true });
  }
});
