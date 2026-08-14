import { createHash } from "node:crypto";
import type { Readable } from "node:stream";

import {
  downloadMediaMessage,
  normalizeMessageContent,
  type WAMessage,
} from "baileys";

import type {
  DownloadedInboundMedia,
  InboundMessageEnvelope,
} from "./types.js";

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export type InboundMediaStreamLoader = (
  message: WAMessage,
  signal: AbortSignal,
) => Promise<Readable>;

export interface InboundMediaDownloaderOptions {
  maxBytes?: number;
  timeoutMs?: number;
  /** Test seam and hook for Baileys' optional media reupload context. */
  loadStream?: InboundMediaStreamLoader;
}

export interface InboundMediaDownloader {
  download(
    message: WAMessage,
    envelope: InboundMessageEnvelope,
  ): Promise<DownloadedInboundMedia | null>;
}

type BaileysMediaDownloadContext = NonNullable<
  Parameters<typeof downloadMediaMessage>[3]
>;

export class InboundMediaLimitError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`WhatsApp media exceeds the configured ${maxBytes} byte limit`);
    this.name = "InboundMediaLimitError";
    this.maxBytes = maxBytes;
  }
}

/** Downloads analysable inbound media without adding any outbound capability. */
export function createInboundMediaDownloader(
  options: InboundMediaDownloaderOptions = {},
): InboundMediaDownloader {
  const maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const loadStream = options.loadStream ?? defaultStreamLoader;

  return {
    async download(message, envelope) {
      const supportedKind = getSupportedMediaKind(message);
      const attachment = envelope.content.attachments[0];
      if (
        !supportedKind ||
        !attachment ||
        !attachment.eligibleForAnalysis ||
        attachment.kind !== supportedKind
      ) {
        return null;
      }

      if (
        attachment.sizeBytes !== null &&
        attachment.sizeBytes > maxBytes
      ) {
        throw new InboundMediaLimitError(maxBytes);
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      timeout.unref?.();

      try {
        const stream = await loadStream(message, controller.signal);
        const chunks: Buffer[] = [];
        let totalBytes = 0;

        for await (const chunk of stream) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buffer.byteLength;
          if (totalBytes > maxBytes) {
            controller.abort();
            stream.destroy();
            throw new InboundMediaLimitError(maxBytes);
          }
          chunks.push(buffer);
        }

        const bytes = Buffer.concat(chunks, totalBytes);
        return {
          idempotencyKey: attachment.idempotencyKey,
          messageIdempotencyKey: envelope.idempotencyKey,
          kind: supportedKind,
          mimeType: attachment.mimeType,
          fileName: attachment.fileName,
          sizeBytes: bytes.byteLength,
          sha256Hex: createHash("sha256").update(bytes).digest("hex"),
          bytes,
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

/** Internal adapter used by the client to retry expired historical media. */
export function createBaileysMediaStreamLoader(
  context: BaileysMediaDownloadContext,
): InboundMediaStreamLoader {
  return (message, signal) =>
    downloadMediaMessage(
      message,
      "stream",
      { options: { signal } },
      context,
    );
}

async function defaultStreamLoader(
  message: WAMessage,
  signal: AbortSignal,
): Promise<Readable> {
  return downloadMediaMessage(message, "stream", {
    options: { signal },
  });
}

function getSupportedMediaKind(
  message: WAMessage,
): "image" | "document" | "audio" | null {
  const content = normalizeMessageContent(message.message);
  if (content?.imageMessage) {
    return "image";
  }
  if (content?.documentMessage) {
    return "document";
  }
  if (content?.audioMessage) {
    return "audio";
  }
  return null;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
