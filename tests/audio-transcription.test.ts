import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDatabase } from "../server/db/index.js";
import { SupportStore } from "../server/domain/support-store.js";
import {
  AudioTranscriptionService,
  queueRealtimeAudioTranscription,
} from "../server/transcription/service.js";
import type {
  AudioTranscriptionEngine,
  AudioTranscriptionEngineResult,
} from "../server/transcription/engine.js";
import {
  normalizedProgress,
  retryTransientModelLoad,
} from "../server/transcription/engine.js";
import type { LocalTranscriptionModelSpec } from "../server/transcription/catalog.js";

class FakeTranscriptionEngine implements AudioTranscriptionEngine {
  loadCalls: string[] = [];
  transcribeCalls: string[] = [];
  unloadCalls = 0;

  async loadModel(model: LocalTranscriptionModelSpec): Promise<void> {
    this.loadCalls.push(model.id);
  }

  async transcribe(input: { localPath: string }): Promise<AudioTranscriptionEngineResult> {
    this.transcribeCalls.push(input.localPath);
    return {
      text: "O dashboard não atualizou os pedidos de hoje.",
      language: "pt",
      durationSeconds: 8,
      needsReview: false,
    };
  }

  async unload(): Promise<void> {
    this.unloadCalls += 1;
  }
}

test("transcrição local persiste texto e só devolve áudio em tempo real para a triagem", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "threadmark-transcription-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const engine = new FakeTranscriptionEngine();
  try {
    const account = store.upsertAccount({ phoneNumber: "+5547000000000", displayName: "Comercial" });
    const client = store.upsertClient({ name: "Cliente áudio", slug: "cliente-audio", kind: "ecommerce" });
    const group = store.upsertGroup({ accountId: account.id, clientId: client.id, externalJid: "audio@g.us", subject: "Cliente áudio", monitored: true });
    const participant = store.upsertParticipant({ externalJid: "5547999999999@s.whatsapp.net", phoneE164: "+5547999999999", displayName: "Cliente" });
    store.addGroupParticipant(group.id, participant.id);

    const realtime = store.upsertMessage({
      externalId: "audio-realtime",
      groupId: group.id,
      senderId: participant.id,
      occurredAt: new Date().toISOString(),
      messageType: "audioMessage",
      triageKind: "context",
      triageState: "context",
      ingestionSource: "realtime_notify",
    });
    const realtimeAttachment = store.upsertAttachment({
      id: "audio-realtime-attachment",
      messageId: realtime.id,
      kind: "audio",
      mimeType: "audio/ogg; codecs=opus",
      fileName: "audio.ogg",
      localPath: path.join(temporary, "audio.ogg"),
      sizeBytes: 128,
      sha256: "audio-realtime-sha",
      available: true,
    });

    const realtimeBackfill = store.upsertMessage({
      externalId: "audio-realtime-backfill",
      groupId: group.id,
      senderId: participant.id,
      occurredAt: new Date(Date.now() - 120_000).toISOString(),
      messageType: "audioMessage",
      triageKind: "context",
      triageState: "context",
      ingestionSource: "realtime_notify",
    });
    store.upsertAttachment({
      id: "audio-realtime-backfill-attachment",
      messageId: realtimeBackfill.id,
      kind: "audio",
      mimeType: "audio/ogg; codecs=opus",
      fileName: "realtime-backfill.ogg",
      localPath: path.join(temporary, "realtime-backfill.ogg"),
      sizeBytes: 192,
      sha256: "audio-realtime-backfill-sha",
      available: true,
    });

    const historical = store.upsertMessage({
      externalId: "audio-history",
      groupId: group.id,
      senderId: participant.id,
      occurredAt: new Date(Date.now() - 60_000).toISOString(),
      messageType: "audioMessage",
      triageKind: "context",
      triageState: "context",
      ingestionSource: "history",
    });
    store.upsertAttachment({
      id: "audio-history-attachment",
      messageId: historical.id,
      kind: "audio",
      mimeType: "audio/ogg; codecs=opus",
      fileName: "history.ogg",
      localPath: path.join(temporary, "history.ogg"),
      sizeBytes: 256,
      sha256: "audio-history-sha",
      available: true,
    });

    database.prepare(
      `INSERT INTO local_transcription_models (model_id, state, progress, cache_bytes, error, installed_at, updated_at)
       VALUES ('onnx-community/whisper-small', 'installed', 1, 0, NULL, ?, ?)`,
    ).run(new Date().toISOString(), new Date().toISOString());
    const service = new AudioTranscriptionService(database, {
      modelsDirectory: path.join(temporary, "models"),
      engine,
      pollIntervalMs: 5,
      idleUnloadMs: 5,
    });
    service.updateSettings({
      enabled: true,
      modelId: "onnx-community/whisper-small",
      language: "pt",
      autoTranscribeNew: true,
      actor: "Teste",
    });

    assert.equal(queueRealtimeAudioTranscription(database, realtimeAttachment.id, realtime.id), true);
    assert.equal(service.queueHistorical(100), 2);

    const controller = new AbortController();
    const worker = service.run(controller.signal);
    await waitUntil(() => {
      const row = database.prepare(
        `SELECT COUNT(*) AS count FROM audio_transcriptions WHERE status = 'completed'`,
      ).get() as { count: number };
      return row.count === 3;
    });
    controller.abort();
    await worker;

    const rows = database.prepare(
      `SELECT transcription.source, transcription.status, transcription.text,
              attachment.extracted_text, message.triage_state
       FROM audio_transcriptions transcription
       JOIN attachments attachment ON attachment.id = transcription.attachment_id
       JOIN messages message ON message.id = transcription.message_id
       ORDER BY transcription.source`,
    ).all() as Array<{
      source: "manual_history" | "realtime";
      status: string;
      text: string;
      extracted_text: string;
      triage_state: string;
    }>;

    assert.equal(rows.length, 3);
    assert.ok(rows.every((row) => row.status === "completed"));
    assert.ok(rows.every((row) => row.extracted_text.includes("dashboard não atualizou")));
    assert.equal(
      rows.filter((row) => row.source === "manual_history").length,
      2,
    );
    assert.ok(
      rows
        .filter((row) => row.source === "manual_history")
        .every((row) => row.triage_state === "context"),
    );
    assert.equal(rows.find((row) => row.source === "realtime")?.triage_state, "unreviewed");
    assert.equal(engine.transcribeCalls.length, 3);
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("configuração não ativa um modelo que ainda não foi instalado", () => {
  const database = createDatabase(":memory:");
  try {
    const service = new AudioTranscriptionService(database, {
      modelsDirectory: path.join(os.tmpdir(), "threadmark-missing-model"),
      engine: new FakeTranscriptionEngine(),
    });
    assert.throws(
      () => service.updateSettings({ enabled: true, modelId: "onnx-community/whisper-small", autoTranscribeNew: true, actor: "Teste" }),
      /Baixe o modelo selecionado/,
    );
  } finally {
    database.close();
  }
});

test("áudio específico sem transcrição pode ser colocado manualmente na fila", () => {
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  try {
    const account = store.upsertAccount({ phoneNumber: "+5547000000000", displayName: "Comercial" });
    const client = store.upsertClient({ name: "Cliente áudio", slug: "cliente-audio-manual", kind: "ecommerce" });
    const group = store.upsertGroup({ accountId: account.id, clientId: client.id, externalJid: "audio-manual@g.us", subject: "Cliente áudio", monitored: true });
    const participant = store.upsertParticipant({ externalJid: "5547999999999@s.whatsapp.net", phoneE164: "+5547999999999", displayName: "Cliente" });
    store.addGroupParticipant(group.id, participant.id);
    const message = store.upsertMessage({
      externalId: "audio-manual",
      groupId: group.id,
      senderId: participant.id,
      occurredAt: new Date().toISOString(),
      messageType: "audioMessage",
      triageKind: "context",
      triageState: "context",
      ingestionSource: "history",
    });
    const attachment = store.upsertAttachment({
      id: "audio-manual-attachment",
      messageId: message.id,
      kind: "audio",
      mimeType: "audio/ogg; codecs=opus",
      fileName: "manual.ogg",
      localPath: "/tmp/manual.ogg",
      sizeBytes: 128,
      sha256: "audio-manual-sha",
      available: true,
    });
    database.prepare(
      `INSERT INTO local_transcription_models (model_id, state, progress, cache_bytes, error, installed_at, updated_at)
       VALUES ('onnx-community/whisper-small', 'installed', 1, 0, NULL, ?, ?)`,
    ).run(new Date().toISOString(), new Date().toISOString());
    const service = new AudioTranscriptionService(database, {
      modelsDirectory: path.join(os.tmpdir(), "threadmark-manual-transcription"),
      engine: new FakeTranscriptionEngine(),
    });
    service.updateSettings({
      enabled: true,
      modelId: "onnx-community/whisper-small",
      language: "pt",
      autoTranscribeNew: true,
      actor: "Teste",
    });

    assert.equal(service.queueAttachment(attachment.id), true);
    assert.equal(service.queueAttachment(attachment.id), false);
    assert.deepEqual(
      database.prepare(
        `SELECT status, source, message_id FROM audio_transcriptions WHERE attachment_id = ?`,
      ).get(attachment.id),
      { status: "queued", source: "manual_history", message_id: message.id },
    );
  } finally {
    database.close();
  }
});

test("recurso desativado não cria uma fila oculta para áudio novo", () => {
  const database = createDatabase(":memory:");
  try {
    assert.equal(
      queueRealtimeAudioTranscription(database, "attachment-disabled", "message-disabled"),
      false,
    );
    const row = database.prepare(
      `SELECT COUNT(*) AS count FROM audio_transcriptions`,
    ).get() as { count: number };
    assert.equal(row.count, 0);
  } finally {
    database.close();
  }
});

test("progresso do modelo usa o total agregado e não arquivos auxiliares isolados", () => {
  assert.equal(
    normalizedProgress({ status: "progress_total", progress: 42 }),
    0.42,
  );
  assert.equal(normalizedProgress({ status: "done" }), null);
  assert.equal(normalizedProgress({ status: "ready" }), 1);
});

test("carregamento do modelo repete falhas transitórias sem ocultar erros definitivos", async () => {
  let attempts = 0;
  const loaded = await retryTransientModelLoad(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("Unable to get model file path or buffer.");
      }
      return "ready";
    },
    { attempts: 3, retryDelayMs: 0 },
  );
  assert.equal(loaded, "ready");
  assert.equal(attempts, 3);

  await assert.rejects(
    retryTransientModelLoad(
      async () => {
        throw new Error("Modelo incompatível");
      },
      { attempts: 3, retryDelayMs: 0 },
    ),
    /Modelo incompatível/,
  );
});

test("falha de instalação ignora callbacks de progresso atrasados", async () => {
  const database = createDatabase(":memory:");
  class LateProgressEngine extends FakeTranscriptionEngine {
    override async loadModel(
      _model: LocalTranscriptionModelSpec,
      options?: { onProgress?(progress: number): void },
    ): Promise<void> {
      setTimeout(() => options?.onProgress?.(1), 10);
      throw new Error("Falha de download");
    }
  }
  try {
    const service = new AudioTranscriptionService(database, {
      modelsDirectory: path.join(os.tmpdir(), "threadmark-late-progress"),
      engine: new LateProgressEngine(),
    });
    service.startModelInstall("onnx-community/whisper-small");
    await waitUntil(() => {
      const row = database
        .prepare(
          `SELECT state FROM local_transcription_models WHERE model_id = ?`,
        )
        .get("onnx-community/whisper-small") as { state: string } | undefined;
      return row?.state === "error";
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const row = database
      .prepare(
        `SELECT state, progress FROM local_transcription_models WHERE model_id = ?`,
      )
      .get("onnx-community/whisper-small") as {
      state: string;
      progress: number;
    };
    assert.equal(row.state, "error");
    assert.equal(row.progress, 0);
  } finally {
    database.close();
  }
});

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Tempo esgotado aguardando a transcrição de teste");
}
