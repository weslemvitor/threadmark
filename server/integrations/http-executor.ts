import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

import {
  assertUrlAllowed,
  idempotencyKeySchema,
  isPrivateOrReservedIp,
  MAX_RESPONSE_BYTES,
  safeHttpUrlSchema,
  timeoutSchema,
} from "./validation.js";
import type { IntegrationExecutionResult } from "./types.js";

export type IntegrationFetch = typeof globalThis.fetch;
export type IntegrationHostLookup = (
  hostname: string,
) => Promise<readonly { address: string }[]>;

export interface ExternalHttpRequest {
  endpoint: string | URL;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Readonly<Record<string, string>>;
  body: unknown;
  idempotencyKey: string;
  idempotencyHeader?: string | null;
  timeoutMs?: number;
  allowPrivateNetwork?: boolean;
  /** Values that must be removed even when a provider echoes them under an innocent key. */
  secretValues?: readonly string[];
  signal?: AbortSignal;
}

export interface ExternalHttpExecutorOptions {
  fetchImpl?: IntegrationFetch;
  lookup?: IntegrationHostLookup;
  maxResponseBytes?: number;
}

export class IntegrationRequestError extends Error {
  constructor(
    message: string,
    readonly kind: "invalid" | "blocked" | "timeout" | "network" | "response",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "IntegrationRequestError";
  }
}

export async function executeExternalHttp(
  request: ExternalHttpRequest,
  options: ExternalHttpExecutorOptions = {},
): Promise<IntegrationExecutionResult> {
  const url = parseEndpoint(request.endpoint);
  const timeoutMs = timeoutSchema.parse(request.timeoutMs);
  const idempotencyKey = idempotencyKeySchema.parse(request.idempotencyKey);
  const allowPrivateNetwork = request.allowPrivateNetwork === true;
  try {
    await assertResolvedDestinationAllowed(
      url,
      allowPrivateNetwork,
      options.lookup ?? defaultLookup,
    );
  } catch (error) {
    if (error instanceof IntegrationRequestError) throw error;
    throw new IntegrationRequestError(
      "O destino da integração foi bloqueado pela política de rede.",
      "blocked",
      { cause: error },
    );
  }

  const headers = validateResolvedHeaders(request.headers ?? {});
  if (request.idempotencyHeader !== null) {
    const headerName = request.idempotencyHeader ?? "Idempotency-Key";
    if (!isHeaderName(headerName)) {
      throw new IntegrationRequestError("Header de idempotência inválido.", "invalid");
    }
    headers[headerName] = idempotencyKey;
  }
  if (!hasHeader(headers, "content-type")) headers["Content-Type"] = "application/json";

  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(request.signal?.reason);
  if (request.signal?.aborted) onAbort();
  request.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await (options.fetchImpl ?? globalThis.fetch)(url, {
      method: request.method,
      headers,
      body: JSON.stringify(request.body),
      redirect: "error",
      signal: controller.signal,
    });
    const maxBytes = normaliseResponseLimit(options.maxResponseBytes);
    const { value, truncated } = await readBoundedResponse(response, maxBytes);
    return {
      ok: response.ok,
      status: response.status,
      requestId: safeRequestId(response, request.secretValues ?? []),
      output: sanitizeExternalOutput(value, request.secretValues ?? []),
      truncated,
    };
  } catch (error) {
    if (request.signal?.aborted) throw error;
    if (timedOut) {
      throw new IntegrationRequestError(
        `A integração excedeu o limite de ${timeoutMs}ms.`,
        "timeout",
        { cause: error },
      );
    }
    if (error instanceof IntegrationRequestError) throw error;
    throw new IntegrationRequestError(
      "Não foi possível conectar ao app configurado.",
      "network",
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onAbort);
  }
}

export async function assertResolvedDestinationAllowed(
  url: URL,
  allowPrivateNetwork: boolean,
  lookup: IntegrationHostLookup,
): Promise<void> {
  assertUrlAllowed(url, allowPrivateNetwork);
  if (allowPrivateNetwork || isIP(normaliseHostname(url.hostname))) return;

  let addresses: readonly { address: string }[];
  try {
    addresses = await lookup(normaliseHostname(url.hostname));
  } catch (error) {
    throw new IntegrationRequestError(
      "Não foi possível validar o endereço de rede da integração.",
      "network",
      { cause: error },
    );
  }
  if (addresses.length === 0) {
    throw new IntegrationRequestError(
      "O endereço da integração não pôde ser resolvido.",
      "network",
    );
  }
  if (addresses.some(({ address }) => isPrivateOrReservedIp(address))) {
    throw new IntegrationRequestError(
      "O endereço resolvido aponta para uma rede local, privada ou reservada.",
      "blocked",
    );
  }
}

export function sanitizeExternalOutput(
  value: unknown,
  secretValues: readonly string[] = [],
): unknown {
  return sanitizeValue(value, 0, secretValues.filter((secret) => secret.length >= 4));
}

async function defaultLookup(hostname: string): Promise<readonly { address: string }[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

function parseEndpoint(value: string | URL): URL {
  try {
    return safeHttpUrlSchema.parse(value instanceof URL ? value.toString() : value);
  } catch (error) {
    throw new IntegrationRequestError("URL da integração inválida.", "invalid", {
      cause: error,
    });
  }
}

function validateResolvedHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (Object.keys(headers).length > 50) {
    throw new IntegrationRequestError("A integração possui headers demais.", "invalid");
  }
  for (const [name, value] of Object.entries(headers)) {
    if (!isHeaderName(name) || /\r|\n/.test(value) || value.length > 8_192) {
      throw new IntegrationRequestError("Header da integração inválido.", "invalid");
    }
    const lower = name.toLowerCase();
    if (["connection", "content-length", "host", "transfer-encoding"].includes(lower)) {
      throw new IntegrationRequestError("Header controlado pelo Threadmark.", "invalid");
    }
    if (Object.keys(result).some((existing) => existing.toLowerCase() === lower)) {
      throw new IntegrationRequestError("Header duplicado na integração.", "invalid");
    }
    result[name] = value;
  }
  return result;
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
): Promise<{ value: unknown; truncated: boolean }> {
  const length = Number(response.headers.get("content-length"));
  const announcedOverflow = Number.isFinite(length) && length > maxBytes;
  if (!response.body) return { value: null, truncated: announcedOverflow };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = announcedOverflow;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = maxBytes - total;
    if (remaining > 0) {
      chunks.push(value.subarray(0, remaining));
      total += Math.min(value.byteLength, remaining);
    }
    if (value.byteLength > remaining || total >= maxBytes) {
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  if (!body) return { value: null, truncated };
  try {
    return { value: JSON.parse(body) as unknown, truncated };
  } catch {
    return { value: body, truncated };
  }
}

function sanitizeValue(value: unknown, depth: number, secrets: readonly string[]): unknown {
  if (depth > 8) return "[limit]";
  if (typeof value === "string") return redact(value, secrets).slice(0, 8_192);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeValue(item, depth + 1, secrets));
  }
  if (!value || typeof value !== "object") return null;
  const entries = Object.entries(value as Record<string, unknown>).slice(0, 100);
  return Object.fromEntries(
    entries.map(([key, item]) => [
      key.slice(0, 128),
      isSensitiveKey(key) ? "[redacted]" : sanitizeValue(item, depth + 1, secrets),
    ]),
  );
}

function redact(value: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (current, secret) => current.split(secret).join("[redacted]"),
    value,
  );
}

function isSensitiveKey(value: string): boolean {
  return /(?:api[-_]?key|authorization|cookie|credential|password|secret|token)/i.test(value);
}

function safeRequestId(response: Response, secrets: readonly string[]): string | null {
  const value =
    response.headers.get("x-request-id") ??
    response.headers.get("request-id") ??
    response.headers.get("cf-ray");
  return value && /^[\x20-\x7e]{1,200}$/.test(value) ? redact(value, secrets) : null;
}

function normaliseResponseLimit(value: number | undefined): number {
  if (value === undefined) return MAX_RESPONSE_BYTES;
  if (!Number.isInteger(value) || value < 256 || value > MAX_RESPONSE_BYTES) {
    throw new IntegrationRequestError("Limite de resposta inválido.", "invalid");
  }
  return value;
}

function normaliseHostname(value: string): string {
  return value.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

function isHeaderName(value: string): boolean {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value);
}
