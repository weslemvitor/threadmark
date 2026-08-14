import assert from "node:assert/strict";
import test from "node:test";

import { createDatabase } from "../server/db/index.js";
import { SupportStore } from "../server/domain/index.js";
import { updateConversationMonitoring } from "../server/triage/monitoring.js";

test("monitor inicializa cursor pela última mensagem e unmonitor preserva o cursor", () => {
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  try {
    const account = store.upsertAccount({
      id: "monitor-account",
      phoneNumber: "commercial-account",
      displayName: "Acme Comercial",
    });
    const client = store.upsertClient({
      id: "monitor-client",
      name: "Cliente Monitor",
      slug: "cliente-monitor",
      kind: "ecommerce",
    });
    const group = store.upsertGroup({
      id: "monitor-group",
      accountId: account.id,
      clientId: client.id,
      externalJid: "120363-monitor@g.us",
      subject: "Acme + Cliente Monitor",
      monitored: false,
    });
    const participant = store.upsertParticipant({
      id: "monitor-participant",
      externalJid: "5511999990000@s.whatsapp.net",
      displayName: "Cliente Monitor",
    });
    store.upsertMessage({
      id: "monitor-message-old",
      externalId: "monitor-message-old",
      groupId: group.id,
      senderId: participant.id,
      occurredAt: "2026-07-17T09:00:00.000Z",
      text: "Mensagem antiga",
      messageType: "conversation",
      triageState: "context",
    });
    store.upsertMessage({
      id: "monitor-message-latest",
      externalId: "monitor-message-latest",
      groupId: group.id,
      senderId: participant.id,
      occurredAt: "2026-07-17T10:00:00.000Z",
      text: "Última mensagem conhecida",
      messageType: "conversation",
      triageState: "context",
    });
    database
      .prepare(
        `UPDATE whatsapp_groups
         SET triage_enabled_at = NULL, triage_watermark_at = NULL
         WHERE id = ?`,
      )
      .run(group.id);

    assert.equal(
      updateConversationMonitoring(
        database,
        ["120363-monitor@g.us"],
        true,
        "2026-07-17T11:00:00.000Z",
      ),
      1,
    );
    assert.deepEqual(
      database
        .prepare(
          `SELECT monitored, triage_enabled_at, triage_watermark_at
           FROM whatsapp_groups WHERE id = ?`,
        )
        .get(group.id),
      {
        monitored: 1,
        triage_enabled_at: "2026-07-17T10:00:00.000Z",
        triage_watermark_at: "2026-07-17T10:00:00.000Z",
      },
    );

    updateConversationMonitoring(
      database,
      ["120363-monitor@g.us"],
      false,
      "2026-07-17T12:00:00.000Z",
    );
    assert.deepEqual(
      database
        .prepare(
          `SELECT monitored, triage_enabled_at, triage_watermark_at
           FROM whatsapp_groups WHERE id = ?`,
        )
        .get(group.id),
      {
        monitored: 0,
        triage_enabled_at: "2026-07-17T10:00:00.000Z",
        triage_watermark_at: "2026-07-17T10:00:00.000Z",
      },
    );
  } finally {
    database.close();
  }
});

test("monitor usa o instante de habilitação quando a conversa ainda não tem mensagens", () => {
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  try {
    const account = store.upsertAccount({
      id: "empty-account",
      phoneNumber: "commercial-account",
      displayName: "Acme Comercial",
    });
    const client = store.upsertClient({
      id: "empty-client",
      name: "Cliente Vazio",
      slug: "cliente-vazio",
      kind: "ecommerce",
    });
    const group = store.upsertGroup({
      id: "empty-group",
      accountId: account.id,
      clientId: client.id,
      externalJid: "120363-empty@g.us",
      subject: "Acme + Cliente Vazio",
      monitored: false,
    });

    updateConversationMonitoring(
      database,
      ["120363-empty@g.us"],
      true,
      "2026-07-17T13:00:00.000Z",
    );
    assert.deepEqual(store.getConversationTriageCursor(group.id), {
      enabledAt: "2026-07-17T13:00:00.000Z",
      watermarkAt: "2026-07-17T13:00:00.000Z",
    });
  } finally {
    database.close();
  }
});
