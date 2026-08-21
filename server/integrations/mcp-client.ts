import {
  Client,
  StreamableHTTPClientTransport,
  type AuthProvider,
  type Tool,
} from "@modelcontextprotocol/client";

import {
  assertResolvedDestinationAllowed,
  sanitizeExternalOutput,
  type IntegrationFetch,
  type IntegrationHostLookup,
} from "./http-executor.js";
import { safeHttpUrlSchema } from "./validation.js";

const MCP_TIMEOUT_MS = 30_000;
const MAX_MCP_TOOLS = 200;

export type McpToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

export type McpDiscoveredTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: McpToolAnnotations;
};

export type McpToolCallResult = {
  isError: boolean;
  content: unknown;
  structuredContent: unknown;
};

export type McpRemoteConnection = {
  endpoint: string;
  bearerToken?: string | null;
  allowPrivateNetwork: boolean;
};

export type McpRemoteClientOptions = {
  fetchImpl?: IntegrationFetch;
  lookup?: IntegrationHostLookup;
};

/**
 * Small, short-lived MCP client. Every operation performs a fresh handshake so
 * no remote session or credential remains resident after the request.
 */
export class McpRemoteClient {
  constructor(private readonly options: McpRemoteClientOptions = {}) {}

  async listTools(connection: McpRemoteConnection): Promise<McpDiscoveredTool[]> {
    return this.withClient(connection, async (client) => {
      const result = await client.listTools(undefined, { timeout: MCP_TIMEOUT_MS });
      if (result.tools.length > MAX_MCP_TOOLS) {
        throw new Error(`O servidor MCP expôs mais de ${MAX_MCP_TOOLS} ferramentas.`);
      }
      return result.tools.map(normalizeTool);
    });
  }

  async callTool(
    connection: McpRemoteConnection,
    name: string,
    argumentsValue: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpToolCallResult> {
    return this.withClient(connection, async (client) => {
      const result = await client.callTool(
        { name, arguments: argumentsValue },
        { timeout: MCP_TIMEOUT_MS, ...(signal ? { signal } : {}) },
      );
      return {
        isError: result.isError === true,
        content: sanitizeExternalOutput(result.content, tokenValues(connection)),
        structuredContent: sanitizeExternalOutput(
          result.structuredContent ?? null,
          tokenValues(connection),
        ),
      };
    });
  }

  private async withClient<T>(
    connection: McpRemoteConnection,
    execute: (client: Client) => Promise<T>,
  ): Promise<T> {
    const endpoint = safeHttpUrlSchema.parse(connection.endpoint);
    await assertResolvedDestinationAllowed(
      endpoint,
      connection.allowPrivateNetwork,
      this.options.lookup ?? defaultLookup,
    );
    const token = bareToken(connection.bearerToken);
    const authProvider: AuthProvider | undefined = token
      ? { token: async () => token }
      : undefined;
    const transport = new StreamableHTTPClientTransport(endpoint, {
      ...(authProvider ? { authProvider } : {}),
      fetch: safeFetch(
        connection.allowPrivateNetwork,
        this.options.fetchImpl ?? globalThis.fetch,
        this.options.lookup ?? defaultLookup,
      ),
      onInsufficientScope: "throw",
    });
    const client = new Client(
      { name: "threadmark", version: "0.2.0" },
      { enforceStrictCapabilities: true, listMaxPages: 20 },
    );
    try {
      await client.connect(transport);
      return await execute(client);
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}

function normalizeTool(tool: Tool): McpDiscoveredTool {
  const annotations = tool.annotations ?? {};
  return {
    name: tool.name.slice(0, 200),
    title: (tool.title || annotations.title || tool.name).slice(0, 200),
    description: (tool.description ?? "Ferramenta MCP sem descrição.").slice(0, 2_000),
    inputSchema: normalizeSchema(tool.inputSchema),
    annotations: {
      readOnlyHint: annotations.readOnlyHint === true,
      destructiveHint: annotations.destructiveHint !== false,
      idempotentHint: annotations.idempotentHint === true,
      openWorldHint: annotations.openWorldHint !== false,
    },
  };
}

function normalizeSchema(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { type: "object" };
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > 64 * 1_024) {
    throw new Error("O schema de uma ferramenta MCP excede 64 KB.");
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

function safeFetch(
  allowPrivateNetwork: boolean,
  fetchImpl: IntegrationFetch,
  lookup: IntegrationHostLookup,
): IntegrationFetch {
  return async (input, init) => {
    const url = safeHttpUrlSchema.parse(
      typeof input === "string" || input instanceof URL ? String(input) : input.url,
    );
    await assertResolvedDestinationAllowed(url, allowPrivateNetwork, lookup);
    const signals = [AbortSignal.timeout(MCP_TIMEOUT_MS)];
    if (init?.signal) signals.push(init.signal);
    const response = await fetchImpl(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.any(signals),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Redirecionamentos do servidor MCP são bloqueados por segurança.");
    }
    return response;
  };
}

async function defaultLookup(hostname: string): Promise<readonly { address: string }[]> {
  const { lookup } = await import("node:dns/promises");
  return lookup(hostname, { all: true, verbatim: true });
}

function bareToken(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  return normalized.replace(/^Bearer\s+/i, "");
}

function tokenValues(connection: McpRemoteConnection): string[] {
  const value = bareToken(connection.bearerToken);
  return value ? [value, `Bearer ${value}`] : [];
}
