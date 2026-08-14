import { verifyWebBuild } from "./web-readiness.js";

const THREADMARK_API_SERVICE = "threadmark-api";

export interface ThreadmarkDaemonIdentity {
  ok: true;
  service: typeof THREADMARK_API_SERVICE;
  pid: number;
  startedAt: string | null;
}

export type DaemonInspection =
  | { state: "offline"; message: string }
  | { state: "foreign"; message: string }
  | { state: "unavailable"; message: string }
  | {
      state: "threadmark";
      authenticated: boolean;
      identity: ThreadmarkDaemonIdentity | null;
      pid: number | null;
      message: string;
    };

export interface DaemonInspectionOptions {
  token?: string | null;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export interface DaemonReadinessOptions {
  apiUrl: string;
  webOrigin: string;
  webEnabled: boolean;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  retryIntervalMs?: number;
}

/**
 * Identifies the process bound to the configured local API without touching SQLite.
 * A Threadmark health response is only considered owned by this installation after
 * the machine-local bearer token succeeds against the identity endpoint.
 */
export async function inspectDaemonIdentity(
  apiUrl: string,
  options: DaemonInspectionOptions = {},
): Promise<DaemonInspection> {
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 2_500;
  let health: Response;
  try {
    health = await fetchWithTimeout(
      new URL("/health", apiUrl),
      { headers: { accept: "application/json" } },
      fetcher,
      timeoutMs,
    );
  } catch (error) {
    if (isTimeout(error)) {
      return {
        state: "unavailable",
        message: "A porta da API local não respondeu dentro do prazo.",
      };
    }
    return {
      state: "offline",
      message: "Nenhuma API respondeu no endereço local configurado.",
    };
  }

  const healthPayload = await readJsonRecord(health);
  if (
    !health.ok ||
    healthPayload?.ok !== true ||
    healthPayload.service !== THREADMARK_API_SERVICE
  ) {
    return {
      state: "foreign",
      message: `A porta configurada respondeu, mas não pertence ao Threadmark (HTTP ${health.status}).`,
    };
  }

  const healthPid = positiveInteger(healthPayload.pid);
  const token = options.token?.trim();
  if (!token) {
    return {
      state: "threadmark",
      authenticated: false,
      identity: null,
      pid: healthPid,
      message: "A API pertence ao Threadmark, mas a instalação ainda não foi autenticada.",
    };
  }

  let identityResponse: Response;
  try {
    identityResponse = await fetchWithTimeout(
      new URL("/api/runtime/identity", apiUrl),
      {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
        },
      },
      fetcher,
      timeoutMs,
    );
  } catch (error) {
    return {
      state: "unavailable",
      message: isTimeout(error)
        ? "A API local não confirmou sua identidade dentro do prazo."
        : "A API local ficou indisponível durante a confirmação de identidade.",
    };
  }

  const identityPayload = await readJsonRecord(identityResponse);
  if (
    !identityResponse.ok ||
    identityPayload?.ok !== true ||
    identityPayload.service !== THREADMARK_API_SERVICE
  ) {
    return {
      state: "threadmark",
      authenticated: false,
      identity: null,
      pid: healthPid,
      message:
        identityResponse.status === 401 || identityResponse.status === 403
          ? "A API é do Threadmark, mas usa outra credencial local."
          : "A API é do Threadmark, mas não confirmou a identidade desta instalação.",
    };
  }

  const pid = positiveInteger(identityPayload.pid);
  if (!pid || (healthPid && healthPid !== pid)) {
    return {
      state: "unavailable",
      message: "A API local retornou uma identidade inconsistente.",
    };
  }
  const identity: ThreadmarkDaemonIdentity = {
    ok: true,
    service: THREADMARK_API_SERVICE,
    pid,
    startedAt:
      typeof identityPayload.startedAt === "string"
        ? identityPayload.startedAt
        : null,
  };
  return {
    state: "threadmark",
    authenticated: true,
    identity,
    pid,
    message: `Daemon Threadmark autenticado no PID ${pid}.`,
  };
}

/** Waits until both the API identity and the production Web build are usable. */
export async function waitForDaemonReady(
  options: DaemonReadinessOptions,
): Promise<ThreadmarkDaemonIdentity> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const retryIntervalMs = options.retryIntervalMs ?? 250;
  const fetcher = options.fetcher ?? fetch;
  const deadline = Date.now() + timeoutMs;
  let lastError = "serviços locais ainda indisponíveis";

  do {
    const attemptTimeout = Math.max(1, Math.min(3_000, deadline - Date.now()));
    try {
      const health = await fetchWithTimeout(
        new URL("/health", options.apiUrl),
        { headers: { accept: "application/json" } },
        fetcher,
        attemptTimeout,
      );
      const payload = await readJsonRecord(health);
      const pid = positiveInteger(payload?.pid);
      if (
        !health.ok ||
        payload?.ok !== true ||
        payload.service !== THREADMARK_API_SERVICE ||
        !pid
      ) {
        throw new Error("o health-check não confirmou o daemon Threadmark");
      }
      if (options.webEnabled) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), attemptTimeout);
        try {
          await verifyWebBuild(options.webOrigin, fetcher, controller.signal);
        } finally {
          clearTimeout(timer);
        }
      }
      return {
        ok: true,
        service: THREADMARK_API_SERVICE,
        pid,
        startedAt: typeof payload.startedAt === "string" ? payload.startedAt : null,
      };
    } catch (error) {
      lastError = errorMessage(error);
    }
    if (Date.now() < deadline) await wait(retryIntervalMs);
  } while (Date.now() < deadline);

  throw new Error(
    `Os serviços locais não ficaram prontos em ${timeoutMs}ms: ${lastError}.`,
  );
}

export async function requestDaemonShutdown(
  apiUrl: string,
  token: string,
  expectedPid: number,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchWithTimeout(
    new URL("/api/runtime/shutdown", apiUrl),
    {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
    },
    fetcher,
    5_000,
  );
  const payload = await readJsonRecord(response);
  if (!response.ok) {
    throw new Error(
      `O daemon recusou o encerramento autenticado (HTTP ${response.status}).`,
    );
  }
  if (
    payload?.accepted !== true ||
    payload.service !== THREADMARK_API_SERVICE ||
    positiveInteger(payload.pid) !== expectedPid
  ) {
    throw new Error("O daemon retornou uma confirmação de encerramento inconsistente.");
  }
}

export async function waitForDaemonStopped(
  apiUrl: string,
  pid: number,
  options: {
    fetcher?: typeof fetch;
    processRunning?: (pid: number) => boolean;
    timeoutMs?: number;
    retryIntervalMs?: number;
  } = {},
): Promise<void> {
  const fetcher = options.fetcher ?? fetch;
  const processRunning = options.processRunning ?? isProcessRunning;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const retryIntervalMs = options.retryIntervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;

  do {
    const inspection = await inspectDaemonIdentity(apiUrl, {
      fetcher,
      timeoutMs: Math.min(1_000, Math.max(1, deadline - Date.now())),
    });
    const sameApiStillRunning =
      inspection.state === "threadmark" && inspection.pid === pid;
    if (!processRunning(pid) && !sameApiStillRunning) return;
    if (Date.now() < deadline) await wait(retryIntervalMs);
  } while (Date.now() < deadline);

  throw new Error(
    `O daemon ${pid} não confirmou o encerramento no prazo. Consulte o log antes de intervir.`,
  );
}

async function fetchWithTimeout(
  url: URL,
  init: RequestInit,
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonRecord(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const value = (await response.json()) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  if (isTimeout(error)) return "tempo limite excedido";
  return error instanceof Error ? error.message : String(error);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
