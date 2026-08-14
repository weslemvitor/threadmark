import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import { OggOpusDecoder } from "ogg-opus-decoder";

import type { LocalTranscriptionModelSpec } from "./catalog.js";
import { modelCacheKey } from "./catalog.js";

export interface AudioTranscriptionEngineResult {
  text: string;
  language: string;
  durationSeconds: number;
  needsReview: boolean;
}

export interface AudioTranscriptionEngine {
  loadModel(
    model: LocalTranscriptionModelSpec,
    options?: {
      localFilesOnly?: boolean;
      onProgress?(progress: number): void;
    },
  ): Promise<void>;
  transcribe(input: {
    localPath: string;
    mimeType: string;
    language: string;
  }): Promise<AudioTranscriptionEngineResult>;
  unload(): Promise<void>;
}

type SpeechPipeline = {
  (
    audio: Float32Array,
    options: {
      chunk_length_s: number;
      stride_length_s: number;
      language: string;
      task: string;
      return_timestamps: boolean;
    },
  ): Promise<{ text: string }>;
  dispose(): Promise<void>;
};

type ModelProgress =
  | { status: "progress_total"; progress: number }
  | { status: "ready" }
  | { status: string };

const MODEL_LOAD_ATTEMPTS = 3;
const MODEL_LOAD_RETRY_DELAY_MS = 750;
const MODEL_DOWNLOAD_PROGRESS_SHARE = 0.9;
const WHISPER_MODEL_FILES = [
  "config.json",
  "onnx/encoder_model_quantized.onnx",
  "onnx/decoder_model_merged_quantized.onnx",
  "generation_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "preprocessor_config.json",
] as const;

export class TransformersAudioTranscriptionEngine
  implements AudioTranscriptionEngine
{
  private pipeline: SpeechPipeline | null = null;
  private modelId: string | null = null;

  constructor(private readonly modelsDirectory: string) {}

  async loadModel(
    model: LocalTranscriptionModelSpec,
    options: {
      localFilesOnly?: boolean;
      onProgress?(progress: number): void;
    } = {},
  ): Promise<void> {
    if (this.pipeline && this.modelId === model.id) return;
    await this.unload();
    const { env, pipeline } = await import("@huggingface/transformers");
    const cacheDirectory = path.join(
      this.modelsDirectory,
      modelCacheKey(model.id),
    );
    // Transformers.js resolves the pipeline manifest before it forwards the
    // per-call `cache_dir`. Point its global filesystem cache at the exact
    // same directory so metadata and ONNX weights cannot be split between
    // the package cache and ThreadMark's managed model cache.
    env.useFSCache = true;
    env.cacheDir = cacheDirectory;
    if (!options.localFilesOnly) {
      await ensureWhisperModelFiles(model.id, cacheDirectory, (progress) => {
        options.onProgress?.(progress * MODEL_DOWNLOAD_PROGRESS_SHARE);
      });
    }
    this.pipeline = await retryTransientModelLoad(
      async () =>
        (await pipeline("automatic-speech-recognition", model.id, {
          cache_dir: cacheDirectory,
          device: "cpu",
          dtype: model.dtype,
          local_files_only: options.localFilesOnly ?? false,
          progress_callback: (progress) => {
            const normalized = normalizedProgress(progress);
            if (normalized !== null) {
              options.onProgress?.(
                options.localFilesOnly
                  ? normalized
                  : MODEL_DOWNLOAD_PROGRESS_SHARE +
                      normalized * (1 - MODEL_DOWNLOAD_PROGRESS_SHARE),
              );
            }
          },
        })) as SpeechPipeline,
    );
    this.modelId = model.id;
    options.onProgress?.(1);
  }

  async transcribe(input: {
    localPath: string;
    mimeType: string;
    language: string;
  }): Promise<AudioTranscriptionEngineResult> {
    if (!this.pipeline) {
      throw new Error("Modelo local de transcrição não carregado");
    }
    if (!isOggOpus(input.mimeType, input.localPath)) {
      throw new Error(
        "Formato de áudio ainda não suportado pelo transcritor local. O WhatsApp normalmente envia OGG/Opus.",
      );
    }
    const decoder = new OggOpusDecoder();
    try {
      await decoder.ready;
      const decoded = await decoder.decodeFile(
        new Uint8Array(await readFile(input.localPath)),
      );
      if (!decoded.channelData.length || decoded.samplesDecoded === 0) {
        throw new Error("O áudio não possui amostras decodificáveis");
      }
      const mono48Khz = mixToMono(decoded.channelData);
      const audio16Khz = downsample48KhzTo16Khz(mono48Khz);
      const result = await this.pipeline(audio16Khz, {
        chunk_length_s: 30,
        stride_length_s: 5,
        language: whisperLanguage(input.language),
        task: "transcribe",
        return_timestamps: true,
      });
      if (Array.isArray(result)) {
        throw new Error("Resposta inesperada do modelo de transcrição");
      }
      const text = result.text.trim();
      return {
        text,
        language: input.language,
        durationSeconds: decoded.samplesDecoded / decoded.sampleRate,
        needsReview: decoded.errors.length > 0 || text.length < 2,
      };
    } finally {
      decoder.free();
    }
  }

  async unload(): Promise<void> {
    const current = this.pipeline;
    this.pipeline = null;
    this.modelId = null;
    await current?.dispose();
  }
}

export function normalizedProgress(progress: ModelProgress): number | null {
  if (progress.status === "ready") return 1;
  if (progress.status === "progress_total" && "progress" in progress) {
    return Math.max(0, Math.min(1, progress.progress / 100));
  }
  return null;
}

export async function retryTransientModelLoad<T>(
  load: () => Promise<T>,
  options: { attempts?: number; retryDelayMs?: number } = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? MODEL_LOAD_ATTEMPTS);
  const retryDelayMs = Math.max(
    0,
    options.retryDelayMs ?? MODEL_LOAD_RETRY_DELAY_MS,
  );
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await load();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isTransientModelLoadError(error)) throw error;
      await delay(retryDelayMs * attempt);
    }
  }
  throw lastError;
}

function isTransientModelLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Unable to get model file path or buffer") ||
    message.includes("fetch failed") ||
    message.includes("ECONNRESET") ||
    message.includes("ETIMEDOUT")
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function ensureWhisperModelFiles(
  modelId: string,
  cacheDirectory: string,
  onProgress: (progress: number) => void,
): Promise<void> {
  const modelRoot = path.join(cacheDirectory, modelId);
  let completedFiles = 0;
  for (const file of WHISPER_MODEL_FILES) {
    const targetPath = path.join(modelRoot, file);
    const existing = await stat(targetPath).catch(() => null);
    if (!existing?.isFile() || existing.size === 0) {
      await retryTransientModelLoad(() =>
        downloadModelFile(modelId, file, targetPath, (fileProgress) => {
          onProgress(
            (completedFiles + fileProgress) / WHISPER_MODEL_FILES.length,
          );
        }),
      );
    }
    completedFiles += 1;
    onProgress(completedFiles / WHISPER_MODEL_FILES.length);
  }
}

async function downloadModelFile(
  modelId: string,
  file: string,
  targetPath: string,
  onProgress: (progress: number) => void,
): Promise<void> {
  const modelPath = modelId.split("/").map(encodeURIComponent).join("/");
  const filePath = file.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(
    `https://huggingface.co/${modelPath}/resolve/main/${filePath}`,
    { redirect: "follow" },
  );
  if (!response.ok || !response.body) {
    throw new Error(
      `fetch failed: modelo ${modelId}, arquivo ${file}, HTTP ${response.status}`,
    );
  }

  await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  const handle = await open(temporaryPath, "wx", 0o600);
  const reader = response.body.getReader();
  const expectedBytes = Number(response.headers.get("content-length")) || 0;
  let downloadedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await handle.write(value);
      downloadedBytes += value.byteLength;
      if (expectedBytes > 0) {
        onProgress(Math.min(1, downloadedBytes / expectedBytes));
      }
    }
    await handle.sync();
    await handle.close();
    if (downloadedBytes === 0) {
      throw new Error(`fetch failed: arquivo vazio recebido para ${file}`);
    }
    if (expectedBytes > 0 && downloadedBytes !== expectedBytes) {
      throw new Error(
        `fetch failed: download incompleto de ${file} (${downloadedBytes}/${expectedBytes} bytes)`,
      );
    }
    await unlink(targetPath).catch(() => undefined);
    await rename(temporaryPath, targetPath);
    onProgress(1);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function isOggOpus(mimeType: string, localPath: string): boolean {
  const mime = mimeType.toLowerCase();
  return mime.includes("ogg") || mime.includes("opus") || localPath.endsWith(".ogg") || localPath.endsWith(".opus");
}

function whisperLanguage(language: string): string {
  return language.toLowerCase().startsWith("pt") ? "portuguese" : language;
}

function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0] as Float32Array;
  const length = Math.min(...channels.map((channel) => channel.length));
  const mono = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    let value = 0;
    for (const channel of channels) value += channel[index] ?? 0;
    mono[index] = value / channels.length;
  }
  return mono;
}

/** WhatsApp voice notes are 48 kHz Opus; averaging each triplet is a stable anti-aliasing decimator for speech. */
function downsample48KhzTo16Khz(input: Float32Array): Float32Array {
  const output = new Float32Array(Math.floor(input.length / 3));
  for (let index = 0; index < output.length; index += 1) {
    const offset = index * 3;
    output[index] =
      ((input[offset] ?? 0) +
        (input[offset + 1] ?? 0) +
        (input[offset + 2] ?? 0)) /
      3;
  }
  return output;
}
