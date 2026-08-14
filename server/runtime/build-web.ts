import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.js";
import {
  requestWebBuildReload,
  webBuildReloadPath,
} from "./web-build-reload.js";
import { webBuildLockPath, withWebBuildLock } from "./web-build-lock.js";

const packageBuild = process.argv.includes("--package");
const sourceProjectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const config = packageBuild ? null : loadConfig();
const projectRoot = config?.projectRoot ?? sourceProjectRoot;
const lockPath = config
  ? webBuildLockPath(config.dataDir)
  : packageWebBuildLockPath(projectRoot);

try {
  await withWebBuildLock(lockPath, async () => {
    if (packageBuild) {
      await rm(path.join(projectRoot, "dist"), {
        force: true,
        recursive: true,
      });
    }
    await runVinextBuild(projectRoot);
    if (config) {
      await requestWebBuildReload(webBuildReloadPath(config.dataDir));
      console.log("Interface Threadmark notificada sobre o novo build.");
    } else {
      console.log("Build web limpo preparado para o pacote npm.");
    }
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function packageWebBuildLockPath(projectRoot: string): string {
  const projectHash = createHash("sha256")
    .update(projectRoot)
    .digest("hex")
    .slice(0, 16);
  return path.join(os.tmpdir(), `threadmark-package-build-${projectHash}.lock`);
}

async function runVinextBuild(projectRoot: string): Promise<void> {
  const vinextCli = path.join(projectRoot, "node_modules", "vinext", "dist", "cli.js");
  const child = spawn(process.execPath, [vinextCli, "build"], {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
  });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  if (result.code !== 0) {
    throw new Error(
      result.signal
        ? `O build web foi interrompido por ${result.signal}.`
        : `O build web encerrou com codigo ${result.code ?? "desconhecido"}.`,
    );
  }
}
