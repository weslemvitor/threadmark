import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export function webBuildReloadPath(dataDir: string): string {
  return path.join(dataDir, ".web-build-reload");
}

export async function requestWebBuildReload(
  requestPath: string,
  token = `${Date.now()}-${randomUUID()}`,
): Promise<string> {
  await mkdir(path.dirname(requestPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${requestPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, requestPath);
  return token;
}

export async function readWebBuildReloadRequest(
  requestPath: string,
): Promise<string | null> {
  try {
    const value = (await readFile(requestPath, "utf8")).trim();
    return value || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export interface WebBuildReloadMonitorOptions {
  intervalMs?: number;
  onError?: (error: Error) => void;
}

export class WebBuildReloadMonitor {
  private timer: NodeJS.Timeout | null = null;
  private active = false;
  private lastHandledToken: string | null = null;
  private pollInFlight: Promise<void> | null = null;
  private readonly intervalMs: number;
  private readonly onError: (error: Error) => void;

  constructor(
    private readonly requestPath: string,
    private readonly onReload: (token: string) => Promise<void>,
    options: WebBuildReloadMonitorOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 750;
    this.onError = options.onError ?? ((error) => console.error("Falha ao recarregar a interface", error));
  }

  async start(): Promise<void> {
    if (this.active) return;
    this.lastHandledToken = await readWebBuildReloadRequest(this.requestPath);
    this.active = true;
    this.timer = setInterval(() => {
      void this.pollNow().catch(this.onError);
    }, this.intervalMs);
    this.timer.unref();
  }

  pollNow(): Promise<void> {
    if (!this.active) return Promise.resolve();
    if (this.pollInFlight) return this.pollInFlight;
    const poll = this.checkForReload();
    this.pollInFlight = poll.finally(() => {
      this.pollInFlight = null;
    });
    return this.pollInFlight;
  }

  stop(): void {
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async checkForReload(): Promise<void> {
    const token = await readWebBuildReloadRequest(this.requestPath);
    if (!this.active || !token || token === this.lastHandledToken) return;
    await this.onReload(token);
    this.lastHandledToken = token;
  }
}
