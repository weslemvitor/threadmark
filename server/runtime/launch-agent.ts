import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { SupportConfig } from "./config.js";

export const THREADMARK_LAUNCH_AGENT_LABEL = "app.threadmark.local";

export interface LaunchAgentStatus {
  supported: boolean;
  installed: boolean;
  loaded: boolean;
  label: string;
  plistPath: string;
  detail: string;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

type RunCommand = (command: string, argumentsList: string[]) => Promise<CommandResult>;

export function launchAgentPath(homeDirectory = os.homedir()): string {
  return path.join(
    homeDirectory,
    "Library",
    "LaunchAgents",
    `${THREADMARK_LAUNCH_AGENT_LABEL}.plist`,
  );
}

export function renderLaunchAgentPlist(
  config: SupportConfig,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const tsxCli = path.join(config.projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const runner = path.join(config.projectRoot, "server", "service-runner.ts");
  const executablePath = environment.PATH?.trim() || "/usr/local/bin:/usr/bin:/bin";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(THREADMARK_LAUNCH_AGENT_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(tsxCli)}</string>
    <string>${xml(runner)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(config.projectRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(executablePath)}</string>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
`;
}

export async function installLaunchAgent(
  config: SupportConfig,
  options: { homeDirectory?: string; runCommand?: RunCommand } = {},
): Promise<LaunchAgentStatus> {
  assertMacOs();
  const runCommand = options.runCommand ?? run;
  const plistPath = launchAgentPath(options.homeDirectory);
  await mkdir(path.dirname(plistPath), { recursive: true, mode: 0o700 });
  await writeFile(plistPath, renderLaunchAgentPlist(config), { mode: 0o644 });

  const target = launchAgentTarget();
  await runCommand("launchctl", ["bootout", target]).catch(() => undefined);
  const bootstrap = await runCommand("launchctl", ["bootstrap", launchAgentDomain(), plistPath]);
  if (bootstrap.code !== 0) {
    throw new Error(bootstrap.stderr || "launchctl bootstrap falhou.");
  }
  const kickstart = await runCommand("launchctl", ["kickstart", "-k", target]);
  if (kickstart.code !== 0) {
    throw new Error(kickstart.stderr || "launchctl kickstart falhou.");
  }
  return getLaunchAgentStatus({ homeDirectory: options.homeDirectory, runCommand });
}

export async function uninstallLaunchAgent(
  options: { homeDirectory?: string; runCommand?: RunCommand } = {},
): Promise<LaunchAgentStatus> {
  assertMacOs();
  const runCommand = options.runCommand ?? run;
  await runCommand("launchctl", ["bootout", launchAgentTarget()]).catch(() => undefined);
  await rm(launchAgentPath(options.homeDirectory), { force: true });
  return getLaunchAgentStatus({ homeDirectory: options.homeDirectory, runCommand });
}

export async function getLaunchAgentStatus(
  options: { homeDirectory?: string; runCommand?: RunCommand } = {},
): Promise<LaunchAgentStatus> {
  const plistPath = launchAgentPath(options.homeDirectory);
  if (process.platform !== "darwin") {
    return {
      supported: false,
      installed: false,
      loaded: false,
      label: THREADMARK_LAUNCH_AGENT_LABEL,
      plistPath,
      detail: "A instalação automática está disponível apenas no macOS.",
    };
  }
  const installed = await fileExists(plistPath);
  const result = await (options.runCommand ?? run)("launchctl", [
    "print",
    launchAgentTarget(),
  ]);
  return {
    supported: true,
    installed,
    loaded: result.code === 0,
    label: THREADMARK_LAUNCH_AGENT_LABEL,
    plistPath,
    detail: result.code === 0 ? result.stdout.trim() : result.stderr.trim(),
  };
}

export async function startInstalledLaunchAgent(
  options: { homeDirectory?: string; runCommand?: RunCommand } = {},
): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const plistPath = launchAgentPath(options.homeDirectory);
  if (!(await fileExists(plistPath))) return false;
  const runCommand = options.runCommand ?? run;
  const target = launchAgentTarget();
  let status = await runCommand("launchctl", ["print", target]);
  if (status.code !== 0) {
    status = await runCommand("launchctl", ["bootstrap", launchAgentDomain(), plistPath]);
    if (status.code !== 0) {
      throw new Error(status.stderr || "Não foi possível carregar o serviço do Threadmark.");
    }
  }
  const result = await runCommand("launchctl", ["kickstart", "-k", target]);
  if (result.code !== 0) {
    throw new Error(result.stderr || "Não foi possível iniciar o serviço do Threadmark.");
  }
  return true;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath, "utf8");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function launchAgentDomain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Não foi possível identificar o usuário local.");
  return `gui/${uid}`;
}

function launchAgentTarget(): string {
  return `${launchAgentDomain()}/${THREADMARK_LAUNCH_AGENT_LABEL}`;
}

function assertMacOs(): void {
  if (process.platform !== "darwin") {
    throw new Error("O serviço automático desta versão está disponível apenas no macOS.");
  }
}

function run(command: string, argumentsList: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
