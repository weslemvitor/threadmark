import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import Database from "better-sqlite3";

import { runDoctor, type DoctorOptions } from "../server/runtime/doctor.js";
import { renderLaunchAgentPlist } from "../server/runtime/launch-agent.js";
import { rotateLogFile } from "../server/runtime/log-rotation.js";
import {
  configurationUrl,
  openerForPlatform,
} from "../server/runtime/open-interface.js";
import type { SupportConfig } from "../server/runtime/config.js";
import { offlineRuntimeState } from "../server/runtime/runtime-state.js";

test("rotação conserva gerações e só atua quando o limite é atingido", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadmark-logs-"));
  const logPath = path.join(root, "daemon.log");
  try {
    await writeFile(logPath, "primeiro-log");
    assert.deepEqual(await rotateLogFile(logPath, { maxBytes: 100, retain: 2 }), {
      rotated: false,
      size: 12,
    });

    await writeFile(logPath, "x".repeat(101));
    const result = await rotateLogFile(logPath, { maxBytes: 100, retain: 2 });
    assert.equal(result.rotated, true);
    assert.equal((await readFile(`${logPath}.1`, "utf8")).length, 101);

    await writeFile(logPath, "y".repeat(101));
    await rotateLogFile(logPath, { maxBytes: 100, retain: 2 });
    assert.equal((await readFile(`${logPath}.1`, "utf8"))[0], "y");
    assert.equal((await readFile(`${logPath}.2`, "utf8"))[0], "x");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("LaunchAgent usa caminhos absolutos, restart apenas em falha e não expõe dados", () => {
  const config = fixtureConfig("/tmp/Thread & Mark");
  const plist = renderLaunchAgentPlist(config, {
    ...process.env,
    PATH: "/opt/homebrew/bin:/usr/bin",
  });
  assert.match(plist, /app\.threadmark\.local/);
  assert.match(plist, /Thread &amp; Mark/);
  assert.match(plist, /service-runner\.ts/);
  assert.match(plist, /<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.doesNotMatch(plist, /SUPPORT_.*TOKEN|password|secret/i);
});

test("URLs de configuração apontam para a seção solicitada sem shell", () => {
  assert.equal(
    configurationUrl("http://127.0.0.1:3000", "tools"),
    "http://127.0.0.1:3000/settings/tools",
  );
  assert.deepEqual(openerForPlatform("darwin", "http://127.0.0.1:3000/"), {
    command: "open",
    arguments: ["http://127.0.0.1:3000/"],
  });
});

test("doctor valida processo, API, assets e SQLite real", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadmark-doctor-"));
  const config = fixtureConfig(root);
  await mkdir(config.dataDir, { recursive: true });
  const database = new Database(config.databasePath);
  database.exec("CREATE TABLE health_probe (id INTEGER PRIMARY KEY)");
  database.close();
  const runtime = {
    ...offlineRuntimeState(),
    phase: "online" as const,
    pid: 12345,
  };
  const fetcher = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/health")) {
      return Response.json({ ok: true, service: "threadmark-api" });
    }
    if (url === "http://127.0.0.1:3000/") {
      return new Response(
        '<link rel="stylesheet" href="/assets/app.css"><script src="/assets/app.js"></script>',
      );
    }
    if (url.includes("/assets/")) return new Response("ok");
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const report = await runDoctor(config, {
      runtimeState: runtime,
      processRunning: () => true,
      fetcher,
    });
    assert.equal(report.healthy, true);
    assert.equal(report.failures, 0);
    assert.equal(report.probes.find((probe) => probe.id === "sqlite")?.state, "ok");
    assert.equal(report.probes.find((probe) => probe.id === "whatsapp")?.state, "skipped");
    assert.equal(report.probes.find((probe) => probe.id === "agent")?.state, "skipped");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor testa somente os provedores selecionados pelos perfis ativos", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadmark-doctor-ai-"));
  const config = {
    ...fixtureConfig(root),
    startWeb: false,
    agentEnabled: true,
    agentConcurrency: 2,
  };
  await mkdir(config.dataDir, { recursive: true });
  const database = new Database(config.databasePath);
  database.exec("CREATE TABLE health_probe (id INTEGER PRIMARY KEY)");
  database.close();
  const tested: string[] = [];
  let directCodexProbes = 0;
  const aiSettings = {
    getProfiles: () => [
      {
        taskKind: "triage" as const,
        connectionId: "openai-main",
        model: "gpt-mini",
        enabled: true,
        updatedAt: "2026-07-18T12:00:00.000Z",
      },
      {
        taskKind: "automatic" as const,
        connectionId: "openai-main",
        model: "gpt-mini",
        enabled: true,
        updatedAt: "2026-07-18T12:00:00.000Z",
      },
      {
        taskKind: "deep" as const,
        connectionId: "builtin-codex",
        model: "default",
        enabled: false,
        updatedAt: "2026-07-18T12:00:00.000Z",
      },
    ],
    listConnections: () => [
      {
        id: "openai-main",
        label: "OpenAI principal",
        providerId: "openai" as const,
        baseUrl: null,
        enabled: true,
        hasSecret: true,
        secretLastFour: "1234",
        capabilities: {
          automaticAnalysis: true,
          triage: true,
          structuredOutput: true,
          vision: true,
          localTools: false,
          codebaseAccess: false,
          deepInvestigation: true,
        },
        createdAt: "2026-07-18T12:00:00.000Z",
        updatedAt: "2026-07-18T12:00:00.000Z",
      },
      {
        id: "builtin-codex",
        label: "Codex CLI",
        providerId: "codex" as const,
        baseUrl: null,
        enabled: true,
        hasSecret: false,
        secretLastFour: null,
        capabilities: {
          automaticAnalysis: true,
          triage: true,
          structuredOutput: true,
          vision: true,
          localTools: true,
          codebaseAccess: true,
          deepInvestigation: true,
        },
        createdAt: "2026-07-18T12:00:00.000Z",
        updatedAt: "2026-07-18T12:00:00.000Z",
      },
    ],
    async testConnection(id: string) {
      tested.push(id);
      return { ok: true as const, message: "ok", models: ["gpt-mini"] };
    },
  } satisfies NonNullable<DoctorOptions["aiSettings"]>;

  try {
    const report = await runDoctor(config, {
      runtimeState: {
        ...offlineRuntimeState(),
        phase: "online",
        pid: 12345,
      },
      processRunning: () => true,
      fetcher: (async () =>
        Response.json({ ok: true, service: "threadmark-api" })) as typeof fetch,
      commandProbe: async () => {
        directCodexProbes += 1;
        return "codex should not run";
      },
      aiSettings,
    });
    assert.deepEqual(tested, ["openai-main"]);
    assert.equal(directCodexProbes, 0);
    assert.equal(report.probes.find((probe) => probe.id === "agent")?.state, "ok");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shim global é executável e expõe help e versão", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const shim = path.join(root, "bin", "threadmark.mjs");
  const packageJson = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  ) as { version: string };
  await chmod(shim, 0o755);
  assert.equal((await stat(shim)).mode & 0o111, 0o111);
  const version = await run(process.execPath, [shim, "--version"], root);
  assert.equal(version.code, 0);
  assert.match(version.stdout, new RegExp(`^threadmark ${packageJson.version}$`, "m"));
  const help = await run(process.execPath, [shim, "--help"], root);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /doctor \[--json\]/);
  assert.match(help.stdout, /service install/);
});

function fixtureConfig(projectRoot: string): SupportConfig {
  const dataDir = path.join(projectRoot, ".data");
  return {
    projectRoot,
    apiHost: "127.0.0.1",
    apiPort: 4317,
    apiUrl: "http://127.0.0.1:4317",
    webOrigin: "http://127.0.0.1:3000",
    dataDir,
    databasePath: path.join(dataDir, "threadmark.sqlite"),
    attachmentsDir: path.join(dataDir, "attachments"),
    authDir: path.join(dataDir, "whatsapp-auth"),
    logsDir: path.join(dataDir, "logs"),
    backupsDir: path.join(dataDir, "backups"),
    runtimeStatePath: path.join(dataDir, "runtime.json"),
    localSettingsPath: path.join(dataDir, "settings.json"),
    localAccessTokenPath: path.join(dataDir, "local-access.token"),
    pidPath: path.join(dataDir, "threadmark.pid"),
    codexBin: "codex",
    whatsappPhone: "commercial-account",
    whatsappName: "Threadmark",
    monitoredGroupJids: [],
    staffIdentities: [],
    whatsappEnabled: false,
    startWeb: true,
    agentEnabled: false,
    agentConcurrency: 2,
    triageAiEnabled: false,
    triageAiModel: "gpt-5.4-mini",
    triageAiQuietMs: 30_000,
    workspaceName: "Meu workspace",
    legacyCodeRoots: [],
    legacyVaultDirectory: null,
  };
}

function run(command: string, argumentsList: string[], cwd: string) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, argumentsList, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
