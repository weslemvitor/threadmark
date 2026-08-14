import {
  Browsers,
  DisconnectReason,
  makeWASocket,
  type WAVersion,
} from "baileys";

import {
  loadPersistentAuthState,
  resetPersistentAuthState,
  type PersistentAuthState,
} from "./auth.js";
import {
  bindInboundEvents,
  getDisconnectStatusCode,
  normalizeGroupRosters,
  type BoundInboundEvents,
} from "./events.js";
import {
  createBaileysMediaStreamLoader,
  createInboundMediaDownloader,
} from "./media.js";
import type {
  ConnectionUpdatePayload,
  InboundMessageSink,
  NormalizationPolicyInput,
} from "./types.js";
import { resolveWhatsAppWebVersion } from "./version.js";

type BaileysSocket = ReturnType<typeof makeWASocket>;

export type InboundWhatsAppClientState =
  | "idle"
  | "starting"
  | "connecting"
  | "running"
  | "reconnecting"
  | "auth_required"
  | "stopping"
  | "stopped";

export interface InboundWhatsAppClientOptions extends NormalizationPolicyInput {
  authDirectory: string;
  sink: InboundMessageSink;
  media?: {
    enabled?: boolean;
    maxBytes?: number;
    timeoutMs?: number;
  };
  reconnect?: {
    initialDelayMs?: number;
    maxDelayMs?: number;
  };
}

export interface InboundWhatsAppClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  renewQr(): Promise<void>;
  getState(): InboundWhatsAppClientState;
}

interface ActiveConnection {
  socket: BaileysSocket;
  bridge: BoundInboundEvents;
  onCredsUpdate: () => void;
  onConnectionUpdate: (update: ConnectionUpdatePayload) => void;
}

/**
 * Creates a lazy inbound client. No network connection is opened until
 * `start()` is explicitly called, which keeps imports and tests side-effect
 * free. The returned API deliberately has no access to the Baileys socket.
 */
export function createInboundWhatsAppClient(
  options: InboundWhatsAppClientOptions,
): InboundWhatsAppClient {
  const initialReconnectDelay = positiveInteger(
    options.reconnect?.initialDelayMs,
    1_000,
  );
  const maxReconnectDelay = positiveInteger(
    options.reconnect?.maxDelayMs,
    30_000,
  );
  const policy: NormalizationPolicyInput = {
    allowlistedGroupJids: options.allowlistedGroupJids
      ? Array.from(options.allowlistedGroupJids)
      : undefined,
    staffIdentities: Array.from(options.staffIdentities ?? []),
  };

  let state: InboundWhatsAppClientState = "idle";
  let active: ActiveConnection | null = null;
  let auth: PersistentAuthState | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let reconnectDelay = initialReconnectDelay;
  let generation = 0;
  let qrRenewal: Promise<void> | null = null;
  let waVersion: WAVersion | null = null;

  const client: InboundWhatsAppClient = {
    async start() {
      if (!canStart(state)) {
        return;
      }

      generation += 1;
      const currentGeneration = generation;
      state = "starting";
      try {
        auth = await loadPersistentAuthState(options.authDirectory);
        if (currentGeneration !== generation) {
          return;
        }
        await connect(currentGeneration, false);
      } catch (error: unknown) {
        state = "stopped";
        await reportClientError(options.sink, "connection.update", error);
        throw error;
      }
    },

    async stop() {
      if (state === "idle" || state === "stopped") {
        state = "stopped";
        return;
      }

      state = "stopping";
      generation += 1;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      const connection = active;
      if (connection) {
        try {
          await connection.socket.end(undefined);
          await connection.bridge.flush();
        } finally {
          detachConnection(connection);
          if (active === connection) {
            active = null;
          }
        }
      }
      state = "stopped";
    },

    renewQr() {
      if (qrRenewal) return qrRenewal;
      qrRenewal = (async () => {
        if (state === "running") {
          throw new Error(
            "O WhatsApp ainda está conectado. Desconecte a conta antes de gerar um novo QR code.",
          );
        }
        await client.stop();
        auth = null;
        waVersion = null;
        reconnectDelay = initialReconnectDelay;
        await resetPersistentAuthState(options.authDirectory);
        await client.start();
      })().finally(() => {
        qrRenewal = null;
      });
      return qrRenewal;
    },

    getState() {
      return state;
    },
  };

  async function connect(
    currentGeneration: number,
    isReconnect: boolean,
  ): Promise<void> {
    if (!auth || currentGeneration !== generation || state === "stopping") {
      return;
    }

    state = isReconnect ? "reconnecting" : "connecting";
    waVersion ??= await resolveWhatsAppWebVersion();
    if (currentGeneration !== generation) {
      return;
    }
    const socket = makeWASocket({
      auth: auth.state,
      browser: Browsers.macOS("Threadmark"),
      emitOwnEvents: true,
      fireInitQueries: true,
      markOnlineOnConnect: false,
      shouldIgnoreJid: () => false,
      shouldSyncHistoryMessage: () => true,
      syncFullHistory: true,
      version: waVersion,
    });

    const mediaDownloader =
      options.media?.enabled === false
        ? undefined
        : createInboundMediaDownloader({
            maxBytes: options.media?.maxBytes,
            timeoutMs: options.media?.timeoutMs,
            loadStream: createBaileysMediaStreamLoader({
              logger: socket.logger,
              reuploadRequest: (message) => socket.updateMediaMessage(message),
            }),
          });
    const bridge = bindInboundEvents({
      source: socket.ev,
      sink: options.sink,
      policy,
      mediaDownloader,
    });
    const onCredsUpdate = () => {
      void auth?.saveCreds().catch((error: unknown) =>
        reportClientError(options.sink, "creds.update", error),
      );
    };
    const onConnectionUpdate = (update: ConnectionUpdatePayload) => {
      if (update.connection === "open") {
        state = "running";
        reconnectDelay = initialReconnectDelay;
        synchronizeParticipatingGroups(connection, currentGeneration);
        return;
      }
      if (update.connection === "close") {
        void handleClose(connection, update);
      }
    };
    const connection: ActiveConnection = {
      socket,
      bridge,
      onCredsUpdate,
      onConnectionUpdate,
    };

    socket.ev.on("creds.update", onCredsUpdate);
    socket.ev.on("connection.update", onConnectionUpdate);
    active = connection;
  }

  function synchronizeParticipatingGroups(
    connection: ActiveConnection,
    currentGeneration: number,
  ): void {
    if (
      !options.sink.syncGroupRosters &&
      !options.sink.upsertIdentityLinks
    ) {
      return;
    }

    const rosters = Promise.resolve()
      .then(() => connection.socket.groupFetchAllParticipating())
      .then((participating) => {
        if (
          active !== connection ||
          generation !== currentGeneration ||
          state === "stopping" ||
          state === "stopped"
        ) {
          return [];
        }
        return normalizeGroupRosters(
          Object.values(participating),
          new Date().toISOString(),
        );
      });
    // Enqueue the unresolved fetch immediately. Later message events cannot
    // overtake the initial roster snapshot for this connection.
    void connection.bridge.syncGroupRosters(rosters);
  }

  async function handleClose(
    connection: ActiveConnection,
    update: ConnectionUpdatePayload,
  ): Promise<void> {
    if (active !== connection) {
      return;
    }

    detachConnection(connection);
    active = null;
    if (state === "stopping" || state === "stopped") {
      return;
    }

    const statusCode = getDisconnectStatusCode(update.lastDisconnect?.error);
    if (statusCode === DisconnectReason.loggedOut) {
      state = "auth_required";
      return;
    }
    scheduleReconnect(generation);
  }

  function scheduleReconnect(currentGeneration: number): void {
    if (reconnectTimer || currentGeneration !== generation) {
      return;
    }
    state = "reconnecting";
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelay);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect(currentGeneration, true).catch(async (error: unknown) => {
        await reportClientError(options.sink, "connection.update", error);
        scheduleReconnect(currentGeneration);
      });
    }, delay);
  }

  return client;
}

function detachConnection(connection: ActiveConnection): void {
  connection.bridge.detach();
  connection.socket.ev.off("creds.update", connection.onCredsUpdate);
  connection.socket.ev.off(
    "connection.update",
    connection.onConnectionUpdate,
  );
}

function canStart(state: InboundWhatsAppClientState): boolean {
  return state === "idle" || state === "stopped";
}

async function reportClientError(
  sink: InboundMessageSink,
  source: "connection.update" | "creds.update" | "group_roster.sync",
  error: unknown,
): Promise<void> {
  try {
    await sink.emitRuntimeEvent?.({
      type: "ingestion_error",
      occurredAt: new Date().toISOString(),
      source,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  } catch {
    // A diagnostics sink cannot make connection recovery crash the daemon.
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
