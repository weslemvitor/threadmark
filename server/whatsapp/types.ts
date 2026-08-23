import type {
  BaileysEventEmitter,
  BaileysEventMap,
  MessageUpsertType,
} from "baileys";

export type Awaitable<T> = T | Promise<T>;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type InboundMessageSource = "history" | "realtime";

export type MessageScope =
  | "group"
  | "direct"
  | "broadcast"
  | "newsletter"
  | "unknown";

export type NormalizedMessageKind =
  | "text"
  | "image"
  | "document"
  | "video"
  | "audio"
  | "sticker"
  | "reaction"
  | "location"
  | "contact"
  | "poll"
  | "system"
  | "unknown";

export interface EncryptedMediaLocator {
  directPath: string | null;
  mediaKeyBase64: string | null;
  url: string | null;
}

export interface InboundAttachment {
  idempotencyKey: string;
  kind: "image" | "document" | "video" | "audio" | "sticker";
  /** Images, documents and voice notes are persisted for local analysis. */
  eligibleForAnalysis: boolean;
  mimeType: string | null;
  fileName: string | null;
  fileSha256Base64: string | null;
  fileEncSha256Base64: string | null;
  sizeBytes: number | null;
  pageCount: number | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  encryptedLocator: EncryptedMediaLocator;
}

export interface InboundMessageContent {
  kind: NormalizedMessageKind;
  messageType: string | null;
  text: string | null;
  caption: string | null;
  quotedMessageId: string | null;
  attachments: InboundAttachment[];
  reaction?: {
    targetProviderMessageId: string;
    emoji: string | null;
    reactedAt: string | null;
  };
  revocation?: {
    targetProviderMessageId: string;
  };
}

export interface HistoryObservation {
  syncType: number | null;
  progress: number | null;
  isLatest: boolean;
  chunkOrder: number | null;
  peerDataRequestSessionId: string | null;
}

export interface RealtimeObservation {
  upsertType: MessageUpsertType;
  requestId: string | null;
}

export interface InboundMessageEnvelope {
  /** Stable across history syncs, reconnects and real-time redelivery. */
  idempotencyKey: string;
  provider: "whatsapp";
  providerMessageId: string | null;
  source: InboundMessageSource;
  observedAs: HistoryObservation | RealtimeObservation;
  occurredAt: string | null;
  timestampMs: number | null;
  chatJid: string;
  chatDisplayName: string | null;
  scope: MessageScope;
  participantJid: string | null;
  participantAltJid: string | null;
  participantDisplayName: string | null;
  fromMe: boolean;
  isStaff: boolean;
  isAllowlistedGroup: boolean;
  /** False means "store as context, but do not open a ticket". */
  eligibleForTicket: boolean;
  content: InboundMessageContent;
  rawMessage: JsonValue;
}

export interface NormalizationPolicyInput {
  /** Undefined means every group is enabled. An empty iterable enables none. */
  allowlistedGroupJids?: Iterable<string>;
  staffIdentities?: Iterable<string>;
}

export type InboundIdentityLinkSource =
  | "history"
  | "lid_mapping_update"
  | "group_roster"
  | "group_participant_update";

/** A verified WhatsApp phone-number identity and its device-independent LID. */
export interface InboundIdentityLink {
  phoneJid: string;
  lidJid: string;
  source: InboundIdentityLinkSource;
  observedAt: string;
}

/** A human-readable contact name observed in the local WhatsApp history. */
export interface InboundContactName {
  externalJid: string;
  displayName: string;
  observedAt: string;
}

export type InboundGroupParticipantRole = "member" | "admin" | "owner";

export interface InboundGroupParticipant {
  /** The identifier Baileys currently uses for this member. */
  externalJid: string;
  lidJid: string | null;
  phoneJid: string | null;
  displayName: string | null;
  role: InboundGroupParticipantRole;
}

export interface InboundGroupRoster {
  groupJid: string;
  subject: string;
  participants: InboundGroupParticipant[];
  observedAt: string;
}

export type InboundGroupParticipantAction =
  | "add"
  | "remove"
  | "promote"
  | "demote"
  | "modify";

export interface InboundGroupParticipantUpdate {
  groupJid: string;
  action: InboundGroupParticipantAction;
  participants: InboundGroupParticipant[];
  observedAt: string;
}

export interface InboundMessageSink {
  /** Must upsert by `idempotencyKey`; the connector can redeliver safely. */
  upsertMessages(messages: readonly InboundMessageEnvelope[]): Awaitable<void>;
  /** Upsert aliases idempotently; mappings can be redelivered by Baileys. */
  upsertIdentityLinks?(links: readonly InboundIdentityLink[]): Awaitable<void>;
  /** Improve names only for participants already known by Threadmark. */
  upsertContactNames?(contacts: readonly InboundContactName[]): Awaitable<void>;
  /** Replace each supplied group's active roster with this readonly snapshot. */
  syncGroupRosters?(rosters: readonly InboundGroupRoster[]): Awaitable<void>;
  /** Apply one incremental membership event after the most recent snapshot. */
  applyGroupParticipantsUpdate?(
    update: InboundGroupParticipantUpdate,
  ): Awaitable<void>;
  hasMedia?(attachmentIdempotencyKey: string): Awaitable<boolean>;
  storeMedia?(media: DownloadedInboundMedia): Awaitable<void>;
  emitRuntimeEvent?(event: InboundRuntimeEvent): Awaitable<void>;
}

export interface DownloadedInboundMedia {
  idempotencyKey: string;
  messageIdempotencyKey: string;
  kind: "image" | "document" | "audio";
  mimeType: string | null;
  fileName: string | null;
  sizeBytes: number;
  sha256Hex: string;
  bytes: Buffer;
}

export type InboundRuntimeEvent =
  | {
      type: "qr";
      occurredAt: string;
      /** Ephemeral secret. Consumers must display it, never persist it. */
      qr: string;
    }
  | {
      type: "connection";
      occurredAt: string;
      state: "connecting" | "open" | "close";
      isOnline: boolean | null;
      receivedPendingNotifications: boolean | null;
      disconnectStatusCode: number | null;
      errorMessage: string | null;
    }
  | {
      type: "history_sync";
      occurredAt: string;
      status: "batch" | "complete" | "paused";
      syncType: number | null;
      progress: number | null;
      explicit: boolean | null;
      isLatest: boolean | null;
      chunkOrder: number | null;
      messageCount: number;
    }
  | {
      type: "ingestion_error";
      occurredAt: string;
      source:
        | "messaging-history.set"
        | "messaging-history.status"
        | "contacts.upsert"
        | "contacts.update"
        | "messages.upsert"
        | "lid-mapping.update"
        | "group-participants.update"
        | "group_roster.sync"
        | "connection.update"
        | "creds.update"
        | "media.download";
      errorMessage: string;
    };

export type InboundBaileysEventName =
  | "connection.update"
  | "contacts.upsert"
  | "contacts.update"
  | "messaging-history.set"
  | "messaging-history.status"
  | "messages.upsert"
  | "lid-mapping.update"
  | "group-participants.update";

/** Event-only view of Baileys. It deliberately contains no socket operations. */
export type InboundEventSource = Pick<BaileysEventEmitter, "on" | "off">;

export type HistorySetPayload = BaileysEventMap["messaging-history.set"];
export type ContactsUpsertPayload = BaileysEventMap["contacts.upsert"];
export type ContactsUpdatePayload = BaileysEventMap["contacts.update"];
export type HistoryStatusPayload =
  BaileysEventMap["messaging-history.status"];
export type MessagesUpsertPayload = BaileysEventMap["messages.upsert"];
export type ConnectionUpdatePayload = BaileysEventMap["connection.update"];
export type LidMappingUpdatePayload = BaileysEventMap["lid-mapping.update"];
export type GroupParticipantsUpdatePayload =
  BaileysEventMap["group-participants.update"];
