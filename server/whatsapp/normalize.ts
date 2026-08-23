import { createHash } from "node:crypto";

import {
  getContentType,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  jidNormalizedUser,
  normalizeMessageContent,
  proto,
  type Contact,
  type WAMessage,
} from "baileys";

import type {
  HistoryObservation,
  HistorySetPayload,
  InboundContactName,
  InboundAttachment,
  InboundMessageContent,
  InboundMessageEnvelope,
  JsonValue,
  MessageScope,
  MessagesUpsertPayload,
  NormalizationPolicyInput,
  RealtimeObservation,
} from "./types.js";

interface CompiledNormalizationPolicy {
  allowlistedGroups: ReadonlySet<string> | null;
  staffIdentities: ReadonlySet<string>;
}

interface NormalizationContext {
  policy: CompiledNormalizationPolicy;
  source: "history" | "realtime";
  observedAs: HistoryObservation | RealtimeObservation;
  chatNames: ReadonlyMap<string, string>;
  contactNames: ReadonlyMap<string, string>;
}

interface MediaLike {
  url?: string | null;
  directPath?: string | null;
  mediaKey?: Uint8Array | null;
  mimetype?: string | null;
  fileName?: string | null;
  title?: string | null;
  fileSha256?: Uint8Array | null;
  fileEncSha256?: Uint8Array | null;
  fileLength?: unknown;
  pageCount?: number | null;
  width?: number | null;
  height?: number | null;
  seconds?: number | null;
}

export function normalizeHistorySet(
  payload: HistorySetPayload,
  policyInput: NormalizationPolicyInput = {},
): InboundMessageEnvelope[] {
  const policy = compilePolicy(policyInput);
  const chatNames = new Map<string, string>();
  const contactNames = new Map<string, string>();

  for (const chat of payload.chats) {
    const jid = normalizeJid(chat.id);
    const name = firstNonEmpty(chat.name, chat.displayName);
    if (jid && name) {
      chatNames.set(jid, name);
    }
  }

  for (const contact of payload.contacts) {
    const displayName = firstNonEmpty(
      contact.name,
      contact.notify,
      contact.verifiedName,
    );
    if (!displayName) {
      continue;
    }

    for (const candidate of [contact.id, contact.lid, contact.phoneNumber]) {
      const jid = normalizeJid(candidate);
      if (jid) {
        contactNames.set(jid, displayName);
      }
    }
  }

  const observedAs: HistoryObservation = {
    syncType: nullableNumber(payload.syncType),
    progress: nullableNumber(payload.progress),
    isLatest: payload.isLatest === true,
    chunkOrder: nullableNumber(payload.chunkOrder),
    peerDataRequestSessionId:
      firstNonEmpty(payload.peerDataRequestSessionId) ?? null,
  };

  return payload.messages.map((message) =>
    normalizeMessage(message, {
      policy,
      source: "history",
      observedAs,
      chatNames,
      contactNames,
    }),
  );
}

export function normalizeHistoryContacts(
  payload: HistorySetPayload,
  observedAt: string,
): InboundContactName[] {
  return normalizeContactNames(payload.contacts, observedAt);
}

export function normalizeContactNames(
  contacts: readonly Partial<Contact>[],
  observedAt: string,
): InboundContactName[] {
  const names = new Map<string, string>();
  for (const contact of contacts) {
    const displayName = firstNonEmpty(
      contact.name,
      contact.notify,
      contact.verifiedName,
    );
    if (!displayName) continue;
    for (const candidate of [contact.id, contact.lid, contact.phoneNumber]) {
      const externalJid = normalizeJid(candidate);
      if (externalJid) names.set(externalJid, displayName);
    }
  }
  return [...names.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([externalJid, displayName]) => ({
      externalJid,
      displayName,
      observedAt,
    }));
}

export function normalizeMessagesUpsert(
  payload: MessagesUpsertPayload,
  policyInput: NormalizationPolicyInput = {},
): InboundMessageEnvelope[] {
  const observedAs: RealtimeObservation = {
    upsertType: payload.type,
    requestId: firstNonEmpty(payload.requestId) ?? null,
  };

  return payload.messages.map((message) =>
    normalizeMessage(message, {
      policy: compilePolicy(policyInput),
      source: "realtime",
      observedAs,
      chatNames: new Map(),
      contactNames: new Map(),
    }),
  );
}

export function normalizeJid(value: string | null | undefined): string {
  if (!value) {
    return "";
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  if (!trimmed.includes("@")) {
    const digits = trimmed.replace(/\D/g, "");
    return digits ? `${digits}@s.whatsapp.net` : "";
  }

  return jidNormalizedUser(trimmed);
}

export function toJsonValue(value: unknown): JsonValue {
  return convertToJson(value, new WeakSet<object>());
}

function normalizeMessage(
  message: WAMessage,
  context: NormalizationContext,
): InboundMessageEnvelope {
  const rawMessage = toJsonValue(message);
  const chatJid = normalizeJid(message.key.remoteJid) || "unknown";
  const scope = classifyScope(chatJid);
  const participantJid = normalizeJid(
    message.key.participant ??
      message.participant ??
      (scope === "direct" && !message.key.fromMe ? chatJid : undefined),
  );
  const participantAltJid = normalizeJid(
    message.key.participantAlt ??
      (scope === "direct" ? message.key.remoteJidAlt : undefined),
  );
  const fromMe = message.key.fromMe === true;
  const isStaff =
    fromMe ||
    matchesStaff(context.policy, [participantJid, participantAltJid]);
  const isAllowlistedGroup =
    scope === "group" &&
    (context.policy.allowlistedGroups === null ||
      context.policy.allowlistedGroups.has(chatJid));
  const isNewDirectMessage =
    scope === "direct" &&
    context.source === "realtime" &&
    "upsertType" in context.observedAs &&
    context.observedAs.upsertType === "notify";
  const isNewGroupMessage =
    isAllowlistedGroup &&
    context.source === "realtime" &&
    "upsertType" in context.observedAs &&
    context.observedAs.upsertType === "notify";
  const providerMessageId = firstNonEmpty(message.key.id) ?? null;
  const timestampMs = timestampToMilliseconds(message.messageTimestamp);
  const idempotencyKey = createIdempotencyKey({
    chatJid,
    providerMessageId,
    timestampMs,
    participantJid,
    rawMessage,
  });
  const normalizedContent = normalizeContent(message);
  const content: InboundMessageContent = {
    ...normalizedContent,
    attachments: normalizedContent.attachments.map((attachment, index) => ({
      ...attachment,
      idempotencyKey: `${idempotencyKey}:attachment:${index}`,
    })),
  };
  const isChatControlEvent = Boolean(
    content.reaction ||
      content.revocation ||
      content.messageType === "protocolMessage",
  );

  return {
    idempotencyKey,
    provider: "whatsapp",
    providerMessageId,
    source: context.source,
    observedAs: context.observedAs,
    occurredAt:
      timestampMs === null ? null : new Date(timestampMs).toISOString(),
    timestampMs,
    chatJid,
    chatDisplayName: context.chatNames.get(chatJid) ?? null,
    scope,
    participantJid: participantJid || null,
    participantAltJid: participantAltJid || null,
    participantDisplayName: resolveParticipantName(
      message,
      participantJid,
      participantAltJid,
      context.contactNames,
    ),
    fromMe,
    isStaff,
    isAllowlistedGroup,
    eligibleForTicket:
      (isNewGroupMessage || isNewDirectMessage) &&
      !isStaff &&
      !isChatControlEvent,
    content,
    rawMessage,
  };
}

function compilePolicy(
  input: NormalizationPolicyInput,
): CompiledNormalizationPolicy {
  const allowlistedGroups = input.allowlistedGroupJids
    ? new Set(
        Array.from(input.allowlistedGroupJids, normalizeJid).filter(Boolean),
      )
    : null;
  const staffIdentities = new Set(
    Array.from(input.staffIdentities ?? [], normalizeJid).filter(Boolean),
  );

  return { allowlistedGroups, staffIdentities };
}

function resolveParticipantName(
  message: WAMessage,
  participantJid: string,
  participantAltJid: string,
  contactNames: ReadonlyMap<string, string>,
): string | null {
  return (
    contactNames.get(participantJid) ??
    contactNames.get(participantAltJid) ??
    firstNonEmpty(message.pushName) ??
    null
  );
}

function matchesStaff(
  policy: CompiledNormalizationPolicy,
  candidates: readonly string[],
): boolean {
  return candidates.some(
    (candidate) => candidate && policy.staffIdentities.has(candidate),
  );
}

function classifyScope(jid: string): MessageScope {
  if (isJidGroup(jid)) {
    return "group";
  }
  if (isJidNewsletter(jid)) {
    return "newsletter";
  }
  if (isJidBroadcast(jid)) {
    return "broadcast";
  }
  if (jid && jid !== "unknown" && jid.includes("@")) {
    return "direct";
  }
  return "unknown";
}

function normalizeContent(message: WAMessage): InboundMessageContent {
  const content = normalizeMessageContent(message.message);
  const messageType = getContentType(content) ?? null;
  const contextInfo =
    content?.extendedTextMessage?.contextInfo ??
    content?.imageMessage?.contextInfo ??
    content?.documentMessage?.contextInfo ??
    content?.videoMessage?.contextInfo ??
    content?.audioMessage?.contextInfo ??
    content?.stickerMessage?.contextInfo ??
    null;
  const quotedMessageId = firstNonEmpty(contextInfo?.stanzaId) ?? null;

  if (!content) {
    return {
      kind: message.messageStubType == null ? "unknown" : "system",
      messageType,
      text: message.messageStubParameters?.join(" ") || null,
      caption: null,
      quotedMessageId,
      attachments: [],
    };
  }

  if (
    content.protocolMessage?.type ===
      proto.Message.ProtocolMessage.Type.REVOKE &&
    content.protocolMessage.key?.id
  ) {
    return {
      kind: "system",
      messageType,
      text: null,
      caption: null,
      quotedMessageId: null,
      attachments: [],
      revocation: {
        targetProviderMessageId: content.protocolMessage.key.id,
      },
    };
  }

  if (content.conversation != null) {
    return textContent("text", messageType, content.conversation, quotedMessageId);
  }

  if (content.extendedTextMessage) {
    return textContent(
      "text",
      messageType,
      content.extendedTextMessage.text,
      quotedMessageId,
    );
  }

  if (content.imageMessage) {
    return mediaContent(
      "image",
      messageType,
      content.imageMessage.caption,
      quotedMessageId,
      content.imageMessage,
    );
  }

  if (content.documentMessage) {
    return mediaContent(
      "document",
      messageType,
      content.documentMessage.caption,
      quotedMessageId,
      content.documentMessage,
    );
  }

  if (content.videoMessage) {
    return mediaContent(
      "video",
      messageType,
      content.videoMessage.caption,
      quotedMessageId,
      content.videoMessage,
    );
  }

  if (content.audioMessage) {
    return mediaContent(
      "audio",
      messageType,
      null,
      quotedMessageId,
      content.audioMessage,
    );
  }

  if (content.stickerMessage) {
    return mediaContent(
      "sticker",
      messageType,
      null,
      quotedMessageId,
      content.stickerMessage,
    );
  }

  if (content.reactionMessage) {
    const targetProviderMessageId = firstNonEmpty(
      content.reactionMessage.key?.id,
    );
    const reaction = textContent(
      "reaction",
      messageType,
      content.reactionMessage.text,
      targetProviderMessageId ?? quotedMessageId,
    );
    if (!targetProviderMessageId) return reaction;
    const reactedAtMs = timestampToMilliseconds(
      content.reactionMessage.senderTimestampMs,
    );
    return {
      ...reaction,
      reaction: {
        targetProviderMessageId,
        emoji: firstNonEmpty(content.reactionMessage.text) ?? null,
        reactedAt:
          reactedAtMs === null ? null : new Date(reactedAtMs).toISOString(),
      },
    };
  }

  if (content.locationMessage) {
    return textContent(
      "location",
      messageType,
      firstNonEmpty(
        content.locationMessage.name,
        content.locationMessage.address,
        content.locationMessage.url,
      ),
      quotedMessageId,
    );
  }

  if (content.contactMessage) {
    return textContent(
      "contact",
      messageType,
      firstNonEmpty(
        content.contactMessage.displayName,
        content.contactMessage.vcard,
      ),
      quotedMessageId,
    );
  }

  const richMessageText = firstNonEmpty(
    content.templateMessage?.hydratedFourRowTemplate?.hydratedContentText,
    content.templateMessage?.hydratedTemplate?.hydratedContentText,
    content.templateMessage?.interactiveMessageTemplate?.body?.text,
    content.templateMessage?.interactiveMessageTemplate?.header?.imageMessage
      ?.caption,
    content.buttonsMessage?.contentText,
    content.interactiveMessage?.body?.text,
    content.groupInviteMessage?.caption,
    content.groupInviteMessage?.groupName,
  );
  if (richMessageText) {
    return textContent("text", messageType, richMessageText, quotedMessageId);
  }

  const replyText = firstNonEmpty(
    content.buttonsResponseMessage?.selectedDisplayText,
    content.buttonsResponseMessage?.selectedButtonId,
    content.templateButtonReplyMessage?.selectedDisplayText,
    content.templateButtonReplyMessage?.selectedId,
    content.listResponseMessage?.title,
    content.listResponseMessage?.description,
    content.listResponseMessage?.singleSelectReply?.selectedRowId,
    content.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson,
  );
  if (replyText) {
    return textContent("text", messageType, replyText, quotedMessageId);
  }

  const pollName = firstNonEmpty(
    content.pollCreationMessage?.name,
    content.pollCreationMessageV2?.name,
    content.pollCreationMessageV3?.name,
  );
  if (pollName) {
    return textContent("poll", messageType, pollName, quotedMessageId);
  }

  return {
    kind: message.messageStubType == null ? "unknown" : "system",
    messageType,
    text: message.messageStubParameters?.join(" ") || null,
    caption: null,
    quotedMessageId,
    attachments: [],
  };
}

function textContent(
  kind: InboundMessageContent["kind"],
  messageType: string | null,
  text: string | null | undefined,
  quotedMessageId: string | null,
): InboundMessageContent {
  return {
    kind,
    messageType,
    text: text && text.length > 0 ? text : null,
    caption: null,
    quotedMessageId,
    attachments: [],
  };
}

function mediaContent(
  kind: InboundAttachment["kind"],
  messageType: string | null,
  caption: string | null | undefined,
  quotedMessageId: string | null,
  media: MediaLike,
): InboundMessageContent {
  const normalizedCaption = caption && caption.length > 0 ? caption : null;
  return {
    kind,
    messageType,
    text: normalizedCaption,
    caption: normalizedCaption,
    quotedMessageId,
    attachments: [normalizeAttachment(kind, media)],
  };
}

function normalizeAttachment(
  kind: InboundAttachment["kind"],
  media: MediaLike,
): InboundAttachment {
  return {
    idempotencyKey: "",
    kind,
    eligibleForAnalysis:
      kind === "image" || kind === "document" || kind === "audio",
    mimeType: firstNonEmpty(media.mimetype) ?? null,
    fileName: firstNonEmpty(media.fileName, media.title) ?? null,
    fileSha256Base64: bytesToBase64(media.fileSha256),
    fileEncSha256Base64: bytesToBase64(media.fileEncSha256),
    sizeBytes: nullableNumber(media.fileLength),
    pageCount: nullableNumber(media.pageCount),
    width: nullableNumber(media.width),
    height: nullableNumber(media.height),
    durationSeconds: nullableNumber(media.seconds),
    encryptedLocator: {
      directPath: firstNonEmpty(media.directPath) ?? null,
      mediaKeyBase64: bytesToBase64(media.mediaKey),
      url: firstNonEmpty(media.url) ?? null,
    },
  };
}

function createIdempotencyKey(input: {
  chatJid: string;
  providerMessageId: string | null;
  timestampMs: number | null;
  participantJid: string;
  rawMessage: JsonValue;
}): string {
  const providerIdentity = input.providerMessageId
    ? `provider-id:${input.providerMessageId}`
    : `fallback:${input.timestampMs ?? "unknown"}:${input.participantJid}:${JSON.stringify(input.rawMessage)}`;
  const digest = createHash("sha256")
    .update(input.chatJid)
    .update("\0")
    .update(providerIdentity)
    .digest("hex");
  return `whatsapp:v1:${digest}`;
}

function timestampToMilliseconds(value: unknown): number | null {
  const timestamp = nullableNumber(value);
  if (timestamp === null || timestamp < 0) {
    return null;
  }
  return timestamp >= 1_000_000_000_000
    ? Math.trunc(timestamp)
    : Math.trunc(timestamp * 1_000);
}

function nullableNumber(value: unknown): number | null {
  if (value == null) {
    return null;
  }

  const candidate =
    typeof value === "object" && "toNumber" in value
      ? (value as { toNumber(): number }).toNumber()
      : Number(value);
  return Number.isFinite(candidate) ? candidate : null;
}

function bytesToBase64(value: Uint8Array | null | undefined): string | null {
  return value ? Buffer.from(value).toString("base64") : null;
}

function firstNonEmpty(
  ...values: Array<string | null | undefined>
): string | undefined {
  return values.find((value): value is string => Boolean(value?.length));
}

function convertToJson(value: unknown, seen: WeakSet<object>): JsonValue {
  if (value == null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value !== "object") {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Uint8Array) {
    return { $bytesBase64: Buffer.from(value).toString("base64") };
  }
  if (isLongLike(value)) {
    return value.toString();
  }
  if (seen.has(value)) {
    return "[Circular]";
  }

  seen.add(value);
  if (Array.isArray(value)) {
    const output = value.map((item) => convertToJson(item, seen));
    seen.delete(value);
    return output;
  }

  const output: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) {
      output[key] = convertToJson(item, seen);
    }
  }
  seen.delete(value);
  return output;
}

function isLongLike(
  value: object,
): value is { low: number; high: number; toString(): string } {
  return (
    "low" in value &&
    "high" in value &&
    typeof value.low === "number" &&
    typeof value.high === "number" &&
    "toString" in value &&
    typeof value.toString === "function"
  );
}
