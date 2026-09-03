import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const envSchema = z.object({
  SUPPORT_API_HOST: z.string().default("127.0.0.1"),
  SUPPORT_API_PORT: z.coerce.number().int().min(1).max(65_535).default(4317),
  SUPPORT_WEB_ORIGIN: z.string().url().default("http://127.0.0.1:3000"),
  SUPPORT_DATA_DIR: z.string().trim().optional(),
  CODEX_BIN: z.string().default("codex"),
  SUPPORT_WHATSAPP_PHONE: z.string().default("commercial-account"),
  SUPPORT_WHATSAPP_NAME: z.string().default("Threadmark"),
  SUPPORT_MONITORED_GROUPS: z.string().default(""),
  SUPPORT_STAFF_IDENTITIES: z.string().default(""),
  SUPPORT_WHATSAPP_ENABLED: booleanEnvironment(true),
  SUPPORT_START_WEB: booleanEnvironment(true),
  SUPPORT_AGENT_ENABLED: booleanEnvironment(true),
  SUPPORT_AGENT_EXECUTOR: z.enum(["internal", "hermes"]).default("internal"),
  SUPPORT_AGENT_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(2),
  SUPPORT_CODEX_MCP_TOOL_LOOP_ENABLED: booleanEnvironment(true),
  SUPPORT_TRIAGE_AI_ENABLED: booleanEnvironment(true),
  SUPPORT_TRIAGE_AI_MODEL: z.string().trim().min(1).default("gpt-5.4-mini"),
  SUPPORT_TRIAGE_AI_QUIET_MS: z.coerce
    .number()
    .int()
    .min(30_000)
    .max(30 * 60_000)
    .default(180_000),
  SUPPORT_WORKSPACE_NAME: z.string().trim().min(1).default("Meu workspace"),
  SUPPORT_CODE_ROOTS: z.string().default(""),
  SUPPORT_VAULT_DIR: z.string().default(""),
});

export interface SupportConfig {
  projectRoot: string;
  apiHost: string;
  apiPort: number;
  apiUrl: string;
  webOrigin: string;
  dataDir: string;
  databasePath: string;
  attachmentsDir: string;
  authDir: string;
  logsDir: string;
  backupsDir: string;
  runtimeStatePath: string;
  localSettingsPath: string;
  localAccessTokenPath: string;
  pidPath: string;
  codexBin: string;
  whatsappPhone: string;
  whatsappName: string;
  monitoredGroupJids: string[];
  staffIdentities: string[];
  whatsappEnabled: boolean;
  startWeb: boolean;
  agentEnabled: boolean;
  agentExecutor: "internal" | "hermes";
  agentConcurrency: number;
  codexMcpToolLoopEnabled: boolean;
  triageAiEnabled: boolean;
  triageAiModel: string;
  triageAiQuietMs: number;
  workspaceName: string;
  /** Legacy sources are exposed only as explicit import candidates. */
  legacyCodeRoots: string[];
  legacyVaultDirectory: string | null;
}

export function loadConfig(
  environment: Partial<NodeJS.ProcessEnv> = process.env,
): SupportConfig {
  if (environment === process.env) loadProjectEnv();
  const env = envSchema.parse(environment);
  const configuredDataDirectory = env.SUPPORT_DATA_DIR?.trim();
  const dataDir = configuredDataDirectory
    ? path.resolve(projectRoot, configuredDataDirectory)
    : environment === process.env
      ? defaultSupportDataDirectory()
      : path.resolve(projectRoot, ".data");
  const apiUrl = `http://${env.SUPPORT_API_HOST}:${env.SUPPORT_API_PORT}`;
  const preferredDatabasePath = path.join(dataDir, "threadmark.sqlite");
  const legacyDatabasePath = path.join(dataDir, "support-copilot.sqlite");
  const useLegacyPaths =
    environment === process.env &&
    existsSync(legacyDatabasePath) &&
    !existsSync(preferredDatabasePath);

  return {
    projectRoot,
    apiHost: env.SUPPORT_API_HOST,
    apiPort: env.SUPPORT_API_PORT,
    apiUrl,
    webOrigin: env.SUPPORT_WEB_ORIGIN,
    dataDir,
    databasePath: useLegacyPaths ? legacyDatabasePath : preferredDatabasePath,
    attachmentsDir: path.join(dataDir, "attachments"),
    authDir: path.join(dataDir, "whatsapp-auth"),
    logsDir: path.join(dataDir, "logs"),
    backupsDir: path.join(dataDir, "backups"),
    runtimeStatePath: path.join(dataDir, "runtime.json"),
    localSettingsPath: path.join(dataDir, "settings.json"),
    localAccessTokenPath: path.join(dataDir, "local-access.token"),
    pidPath: path.join(
      dataDir,
      useLegacyPaths ? "support-copilot.pid" : "threadmark.pid",
    ),
    codexBin: env.CODEX_BIN,
    whatsappPhone: env.SUPPORT_WHATSAPP_PHONE,
    whatsappName: env.SUPPORT_WHATSAPP_NAME,
    monitoredGroupJids: commaSeparated(env.SUPPORT_MONITORED_GROUPS),
    staffIdentities: commaSeparated(env.SUPPORT_STAFF_IDENTITIES),
    whatsappEnabled: env.SUPPORT_WHATSAPP_ENABLED,
    startWeb: env.SUPPORT_START_WEB,
    agentEnabled: env.SUPPORT_AGENT_ENABLED,
    agentExecutor: env.SUPPORT_AGENT_EXECUTOR,
    agentConcurrency: env.SUPPORT_AGENT_CONCURRENCY,
    codexMcpToolLoopEnabled: env.SUPPORT_CODEX_MCP_TOOL_LOOP_ENABLED,
    triageAiEnabled: env.SUPPORT_TRIAGE_AI_ENABLED,
    triageAiModel: env.SUPPORT_TRIAGE_AI_MODEL,
    triageAiQuietMs: env.SUPPORT_TRIAGE_AI_QUIET_MS,
    workspaceName: env.SUPPORT_WORKSPACE_NAME,
    legacyCodeRoots: commaSeparated(env.SUPPORT_CODE_ROOTS),
    legacyVaultDirectory: env.SUPPORT_VAULT_DIR.trim() || null,
  };
}

export interface DefaultSupportDataDirectoryOptions {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  environment?: Partial<NodeJS.ProcessEnv>;
}

export function defaultSupportDataDirectory(
  options: DefaultSupportDataDirectoryOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const environment = options.environment ?? process.env;

  if (platform === "darwin") {
    return path.posix.join(homeDirectory, "Library", "Application Support", "Threadmark");
  }
  if (platform === "win32") {
    const localAppData = environment.LOCALAPPDATA?.trim();
    return path.win32.join(
      localAppData || path.win32.join(homeDirectory, "AppData", "Local"),
      "Threadmark",
    );
  }

  const xdgDataHome = environment.XDG_DATA_HOME?.trim();
  return path.posix.join(
    xdgDataHome || path.posix.join(homeDirectory, ".local", "share"),
    "threadmark",
  );
}

let projectEnvironmentLoaded = false;

export function loadProjectEnv(): void {
  if (projectEnvironmentLoaded) return;
  projectEnvironmentLoaded = true;
  // O Bun carrega .env automaticamente; process.loadEnvFile existe apenas no Node.
  if (typeof process.loadEnvFile !== "function") return;
  try {
    process.loadEnvFile(path.join(projectRoot, ".env"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function commaSeparated(value: string): string[] {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function booleanEnvironment(defaultValue: boolean) {
  return z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default(defaultValue ? "true" : "false")
    .transform((value) => new Set(["true", "1", "yes"]).has(value));
}
