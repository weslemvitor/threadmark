export interface LocalTranscriptionModelSpec {
  id: string;
  label: string;
  description: string;
  estimatedDiskBytes: number;
  estimatedRamBytes: number;
  recommended: boolean;
  dtype: "q8";
}

const MIB = 1024 * 1024;

/**
 * Multilingual ONNX Whisper models supported by Transformers.js. Estimates
 * include the quantized encoder/decoder plus tokenizer and configuration files.
 */
export const LOCAL_TRANSCRIPTION_MODELS: readonly LocalTranscriptionModelSpec[] = [
  {
    id: "onnx-community/whisper-tiny",
    label: "Whisper Tiny",
    description: "Mais leve e rápido; indicado para máquinas com pouca memória.",
    estimatedDiskBytes: 65 * MIB,
    estimatedRamBytes: 420 * MIB,
    recommended: false,
    dtype: "q8",
  },
  {
    id: "onnx-community/whisper-base",
    label: "Whisper Base",
    description: "Bom equilíbrio entre consumo e precisão para áudios curtos.",
    estimatedDiskBytes: 105 * MIB,
    estimatedRamBytes: 700 * MIB,
    recommended: false,
    dtype: "q8",
  },
  {
    id: "onnx-community/whisper-small",
    label: "Whisper Small",
    description: "Melhor precisão em português; recomendado para o suporte diário.",
    estimatedDiskBytes: 310 * MIB,
    estimatedRamBytes: 1_300 * MIB,
    recommended: true,
    dtype: "q8",
  },
] as const;

export const DEFAULT_TRANSCRIPTION_MODEL_ID =
  "onnx-community/whisper-small";

export function requireTranscriptionModel(
  modelId: string,
): LocalTranscriptionModelSpec {
  const model = LOCAL_TRANSCRIPTION_MODELS.find((item) => item.id === modelId);
  if (!model) {
    throw new Error("Modelo local de transcrição não suportado");
  }
  return model;
}

export function modelCacheKey(modelId: string): string {
  return modelId.replace(/[^A-Za-z0-9._-]+/g, "--");
}
