import { TransformersAudioTranscriptionEngine } from "./engine.js";
import type { TranscriptionWorkerRequest, TranscriptionWorkerResponse } from "./worker-protocol.js";

const engine = new TransformersAudioTranscriptionEngine(process.argv[2]);

function send(response: TranscriptionWorkerResponse): void {
  if (process.connected) process.send?.(response);
}

async function execute(request: TranscriptionWorkerRequest): Promise<void> {
  try {
    if (request.operation === "load") {
      await engine.loadModel(request.model, {
        localFilesOnly: request.localFilesOnly,
        onProgress: (progress) => send({ id: request.id, type: "progress", progress }),
      });
      send({ id: request.id, type: "loaded" });
      return;
    }
    const result = await engine.transcribe(request.input);
    send({ id: request.id, type: "result", result });
  } catch (error) {
    send({ id: request.id, type: "error", error: error instanceof Error ? error.message : String(error) });
  }
}

process.on("message", (request: TranscriptionWorkerRequest) => void execute(request));
process.once("disconnect", () => process.exit(0));
