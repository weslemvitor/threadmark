import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { statfs } from "node:fs/promises";
import Database from "better-sqlite3";

import type { AiProviderSettingsService } from "../agent/provider-settings.js";
import type { SupportConfig } from "./config.js";
import { RuntimeStateFile, type RuntimeState } from "./runtime-state.js";
import { verifyWebBuild } from "./web-readiness.js";

export type DoctorProbeState = "ok" | "warning" | "failed" | "skipped";

export interface DoctorProbe {
  id: "process" | "api" | "web" | "sqlite" | "whatsapp" | "agent" | "disk";
  label: string;
  state: DoctorProbeState;
  message: string;
}

export interface DoctorReport {
  checkedAt: string;
  probes: DoctorProbe[];
  healthy: boolean;
  warnings: number;
  failures: number;
}

export interface DoctorOptions {
  fetcher?: typeof fetch;
  runtimeState?: RuntimeState;
  processRunning?: (pid: number) => boolean;
  commandProbe?: (command: string, argumentsList: string[]) => Promise<string>;
  aiSettings?: Pick<
    AiProviderSettingsService,
    "getProfiles" | "listConnections" | "testConnection"
  > | null;
}

export async function runDoctor(
  config: SupportConfig,
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const fetcher = options.fetcher ?? fetch;
  const runtime =
    options.runtimeState ??
    (await new RuntimeStateFile(config.runtimeStatePath).read());
  const processRunning = options.processRunning ?? isProcessRunning;

  const probes: DoctorProbe[] = [];
  probes.push(probeProcess(runtime, processRunning));
  probes.push(await probeApi(config.apiUrl, fetcher));
  probes.push(
    config.startWeb
      ? await probeWeb(config.webOrigin, fetcher)
      : skipped("web", "Interface Web", "Desativada nesta instalação."),
  );
  probes.push(probeSqlite(config.databasePath));
  probes.push(probeWhatsapp(config, runtime));
  probes.push(
    await probeAgent(
      config,
      options.commandProbe ?? ((command, argumentsList) => probeCommand(command, argumentsList)),
      options.aiSettings,
    ),
  );
  probes.push(await probeDisk(config.dataDir, config.projectRoot));

  const failures = probes.filter((probe) => probe.state === "failed").length;
  const warnings = probes.filter((probe) => probe.state === "warning").length;
  return {
    checkedAt: new Date().toISOString(),
    probes,
    healthy: failures === 0,
    warnings,
    failures,
  };
}

function probeProcess(
  runtime: RuntimeState,
  processRunning: (pid: number) => boolean,
): DoctorProbe {
  if (!runtime.pid) {
    return failed("process", "Processo principal", "Serviço local não está em execução.");
  }
  if (!processRunning(runtime.pid)) {
    return failed(
      "process",
      "Processo principal",
      `O runtime aponta para o PID ${runtime.pid}, mas ele não existe.`,
    );
  }
  return ok("process", "Processo principal", `PID ${runtime.pid} em execução.`);
}

async function probeApi(apiUrl: string, fetcher: typeof fetch): Promise<DoctorProbe> {
  try {
    const response = await fetchWithTimeout(new URL("/health", apiUrl), fetcher);
    if (!response.ok) {
      return failed("api", "API local", `Health-check respondeu HTTP ${response.status}.`);
    }
    const payload = (await response.json()) as { ok?: boolean; service?: string };
    if (payload.ok !== true || payload.service !== "threadmark-api") {
      return failed("api", "API local", "Resposta de saúde não pertence ao Threadmark.");
    }
    return ok("api", "API local", `${apiUrl} respondeu corretamente.`);
  } catch (error) {
    return failed("api", "API local", errorMessage(error));
  }
}

async function probeWeb(webOrigin: string, fetcher: typeof fetch): Promise<DoctorProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);
  try {
    await verifyWebBuild(webOrigin, fetcher, controller.signal);
    return ok("web", "Interface Web", "HTML, CSS e JavaScript do build estão acessíveis.");
  } catch (error) {
    return failed("web", "Interface Web", errorMessage(error));
  } finally {
    clearTimeout(timer);
  }
}

function probeSqlite(databasePath: string): DoctorProbe {
  if (!existsSync(databasePath)) {
    return failed("sqlite", "SQLite", `Banco não encontrado em ${databasePath}.`);
  }
  let database: Database.Database | null = null;
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true });
    database.pragma("query_only = ON");
    const result = database.pragma("quick_check", { simple: true });
    if (result !== "ok") {
      return failed("sqlite", "SQLite", `PRAGMA quick_check retornou: ${String(result)}.`);
    }
    return ok("sqlite", "SQLite", "PRAGMA quick_check: ok.");
  } catch (error) {
    return failed("sqlite", "SQLite", errorMessage(error));
  } finally {
    database?.close();
  }
}

function probeWhatsapp(config: SupportConfig, runtime: RuntimeState): DoctorProbe {
  if (!config.whatsappEnabled) {
    return skipped("whatsapp", "WhatsApp", "Captura desativada por configuração.");
  }
  if (runtime.whatsappConnected) {
    return ok("whatsapp", "WhatsApp", "Conta conectada para captura inbound.");
  }
  const detail = runtime.qrAvailable
    ? "Aguardando leitura do QR Code."
    : `Desconectado; fase atual: ${runtime.phase}.`;
  return warning("whatsapp", "WhatsApp", detail);
}

async function probeAgent(
  config: SupportConfig,
  commandProbe: (command: string, argumentsList: string[]) => Promise<string>,
  settings?: Pick<
    AiProviderSettingsService,
    "getProfiles" | "listConnections" | "testConnection"
  > | null,
): Promise<DoctorProbe> {
  if (!config.agentEnabled) {
    return skipped("agent", "Agente de IA", "Worker de IA desativado por configuração.");
  }
  if (config.agentExecutor === "hermes") {
    return skipped(
      "agent",
      "Executor externo",
      "Triagem delegada ao Hermes; modelos e ferramentas são verificados no ambiente do agente.",
    );
  }
  if (settings === null) {
    return failed(
      "agent",
      "Agente de IA",
      "Não foi possível ler os perfis de IA porque o banco local está indisponível.",
    );
  }
  if (settings) {
    try {
      const activeProfiles = settings
        .getProfiles()
        .filter((profile) => profile.enabled);
      if (!activeProfiles.length) {
        return skipped(
          "agent",
          "Agente de IA",
          "Nenhum perfil de IA está ativo.",
        );
      }
      const missingConnection = activeProfiles.find((profile) => !profile.connectionId);
      if (missingConnection) {
        return failed(
          "agent",
          "Agente de IA",
          `O perfil ${missingConnection.taskKind} está ativo sem uma conexão selecionada.`,
        );
      }

      const connections = new Map(
        settings.listConnections().map((connection) => [connection.id, connection]),
      );
      const connectionIds = [
        ...new Set(
          activeProfiles.flatMap((profile) =>
            profile.connectionId ? [profile.connectionId] : [],
          ),
        ),
      ];
      const validated: string[] = [];
      for (const connectionId of connectionIds) {
        const connection = connections.get(connectionId);
        if (!connection || !connection.enabled) {
          return failed(
            "agent",
            "Agente de IA",
            `Uma conexão usada pelos perfis ativos está ausente ou desativada (${connectionId}).`,
          );
        }
        await settings.testConnection(connectionId);
        validated.push(`${connection.label} (${connection.providerId})`);
      }
      return ok(
        "agent",
        "Agente de IA",
        `${activeProfiles.length} perfil(is) ativo(s); conexão(ões) validada(s): ${validated.join(", ")}.`,
      );
    } catch (error) {
      return failed(
        "agent",
        "Agente de IA",
        `Uma conexão selecionada não passou no teste seguro: ${errorMessage(error)}`,
      );
    }
  }
  try {
    const version = await commandProbe(config.codexBin, ["--version"]);
    return ok("agent", "Agente de IA", version || "Codex CLI disponível.");
  } catch (error) {
    return warning(
      "agent",
      "Agente de IA",
      `Worker habilitado, mas o Codex CLI não respondeu: ${errorMessage(error)}`,
    );
  }
}

async function probeDisk(dataDir: string, fallback: string): Promise<DoctorProbe> {
  try {
    const target = existsSync(dataDir) ? dataDir : fallback;
    const stats = await statfs(target);
    const availableBytes = stats.bavail * stats.bsize;
    const available = formatBytes(availableBytes);
    if (availableBytes < 100 * 1024 * 1024) {
      return failed("disk", "Espaço em disco", `Apenas ${available} disponíveis em ${target}.`);
    }
    if (availableBytes < 512 * 1024 * 1024) {
      return warning("disk", "Espaço em disco", `Somente ${available} disponíveis em ${target}.`);
    }
    return ok("disk", "Espaço em disco", `${available} disponíveis.`);
  } catch (error) {
    return warning("disk", "Espaço em disco", errorMessage(error));
  }
}

async function fetchWithTimeout(url: URL, fetcher: typeof fetch): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    return await fetcher(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function probeCommand(
  command: string,
  argumentsList: string[],
  timeoutMs = 5_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`tempo limite de ${timeoutMs}ms excedido`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(stderr.trim() || `processo encerrou com código ${code ?? "?"}`));
    });
  });
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function ok(id: DoctorProbe["id"], label: string, message: string): DoctorProbe {
  return { id, label, state: "ok", message };
}

function warning(id: DoctorProbe["id"], label: string, message: string): DoctorProbe {
  return { id, label, state: "warning", message };
}

function failed(id: DoctorProbe["id"], label: string, message: string): DoctorProbe {
  return { id, label, state: "failed", message };
}

function skipped(id: DoctorProbe["id"], label: string, message: string): DoctorProbe {
  return { id, label, state: "skipped", message };
}

function formatBytes(bytes: number): string {
  const gibibyte = 1024 * 1024 * 1024;
  const mebibyte = 1024 * 1024;
  if (bytes >= gibibyte) return `${(bytes / gibibyte).toFixed(1)} GiB`;
  return `${Math.round(bytes / mebibyte)} MiB`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "tempo limite excedido";
  return error instanceof Error ? error.message : String(error);
}
