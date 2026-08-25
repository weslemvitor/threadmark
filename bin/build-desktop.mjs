#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdtemp, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2] === "dmg" ? "dmg" : "dir";
const builderCli = path.join(
  projectRoot,
  "node_modules",
  "electron-builder",
  "cli.js",
);
const rebuildCli = path.join(
  projectRoot,
  "node_modules",
  "@electron",
  "rebuild",
  "lib",
  "cli.js",
);
const nativeBinary = path.join(
  projectRoot,
  "node_modules",
  "better-sqlite3",
  "build",
  "Release",
  "better_sqlite3.node",
);
const runtimeDist = path.join(projectRoot, "dist");
const tsxCli = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const webReloadScript = path.join(
  projectRoot,
  "server",
  "runtime",
  "request-web-build-reload.ts",
);

const temporaryDirectory = await mkdtemp(
  path.join(os.tmpdir(), "threadmark-desktop-build-"),
);
const nativeBinaryBackup = path.join(temporaryDirectory, "better_sqlite3.node");
const runtimeDistBackup = path.join(temporaryDirectory, "runtime-dist");
const hadRuntimeDist = existsSync(runtimeDist);
let nativeBinaryBackedUp = false;
let buildError;
let restorationError;

try {
  if (hadRuntimeDist) {
    await cp(runtimeDist, runtimeDistBackup, { recursive: true });
  }
  await run("npm", ["run", "package:build"]);
  await run("npm", ["run", "desktop:compile"]);

  // O pacote precisa do ABI do Electron, enquanto a CLI local usa o ABI do Node.
  // O backup preserva o binário usado pelo desenvolvimento e pela CLI.
  await copyFile(nativeBinary, nativeBinaryBackup);
  nativeBinaryBackedUp = true;
  await run(process.execPath, [
    rebuildCli,
    "--force",
    "--which-module",
    "better-sqlite3",
    "--version",
    "44.0.0",
  ]);
  // A publicação pertence exclusivamente ao workflow auditado. Em builds
  // disparados por tag, o electron-builder tentaria publicar implicitamente.
  await run(process.execPath, [
    builderCli,
    "--mac",
    target,
    "--publish",
    "never",
  ]);
} catch (error) {
  buildError = error;
} finally {
  // O builder pode usar hard links ao copiar dependências para o .app. Substituir
  // o arquivo por rename restaura o Node local sem alterar o inode empacotado.
  const restoredBinary = `${nativeBinary}.${process.pid}.restore`;
  if (nativeBinaryBackedUp) {
    try {
      if (existsSync(nativeBinaryBackup)) {
        await copyFile(nativeBinaryBackup, restoredBinary);
        await rename(restoredBinary, nativeBinary);
      } else {
        // O backup fica fora da árvore reconstruída, mas um processo externo
        // pode limpar o diretório temporário. Nesse caso, o rebuild do Node evita
        // deixar a instalação local presa ao ABI do Electron.
        await run("npm", ["rebuild", "better-sqlite3"]);
      }
    } catch (error) {
      restorationError = error;
    }
  }

  // A Web UI local pode estar sendo servida enquanto o pacote é gerado. Repor a
  // árvore por rename evita deixar o daemon apontando para assets de outro build.
  try {
    await rm(runtimeDist, { recursive: true, force: true });
    if (hadRuntimeDist) {
      await rename(runtimeDistBackup, runtimeDist);
    }
  } catch (error) {
    restorationError ??= error;
  }
  try {
    await rm(temporaryDirectory, { recursive: true, force: true });
  } catch (error) {
    restorationError ??= error;
  }
  if (hadRuntimeDist) {
    try {
      await run(process.execPath, [tsxCli, webReloadScript]);
    } catch (error) {
      restorationError ??= error;
    }
  }
}

if (buildError) throw buildError;
if (restorationError) throw restorationError;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal
            ? `O empacotamento foi interrompido pelo sinal ${signal}.`
            : `O empacotamento encerrou com o código ${code ?? "desconhecido"}.`,
        ),
      );
    });
  });
}
