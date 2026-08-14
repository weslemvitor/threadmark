import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { loadConfig } from "./runtime/config.js";
import { rotateLogFile } from "./runtime/log-rotation.js";

async function main(): Promise<void> {
  const config = loadConfig();
  mkdirSync(config.logsDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(config.logsDir, "daemon.log");
  await rotateLogFile(logPath);
  const log = openSync(logPath, "a", 0o600);
  const executable = path.join(config.projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(
    process.execPath,
    [executable, path.join(config.projectRoot, "server", "daemon.ts")],
    {
      cwd: config.projectRoot,
      env: process.env,
      stdio: ["ignore", log, log],
    },
  );
  closeSync(log);

  let forwardedSignal: NodeJS.Signals | null = null;
  const forward = (signal: NodeJS.Signals) => {
    forwardedSignal = signal;
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  process.once("SIGINT", forward);
  process.once("SIGTERM", forward);

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  process.off("SIGINT", forward);
  process.off("SIGTERM", forward);

  if (forwardedSignal || result.signal) return;
  if ((result.code ?? 1) !== 0) process.exitCode = result.code ?? 1;
}

void main().catch(async (error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  try {
    const config = loadConfig();
    await mkdir(config.logsDir, { recursive: true, mode: 0o700 });
    await appendFile(
      path.join(config.logsDir, "daemon.log"),
      `[service-runner] ${new Date().toISOString()} ${message}\n`,
      { mode: 0o600 },
    );
  } catch {
    console.error(error);
  }
  process.exitCode = 1;
});
