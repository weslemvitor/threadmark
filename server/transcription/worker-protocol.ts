import type { LocalTranscriptionModelSpec } from "./catalog.js";
import type { AudioTranscriptionEngineResult } from "./engine.js";

export type TranscriptionWorkerRequest =
  | { id: number; operation: "load"; model: LocalTranscriptionModelSpec; localFilesOnly: boolean }
  | { id: number; operation: "transcribe"; input: { localPath: string; mimeType: string; language: string } };

export type TranscriptionWorkerResponse =
  | { id: number; type: "progress"; progress: number }
  | { id: number; type: "loaded" }
  | { id: number; type: "result"; result: AudioTranscriptionEngineResult }
  | { id: number; type: "error"; error: string };
