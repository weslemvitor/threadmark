import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

export interface ManagedWebProcess {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  once(event: "error", listener: (error: Error) => void): this;
  off(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  off(event: "error", listener: (error: Error) => void): this;
}

type SpawnWebProcess = () => ManagedWebProcess;

export interface WebProcessControllerOptions {
  stopTimeoutMs?: number;
  onError?: (error: Error) => void;
  autoRestart?: boolean;
  restartBackoffMs?: number[];
  restartResetAfterMs?: number;
  onRestartScheduled?: (delayMs: number, attempt: number) => void;
}

export class WebProcessController {
  private child: ManagedWebProcess | null = null;
  private transition: Promise<void> = Promise.resolve();
  private restartInFlight: Promise<void> | null = null;
  private readonly stopTimeoutMs: number;
  private readonly onError: (error: Error) => void;
  private readonly autoRestart: boolean;
  private readonly restartBackoffMs: number[];
  private readonly restartResetAfterMs: number;
  private readonly onRestartScheduled: (delayMs: number, attempt: number) => void;
  private readonly expectedExits = new WeakSet<ManagedWebProcess>();
  private desiredRunning = false;
  private restartAttempt = 0;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private stabilityTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly spawnProcess: SpawnWebProcess,
    options: WebProcessControllerOptions = {},
  ) {
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
    this.onError = options.onError ?? ((error) => console.error("Falha na interface web", error));
    this.autoRestart = options.autoRestart ?? true;
    this.restartBackoffMs = normalizeBackoff(options.restartBackoffMs);
    this.restartResetAfterMs = options.restartResetAfterMs ?? 60_000;
    this.onRestartScheduled = options.onRestartScheduled ?? (() => undefined);
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(): ManagedWebProcess {
    this.desiredRunning = true;
    this.cancelWatchdog();
    if (this.child && isRunning(this.child)) return this.child;
    const child = this.spawnProcess();
    this.child = child;
    child.once("error", (error) => {
      this.onError(error);
      if (
        this.child !== child ||
        this.expectedExits.has(child) ||
        !this.desiredRunning
      ) {
        return;
      }
      this.child = null;
      this.cancelStabilityReset();
      this.scheduleWatchdogRestart();
    });
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.cancelStabilityReset();
      if (this.expectedExits.delete(child) || !this.desiredRunning) return;
      this.onError(
        new Error(
          `A interface web encerrou inesperadamente (${signal ?? `código ${code ?? "?"}`}).`,
        ),
      );
      this.scheduleWatchdogRestart();
    });
    this.scheduleStabilityReset(child);
    return child;
  }

  restart(): Promise<void> {
    if (this.restartInFlight) return this.restartInFlight;
    this.desiredRunning = true;
    this.cancelWatchdog();
    const restart = this.enqueue(async () => {
      await this.stopCurrent();
      this.start();
    });
    this.restartInFlight = restart.finally(() => {
      this.restartInFlight = null;
    });
    return this.restartInFlight;
  }

  stop(): Promise<void> {
    this.desiredRunning = false;
    this.cancelWatchdog();
    this.cancelStabilityReset();
    return this.enqueue(() => this.stopCurrent());
  }

  private scheduleWatchdogRestart(): void {
    if (!this.autoRestart || !this.desiredRunning || this.watchdogTimer) return;
    const delay = this.restartBackoffMs[
      Math.min(this.restartAttempt, this.restartBackoffMs.length - 1)
    ] ?? 30_000;
    this.restartAttempt += 1;
    this.onRestartScheduled(delay, this.restartAttempt);
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null;
      if (!this.desiredRunning || this.child) return;
      try {
        this.start();
      } catch (error) {
        this.onError(error instanceof Error ? error : new Error(String(error)));
        this.scheduleWatchdogRestart();
      }
    }, delay);
    this.watchdogTimer.unref();
  }

  private scheduleStabilityReset(child: ManagedWebProcess): void {
    this.cancelStabilityReset();
    this.stabilityTimer = setTimeout(() => {
      this.stabilityTimer = null;
      if (this.child === child && isRunning(child)) this.restartAttempt = 0;
    }, this.restartResetAfterMs);
    this.stabilityTimer.unref();
  }

  private cancelWatchdog(): void {
    if (!this.watchdogTimer) return;
    clearTimeout(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  private cancelStabilityReset(): void {
    if (!this.stabilityTimer) return;
    clearTimeout(this.stabilityTimer);
    this.stabilityTimer = null;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.transition.then(operation, operation);
    this.transition = next.catch(() => undefined);
    return next;
  }

  private async stopCurrent(): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (!isRunning(child)) {
      if (this.child === child) this.child = null;
      return;
    }

    await new Promise<void>((resolve) => {
      let forceTimer: NodeJS.Timeout | null = null;
      let settleTimer: NodeJS.Timeout | null = null;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (forceTimer) clearTimeout(forceTimer);
        if (settleTimer) clearTimeout(settleTimer);
        child.off("exit", finish);
        child.off("error", handleError);
        resolve();
      };
      const handleError = (error: Error) => {
        this.onError(error);
        finish();
      };

      child.once("exit", finish);
      child.once("error", handleError);
      this.expectedExits.add(child);
      try {
        if (!child.kill("SIGTERM")) {
          finish();
          return;
        }
      } catch (error) {
        handleError(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      forceTimer = setTimeout(() => {
        if (!isRunning(child)) {
          finish();
          return;
        }
        try {
          child.kill("SIGKILL");
        } catch (error) {
          this.onError(error instanceof Error ? error : new Error(String(error)));
        }
        settleTimer = setTimeout(finish, 1_000);
      }, this.stopTimeoutMs);
    });

    if (this.child === child) this.child = null;
  }
}

export function createVinextWebProcessController(
  projectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): WebProcessController {
  const vinextCli = path.join(projectRoot, "node_modules", "vinext", "dist", "cli.js");
  return new WebProcessController(
    () =>
      spawn(process.execPath, [vinextCli, "start", "--hostname", "127.0.0.1"], {
        cwd: projectRoot,
        env: environment,
        stdio: "inherit",
      }) as ChildProcess,
    {
      onRestartScheduled: (delayMs, attempt) =>
        console.warn(
          `Interface web indisponível; nova tentativa ${attempt} em ${delayMs}ms.`,
        ),
    },
  );
}

function isRunning(child: ManagedWebProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function normalizeBackoff(backoff = [1_000, 2_000, 5_000, 10_000, 30_000]): number[] {
  const normalized = backoff.filter(
    (value) => Number.isSafeInteger(value) && value >= 0 && value <= 5 * 60_000,
  );
  return normalized.length ? normalized : [1_000];
}
