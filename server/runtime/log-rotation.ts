import { rename, rm, stat } from "node:fs/promises";

export interface LogRotationOptions {
  maxBytes?: number;
  retain?: number;
}

export interface LogRotationResult {
  rotated: boolean;
  size: number;
}

export async function rotateLogFile(
  logPath: string,
  options: LogRotationOptions = {},
): Promise<LogRotationResult> {
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const retain = options.retain ?? 5;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("maxBytes deve ser um inteiro positivo.");
  }
  if (!Number.isSafeInteger(retain) || retain < 1 || retain > 100) {
    throw new Error("retain deve estar entre 1 e 100.");
  }

  let size = 0;
  try {
    size = (await stat(logPath)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { rotated: false, size: 0 };
    }
    throw error;
  }
  if (size < maxBytes) return { rotated: false, size };

  await rm(`${logPath}.${retain}`, { force: true });
  for (let index = retain - 1; index >= 1; index -= 1) {
    try {
      await rename(`${logPath}.${index}`, `${logPath}.${index + 1}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await rename(logPath, `${logPath}.1`);
  return { rotated: true, size };
}
