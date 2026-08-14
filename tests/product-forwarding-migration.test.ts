import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import {
  migrateDatabase,
  migrations,
  type SupportDatabase,
} from "../server/db/index.js";
import { ConflictError, SupportStore } from "../server/domain/index.js";

const PRODUCT_FORWARDING_MIGRATION_NAME = "ticket_product_forwardings";

function productForwardingMigration() {
  const migration = migrations.find(
    (candidate) => candidate.name === PRODUCT_FORWARDING_MIGRATION_NAME,
  );
  assert.ok(migration, "a migração de encaminhamento ao Produto deve existir");
  return migration;
}

function databaseBeforeProductForwarding(): SupportDatabase {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const target = productForwardingMigration();
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
        .run(migration.version, migration.name, "2026-07-20T12:00:00.000Z");
    })();
  }
  return database;
}

function createTicket(support: SupportStore) {
  const account = support.upsertAccount({
    id: "product-account",
    phoneNumber: "+5547000000000",
    displayName: "Conta local",
  });
  const client = support.upsertClient({
    id: "product-client",
    name: "Organização de teste",
    slug: "organizacao-de-teste",
    kind: "ecommerce",
  });
  const group = support.upsertGroup({
    id: "product-group",
    accountId: account.id,
    clientId: client.id,
    externalJid: "120363000027@g.us",
    subject: "Grupo de teste",
  });
  const participant = support.upsertParticipant({
    id: "product-participant",
    externalJid: "5547999999999@s.whatsapp.net",
    phoneE164: "+5547999999999",
    displayName: "Pessoa solicitante",
  });
  support.addGroupParticipant(group.id, participant.id);
  const message = support.upsertMessage({
    id: "product-message",
    externalId: "product-message-external",
    groupId: group.id,
    senderId: participant.id,
    occurredAt: "2026-07-20T12:10:00.000Z",
    text: "O total do dashboard está incorreto.",
    messageType: "text",
    triageKind: "demand",
  });
  return support.createTicket({
    id: "product-ticket",
    groupId: group.id,
    sourceMessageId: message.id,
    title: "Total incorreto no dashboard",
    summary: "Pessoa relata divergência na métrica total.",
  });
}

test("migração adiciona encaminhamento editável e compatível com banco anterior", () => {
  const database = databaseBeforeProductForwarding();
  try {
    const support = new SupportStore(database);
    const ticket = createTicket(support);

    assert.equal(
      support.getTicketDetail(ticket.id).productForwarding,
      null,
      "a leitura de um banco anterior deve continuar funcionando",
    );

    migrateDatabase(database);
    migrateDatabase(database);

    const created = support.upsertTicketProductForwarding(
      ticket.id,
      {
        kind: "bug",
        title: "Regra incorreta na métrica total",
        description: "Revisar a deduplicação entre novos e recorrentes.",
        externalReference: "PROD-27",
      },
      "Pessoa operadora",
    );
    assert.equal(created.productForwarding?.kind, "bug");
    assert.equal(created.productForwarding?.createdBy, "Pessoa operadora");
    assert.equal(created.productForwarding?.externalReference, "PROD-27");

    assert.equal(
      (
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM schema_migrations
             WHERE name = ?`,
          )
          .get(PRODUCT_FORWARDING_MIGRATION_NAME) as { count: number }
      ).count,
      1,
    );
    assert.deepEqual(database.pragma("foreign_key_check"), []);

    database.prepare("DELETE FROM tickets WHERE id = ?").run(ticket.id);
    assert.equal(
      (
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM ticket_product_forwardings WHERE ticket_id = ?",
          )
          .get(ticket.id) as { count: number }
      ).count,
      0,
      "o vínculo deve ser removido junto com o ticket",
    );
  } finally {
    database.close();
  }
});

test("encaminhamento com finalização não reabre ticket arquivado", () => {
  const database = databaseBeforeProductForwarding();
  try {
    migrateDatabase(database);
    const support = new SupportStore(database);
    const ticket = createTicket(support);

    support.updateTicketStatus(ticket.id, {
      status: "resolved",
      actor: "Pessoa operadora",
      resolution: {
        summary: "Caso encaminhado ao time responsável.",
        outcome: "Atendimento encerrado sem perda do vínculo.",
      },
    });
    support.updateTicketStatus(ticket.id, {
      status: "archived",
      actor: "Pessoa operadora",
    });

    assert.throws(
      () =>
        support.upsertTicketProductForwarding(
          ticket.id,
          {
            kind: "bug",
            title: "Regra incorreta na métrica total",
            description: "Revisar a deduplicação entre novos e recorrentes.",
            resolveTicket: true,
          },
          "Pessoa operadora",
        ),
      ConflictError,
    );

    assert.equal(support.getTicketDetail(ticket.id).status, "archived");
    assert.equal(
      (
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM ticket_product_forwardings WHERE ticket_id = ?",
          )
          .get(ticket.id) as { count: number }
      ).count,
      0,
      "a transação rejeitada não deve persistir um encaminhamento parcial",
    );
  } finally {
    database.close();
  }
});
