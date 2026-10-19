export const CHANNEL_EVENT_TYPES = ["message.created", "message.updated", "message.deleted"] as const;
export type ChannelEventType = (typeof CHANNEL_EVENT_TYPES)[number];
export const CHANNEL_MAPPING_FIELDS = [
  "eventId", "eventType", "eventOccurredAt", "messageId", "conversationId",
  "conversationTitle", "threadId", "authorId", "authorName", "authorRole",
  "body", "occurredAt", "replyToMessageId", "externalUrl", "attachments",
] as const;
export type ChannelMappingField = (typeof CHANNEL_MAPPING_FIELDS)[number];

export interface ChannelConfig {
  format: "standard" | "mapped";
  mapping: Partial<Record<ChannelMappingField, string>>;
  timestampFormat: "iso" | "unix_seconds" | "unix_milliseconds";
  roleMapping: Record<string, "customer" | "support">;
  eventTypeMapping: Record<string, ChannelEventType>;
  authentication: "bearer" | "hmac" | "hmac_sha256";
  signatureHeader: string;
  signatureEncoding: "hex" | "base64";
  signatureAlgorithm?: "sha256" | "sha1";
  signaturePrefix?: string;
  conversationScope: "group" | "direct";
  monitored: boolean;
}

export interface ChannelAttachment {
  id: string;
  name: string;
  mimeType: string;
  url: string;
}

export interface ChannelMessageEvent {
  eventId: string;
  eventType: ChannelEventType;
  eventOccurredAt: string;
  messageId: string;
  conversationId: string;
  conversationTitle?: string;
  threadId?: string;
  authorId?: string;
  authorName?: string;
  authorRole?: "customer" | "support";
  body?: string;
  occurredAt: string;
  replyToMessageId?: string;
  externalUrl?: string;
  attachments: ChannelAttachment[];
}

export interface ChannelConnection {
  id: string;
  name: string;
  description: string;
  status: "draft" | "active" | "paused";
  clientId: string | null;
  config: ChannelConfig;
  lastReceivedAt: string | null;
  lastError: string | null;
  lastPreviewAt: string | null;
  pendingCount: number;
  failedCount: number;
  webhookPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelWriteInput {
  name: string;
  description?: string;
  clientId?: string | null;
  config: ChannelConfig;
  signatureSecret?: string;
  bearerToken?: string;
}

export interface ChannelSource {
  id: string;
  name: string;
  externalConversationId: string;
  threadId: string | null;
  externalUrl: string | null;
}

export interface ChannelEventRecord {
  id: string;
  externalEventId: string;
  state: "pending" | "processing" | "processed" | "failed";
  attempts: number;
  errorCode: string | null;
  receivedAt: string;
  processedAt: string | null;
}
