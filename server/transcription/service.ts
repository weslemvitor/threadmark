import os from "node:os";
import path from "node:path";
import { mkdir, readdir, rm, stat, statfs } from "node:fs/promises";

import type {
  AudioTranscriptionSettingsDto,
  LocalTranscriptionModelDto,
} from "../../shared/contracts.js";
import type { SupportDatabase } from "../db/index.js";
import {
  DEFAULT_TRANSCRIPTION_MODEL_ID,
  LOCAL_TRANSCRIPTION_MODELS,
  modelCacheKey,
  requireTranscriptionModel,
} from "./catalog.js";
import {
  TransformersAudioTranscriptionEngine,
  type AudioTranscriptionEngine,
} from "./engine.js";

const IDLE_UNLOAD_MS = 2 * 60_000;
const POLL_INTERVAL_MS = 1_500;

type RuntimeState = AudioTranscriptionSettingsDto["runtime"]["state"];

interface TranscriptionSettingsRow {
  enabled: number;
  model_id: string;
  language: string;
  auto_transcribe_new: number;
  updated_at: string;
}

interface ClaimedTranscription {
  attachmentId: string;
  messageId: string;
  localPath: string;
  mimeType: string;
  modelId: string;
  language: string;
  source: "realtime" | "manual_history";
}

export interface AudioTranscriptionSettingsInput {
  enabled: boolean;
  modelId: string;
  language?: string;
  autoTranscribeNew: boolean;
  actor: string;
}

export interface AudioTranscriptionServiceOptions {
  modelsDirectory: string;
  engine?: AudioTranscriptionEngine;
  idleUnloadMs?: number;
  pollIntervalMs?: number;
  onError?(error: unknown): void;
}

export class AudioTranscriptionService {
  private readonly engine: AudioTranscriptionEngine;
  private readonly idleUnloadMs: number;
  private readonly pollIntervalMs: number;
  private runtimeState: RuntimeState = "idle";
  private activeModelId: string | null = null;
  private runtimeError: string | null = null;
  private unloadTimer: NodeJS.Timeout | null = null;
  private readonly installations = new Map<string, Promise<void>>();

  constructor(
    private readonly database: SupportDatabase,
    private readonly options: AudioTranscriptionServiceOptions,
  ) {
    this.engine =
      options.engine ??
      new TransformersAudioTranscriptionEngine(options.modelsDirectory);
    this.idleUnloadMs = options.idleUnloadMs ?? IDLE_UNLOAD_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.database
      .prepare(
        `UPDATE audio_transcriptions
         SET status = 'queued', started_at = NULL,
             error = 'Execução interrompida; aguardando retomada', updated_at = ?
         WHERE status = 'processing'`,
      )
      .run(new Date().toISOString());
    this.database
      .prepare(
        `UPDATE local_transcription_models
         SET state = 'error', error = 'Download interrompido; tente novamente',
             progress = 0, updated_at = ?
         WHERE state = 'downloading'`,
      )
      .run(new Date().toISOString());
  }

  async getSettings(): Promise<AudioTranscriptionSettingsDto> {
    const settings = this.settingsRow();
    const modelRows = this.database
      .prepare(
        `SELECT model_id, state, progress, cache_bytes, error, installed_at
         FROM local_transcription_models`,
      )
      .all() as Array<{
      model_id: string;
      state: LocalTranscriptionModelDto["state"];
      progress: number;
      cache_bytes: number;
      error: string | null;
      installed_at: string | null;
    }>;
    const states = new Map(modelRows.map((row) => [row.model_id, row]));
    const queueRows = this.database
      .prepare(
        `SELECT status, COUNT(*) AS count
         FROM audio_transcriptions
         WHERE status IN ('queued', 'processing', 'review', 'failed')
         GROUP BY status`,
      )
      .all() as Array<{ status: "queued" | "processing" | "review" | "failed"; count: number }>;
    const queue = { queued: 0, processing: 0, review: 0, failed: 0 };
    for (const row of queueRows) queue[row.status] = row.count;
    const [cacheBytes, availableDiskBytes] = await Promise.all([
      directoryBytes(this.options.modelsDirectory),
      availableBytes(this.options.modelsDirectory),
    ]);
    return {
      enabled: Boolean(settings.enabled),
      modelId: settings.model_id,
      language: settings.language,
      autoTranscribeNew: Boolean(settings.auto_transcribe_new),
      updatedAt: settings.updated_at,
      queue,
      runtime: {
        state: this.runtimeState,
        activeModelId: this.activeModelId,
        totalMemoryBytes: os.totalmem(),
        freeMemoryBytes: os.freemem(),
        availableDiskBytes,
        cacheBytes,
        unloadAfterSeconds: Math.round(this.idleUnloadMs / 1_000),
        error: this.runtimeError,
      },
      models: LOCAL_TRANSCRIPTION_MODELS.map((model) => {
        const persisted = states.get(model.id);
        return {
          id: model.id,
          label: model.label,
          description: model.description,
          estimatedDiskBytes: model.estimatedDiskBytes,
          estimatedRamBytes: model.estimatedRamBytes,
          recommended: model.recommended,
          state: persisted?.state ?? "not_installed",
          progress: persisted?.progress ?? 0,
          cacheBytes: persisted?.cache_bytes ?? 0,
          error: persisted?.error ?? null,
          installedAt: persisted?.installed_at ?? null,
        };
      }),
    };
  }

  updateSettings(
    input: AudioTranscriptionSettingsInput,
  ): void {
    requireTranscriptionModel(input.modelId);
    const language = normalizedLanguage(input.language ?? "pt");
    if (input.enabled && !this.isModelInstalled(input.modelId)) {
      throw new Error("Baixe o modelo selecionado antes de ativar a transcrição");
    }
    const now = new Date().toISOString();
    this.database
      .prepare(
        `UPDATE audio_transcription_settings
         SET enabled = ?, model_id = ?, language = ?, auto_transcribe_new = ?,
             updated_by = ?, updated_at = ?
         WHERE singleton = 1`,
      )
      .run(
        input.enabled ? 1 : 0,
        input.modelId,
        language,
        input.autoTranscribeNew ? 1 : 0,
        input.actor.trim() || "Operador local",
        now,
      );
    this.database
      .prepare(
        `UPDATE audio_transcriptions
         SET model_id = ?, language = ?, updated_at = ?
         WHERE status = 'queued'`,
      )
      .run(input.modelId, language, now);
    if (!input.enabled) void this.unload();
  }

  startModelInstall(modelId: string): void {
    const model = requireTranscriptionModel(modelId);
    if (this.installations.has(modelId)) return;
    if (this.installations.size > 0) {
      throw new Error("Aguarde o download atual terminar antes de baixar outro modelo");
    }
    if (this.runtimeState === "loading" || this.runtimeState === "processing") {
      throw new Error("Aguarde a transcrição atual terminar antes de baixar um modelo");
    }
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO local_transcription_models (
           model_id, state, progress, cache_bytes, error, installed_at, updated_at
         ) VALUES (?, 'downloading', 0, 0, NULL, NULL, ?)
         ON CONFLICT(model_id) DO UPDATE SET
           state = 'downloading', progress = 0, error = NULL, updated_at = excluded.updated_at`,
      )
      .run(modelId, now);
    let lastPersistedProgress = 0;
    let acceptsProgress = true;
    const installation = (async () => {
      this.setRuntime("loading", modelId, null);
      try {
        await mkdir(this.options.modelsDirectory, { recursive: true, mode: 0o700 });
        await this.engine.loadModel(model, {
          onProgress: (progress) => {
            if (!acceptsProgress) return;
            const safeProgress = Math.max(lastPersistedProgress, Math.min(1, progress));
            if (safeProgress < 1 && safeProgress - lastPersistedProgress < 0.02) return;
            lastPersistedProgress = safeProgress;
            this.database
              .prepare(
                `UPDATE local_transcription_models
                 SET progress = ?, updated_at = ? WHERE model_id = ?`,
              )
              .run(safeProgress, new Date().toISOString(), modelId);
          },
        });
        const cacheBytes = await directoryBytes(this.modelDirectory(modelId));
        const installedAt = new Date().toISOString();
        this.database
          .prepare(
            `UPDATE local_transcription_models
             SET state = 'installed', progress = 1, cache_bytes = ?, error = NULL,
                 installed_at = ?, updated_at = ?
             WHERE model_id = ?`,
          )
          .run(cacheBytes, installedAt, installedAt, modelId);
        this.setRuntime("ready", modelId, null);
        this.scheduleUnload();
      } catch (error) {
        acceptsProgress = false;
        const message = errorMessage(error);
        this.database
          .prepare(
            `UPDATE local_transcription_models
             SET state = 'error', progress = 0, error = ?, updated_at = ?
             WHERE model_id = ?`,
          )
          .run(message, new Date().toISOString(), modelId);
        this.setRuntime("error", null, message);
        this.options.onError?.(error);
      } finally {
        acceptsProgress = false;
        this.installations.delete(modelId);
      }
    })();
    this.installations.set(modelId, installation);
  }

  async removeModel(modelId: string): Promise<void> {
    requireTranscriptionModel(modelId);
    const settings = this.settingsRow();
    if (Boolean(settings.enabled) && settings.model_id === modelId) {
      throw new Error("Desative a transcrição antes de remover o modelo em uso");
    }
    if (this.installations.size > 0) {
      throw new Error("Aguarde o download atual terminar antes de remover um modelo");
    }
    if (this.activeModelId === modelId) await this.unload();
    await rm(this.modelDirectory(modelId), { recursive: true, force: true });
    this.database
      .prepare(
        `INSERT INTO local_transcription_models (
           model_id, state, progress, cache_bytes, error, installed_at, updated_at
         ) VALUES (?, 'not_installed', 0, 0, NULL, NULL, ?)
         ON CONFLICT(model_id) DO UPDATE SET
           state = 'not_installed', progress = 0, cache_bytes = 0,
           error = NULL, installed_at = NULL, updated_at = excluded.updated_at`,
      )
      .run(modelId, new Date().toISOString());
  }

  queueHistorical(limit = 100): number {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 500);
    const settings = this.settingsRow();
    if (!Boolean(settings.enabled)) {
      throw new Error("Ative a transcrição antes de processar áudios antigos");
    }
    if (!this.isModelInstalled(settings.model_id)) {
      throw new Error("Baixe o modelo selecionado antes de processar áudios antigos");
    }
    const now = new Date().toISOString();
    const candidates = this.database
      .prepare(
        `SELECT attachment.id, attachment.message_id
         FROM attachments attachment
         JOIN messages message ON message.id = attachment.message_id
         WHERE attachment.kind = 'audio' AND attachment.available = 1
           AND NOT EXISTS (
             SELECT 1 FROM audio_transcriptions transcription
             WHERE transcription.attachment_id = attachment.id
           )
         ORDER BY message.occurred_at DESC, attachment.id
         LIMIT ?`,
      )
      .all(safeLimit) as Array<{ id: string; message_id: string }>;
    const insert = this.database.prepare(
      `INSERT OR IGNORE INTO audio_transcriptions (
         attachment_id, message_id, status, source, model_id, language,
         text, confidence, duration_seconds, error, attempts,
         requested_at, started_at, completed_at, created_at, updated_at
       ) VALUES (?, ?, 'queued', 'manual_history', ?, ?, NULL, NULL, NULL,
                 NULL, 0, ?, NULL, NULL, ?, ?)`,
    );
    return this.database.transaction(() => {
      let queued = 0;
      for (const candidate of candidates) {
        queued += insert.run(
          candidate.id,
          candidate.message_id,
          settings.model_id,
          settings.language,
          now,
          now,
          now,
        ).changes;
      }
      return queued;
    })();
  }

  queueAttachment(attachmentId: string): boolean {
    const settings = this.settingsRow();
    if (!Boolean(settings.enabled)) {
      throw new Error("Ative a transcrição antes de processar este áudio");
    }
    if (!this.isModelInstalled(settings.model_id)) {
      throw new Error("Baixe o modelo selecionado antes de processar este áudio");
    }
    const attachment = this.database
      .prepare(
        `SELECT id, message_id
         FROM attachments
         WHERE id = ? AND kind = 'audio' AND available = 1`,
      )
      .get(attachmentId) as { id: string; message_id: string } | undefined;
    if (!attachment) return false;

    const current = this.database
      .prepare(`SELECT status FROM audio_transcriptions WHERE attachment_id = ?`)
      .get(attachmentId) as { status: string } | undefined;
    if (current && !["failed", "review"].includes(current.status)) return false;

    const now = new Date().toISOString();
    if (current) {
      return Boolean(
        this.database
          .prepare(
            `UPDATE audio_transcriptions
             SET status = 'queued', source = 'manual_history', model_id = ?,
                 language = ?, text = NULL, confidence = NULL, error = NULL,
                 started_at = NULL, completed_at = NULL, requested_at = ?,
                 updated_at = ?
             WHERE attachment_id = ? AND status IN ('failed', 'review')`,
          )
          .run(
            settings.model_id,
            settings.language,
            now,
            now,
            attachmentId,
          ).changes,
      );
    }

    return Boolean(
      this.database
        .prepare(
          `INSERT INTO audio_transcriptions (
             attachment_id, message_id, status, source, model_id, language,
             text, confidence, duration_seconds, error, attempts,
             requested_at, started_at, completed_at, created_at, updated_at
           ) VALUES (?, ?, 'queued', 'manual_history', ?, ?, NULL, NULL, NULL,
                     NULL, 0, ?, NULL, NULL, ?, ?)`,
        )
        .run(
          attachment.id,
          attachment.message_id,
          settings.model_id,
          settings.language,
          now,
          now,
          now,
        ).changes,
    );
  }

  retryAttachment(attachmentId: string): boolean {
    const settings = this.settingsRow();
    if (!Boolean(settings.enabled)) {
      throw new Error("Ative a transcrição antes de tentar novamente");
    }
    if (!this.isModelInstalled(settings.model_id)) {
      throw new Error("Baixe o modelo selecionado antes de tentar novamente");
    }
    const now = new Date().toISOString();
    return Boolean(
      this.database
        .prepare(
          `UPDATE audio_transcriptions
           SET status = 'queued', model_id = ?, language = ?, text = NULL,
               confidence = NULL, error = NULL, started_at = NULL,
               completed_at = NULL, requested_at = ?, updated_at = ?
           WHERE attachment_id = ? AND status IN ('failed', 'review')`,
        )
        .run(settings.model_id, settings.language, now, now, attachmentId).changes,
    );
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const settings = this.settingsRow();
        if (
          this.installations.size === 0 &&
          Boolean(settings.enabled) &&
          this.isModelInstalled(settings.model_id)
        ) {
          const job = this.claimNext();
          if (job) {
            await this.process(job);
            continue;
          }
        }
      } catch (error) {
        this.options.onError?.(error);
      }
      await abortableDelay(this.pollIntervalMs, signal);
    }
    await this.unload();
  }

  async stop(): Promise<void> {
    await Promise.allSettled(this.installations.values());
    await this.unload();
  }

  private async process(job: ClaimedTranscription): Promise<void> {
    const model = requireTranscriptionModel(job.modelId);
    try {
      this.cancelScheduledUnload();
      this.setRuntime("loading", model.id, null);
      await this.engine.loadModel(model, { localFilesOnly: true });
      this.setRuntime("processing", model.id, null);
      const result = await this.engine.transcribe({
        localPath: job.localPath,
        mimeType: job.mimeType,
        language: job.language,
      });
      const now = new Date().toISOString();
      const status = result.needsReview ? "review" : "completed";
      this.database.transaction(() => {
        this.database
          .prepare(
            `UPDATE audio_transcriptions
             SET status = ?, text = ?, duration_seconds = ?, error = NULL,
                 completed_at = ?, updated_at = ?
             WHERE attachment_id = ?`,
          )
          .run(status, result.text || null, result.durationSeconds, now, now, job.attachmentId);
        if (status === "completed") {
          this.database
            .prepare(
              `UPDATE attachments SET extracted_text = ?, updated_at = ? WHERE id = ?`,
            )
            .run(`Transcrição do áudio:\n${result.text}`, now, job.attachmentId);
          if (job.source === "realtime") {
            this.requeueRealtimeMessage(job.messageId, now);
          }
        }
      })();
      this.setRuntime("ready", model.id, null);
    } catch (error) {
      const message = errorMessage(error);
      const now = new Date().toISOString();
      this.database
        .prepare(
          `UPDATE audio_transcriptions
           SET status = 'failed', error = ?, completed_at = ?, updated_at = ?
           WHERE attachment_id = ?`,
        )
        .run(message, now, now, job.attachmentId);
      this.setRuntime("error", this.activeModelId, message);
      this.options.onError?.(error);
    } finally {
      this.scheduleUnload();
    }
  }

  private claimNext(): ClaimedTranscription | null {
    return this.database.transaction(() => {
      const row = this.database
        .prepare(
          `SELECT transcription.attachment_id, transcription.message_id,
                  transcription.model_id, transcription.language,
                  transcription.source, attachment.local_path, attachment.mime_type
           FROM audio_transcriptions transcription
           JOIN attachments attachment ON attachment.id = transcription.attachment_id
           WHERE transcription.status = 'queued' AND attachment.available = 1
           ORDER BY transcription.requested_at, transcription.attachment_id
           LIMIT 1`,
        )
        .get() as
        | {
            attachment_id: string;
            message_id: string;
            model_id: string;
            language: string;
            source: "realtime" | "manual_history";
            local_path: string;
            mime_type: string;
          }
        | undefined;
      if (!row) return null;
      const now = new Date().toISOString();
      const claimed = this.database
        .prepare(
          `UPDATE audio_transcriptions
           SET status = 'processing', attempts = attempts + 1,
               started_at = ?, error = NULL, updated_at = ?
           WHERE attachment_id = ? AND status = 'queued'`,
        )
        .run(now, now, row.attachment_id);
      if (!claimed.changes) return null;
      return {
        attachmentId: row.attachment_id,
        messageId: row.message_id,
        modelId: row.model_id,
        language: row.language,
        source: row.source,
        localPath: row.local_path,
        mimeType: row.mime_type,
      };
    })();
  }

  private requeueRealtimeMessage(messageId: string, now: string): void {
    this.database
      .prepare(
        `UPDATE messages
         SET triage_kind = 'unclassified', triage_state = 'unreviewed', updated_at = ?
         WHERE id = ? AND triage_state = 'context'
           AND NOT EXISTS (
             SELECT 1 FROM staff_members staff
             WHERE staff.participant_id = messages.sender_id AND staff.active = 1
           )
           AND NOT EXISTS (
             SELECT 1 FROM ticket_messages WHERE message_id = messages.id
           )
           AND EXISTS (
             SELECT 1
             FROM whatsapp_groups conversation
             JOIN clients client ON client.id = conversation.client_id
             WHERE conversation.id = messages.group_id
               AND conversation.suggestions_muted_at IS NULL
               AND client.ignored_at IS NULL
               AND (
                 conversation.monitored = 1
                 OR conversation.external_jid LIKE '%@s.whatsapp.net'
                 OR conversation.external_jid LIKE '%@lid'
               )
           )`,
      )
      .run(now, messageId);
  }

  private settingsRow(): TranscriptionSettingsRow {
    return this.database
      .prepare(
        `SELECT enabled, model_id, language, auto_transcribe_new, updated_at
         FROM audio_transcription_settings WHERE singleton = 1`,
      )
      .get() as TranscriptionSettingsRow;
  }

  private isModelInstalled(modelId: string): boolean {
    return Boolean(
      this.database
        .prepare(
          `SELECT 1 FROM local_transcription_models
           WHERE model_id = ? AND state = 'installed'`,
        )
        .get(modelId),
    );
  }

  private modelDirectory(modelId: string): string {
    return path.join(this.options.modelsDirectory, modelCacheKey(modelId));
  }

  private setRuntime(
    state: RuntimeState,
    activeModelId: string | null,
    error: string | null,
  ): void {
    this.runtimeState = state;
    this.activeModelId = activeModelId;
    this.runtimeError = error;
  }

  private scheduleUnload(): void {
    this.cancelScheduledUnload();
    this.unloadTimer = setTimeout(() => void this.unload(), this.idleUnloadMs);
    this.unloadTimer.unref?.();
  }

  private cancelScheduledUnload(): void {
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    this.unloadTimer = null;
  }

  private async unload(): Promise<void> {
    this.cancelScheduledUnload();
    await this.engine.unload();
    this.setRuntime("idle", null, null);
  }
}

export function queueRealtimeAudioTranscription(
  database: SupportDatabase,
  attachmentId: string,
  messageId: string,
): boolean {
  const settings = database
    .prepare(
      `SELECT enabled, model_id, language, auto_transcribe_new
       FROM audio_transcription_settings WHERE singleton = 1`,
    )
    .get() as
    | { enabled: number; model_id: string; language: string; auto_transcribe_new: number }
    | undefined;
  if (!settings?.enabled || !settings.auto_transcribe_new) return false;
  const now = new Date().toISOString();
  return Boolean(
    database
      .prepare(
        `INSERT OR IGNORE INTO audio_transcriptions (
           attachment_id, message_id, status, source, model_id, language,
           text, confidence, duration_seconds, error, attempts,
           requested_at, started_at, completed_at, created_at, updated_at
         ) VALUES (?, ?, 'queued', 'realtime', ?, ?, NULL, NULL, NULL,
                   NULL, 0, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        attachmentId,
        messageId,
        settings.model_id,
        settings.language,
        now,
        now,
        now,
      ).changes,
  );
}

function normalizedLanguage(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(normalized)) {
    throw new Error("Idioma de transcrição inválido");
  }
  return normalized;
}

async function directoryBytes(directory: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(target);
    else if (entry.isFile()) total += (await stat(target)).size;
  }
  return total;
}

async function availableBytes(directory: string): Promise<number | null> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const fileSystem = await statfs(directory);
    return Number(fileSystem.bavail) * Number(fileSystem.bsize);
  } catch {
    return null;
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { DEFAULT_TRANSCRIPTION_MODEL_ID };
