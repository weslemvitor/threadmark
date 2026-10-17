import { fork, type ChildProcess } from "node:child_process";

import type { LocalTranscriptionModelSpec } from "./catalog.js";
import type { AudioTranscriptionEngine, AudioTranscriptionEngineResult } from "./engine.js";
import type { TranscriptionWorkerRequest, TranscriptionWorkerResponse } from "./worker-protocol.js";

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const INSTALL_TIMEOUT_MS = 30 * 60_000;

interface PendingRequest {
  id: number;
  timer: NodeJS.Timeout;
  resolve(response: TranscriptionWorkerResponse): void;
  reject(error: Error): void;
  onProgress?(progress: number): void;
}

export interface ProcessTranscriptionEngineOptions {
  timeoutMs?: number;
  installTimeoutMs?: number;
  workerUrl?: URL;
}

/** The parent can kill native inference even when the child's event loop is blocked. */
export class ProcessAudioTranscriptionEngine implements AudioTranscriptionEngine {
  private child: ChildProcess | null = null;
  private childClosed: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private pending: PendingRequest | null = null;
  private sequence = 0;
  private generation = 0;
  private readonly timeoutMs: number;

  constructor(
    private readonly modelsDirectory: string,
    private readonly options: ProcessTranscriptionEngineOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? Number(
      process.env.SUPPORT_AUDIO_TRANSCRIPTION_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
    );
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 2_147_483_647) {
      throw new Error("SUPPORT_AUDIO_TRANSCRIPTION_TIMEOUT_MS deve ser um inteiro positivo de até 2147483647 ms");
    }
  }

  async loadModel(
    model: LocalTranscriptionModelSpec,
    options: { localFilesOnly?: boolean; onProgress?(progress: number): void } = {},
  ): Promise<void> {
    await this.request(
      { id: ++this.sequence, operation: "load", model, localFilesOnly: options.localFilesOnly ?? false },
      options.localFilesOnly ? this.timeoutMs : (this.options.installTimeoutMs ?? INSTALL_TIMEOUT_MS),
      options.onProgress,
    );
  }

  async transcribe(input: {
    localPath: string;
    mimeType: string;
    language: string;
  }): Promise<AudioTranscriptionEngineResult> {
    const response = await this.request({ id: ++this.sequence, operation: "transcribe", input }, this.timeoutMs);
    if (response.type !== "result") throw new Error("Resposta inesperada do transcritor local");
    return response.result;
  }

  async unload(): Promise<void> {
    this.generation += 1;
    await this.terminate(new Error("Execução da transcrição local interrompida"));
  }

  private async request(
    request: TranscriptionWorkerRequest,
    timeoutMs: number,
    onProgress?: (progress: number) => void,
  ): Promise<TranscriptionWorkerResponse> {
    const generation = this.generation;
    await this.stopping;
    if (generation !== this.generation) throw new Error("Execução da transcrição local interrompida");
    if (this.pending) throw new Error("Já existe uma operação de transcrição em andamento");
    const child = this.getChild();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        void this.terminate(new Error(
          `Transcrição local excedeu o limite de ${Math.ceil(timeoutMs / 1_000)} segundos; processo encerrado`,
        ));
      }, timeoutMs);
      this.pending = { id: request.id, timer, resolve, reject, onProgress };
      child.send(request, (error) => {
        if (error && this.child === child) void this.terminate(error);
      });
    });
  }

  private getChild(): ChildProcess {
    if (this.child) return this.child;
    const workerUrl = this.options.workerUrl ?? new URL(
      import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js",
      import.meta.url,
    );
    const child = fork(workerUrl, [this.modelsDirectory], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    this.child = child;
    this.childClosed = new Promise((resolve) => child.once("close", () => resolve()));
    child.on("message", (response: TranscriptionWorkerResponse) => {
      if (this.child !== child || this.pending?.id !== response.id) return;
      if (response.type === "progress") {
        try {
          this.pending.onProgress?.(response.progress);
        } catch (error) {
          void this.terminate(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }
      if (response.type === "error") {
        void this.terminate(new Error(response.error));
        return;
      }
      const pending = this.takePending();
      pending?.resolve(response);
    });
    child.once("error", (error) => {
      if (this.child === child) void this.terminate(error);
    });
    child.once("close", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.takePending()?.reject(new Error(
        `Processo de transcrição encerrado inesperadamente (${signal ?? code})`,
      ));
    });
    return child;
  }

  private takePending(): PendingRequest | null {
    const pending = this.pending;
    this.pending = null;
    if (pending) clearTimeout(pending.timer);
    return pending;
  }

  private async terminate(error: Error): Promise<void> {
    if (!this.child) {
      await this.stopping;
      return;
    }
    const child = this.child;
    const closed = this.childClosed!;
    const pending = this.takePending();
    this.child = null;
    this.stopping = closed;
    child.kill("SIGKILL");
    await closed;
    if (this.stopping === closed) this.stopping = null;
    pending?.reject(error);
  }
}
