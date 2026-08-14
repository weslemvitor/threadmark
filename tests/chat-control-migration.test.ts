import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import {
  migrateDatabase,
  migrations,
  type SupportDatabase,
} from "../server/db/index.js";
import { SupportStore } from "../server/domain/index.js";

interface LegacyFixture {
  database: SupportDatabase;
  store: SupportStore;
  groupId: string;
  participantId: string;
}

function createLegacyFixture(): LegacyFixture {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  for (const migration of migrations.filter((item) => item.version < 12)) {
    database.transaction(() => {
      database.exec(migration.sql);
      database
        .prepare(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        )
        .run(migration.version, migration.name, "2026-07-17T20:00:00.000Z");
    })();
  }

  const store = new SupportStore(database);
  const account = store.upsertAccount({
    id: "legacy-control-account",
    phoneNumber: "+5547000000000",
    displayName: "Acme Comercial",
  });
  const client = store.upsertClient({
    id: "legacy-control-client",
    name: "Cliente de controles legados",
    slug: "cliente-controles-legados",
    kind: "ecommerce",
  });
  const group = store.upsertGroup({
    id: "legacy-control-group",
    accountId: account.id,
    clientId: client.id,
    externalJid: "120363000888@g.us",
    subject: "Acme + Controles legados",
  });
  const participant = store.upsertParticipant({
    id: "legacy-control-participant",
    externalJid: "5511994444444@s.whatsapp.net",
    phoneE164: "+5511994444444",
    displayName: "Cliente legado",
  });
  store.addGroupParticipant(group.id, participant.id);

  return {
    database,
    store,
    groupId: group.id,
    participantId: participant.id,
  };
}

function insertLegacyReaction(
  fixture: LegacyFixture,
  input: {
    id: string;
    externalId: string;
    providerMessageId: string;
    targetProviderMessageId: string;
    emoji: string;
    occurredAt: string;
  },
) {
  return fixture.store.upsertMessage({
    id: input.id,
    externalId: input.externalId,
    providerMessageId: input.providerMessageId,
    groupId: fixture.groupId,
    senderId: fixture.participantId,
    occurredAt: input.occurredAt,
    text: input.emoji,
    messageType: "reactionMessage",
    triageKind: "social",
    triageState: "unreviewed",
    ingestionSource: "history",
    raw: {
      key: {
        id: input.providerMessageId,
        remoteJid: "120363000888@g.us",
      },
      message: {
        reactionMessage: {
          key: {
            id: input.targetProviderMessageId,
            remoteJid: "120363000888@g.us",
          },
          text: input.emoji,
          senderTimestampMs: Date.parse(input.occurredAt),
        },
      },
    },
  });
}

test("migração remove ticket composto somente por reação e preserva o evento bruto", () => {
  const fixture = createLegacyFixture();
  try {
    const reaction = insertLegacyReaction(fixture, {
      id: "pure-reaction-message",
      externalId: "pure-reaction-external",
      providerMessageId: "pure-reaction-provider",
      targetProviderMessageId: "pure-reaction-target",
      emoji: "❤️",
      occurredAt: "2026-07-17T20:01:00.000Z",
    });
    fixture.store.createTicket({
      id: "pure-reaction-ticket",
      groupId: fixture.groupId,
      sourceMessageId: reaction.id,
      title: "Reação social sem demanda",
      summary: "Ticket legado criado incorretamente a partir de uma reação.",
      status: "triage",
    });

    migrateDatabase(fixture.database);

    assert.deepEqual(
      fixture.database
        .prepare(
          `SELECT id, text, triage_state,
                  json_extract(raw_json, '$.message.reactionMessage.key.id') AS target_id
           FROM messages WHERE id = ?`,
        )
        .get(reaction.id),
      {
        id: reaction.id,
        text: "❤️",
        triage_state: "context",
        target_id: "pure-reaction-target",
      },
    );
    assert.deepEqual(
      fixture.database
        .prepare(
          `SELECT event_external_id, target_provider_message_id, emoji
           FROM message_reaction_events WHERE event_external_id = ?`,
        )
        .get("pure-reaction-external"),
      {
        event_external_id: "pure-reaction-external",
        target_provider_message_id: "pure-reaction-target",
        emoji: "❤️",
      },
    );
    assert.equal(
      fixture.database
        .prepare("SELECT id FROM tickets WHERE id = 'pure-reaction-ticket'")
        .get(),
      undefined,
    );
    assert.equal(
      (
        fixture.database
          .prepare("SELECT COUNT(*) AS count FROM messages")
          .get() as { count: number }
      ).count,
      1,
    );
  } finally {
    fixture.database.close();
  }
});

test("migração remove somente o vínculo da reação em ticket válido", () => {
  const fixture = createLegacyFixture();
  try {
    const substantive = fixture.store.upsertMessage({
      id: "valid-ticket-message",
      externalId: "valid-ticket-message-external",
      providerMessageId: "valid-ticket-message-provider",
      groupId: fixture.groupId,
      senderId: fixture.participantId,
      occurredAt: "2026-07-17T20:02:00.000Z",
      text: "Os pedidos de hoje não apareceram.",
      messageType: "conversation",
      triageKind: "demand",
      triageState: "unreviewed",
      ingestionSource: "realtime_notify",
      raw: {
        message: { conversation: "Os pedidos de hoje não apareceram." },
      },
    });
    const reaction = insertLegacyReaction(fixture, {
      id: "valid-ticket-reaction",
      externalId: "valid-ticket-reaction-external",
      providerMessageId: "valid-ticket-reaction-provider",
      targetProviderMessageId: "valid-ticket-message-provider",
      emoji: "🙏",
      occurredAt: "2026-07-17T20:02:10.000Z",
    });
    const ticket = fixture.store.createTicket({
      id: "valid-ticket-with-reaction",
      groupId: fixture.groupId,
      sourceMessageId: substantive.id,
      title: "Pedidos ausentes",
      summary: "Cliente relata ausência de pedidos.",
      status: "triage",
    });
    fixture.store.attachMessageToTicket(ticket.id, reaction.id, "legacy-test");

    migrateDatabase(fixture.database);

    assert.deepEqual(
      fixture.database
        .prepare("SELECT id, source_message_id FROM tickets WHERE id = ?")
        .get(ticket.id),
      { id: ticket.id, source_message_id: substantive.id },
    );
    assert.deepEqual(
      fixture.database
        .prepare(
          `SELECT message_id FROM ticket_messages
           WHERE ticket_id = ? ORDER BY message_id`,
        )
        .all(ticket.id),
      [{ message_id: substantive.id }],
    );
    assert.deepEqual(
      fixture.database
        .prepare(
          `SELECT id, text, triage_state,
                  json_extract(raw_json, '$.message.reactionMessage.key.id') AS target_id
           FROM messages WHERE id = ?`,
        )
        .get(reaction.id),
      {
        id: reaction.id,
        text: "🙏",
        triage_state: "context",
        target_id: "valid-ticket-message-provider",
      },
    );
    assert.deepEqual(
      fixture.database
        .prepare(
          `SELECT event_external_id, target_provider_message_id, emoji
           FROM message_reaction_events WHERE event_external_id = ?`,
        )
        .get("valid-ticket-reaction-external"),
      {
        event_external_id: "valid-ticket-reaction-external",
        target_provider_message_id: "valid-ticket-message-provider",
        emoji: "🙏",
      },
    );
    assert.equal(
      (
        fixture.database
          .prepare("SELECT COUNT(*) AS count FROM messages")
          .get() as { count: number }
      ).count,
      2,
    );
  } finally {
    fixture.database.close();
  }
});
