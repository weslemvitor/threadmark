import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDatabase } from "../server/db/index.js";
import { SupportStore } from "../server/domain/support-store.js";
import { LOCAL_TRANSCRIPTION_MODELS } from "../server/transcription/catalog.js";
import { ProcessAudioTranscriptionEngine } from "../server/transcription/process-engine.js";
import { AudioTranscriptionService } from "../server/transcription/service.js";

const model = LOCAL_TRANSCRIPTION_MODELS[0];
const workerUrl = new URL("./fixtures/transcription-worker.mjs", import.meta.url);
const audio = (localPath: string) => ({ localPath, mimeType: "audio/ogg", language: "pt" });
const fakeEngine = (timeoutMs = 1_000) => new ProcessAudioTranscriptionEngine("synthetic-models", {
  workerUrl, timeoutMs, installTimeoutMs: 5_000,
});

function assertExited(pid: number): void {
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}

test("timeout mata inferência bloqueada, preserva progresso e permite um novo processo", { timeout: 15_000 }, async () => {
  const engine = fakeEngine();
  try {
    const progress: number[] = [];
    await engine.loadModel(model, { onProgress: (value) => progress.push(value) });
    assert.deepEqual(progress, [0.5]);
    const first = await engine.transcribe(audio("ok.ogg"));
    const oldPid = Number(first.text);
    await assert.rejects(engine.transcribe(audio("hang.ogg")), /excedeu o limite.*processo encerrado/);
    assertExited(oldPid);
    await engine.loadModel(model);
    const next = await engine.transcribe(audio("ok.ogg"));
    assert.notEqual(next.text, first.text);
    await engine.unload();
    assertExited(Number(next.text));
  } finally {
    await engine.unload();
  }
});

test("processo que cai é descartado e o próximo áudio pode executar", { timeout: 15_000 }, async () => {
  const engine = fakeEngine();
  try {
    await engine.loadModel(model);
    await assert.rejects(engine.transcribe(audio("crash.ogg")), /inesperadamente.*42/);
    await engine.loadModel(model);
    assert.ok((await engine.transcribe(audio("ok.ogg"))).text);
  } finally {
    await engine.unload();
  }
});

test("carregamento bloqueado também tem prazo e pode ser interrompido", { timeout: 15_000 }, async () => {
  const engine = new ProcessAudioTranscriptionEngine("hang-load", { workerUrl, installTimeoutMs: 1_000 });
  try {
    await assert.rejects(engine.loadModel(model), /excedeu o limite/);
  } finally {
    await engine.unload();
  }
});

test("worker real inicia pelo TypeScript sem baixar modelo e propaga seu erro", { timeout: 15_000 }, async () => {
  const engine = new ProcessAudioTranscriptionEngine("synthetic-models", { timeoutMs: 10_000 });
  try {
    await assert.rejects(engine.transcribe(audio("unused.ogg")), /Modelo local de transcrição não carregado/);
  } finally {
    await engine.unload();
  }
});

test("prazo inválido é rejeitado antes de iniciar o worker", () => {
  for (const timeoutMs of [0, -1, NaN, Infinity, 2_147_483_648]) {
    assert.throws(() => new ProcessAudioTranscriptionEngine("synthetic-models", { timeoutMs }), /inteiro positivo/);
  }
});

test("unload imediato cancela uma operação que ainda não criou o processo", async () => {
  const engine = fakeEngine();
  const loading = engine.loadModel(model);
  const unloading = engine.unload();
  await assert.rejects(loading, /interrompida/);
  await unloading;
});

test("erro ao persistir progresso rejeita a instalação sem escapar do callback IPC", async () => {
  const engine = fakeEngine();
  try {
    await assert.rejects(engine.loadModel(model, { onProgress() { throw new Error("Falha de persistência"); } }), /Falha de persistência/);
    await engine.loadModel(model);
    assert.ok((await engine.transcribe(audio("ok.ogg"))).text);
  } finally {
    await engine.unload();
  }
});

async function queueFixture(timeoutMs = 1_000) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadmark-audio-timeout-"));
  const database = createDatabase(":memory:");
  const store = new SupportStore(database);
  const account = store.upsertAccount({ phoneNumber: "+5500000000000", displayName: "Conta teste" });
  const client = store.upsertClient({ name: "Cliente teste", slug: "audio-timeout", kind: "ecommerce" });
  const group = store.upsertGroup({ accountId: account.id, clientId: client.id,
    externalJid: "120363000000000000@g.us", subject: "Áudios teste", monitored: true });
  const sender = store.upsertParticipant({ externalJid: "900000000000001@lid", displayName: "Cliente teste" });
  for (const name of ["hang", "ok"]) {
    const message = store.upsertMessage({ externalId: `synthetic-${name}`, groupId: group.id,
      senderId: sender.id, occurredAt: `2026-01-01T00:00:0${name === "hang" ? 0 : 1}.000Z`,
      messageType: "audioMessage", triageKind: "context", triageState: "context", ingestionSource: "history" });
    const localPath = path.join(directory, `${name}.ogg`);
    await writeFile(localPath, "synthetic-audio");
    store.upsertAttachment({ id: name, messageId: message.id, kind: "audio", mimeType: "audio/ogg",
      localPath, sha256: `synthetic-${name}`, available: true });
  }
  database.prepare(`INSERT INTO local_transcription_models (model_id, state, progress, updated_at)
    VALUES (?, 'installed', 1, ?)`).run(model.id, new Date().toISOString());
  const makeService = () => new AudioTranscriptionService(database, {
    modelsDirectory: directory, engine: fakeEngine(timeoutMs), pollIntervalMs: 5,
  });
  const service = makeService();
  service.updateSettings({ enabled: true, modelId: model.id, autoTranscribeNew: true, actor: "Teste" });
  service.queueHistorical();
  database.prepare("UPDATE audio_transcriptions SET requested_at = attachment_id").run();
  const row = (id: string) => database.prepare("SELECT * FROM audio_transcriptions WHERE attachment_id = ?").get(id) as {
    status: string; attempts: number; error: string | null; completed_at: string | null; started_at: string | null;
  };
  return { directory, database, service, row, makeService, async cleanup() {
    await service.stop();
    database.close();
    await rm(directory, { recursive: true, force: true });
  } };
}

test("áudio bloqueado falha sem perder o original e o próximo conclui", { timeout: 15_000 }, async () => {
  const fixture = await queueFixture();
  const controller = new AbortController();
  const run = fixture.service.run(controller.signal);
  try {
    await waitUntil(() => fixture.row("ok").status === "completed");
    assert.equal(fixture.row("hang").status, "failed");
    assert.equal(fixture.row("hang").attempts, 1);
    assert.match(fixture.row("hang").error!, /excedeu o limite/);
    assert.ok(fixture.row("hang").completed_at);
    assert.equal(await readFile(path.join(fixture.directory, "hang.ogg"), "utf8"), "synthetic-audio");
    const attachment = fixture.database.prepare("SELECT extracted_text FROM attachments WHERE id = 'ok'").get() as { extracted_text: string };
    assert.match(attachment.extracted_text, /Transcrição do áudio:/);
  } finally {
    controller.abort();
    await run;
    await fixture.cleanup();
  }
});

test("shutdown interrompe o áudio prontamente e mantém uma retomada limitada", { timeout: 15_000 }, async () => {
  const fixture = await queueFixture(10_000);
  const controller = new AbortController();
  const run = fixture.service.run(controller.signal);
  try {
    await waitUntil(() => fixture.row("hang").status === "processing");
    controller.abort();
    await within(run, 2_000);
    assert.equal(fixture.row("hang").status, "queued");
    assert.equal(fixture.row("hang").started_at, null);
    assert.equal(fixture.row("ok").attempts, 0);
    assert.equal(fixture.row("hang").attempts, 1);
  } finally {
    controller.abort();
    await fixture.service.stop();
    await run;
    await fixture.cleanup();
  }
});

async function within(operation: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout;
  try {
    await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Encerramento não interrompeu a inferência")), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer!);
  }
}

test("reinicializações esgotam 3 tentativas; retry manual inicia um novo orçamento", async () => {
  const fixture = await queueFixture();
  try {
    fixture.database.prepare("UPDATE audio_transcriptions SET status = 'processing', attempts = 3 WHERE attachment_id = 'hang'").run();
    fixture.database.prepare("UPDATE audio_transcriptions SET status = 'processing', attempts = 1 WHERE attachment_id = 'ok'").run();
    const restarted = fixture.makeService();
    assert.equal(fixture.row("hang").status, "failed");
    assert.match(fixture.row("hang").error!, /Limite de 3 tentativas/);
    assert.equal(fixture.row("ok").status, "queued");
    assert.equal(fixture.row("ok").attempts, 1);
    assert.equal(restarted.retryAttachment("hang"), true);
    assert.equal(fixture.row("hang").attempts, 0);
    assert.equal(fixture.row("hang").status, "queued");
    fixture.database.prepare("UPDATE audio_transcriptions SET status = 'failed', attempts = 3 WHERE attachment_id = 'hang'").run();
    assert.equal(restarted.queueAttachment("hang"), true);
    assert.equal(fixture.row("hang").attempts, 0);
    await restarted.stop();
  } finally {
    await fixture.cleanup();
  }
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Tempo esgotado aguardando worker de teste");
}
