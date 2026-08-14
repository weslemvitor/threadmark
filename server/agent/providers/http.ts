import {
  ProviderOutputError,
  ProviderRequestError,
  type AiProviderId,
} from "../provider.js";

export type RemoteProviderId = Exclude<AiProviderId, "codex">;
export type FetchImplementation = typeof globalThis.fetch;

export interface ProviderHttpRequest {
  providerId: RemoteProviderId;
  endpoint: URL;
  headers?: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
  fetchImpl: FetchImplementation;
}

export function resolveEndpoint(
  baseUrl: string,
  resourcePath: string,
): URL {
  const normalisedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const base = new URL(normalisedBase);
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new TypeError("A URL do provedor deve usar http ou https.");
  }
  if (base.username || base.password) {
    throw new TypeError("Credenciais não podem fazer parte da URL do provedor.");
  }
  return new URL(resourcePath.replace(/^\/+/, ""), base);
}

export function requiredSecret(value: string, field = "apiKey"): string {
  const normalised = value.trim();
  if (!normalised) throw new TypeError(`${field} é obrigatório.`);
  return normalised;
}

export function positiveInteger(
  value: number | undefined,
  fallback: number,
  field: string,
): number {
  const candidate = value ?? fallback;
  if (!Number.isInteger(candidate) || candidate <= 0) {
    throw new RangeError(`${field} deve ser um inteiro positivo.`);
  }
  return candidate;
}

export async function postProviderJson(
  request: ProviderHttpRequest,
): Promise<unknown> {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(request.signal?.reason);
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.timeoutMs);

  if (request.signal?.aborted) onAbort();
  request.signal?.addEventListener("abort", onAbort, { once: true });

  let response: Response;
  try {
    response = await request.fetchImpl(request.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...request.headers,
      },
      body: JSON.stringify(request.body),
      signal: controller.signal,
    });
  } catch (error) {
    if (request.signal?.aborted) throw error;
    if (timedOut) {
      throw new ProviderRequestError(
        request.providerId,
        `O provedor excedeu o limite de ${request.timeoutMs}ms.`,
        null,
        null,
        { cause: error },
      );
    }
    throw new ProviderRequestError(
      request.providerId,
      "Não foi possível conectar ao provedor de IA.",
      null,
      null,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onAbort);
  }

  const requestId =
    response.headers.get("x-request-id") ??
    response.headers.get("request-id") ??
    response.headers.get("cf-ray");
  if (!response.ok) {
    // Do not include the response body: providers and proxies may echo secrets.
    void response.body?.cancel().catch(() => undefined);
    throw new ProviderRequestError(
      request.providerId,
      `O provedor respondeu com HTTP ${response.status}.`,
      response.status,
      requestId,
    );
  }

  try {
    return (await response.json()) as unknown;
  } catch (error) {
    throw new ProviderOutputError(
      request.providerId,
      "O provedor devolveu uma resposta HTTP sem JSON válido.",
      { cause: error },
    );
  }
}

export function parseStructuredJsonText(
  providerId: RemoteProviderId,
  value: unknown,
): unknown {
  if (typeof value !== "string" || !value.trim()) {
    throw new ProviderOutputError(
      providerId,
      "O provedor não devolveu conteúdo estruturado.",
    );
  }
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new ProviderOutputError(providerId, undefined, { cause: error });
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
