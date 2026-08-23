import type {
  GroupMetadata,
  GroupParticipant,
  LIDMapping,
  WAMessage,
} from "baileys";

import {
  normalizeContactNames,
  normalizeHistoryContacts,
  normalizeHistorySet,
  normalizeJid,
  normalizeMessagesUpsert,
} from "./normalize.js";
import type {
  ConnectionUpdatePayload,
  ContactsUpdatePayload,
  ContactsUpsertPayload,
  GroupParticipantsUpdatePayload,
  HistorySetPayload,
  HistoryStatusPayload,
  InboundEventSource,
  InboundGroupParticipant,
  InboundGroupParticipantAction,
  InboundGroupParticipantUpdate,
  InboundGroupRoster,
  InboundIdentityLink,
  InboundIdentityLinkSource,
  InboundMessageEnvelope,
  InboundMessageSink,
  InboundRuntimeEvent,
  LidMappingUpdatePayload,
  MessagesUpsertPayload,
  NormalizationPolicyInput,
} from "./types.js";
import type { InboundMediaDownloader } from "./media.js";

export interface BindInboundEventsOptions {
  source: InboundEventSource;
  sink: InboundMessageSink;
  policy?: NormalizationPolicyInput;
  mediaDownloader?: InboundMediaDownloader;
  now?: () => Date;
}

export interface BoundInboundEvents {
  detach(): void;
  flush(): Promise<void>;
  /** Queues a readonly snapshot fetched by the client after a connection opens. */
  syncGroupRosters(
    rosters:
      | readonly InboundGroupRoster[]
      | Promise<readonly InboundGroupRoster[]>,
  ): Promise<void>;
}

/**
 * Bridges only inbound Baileys events to an injected persistence sink. Event
 * handlers are serialized so a history batch cannot overtake a live upsert.
 */
export function bindInboundEvents(
  options: BindInboundEventsOptions,
): BoundInboundEvents {
  const policy: NormalizationPolicyInput = {
    allowlistedGroupJids: options.policy?.allowlistedGroupJids
      ? Array.from(options.policy.allowlistedGroupJids)
      : undefined,
    staffIdentities: Array.from(options.policy?.staffIdentities ?? []),
  };
  const now = options.now ?? (() => new Date());
  let detached = false;
  let pending = Promise.resolve();
  let mediaPending = Promise.resolve();

  const emit = (event: InboundRuntimeEvent) =>
    options.sink.emitRuntimeEvent?.(event);

  const enqueue = (
    source: InboundRuntimeEventSource,
    operation: () => Promise<void>,
  ): Promise<void> => {
    if (detached) {
      return Promise.resolve();
    }
    pending = pending
      .then(operation)
      .catch(async (error: unknown) => {
        try {
          await emit({
            type: "ingestion_error",
            occurredAt: now().toISOString(),
            source,
            errorMessage: errorMessage(error),
          });
        } catch {
          // Runtime reporting must never turn an event callback into an
          // unhandled rejection. The caller can observe failures in its sink.
        }
      });
    return pending;
  };

  const enqueueMedia = (
    messages: readonly WAMessage[],
    envelopes: readonly InboundMessageEnvelope[],
  ) => {
    mediaPending = mediaPending.then(() =>
      persistMediaBatch(options, messages, envelopes, now),
    );
  };

  const onHistorySet = (payload: HistorySetPayload) => {
    enqueue("messaging-history.set", async () => {
      const observedAt = now().toISOString();
      await persistIdentityLinks(
        options.sink,
        normalizeIdentityLinks(
          payload.lidPnMappings ?? [],
          "history",
          observedAt,
        ),
      );
      await options.sink.upsertContactNames?.(
        normalizeHistoryContacts(payload, observedAt),
      );
      const envelopes = normalizeHistorySet(payload, policy);
      await emit({
        type: "history_sync",
        occurredAt: observedAt,
        status: "batch",
        syncType: nullableNumber(payload.syncType),
        progress: nullableNumber(payload.progress),
        explicit: null,
        isLatest: payload.isLatest ?? null,
        chunkOrder: nullableNumber(payload.chunkOrder),
        messageCount: envelopes.length,
      });
      await persistBatch(
        options,
        payload.messages,
        envelopes,
        enqueueMedia,
      );
    });
  };

  const onHistoryStatus = (payload: HistoryStatusPayload) => {
    enqueue("messaging-history.status", async () => {
      await emit({
        type: "history_sync",
        occurredAt: now().toISOString(),
        status: payload.status,
        syncType: nullableNumber(payload.syncType),
        progress: payload.explicit ? 100 : null,
        explicit: payload.explicit,
        isLatest: null,
        chunkOrder: null,
        messageCount: 0,
      });
    });
  };

  const onContactsUpsert = (payload: ContactsUpsertPayload) => {
    enqueue("contacts.upsert", async () => {
      const observedAt = now().toISOString();
      await options.sink.upsertContactNames?.(
        normalizeContactNames(payload, observedAt),
      );
    });
  };

  const onContactsUpdate = (payload: ContactsUpdatePayload) => {
    enqueue("contacts.update", async () => {
      const observedAt = now().toISOString();
      await options.sink.upsertContactNames?.(
        normalizeContactNames(payload, observedAt),
      );
    });
  };

  const onMessagesUpsert = (payload: MessagesUpsertPayload) => {
    enqueue("messages.upsert", async () => {
      const envelopes = normalizeMessagesUpsert(payload, policy);
      await persistBatch(
        options,
        payload.messages,
        envelopes,
        enqueueMedia,
      );
    });
  };

  const onLidMappingUpdate = (payload: LidMappingUpdatePayload) => {
    enqueue("lid-mapping.update", async () => {
      await persistIdentityLinks(
        options.sink,
        normalizeIdentityLinks(
          [payload],
          "lid_mapping_update",
          now().toISOString(),
        ),
      );
    });
  };

  const onGroupParticipantsUpdate = (
    payload: GroupParticipantsUpdatePayload,
  ) => {
    enqueue("group-participants.update", async () => {
      const update = normalizeGroupParticipantsUpdate(
        payload,
        now().toISOString(),
      );
      if (!update) {
        return;
      }
      await persistIdentityLinks(
        options.sink,
        identityLinksFromParticipants(
          update.participants,
          "group_participant_update",
          update.observedAt,
        ),
      );
      await options.sink.applyGroupParticipantsUpdate?.(update);
    });
  };

  const onConnectionUpdate = (payload: ConnectionUpdatePayload) => {
    enqueue("connection.update", async () => {
      if (payload.qr) {
        await emit({
          type: "qr",
          occurredAt: now().toISOString(),
          qr: payload.qr,
        });
      }

      if (payload.connection) {
        await emit({
          type: "connection",
          occurredAt: now().toISOString(),
          state: payload.connection,
          isOnline: payload.isOnline ?? null,
          receivedPendingNotifications:
            payload.receivedPendingNotifications ?? null,
          disconnectStatusCode: getDisconnectStatusCode(
            payload.lastDisconnect?.error,
          ),
          errorMessage: payload.lastDisconnect?.error
            ? errorMessage(payload.lastDisconnect.error)
            : null,
        });
      }
    });
  };

  options.source.on("messaging-history.set", onHistorySet);
  options.source.on("messaging-history.status", onHistoryStatus);
  options.source.on("contacts.upsert", onContactsUpsert);
  options.source.on("contacts.update", onContactsUpdate);
  options.source.on("messages.upsert", onMessagesUpsert);
  options.source.on("lid-mapping.update", onLidMappingUpdate);
  options.source.on("group-participants.update", onGroupParticipantsUpdate);
  options.source.on("connection.update", onConnectionUpdate);

  return {
    detach() {
      if (detached) {
        return;
      }
      detached = true;
      options.source.off("messaging-history.set", onHistorySet);
      options.source.off("messaging-history.status", onHistoryStatus);
      options.source.off("contacts.upsert", onContactsUpsert);
      options.source.off("contacts.update", onContactsUpdate);
      options.source.off("messages.upsert", onMessagesUpsert);
      options.source.off("lid-mapping.update", onLidMappingUpdate);
      options.source.off(
        "group-participants.update",
        onGroupParticipantsUpdate,
      );
      options.source.off("connection.update", onConnectionUpdate);
    },
    async flush() {
      await pending;
      await mediaPending;
    },
    syncGroupRosters(rosters) {
      return enqueue("group_roster.sync", async () => {
        const resolvedRosters = await rosters;
        const links = resolvedRosters.flatMap((roster) =>
          identityLinksFromParticipants(
            roster.participants,
            "group_roster",
            roster.observedAt,
          ),
        );
        await persistIdentityLinks(options.sink, links);
        await options.sink.syncGroupRosters?.(resolvedRosters);
      });
    },
  };
}

export function normalizeIdentityLinks(
  mappings: readonly LIDMapping[],
  source: InboundIdentityLinkSource,
  observedAt: string,
): InboundIdentityLink[] {
  const links = new Map<string, InboundIdentityLink>();
  for (const mapping of mappings) {
    const phoneJid = normalizeJid(mapping.pn);
    const lidJid = normalizeJid(mapping.lid);
    if (!isPhoneJid(phoneJid) || !isLidJid(lidJid)) {
      continue;
    }
    links.set(`${phoneJid}\u0000${lidJid}`, {
      phoneJid,
      lidJid,
      source,
      observedAt,
    });
  }
  return Array.from(links.values());
}

export function normalizeGroupRosters(
  groups: readonly GroupMetadata[],
  observedAt: string,
): InboundGroupRoster[] {
  const rosters: InboundGroupRoster[] = [];
  for (const group of groups) {
    const groupJid = normalizeJid(group.id);
    if (!groupJid.endsWith("@g.us")) {
      continue;
    }
    const ownerJids = normalizedJidSet([group.owner, group.ownerPn]);
    rosters.push({
      groupJid,
      subject: firstNonEmpty(group.subject, group.notify) ?? groupJid,
      participants: normalizeGroupParticipants(
        group.participants,
        ownerJids,
      ),
      observedAt,
    });
  }
  return rosters;
}

export function normalizeGroupParticipantsUpdate(
  payload: GroupParticipantsUpdatePayload,
  observedAt: string,
): InboundGroupParticipantUpdate | null {
  const groupJid = normalizeJid(payload.id);
  if (!groupJid.endsWith("@g.us")) {
    return null;
  }
  const participants = normalizeGroupParticipants(payload.participants);
  return {
    groupJid,
    action: payload.action as InboundGroupParticipantAction,
    participants: participants.map((participant) => ({
      ...participant,
      role: roleForParticipantAction(participant.role, payload.action),
    })),
    observedAt,
  };
}

function normalizeGroupParticipants(
  participants: readonly GroupParticipant[],
  ownerJids: ReadonlySet<string> = new Set(),
): InboundGroupParticipant[] {
  const normalized = new Map<string, InboundGroupParticipant>();
  for (const participant of participants) {
    const externalJid = normalizeJid(participant.id);
    const lidJid = firstJidWithSuffix(
      [participant.lid, participant.id],
      "@lid",
    );
    const phoneJid = firstJidWithSuffix(
      [participant.phoneNumber, participant.id],
      "@s.whatsapp.net",
    );
    const identity = externalJid || lidJid || phoneJid;
    if (!identity) {
      continue;
    }
    const participantJids = normalizedJidSet([
      externalJid,
      lidJid,
      phoneJid,
    ]);
    const isOwner = Array.from(participantJids).some((jid) =>
      ownerJids.has(jid),
    );
    normalized.set(identity, {
      externalJid: identity,
      lidJid,
      phoneJid,
      displayName: firstNonEmpty(
        participant.name,
        participant.notify,
        participant.verifiedName,
        participant.username,
      ),
      role: participantRole(participant, isOwner),
    });
  }
  return Array.from(normalized.values());
}

function participantRole(
  participant: GroupParticipant,
  isOwner: boolean,
): InboundGroupParticipant["role"] {
  if (
    isOwner ||
    participant.isSuperAdmin === true ||
    participant.admin === "superadmin"
  ) {
    return "owner";
  }
  if (participant.isAdmin === true || participant.admin === "admin") {
    return "admin";
  }
  return "member";
}

function roleForParticipantAction(
  current: InboundGroupParticipant["role"],
  action: GroupParticipantsUpdatePayload["action"],
): InboundGroupParticipant["role"] {
  if (action === "promote" && current === "member") {
    return "admin";
  }
  if (action === "demote") {
    return "member";
  }
  return current;
}

function identityLinksFromParticipants(
  participants: readonly InboundGroupParticipant[],
  source: InboundIdentityLinkSource,
  observedAt: string,
): InboundIdentityLink[] {
  return participants.flatMap((participant) => {
    if (!participant.phoneJid || !participant.lidJid) {
      return [];
    }
    return [
      {
        phoneJid: participant.phoneJid,
        lidJid: participant.lidJid,
        source,
        observedAt,
      },
    ];
  });
}

async function persistIdentityLinks(
  sink: InboundMessageSink,
  links: readonly InboundIdentityLink[],
): Promise<void> {
  if (!sink.upsertIdentityLinks || links.length === 0) {
    return;
  }
  const uniqueLinks = new Map<string, InboundIdentityLink>();
  for (const link of links) {
    uniqueLinks.set(`${link.phoneJid}\u0000${link.lidJid}`, link);
  }
  await sink.upsertIdentityLinks(Array.from(uniqueLinks.values()));
}

function normalizedJidSet(
  candidates: readonly (string | null | undefined)[],
): ReadonlySet<string> {
  return new Set(candidates.map(normalizeJid).filter(Boolean));
}

function firstJidWithSuffix(
  candidates: readonly (string | null | undefined)[],
  suffix: "@lid" | "@s.whatsapp.net",
): string | null {
  for (const candidate of candidates) {
    const jid = normalizeJid(candidate);
    if (jid.endsWith(suffix)) {
      return jid;
    }
  }
  return null;
}

function isPhoneJid(jid: string): boolean {
  return jid.endsWith("@s.whatsapp.net");
}

function isLidJid(jid: string): boolean {
  return jid.endsWith("@lid");
}

function firstNonEmpty(
  ...values: readonly (string | null | undefined)[]
): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

type InboundRuntimeEventSource = Extract<
  InboundRuntimeEvent,
  { type: "ingestion_error" }
>["source"];

async function persistBatch(
  options: BindInboundEventsOptions,
  messages: readonly WAMessage[],
  envelopes: readonly InboundMessageEnvelope[],
  enqueueMedia: (
    messages: readonly WAMessage[],
    envelopes: readonly InboundMessageEnvelope[],
  ) => void,
): Promise<void> {
  await options.sink.upsertMessages(envelopes);

  if (!options.mediaDownloader || !options.sink.storeMedia) {
    return;
  }
  enqueueMedia(messages, envelopes);
}

async function persistMediaBatch(
  options: BindInboundEventsOptions,
  messages: readonly WAMessage[],
  envelopes: readonly InboundMessageEnvelope[],
  now: () => Date,
): Promise<void> {
  const mediaDownloader = options.mediaDownloader;
  const storeMedia = options.sink.storeMedia;
  if (!mediaDownloader || !storeMedia) {
    return;
  }

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const envelope = envelopes[index];
    const attachment = envelope?.content.attachments[0];
    if (!message || !envelope || !attachment?.eligibleForAnalysis) {
      continue;
    }

    try {
      if (
        options.sink.hasMedia &&
        (await options.sink.hasMedia(attachment.idempotencyKey))
      ) {
        continue;
      }
      const media = await mediaDownloader.download(message, envelope);
      if (media) {
        await storeMedia.call(options.sink, media);
      }
    } catch (error: unknown) {
      try {
        await options.sink.emitRuntimeEvent?.({
          type: "ingestion_error",
          occurredAt: now().toISOString(),
          source: "media.download",
          errorMessage: errorMessage(error),
        });
      } catch {
        // Message persistence already succeeded. A media reporting failure must
        // not roll the batch back or lose subsequent messages.
      }
    }
  }
}

export function getDisconnectStatusCode(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  if (
    "statusCode" in error &&
    typeof (error as { statusCode?: unknown }).statusCode === "number"
  ) {
    return (error as { statusCode: number }).statusCode;
  }

  const output = (error as { output?: unknown }).output;
  if (
    output &&
    typeof output === "object" &&
    "statusCode" in output &&
    typeof (output as { statusCode?: unknown }).statusCode === "number"
  ) {
    return (output as { statusCode: number }).statusCode;
  }
  return null;
}

function nullableNumber(value: unknown): number | null {
  if (value == null) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
