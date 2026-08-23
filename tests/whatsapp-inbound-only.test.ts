import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { join, resolve } from "node:path";

import type { WAMessage } from "baileys";

import { createDatabase } from "../server/db/database.js";
import * as publicApi from "../server/whatsapp/index.js";
import {
  bindInboundEvents,
  createInboundMediaDownloader,
  createInboundWhatsAppClient,
  InboundMediaLimitError,
  normalizeMessagesUpsert,
  type InboundEventSource,
  type InboundContactName,
  type InboundMessageEnvelope,
  type InboundRuntimeEvent,
} from "../server/whatsapp/index.js";
import {
  loadPersistentAuthState,
  resetPersistentAuthState,
} from "../server/whatsapp/auth.js";
import { normalizeGroupRosters } from "../server/whatsapp/events.js";
import type {
  InboundGroupParticipantUpdate,
  InboundGroupRoster,
  InboundIdentityLink,
} from "../server/whatsapp/types.js";
import {
  resolveWhatsAppWebVersion,
  THREADMARK_FALLBACK_WA_VERSION,
} from "../server/whatsapp/version.js";

const groupJid = "120363000000000000@g.us";
const customerJid = "5511999999999@s.whatsapp.net";

describe("WhatsApp inbound-only boundary", () => {
  it("resolve uma versão compatível para gerar QR e mantém fallback offline", async () => {
    const currentVersion = [2, 3000, 1_043_900_000] as const;

    assert.deepEqual(
      await resolveWhatsAppWebVersion(async () => ({
        version: [...currentVersion],
        isLatest: true,
      })),
      currentVersion,
    );
    assert.deepEqual(
      await resolveWhatsAppWebVersion(async () => ({
        version: [2, 3000, 1],
        isLatest: false,
      })),
      THREADMARK_FALLBACK_WA_VERSION,
    );
    assert.deepEqual(
      await resolveWhatsAppWebVersion(async () => {
        throw new Error("offline");
      }),
      THREADMARK_FALLBACK_WA_VERSION,
    );
  });

  it("exposes no outbound operation and stays lazy before start", async () => {
    const client = createInboundWhatsAppClient({
      authDirectory: "/tmp/threadmark-auth-not-started",
      sink: { upsertMessages() {} },
    });

    assert.equal(client.getState(), "idle");
    assert.deepEqual(Object.keys(client).sort(), [
      "getState",
      "renewQr",
      "start",
      "stop",
    ]);
    assert.equal(Object.keys(publicApi).some((key) => /send/i.test(key)), false);

    const whatsappDirectory = resolve(process.cwd(), "server/whatsapp");
    const typeScriptFiles = (await readdir(whatsappDirectory)).filter((file) =>
      file.endsWith(".ts"),
    );
    const implementation = (
      await Promise.all(
        typeScriptFiles.map((file) =>
          readFile(resolve(whatsappDirectory, file), "utf8"),
        ),
      )
    ).join("\n");
    const forbiddenOperation = `send${"Message"}`;
    assert.equal(implementation.includes(forbiddenOperation), false);
  });

  it("renova somente as credenciais locais sem tocar em dados operacionais", async () => {
    const root = await mkdtemp(join(tmpdir(), "threadmark-auth-reset-"));
    const authDirectory = join(root, "auth");
    try {
      const auth = await loadPersistentAuthState(authDirectory);
      await auth.saveCreds();
      assert.equal((await readdir(authDirectory)).length > 0, true);

      await resetPersistentAuthState(authDirectory);

      assert.deepEqual(await readdir(authDirectory), []);
      assert.equal((await stat(authDirectory)).mode & 0o777, 0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes history and live events into the injected sink", async () => {
    const emitter = new EventEmitter();
    const envelopes: InboundMessageEnvelope[] = [];
    const contactNames: InboundContactName[] = [];
    const runtimeEvents: InboundRuntimeEvent[] = [];
    const bridge = bindInboundEvents({
      source: emitter as unknown as InboundEventSource,
      sink: {
        upsertMessages(batch) {
          envelopes.push(...batch);
        },
        upsertContactNames(batch) {
          contactNames.push(...batch);
        },
        emitRuntimeEvent(event) {
          runtimeEvents.push(event);
        },
      },
      policy: { allowlistedGroupJids: [groupJid] },
      now: () => new Date("2026-07-16T12:00:00.000Z"),
    });
    const historyMessage = textMessage("HISTORY-EVENT", "Erro no tracking");
    const liveMessage = textMessage("LIVE-EVENT", "Ainda está acontecendo");

    emitter.emit("connection.update", {
      connection: "connecting",
      qr: "ephemeral-qr",
    });
    emitter.emit("messaging-history.set", {
      chats: [],
      contacts: [],
      messages: [historyMessage],
      progress: 50,
      syncType: 1,
      isLatest: false,
    });
    emitter.emit("messages.upsert", {
      messages: [liveMessage],
      type: "notify",
    });
    emitter.emit("contacts.update", [
      { id: customerJid, notify: "Pessoa Fictícia Eta" },
    ]);
    emitter.emit("messaging-history.status", {
      syncType: 1,
      status: "complete",
      explicit: true,
    });
    await bridge.flush();

    assert.deepEqual(
      envelopes.map((envelope) => envelope.providerMessageId),
      ["HISTORY-EVENT", "LIVE-EVENT"],
    );
    assert.equal(runtimeEvents[0]?.type, "qr");
    assert.equal(
      runtimeEvents.some(
        (event) => event.type === "connection" && event.state === "connecting",
      ),
      true,
    );
    assert.equal(
      runtimeEvents.some(
        (event) =>
          event.type === "history_sync" && event.status === "complete",
      ),
      true,
    );
    assert.deepEqual(contactNames, [
      {
        externalJid: customerJid,
        displayName: "Pessoa Fictícia Eta",
        observedAt: "2026-07-16T12:00:00.000Z",
      },
    ]);

    bridge.detach();
    emitter.emit("messages.upsert", {
      messages: [textMessage("AFTER-DETACH", "Não deve entrar")],
      type: "notify",
    });
    await bridge.flush();
    assert.equal(envelopes.length, 2);
  });

  it("persists PN/LID aliases and normalized group membership events", async () => {
    const emitter = new EventEmitter();
    const identityBatches: InboundIdentityLink[][] = [];
    const rosterBatches: InboundGroupRoster[][] = [];
    const participantUpdates: InboundGroupParticipantUpdate[] = [];
    const bridge = bindInboundEvents({
      source: emitter as unknown as InboundEventSource,
      sink: {
        upsertMessages() {},
        upsertIdentityLinks(links) {
          identityBatches.push([...links]);
        },
        syncGroupRosters(rosters) {
          rosterBatches.push([...rosters]);
        },
        applyGroupParticipantsUpdate(update) {
          participantUpdates.push(update);
        },
      },
      now: () => new Date("2026-07-16T15:30:00.000Z"),
    });

    emitter.emit("messaging-history.set", {
      chats: [],
      contacts: [],
      messages: [],
      lidPnMappings: [
        { pn: "5511999999999@s.whatsapp.net", lid: "123456789@lid" },
      ],
      isLatest: false,
    });
    emitter.emit("lid-mapping.update", {
      pn: "5511888888888@s.whatsapp.net",
      lid: "987654321@lid",
    });
    emitter.emit("group-participants.update", {
      id: groupJid,
      author: "5511777777777@s.whatsapp.net",
      action: "promote",
      participants: [
        {
          id: "222222222@lid",
          lid: "222222222@lid",
          phoneNumber: "5511666666666@s.whatsapp.net",
          notify: "Cliente do grupo",
        },
      ],
    });

    const rosters = normalizeGroupRosters(
      [
        {
          id: groupJid,
          subject: "Organização Exemplo Ômega",
          owner: "5511555555555@s.whatsapp.net",
          participants: [
            {
              id: "333333333@lid",
              lid: "333333333@lid",
              phoneNumber: "5511555555555@s.whatsapp.net",
              name: "Dona da agência",
            },
          ],
        },
      ],
      "2026-07-16T15:31:00.000Z",
    );
    await bridge.syncGroupRosters(rosters);
    await bridge.flush();

    assert.deepEqual(
      identityBatches.flat().map(({ phoneJid, lidJid, source }) => ({
        phoneJid,
        lidJid,
        source,
      })),
      [
        {
          phoneJid: "5511999999999@s.whatsapp.net",
          lidJid: "123456789@lid",
          source: "history",
        },
        {
          phoneJid: "5511888888888@s.whatsapp.net",
          lidJid: "987654321@lid",
          source: "lid_mapping_update",
        },
        {
          phoneJid: "5511666666666@s.whatsapp.net",
          lidJid: "222222222@lid",
          source: "group_participant_update",
        },
        {
          phoneJid: "5511555555555@s.whatsapp.net",
          lidJid: "333333333@lid",
          source: "group_roster",
        },
      ],
    );
    assert.equal(participantUpdates.length, 1);
    assert.equal(participantUpdates[0]?.groupJid, groupJid);
    assert.equal(participantUpdates[0]?.participants[0]?.role, "admin");
    assert.equal(
      participantUpdates[0]?.participants[0]?.displayName,
      "Cliente do grupo",
    );
    assert.equal(rosterBatches.length, 1);
    assert.equal(rosterBatches[0]?.[0]?.subject, "Organização Exemplo Ômega");
    assert.equal(rosterBatches[0]?.[0]?.participants[0]?.role, "owner");
    bridge.detach();
  });

  it("migrates active group rosters and WhatsApp identity links", () => {
    const database = createDatabase(":memory:");
    try {
      const participantColumns = database
        .prepare("PRAGMA table_info(group_participants)")
        .all()
        .map((row) => (row as { name: string }).name);
      assert.equal(participantColumns.includes("active"), true);
      assert.equal(participantColumns.includes("source"), true);
      assert.equal(participantColumns.includes("last_confirmed_at"), true);

      const identityColumns = database
        .prepare("PRAGMA table_info(whatsapp_identity_links)")
        .all()
        .map((row) => (row as { name: string }).name);
      assert.deepEqual(identityColumns, [
        "phone_jid",
        "lid_jid",
        "source",
        "first_seen_at",
        "last_seen_at",
      ]);
    } finally {
      database.close();
    }
  });

  it("does not let live messages overtake the initial group roster", async () => {
    const emitter = new EventEmitter();
    const operations: string[] = [];
    let resolveRoster!: (rosters: readonly InboundGroupRoster[]) => void;
    const rosterPromise = new Promise<readonly InboundGroupRoster[]>(
      (resolve) => {
        resolveRoster = resolve;
      },
    );
    const bridge = bindInboundEvents({
      source: emitter as unknown as InboundEventSource,
      sink: {
        upsertMessages() {
          operations.push("message");
        },
        syncGroupRosters() {
          operations.push("roster");
        },
      },
    });

    const rosterSync = bridge.syncGroupRosters(rosterPromise);
    emitter.emit("messages.upsert", {
      messages: [textMessage("AFTER-ROSTER", "Mensagem privada")],
      type: "notify",
    });
    await Promise.resolve();
    assert.deepEqual(operations, []);

    resolveRoster([]);
    await rosterSync;
    await bridge.flush();
    assert.deepEqual(operations, ["roster", "message"]);
    bridge.detach();
  });

  it("downloads supported inbound media bytes with hash and size limit", async () => {
    const image = imageMessage("IMAGE-DOWNLOAD", null);
    const [envelope] = normalizeMessagesUpsert({
      messages: [image],
      type: "append",
    });
    assert.ok(envelope);

    const downloader = createInboundMediaDownloader({
      maxBytes: 10,
      loadStream: async () =>
        Readable.from([Buffer.from("abc"), Buffer.from("def")]),
    });
    const media = await downloader.download(image, envelope);

    assert.ok(media);
    assert.equal(media.kind, "image");
    assert.equal(media.sizeBytes, 6);
    assert.equal(media.bytes.toString("utf8"), "abcdef");
    assert.equal(
      media.sha256Hex,
      "bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721",
    );

    let loaderCalls = 0;
    const limitedDownloader = createInboundMediaDownloader({
      maxBytes: 4,
      loadStream: async () => {
        loaderCalls += 1;
        return Readable.from([Buffer.from("12345")]);
      },
    });
    await assert.rejects(
      limitedDownloader.download(image, envelope),
      InboundMediaLimitError,
    );
    assert.equal(loaderCalls, 1);
  });

  it("downloads WhatsApp audio for local transcription without sending anything", async () => {
    const audio: WAMessage = {
      key: {
        id: "AUDIO-CONTEXT",
        remoteJid: groupJid,
        participant: customerJid,
        fromMe: false,
      },
      messageTimestamp: 1_710_000_000,
      message: {
        audioMessage: {
          mimetype: "audio/ogg; codecs=opus",
          seconds: 8,
        },
      },
    };
    const [envelope] = normalizeMessagesUpsert({
      messages: [audio],
      type: "notify",
    });
    assert.ok(envelope);

    let loaderCalls = 0;
    const downloader = createInboundMediaDownloader({
      loadStream: async () => {
        loaderCalls += 1;
        return Readable.from([Buffer.from("ogg-opus")]);
      },
    });
    const media = await downloader.download(audio, envelope);

    assert.ok(media);
    assert.equal(media.kind, "audio");
    assert.equal(media.mimeType, "audio/ogg; codecs=opus");
    assert.equal(media.bytes.toString("utf8"), "ogg-opus");
    assert.equal(loaderCalls, 1);
    assert.equal(envelope.content.attachments[0]?.eligibleForAnalysis, true);
  });

  it("persists media through the sink once across redelivery", async () => {
    const emitter = new EventEmitter();
    const message = imageMessage("IMAGE-IDEMPOTENT", null);
    const storedMedia = new Set<string>();
    let downloads = 0;
    let messageUpserts = 0;
    const bridge = bindInboundEvents({
      source: emitter as unknown as InboundEventSource,
      sink: {
        upsertMessages(batch) {
          messageUpserts += batch.length;
        },
        hasMedia(idempotencyKey) {
          return storedMedia.has(idempotencyKey);
        },
        storeMedia(media) {
          storedMedia.add(media.idempotencyKey);
        },
      },
      mediaDownloader: createInboundMediaDownloader({
        loadStream: async () => {
          downloads += 1;
          return Readable.from([Buffer.from("image")]);
        },
      }),
    });

    emitter.emit("messages.upsert", {
      messages: [message],
      type: "append",
    });
    emitter.emit("messages.upsert", {
      messages: [message],
      type: "notify",
    });
    await bridge.flush();

    assert.equal(messageUpserts, 2);
    assert.equal(storedMedia.size, 1);
    assert.equal(downloads, 1);
    bridge.detach();
  });

  it("hardens the persistent auth directory and credential files", async () => {
    const root = await mkdtemp(join(tmpdir(), "threadmark-auth-test-"));
    const authDirectory = join(root, "auth");
    try {
      const auth = await loadPersistentAuthState(authDirectory);
      await auth.saveCreds();

      const directoryMode = (await stat(authDirectory)).mode & 0o777;
      const credentialMode =
        (await stat(join(authDirectory, "creds.json"))).mode & 0o777;
      assert.equal(directoryMode, 0o700);
      assert.equal(credentialMode, 0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent auth mutations before hardening files", async () => {
    const root = await mkdtemp(join(tmpdir(), "threadmark-auth-race-test-"));
    const authDirectory = join(root, "auth");
    try {
      const auth = await loadPersistentAuthState(authDirectory);
      const keyPair = {
        public: Buffer.alloc(32, 1),
        private: Buffer.alloc(32, 2),
      };
      const mutations: Array<Promise<void>> = [];

      for (let round = 0; round < 20; round += 1) {
        for (let id = 760; id < 770; id += 1) {
          mutations.push(Promise.resolve(auth.state.keys.set({
            "pre-key": { [String(id)]: keyPair },
          })));
          mutations.push(Promise.resolve(auth.state.keys.set({
            "pre-key": { [String(id)]: null },
          })));
        }
      }

      const results = await Promise.allSettled(mutations);
      assert.equal(
        results.filter((result) => result.status === "rejected").length,
        0,
      );
      assert.equal((await stat(authDirectory)).mode & 0o777, 0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function textMessage(id: string, text: string): WAMessage {
  return {
    key: {
      id,
      remoteJid: groupJid,
      participant: customerJid,
      fromMe: false,
    },
    messageTimestamp: 1_710_000_000,
    message: { conversation: text },
  };
}

function imageMessage(id: string, fileLength: number | null): WAMessage {
  return {
    key: {
      id,
      remoteJid: groupJid,
      participant: customerJid,
      fromMe: false,
    },
    messageTimestamp: 1_710_000_000,
    message: {
      imageMessage: {
        mimetype: "image/png",
        fileLength,
      },
    },
  };
}
