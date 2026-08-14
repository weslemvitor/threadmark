import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

import { loadConfig } from "./runtime/config.js";
import {
  assertPresentationDataDirectory,
  seedPresentationData,
} from "./seed.js";

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readRunningPid(path: string): Promise<number | null> {
  try {
    const pid = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 && processIsRunning(pid) ? pid : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function resetPresentation(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("O reset de apresentação não pode ser executado em produção.");
  }

  const config = loadConfig();
  assertPresentationDataDirectory(config);
  const runningPid = await readRunningPid(config.pidPath);
  if (runningPid) {
    throw new Error(
      `O ambiente de apresentação está rodando no PID ${runningPid}. Execute npm run support:off antes do reset.`,
    );
  }

  let backupPath: string | null = null;
  if (existsSync(config.dataDir) && (await readdir(config.dataDir)).length) {
    const backupRoot = join(dirname(config.dataDir), "presentation-backups");
    await mkdir(backupRoot, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
    backupPath = join(backupRoot, stamp);
    await rename(config.dataDir, backupPath);
  }

  seedPresentationData(config);
  if (backupPath) {
    console.log(`Estado anterior preservado em ${backupPath}.`);
  }
}

await resetPresentation();
