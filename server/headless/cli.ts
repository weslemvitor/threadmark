import { open } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import { z } from "zod";

import {
  CATEGORY_FACETS,
  PRODUCT_FORWARDING_KINDS,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
} from "../../shared/contracts.js";
import { triageAnalysisSchema } from "../agent/validation.js";
import { channelWriteSchema } from "../channels/normalize.js";
import type { ChannelConnection } from "../../shared/channels.js";

export const HEADLESS_SCHEMA_VERSION = "threadmark.headless.v1" as const;

const HEADLESS_COMMANDS = new Set([
  "agent",
  "capabilities",
  "categories",
  "channels",
  "clients",
  "conversations",
  "dashboard",
  "operators",
  "tickets",
  "triage",
]);

export const HEADLESS_MAX_INPUT_BYTES = 64 * 1024;
const MAX_LIMIT = 200;

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface HeadlessRequest {
  method?: HttpMethod;
  body?: unknown;
  actorId?: string;
  clientId?: AgentClientId;
}

export interface HeadlessTransport {
  request<T>(route: string, input?: HeadlessRequest): Promise<T>;
}

export interface HeadlessCommandOptions {
  invocationCwd?: string;
}

export interface HeadlessSuccess<T = unknown> {
  schemaVersion: typeof HEADLESS_SCHEMA_VERSION;
  ok: true;
  command: string;
  data: T;
  meta: {
    readOnly: boolean;
    actorId: string | null;
    clientId: AgentClientId | null;
  };
}

export interface HeadlessFailure {
  schemaVersion: typeof HEADLESS_SCHEMA_VERSION;
  ok: false;
  command: string;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type HeadlessResult<T = unknown> =
  | HeadlessSuccess<T>
  | HeadlessFailure;

export type AgentClientId = "threadmark-cli";

interface ParsedArguments {
  positionals: string[];
  values: Map<string, string[]>;
  flags: Set<string>;
}

interface CommandIdentity {
  actorId: string;
  clientId: AgentClientId;
}

const manualTicketSchema = z
  .object({
    clientRequestId: z.string().trim().min(1).max(200),
    groupId: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(20_000),
    priority: z.enum(TICKET_PRIORITIES).optional(),
  })
  .strict();

const conversationTicketSchema = z
  .object({
    clientRequestId: z.string().trim().min(1).max(200),
    messageIds: z.array(z.string().trim().min(1).max(200)).min(1).max(500),
    title: z.string().trim().min(1).max(200).optional(),
    summary: z.string().trim().min(1).max(20_000).optional(),
    clientId: z.string().trim().min(1).max(200).nullable().optional(),
    affectedStoreId: z.string().trim().min(1).max(200).nullable().optional(),
    priority: z.enum(TICKET_PRIORITIES).optional(),
  })
  .strict();

const conversationAttachSchema = z
  .object({
    clientRequestId: z.string().trim().min(1).max(200),
    messageIds: z.array(z.string().trim().min(1).max(200)).min(1).max(500),
    ticketId: z.string().trim().min(1).max(200),
    reason: z.string().trim().max(1_000).nullable().optional(),
  })
  .strict();

const conversationBatchSchema = z
  .object({
    clientRequestId: z.string().trim().min(1).max(200),
    messageIds: z.array(z.string().trim().min(1).max(200)).min(1).max(500),
    reason: z.string().trim().max(1_000).nullable().optional(),
  })
  .strict();

const ticketMetadataSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(20_000),
    priority: z.enum(TICKET_PRIORITIES),
    requesterId: z.string().trim().min(1).max(200).nullable(),
  })
  .strict();

const ticketAssigneeSchema = z
  .object({ assigneeId: z.string().trim().min(1).max(200).nullable() })
  .strict();

const ticketStatusSchema = z
  .object({
    status: z.enum(TICKET_STATUSES),
    reason: z.string().trim().min(1).max(1_000).optional(),
    resolution: z
      .object({
        summary: z.string().trim().min(1).max(20_000),
        rootCause: z.string().trim().min(1).max(20_000).optional(),
        outcome: z.string().trim().min(1).max(20_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const ticketCategorySchema = z
  .object({ categoryId: z.string().trim().min(1).max(200) })
  .strict();

const ticketNoteSchema = z
  .object({
    body: z.string().trim().min(1).max(4_000),
    clientNoteId: z.string().trim().min(1).max(200),
  })
  .strict();

const externalTicketMessagesSchema = z
  .object({
    sourceType: z.string().trim().min(1).max(100),
    sourceConversationId: z.string().trim().min(1).max(200),
    messages: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(200),
            author: z.string().trim().min(1).max(200),
            authorRole: z.enum(["customer", "support"]),
            body: z.string().trim().min(1).max(20_000),
            occurredAt: z.string().datetime({ offset: true }),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

const ticketProductForwardingSchema = z
  .object({
    kind: z.enum(PRODUCT_FORWARDING_KINDS),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(20_000),
    externalReference: z.string().trim().min(1).max(1_000).nullable().optional(),
    resolveTicket: z.boolean().optional(),
  })
  .strict();

const categoryCreateSchema = z
  .object({
    facet: z.enum(CATEGORY_FACETS),
    label: z.string().trim().min(1).max(120),
    color: z.string().trim().min(4).max(40).nullable().optional(),
  })
  .strict();

const categoryDeleteSchema = z
  .object({
    replacementCategoryId: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .strict();

const externalTriageLeaseSchema = z
  .object({
    leaseSeconds: z.number().int().min(30).max(15 * 60),
  })
  .strict();

export class HeadlessCliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HeadlessCliError";
  }
}

export class HeadlessApiError extends HeadlessCliError {
  constructor(
    readonly status: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(code, message, details);
    this.name = "HeadlessApiError";
  }
}

export function isHeadlessCommand(command: string): boolean {
  return HEADLESS_COMMANDS.has(command.toLowerCase());
}

export function createHeadlessHttpTransport(input: {
  apiUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  unavailableMessage?: string;
}): HeadlessTransport {
  const request = input.fetch ?? fetch;
  return {
    async request<T>(route: string, options: HeadlessRequest = {}): Promise<T> {
      const headers = new Headers({ authorization: `Bearer ${input.token}` });
      if (options.body !== undefined) {
        headers.set("content-type", "application/json");
      }
      if (options.actorId) headers.set("x-threadmark-actor-id", options.actorId);
      if (options.clientId) headers.set("x-threadmark-agent-client", options.clientId);
      let response: Response;
      try {
        response = await request(new URL(route, input.apiUrl), {
          method: options.method ?? "GET",
          redirect: "error",
          headers,
          body:
            options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: input.timeoutMs ? AbortSignal.timeout(input.timeoutMs) : undefined,
        });
      } catch {
        throw new HeadlessCliError(
          "api_unavailable",
          input.unavailableMessage
            ?? "A API local está indisponível. Execute `threadmark on` primeiro.",
        );
      }
      let payload: T
        | { error?: { code?: string; message?: string; details?: unknown }; message?: string }
        | null;
      try {
        payload = await response.json() as typeof payload;
      } catch {
        if (response.ok) {
          throw new HeadlessCliError(
            "api_response_invalid",
            "A API não retornou uma resposta JSON válida.",
          );
        }
        payload = null;
      }
      if (!response.ok) {
        const error = payload && typeof payload === "object" && "error" in payload
          ? payload.error
          : null;
        throw new HeadlessApiError(
          response.status,
          error?.code ?? `http_${response.status}`,
          error?.message ??
            (payload && typeof payload === "object" && "message" in payload
              ? payload.message ?? `A API respondeu HTTP ${response.status}.`
              : `A API respondeu HTTP ${response.status}.`),
          error?.details,
        );
      }
      if (payload === null) {
        throw new HeadlessCliError(
          "api_response_invalid",
          "A API não retornou uma resposta JSON válida.",
        );
      }
      return payload as T;
    },
  };
}

export async function executeHeadlessCommand(
  command: string,
  args: string[],
  transport: HeadlessTransport,
  options: HeadlessCommandOptions = {},
): Promise<HeadlessResult> {
  const commandName = [command, ...args.filter((value) => !value.startsWith("--"))]
    .slice(0, 2)
    .join(".");
  try {
    const parsed = parseArguments(args);
    const result = await execute(command.toLowerCase(), parsed, transport, options);
    return {
      schemaVersion: HEADLESS_SCHEMA_VERSION,
      ok: true,
      command: result.command,
      data: result.data,
      meta: {
        readOnly: result.readOnly,
        actorId: result.identity?.actorId ?? null,
        clientId: result.identity?.clientId ?? null,
      },
    };
  } catch (error) {
    const normalized = normalizeError(error);
    return {
      schemaVersion: HEADLESS_SCHEMA_VERSION,
      ok: false,
      command: commandName,
      error: normalized,
    };
  }
}

async function execute(
  command: string,
  args: ParsedArguments,
  transport: HeadlessTransport,
  options: HeadlessCommandOptions,
): Promise<{
  command: string;
  data: unknown;
  readOnly: boolean;
  identity?: CommandIdentity;
}> {
  if (command === "capabilities") {
    assertNoPositionals(args, "threadmark capabilities [--json]");
    return {
      command: "capabilities",
      data: headlessCapabilities(),
      readOnly: true,
    };
  }
  if (command === "operators") {
    assertAction(args, "list", "threadmark operators list");
    return {
      command: "operators.list",
      data: await transport.request("/api/ticket-assignees"),
      readOnly: true,
    };
  }
  if (command === "clients") {
    assertAction(args, "list", "threadmark clients list");
    return {
      command: "clients.list",
      data: await transport.request("/api/clients"),
      readOnly: true,
    };
  }
  if (command === "categories") {
    return executeCategories(args, transport, options);
  }
  if (command === "channels") {
    return executeChannels(args, transport, options);
  }
  if (command === "agent") {
    return executeAgent(args, transport, options);
  }
  if (command === "conversations") {
    return executeConversations(args, transport);
  }
  if (command === "dashboard") {
    return executeDashboard(args, transport);
  }
  if (command === "tickets") {
    return executeTickets(args, transport, options);
  }
  if (command === "triage") {
    return executeTriage(args, transport, options);
  }
  throw new HeadlessCliError("unknown_command", `Comando desconhecido: ${command}.`);
}

async function executeAgent(
  args: ParsedArguments,
  transport: HeadlessTransport,
  options: HeadlessCommandOptions,
) {
  const action = args.positionals[0] ?? "triage-status";
  if (action === "triage-status") {
    assertAction(args, "triage-status", "threadmark agent triage-status");
    return {
      command: "agent.triage-status",
      data: await transport.request("/api/agent/triage/jobs"),
      readOnly: true,
    };
  }
  if (action === "triage-claim") {
    const identity = await requireMutationIdentity(args, transport);
    const body = externalTriageLeaseSchema.parse({
      leaseSeconds: parseIntegerOption(args, "lease-seconds", 10 * 60),
    });
    return writeResult(
      "agent.triage-claim",
      await transport.request("/api/agent/triage/jobs/claim", {
        method: "POST",
        body,
        ...identity,
      }),
      identity,
    );
  }
  const jobId = requirePositional(args, 1, "ID do job de triagem");
  if (action === "triage-heartbeat") {
    const identity = await requireMutationIdentity(args, transport);
    const body = externalTriageLeaseSchema.parse({
      leaseSeconds: parseIntegerOption(args, "lease-seconds", 10 * 60),
    });
    return writeResult(
      "agent.triage-heartbeat",
      await transport.request(
        `/api/agent/triage/jobs/${encodeURIComponent(jobId)}/heartbeat`,
        { method: "POST", body, ...identity },
      ),
      identity,
    );
  }
  if (action === "triage-complete") {
    const identity = await requireMutationIdentity(args, transport);
    const analysis = triageAnalysisSchema.parse(await readInput(args, options));
    return writeResult(
      "agent.triage-complete",
      await transport.request(
        `/api/agent/triage/jobs/${encodeURIComponent(jobId)}/complete`,
        {
          method: "POST",
          body: {
            analysis,
            ...(option(args, "model") ? { model: option(args, "model") } : {}),
          },
          ...identity,
        },
      ),
      identity,
    );
  }
  throw usageError(
    "Use: threadmark agent triage-status|triage-claim|triage-heartbeat|triage-complete.",
  );
}

async function executeCategories(
  args: ParsedArguments,
  transport: HeadlessTransport,
  options: HeadlessCommandOptions,
) {
  const action = args.positionals[0] ?? "list";
  if (action === "list") {
    const params = new URLSearchParams();
    appendIfPresent(params, "q", option(args, "query"));
    appendIfPresent(params, "facet", option(args, "facet"));
    appendIfPresent(params, "usage", option(args, "usage"));
    return {
      command: "categories.list",
      data: await transport.request(withQuery("/api/categories", params)),
      readOnly: true,
    };
  }
  if (action === "create") {
    const identity = await requireMutationIdentity(args, transport);
    const body = categoryCreateSchema.parse(await readInput(args, options));
    return writeResult(
      "categories.create",
      await transport.request("/api/categories", {
        method: "POST",
        body,
        ...identity,
      }),
      identity,
    );
  }
  if (action === "delete") {
    const categoryId = requirePositional(args, 1, "ID da categoria");
    const identity = await requireMutationIdentity(args, transport);
    const body = categoryDeleteSchema.parse(await readInput(args, options, {}));
    return writeResult(
      "categories.delete",
      await transport.request(`/api/categories/${encodeURIComponent(categoryId)}`, {
        method: "DELETE",
        body,
        ...identity,
      }),
      identity,
    );
  }
  throw usageError("Use: threadmark categories list|create|delete.");
}

async function executeChannels(
  args: ParsedArguments,
  transport: HeadlessTransport,
  options: HeadlessCommandOptions,
) {
  const action = args.positionals[0] ?? "list";
  const usage = "Use: threadmark channels list|get|create|update|test|activate|pause.";
  if (action === "list") {
    assertAction(args, "list", "threadmark channels list [--json]");
    return {command: "channels.list", data: await transport.request("/api/channels"), readOnly: true};
  }
  if (action === "get") {
    if (args.positionals.length > 2) throw usageError(usage);
    const channel = await resolveChannel(requirePositional(args, 1, "ID ou nome do canal"), transport);
    return {command: "channels.get", data: channel, readOnly: true};
  }
  if (!["create", "update", "test", "activate", "pause"].includes(action)) throw usageError(usage);
  if (args.positionals.length > (action === "create" ? 1 : 2)) throw usageError(usage);
  const reference = action === "create" ? null : requirePositional(args, 1, "ID ou nome do canal");
  const identity = await requireMutationIdentity(args, transport);
  if (action === "create") {
    const body = channelWriteSchema.parse(await readInput(args, options));
    // The caller already owns this credential, so it never needs to pass through CLI output.
    if (body.config.authentication === "bearer" && !body.bearerToken) {
      throw usageError("Informe bearerToken no JSON privado de criação (mínimo de 32 caracteres). A CLI não exibe segredos.");
    }
    const created = await transport.request<{connection: ChannelConnection}>("/api/channels", {
      method: "POST", body, ...identity,
    });
    return writeResult("channels.create", created.connection, identity);
  }
  const channel = await resolveChannel(reference!, transport);
  const base = `/api/channels/${encodeURIComponent(channel.id)}`;
  if (action === "update") {
    const body = channelWriteSchema.parse(await readInput(args, options));
    return writeResult("channels.update", await transport.request(base, {method: "PATCH", body, ...identity}), identity);
  }
  if (action === "test") {
    const body = await readInput(args, options);
    return writeResult("channels.test", await transport.request(`${base}/preview`, {method: "POST", body, ...identity}), identity);
  }
  return writeResult(`channels.${action}`, await transport.request(`${base}/status`, {
    method: "PATCH", body: {status: action === "activate" ? "active" : "paused"}, ...identity,
  }), identity);
}

async function resolveChannel(reference: string, transport: HeadlessTransport): Promise<ChannelConnection> {
  const {items} = await transport.request<{items: ChannelConnection[]}>("/api/channels");
  const exact = items.find(channel => channel.id === reference.trim());
  if (exact) return exact;
  const normalized = reference.trim().toLocaleLowerCase("pt-BR");
  const matches = items.filter(channel => channel.name.toLocaleLowerCase("pt-BR") === normalized);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new HeadlessCliError("channel_ambiguous", "Mais de um canal corresponde ao nome. Use o ID exato.",
      matches.map(channel => ({id: channel.id, name: channel.name})));
  }
  throw new HeadlessCliError("channel_not_found", "Canal não encontrado. Consulte `threadmark channels list --json`.");
}

async function channelFilter(args: ParsedArguments, transport: HeadlessTransport): Promise<string | undefined> {
  const reference = option(args, "channel")?.trim();
  if (args.flags.has("channel") || (args.values.has("channel") && !reference) || optionsFor(args, "channel").length > 1) {
    throw usageError("Use --channel uma vez, com ID, nome, whatsapp ou all.");
  }
  if (!reference || reference === "all") return undefined;
  if (reference === "whatsapp") return "whatsapp";
  return (await resolveChannel(reference, transport)).id;
}

async function executeConversations(
  args: ParsedArguments,
  transport: HeadlessTransport,
) {
  const action = args.positionals[0] ?? "list";
  if (action === "list") {
    const params = new URLSearchParams();
    appendIfPresent(params, "q", option(args, "query"));
    appendIfPresent(params, "attention", option(args, "attention"));
    appendIfPresent(params, "scope", option(args, "scope"));
    appendIfPresent(params, "connectionId", await channelFilter(args, transport));
    appendIfPresent(params, "cursor", option(args, "cursor"));
    params.set("limit", String(parseLimit(option(args, "limit"), 20)));
    return {
      command: "conversations.list",
      data: await transport.request(withQuery("/api/conversations", params)),
      readOnly: true,
    };
  }
  const conversationId = requirePositional(args, 1, "ID da conversa");
  if (action === "messages" || action === "get") {
    const params = new URLSearchParams();
    params.set("limit", String(parseLimit(option(args, "limit"), action === "get" ? 50 : 100)));
    appendIfPresent(params, "before", option(args, "before"));
    return {
      command: action === "get" ? "conversations.get" : "conversations.messages",
      data: await transport.request(
        withQuery(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, params),
      ),
      readOnly: true,
    };
  }
  if (action === "tickets") {
    const params = new URLSearchParams();
    params.set("limit", String(parseLimit(option(args, "limit"), 50)));
    appendIfPresent(params, "cursor", option(args, "cursor"));
    appendIfPresent(params, "q", option(args, "query"));
    for (const status of optionsFor(args, "status")) params.append("status", status);
    return {
      command: "conversations.tickets",
      data: await transport.request(
        withQuery(`/api/conversations/${encodeURIComponent(conversationId)}/tickets`, params),
      ),
      readOnly: true,
    };
  }
  throw usageError("Use: threadmark conversations list|get|messages|tickets.");
}

async function executeDashboard(args: ParsedArguments, transport: HeadlessTransport) {
  assertAction(args, "show", "threadmark dashboard show [--from AAAA-MM-DD --to AAAA-MM-DD]");
  const params = new URLSearchParams();
  appendIfPresent(params, "from", option(args, "from"));
  appendIfPresent(params, "to", option(args, "to"));
  appendIfPresent(params, "assigneeId", option(args, "assignee"));
  return {
    command: "dashboard.show",
    data: await transport.request(withQuery("/api/dashboard", params)),
    readOnly: true,
  };
}

async function executeTickets(
  args: ParsedArguments,
  transport: HeadlessTransport,
  options: HeadlessCommandOptions,
) {
  const action = args.positionals[0] ?? "list";
  if (action === "list") {
    const params = new URLSearchParams();
    appendIfPresent(params, "q", option(args, "query"));
    appendIfPresent(params, "clientId", option(args, "client"));
    appendIfPresent(params, "connectionId", await channelFilter(args, transport));
    appendIfPresent(params, "order", option(args, "order"));
    for (const status of optionsFor(args, "status")) params.append("status", status);
    if (flag(args, "include-archived")) params.set("includeArchived", "true");
    params.set("limit", String(parseLimit(option(args, "limit"), 25)));
    appendIfPresent(params, "offset", option(args, "offset"));
    return {
      command: "tickets.list",
      data: await transport.request(withQuery("/api/tickets", params)),
      readOnly: true,
    };
  }
  if (action === "create") {
    const identity = await requireMutationIdentity(args, transport);
    const body = manualTicketSchema.parse(await readInput(args, options));
    return writeResult(
      "tickets.create",
      await transport.request("/api/tickets", {
        method: "POST",
        body,
        ...identity,
      }),
      identity,
    );
  }

  const reference = requirePositional(args, 1, "ID ou número do ticket");
  if (action === "get") {
    const ticketId = await resolveTicketId(reference, transport);
    return {
      command: "tickets.get",
      data: await transport.request(`/api/tickets/${encodeURIComponent(ticketId)}`),
      readOnly: true,
    };
  }

  const identity = await requireMutationIdentity(args, transport);
  const ticketId = await resolveTicketId(reference, transport);
  if (action === "update") {
    const body = ticketMetadataSchema.parse(await readInput(args, options));
    return writeResult(
      "tickets.update",
      await transport.request(`/api/tickets/${encodeURIComponent(ticketId)}`, {
        method: "PATCH",
        body,
        ...identity,
      }),
      identity,
    );
  }
  if (action === "assign") {
    const body = ticketAssigneeSchema.parse(await readInput(args, options));
    return writeResult(
      "tickets.assign",
      await transport.request(`/api/tickets/${encodeURIComponent(ticketId)}/assignee`, {
        method: "PATCH",
        body,
        ...identity,
      }),
      identity,
    );
  }
  if (action === "status") {
    const body = ticketStatusSchema.parse(await readInput(args, options));
    return writeResult(
      "tickets.status",
      await transport.request(`/api/tickets/${encodeURIComponent(ticketId)}/status`, {
        method: "PATCH",
        body,
        ...identity,
      }),
      identity,
    );
  }
  if (action === "category-add") {
    const body = ticketCategorySchema.parse(await readInput(args, options));
    return writeResult(
      "tickets.category-add",
      await transport.request(`/api/tickets/${encodeURIComponent(ticketId)}/categories`, {
        method: "POST",
        body,
        ...identity,
      }),
      identity,
    );
  }
  if (action === "category-remove") {
    const categoryId = requirePositional(args, 2, "ID da categoria");
    return writeResult(
      "tickets.category-remove",
      await transport.request(
        `/api/tickets/${encodeURIComponent(ticketId)}/categories/${encodeURIComponent(categoryId)}`,
        { method: "DELETE", ...identity },
      ),
      identity,
    );
  }
  if (action === "note-add") {
    const body = ticketNoteSchema.parse(await readInput(args, options));
    return writeResult(
      "tickets.note-add",
      await transport.request(`/api/tickets/${encodeURIComponent(ticketId)}/notes`, {
        method: "POST",
        body,
        ...identity,
      }),
      identity,
    );
  }
  if (action === "note-delete") {
    const noteId = requirePositional(args, 2, "ID da nota interna");
    return writeResult(
      "tickets.note-delete",
      await transport.request(
        `/api/tickets/${encodeURIComponent(ticketId)}/notes/${encodeURIComponent(noteId)}`,
        { method: "DELETE", ...identity },
      ),
      identity,
    );
  }
  if (action === "external-messages-import") {
    const body = externalTicketMessagesSchema.parse(await readInput(args, options));
    return writeResult(
      "tickets.external-messages-import",
      await transport.request(`/api/tickets/${encodeURIComponent(ticketId)}/external-messages`, {
        method: "POST",
        body,
        ...identity,
      }),
      identity,
    );
  }
  if (action === "product-forwarding") {
    const body = ticketProductForwardingSchema.parse(await readInput(args, options));
    return writeResult(
      "tickets.product-forwarding",
      await transport.request(`/api/tickets/${encodeURIComponent(ticketId)}/product-forwarding`, {
        method: "PUT",
        body,
        ...identity,
      }),
      identity,
    );
  }
  throw usageError(
    "Use: threadmark tickets list|get|create|update|assign|status|category-add|category-remove|note-add|note-delete|external-messages-import|product-forwarding.",
  );
}

async function executeTriage(
  args: ParsedArguments,
  transport: HeadlessTransport,
  options: HeadlessCommandOptions,
) {
  const action = args.positionals[0] ?? "blocks";
  const conversationId = requirePositional(args, 1, "ID da conversa");
  if (action === "blocks") {
    const includeResolved = flag(args, "include-resolved") ? "?includeResolved=true" : "";
    return {
      command: "triage.blocks",
      data: await transport.request(
        `/api/conversations/${encodeURIComponent(conversationId)}/triage-blocks${includeResolved}`,
      ),
      readOnly: true,
    };
  }

  const identity = await requireMutationIdentity(args, transport);
  const base = `/api/conversations/${encodeURIComponent(conversationId)}/triage`;
  if (action === "analyze") {
    return writeResult(
      "triage.analyze",
      await transport.request(`${base}/analyze`, { method: "POST", ...identity }),
      identity,
    );
  }
  if (action === "create") {
    const body = conversationTicketSchema.parse(await readInput(args, options));
    return writeResult(
      "triage.create",
      await transport.request(`${base}/tickets`, {
        method: "POST",
        body,
        ...identity,
      }),
      identity,
    );
  }
  if (action === "attach") {
    const body = conversationAttachSchema.parse(await readInput(args, options));
    return writeResult(
      "triage.attach",
      await transport.request(`${base}/attach`, {
        method: "POST",
        body,
        ...identity,
      }),
      identity,
    );
  }
  if (["ignore", "context", "restore"].includes(action)) {
    const body = conversationBatchSchema.parse(await readInput(args, options));
    return writeResult(
      `triage.${action}`,
      await transport.request(`${base}/${action}`, {
        method: "POST",
        body,
        ...identity,
      }),
      identity,
    );
  }
  throw usageError("Use: threadmark triage blocks|analyze|create|attach|ignore|context|restore.");
}

function writeResult(
  command: string,
  data: unknown,
  identity: CommandIdentity,
) {
  return { command, data, readOnly: false, identity };
}

async function requireMutationIdentity(
  args: ParsedArguments,
  transport: HeadlessTransport,
): Promise<CommandIdentity> {
  if (!flag(args, "apply")) {
    throw new HeadlessCliError(
      "confirmation_required",
      "Esta operação altera o Threadmark. Repita com --apply somente após a autorização do usuário.",
    );
  }
  const actorReference = option(args, "as") ?? process.env.THREADMARK_ACTOR_ID;
  if (!actorReference?.trim()) {
    throw new HeadlessCliError(
      "actor_required",
      "Informe --as <id-ou-nome> para registrar quem autorizou a alteração.",
    );
  }
  const actorId = await resolveActorId(actorReference, transport);
  return {
    actorId,
    clientId: "threadmark-cli",
  };
}

async function resolveActorId(
  reference: string,
  transport: HeadlessTransport,
): Promise<string> {
  const operators = await transport.request<
    Array<{ id: string; displayName: string; role: string }>
  >("/api/ticket-assignees");
  const normalized = reference.trim().toLocaleLowerCase("pt-BR");
  const matches = operators.filter(
    (operator) =>
      operator.id.toLocaleLowerCase("pt-BR") === normalized ||
      operator.displayName.toLocaleLowerCase("pt-BR") === normalized,
  );
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1) {
    throw new HeadlessCliError(
      "actor_ambiguous",
      `Mais de um operador corresponde a “${reference}”. Use o ID exato.`,
      matches.map((operator) => ({ id: operator.id, displayName: operator.displayName })),
    );
  }
  throw new HeadlessCliError(
    "actor_not_found",
    `Operador ativo “${reference}” não encontrado. Consulte \`threadmark operators list --json\`.`,
  );
}

async function resolveTicketId(
  reference: string,
  transport: HeadlessTransport,
): Promise<string> {
  const trimmed = reference.trim();
  const number = trimmed.match(/^#?(\d+)$/)?.[1];
  if (!number) return trimmed;
  const ticket = await transport.request<{ id: string; number: number }>(
    `/api/tickets/by-number/${number}`,
  );
  if (ticket.number !== Number(number)) {
    throw new HeadlessCliError("ticket_not_found", `Ticket #${number} não encontrado.`);
  }
  return ticket.id;
}

async function readInput(
  args: ParsedArguments,
  options: HeadlessCommandOptions,
  fallback?: unknown,
): Promise<unknown> {
  const inputPath = option(args, "input");
  if (!inputPath) {
    if (fallback !== undefined) return fallback;
    throw usageError("Informe um JSON com --input <arquivo> ou --input - para stdin.");
  }
  const content = inputPath === "-"
    ? await readHeadlessStandardInput()
    : await readBoundedInputFile(
        path.resolve(options.invocationCwd ?? process.cwd(), inputPath),
      );
  if (Buffer.byteLength(content, "utf8") > HEADLESS_MAX_INPUT_BYTES) {
    throw new HeadlessCliError(
      "input_too_large",
      `O JSON de entrada deve ter no máximo ${HEADLESS_MAX_INPUT_BYTES} bytes.`,
    );
  }
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new HeadlessCliError("invalid_json", "O arquivo de entrada não contém JSON válido.");
  }
}

async function readBoundedInputFile(filePath: string): Promise<string> {
  const handle = await open(filePath, "r");
  const buffer = Buffer.allocUnsafe(HEADLESS_MAX_INPUT_BYTES + 1);
  let offset = 0;
  try {
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, null);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
  } finally {
    await handle.close();
  }
  if (offset > HEADLESS_MAX_INPUT_BYTES) {
    throw new HeadlessCliError(
      "input_too_large",
      `O JSON de entrada deve ter no máximo ${HEADLESS_MAX_INPUT_BYTES} bytes.`,
    );
  }
  return buffer.subarray(0, offset).toString("utf8");
}

export async function readHeadlessStandardInput(
  input: AsyncIterable<Buffer | string> = process.stdin,
): Promise<string> {
  let content = "";
  let bytes = 0;
  const decoder = new StringDecoder("utf8");
  for await (const chunk of input) {
    const encoded = Buffer.from(chunk);
    bytes += encoded.byteLength;
    if (bytes > HEADLESS_MAX_INPUT_BYTES) {
      throw new HeadlessCliError(
        "input_too_large",
        `O JSON de entrada deve ter no máximo ${HEADLESS_MAX_INPUT_BYTES} bytes.`,
      );
    }
    content += decoder.write(encoded);
  }
  return `${content}${decoder.end()}`;
}

function parseArguments(args: string[]): ParsedArguments {
  const positionals: string[] = [];
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index]!;
    if (!current.startsWith("--")) {
      positionals.push(current);
      continue;
    }
    const optionText = current.slice(2);
    const separatorIndex = optionText.indexOf("=");
    const rawName = separatorIndex >= 0
      ? optionText.slice(0, separatorIndex)
      : optionText;
    const inlineValue = separatorIndex >= 0
      ? optionText.slice(separatorIndex + 1)
      : undefined;
    const name = rawName.trim();
    if (!name) throw usageError("Opção inválida.");
    if (inlineValue !== undefined) {
      addOption(values, name, inlineValue);
      continue;
    }
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("--") && !isBooleanFlag(name)) {
      addOption(values, name, next);
      index += 1;
      continue;
    }
    flags.add(name);
  }
  return { positionals, values, flags };
}

function isBooleanFlag(name: string): boolean {
  return new Set(["apply", "include-archived", "include-resolved", "json"]).has(name);
}

function addOption(values: Map<string, string[]>, name: string, value: string) {
  values.set(name, [...(values.get(name) ?? []), value]);
}

function option(args: ParsedArguments, name: string): string | undefined {
  const values = args.values.get(name);
  return values?.[values.length - 1];
}

function optionsFor(args: ParsedArguments, name: string): string[] {
  return args.values.get(name) ?? [];
}

function flag(args: ParsedArguments, name: string): boolean {
  return args.flags.has(name);
}

function requirePositional(
  args: ParsedArguments,
  index: number,
  label: string,
): string {
  const value = args.positionals[index]?.trim();
  if (!value) throw usageError(`${label} não informado.`);
  return value;
}

function assertAction(args: ParsedArguments, action: string, usage: string): void {
  const received = args.positionals[0] ?? action;
  if (received !== action || args.positionals.length > 1) {
    throw usageError(`Use: ${usage}.`);
  }
}

function assertNoPositionals(args: ParsedArguments, usage: string): void {
  if (args.positionals.length) throw usageError(`Use: ${usage}.`);
}

function parseLimit(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    throw usageError(`--limit deve ser um inteiro entre 1 e ${MAX_LIMIT}.`);
  }
  return parsed;
}

function parseIntegerOption(
  args: ParsedArguments,
  name: string,
  fallback: number,
): number {
  const value = option(args, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw usageError(`--${name} deve ser um número inteiro.`);
  }
  return parsed;
}

function appendIfPresent(params: URLSearchParams, key: string, value?: string): void {
  if (value?.trim()) params.set(key, value.trim());
}

function withQuery(route: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${route}?${query}` : route;
}

function usageError(message: string): HeadlessCliError {
  return new HeadlessCliError("invalid_usage", message);
}

function normalizeError(error: unknown): HeadlessFailure["error"] {
  if (error instanceof z.ZodError) {
    return {
      code: "validation_error",
      message: "O JSON de entrada não corresponde ao contrato da operação.",
      details: error.issues,
    };
  }
  if (error instanceof HeadlessCliError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
    return { code: "input_not_found", message: "Arquivo de entrada não encontrado." };
  }
  return {
    code: "unexpected_error",
    message: error instanceof Error ? error.message : "Erro inesperado.",
  };
}

function headlessCapabilities() {
  return {
    apiVersion: "v1",
    sourceOfTruth: "sqlite",
    interactionSurface: "cli",
    executorModes: ["internal", "hermes"],
    output: {
      format: "json",
      compactFlag: "--json",
      schemaVersion: HEADLESS_SCHEMA_VERSION,
    },
    safety: {
      whatsappOutbound: false,
      directDatabaseWrites: false,
      writesRequireApplyFlag: true,
      writesRequireActor: true,
      secretsInOutput: false,
    },
    resources: {
      channels: ["list", "get", "create", "update", "test", "activate", "pause"],
      agent: ["triage-status", "triage-claim", "triage-heartbeat", "triage-complete"],
      conversations: ["list", "get", "messages", "tickets"],
      triage: ["blocks", "analyze", "create", "attach", "ignore", "context", "restore"],
      tickets: [
        "list",
        "get",
        "create",
        "update",
        "assign",
        "status",
        "category-add",
        "category-remove",
        "note-add",
        "note-delete",
        "external-messages-import",
        "product-forwarding",
      ],
      categories: ["list", "create", "delete"],
      operators: ["list"],
      clients: ["list"],
      dashboard: ["show"],
    },
    filters: {
      channel: {
        option: "--channel",
        commands: ["conversations.list", "tickets.list"],
        values: ["channel-id", "channel-name", "whatsapp", "all"],
      },
    },
  };
}
