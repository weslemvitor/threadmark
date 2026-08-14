import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type RuntimePhase =
  | "offline"
  | "starting"
  | "waiting_qr"
  | "syncing"
  | "online"
  | "stopping"
  | "error";

export interface RuntimeState {
  phase: RuntimePhase;
  pid: number | null;
  startedAt: string | null;
  updatedAt: string;
  whatsappConnected: boolean;
  qrAvailable: boolean;
  groupsDiscovered: number;
  groupsSynced: number;
  privateConversations: number;
  messagesStored: number;
  ticketsCreated: number;
  lastError: string | null;
}

export function offlineRuntimeState(now = new Date()): RuntimeState {
  return {
    phase: "offline",
    pid: null,
    startedAt: null,
    updatedAt: now.toISOString(),
    whatsappConnected: false,
    qrAvailable: false,
    groupsDiscovered: 0,
    groupsSynced: 0,
    privateConversations: 0,
    messagesStored: 0,
    ticketsCreated: 0,
    lastError: null,
  };
}

export class RuntimeStateFile {
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async read(): Promise<RuntimeState> {
    try {
      const persisted = JSON.parse(
        await readFile(this.filePath, "utf8"),
      ) as Partial<RuntimeState>;
      return {
        ...offlineRuntimeState(),
        ...persisted,
        privateConversations: persisted.privateConversations ?? 0,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return offlineRuntimeState();
      }
      throw error;
    }
  }

  async write(state: RuntimeState): Promise<void> {
    return this.enqueueWrite(() => this.writeUnlocked(state));
  }

  async patch(
    update: Partial<Omit<RuntimeState, "updatedAt">>,
  ): Promise<RuntimeState> {
    return this.enqueueWrite(async () => {
      const next = {
        ...(await this.read()),
        ...update,
        updatedAt: new Date().toISOString(),
      };
      await this.writeUnlocked(next);
      return next;
    });
  }

  private async writeUnlocked(state: RuntimeState): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(
      temporaryPath,
      JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2),
      { mode: 0o600 },
    );
    await rename(temporaryPath, this.filePath);
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.pendingWrite.then(operation, operation);
    this.pendingWrite = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }
}
