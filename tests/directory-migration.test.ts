import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import {
  createDatabase,
  migrateDatabase,
  migrations,
  type SupportDatabase,
} from "../server/db/index.js";
import { DirectoryStore, SupportStore } from "../server/domain/index.js";

const DIRECTORY_MIGRATION_NAME = "agnostic_directory_records";

function directoryMigration() {
  const migration = migrations.find(
    (candidate) => candidate.name === DIRECTORY_MIGRATION_NAME,
  );
  assert.ok(migration, "a migração do Diretório deve existir");
  return migration;
}

function databaseBeforeDirectory(): SupportDatabase {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const target = directoryMigration();
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
        .run(migration.version, migration.name, "2026-07-19T12:00:00.000Z");
    })();
  }
  return database;
}

test("instalação nova começa agnóstica, somente com o tipo Organização", () => {
  const database = createDatabase(":memory:");
  try {
    const snapshot = new DirectoryStore(database).getSnapshot();

    assert.deepEqual(
      snapshot.recordTypes.map((recordType) => ({
        name: recordType.name,
        pluralName: recordType.pluralName,
        system: recordType.system,
      })),
      [{ name: "Organização", pluralName: "Organizações", system: true }],
    );
    assert.equal(snapshot.records.length, 0);
    assert.equal(snapshot.recordTypes.some((type) => type.name === "Agência"), false);
    assert.equal(snapshot.recordTypes.some((type) => type.name === "Ecommerce"), false);
  } finally {
    database.close();
  }
});

test("migração preserva o legado significativo sem transformar fallback 1:1 em cadastro", () => {
  const database = databaseBeforeDirectory();
  try {
    const support = new SupportStore(database);
    const account = support.upsertAccount({
      id: "legacy-account",
      phoneNumber: "+5547000000000",
      displayName: "Conta local",
    });

    const fallback = support.upsertClient({
      id: "fallback-client",
      name: "Grupo 120363000001",
      slug: "grupo-120363000001",
      kind: "ecommerce",
    });
    const fallbackGroup = support.upsertGroup({
      id: "fallback-group",
      accountId: account.id,
      clientId: fallback.id,
      externalJid: "120363000001@g.us",
      subject: "Grupo sem classificação manual",
    });

    const meaningful = support.upsertClient({
      id: "meaningful-client",
      name: "Operação Sul",
      slug: "operacao-sul",
      kind: "ecommerce",
      notes: "Cadastro revisado manualmente.",
    });
    database
      .prepare("UPDATE clients SET manual_override = 1 WHERE id = ?")
      .run(meaningful.id);
    const meaningfulGroup = support.upsertGroup({
      id: "meaningful-group",
      accountId: account.id,
      clientId: meaningful.id,
      externalJid: "120363000002@g.us",
      subject: "Atendimento da Operação Sul",
    });
    const participant = support.upsertParticipant({
      id: "meaningful-person",
      externalJid: "5547999999999@s.whatsapp.net",
      phoneE164: "+5547999999999",
      displayName: "Pessoa externa",
    });
    support.addGroupParticipant(meaningfulGroup.id, participant.id);
    const message = support.upsertMessage({
      id: "meaningful-message",
      externalId: "legacy-directory-message",
      groupId: meaningfulGroup.id,
      senderId: participant.id,
      occurredAt: "2026-07-19T12:10:00.000Z",
      text: "Preciso de ajuda com o painel.",
      messageType: "text",
      triageKind: "demand",
    });
    const ticket = support.createTicket({
      id: "meaningful-ticket",
      groupId: meaningfulGroup.id,
      sourceMessageId: message.id,
      title: "Dúvida sobre o painel",
      summary: "Pessoa relata uma dúvida no painel.",
    });

    migrateDatabase(database);
    migrateDatabase(database);

    const snapshot = new DirectoryStore(database).getSnapshot();
    const migrated = snapshot.records.find(
      (record) => record.legacyClientId === meaningful.id,
    );
    assert.ok(migrated);
    assert.equal(migrated.name, "Operação Sul");
    assert.deepEqual(migrated.groupIds, [meaningfulGroup.id]);
    assert.equal(migrated.ticketCount, 1);

    assert.equal(
      snapshot.records.some((record) => record.legacyClientId === fallback.id),
      false,
      "um cliente técnico criado apenas para satisfazer o legado 1:1 não vira registro",
    );
    assert.ok(snapshot.groups.some((group) => group.id === fallbackGroup.id));
    assert.ok(snapshot.groups.some((group) => group.id === meaningfulGroup.id));
    assert.ok(snapshot.people.some((person) => person.id === participant.id));

    assert.deepEqual(
      database
        .prepare("SELECT id, name FROM clients ORDER BY id")
        .all(),
      [
        { id: fallback.id, name: "Grupo 120363000001" },
        { id: meaningful.id, name: "Operação Sul" },
      ],
    );
    assert.equal(
      (
        database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM ticket_record_links
             WHERE ticket_id = ? AND record_id = ? AND archived_at IS NULL`,
          )
          .get(ticket.id, migrated.id) as { count: number }
      ).count,
      1,
    );
    assert.equal(
      (
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM schema_migrations
             WHERE name = ?`,
          )
          .get(DIRECTORY_MIGRATION_NAME) as { count: number }
      ).count,
      1,
    );
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }
});

test("migração mantém agência e seus ecommerces como registros relacionados", () => {
  const database = databaseBeforeDirectory();
  try {
    const support = new SupportStore(database);
    const account = support.upsertAccount({
      id: "agency-account",
      phoneNumber: "+5547111111111",
      displayName: "Conta local",
    });
    const agency = support.upsertClient({
      id: "legacy-agency",
      name: "Parceiro Norte",
      slug: "parceiro-norte",
      kind: "agency",
    });
    database
      .prepare("UPDATE clients SET manual_override = 1 WHERE id = ?")
      .run(agency.id);
    const store = support.upsertStore({
      id: "legacy-store",
      clientId: agency.id,
      name: "Loja Azul",
      businessId: "business-blue",
      platform: "Shopify",
    });
    const group = support.upsertGroup({
      id: "agency-group",
      accountId: account.id,
      clientId: agency.id,
      externalJid: "120363000003@g.us",
      subject: "Parceiro Norte + Loja Azul",
    });

    migrateDatabase(database);

    const snapshot = new DirectoryStore(database).getSnapshot();
    const agencyRecord = snapshot.records.find(
      (record) => record.legacyClientId === agency.id,
    );
    const storeRecord = snapshot.records.find(
      (record) => record.name === "Loja Azul",
    );
    assert.ok(agencyRecord);
    assert.ok(storeRecord);
    assert.deepEqual(agencyRecord.groupIds, [group.id]);
    assert.ok(agencyRecord.relatedRecordIds.includes(storeRecord.id));
    assert.ok(storeRecord.relatedRecordIds.includes(agencyRecord.id));
    assert.equal(
      snapshot.recordTypes.find((type) => type.id === agencyRecord.typeId)?.name,
      "Agência",
    );
    assert.equal(
      snapshot.recordTypes.find((type) => type.id === storeRecord.typeId)?.name,
      "Ecommerce",
    );
    assert.equal(
      (
        database
          .prepare("SELECT COUNT(*) AS count FROM client_stores WHERE id = ?")
          .get(store.id) as { count: number }
      ).count,
      1,
    );
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }
});
