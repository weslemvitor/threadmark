#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const metadata = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const temporary = await mkdtemp(path.join(os.tmpdir(), "threadmark-package-smoke-"));

try {
  const packageDirectory = path.join(temporary, "package");
  const installPrefix = path.join(temporary, "install");
  const npmCache = path.join(temporary, "npm-cache");
  const forbiddenPackageDataDirectory = path.join(temporary, "package-data");
  await mkdir(packageDirectory, { recursive: true });
  await run(npmCommand(), [
    "pack",
    "--silent",
    "--ignore-scripts",
    "--pack-destination",
    packageDirectory,
  ], {
    cwd: projectRoot,
    env: {
      ...process.env,
      npm_config_cache: npmCache,
      npm_config_update_notifier: "false",
      SUPPORT_DATA_DIR: forbiddenPackageDataDirectory,
    },
  });
  await assertMissing(forbiddenPackageDataDirectory);

  const archiveName = (await readdir(packageDirectory)).find((entry) => entry.endsWith(".tgz"));
  if (!archiveName) throw new Error("npm pack não produziu um arquivo .tgz.");
  const archivePath = path.join(packageDirectory, archiveName);

  await run(npmCommand(), [
    "install",
    "--global",
    "--prefix",
    installPrefix,
    "--omit=dev",
    "--no-package-lock",
    "--no-audit",
    "--no-fund",
    archivePath,
  ], {
    cwd: temporary,
    env: {
      ...process.env,
      npm_config_cache: npmCache,
      npm_config_update_notifier: "false",
    },
  });

  const globalModules = await run(npmCommand(), [
    "root",
    "--global",
    "--prefix",
    installPrefix,
  ], {
    cwd: temporary,
  });
  const installedRoot = path.join(globalModules.stdout.trim(), metadata.name);
  await Promise.all([
    assertPath(path.join(installedRoot, "dist", "server", "index.js")),
    assertPath(path.join(installedRoot, "server", "cli.ts")),
    assertPath(path.join(installedRoot, "node_modules", "tsx", "dist", "cli.mjs")),
  ]);
  await assertMissing(path.join(installedRoot, "tests"));
  await assertMissing(path.join(installedRoot, "app"));
  await assertMissing(path.join(installedRoot, ".env"));

  const executable = path.join(
    installPrefix,
    process.platform === "win32" ? "threadmark.cmd" : path.join("bin", "threadmark"),
  );
  await assertPath(executable);

  const version = await run(executable, ["--version"], { cwd: temporary });
  const expectedVersion = `threadmark ${metadata.version}`;
  if (version.stdout.trim() !== expectedVersion) {
    throw new Error(
      `A CLI instalada respondeu “${version.stdout.trim()}”; esperado “${expectedVersion}”.`,
    );
  }

  const doctorDataDirectory = path.join(temporary, "doctor-data");
  const doctor = await run(executable, ["doctor", "--json"], {
    allowedExitCodes: [0, 1],
    cwd: temporary,
    env: {
      ...process.env,
      SUPPORT_AGENT_ENABLED: "false",
      SUPPORT_DATA_DIR: doctorDataDirectory,
      SUPPORT_START_WEB: "false",
      SUPPORT_WHATSAPP_ENABLED: "false",
    },
  });
  const report = JSON.parse(doctor.stdout);
  if (!Array.isArray(report.probes) || report.probes.length === 0) {
    throw new Error("threadmark doctor não retornou o relatório estruturado esperado.");
  }

  const help = await run(executable, [], { cwd: temporary });
  if (!help.stdout.includes("Uso:") || !help.stdout.includes("on | start")) {
    throw new Error("A CLI instalada não exibiu a ajuda ao ser executada sem argumentos.");
  }

  console.log(
    `Pacote ${metadata.name}@${metadata.version} validado: instalação sem devDependencies, versão e Doctor funcionais.`,
  );
} finally {
  await rm(temporary, { force: true, recursive: true });
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

async function assertPath(filePath) {
  await access(filePath).catch(() => {
    throw new Error(`O pacote instalado não contém ${filePath}.`);
  });
}

async function assertMissing(filePath) {
  try {
    await access(filePath);
  } catch {
    return;
  }
  throw new Error(`O pacote publicou um caminho fora da allowlist: ${filePath}.`);
}

function run(command, argumentsList, options = {}) {
  const allowedExitCodes = options.allowedExitCodes ?? [0];
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal || !allowedExitCodes.includes(code ?? 1)) {
        reject(
          new Error(
            [
              `${command} ${argumentsList.join(" ")} falhou (${signal ?? `código ${code ?? "?"}`}).`,
              stdout.trim(),
              stderr.trim(),
            ]
              .filter(Boolean)
              .join("\n"),
          ),
        );
        return;
      }
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}
