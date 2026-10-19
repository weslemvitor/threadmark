import { z } from "zod";
import {
  CHANNEL_EVENT_TYPES, CHANNEL_MAPPING_FIELDS,
  type ChannelConfig, type ChannelMessageEvent,
} from "../../shared/channels.js";
import { ValidationError } from "../domain/errors.js";

const pathSchema = z.string().max(300).regex(/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/)
  .refine((path) => !path.split(".").some((key) => ["__proto__", "prototype", "constructor"].includes(key)));
export const channelConfigSchema = z.object({
  format: z.enum(["standard", "mapped"]).default("standard"),
  mapping: z.partialRecord(z.enum(CHANNEL_MAPPING_FIELDS), pathSchema).default({}),
  timestampFormat: z.enum(["iso", "unix_seconds", "unix_milliseconds"]).default("iso"),
  roleMapping: z.record(z.string().max(100), z.enum(["customer", "support"])).default({}),
  eventTypeMapping: z.record(z.string().max(100), z.enum(CHANNEL_EVENT_TYPES)).default({}),
  authentication: z.enum(["bearer", "hmac", "hmac_sha256"]).default("bearer"),
  signatureHeader: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/).default("X-Channel-Signature"),
  signatureEncoding: z.enum(["hex", "base64"]).default("hex"),
  signatureAlgorithm: z.enum(["sha256", "sha1"]).default("sha256"),
  signaturePrefix: z.string().max(80).regex(/^[\x21-\x7e]*$/).default(""),
  conversationScope: z.enum(["group", "direct"]).default("group"),
  monitored: z.boolean().default(true),
}).strict().superRefine((config, context) => {
  if (config.format !== "mapped") return;
  for (const field of ["eventId", "messageId", "conversationId", "occurredAt"] as const) {
    if (!config.mapping[field]) context.addIssue({ code: "custom", message: `Mapeie o campo ${field}.`, path: ["mapping", field] });
  }
});

export const channelWriteSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).default(""),
  clientId: z.string().min(1).max(200).nullable().optional(),
  config: channelConfigSchema,
  signatureSecret: z.string().min(32).max(1000).optional(),
  bearerToken: z.string().min(32).max(1000).regex(/^[A-Za-z0-9._~+/-]+=*$/).optional(),
}).strict().superRefine((input, context) => {
  if (input.bearerToken && input.config.authentication !== "bearer") {
    context.addIssue({code: "custom", message: "bearerToken exige autenticação Bearer.", path: ["bearerToken"]});
  }
});

const httpsUrl = z.string().url().max(2048).refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password;
});
const identifier = z.string().trim().min(1).max(200);
const normalizedSchema = z.object({
  eventId: identifier,
  eventType: z.enum(CHANNEL_EVENT_TYPES),
  eventOccurredAt: z.string().datetime({ offset: true }),
  messageId: identifier,
  conversationId: identifier,
  conversationTitle: z.string().trim().min(1).max(300).optional(),
  threadId: identifier.optional(),
  authorId: identifier.optional(),
  authorName: z.string().trim().min(1).max(200).optional(),
  authorRole: z.enum(["customer", "support"]).optional(),
  body: z.string().max(20_000).optional(),
  occurredAt: z.string().datetime({ offset: true }),
  replyToMessageId: identifier.optional(),
  externalUrl: httpsUrl.optional(),
  attachments: z.array(z.object({
    id: identifier, name: z.string().max(200), mimeType: z.string().max(100), url: httpsUrl,
  }).strict()).max(20).default([]),
}).strict().superRefine((event, context) => {
  if (event.eventType === "message.created" && (!event.authorId || !event.authorName || !event.authorRole)) {
    context.addIssue({code:"custom", message:"Informe autor, nome e papel para uma mensagem nova.", path:["authorId"]});
  }
  if (event.eventType !== "message.deleted" && !event.body?.trim() && !event.attachments.length) {
    context.addIssue({code:"custom", message:"Informe texto ou anexos.", path:["body"]});
  }
});

function fieldAt(payload: unknown, path: string): unknown {
  let value = payload;
  for (const key of path.split(".")) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function timestamp(value: unknown, format: ChannelConfig["timestampFormat"]): unknown {
  if (value === undefined) return undefined;
  if (format === "iso") {
    if (typeof value !== "string" || !z.string().datetime({offset:true}).safeParse(value).success) return value;
    return new Date(value).toISOString();
  }
  if ((typeof value !== "number" && typeof value !== "string") || value === "") return value;
  const date = new Date(Number(value) * (format === "unix_seconds" ? 1000 : 1));
  return Number.isFinite(date.getTime()) ? date.toISOString() : value;
}

export function normalizeChannelEvent(payload: unknown, input: ChannelConfig): ChannelMessageEvent {
  const config = channelConfigSchema.parse(input);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new ValidationError("O evento deve ser um objeto JSON.");
  const result: Record<string, unknown> = {};
  for (const field of CHANNEL_MAPPING_FIELDS) {
    const path = config.format === "mapped" ? config.mapping[field] : field;
    if (path) result[field] = fieldAt(payload, path);
  }
  for (const field of ["eventId", "messageId", "conversationId", "threadId", "authorId", "replyToMessageId"]) {
    if (typeof result[field] === "number" && Number.isSafeInteger(result[field])) result[field] = String(result[field]);
  }
  const role = result.authorRole;
  if (typeof role === "string" && Object.hasOwn(config.roleMapping, role)) result.authorRole = config.roleMapping[role];
  const eventType = result.eventType;
  result.eventType = typeof eventType === "string" && Object.hasOwn(config.eventTypeMapping, eventType)
    ? config.eventTypeMapping[eventType] : eventType ?? "message.created";
  result.eventOccurredAt = timestamp(result.eventOccurredAt ?? result.occurredAt, config.timestampFormat);
  result.occurredAt = timestamp(result.occurredAt, config.timestampFormat);
  return normalizedSchema.parse(result);
}
