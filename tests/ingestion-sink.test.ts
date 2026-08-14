import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { proto, type WAMessage } from "baileys";
import Database from "better-sqlite3";

import {
  createDatabase,
  migrateDatabase,
  migrations,
} from "../server/db/index.js";
import { SupportStore } from "../server/domain/index.js";
import { createSqliteInboundSink } from "../server/ingestion/sqlite-sink.js";
import { RuntimeStateFile } from "../server/runtime/runtime-state.js";
import { TriageAiScheduler } from "../server/triage/ai-scheduler.js";
import { TriageWorker } from "../server/triage/triage-worker.js";
import {
  normalizeMessagesUpsert,
  type InboundMessageEnvelope,
} from "../server/whatsapp/index.js";

function imageEnvelope(overrides: Partial<InboundMessageEnvelope> = {}): InboundMessageEnvelope {
  return {
    idempotencyKey: "group@g.us:message-1",
    provider: "whatsapp",
    providerMessageId: "message-1",
    source: "realtime",
    observedAs: { upsertType: "notify", requestId: null },
    occurredAt: "2026-07-16T12:00:00.000Z",
    timestampMs: Date.parse("2026-07-16T12:00:00.000Z"),
    chatJid: "group@g.us",
    chatDisplayName: "Loja Exemplo",
    scope: "group",
    participantJid: "5511999999999@s.whatsapp.net",
    participantAltJid: null,
    participantDisplayName: "Cliente",
    fromMe: false,
    isStaff: false,
    isAllowlistedGroup: true,
    eligibleForTicket: true,
    content: {
      kind: "image",
      messageType: "imageMessage",
      text: "Está dando erro",
      caption: "Está dando erro",
      quotedMessageId: null,
      attachments: [
        {
          idempotencyKey: "group@g.us:message-1:attachment:0",
          kind: "image",
          eligibleForAnalysis: true,
          mimeType: "image/png",
          fileName: "erro.png",
          fileSha256Base64: null,
          fileEncSha256Base64: null,
          sizeBytes: 8,
          pageCount: null,
          width: 10,
          height: 10,
          durationSeconds: null,
          encryptedLocator: { directPath: null, mediaKeyBase64: null, url: null },
        },
      ],
    },
    rawMessage: null,
    ...overrides,
  };
}

function directEnvelope(
  id: string,
  input: {
    source: "history" | "realtime";
    upsertType?: "append" | "notify";
    eligibleForTicket: boolean;
  },
): InboundMessageEnvelope {
  return imageEnvelope({
    idempotencyKey: `5511999999999@s.whatsapp.net:${id}`,
    providerMessageId: id,
    source: input.source,
    observedAs:
      input.source === "history"
        ? {
            syncType: 1,
            progress: 100,
            isLatest: true,
            chunkOrder: 1,
            peerDataRequestSessionId: null,
          }
        : { upsertType: input.upsertType ?? "notify", requestId: null },
    chatJid: "5511999999999@s.whatsapp.net",
    chatDisplayName: input.source === "history" ? "Contato antigo" : null,
    scope: "direct",
    participantJid: "5511999999999@s.whatsapp.net",
    participantDisplayName: "Contato privado",
    isAllowlistedGroup: false,
    eligibleForTicket: input.eligibleForTicket,
    content: {
      kind: "text",
      messageType: "conversation",
      text: "Como funciona a métrica total de clientes?",
      caption: null,
      quotedMessageId: null,
      attachments: [],
    },
  });
}

function groupHistoryEnvelope(
  id: string,
  occurredAt: string,
  text = "Não estamos conseguindo integrar a plataforma",
): InboundMessageEnvelope {
  return imageEnvelope({
    idempotencyKey: `group@g.us:${id}`,
    providerMessageId: id,
    source: "history",
    observedAs: {
      syncType: 1,
      progress: 50,
      isLatest: false,
      chunkOrder: 1,
      peerDataRequestSessionId: null,
    },
    occurredAt,
    timestampMs: Date.parse(occurredAt),
    eligibleForTicket: false,
    content: {
      kind: "text",
      messageType: "conversation",
      text,
      caption: null,
      quotedMessageId: null,
      attachments: [],
    },
  });
}

function addCustomerGroup(
  store: SupportStore,
  input: {
    clientId: string;
    clientName: string;
    clientKind?: "agency" | "ecommerce";
    groupId: string;
    groupJid: string;
    participantJid?: string;
    participantName?: string;
  },
): { clientId: string; groupId: string; participantId: string } {
  const account = store.upsertAccount({
    id: "membership-account",
    phoneNumber: "commercial-account",
    displayName: "Acme Comercial",
  });
  const client = store.upsertClient({
    id: input.clientId,
    name: input.clientName,
    slug: input.clientId,
    kind: input.clientKind ?? "ecommerce",
  });
  const group = store.upsertGroup({
    id: input.groupId,
    accountId: account.id,
    clientId: client.id,
    externalJid: input.groupJid,
    subject: `Acme + ${input.clientName}`,
  });
  const participant = store.upsertParticipant({
    id: `participant-${input.participantJid ?? "5511999999999"}`,
    externalJid: input.participantJid ?? "5511999999999@s.whatsapp.net",
    phoneE164: "+5511999999999",
    displayName: input.participantName ?? "Pessoa Fictícia Cliente",
  });
  store.addGroupParticipant(group.id, participant.id);
  return { clientId: client.id, groupId: group.id, participantId: participant.id };
}

test("sink ignora o evento de revogação e preserva somente a mensagem original", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-revoke-sink-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const sink = createSqliteInboundSink({
    store,
    runtimeState: new RuntimeStateFile(path.join(temporary, "runtime.json")),
    attachmentsDirectory: path.join(temporary, "attachments"),
    accountPhone: "commercial-account",
    accountName: "Acme Comercial",
  });
  const original = imageEnvelope({
    idempotencyKey: "group@g.us:original-before-revoke",
    providerMessageId: "original-before-revoke",
    content: {
      kind: "text",
      messageType: "conversation",
      text: "Texto original que deve permanecer",
      caption: null,
      quotedMessageId: null,
      attachments: [],
    },
  });
  const revocation = imageEnvelope({
    idempotencyKey: "group@g.us:revoke-event",
    providerMessageId: "revoke-event",
    occurredAt: "2026-07-16T12:01:00.000Z",
    timestampMs: Date.parse("2026-07-16T12:01:00.000Z"),
    eligibleForTicket: false,
    content: {
      kind: "system",
      messageType: "protocolMessage",
      text: null,
      caption: null,
      quotedMessageId: null,
      attachments: [],
      revocation: {
        targetProviderMessageId: "original-before-revoke",
      },
    },
  });

  try {
    await sink.upsertMessages([original, revocation]);

    assert.deepEqual(
      database
        .prepare(
          `SELECT provider_message_id, text, message_type
           FROM messages ORDER BY occurred_at`,
        )
        .all(),
      [
        {
          provider_message_id: "original-before-revoke",
          text: "Texto original que deve permanecer",
          message_type: "conversation",
        },
      ],
    );
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM tickets").get() as {
        count: number;
      }).count,
      0,
    );
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("sink ignora MESSAGE_EDIT como bolha e preserva a mensagem original bruta", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-edit-sink-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const sink = createSqliteInboundSink({
    store,
    runtimeState: new RuntimeStateFile(path.join(temporary, "runtime.json")),
    attachmentsDirectory: path.join(temporary, "attachments"),
    accountPhone: "commercial-account",
    accountName: "Acme Comercial",
  });
  const original = imageEnvelope({
    idempotencyKey: "group@g.us:original-before-edit",
    providerMessageId: "original-before-edit",
    eligibleForTicket: false,
    content: {
      kind: "text",
      messageType: "conversation",
      text: "Texto original preservado",
      caption: null,
      quotedMessageId: null,
      attachments: [],
    },
    rawMessage: {
      key: { id: "original-before-edit", remoteJid: "group@g.us" },
      message: { conversation: "Texto original preservado" },
    },
  });
  const rawEdit: WAMessage = {
    key: {
      id: "edit-event",
      remoteJid: "group@g.us",
      participant: "5511999999999@s.whatsapp.net",
      fromMe: false,
    },
    messageTimestamp: Math.floor(
      Date.parse("2026-07-16T12:01:00.000Z") / 1_000,
    ),
    message: {
      protocolMessage: {
        type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
        key: {
          id: "original-before-edit",
          remoteJid: "group@g.us",
          participant: "5511999999999@s.whatsapp.net",
          fromMe: false,
        },
        editedMessage: { conversation: "Texto editado que não vira bolha" },
        timestampMs: Date.parse("2026-07-16T12:01:00.000Z"),
      },
    },
  };
  const [edit] = normalizeMessagesUpsert(
    { messages: [rawEdit], type: "notify" },
    { allowlistedGroupJids: ["group@g.us"] },
  );
  assert.ok(edit);

  try {
    await sink.upsertMessages([original, edit]);

    assert.deepEqual(
      database
        .prepare(
          `SELECT provider_message_id, text, message_type,
                  json_extract(raw_json, '$.message.conversation') AS raw_text
           FROM messages ORDER BY occurred_at`,
        )
        .all(),
      [
        {
          provider_message_id: "original-before-edit",
          text: "Texto original preservado",
          message_type: "conversation",
          raw_text: "Texto original preservado",
        },
      ],
    );
    assert.equal(store.listTriageCandidates().length, 0);
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM tickets").get() as {
        count: number;
      }).count,
      0,
    );
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM triage_blocks").get() as {
        count: number;
      }).count,
      0,
    );
    const conversation = database
      .prepare("SELECT id FROM whatsapp_groups WHERE external_jid = 'group@g.us'")
      .get() as { id: string };
    assert.deepEqual(
      store.getConversationMessages(conversation.id).items.map((message) => ({
        text: message.text,
        messageType: message.messageType,
      })),
      [{ text: "Texto original preservado", messageType: "conversation" }],
    );
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("sink persiste reação como evento sem criar mensagem ou ticket", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-reaction-sink-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const sink = createSqliteInboundSink({
    store,
    runtimeState: new RuntimeStateFile(path.join(temporary, "runtime.json")),
    attachmentsDirectory: path.join(temporary, "attachments"),
    accountPhone: "commercial-account",
    accountName: "Acme Comercial",
  });
  const reaction = imageEnvelope({
    idempotencyKey: "group@g.us:reaction-event",
    providerMessageId: "reaction-event",
    occurredAt: "2026-07-16T12:02:00.000Z",
    timestampMs: Date.parse("2026-07-16T12:02:00.000Z"),
    eligibleForTicket: false,
    content: {
      kind: "reaction",
      messageType: "reactionMessage",
      text: "❤️",
      caption: null,
      quotedMessageId: "reaction-target",
      attachments: [],
      reaction: {
        targetProviderMessageId: "reaction-target",
        emoji: "❤️",
        reactedAt: "2026-07-16T12:01:30.000Z",
      },
    },
  });

  try {
    await sink.upsertMessages([reaction]);

    assert.deepEqual(
      database
        .prepare(
          `SELECT event_external_id, target_provider_message_id, emoji, occurred_at
           FROM message_reaction_events`,
        )
        .get(),
      {
        event_external_id: "group@g.us:reaction-event",
        target_provider_message_id: "reaction-target",
        emoji: "❤️",
        occurred_at: "2026-07-16T12:01:30.000Z",
      },
    );
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM messages").get() as {
        count: number;
      }).count,
      0,
    );
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM tickets").get() as {
        count: number;
      }).count,
      0,
    );
    assert.equal(store.listTriageCandidates().length, 0);
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("reação de funcionário não é capturada como resposta do ticket", async () => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "support-staff-reaction-sink-"),
  );
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const sink = createSqliteInboundSink({
    store,
    runtimeState: new RuntimeStateFile(path.join(temporary, "runtime.json")),
    attachmentsDirectory: path.join(temporary, "attachments"),
    accountPhone: "commercial-account",
    accountName: "Acme Comercial",
  });
  const original = imageEnvelope({
    idempotencyKey: "group@g.us:staff-reaction-target",
    providerMessageId: "staff-reaction-target",
    content: {
      kind: "text",
      messageType: "conversation",
      text: "Os pedidos ainda não apareceram",
      caption: null,
      quotedMessageId: null,
      attachments: [],
    },
  });

  try {
    await sink.upsertMessages([original]);
    const target = database
      .prepare("SELECT id, group_id FROM messages WHERE provider_message_id = ?")
      .get("staff-reaction-target") as { id: string; group_id: string };
    const ticket = store.createTicket({
      id: "ticket-with-staff-reaction",
      groupId: target.group_id,
      sourceMessageId: target.id,
      title: "Pedidos ausentes",
      summary: "Cliente relata pedidos ausentes.",
    });

    await sink.upsertMessages([
      imageEnvelope({
        idempotencyKey: "group@g.us:staff-reaction-event",
        providerMessageId: "staff-reaction-event",
        occurredAt: "2026-07-16T12:03:00.000Z",
        timestampMs: Date.parse("2026-07-16T12:03:00.000Z"),
        participantJid: null,
        participantAltJid: null,
        participantDisplayName: "Acme Comercial",
        fromMe: true,
        isStaff: true,
        eligibleForTicket: false,
        content: {
          kind: "reaction",
          messageType: "reactionMessage",
          text: "✅",
          caption: null,
          quotedMessageId: "staff-reaction-target",
          attachments: [],
          reaction: {
            targetProviderMessageId: "staff-reaction-target",
            emoji: "✅",
            reactedAt: "2026-07-16T12:03:00.000Z",
          },
        },
      }),
    ]);

    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM messages").get() as {
        count: number;
      }).count,
      1,
    );
    assert.equal(
      (
        database
          .prepare("SELECT COUNT(*) AS count FROM message_reaction_events")
          .get() as { count: number }
      ).count,
      1,
    );
    assert.equal(
      (
        database
          .prepare("SELECT COUNT(*) AS count FROM ticket_messages WHERE ticket_id = ?")
          .get(ticket.id) as { count: number }
      ).count,
      1,
    );
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM sent_responses").get() as {
        count: number;
      }).count,
      0,
    );
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("sink salva contexto antes da midia e deduplica somente depois do download", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-sink-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const sink = createSqliteInboundSink({
    store,
    runtimeState: new RuntimeStateFile(path.join(temporary, "runtime.json")),
    attachmentsDirectory: path.join(temporary, "attachments"),
    accountPhone: "commercial-account",
    accountName: "Acme Comercial",
  });
  const envelope = imageEnvelope();
  const sourceKey = envelope.content.attachments[0]?.idempotencyKey as string;
  const bytes = Buffer.from("fake-png");

  try {
    assert.equal((await stat(path.join(temporary, "attachments"))).mode & 0o777, 0o700);
    await sink.upsertMessages([envelope]);
    assert.equal(await sink.hasMedia?.(sourceKey), false);
    assert.equal(store.listTriageCandidates().length, 1);

    await sink.storeMedia?.({
      idempotencyKey: sourceKey,
      messageIdempotencyKey: envelope.idempotencyKey,
      kind: "image",
      mimeType: "image/png",
      fileName: "erro.png",
      sizeBytes: bytes.byteLength,
      sha256Hex: createHash("sha256").update(bytes).digest("hex"),
      bytes,
    });

    assert.equal(await sink.hasMedia?.(sourceKey), true);
    const attachment = database
      .prepare("SELECT available, local_path FROM attachments WHERE source_key = ?")
      .get(sourceKey) as { available: number; local_path: string };
    assert.equal(attachment.available, 1);
    assert.match(attachment.local_path, /attachments\/2026\/07\/.+\.png$/);
    assert.equal((await stat(attachment.local_path)).mode & 0o777, 0o600);

    await sink.upsertMessages([envelope]);
    assert.equal(await sink.hasMedia?.(sourceKey), true);
    assert.deepEqual(
      database
        .prepare("SELECT available, local_path FROM attachments WHERE source_key = ?")
        .get(sourceKey),
      attachment,
    );
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("áudio recebido invalida triagem iniciada antes do download da mídia", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-audio-triage-race-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const sink = createSqliteInboundSink({
    store,
    runtimeState: new RuntimeStateFile(path.join(temporary, "runtime.json")),
    attachmentsDirectory: path.join(temporary, "attachments"),
    accountPhone: "commercial-account",
    accountName: "Acme Comercial",
  });
  const envelope = imageEnvelope({
    idempotencyKey: "group@g.us:audio-triage-race",
    providerMessageId: "audio-triage-race",
    content: {
      kind: "audio",
      messageType: "audioMessage",
      text: null,
      caption: null,
      quotedMessageId: null,
      attachments: [{
        idempotencyKey: "group@g.us:audio-triage-race:attachment:0",
        kind: "audio",
        eligibleForAnalysis: true,
        mimeType: "audio/ogg; codecs=opus",
        fileName: "audio.ogg",
        fileSha256Base64: null,
        fileEncSha256Base64: null,
        sizeBytes: 8,
        pageCount: null,
        width: null,
        height: null,
        durationSeconds: 2,
        encryptedLocator: { directPath: null, mediaKeyBase64: null, url: null },
      }],
    },
  });
  const textBeforeAudio = imageEnvelope({
    idempotencyKey: "group@g.us:text-before-audio-triage-race",
    providerMessageId: "text-before-audio-triage-race",
    content: {
      kind: "text",
      messageType: "conversation",
      text: "Os disparos da campanha não estão sendo enviados.",
      caption: null,
      quotedMessageId: null,
      attachments: [],
    },
  });
  const bytes = Buffer.from("fake-ogg");

  try {
    database
      .prepare(
        `UPDATE audio_transcription_settings
         SET enabled = 1, auto_transcribe_new = 1, updated_at = ?
         WHERE singleton = 1`,
      )
      .run(new Date().toISOString());
    await sink.upsertMessages([textBeforeAudio]);
    assert.equal(
      new TriageAiScheduler(store, { quietPeriodMs: 0 }).scheduleBatch(),
      1,
    );

    await sink.upsertMessages([envelope]);
    assert.deepEqual(
      database.prepare("SELECT state, error FROM triage_ai_jobs").get(),
      {
        state: "failed",
        error: "Áudio aguardando transcrição; contexto reagendado",
      },
    );
    assert.deepEqual(
      database
        .prepare("SELECT status, source FROM audio_transcriptions")
        .get(),
      { status: "queued", source: "realtime" },
    );
    assert.equal(
      new TriageAiScheduler(store, { quietPeriodMs: 0 }).scheduleBatch(),
      0,
    );
    assert.equal(
      store.getConversationSuggestionAnalysis(
        store.listConversations({ limit: 1 }).items[0]!.id,
      ).state,
      "waiting_for_audio",
    );

    await sink.storeMedia?.({
      idempotencyKey: envelope.content.attachments[0]!.idempotencyKey,
      messageIdempotencyKey: envelope.idempotencyKey,
      kind: "audio",
      mimeType: "audio/ogg; codecs=opus",
      fileName: "audio.ogg",
      sizeBytes: bytes.byteLength,
      sha256Hex: createHash("sha256").update(bytes).digest("hex"),
      bytes,
    });

    assert.deepEqual(
      database
        .prepare("SELECT status, source FROM audio_transcriptions")
        .get(),
      { status: "queued", source: "realtime" },
    );
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("conversa silenciada continua armazenando mensagens e anexos sem gerar triagem", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-muted-sink-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const group = addCustomerGroup(store, {
    clientId: "muted-client",
    clientName: "Cliente Interno",
    groupId: "muted-group",
    groupJid: "group@g.us",
  });
  store.setConversationSuggestionsMuted(group.groupId, {
    muted: true,
    actor: "Operador",
  });
  const sink = createSqliteInboundSink({
    store,
    runtimeState: new RuntimeStateFile(path.join(temporary, "runtime.json")),
    attachmentsDirectory: path.join(temporary, "attachments"),
    accountPhone: "commercial-account",
    accountName: "Acme Comercial",
  });

  try {
    await sink.upsertMessages([imageEnvelope({
      idempotencyKey: "group@g.us:muted-message",
      providerMessageId: "muted-message",
    })]);
    const stored = database
      .prepare(
        `SELECT message.triage_kind, message.triage_state,
                COUNT(attachment.id) AS attachment_count
         FROM messages message
         LEFT JOIN attachments attachment ON attachment.message_id = message.id
         WHERE message.external_id = ?
         GROUP BY message.id`,
      )
      .get("group@g.us:muted-message") as {
        triage_kind: string;
        triage_state: string;
        attachment_count: number;
      };
    assert.deepEqual(stored, {
      triage_kind: "context",
      triage_state: "context",
      attachment_count: 1,
    });
    assert.equal(store.listTriageCandidates().length, 0);
    assert.equal(store.listConversations({ attention: "all" }).items[0]?.suggestionsMuted, true);
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("redelivery notify apos reativar conversa preserva mensagem recebida durante silencio como contexto", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-muted-redelivery-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const group = addCustomerGroup(store, {
    clientId: "muted-redelivery-client",
    clientName: "Cliente Interno",
    groupId: "muted-redelivery-group",
    groupJid: "group@g.us",
  });
  const sink = createSqliteInboundSink({
    store,
    runtimeState: new RuntimeStateFile(path.join(temporary, "runtime.json")),
    attachmentsDirectory: path.join(temporary, "attachments"),
    accountPhone: "commercial-account",
    accountName: "Acme Comercial",
  });
  const envelope = imageEnvelope({
    idempotencyKey: "group@g.us:muted-notify-redelivery",
    providerMessageId: "muted-notify-redelivery",
    content: {
      kind: "text",
      messageType: "conversation",
      text: "Os pedidos sumiram, conseguem verificar?",
      caption: null,
      quotedMessageId: null,
      attachments: [],
    },
  });

  try {
    store.setConversationSuggestionsMuted(group.groupId, {
      muted: true,
      actor: "Operador",
    });
    await sink.upsertMessages([envelope]);
    assert.deepEqual(
      database
        .prepare(
          `SELECT ingestion_source, triage_kind, triage_state
           FROM messages WHERE external_id = ?`,
        )
        .get(envelope.idempotencyKey),
      {
        ingestion_source: "realtime_notify",
        triage_kind: "context",
        triage_state: "context",
      },
    );

    store.setConversationSuggestionsMuted(group.groupId, {
      muted: false,
      actor: "Operador",
    });
    await sink.upsertMessages([envelope]);

    assert.deepEqual(
      database
        .prepare(
          `SELECT ingestion_source, triage_kind, triage_state
           FROM messages WHERE external_id = ?`,
        )
        .get(envelope.idempotencyKey),
      {
        ingestion_source: "realtime_notify",
        triage_kind: "context",
        triage_state: "context",
      },
    );
    assert.equal(store.listTriageCandidates().length, 0);
    assert.equal(new TriageWorker(store).runBatch().processed, 0);
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("runtime separa grupos reais de conversas privadas", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-runtime-counts-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const runtimeState = new RuntimeStateFile(path.join(temporary, "runtime.json"));
  const sink = createSqliteInboundSink({
    store,
    runtimeState,
    attachmentsDirectory: path.join(temporary, "attachments"),
    accountPhone: "commercial-account",
    accountName: "Acme Comercial",
  });

  try {
    await sink.upsertMessages([
      imageEnvelope({
        idempotencyKey: "group@g.us:runtime-group",
        providerMessageId: "runtime-group",
        content: {
          kind: "text",
          messageType: "conversation",
          text: "Dúvida no grupo",
          caption: null,
          quotedMessageId: null,
          attachments: [],
        },
      }),
      directEnvelope("runtime-direct", {
        source: "history",
        eligibleForTicket: false,
      }),
    ]);

    const runtime = await runtimeState.read();
    assert.equal(runtime.groupsDiscovered, 1);
    assert.equal(runtime.groupsSynced, 1);
    assert.equal(runtime.privateConversations, 1);

    const fallbackRuntime = store.getRuntimeStatus();
    assert.equal(fallbackRuntime.groupsDiscovered, 1);
    assert.equal(fallbackRuntime.groupsSynced, 1);
    assert.equal(fallbackRuntime.privateConversations, 1);
    assert.equal(fallbackRuntime.monitoredGroups, 1);
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("mensagem privada vazia não cria conversa nem bolha sem conteúdo", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-empty-direct-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const runtimeState = new RuntimeStateFile(path.join(temporary, "runtime.json"));
  const sink = createSqliteInboundSink({
    store,
    runtimeState,
    attachmentsDirectory: path.join(temporary, "attachments"),
    accountPhone: "commercial-account",
    accountName: "Acme Comercial",
  });
  const empty = {
    ...directEnvelope("empty-private-system", {
      source: "history",
      eligibleForTicket: false,
    }),
    chatJid: "90000000000101@lid",
    chatDisplayName: "Grupo 90000000000101",
    participantJid: "90000000000101@lid",
    participantDisplayName: null,
    fromMe: true,
    isStaff: true,
    content: {
      kind: "system" as const,
      messageType: null,
      text: null,
      caption: null,
      quotedMessageId: null,
      attachments: [],
    },
  };

  try {
    await sink.upsertMessages([empty]);
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM whatsapp_groups").get() as { count: number }).count,
      0,
    );
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM messages").get() as { count: number }).count,
      0,
    );
    assert.equal((await runtimeState.read()).privateConversations, 0);

    const account = store.upsertAccount({
      phoneNumber: "commercial-account",
      displayName: "Acme Comercial",
    });
    const emptyClient = store.upsertClient({
      name: "90000000000101",
      slug: "90000000000101",
      kind: "ecommerce",
    });
    store.upsertGroup({
      accountId: account.id,
      clientId: emptyClient.id,
      externalJid: "90000000000101@lid",
      subject: "90000000000101",
      monitored: false,
    });
    assert.equal(
      store.getRuntimeStatus().privateConversations,
      0,
      "um shell privado sem conteúdo não entra na contagem operacional",
    );

    await sink.upsertMessages([
      {
        ...empty,
        idempotencyKey: "90000000000101@lid:meaningful-private",
        providerMessageId: "meaningful-private",
        fromMe: false,
        isStaff: false,
        content: {
          kind: "text",
          messageType: "conversation",
          text: "Preciso de ajuda com o dashboard",
          caption: null,
          quotedMessageId: null,
          attachments: [],
        },
      },
    ]);
    await sink.upsertMessages([
      {
        ...empty,
        idempotencyKey: "90000000000101@lid:empty-private-redelivery",
        providerMessageId: "empty-private-redelivery",
      },
    ]);

    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM whatsapp_groups").get() as { count: number }).count,
      1,
    );
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM messages").get() as { count: number }).count,
      1,
    );
    assert.equal((await runtimeState.read()).privateConversations, 1);
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("evento realtime sem nome preserva cliente e nome manual do grupo existente", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-existing-group-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const account = store.upsertAccount({
    id: "manual-account",
    phoneNumber: "commercial-account",
    displayName: "Acme Comercial",
  });
  const client = store.upsertClient({
    id: "manual-client",
    name: "Agência editada manualmente",
    slug: "agencia-editada-manualmente",
    kind: "agency",
  });
  store.upsertGroup({
    id: "manual-group",
    accountId: account.id,
    clientId: client.id,
    externalJid: "group@g.us",
    subject: "Nome manual do grupo",
  });
  const sink = createSqliteInboundSink({
    store,
    runtimeState: new RuntimeStateFile(path.join(temporary, "runtime.json")),
    attachmentsDirectory: path.join(temporary, "attachments"),
    accountPhone: "commercial-account",
    accountName: "Acme Comercial",
  });

  try {
    await sink.upsertMessages([
      imageEnvelope({
        idempotencyKey: "group@g.us:realtime-without-name",
        providerMessageId: "realtime-without-name",
        chatDisplayName: null,
        content: {
          kind: "text",
          messageType: "conversation",
          text: "Como funciona o total de clientes?",
          caption: null,
          quotedMessageId: null,
          attachments: [],
        },
      }),
    ]);

    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM clients").get() as { count: number })
        .count,
      1,
    );
    assert.deepEqual(
      database
        .prepare("SELECT id, client_id, subject FROM whatsapp_groups")
        .get(),
      {
        id: "manual-group",
        client_id: "manual-client",
        subject: "Nome manual do grupo",
      },
    );
    assert.equal(
      (database.prepare("SELECT name FROM clients WHERE id = ?").get(client.id) as { name: string })
        .name,
      "Agência editada manualmente",
    );
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("midia analisavel reabre triagem ignorada de forma idempotente", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-media-requeue-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const sink = createSqliteInboundSink({
    store,
    runtimeState: new RuntimeStateFile(path.join(temporary, "runtime.json")),
    attachmentsDirectory: path.join(temporary, "attachments"),
    accountPhone: "commercial-account",
    accountName: "Acme Comercial",
  });
  const envelope = imageEnvelope({
    content: {
      ...imageEnvelope().content,
      text: "Bom dia!",
      caption: "Bom dia!",
    },
  });
  const sourceKey = envelope.content.attachments[0]?.idempotencyKey as string;
  const bytes = Buffer.from("fake-png");
  const media = {
    idempotencyKey: sourceKey,
    messageIdempotencyKey: envelope.idempotencyKey,
    kind: "image" as const,
    mimeType: "image/png",
    fileName: "erro.png",
    sizeBytes: bytes.byteLength,
    sha256Hex: createHash("sha256").update(bytes).digest("hex"),
    bytes,
  };

  try {
    await sink.upsertMessages([envelope]);
    const message = database
      .prepare("SELECT id FROM messages WHERE external_id = ?")
      .get(envelope.idempotencyKey) as { id: string };
    store.markMessageTriage(message.id, { kind: "social", state: "ignored" });

    await sink.storeMedia?.(media);
    assert.deepEqual(
      database
        .prepare("SELECT triage_kind, triage_state FROM messages WHERE id = ?")
        .get(message.id),
      { triage_kind: "unclassified", triage_state: "unreviewed" },
    );
    assert.equal(store.listTriageCandidates().length, 1);

    await sink.storeMedia?.(media);
    assert.deepEqual(
      database
        .prepare("SELECT triage_kind, triage_state FROM messages WHERE id = ?")
        .get(message.id),
      { triage_kind: "unclassified", triage_state: "unreviewed" },
    );
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("histórico agrega limites e evento complete permanece após realtime", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-history-state-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const sink = createSqliteInboundSink({
    store,
    runtimeState: new RuntimeStateFile(path.join(temporary, "runtime.json")),
    attachmentsDirectory: path.join(temporary, "attachments"),
    accountPhone: "commercial-account",
    accountName: "Acme Comercial",
  });

  try {
    await sink.upsertMessages([
      imageEnvelope({
        idempotencyKey: "group@g.us:history-middle",
        providerMessageId: "history-middle",
        source: "history",
        occurredAt: "2026-07-10T12:00:00.000Z",
      }),
      imageEnvelope({
        idempotencyKey: "group@g.us:history-oldest",
        providerMessageId: "history-oldest",
        source: "history",
        chatDisplayName: null,
        occurredAt: "2026-07-01T12:00:00.000Z",
      }),
      imageEnvelope({
        idempotencyKey: "group@g.us:realtime-newest",
        providerMessageId: "realtime-newest",
        source: "realtime",
        chatDisplayName: null,
        occurredAt: "2026-07-20T12:00:00.000Z",
      }),
    ]);
    assert.deepEqual(
      database
        .prepare(
          `SELECT history_oldest_at, history_newest_at, history_complete
           FROM whatsapp_groups WHERE external_jid = ?`,
        )
        .get("group@g.us"),
      {
        history_oldest_at: "2026-07-01T12:00:00.000Z",
        history_newest_at: "2026-07-20T12:00:00.000Z",
        history_complete: 0,
      },
    );

    await sink.emitRuntimeEvent?.({
      type: "history_sync",
      occurredAt: "2026-07-20T12:01:00.000Z",
      status: "complete",
      syncType: null,
      progress: 100,
      explicit: true,
      isLatest: null,
      chunkOrder: null,
      messageCount: 0,
    });
    await sink.upsertMessages([
      imageEnvelope({
        idempotencyKey: "group@g.us:late-redelivery",
        providerMessageId: "late-redelivery",
        source: "realtime",
        chatDisplayName: null,
        occurredAt: "2026-07-15T12:00:00.000Z",
      }),
    ]);

    assert.deepEqual(
      database
        .prepare(
          `SELECT history_oldest_at, history_newest_at, history_complete
           FROM whatsapp_groups WHERE external_jid = ?`,
        )
        .get("group@g.us"),
      {
        history_oldest_at: "2026-07-01T12:00:00.000Z",
        history_newest_at: "2026-07-20T12:00:00.000Z",
        history_complete: 1,
      },
    );
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("histórico inicial em vários batches permanece somente como contexto", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-initial-history-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const sink = createSqliteInboundSink({
    store,
    runtimeState: new RuntimeStateFile(path.join(temporary, "runtime.json")),
    attachmentsDirectory: path.join(temporary, "attachments"),
    accountPhone: "commercial-account",
    accountName: "Acme Comercial",
  });

  try {
    await sink.emitRuntimeEvent?.({
      type: "connection",
      occurredAt: "2026-07-17T12:00:00.000Z",
      state: "open",
      isOnline: true,
      receivedPendingNotifications: true,
      disconnectStatusCode: null,
      errorMessage: null,
    });
    await sink.emitRuntimeEvent?.({
      type: "history_sync",
      occurredAt: "2026-07-17T12:00:01.000Z",
      status: "batch",
      syncType: 1,
      progress: 40,
      explicit: false,
      isLatest: false,
      chunkOrder: 1,
      messageCount: 1,
    });
    await sink.upsertMessages([
      groupHistoryEnvelope("initial-newer", "2026-07-15T12:00:00.000Z"),
    ]);
    await sink.emitRuntimeEvent?.({
      type: "history_sync",
      occurredAt: "2026-07-17T12:00:02.000Z",
      status: "batch",
      syncType: 1,
      progress: 80,
      explicit: false,
      isLatest: false,
      chunkOrder: 2,
      messageCount: 1,
    });
    await sink.upsertMessages([
      groupHistoryEnvelope("initial-older", "2026-07-10T12:00:00.000Z"),
    ]);
    await sink.emitRuntimeEvent?.({
      type: "history_sync",
      occurredAt: "2026-07-17T12:00:03.000Z",
      status: "complete",
      syncType: 1,
      progress: 100,
      explicit: true,
      isLatest: true,
      chunkOrder: null,
      messageCount: 0,
    });

    assert.deepEqual(
      database
        .prepare(
          `SELECT triage_kind, triage_state
           FROM messages ORDER BY occurred_at`,
        )
        .all(),
      [
        { triage_kind: "context", triage_state: "context" },
        { triage_kind: "context", triage_state: "context" },
      ],
    );
    assert.equal(store.listTriageCandidates().length, 0);
    assert.equal(new TriageWorker(store).runBatch().processed, 0);
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM tickets").get() as { count: number })
        .count,
      0,
    );
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM triage_blocks").get() as { count: number })
        .count,
      0,
    );
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("append recuperado após o cursor volta para revisão sem reabrir mensagens antigas", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-recovered-append-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const sink = createSqliteInboundSink({
    store,
    runtimeState: new RuntimeStateFile(path.join(temporary, "runtime.json")),
    attachmentsDirectory: path.join(temporary, "attachments"),
    accountPhone: "commercial-account",
    accountName: "Acme Comercial",
  });
  const appendEnvelope = (
    id: string,
    occurredAt: string,
  ): InboundMessageEnvelope =>
    imageEnvelope({
      idempotencyKey: `group@g.us:${id}`,
      providerMessageId: id,
      source: "realtime",
      observedAs: { upsertType: "append", requestId: null },
      occurredAt,
      timestampMs: Date.parse(occurredAt),
      eligibleForTicket: false,
      content: {
        kind: "text",
        messageType: "conversation",
        text: "Como editar um template de email marketing?",
        caption: null,
        quotedMessageId: null,
        attachments: [],
      },
    });

  try {
    await sink.upsertMessages([
      appendEnvelope("initial-append-older", "2026-07-17T08:59:00.000Z"),
      appendEnvelope("initial-append-latest", "2026-07-17T09:00:00.000Z"),
    ]);
    const conversation = database
      .prepare("SELECT id FROM whatsapp_groups WHERE external_jid = 'group@g.us'")
      .get() as { id: string };

    assert.deepEqual(
      database
        .prepare(
          `SELECT provider_message_id, triage_state
           FROM messages ORDER BY occurred_at`,
        )
        .all(),
      [
        { provider_message_id: "initial-append-older", triage_state: "context" },
        { provider_message_id: "initial-append-latest", triage_state: "context" },
      ],
    );
    assert.equal(
      store.getConversationTriageCursor(conversation.id)?.watermarkAt,
      "2026-07-17T09:00:00.000Z",
    );

    database
      .prepare(
        `UPDATE whatsapp_groups
         SET triage_enabled_at = ?, triage_watermark_at = ?
         WHERE id = ?`,
      )
      .run(
        "2026-07-17T10:00:00.000Z",
        "2026-07-17T10:00:00.000Z",
        conversation.id,
      );

    await sink.upsertMessages([
      appendEnvelope("append-before-cursor", "2026-07-17T09:59:59.000Z"),
      appendEnvelope("append-at-cursor", "2026-07-17T10:00:00.000Z"),
      appendEnvelope("append-after-cursor", "2026-07-17T10:00:01.000Z"),
    ]);

    assert.deepEqual(
      database
        .prepare(
          `SELECT provider_message_id, ingestion_source, triage_state
           FROM messages ORDER BY occurred_at`,
        )
        .all(),
      [
        {
          provider_message_id: "initial-append-older",
          ingestion_source: "realtime_append",
          triage_state: "context",
        },
        {
          provider_message_id: "initial-append-latest",
          ingestion_source: "realtime_append",
          triage_state: "context",
        },
        {
          provider_message_id: "append-before-cursor",
          ingestion_source: "realtime_append",
          triage_state: "context",
        },
        {
          provider_message_id: "append-at-cursor",
          ingestion_source: "realtime_append",
          triage_state: "context",
        },
        {
          provider_message_id: "append-after-cursor",
          ingestion_source: "realtime_append",
          triage_state: "unreviewed",
        },
      ],
    );
    assert.equal(store.listTriageCandidates().length, 1);
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("reativacao durante history sync atualiza o cursor entre batches", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-history-unmute-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const group = addCustomerGroup(store, {
    clientId: "history-unmute-client",
    clientName: "Cliente Histórico",
    groupId: "history-unmute-group",
    groupJid: "group@g.us",
  });
  database
    .prepare(
      `UPDATE whatsapp_groups
       SET triage_enabled_at = ?, triage_watermark_at = ?
       WHERE id = ?`,
    )
    .run(
      "2000-01-01T00:00:00.000Z",
      "2000-01-01T00:00:00.000Z",
      group.groupId,
    );
  const sink = createSqliteInboundSink({
    store,
    runtimeState: new RuntimeStateFile(path.join(temporary, "runtime.json")),
    attachmentsDirectory: path.join(temporary, "attachments"),
    accountPhone: "commercial-account",
    accountName: "Acme Comercial",
  });

  try {
    await sink.emitRuntimeEvent?.({
      type: "connection",
      occurredAt: "2026-07-17T12:00:00.000Z",
      state: "open",
      isOnline: true,
      receivedPendingNotifications: true,
      disconnectStatusCode: null,
      errorMessage: null,
    });
    await sink.emitRuntimeEvent?.({
      type: "history_sync",
      occurredAt: "2026-07-17T12:00:01.000Z",
      status: "batch",
      syncType: 1,
      progress: 40,
      explicit: false,
      isLatest: false,
      chunkOrder: 1,
      messageCount: 1,
    });
    await sink.upsertMessages([
      groupHistoryEnvelope("before-mute", "2005-01-01T00:00:00.000Z"),
    ]);
    assert.equal(store.listTriageCandidates().length, 1);

    store.setConversationSuggestionsMuted(group.groupId, {
      muted: true,
      actor: "Operador",
    });
    store.setConversationSuggestionsMuted(group.groupId, {
      muted: false,
      actor: "Operador",
    });
    const resumedCursor = store.getConversationTriageCursor(group.groupId);
    assert.ok(resumedCursor);
    assert.ok(resumedCursor.enabledAt > "2010-01-01T00:00:00.000Z");

    await sink.emitRuntimeEvent?.({
      type: "history_sync",
      occurredAt: "2026-07-17T12:00:02.000Z",
      status: "batch",
      syncType: 1,
      progress: 80,
      explicit: false,
      isLatest: false,
      chunkOrder: 2,
      messageCount: 1,
    });
    await sink.upsertMessages([
      groupHistoryEnvelope("after-unmute-old", "2010-01-01T00:00:00.000Z"),
    ]);

    assert.deepEqual(
      database
        .prepare(
          `SELECT triage_kind, triage_state
           FROM messages WHERE provider_message_id = ?`,
        )
        .get("after-unmute-old"),
      { triage_kind: "context", triage_state: "context" },
    );
    assert.equal(store.listTriageCandidates().length, 0);
    assert.equal(new TriageWorker(store).runBatch().processed, 0);
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("migration live inicializa o cursor pela última mensagem persistida", () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  for (const migration of migrations.filter((item) => item.version < 10)) {
    database.transaction(() => {
      database.exec(migration.sql);
      database
        .prepare(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        )
        .run(migration.version, migration.name, "2026-07-17T11:00:00.000Z");
    })();
  }

  try {
    const store = new SupportStore(database);
    const account = store.upsertAccount({
      id: "upgrade-account",
      phoneNumber: "commercial-account",
      displayName: "Acme Comercial",
    });
    const client = store.upsertClient({
      id: "upgrade-client",
      name: "Cliente Upgrade",
      slug: "cliente-upgrade",
      kind: "ecommerce",
    });
    const group = store.upsertGroup({
      id: "upgrade-group",
      accountId: account.id,
      clientId: client.id,
      externalJid: "120363-upgrade@g.us",
      subject: "Acme + Cliente Upgrade",
    });
    const participant = store.upsertParticipant({
      id: "upgrade-participant",
      externalJid: "5511999990000@s.whatsapp.net",
      displayName: "Cliente Upgrade",
    });
    store.upsertMessage({
      id: "upgrade-message-old",
      externalId: "upgrade-message-old",
      groupId: group.id,
      senderId: participant.id,
      occurredAt: "2026-07-17T09:00:00.000Z",
      text: "Mensagem antiga",
      messageType: "conversation",
      triageState: "context",
    });
    store.upsertMessage({
      id: "upgrade-message-latest",
      externalId: "upgrade-message-latest",
      groupId: group.id,
      senderId: participant.id,
      occurredAt: "2026-07-17T10:30:00.000Z",
      text: "Última mensagem antes do upgrade",
      messageType: "conversation",
      triageState: "context",
    });

    migrateDatabase(database);

    assert.deepEqual(
      database
        .prepare(
          `SELECT triage_enabled_at, triage_watermark_at
           FROM whatsapp_groups WHERE id = 'upgrade-group'`,
        )
        .get(),
      {
        triage_enabled_at: "2026-07-17T10:30:00.000Z",
        triage_watermark_at: "2026-07-17T10:30:00.000Z",
      },
    );
  } finally {
    database.close();
  }
});

test("histórico offline fora de ordem usa o cursor do início da sessão", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-offline-history-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const sink = createSqliteInboundSink({
    store,
    runtimeState: new RuntimeStateFile(path.join(temporary, "runtime.json")),
    attachmentsDirectory: path.join(temporary, "attachments"),
    accountPhone: "commercial-account",
    accountName: "Acme Comercial",
  });

  try {
    await sink.upsertMessages([
      groupHistoryEnvelope("baseline", "2026-07-15T12:00:00.000Z"),
    ]);
    const conversation = database
      .prepare("SELECT id FROM whatsapp_groups WHERE external_jid = 'group@g.us'")
      .get() as { id: string };
    const baseline = store.getConversationTriageCursor(conversation.id);
    assert.ok(baseline);
    const cutoff = Math.max(
      Date.parse(baseline.enabledAt),
      Date.parse(baseline.watermarkAt ?? baseline.enabledAt),
    );
    const intermediateAt = new Date(cutoff + 60_000).toISOString();
    const newerAt = new Date(cutoff + 120_000).toISOString();
    const realtimeAt = new Date(cutoff + 180_000).toISOString();

    await sink.emitRuntimeEvent?.({
      type: "connection",
      occurredAt: new Date(cutoff + 1_000).toISOString(),
      state: "open",
      isOnline: true,
      receivedPendingNotifications: true,
      disconnectStatusCode: null,
      errorMessage: null,
    });
    await sink.upsertMessages([
      imageEnvelope({
        idempotencyKey: "group@g.us:realtime-after-open",
        providerMessageId: "realtime-after-open",
        occurredAt: realtimeAt,
        timestampMs: Date.parse(realtimeAt),
        content: {
          kind: "text",
          messageType: "conversation",
          text: "A integração continua sem funcionar",
          caption: null,
          quotedMessageId: null,
          attachments: [],
        },
      }),
    ]);
    await sink.emitRuntimeEvent?.({
      type: "history_sync",
      occurredAt: new Date(cutoff + 2_000).toISOString(),
      status: "batch",
      syncType: 1,
      progress: 50,
      explicit: false,
      isLatest: false,
      chunkOrder: 1,
      messageCount: 1,
    });
    await sink.upsertMessages([
      groupHistoryEnvelope("offline-newer", newerAt),
    ]);
    await sink.emitRuntimeEvent?.({
      type: "history_sync",
      occurredAt: new Date(cutoff + 3_000).toISOString(),
      status: "batch",
      syncType: 1,
      progress: 90,
      explicit: false,
      isLatest: false,
      chunkOrder: 2,
      messageCount: 1,
    });
    await sink.upsertMessages([
      groupHistoryEnvelope("offline-intermediate", intermediateAt),
    ]);
    await sink.emitRuntimeEvent?.({
      type: "history_sync",
      occurredAt: new Date(cutoff + 4_000).toISOString(),
      status: "complete",
      syncType: 1,
      progress: 100,
      explicit: true,
      isLatest: true,
      chunkOrder: null,
      messageCount: 0,
    });

    assert.equal(store.listTriageCandidates().length, 3);
    assert.deepEqual(
      database
        .prepare(
          `SELECT triage_state
           FROM messages WHERE provider_message_id LIKE 'offline-%'
           ORDER BY occurred_at`,
        )
        .all(),
      [{ triage_state: "unreviewed" }, { triage_state: "unreviewed" }],
    );
    const result = new TriageWorker(store).runBatch();
    assert.equal(result.suggestedCreate, 3);
    assert.equal(result.failed, 0);
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM triage_blocks").get() as { count: number })
        .count,
      1,
    );
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM tickets").get() as { count: number })
        .count,
      0,
    );
    assert.equal(
      (
        database
          .prepare("SELECT COUNT(*) AS count FROM investigation_jobs")
          .get() as { count: number }
      ).count,
      0,
    );
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("histórico privado pós-cursor volta para revisão somente com vínculo ativo", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-private-offline-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  addCustomerGroup(store, {
    clientId: "offline-agency",
    clientName: "Agência Offline",
    clientKind: "agency",
    groupId: "offline-agency-group",
    groupJid: "120363999001@g.us",
  });
  const sink = createSqliteInboundSink({
    store,
    runtimeState: new RuntimeStateFile(path.join(temporary, "runtime.json")),
    attachmentsDirectory: path.join(temporary, "attachments"),
    accountPhone: "commercial-account",
    accountName: "Acme Comercial",
  });

  try {
    await sink.upsertMessages([
      directEnvelope("private-baseline", {
        source: "history",
        eligibleForTicket: false,
      }),
    ]);
    const directConversation = database
      .prepare(
        `SELECT id, client_id FROM whatsapp_groups
         WHERE external_jid = '5511999999999@s.whatsapp.net'`,
      )
      .get() as { id: string; client_id: string };
    assert.equal(directConversation.client_id, "offline-agency");
    const baseline = store.getConversationTriageCursor(directConversation.id);
    assert.ok(baseline);
    const cutoff = Math.max(
      Date.parse(baseline.enabledAt),
      Date.parse(baseline.watermarkAt ?? baseline.enabledAt),
    );
    const recoveredAt = new Date(cutoff + 60_000).toISOString();

    await sink.emitRuntimeEvent?.({
      type: "history_sync",
      occurredAt: new Date(cutoff + 1_000).toISOString(),
      status: "batch",
      syncType: 1,
      progress: 70,
      explicit: false,
      isLatest: false,
      chunkOrder: 1,
      messageCount: 1,
    });
    await sink.upsertMessages([
      {
        ...directEnvelope("private-recovered", {
          source: "history",
          eligibleForTicket: false,
        }),
        occurredAt: recoveredAt,
        timestampMs: Date.parse(recoveredAt),
      },
    ]);

    assert.equal(store.listTriageCandidates().length, 1);
    assert.deepEqual(
      database
        .prepare(
          `SELECT m.triage_state, g.client_id
           FROM messages m
           JOIN whatsapp_groups g ON g.id = m.group_id
           WHERE m.provider_message_id = 'private-recovered'`,
        )
        .get(),
      { triage_state: "unreviewed", client_id: "offline-agency" },
    );
    assert.equal(new TriageWorker(store).runBatch().suggestedCreate, 1);
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM tickets").get() as { count: number })
        .count,
      0,
    );
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("sink corrige permissão frouxa do diretório de anexos existente", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-attachments-mode-"));
  const attachments = path.join(temporary, "attachments");
  await mkdir(attachments, { recursive: true, mode: 0o755 });
  await chmod(attachments, 0o755);
  const database = createDatabase(":memory:");

  try {
    createSqliteInboundSink({
      store: new SupportStore(database),
      runtimeState: new RuntimeStateFile(path.join(temporary, "runtime.json")),
      attachmentsDirectory: attachments,
      accountPhone: "commercial-account",
      accountName: "Acme Comercial",
    });
    assert.equal((await stat(attachments)).mode & 0o777, 0o700);
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("mensagem de funcionario fica salva mas nunca entra na triagem", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-staff-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const sink = createSqliteInboundSink({
    store,
    runtimeState: new RuntimeStateFile(path.join(temporary, "runtime.json")),
    attachmentsDirectory: path.join(temporary, "attachments"),
    accountPhone: "commercial-account",
    accountName: "Acme Comercial",
  });

  try {
    await sink.upsertMessages([
      imageEnvelope({
        idempotencyKey: "group@g.us:staff-1",
        providerMessageId: "staff-1",
        participantJid: "5511888888888@s.whatsapp.net",
        participantDisplayName: "Operador",
        isStaff: true,
        eligibleForTicket: false,
        content: {
          kind: "text",
          messageType: "conversation",
          text: "Vou verificar para você.",
          caption: null,
          quotedMessageId: null,
          attachments: [],
        },
      }),
    ]);
    assert.equal(store.listTriageCandidates().length, 0);
    const message = database
      .prepare("SELECT triage_kind, triage_state FROM messages")
      .get() as { triage_kind: string; triage_state: string };
    assert.deepEqual(message, { triage_kind: "context", triage_state: "context" });
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("reentrega de mensagem self desvinculada não a anexa novamente ao ticket", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-staff-redelivery-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const sink = createSqliteInboundSink({
    store,
    runtimeState: new RuntimeStateFile(path.join(temporary, "runtime.json")),
    attachmentsDirectory: path.join(temporary, "attachments"),
    accountPhone: "commercial-account",
    accountName: "Acme Comercial",
  });
  const customerEnvelope = imageEnvelope({
    idempotencyKey: "group@g.us:redelivery-customer",
    providerMessageId: "redelivery-customer",
    occurredAt: "2026-07-16T12:00:00.000Z",
    timestampMs: Date.parse("2026-07-16T12:00:00.000Z"),
    content: {
      kind: "text",
      messageType: "conversation",
      text: "Os pedidos não estão aparecendo.",
      caption: null,
      quotedMessageId: null,
      attachments: [],
    },
  });
  const selfEnvelope = imageEnvelope({
    idempotencyKey: "group@g.us:redelivery-self",
    providerMessageId: "redelivery-self",
    occurredAt: "2026-07-16T12:05:00.000Z",
    timestampMs: Date.parse("2026-07-16T12:05:00.000Z"),
    participantJid: null,
    participantAltJid: null,
    participantDisplayName: null,
    fromMe: true,
    isStaff: true,
    eligibleForTicket: false,
    content: {
      kind: "text",
      messageType: "conversation",
      text: "Vou verificar por aqui.",
      caption: null,
      quotedMessageId: "redelivery-customer",
      attachments: [],
    },
  });

  try {
    await sink.upsertMessages([customerEnvelope]);
    const source = database
      .prepare("SELECT id, group_id FROM messages WHERE provider_message_id = ?")
      .get("redelivery-customer") as { id: string; group_id: string };
    const ticket = store.createTicket({
      id: "ticket-staff-redelivery",
      groupId: source.group_id,
      sourceMessageId: source.id,
      title: "Pedidos ausentes",
      summary: "Cliente relata pedidos ausentes.",
    });

    await sink.upsertMessages([selfEnvelope]);
    const selfMessage = database
      .prepare("SELECT id FROM messages WHERE provider_message_id = ?")
      .get("redelivery-self") as { id: string };
    assert.equal(store.getTicketDetail(ticket.id).messageCount, 2);
    assert.equal(store.getTicketDetail(ticket.id).sentResponses.length, 1);

    store.detachMessageFromTicket(ticket.id, selfMessage.id, "Operador");
    await sink.upsertMessages([selfEnvelope]);

    assert.equal(store.getTicketDetail(ticket.id).messageCount, 1);
    assert.equal(store.getTicketDetail(ticket.id).sentResponses.length, 0);
    assert.equal(
      (
        database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM ticket_events
             WHERE ticket_id = ? AND event_type = 'message_attached'`,
          )
          .get(ticket.id) as { count: number }
      ).count,
      1,
    );
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("histórico da equipe invalida minuta antiga sem enfileirar análise automática", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-staff-history-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const sink = createSqliteInboundSink({
    store,
    runtimeState: new RuntimeStateFile(path.join(temporary, "runtime.json")),
    attachmentsDirectory: path.join(temporary, "attachments"),
    accountPhone: "commercial-account",
    accountName: "Acme Comercial",
  });
  const customerEnvelope = imageEnvelope({
    idempotencyKey: "group@g.us:history-guard-customer",
    providerMessageId: "history-guard-customer",
    occurredAt: "2026-07-16T12:00:00.000Z",
    timestampMs: Date.parse("2026-07-16T12:00:00.000Z"),
    content: {
      kind: "text",
      messageType: "conversation",
      text: "Os pedidos ainda não foram sincronizados.",
      caption: null,
      quotedMessageId: null,
      attachments: [],
    },
  });
  const historicalStaffEnvelope = (
    id: string,
    occurredAt: string,
    text: string,
  ): InboundMessageEnvelope =>
    imageEnvelope({
      idempotencyKey: `group@g.us:${id}`,
      providerMessageId: id,
      source: "history",
      observedAs: {
        syncType: 1,
        progress: 100,
        isLatest: true,
        chunkOrder: 1,
        peerDataRequestSessionId: null,
      },
      occurredAt,
      timestampMs: Date.parse(occurredAt),
      participantJid: null,
      participantAltJid: null,
      participantDisplayName: null,
      fromMe: true,
      isStaff: true,
      eligibleForTicket: false,
      content: {
        kind: "text",
        messageType: "conversation",
        text,
        caption: null,
        quotedMessageId: "history-guard-customer",
        attachments: [],
      },
    });

  try {
    await sink.upsertMessages([customerEnvelope]);
    const source = database
      .prepare("SELECT id, group_id FROM messages WHERE provider_message_id = ?")
      .get("history-guard-customer") as { id: string; group_id: string };
    const ticket = store.createTicket({
      id: "ticket-staff-history-guard",
      groupId: source.group_id,
      sourceMessageId: source.id,
      title: "Pedidos sem sincronização",
      summary: "Cliente relata pedidos ainda não sincronizados.",
      createdAt: "2026-07-16T12:00:00.000Z",
    });
    store.addSuggestion({
      id: "staff-history-current-candidate",
      ticketId: ticket.id,
      body: "Reconecte a integração e aguarde a nova sincronização.",
      confidence: 0.9,
      createdAt: "2026-07-16T12:10:00.000Z",
    });
    const originalQueueInvestigation = store.queueInvestigation.bind(store);
    let queueCalls = 0;
    store.queueInvestigation = (
      ...args: Parameters<SupportStore["queueInvestigation"]>
    ) => {
      queueCalls += 1;
      return originalQueueInvestigation(...args);
    };

    await sink.upsertMessages([
      historicalStaffEnvelope(
        "history-guard-ack",
        "2026-07-16T12:05:00.000Z",
        "Vou verificar por aqui.",
      ),
    ]);

    assert.equal(queueCalls, 0);
    assert.equal(
      store.getTicketDetail(ticket.id).suggestions.find(
        (suggestion) => suggestion.id === "staff-history-current-candidate",
      )?.status,
      "candidate",
    );
    assert.equal(store.getTicketDetail(ticket.id).sentResponses.length, 1);

    const invalidatingBatch = [
      historicalStaffEnvelope(
        "history-guard-copied",
        "2026-07-16T12:06:00.000Z",
        "  RECONECTE A INTEGRAÇÃO E AGUARDE A NOVA SINCRONIZAÇÃO.  ",
      ),
      historicalStaffEnvelope(
        "history-guard-later",
        "2026-07-16T12:11:00.000Z",
        "A sincronização foi concluída.",
      ),
    ];
    await sink.upsertMessages(invalidatingBatch);
    await sink.upsertMessages(invalidatingBatch);

    const detail = store.getTicketDetail(ticket.id);
    assert.equal(queueCalls, 0);
    assert.equal(
      detail.suggestions.find(
        (suggestion) => suggestion.id === "staff-history-current-candidate",
      )?.status,
      "superseded",
    );
    assert.equal(detail.sentResponses.length, 3);
    assert.equal(
      (database
        .prepare(
          `SELECT COUNT(*) AS count FROM investigation_jobs
           WHERE ticket_id = ? AND state = 'queued'`,
        )
        .get(ticket.id) as { count: number }).count,
      0,
    );
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("mensagem externa privada remove marcação antiga de funcionário", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-stale-staff-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const staleParticipant = store.upsertParticipant({
    externalJid: "5511999999999@s.whatsapp.net",
    phoneE164: "+5511999999999",
    displayName: "Contato do cliente",
  });
  store.setStaffMember(staleParticipant.id, "Contato do cliente");
  const sink = createSqliteInboundSink({
    store,
    runtimeState: new RuntimeStateFile(path.join(temporary, "runtime.json")),
    attachmentsDirectory: path.join(temporary, "attachments"),
    accountPhone: "commercial-account",
    accountName: "Acme Comercial",
  });

  try {
    await sink.upsertMessages([
      directEnvelope("stale-staff", {
        source: "realtime",
        upsertType: "notify",
        eligibleForTicket: true,
      }),
    ]);

    assert.deepEqual(
      database
        .prepare(
          `SELECT sm.active, m.triage_state
           FROM participants p
           JOIN staff_members sm ON sm.participant_id = p.id
           JOIN messages m ON m.sender_id = p.id
           WHERE p.external_jid = ?`,
        )
        .get("5511999999999@s.whatsapp.net"),
      { active: 0, triage_state: "context" },
    );
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("notify privado sem vínculo em grupo real fica somente como contexto", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-private-unlinked-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const sink = createSqliteInboundSink({
    store,
    runtimeState: new RuntimeStateFile(path.join(temporary, "runtime.json")),
    attachmentsDirectory: path.join(temporary, "attachments"),
    accountPhone: "commercial-account",
    accountName: "Acme Comercial",
  });

  try {
    await sink.upsertMessages([
      directEnvelope("private-without-group", {
        source: "realtime",
        upsertType: "notify",
        eligibleForTicket: true,
      }),
    ]);

    assert.equal(store.listTriageCandidates().length, 0);
    assert.equal(new TriageWorker(store).runBatch().processed, 0);
    assert.equal(store.listClients().length, 0);
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM tickets").get() as { count: number })
        .count,
      0,
    );
    assert.deepEqual(
      database
        .prepare(
          `SELECT m.triage_kind, m.triage_state, c.identification_pending
           FROM messages m
           JOIN whatsapp_groups g ON g.id = m.group_id
           JOIN clients c ON c.id = g.client_id`,
        )
        .get(),
      {
        triage_kind: "context",
        triage_state: "context",
        identification_pending: 0,
      },
    );
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("participante em vários grupos do mesmo cliente gera sugestão privada já vinculada", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-private-one-client-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  addCustomerGroup(store, {
    clientId: "agencia-norte",
    clientName: "Agência Norte",
    clientKind: "agency",
    groupId: "grupo-norte-loja-a",
    groupJid: "120363100001@g.us",
    participantJid: "100000000001@lid",
    participantName: "Pessoa Fictícia Delta",
  });
  addCustomerGroup(store, {
    clientId: "agencia-norte",
    clientName: "Agência Norte",
    clientKind: "agency",
    groupId: "grupo-norte-loja-b",
    groupJid: "120363100002@g.us",
    participantJid: "100000000001@lid",
    participantName: "Pessoa Fictícia Delta",
  });
  const sink = createSqliteInboundSink({
    store,
    runtimeState: new RuntimeStateFile(path.join(temporary, "runtime.json")),
    attachmentsDirectory: path.join(temporary, "attachments"),
    accountPhone: "commercial-account",
    accountName: "Acme Comercial",
  });

  try {
    await sink.upsertMessages([
      {
        ...directEnvelope("private-known-customer", {
          source: "realtime",
          upsertType: "notify",
          eligibleForTicket: true,
        }),
        participantDisplayName: "Pessoa Fictícia Delta",
      },
    ]);

    assert.equal(store.listTriageCandidates().length, 1);
    assert.equal(new TriageWorker(store).runBatch().suggestedCreate, 1);
    assert.deepEqual(
      database
        .prepare(
          `SELECT g.client_id, c.name AS client_name, c.identification_pending,
                  g.external_jid, block.state, block.suggested_action
           FROM triage_blocks block
           JOIN whatsapp_groups g ON g.id = block.group_id
           JOIN clients c ON c.id = g.client_id`,
        )
        .get(),
      {
        client_id: "agencia-norte",
        client_name: "Agência Norte",
        identification_pending: 0,
        external_jid: "5511999999999@s.whatsapp.net",
        state: "pending",
        suggested_action: "create",
      },
    );
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM tickets").get() as { count: number })
        .count,
      0,
    );
    assert.deepEqual(
      database
        .prepare(
          `SELECT p.display_name, p.phone_e164
           FROM messages m
           JOIN participants p ON p.id = m.sender_id
           WHERE m.provider_message_id = ?`,
        )
        .get("private-known-customer"),
      { display_name: "Pessoa Fictícia Delta", phone_e164: "+5511999999999" },
    );
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("participante ligado a clientes distintos não escolhe cliente silenciosamente", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-private-ambiguous-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  addCustomerGroup(store, {
    clientId: "agencia-alfa",
    clientName: "Agência Alfa",
    clientKind: "agency",
    groupId: "grupo-agencia-alfa",
    groupJid: "120363200001@g.us",
  });
  addCustomerGroup(store, {
    clientId: "ecommerce-beta",
    clientName: "Ecommerce Beta",
    groupId: "grupo-ecommerce-beta",
    groupJid: "120363200002@g.us",
  });
  const sink = createSqliteInboundSink({
    store,
    runtimeState: new RuntimeStateFile(path.join(temporary, "runtime.json")),
    attachmentsDirectory: path.join(temporary, "attachments"),
    accountPhone: "commercial-account",
    accountName: "Acme Comercial",
  });

  try {
    await sink.upsertMessages([
      directEnvelope("private-ambiguous-customer", {
        source: "realtime",
        upsertType: "notify",
        eligibleForTicket: true,
      }),
    ]);

    assert.equal(store.listTriageCandidates().length, 1);
    assert.equal(new TriageWorker(store).runBatch().suggestedCreate, 1);
    const suggestion = database
      .prepare(
        `SELECT g.client_id, c.name AS client_name, c.identification_pending,
                block.state, block.suggested_action
         FROM triage_blocks block
         JOIN whatsapp_groups g ON g.id = block.group_id
         JOIN clients c ON c.id = g.client_id`,
      )
      .get() as {
      client_id: string;
      client_name: string;
      identification_pending: number;
      state: string;
      suggested_action: string;
    };
    assert.notEqual(suggestion.client_id, "agencia-alfa");
    assert.notEqual(suggestion.client_id, "ecommerce-beta");
    assert.deepEqual(suggestion, {
      client_id: suggestion.client_id,
      client_name: "Cliente não identificado",
      identification_pending: 1,
      state: "pending",
      suggested_action: "create",
    });
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM tickets").get() as { count: number })
        .count,
      0,
    );
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("mensagem privada fromMe usa a conta comercial sem marcar o contato remoto como staff", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-private-from-me-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  addCustomerGroup(store, {
    clientId: "cliente-from-me",
    clientName: "Cliente From Me",
    groupId: "grupo-from-me",
    groupJid: "120363300001@g.us",
    participantName: "Contato Remoto",
  });
  const sink = createSqliteInboundSink({
    store,
    runtimeState: new RuntimeStateFile(path.join(temporary, "runtime.json")),
    attachmentsDirectory: path.join(temporary, "attachments"),
    accountPhone: "commercial-account",
    accountName: "Acme Comercial",
  });

  try {
    await sink.upsertMessages([
      {
        ...directEnvelope("private-from-me", {
          source: "realtime",
          upsertType: "notify",
          eligibleForTicket: false,
        }),
        participantJid: null,
        participantAltJid: "5511999999999@s.whatsapp.net",
        participantDisplayName: "Contato Remoto",
        fromMe: true,
        isStaff: true,
      },
    ]);

    assert.deepEqual(
      database
        .prepare(
          `SELECT p.external_jid, p.display_name
           FROM messages m
           JOIN participants p ON p.id = m.sender_id
           WHERE m.provider_message_id = ?`,
        )
        .get("private-from-me"),
      { external_jid: "self:commercial-account", display_name: "Acme Comercial" },
    );
    assert.deepEqual(
      database
        .prepare(
          `SELECT p.display_name, sm.active
           FROM participants p
           LEFT JOIN staff_members sm ON sm.participant_id = p.id
           WHERE p.external_jid = ?`,
        )
        .get("5511999999999@s.whatsapp.net"),
      { display_name: "Contato Remoto", active: null },
    );
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("mensagem privada recebida corrige o assunto que herdou o nome da própria conta", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-private-subject-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const sink = createSqliteInboundSink({
    store,
    runtimeState: new RuntimeStateFile(path.join(temporary, "runtime.json")),
    attachmentsDirectory: path.join(temporary, "attachments"),
    accountPhone: "commercial-account",
    accountName: "Equipe Comercial",
  });

  try {
    await sink.upsertMessages([
      {
        ...directEnvelope("private-subject-from-me", {
          source: "history",
          eligibleForTicket: false,
        }),
        chatJid: "90000000000999@lid",
        chatDisplayName: "Operador de teste",
        participantJid: null,
        participantAltJid: null,
        participantDisplayName: "Operador de teste",
        fromMe: true,
        isStaff: true,
      },
    ]);
    await sink.upsertMessages([
      {
        ...directEnvelope("private-subject-inbound", {
          source: "realtime",
          upsertType: "notify",
          eligibleForTicket: true,
        }),
        chatJid: "90000000000999@lid",
        chatDisplayName: null,
        participantJid: "5511999999999@s.whatsapp.net",
        participantAltJid: "90000000000999@lid",
        participantDisplayName: "Pessoa Fictícia Zeta",
        fromMe: false,
        isStaff: false,
      },
    ]);

    assert.deepEqual(
      database
        .prepare(
          `SELECT subject
           FROM whatsapp_groups
           WHERE external_jid = '90000000000999@lid'`,
        )
        .get(),
      { subject: "Pessoa Fictícia Zeta" },
    );
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("sink mantém identidade anônima técnica sem criar nome Participante", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-anonymous-identity-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const sink = createSqliteInboundSink({
    store,
    runtimeState: new RuntimeStateFile(path.join(temporary, "runtime.json")),
    attachmentsDirectory: path.join(temporary, "attachments"),
    accountPhone: "commercial-account",
    accountName: "Acme Comercial",
  });
  const externalJid = "900000000000109@lid";

  try {
    await sink.upsertMessages([
      imageEnvelope({
        idempotencyKey: "group@g.us:anonymous-identity",
        providerMessageId: "anonymous-identity",
        participantJid: externalJid,
        participantAltJid: null,
        participantDisplayName: null,
      }),
    ]);

    assert.deepEqual(
      database
        .prepare(
          `SELECT external_jid, phone_e164, display_name
           FROM participants
           WHERE external_jid = ?`,
        )
        .get(externalJid),
      {
        external_jid: externalJid,
        phone_e164: null,
        display_name: externalJid,
      },
    );
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
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("sink reutiliza nome humano conhecido entre aliases PN e LID", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-known-alias-name-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const phoneJid = "5511912345682@s.whatsapp.net";
  const lidJid = "900000000000110@lid";
  store.upsertParticipant({
    id: "known-alias-phone",
    externalJid: phoneJid,
    phoneE164: "+5511912345682",
    displayName: "Pessoa Fictícia Épsilon",
  });
  store.upsertIdentityLink({
    phoneJid,
    lidJid,
    source: "test",
    observedAt: "2026-07-19T15:10:00.000Z",
  });
  const sink = createSqliteInboundSink({
    store,
    runtimeState: new RuntimeStateFile(path.join(temporary, "runtime.json")),
    attachmentsDirectory: path.join(temporary, "attachments"),
    accountPhone: "commercial-account",
    accountName: "Acme Comercial",
  });

  try {
    await sink.upsertMessages([
      imageEnvelope({
        idempotencyKey: "group@g.us:known-alias-without-name",
        providerMessageId: "known-alias-without-name",
        participantJid: lidJid,
        participantAltJid: phoneJid,
        participantDisplayName: null,
      }),
    ]);

    assert.deepEqual(
      database
        .prepare(
          `SELECT display_name, phone_e164
           FROM participants
           WHERE external_jid = ?`,
        )
        .get(lidJid),
      { display_name: "Pessoa Fictícia Épsilon", phone_e164: "+5511912345682" },
    );
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("roster completo vincula privado por PN e remove a elegibilidade quando o membro sai", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-roster-private-link-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const account = store.upsertAccount({
    id: "roster-account",
    phoneNumber: "commercial-account",
    displayName: "Acme Comercial",
  });
  const client = store.upsertClient({
    id: "roster-agency",
    name: "Agência Roster",
    slug: "agencia-roster",
    kind: "agency",
  });
  store.upsertGroup({
    id: "roster-group",
    accountId: account.id,
    clientId: client.id,
    externalJid: "120363400001@g.us",
    subject: "Acme + Agência Roster",
  });
  const sink = createSqliteInboundSink({
    store,
    runtimeState: new RuntimeStateFile(path.join(temporary, "runtime.json")),
    attachmentsDirectory: path.join(temporary, "attachments"),
    accountPhone: "commercial-account",
    accountName: "Acme Comercial",
  });
  assert.ok(sink.syncGroupRosters);

  try {
    await sink.syncGroupRosters([
      {
        groupJid: "120363400001@g.us",
        subject: "Acme + Agência Roster",
        observedAt: "2026-07-17T13:00:00.000Z",
        participants: [
          {
            externalJid: "100000000400@lid",
            lidJid: "100000000400@lid",
            phoneJid: "5511999999999@s.whatsapp.net",
            displayName: "Pessoa Fictícia Roster",
            role: "member",
          },
        ],
      },
    ]);

    assert.deepEqual(
      database
        .prepare(
          `SELECT p.external_jid, p.phone_e164, gp.active, gp.source,
                  gp.last_confirmed_at
           FROM group_participants gp
           JOIN participants p ON p.id = gp.participant_id
           JOIN whatsapp_groups g ON g.id = gp.group_id
           WHERE g.external_jid = ?`,
        )
        .all("120363400001@g.us"),
      [
        {
          external_jid: "100000000400@lid",
          phone_e164: "+5511999999999",
          active: 1,
          source: "group_roster",
          last_confirmed_at: "2026-07-17T13:00:00.000Z",
        },
      ],
    );

    await sink.upsertMessages([
      directEnvelope("private-after-roster", {
        source: "realtime",
        upsertType: "notify",
        eligibleForTicket: true,
      }),
    ]);
    assert.equal(store.listTriageCandidates().length, 1);
    assert.equal(new TriageWorker(store).runBatch().suggestedCreate, 1);
    assert.deepEqual(
      database
        .prepare(
          `SELECT g.client_id, c.name, block.state, block.suggested_action
           FROM triage_blocks block
           JOIN whatsapp_groups g ON g.id = block.group_id
           JOIN clients c ON c.id = g.client_id`,
        )
        .get(),
      {
        client_id: "roster-agency",
        name: "Agência Roster",
        state: "pending",
        suggested_action: "create",
      },
    );

    await sink.syncGroupRosters([
      {
        groupJid: "120363400001@g.us",
        subject: "Acme + Agência Roster",
        observedAt: "2026-07-17T13:10:00.000Z",
        participants: [],
      },
    ]);
    assert.deepEqual(
      database
        .prepare(
          `SELECT gp.active, gp.last_confirmed_at
           FROM group_participants gp
           JOIN whatsapp_groups g ON g.id = gp.group_id
           JOIN participants p ON p.id = gp.participant_id
           WHERE g.external_jid = ? AND p.external_jid = ?`,
        )
        .get("120363400001@g.us", "100000000400@lid"),
      { active: 0, last_confirmed_at: "2026-07-17T13:10:00.000Z" },
    );

    await sink.upsertMessages([
      directEnvelope("private-after-roster-removal", {
        source: "realtime",
        upsertType: "notify",
        eligibleForTicket: true,
      }),
    ]);
    assert.equal(store.listTriageCandidates().length, 0);
    assert.deepEqual(
      database
        .prepare(
          "SELECT triage_kind, triage_state FROM messages WHERE provider_message_id = ?",
        )
        .get("private-after-roster-removal"),
      { triage_kind: "context", triage_state: "context" },
    );
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM tickets").get() as { count: number })
        .count,
      0,
    );
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("update incremental remove desativa aliases PN e LID e add reativa ambos", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-roster-incremental-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const account = store.upsertAccount({
    id: "incremental-account",
    phoneNumber: "commercial-account",
    displayName: "Acme Comercial",
  });
  const client = store.upsertClient({
    id: "incremental-client",
    name: "Cliente Incremental",
    slug: "cliente-incremental",
    kind: "ecommerce",
  });
  store.upsertGroup({
    id: "incremental-group",
    accountId: account.id,
    clientId: client.id,
    externalJid: "120363500001@g.us",
    subject: "Acme + Cliente Incremental",
  });
  store.upsertParticipant({
    id: "incremental-participant-pn",
    externalJid: "5511888888888@s.whatsapp.net",
    phoneE164: "+5511888888888",
    displayName: "Contato Incremental",
  });
  const sink = createSqliteInboundSink({
    store,
    runtimeState: new RuntimeStateFile(path.join(temporary, "runtime.json")),
    attachmentsDirectory: path.join(temporary, "attachments"),
    accountPhone: "commercial-account",
    accountName: "Acme Comercial",
  });
  assert.ok(sink.applyGroupParticipantsUpdate);
  const participant = {
    externalJid: "100000000500@lid",
    lidJid: "100000000500@lid",
    phoneJid: "5511888888888@s.whatsapp.net",
    displayName: "Contato Incremental",
    role: "member" as const,
  };

  try {
    await sink.applyGroupParticipantsUpdate({
      groupJid: "120363500001@g.us",
      action: "add",
      participants: [participant],
      observedAt: "2026-07-17T14:00:00.000Z",
    });
    assert.deepEqual(
      database
        .prepare(
          `SELECT p.external_jid, gp.active, gp.source
           FROM group_participants gp
           JOIN participants p ON p.id = gp.participant_id
           WHERE gp.group_id = ?
           ORDER BY p.external_jid`,
        )
        .all("incremental-group"),
      [
        {
          external_jid: "100000000500@lid",
          active: 1,
          source: "group_participant_update",
        },
        {
          external_jid: "5511888888888@s.whatsapp.net",
          active: 1,
          source: "group_participant_update",
        },
      ],
    );

    await sink.applyGroupParticipantsUpdate({
      groupJid: "120363500001@g.us",
      action: "remove",
      participants: [participant],
      observedAt: "2026-07-17T14:05:00.000Z",
    });
    assert.deepEqual(
      database
        .prepare(
          `SELECT p.external_jid, gp.active, gp.source, gp.last_confirmed_at
           FROM group_participants gp
           JOIN participants p ON p.id = gp.participant_id
           WHERE gp.group_id = ?
           ORDER BY p.external_jid`,
        )
        .all("incremental-group"),
      [
        {
          external_jid: "100000000500@lid",
          active: 0,
          source: "group_participant_update",
          last_confirmed_at: "2026-07-17T14:05:00.000Z",
        },
        {
          external_jid: "5511888888888@s.whatsapp.net",
          active: 0,
          source: "group_participant_update",
          last_confirmed_at: "2026-07-17T14:05:00.000Z",
        },
      ],
    );

    await sink.applyGroupParticipantsUpdate({
      groupJid: "120363500001@g.us",
      action: "add",
      participants: [participant],
      observedAt: "2026-07-17T14:10:00.000Z",
    });
    assert.deepEqual(
      database
        .prepare(
          `SELECT p.external_jid, gp.active, gp.source, gp.last_confirmed_at
           FROM group_participants gp
           JOIN participants p ON p.id = gp.participant_id
           WHERE gp.group_id = ?
           ORDER BY p.external_jid`,
        )
        .all("incremental-group"),
      [
        {
          external_jid: "100000000500@lid",
          active: 1,
          source: "group_participant_update",
          last_confirmed_at: "2026-07-17T14:10:00.000Z",
        },
        {
          external_jid: "5511888888888@s.whatsapp.net",
          active: 1,
          source: "group_participant_update",
          last_confirmed_at: "2026-07-17T14:10:00.000Z",
        },
      ],
    );
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("histórico privado fica armazenado e notify realtime só vira candidato com vínculo em grupo", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-private-triage-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const sink = createSqliteInboundSink({
    store,
    runtimeState: new RuntimeStateFile(path.join(temporary, "runtime.json")),
    attachmentsDirectory: path.join(temporary, "attachments"),
    accountPhone: "commercial-account",
    accountName: "Acme Comercial",
  });

  try {
    await sink.upsertMessages([
      directEnvelope("private-history", {
        source: "history",
        eligibleForTicket: false,
      }),
      directEnvelope("private-append", {
        source: "realtime",
        upsertType: "append",
        eligibleForTicket: false,
      }),
    ]);

    assert.equal(store.listTriageCandidates().length, 0);
    assert.equal(store.listClients().length, 0);
    assert.deepEqual(
      database
        .prepare("SELECT ingestion_source, triage_state FROM messages ORDER BY external_id")
        .all(),
      [
        { ingestion_source: "realtime_append", triage_state: "context" },
        { ingestion_source: "history", triage_state: "context" },
      ],
    );

    addCustomerGroup(store, {
      clientId: "organization-example-delta",
      clientName: "Organização Fictícia Delta",
      clientKind: "agency",
      groupId: "group-example-delta",
      groupJid: "120363000001@g.us",
    });

    await sink.upsertMessages([
      directEnvelope("private-notify", {
        source: "realtime",
        upsertType: "notify",
        eligibleForTicket: true,
      }),
    ]);

    assert.equal(store.listTriageCandidates().length, 1);
    assert.equal(store.listClients()[0]?.name, "Organização Fictícia Delta");
    assert.equal(store.listClients()[0]?.isUnidentified, false);
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("redelivery history para notify promove uma única mensagem sem reabrir histórico", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "support-private-redelivery-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const sink = createSqliteInboundSink({
    store,
    runtimeState: new RuntimeStateFile(path.join(temporary, "runtime.json")),
    attachmentsDirectory: path.join(temporary, "attachments"),
    accountPhone: "commercial-account",
    accountName: "Acme Comercial",
  });
  const history = directEnvelope("private-redelivery", {
    source: "history",
    eligibleForTicket: false,
  });
  const notify = directEnvelope("private-redelivery", {
    source: "realtime",
    upsertType: "notify",
    eligibleForTicket: true,
  });

  try {
    await sink.upsertMessages([history]);
    addCustomerGroup(store, {
      clientId: "ecommerce-vinculado",
      clientName: "Ecommerce Vinculado",
      groupId: "grupo-ecommerce-vinculado",
      groupJid: "120363000002@g.us",
    });
    await sink.upsertMessages([notify]);

    assert.deepEqual(
      database.prepare("SELECT COUNT(*) AS count, ingestion_source, triage_state FROM messages").get(),
      { count: 1, ingestion_source: "realtime_notify", triage_state: "unreviewed" },
    );
    assert.equal(store.listTriageCandidates().length, 1);

    const clientId = (
      database.prepare("SELECT client_id FROM whatsapp_groups LIMIT 1").get() as {
        client_id: string;
      }
    ).client_id;
    store.ignoreClient(clientId);
    await sink.upsertMessages([
      directEnvelope("private-after-ignore", {
        source: "realtime",
        upsertType: "notify",
        eligibleForTicket: true,
      }),
    ]);

    assert.equal(store.listTriageCandidates().length, 0);
    assert.equal(
      (database.prepare("SELECT triage_state FROM messages WHERE provider_message_id = ?").get("private-after-ignore") as { triage_state: string }).triage_state,
      "context",
    );
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
