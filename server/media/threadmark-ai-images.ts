import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  THREADMARK_AI_IMAGE_MAX_BYTES,
  THREADMARK_AI_IMAGE_MAX_COUNT,
  THREADMARK_AI_IMAGE_MAX_TOTAL_BYTES,
  type ThreadmarkAiImageMimeType,
  type ThreadmarkAiImageUploadInput,
} from "../../shared/contracts.js";
import { ValidationError } from "../domain/errors.js";

const EXTENSION_BY_MIME_TYPE: Record<ThreadmarkAiImageMimeType, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

export interface StoredThreadmarkAiImage {
  id: string;
  fileName: string;
  mimeType: ThreadmarkAiImageMimeType;
  localPath: string;
  sizeBytes: number;
  sha256: string;
}

export async function storeThreadmarkAiImages(
  attachmentsDirectory: string,
  uploads: ThreadmarkAiImageUploadInput[],
): Promise<StoredThreadmarkAiImage[]> {
  if (uploads.length > THREADMARK_AI_IMAGE_MAX_COUNT) {
    throw new ValidationError(
      `Envie no máximo ${THREADMARK_AI_IMAGE_MAX_COUNT} imagens por mensagem.`,
    );
  }

  const prepared = uploads.map(decodeThreadmarkAiImage);
  const totalBytes = prepared.reduce((total, image) => total + image.bytes.byteLength, 0);
  if (totalBytes > THREADMARK_AI_IMAGE_MAX_TOTAL_BYTES) {
    throw new ValidationError("As imagens excedem o limite total de 25 MB por mensagem.");
  }

  const directory = path.join(path.resolve(attachmentsDirectory), "threadmark-ai");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  const stored: StoredThreadmarkAiImage[] = [];
  try {
    for (const image of prepared) {
      const id = randomUUID();
      const localPath = path.join(directory, `${id}${EXTENSION_BY_MIME_TYPE[image.mimeType]}`);
      await writeFile(localPath, image.bytes, { mode: 0o600, flag: "wx" });
      stored.push({
        id,
        fileName: image.fileName,
        mimeType: image.mimeType,
        localPath,
        sizeBytes: image.bytes.byteLength,
        sha256: createHash("sha256").update(image.bytes).digest("hex"),
      });
    }
    return stored;
  } catch (error) {
    await cleanupStoredThreadmarkAiImages(stored);
    throw error;
  }
}

export async function cleanupStoredThreadmarkAiImages(
  images: StoredThreadmarkAiImage[],
): Promise<void> {
  await Promise.all(images.map((image) => rm(image.localPath, { force: true })));
}

export async function deleteThreadmarkAiImageFiles(
  attachmentsDirectory: string,
  localPaths: readonly string[],
): Promise<void> {
  const trustedDirectory = path.join(
    path.resolve(attachmentsDirectory),
    "threadmark-ai",
  );
  await Promise.all(
    localPaths.map(async (localPath) => {
      const target = path.resolve(localPath);
      const relativePath = path.relative(trustedDirectory, target);
      if (
        !relativePath ||
        relativePath.startsWith("..") ||
        path.isAbsolute(relativePath)
      ) {
        throw new ValidationError("Caminho de anexo do Threadmark AI inválido.");
      }
      await rm(target, { force: true });
    }),
  );
}

function decodeThreadmarkAiImage(upload: ThreadmarkAiImageUploadInput): {
  fileName: string;
  mimeType: ThreadmarkAiImageMimeType;
  bytes: Buffer;
} {
  const encoded = upload.dataBase64.trim();
  const bytes = Buffer.from(encoded, "base64");
  const canonical = bytes.toString("base64").replace(/=+$/, "");
  if (!encoded || canonical !== encoded.replace(/=+$/, "")) {
    throw new ValidationError("Uma das imagens possui conteúdo inválido.");
  }
  if (!bytes.byteLength || bytes.byteLength > THREADMARK_AI_IMAGE_MAX_BYTES) {
    throw new ValidationError("Cada imagem deve ter no máximo 10 MB.");
  }
  if (!matchesDeclaredImageType(bytes, upload.mimeType)) {
    throw new ValidationError("O conteúdo da imagem não corresponde ao formato informado.");
  }
  return {
    fileName: safeImageFileName(upload.fileName, upload.mimeType),
    mimeType: upload.mimeType,
    bytes,
  };
}

function safeImageFileName(
  value: string,
  mimeType: ThreadmarkAiImageMimeType,
): string {
  const normalized = path.basename(value.replace(/[\u0000-\u001f\u007f]/g, "")).trim();
  return (normalized || `imagem${EXTENSION_BY_MIME_TYPE[mimeType]}`).slice(0, 200);
}

function matchesDeclaredImageType(
  bytes: Buffer,
  mimeType: ThreadmarkAiImageMimeType,
): boolean {
  if (mimeType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === "image/png") {
    return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mimeType === "image/gif") {
    const signature = bytes.subarray(0, 6).toString("ascii");
    return signature === "GIF87a" || signature === "GIF89a";
  }
  return bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP";
}
