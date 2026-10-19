import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { ChannelService } from "../server/channels/service.js";
import { channelConfigSchema } from "../server/channels/normalize.js";
import { migrateDatabase, migrations } from "../server/db/index.js";
import { SupportStore } from "../server/domain/support-store.js";
import { createTestApiApp } from "../server/index.js";
import type { ChannelConnection } from "../shared/channels.js";
import type { TicketDetailDto } from "../shared/contracts.js";

test("listagem oculta importações legadas, mantém canais reais e preserva histórico dos tickets", async () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  try {
    database.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
    ) STRICT`);
    const channelMigration = migrations.find((migration) => migration.name === "configurable_inbound_channels");
    assert.ok(channelMigration);
    for (const migration of migrations.filter((item) => item.version < channelMigration.version)) {
      if (migration.disableForeignKeys) database.pragma("foreign_keys = OFF");
      database.transaction(() => {
        database.exec(migration.sql);
        database.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)")
          .run(migration.version, migration.name, "2026-10-19T12:00:00.000Z");
      })();
      if (migration.disableForeignKeys) database.pragma("foreign_keys = ON");
    }

    const oldStore = new SupportStore(database);
    const account = oldStore.upsertAccount({ phoneNumber: "+5500000000000", displayName: "Conta teste" });
    const client = oldStore.upsertClient({ name: "Cliente teste", slug: "cliente-teste", kind: "ecommerce" });
    const group = oldStore.upsertGroup({
      accountId: account.id, clientId: client.id, externalJid: "legacy-list@g.us", subject: "Grupo teste",
    });
    const ticket = oldStore.createManualTicket({
      clientRequestId: "legacy-list-ticket", groupId: group.id, title: "Histórico importado", summary: "Demanda externa",
    });
    const imported = oldStore.importExternalSourceMessagesToTicket(ticket.id, {
      sourceType: "intercom_conversation", sourceConversationId: "conversation-240", actor: "Operador",
      messages: [
        { id: "customer-message", author: "Cliente", authorRole: "customer", body: "Preciso de ajuda.", occurredAt: "2026-10-18T12:00:00.000Z" },
        { id: "support-message", author: "Operador", authorRole: "support", body: "Vamos conferir.", occurredAt: "2026-10-18T12:01:00.000Z" },
      ],
    });
    assert.equal(imported.importedCount, 2);

    migrateDatabase(database);
    const store = new SupportStore(database);
    const channels = new ChannelService(store, { set: async () => {}, get: async () => null });
    const app = createTestApiApp(store, undefined, undefined, { channels });
    const migratedTicket = store.getTicketDetail(ticket.id);
    const migratedMessages = migratedTicket.timeline.filter((item) => item.type === "message");
    assert.equal(migratedMessages.length, 2);
    const legacyId = migratedMessages[0]!.channel!.id;
    const legacyName = channels.get(legacyId).name;

    const emptyResponse = await app.request("/api/channels");
    assert.equal(emptyResponse.status, 200);
    assert.deepEqual(await emptyResponse.json(), { items: [] });

    const realChannels: ChannelConnection[] = [];
    for (const status of ["draft", "active", "paused"] as const) {
      const { connection } = await channels.create({
        name: status === "draft" ? legacyName : `Canal ${status}`, config: channelConfigSchema.parse({}),
      }, "Operador");
      if (status !== "draft") {
        channels.preview(connection.id, {
          eventId: "preview", eventType: "message.created", eventOccurredAt: "2026-10-19T12:00:00.000Z",
          messageId: "preview", conversationId: "preview", authorId: "customer", authorName: "Cliente",
          authorRole: "customer", body: "Prévia", occurredAt: "2026-10-19T12:00:00.000Z",
        });
        channels.setStatus(connection.id, status);
      }
      realChannels.push(channels.get(connection.id));
    }
    const response = await app.request("/api/channels");
    assert.equal(response.status, 200);
    const { items } = await response.json() as { items: ChannelConnection[] };
    assert.deepEqual(items.map((item) => item.id).sort(), realChannels.map((item) => item.id).sort());
    assert.deepEqual(items.map((item) => item.status).sort(), ["active", "draft", "paused"]);

    const ticketResponse = await app.request(`/api/tickets/${ticket.id}`);
    assert.equal(ticketResponse.status, 200);
    const preservedTicket = await ticketResponse.json() as TicketDetailDto;
    assert.deepEqual(preservedTicket, migratedTicket);
    assert.equal(preservedTicket.messageCount, imported.ticket.messageCount);
    const messageSummary = (detail: TicketDetailDto) => detail.timeline
      .filter((item) => item.type === "message")
      .map((item) => ({
        id: item.id, externalId: item.externalId, text: item.text, occurredAt: item.occurredAt,
        author: item.sender.displayName, isStaff: item.sender.isStaff,
      }));
    assert.deepEqual(messageSummary(preservedTicket), messageSummary(imported.ticket));
    assert.equal(channels.get(legacyId).name, legacyName);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }
});
