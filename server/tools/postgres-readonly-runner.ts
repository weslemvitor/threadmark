import { Readable } from "node:stream";

import { Client, type ClientConfig } from "pg";
import { to as copyTo } from "pg-copy-streams";

import type { LocalToolConfigMap } from "../../shared/contracts.js";

const POSTGRES_CONNECT_TIMEOUT_MS = 10_000;
const POSTGRES_LOCK_TIMEOUT_MS = 5_000;

export interface PostgresQueryRequest {
  config: LocalToolConfigMap["postgres_readonly"];
  password?: string;
  /** A single, already validated SELECT/WITH statement. */
  query: string;
  /** Wall-clock deadline for connect, execution, streaming and cleanup. */
  timeoutMs: number;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export type PostgresRunner = (request: PostgresQueryRequest) => Promise<string>;

export interface PostgresClientLike {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  copyToCsv(copySql: string): Readable;
  end(): Promise<void>;
}

export type PostgresClientFactory = (config: ClientConfig) => PostgresClientLike;

export interface PostgresRunnerOptions {
  clientFactory?: PostgresClientFactory;
}

/** Creates a bounded PostgreSQL reader with no dependency on a local `psql` binary. */
export function createPostgresRunner(
  options: PostgresRunnerOptions = {},
): PostgresRunner {
  const clientFactory = options.clientFactory ?? createPgClient;
  return async (request) => withDeadline(request, async (signal) => {
    const sslCandidates = postgresSslCandidates(request.config.sslMode);
    let lastError: unknown;

    for (const ssl of sslCandidates) {
      try {
        return await runPostgresAttempt(request, ssl, signal, clientFactory);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        lastError = error;
        if (request.config.sslMode !== "prefer" || !isSslUnsupportedError(error)) break;
      }
    }

    throw redactPostgresError(lastError, request.password);
  });
}

export const runPostgresReadonly = createPostgresRunner();

async function runPostgresAttempt(
  request: PostgresQueryRequest,
  ssl: ClientConfig["ssl"],
  signal: AbortSignal,
  clientFactory: PostgresClientFactory,
): Promise<string> {
  const totalTimeoutMs = Math.max(1, request.timeoutMs);
  const statementTimeoutMs = Math.max(
    1,
    Math.min(request.statementTimeoutMs ?? totalTimeoutMs, totalTimeoutMs),
  );
  const lockTimeoutMs = Math.max(
    1,
    Math.min(
      request.lockTimeoutMs ?? POSTGRES_LOCK_TIMEOUT_MS,
      statementTimeoutMs,
      POSTGRES_LOCK_TIMEOUT_MS,
    ),
  );
  const client = clientFactory({
    host: request.config.host,
    port: request.config.port,
    database: request.config.database,
    user: request.config.username,
    ...(request.password ? { password: request.password } : {}),
    ssl,
    application_name: "threadmark_readonly",
    connectionTimeoutMillis: Math.min(POSTGRES_CONNECT_TIMEOUT_MS, totalTimeoutMs),
    query_timeout: totalTimeoutMs,
  });
  let transactionOpen = false;
  let output: Readable | null = null;
  let closePromise: Promise<void> | null = null;
  const close = () => {
    closePromise ??= client.end().catch(() => undefined);
    return closePromise;
  };
  const abortListener = () => {
    output?.destroy();
    void close();
  };
  signal.addEventListener("abort", abortListener, { once: true });
  if (signal.aborted) abortListener();

  try {
    signal.throwIfAborted();
    await client.connect();
    signal.throwIfAborted();
    await client.query("BEGIN READ ONLY");
    transactionOpen = true;
    await client.query(`SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`);
    await client.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
    await client.query(`SET LOCAL idle_in_transaction_session_timeout = '${totalTimeoutMs}ms'`);
    signal.throwIfAborted();
    output = client.copyToCsv(
      `COPY (${request.query}) TO STDOUT WITH (FORMAT CSV, HEADER TRUE)`,
    );
    const content = await readBoundedStream(output, request.maxOutputBytes, signal);
    signal.throwIfAborted();
    await client.query("ROLLBACK");
    transactionOpen = false;
    return content;
  } catch (error) {
    const copyStarted = output !== null;
    output?.destroy();
    // Once COPY has started, closing the connection is the only bounded cleanup.
    // Issuing ROLLBACK while the protocol is still in COPY mode can hang and mask
    // the original output-limit, stream or cancellation error.
    if (transactionOpen && !copyStarted && !signal.aborted) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    if (signal.aborted) throw signal.reason;
    throw redactPostgresError(error, request.password);
  } finally {
    signal.removeEventListener("abort", abortListener);
    await close();
  }
}

function createPgClient(config: ClientConfig): PostgresClientLike {
  const client = new Client(config);
  return {
    connect: async () => {
      await client.connect();
    },
    query: (sql) => client.query(sql),
    copyToCsv: (copySql) => client.query(copyTo(copySql)),
    end: () => client.end(),
  };
}

async function readBoundedStream(
  stream: Readable,
  maxOutputBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    signal.throwIfAborted();
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.byteLength;
    if (bytes > maxOutputBytes) {
      stream.destroy();
      throw new Error("A ferramenta excedeu o limite de saída.");
    }
    chunks.push(buffer);
  }
  signal.throwIfAborted();
  return Buffer.concat(chunks, bytes).toString("utf8").trim();
}

async function withDeadline<T>(
  request: PostgresQueryRequest,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  request.signal?.throwIfAborted();
  const controller = new AbortController();
  const abortFromCaller = () => {
    controller.abort(request.signal?.reason ?? new Error("A operação foi cancelada."));
  };
  request.signal?.addEventListener("abort", abortFromCaller, { once: true });
  if (request.signal?.aborted) abortFromCaller();
  const timer = setTimeout(() => {
    controller.abort(new Error("A ferramenta excedeu o limite de tempo."));
  }, Math.max(1, request.timeoutMs));
  timer.unref();

  try {
    return await raceWithAbort(operation(controller.signal), controller.signal);
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", abortFromCaller);
  }
}

async function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abortListener: (() => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(signal.reason ?? new Error("A operação foi cancelada."));
    signal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (abortListener) signal.removeEventListener("abort", abortListener);
  }
}

function postgresSslCandidates(
  mode: LocalToolConfigMap["postgres_readonly"]["sslMode"],
): ClientConfig["ssl"][] {
  if (mode === "disable") return [false];
  if (mode === "verify-full") return [{ rejectUnauthorized: true }];
  if (mode === "prefer") return [{ rejectUnauthorized: false }, false];
  return [{ rejectUnauthorized: false }];
}

function isSslUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:server does not support ssl|ssl is not enabled on the server)/i.test(message);
}

function redactPostgresError(error: unknown, password?: string): Error {
  const source = error instanceof Error ? error : new Error("A consulta PostgreSQL falhou de forma segura.");
  let message = source.message;
  if (password) message = message.replaceAll(password, "[REDACTED]");
  message = message.replace(/(password|token|secret|key)\s*[=:]\s*\S+/gi, "$1=[REDACTED]");
  const safe = new Error(message);
  const code = (source as NodeJS.ErrnoException).code;
  if (code) (safe as NodeJS.ErrnoException).code = code;
  return safe;
}
