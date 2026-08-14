import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import {
  migrateDatabase,
  migrations,
  type SupportDatabase,
} from "../server/db/index.js";
import { DirectoryStore, SupportStore } from "../server/domain/index.js";

const MIGRATION_NAME = "clean_placeholder_participant_identities";

function databaseBeforeCleanup(): SupportDatabase {
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
    database.transaction(() => {
      database.exec(migration.sql);
      database
        .prepare(
          `INSERT INTO schema_migrations (version, name, applied_at)
           VALUES (?, ?, ?)`,
        )
        .run(migration.version, migration.name, "2026-07-19T15:00:00.000Z");
    })();
  }
  return database;
}

function insertLegacyParticipant(
  database: SupportDatabase,
  input: {
    id: string;
    externalJid: string;
    displayName: string;
    phoneE164?: string | null;
  },
): void {
  database
    .prepare(
      `INSERT INTO participants
        (id, external_jid, phone_e164, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.externalJid,
      input.phoneE164 ?? null,
      input.displayName,
      "2026-07-19T15:00:00.000Z",
      "2026-07-19T15:00:00.000Z",
    );
}

test("migração limpa contatos Participante sem perder autoria nem integridade", () => {
  const database = databaseBeforeCleanup();
  try {
    const support = new SupportStore(database);
    const account = support.upsertAccount({
      id: "participant-cleanup-account",
      phoneNumber: "+5547000000004",
      displayName: "Conta local",
    });
    const client = support.upsertClient({
      id: "participant-cleanup-client",
      name: "Operação de teste",
      slug: "operacao-de-teste",
      kind: "ecommerce",
    });
    const group = support.upsertGroup({
      id: "participant-cleanup-group",
      accountId: account.id,
      clientId: client.id,
      externalJid: "120363000005@g.us",
      subject: "Grupo de teste",
    });

    insertLegacyParticipant(database, {
      id: "anonymous-history",
      externalJid: "900000000000104@lid",
      displayName: "Participante 900000000000104",
    });
    support.addGroupParticipant(group.id, "anonymous-history");
    support.upsertMessage({
      id: "anonymous-history-message",
      externalId: "anonymous-history-message-external",
      groupId: group.id,
      senderId: "anonymous-history",
      occurredAt: "2026-07-19T15:01:00.000Z",
      text: "Mensagem que não pode perder a autoria.",
      messageType: "text",
      triageKind: "context",
    });

    insertLegacyParticipant(database, {
      id: "mapped-lid",
      externalJid: "900000000000105@lid",
      displayName: "Participante",
    });
    insertLegacyParticipant(database, {
      id: "mapped-phone",
      externalJid: "5511912345680@s.whatsapp.net",
      displayName: "Pessoa Fictícia Delta",
      phoneE164: "+5511912345680",
    });
    support.upsertIdentityLink({
      phoneJid: "5511912345680@s.whatsapp.net",
      lidJid: "900000000000105@lid",
      source: "test",
      observedAt: "2026-07-19T15:02:00.000Z",
    });
    support.addGroupParticipant(group.id, "mapped-lid");

    insertLegacyParticipant(database, {
      id: "mapped-without-counterpart",
      externalJid: "900000000000106@lid",
      displayName: "Participante 900000000000106",
    });
    support.upsertIdentityLink({
      phoneJid: "5511912345681@s.whatsapp.net",
      lidJid: "900000000000106@lid",
      source: "test",
      observedAt: "2026-07-19T15:03:00.000Z",
    });
    support.addGroupParticipant(group.id, "mapped-without-counterpart");

    insertLegacyParticipant(database, {
      id: "roster-only",
      externalJid: "900000000000107@lid",
      displayName: "Participante 900000000000107",
    });
    support.addGroupParticipant(group.id, "roster-only");

    migrateDatabase(database);
    migrateDatabase(database);

    assert.equal(
      (
        database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM participants
             WHERE lower(trim(display_name)) = 'participante'
                OR lower(trim(display_name)) LIKE 'participante %'`,
          )
          .get() as { count: number }
      ).count,
      0,
    );
    assert.equal(
      database
        .prepare("SELECT id FROM participants WHERE id = 'roster-only'")
        .get(),
      undefined,
    );
    assert.deepEqual(
      database
        .prepare(
          `SELECT participant.id, participant.display_name, message.sender_id
           FROM participants participant
           JOIN messages message ON message.sender_id = participant.id
           WHERE participant.id = 'anonymous-history'`,
        )
        .get(),
      {
        id: "anonymous-history",
        display_name: "900000000000104@lid",
        sender_id: "anonymous-history",
      },
    );
    assert.deepEqual(
      database
        .prepare(
          `SELECT display_name, phone_e164
           FROM participants
           WHERE id = 'mapped-lid'`,
        )
        .get(),
      { display_name: "Pessoa Fictícia Delta", phone_e164: "+5511912345680" },
    );
    assert.deepEqual(
      database
        .prepare(
          `SELECT display_name, phone_e164
           FROM participants
           WHERE id = 'mapped-without-counterpart'`,
        )
        .get(),
      { display_name: "+5511912345681", phone_e164: "+5511912345681" },
    );

    const snapshot = new DirectoryStore(database).getSnapshot();
    assert.equal(
      snapshot.people.some((person) => person.id === "anonymous-history"),
      false,
    );
    assert.equal(
      snapshot.people.some((person) => person.displayName.startsWith("Participante")),
      false,
    );
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    assert.equal(database.pragma("integrity_check", { simple: true }), "ok");
    assert.equal(
      (
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM schema_migrations WHERE name = ?`,
          )
          .get(MIGRATION_NAME) as { count: number }
      ).count,
      1,
    );
  } finally {
    database.close();
  }
});
