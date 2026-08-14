import assert from "node:assert/strict";
import test from "node:test";

import { createDatabase } from "../server/db/index.js";
import { SupportStore } from "../server/domain/index.js";
import {
  parseHistoryRescanPreviewArguments,
  previewHistoryRescan,
} from "../server/triage/history-rescan.js";

test("rescan de histórico é somente uma prévia e não reabre a fila", () => {
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  try {
    const account = store.upsertAccount({
      id: "rescan-account",
      phoneNumber: "commercial-account",
      displayName: "Conta de suporte",
    });
    const client = store.upsertClient({
      id: "rescan-client",
      name: "Organização",
      slug: "organizacao-rescan",
      kind: "ecommerce",
    });
    const external = store.upsertParticipant({
      id: "rescan-external",
      externalJid: "5511999990000@s.whatsapp.net",
      displayName: "Pessoa externa",
    });
    const staff = store.upsertParticipant({
      id: "rescan-staff",
      externalJid: "5511888880000@s.whatsapp.net",
      displayName: "Pessoa da equipe",
    });
    store.setStaffMember(staff.id, "Pessoa da equipe");

    const monitored = store.upsertGroup({
      id: "rescan-monitored",
      accountId: account.id,
      clientId: client.id,
      externalJid: "120363-monitored@g.us",
      subject: "Grupo monitorado",
      monitored: true,
    });
    const unmonitored = store.upsertGroup({
      id: "rescan-unmonitored",
      accountId: account.id,
      clientId: client.id,
      externalJid: "120363-unmonitored@g.us",
      subject: "Grupo não monitorado",
      monitored: false,
    });
    const muted = store.upsertGroup({
      id: "rescan-muted",
      accountId: account.id,
      clientId: client.id,
      externalJid: "120363-muted@g.us",
      subject: "Grupo pausado",
      monitored: true,
    });
    database
      .prepare(
        `UPDATE whatsapp_groups
         SET suggestions_muted_at = '2026-07-18T10:00:00.000Z'
         WHERE id = ?`,
      )
      .run(muted.id);

    const insertMessage = (
      id: string,
      groupId: string,
      senderId: string,
      occurredAt: string,
      triageState: "context" | "ignored",
    ) =>
      store.upsertMessage({
        id,
        externalId: id,
        groupId,
        senderId,
        occurredAt,
        text: id,
        messageType: "conversation",
        triageKind: triageState === "context" ? "context" : "social",
        triageState,
        ingestionSource: "history",
      });

    insertMessage(
      "recent-context",
      monitored.id,
      external.id,
      "2026-07-18T12:00:00.000Z",
      "context",
    );
    insertMessage(
      "recent-ignored",
      monitored.id,
      external.id,
      "2026-07-18T12:01:00.000Z",
      "ignored",
    );
    insertMessage(
      "old-context",
      monitored.id,
      external.id,
      "2026-05-01T12:00:00.000Z",
      "context",
    );
    insertMessage(
      "staff-context",
      monitored.id,
      staff.id,
      "2026-07-18T12:02:00.000Z",
      "context",
    );
    insertMessage(
      "unmonitored-context",
      unmonitored.id,
      external.id,
      "2026-07-18T12:03:00.000Z",
      "context",
    );
    insertMessage(
      "muted-context",
      muted.id,
      external.id,
      "2026-07-18T12:04:00.000Z",
      "context",
    );

    const before = database
      .prepare(
        `SELECT id, triage_kind, triage_state, updated_at
         FROM messages ORDER BY id`,
      )
      .all();

    assert.deepEqual(
      previewHistoryRescan(database, {
        days: 30,
        now: new Date("2026-07-19T12:00:00.000Z"),
        requestedJids: [],
      }),
      {
        cutoff: "2026-06-19T12:00:00.000Z",
        days: 30,
        messages: 1,
        conversations: 1,
        oldestAt: "2026-07-18T12:00:00.000Z",
        newestAt: "2026-07-18T12:00:00.000Z",
      },
    );
    assert.deepEqual(
      previewHistoryRescan(database, {
        days: 30,
        now: new Date("2026-07-19T12:00:00.000Z"),
        requestedJids: ["120363-unmonitored@g.us"],
      }),
      {
        cutoff: "2026-06-19T12:00:00.000Z",
        days: 30,
        messages: 1,
        conversations: 1,
        oldestAt: "2026-07-18T12:03:00.000Z",
        newestAt: "2026-07-18T12:03:00.000Z",
      },
    );

    assert.deepEqual(
      database
        .prepare(
          `SELECT id, triage_kind, triage_state, updated_at
           FROM messages ORDER BY id`,
        )
        .all(),
      before,
    );
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS total FROM triage_ai_jobs").get() as {
        total: number;
      }).total,
      0,
    );
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS total FROM triage_blocks").get() as {
        total: number;
      }).total,
      0,
    );
  } finally {
    database.close();
  }
});

test("rescan recusa qualquer flag de execução ou opção desconhecida", () => {
  assert.deepEqual(parseHistoryRescanPreviewArguments(["--days=45", "120@g.us"]), {
    days: 45,
    requestedJids: ["120@g.us"],
  });
  assert.throws(
    () => parseHistoryRescanPreviewArguments(["--apply"]),
    /somente prévia/i,
  );
  assert.throws(
    () => parseHistoryRescanPreviewArguments(["--execute"]),
    /somente prévia/i,
  );
  assert.throws(
    () => parseHistoryRescanPreviewArguments(["--yes"]),
    /somente prévia/i,
  );
  assert.throws(
    () => parseHistoryRescanPreviewArguments(["--days=0"]),
    /entre 1 e 730/i,
  );
  assert.throws(
    () => parseHistoryRescanPreviewArguments(["--unknown"]),
    /opção desconhecida/i,
  );
});
