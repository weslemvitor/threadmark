#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const metadata = JSON.parse(
  await readFile(path.join(projectRoot, "package.json"), "utf8"),
);
const architecture = process.arch;

if (process.platform !== "darwin") {
  throw new Error("A validação do DMG precisa ser executada no macOS.");
}
if (architecture !== "arm64") {
  throw new Error(
    `Esta release suporta somente Apple Silicon; arquitetura atual: ${architecture}.`,
  );
}

const artifactName = `Threadmark-${metadata.version}-${architecture}.dmg`;
const artifactPath = path.join(projectRoot, "release", artifactName);
const artifactStat = await stat(artifactPath).catch(() => null);
if (!artifactStat?.isFile() || artifactStat.size < 10 * 1024 * 1024) {
  throw new Error(`DMG ausente ou incompleto: release/${artifactName}.`);
}

const mountPoint = await mkdtemp(path.join(os.tmpdir(), "threadmark-dmg-check-"));
let mounted = false;
let packagedWebProcess = null;
try {
  await run("hdiutil", [
    "attach",
    "-nobrowse",
    "-readonly",
    "-mountpoint",
    mountPoint,
    artifactPath,
  ]);
  mounted = true;

  const appPath = path.join(mountPoint, "Threadmark.app");
  const resourcesPath = path.join(appPath, "Contents", "Resources", "app");
  const infoPlist = path.join(appPath, "Contents", "Info.plist");
  const executable = path.join(appPath, "Contents", "MacOS", "Threadmark");
  const nativeDatabaseModule = path.join(
    resourcesPath,
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node",
  );
  const webServerEntry = path.join(resourcesPath, "bin", "start-web.mjs");

  await assertReadable(infoPlist, "Info.plist");
  await assertReadable(executable, "executável principal");
  await assertReadable(
    path.join(resourcesPath, "bin", "threadmark.mjs"),
    "CLI interna",
  );
  await assertReadable(
    path.join(resourcesPath, "dist-desktop", "main.js"),
    "processo principal compilado",
  );
  await assertReadable(nativeDatabaseModule, "módulo nativo do SQLite");
  await assertReadable(webServerEntry, "servidor web de produção");

  await assertPlistValue(infoPlist, "CFBundleIdentifier", "com.threadmark.desktop");
  await assertPlistValue(infoPlist, "CFBundleShortVersionString", metadata.version);

  const executableDetails = await run("file", [executable]);
  assertIncludes(executableDetails, "arm64", "O executável principal não é arm64.");
  const nativeModuleDetails = await run("file", [nativeDatabaseModule]);
  assertIncludes(
    nativeModuleDetails,
    "arm64",
    "O módulo do SQLite não é arm64.",
  );

  for (const forbidden of [".env", ".data", "desktop-workspace.json"]) {
    if (existsSync(path.join(resourcesPath, forbidden))) {
      throw new Error(`Estado local foi incluído indevidamente no app: ${forbidden}.`);
    }
  }

  const smokePort = await availablePort();
  packagedWebProcess = spawn(executable, [webServerEntry], {
    cwd: resourcesPath,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      HOST: "127.0.0.1",
      PORT: String(smokePort),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await verifyPackagedWeb(
    `http://127.0.0.1:${smokePort}`,
    packagedWebProcess,
  );
} finally {
  if (packagedWebProcess) await stopProcess(packagedWebProcess);
  if (mounted) {
    await run("hdiutil", ["detach", mountPoint]).catch(async () => {
      await run("hdiutil", ["detach", "-force", mountPoint]);
    });
  }
  await rm(mountPoint, { recursive: true, force: true });
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!address || typeof address === "string") {
    throw new Error("Não foi possível reservar uma porta para validar o app.");
  }
  return address.port;
}

async function verifyPackagedWeb(origin, child) {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout = appendLimited(stdout, chunk.toString("utf8"));
  });
  child.stderr.on("data", (chunk) => {
    stderr = appendLimited(stderr, chunk.toString("utf8"));
  });

  const deadline = Date.now() + 20_000;
  let lastError = "servidor ainda não respondeu";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `O servidor web empacotado encerrou com código ${child.exitCode}. ${stderr || stdout}`,
      );
    }
    try {
      const root = await fetch(origin, { headers: { accept: "text/html" } });
      if (!root.ok) throw new Error(`HTML respondeu ${root.status}`);
      const html = await root.text();
      const assets = [
        ...new Set(
          [...html.matchAll(
            /(?:href|src)="((?:\/assets\/|\/_next\/static\/)[^"?#]+\.(?:css|js))[^\"]*"/g,
          )].map((match) => match[1]),
        ),
      ];
      if (!assets.some((asset) => asset.endsWith(".css"))) {
        throw new Error("HTML não referencia CSS");
      }
      if (!assets.some((asset) => asset.endsWith(".js"))) {
        throw new Error("HTML não referencia JavaScript");
      }
      const responses = await Promise.all(
        assets.map((asset) => fetch(new URL(asset, origin))),
      );
      const failedIndex = responses.findIndex((response) => !response.ok);
      if (failedIndex >= 0) {
        throw new Error(`${assets[failedIndex]} respondeu ${responses[failedIndex].status}`);
      }
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(
    `O servidor web empacotado não ficou utilizável: ${lastError}. ${stderr || stdout}`,
  );
}

function appendLimited(current, value) {
  return `${current}${value}`.slice(-32 * 1024);
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

const checksum = await sha256(artifactPath);
const checksumPath = `${artifactPath}.sha256`;
await writeFile(checksumPath, `${checksum}  ${artifactName}\n`, {
  encoding: "utf8",
  mode: 0o644,
});

console.log(`DMG validado: release/${artifactName}`);
console.log(`SHA-256: ${checksum}`);
console.log(`Checksum: release/${path.basename(checksumPath)}`);

async function assertReadable(targetPath, label) {
  try {
    await access(targetPath);
  } catch {
    throw new Error(`O pacote não contém ${label}: ${targetPath}.`);
  }
}

async function assertPlistValue(plistPath, key, expected) {
  const value = (
    await run("plutil", ["-extract", key, "raw", "-o", "-", plistPath])
  ).trim();
  if (value !== expected) {
    throw new Error(`${key} deveria ser ${expected}, mas é ${value || "vazio"}.`);
  }
}

function assertIncludes(value, expected, message) {
  if (!value.includes(expected)) throw new Error(message);
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: process.env,
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
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new Error(
          stderr.trim() ||
            `${command} encerrou ${signal ? `com o sinal ${signal}` : `com o código ${code ?? "desconhecido"}`}.`,
        ),
      );
    });
  });
}
