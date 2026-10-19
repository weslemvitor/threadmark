import { DomainError } from "../domain/errors.js";

export const MAX_CHANNEL_BODY_BYTES = 256 * 1024;

/** Bound the streamed request too; Content-Length is not authoritative. */
export async function readChannelBody(request: Request): Promise<string> {
  if (Number(request.headers.get("content-length")) > MAX_CHANNEL_BODY_BYTES) {
    throw new DomainError("Evento excede o limite de 256 KiB.", "channel_payload_too_large", 413);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new DomainError("Informe um evento JSON.","channel_payload_empty",400);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_CHANNEL_BODY_BYTES) {
        await reader.cancel();
        throw new DomainError("Evento excede o limite de 256 KiB.","channel_payload_too_large",413);
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}
