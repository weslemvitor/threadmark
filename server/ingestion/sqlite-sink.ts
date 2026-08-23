import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { chmod, mkdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizeConversationSubject } from "../domain/conversation-subject.js";
import {
  isHumanParticipantDisplayName,
  preferredParticipantDisplayName,
} from "../domain/participant-identity.js";
import type { SupportStore } from "../domain/index.js";
import { analysePdf } from "../media/pdf-analysis.js";
import { readRuntimeCounts } from "../runtime/runtime-counts.js";
import type { RuntimeStateFile } from "../runtime/runtime-state.js";
import { queueRealtimeAudioTranscription } from "../transcription/index.js";
import type {
  DownloadedInboundMedia,
  InboundAttachment,
  InboundContactName,
  InboundGroupParticipant,
  InboundGroupParticipantUpdate,
  InboundGroupRoster,
  InboundIdentityLink,
  InboundMessageEnvelope,
  InboundMessageSink,
  InboundRuntimeEvent,
} from "../whatsapp/index.js";

export interface SqliteInboundSinkOptions {
  store: SupportStore;
  runtimeState: RuntimeStateFile;
  attachmentsDirectory: string;
  accountPhone: string;
  accountName: string;
}

export interface SqliteInboundSink extends InboundMessageSink {
  getEphemeralQr(): string | null;
  clearEphemeralQr(): void;
}

interface ConversationTriageCursor {
  enabledAt: string;
  watermarkAt: string | null;
}

function activeHistorySessionCursor(
  cached: ConversationTriageCursor | null,
  persisted: ConversationTriageCursor | null,
): ConversationTriageCursor | null {
  if (!cached) return persisted;
  if (!persisted) return cached;
  return persisted.enabledAt > cached.enabledAt ? persisted : cached;
}

export function createSqliteInboundSink(
  options: SqliteInboundSinkOptions,
): SqliteInboundSink {
  prepareSecureAttachmentsDirectory(options.attachmentsDirectory);
  let ephemeralQr: string | null = null;
  let historySessionActive = false;
  const historySessionCursorByChatJid = new Map<
    string,
    ConversationTriageCursor | null
  >();
  const beginHistorySession = () => {
    historySessionCursorByChatJid.clear();
    const rows = options.store.database
      .prepare(
        `SELECT external_jid, triage_enabled_at, triage_watermark_at
         FROM whatsapp_groups`,
      )
      .all() as Array<{
      external_jid: string;
      triage_enabled_at: string | null;
      triage_watermark_at: string | null;
    }>;
    for (const row of rows) {
      historySessionCursorByChatJid.set(
        row.external_jid,
        row.triage_enabled_at
          ? {
              enabledAt: row.triage_enabled_at,
              watermarkAt: row.triage_watermark_at,
            }
          : null,
      );
    }
    historySessionActive = true;
  };

  return {
    async upsertMessages(messages) {
      let insertedMessages = 0;
      const transaction = options.store.database.transaction(
        (batch: readonly InboundMessageEnvelope[]) => {
          const batchObservedAt = new Date().toISOString();
          const cursorByChatJid = new Map<
            string,
            ConversationTriageCursor | null
          >();
          for (const chatJid of new Set(batch.map((envelope) => envelope.chatJid))) {
            const existingGroup = findExistingGroup(options.store, chatJid);
            const persistedCursor = existingGroup
              ? options.store.getConversationTriageCursor(existingGroup.id)
              : null;
            const containsHistory = batch.some(
              (envelope) =>
                envelope.chatJid === chatJid && envelope.source === "history",
            );
            if (containsHistory && historySessionActive) {
              const sessionCursor = activeHistorySessionCursor(
                historySessionCursorByChatJid.get(chatJid) ?? null,
                persistedCursor,
              );
              historySessionCursorByChatJid.set(chatJid, sessionCursor);
              cursorByChatJid.set(chatJid, sessionCursor);
            } else {
              cursorByChatJid.set(chatJid, persistedCursor);
            }
          }
          const latestObservedByConversation = new Map<
            string,
            { occurredAt: string; hadCursor: boolean }
          >();
          const account = options.store.upsertAccount({
            phoneNumber: options.accountPhone,
            displayName: options.accountName,
          });

          for (const envelope of batch) {
            const existingGroup = findExistingGroup(options.store, envelope.chatJid);
            if (
              shouldSkipDirectConversationEnvelope(
                envelope,
                Boolean(existingGroup),
              )
            ) {
              continue;
            }
            const senderIdentities = envelope.fromMe
              ? []
              : [
                  envelope.participantJid,
                  envelope.participantAltJid,
                  envelope.scope === "direct" ? envelope.chatJid : null,
                ].filter((value): value is string => Boolean(value));
            const senderJid = envelope.fromMe
              ? `self:${options.accountPhone}`
              : senderIdentities[0] ?? `unknown:${envelope.idempotencyKey}`;
            const senderPhones = senderIdentities
              .map(phoneFromIdentity)
              .filter((value): value is string => Boolean(value));
            persistMessageIdentityLink(
              options.store,
              senderIdentities,
              envelope.occurredAt ?? new Date().toISOString(),
            );
            const existingParticipantIds = options.store.findParticipantIds({
              externalJids: senderIdentities,
              phoneE164s: senderPhones,
            });
            const existingName = existingParticipantName(
              options.store,
              existingParticipantIds,
            );
            const participant = options.store.upsertParticipant({
              externalJid: senderJid,
              phoneE164: senderPhones[0] ?? phoneFromIdentity(senderJid),
              displayName: envelope.fromMe
                ? options.accountName
                : envelope.participantDisplayName?.trim() ||
                  existingName ||
                  senderPhones[0] ||
                  phoneFromIdentity(senderJid) ||
                  senderJid,
            });
            if (envelope.isStaff) {
              options.store.setStaffMember(
                participant.id,
                envelope.fromMe
                  ? options.accountName
                  : envelope.participantDisplayName ?? options.accountName,
              );
            } else if (envelope.scope === "direct") {
              // A private inbound message is authoritative for the remote
              // contact. Group events may omit the alternate phone identity,
              // so startup reconciliation handles stale group flags safely.
              options.store.deactivateStaffMember(participant.id);
            }

            const subject = normalizeConversationSubject(
              directRemoteSubject(envelope, existingName) ||
                envelope.chatDisplayName?.trim() ||
                existingGroup?.subject ||
                conversationSubject(envelope),
              envelope.chatJid,
            );
            const participantMatches =
              envelope.scope === "direct" && !envelope.isStaff
                ? options.store.findParticipantClientMatches({
                    externalJids: senderIdentities,
                    phoneE164s: senderPhones,
                  })
                : [];
            const existingMatchedClient = participantMatches.find(
              (match) =>
                match.id === existingGroup?.clientId &&
                !existingGroup.clientIgnoredAt &&
                !existingGroup.clientIdentificationPending,
            );
            const ambiguousParticipant = participantMatches.length > 1;
            const manualAssociation =
              participantMatches.length > 0 &&
              existingGroup?.clientLinkSource === "manual" &&
              !existingGroup.clientIgnoredAt &&
              !existingGroup.clientIdentificationPending;
            let clientId: string;
            let clientLinkSource: "fallback" | "participant_match" | "manual" =
              existingGroup?.clientLinkSource ?? "fallback";
            let identificationPending = false;

            if (envelope.scope !== "direct" || participantMatches.length === 0) {
              clientId =
                existingGroup?.clientId ??
                createFallbackClient(
                  options.store,
                  subject,
                  envelope.chatJid,
                  envelope.scope,
                );
            } else if (manualAssociation && existingGroup) {
              clientId = existingGroup.clientId;
              clientLinkSource = "manual";
            } else if (participantMatches.length === 1) {
              clientId = participantMatches[0]?.id as string;
              clientLinkSource = "participant_match";
            } else if (existingMatchedClient) {
              // Keep a prior association only when it remains one of the
              // proven customer memberships. Never choose by recency.
              clientId = existingMatchedClient.id;
              clientLinkSource = existingGroup?.clientLinkSource ?? "participant_match";
            } else {
              identificationPending = true;
              clientLinkSource = "fallback";
              clientId =
                existingGroup &&
                !existingGroup.clientIgnoredAt &&
                existingGroup.clientIdentificationPending
                  ? existingGroup.clientId
                  : createFallbackClient(
                      options.store,
                      subject,
                      existingGroup?.clientIgnoredAt
                        ? `${envelope.chatJid}:review:${existingGroup.clientId}`
                        : `${envelope.chatJid}:review`,
                      "direct",
                    );
            }

            const clientIgnored =
              clientId === existingGroup?.clientId &&
              Boolean(existingGroup.clientIgnoredAt);
            const recoveredEligibleForReview = isRecoveredMessageAfterCursor(
              envelope,
              cursorByChatJid.get(envelope.chatJid) ?? null,
              participantMatches.length > 0,
            );
            const shouldTriage =
              (envelope.eligibleForTicket || recoveredEligibleForReview) &&
              !envelope.isStaff &&
              !clientIgnored &&
              !existingGroup?.suggestionsMuted &&
              (envelope.scope !== "direct" || participantMatches.length > 0) &&
              !isAudioOnlyMessage(envelope);
            const group = options.store.upsertGroup({
              accountId: account.id,
              clientId,
              externalJid: envelope.chatJid,
              subject,
              monitored:
                envelope.scope === "group" &&
                envelope.isAllowlistedGroup &&
                !clientIgnored,
              historyOldestAt:
                envelope.source === "history"
                  ? earliestTimestamp(existingGroup?.historyOldestAt, envelope.occurredAt)
                  : existingGroup?.historyOldestAt ?? null,
              historyNewestAt: latestTimestamp(
                existingGroup?.historyNewestAt,
                envelope.occurredAt,
              ),
              historyComplete: existingGroup?.historyComplete ?? false,
              clientLinkSource,
            });
            if (existingGroup && existingGroup.clientId !== clientId) {
              options.store.reassignGroupClient(group.id, clientId, clientLinkSource);
            } else if (
              existingGroup &&
              existingGroup.clientLinkSource !== clientLinkSource
            ) {
              options.store.reassignGroupClient(group.id, clientId, clientLinkSource);
            }
            if (identificationPending && ambiguousParticipant) {
              options.store.markClientIdentificationPending(clientId);
            }
            options.store.addGroupParticipant(group.id, participant.id);
            if (envelope.content.reaction) {
              options.store.upsertMessageReactionEvent({
                externalId: envelope.idempotencyKey,
                groupId: group.id,
                reactorId: participant.id,
                targetProviderMessageId:
                  envelope.content.reaction.targetProviderMessageId,
                emoji: envelope.content.reaction.emoji,
                occurredAt:
                  envelope.content.reaction.reactedAt ??
                  envelope.occurredAt ??
                  batchObservedAt,
                observedAt: batchObservedAt,
                raw: envelope.rawMessage,
              });
              continue;
            }
            if (envelope.content.revocation) {
              // A revoke is a control event, not a new chat message. The
              // original stored message intentionally remains untouched.
              continue;
            }
            if (envelope.content.messageType === "protocolMessage") {
              // Edits and other protocol controls are not chat bubbles. The
              // original message remains stored; the control envelope must
              // never become a blank message or enter supervised triage.
              continue;
            }
            if (tracksConversationCursor(envelope) && envelope.occurredAt) {
              const current = latestObservedByConversation.get(group.id);
              if (!current || envelope.occurredAt > current.occurredAt) {
                latestObservedByConversation.set(group.id, {
                  occurredAt: envelope.occurredAt,
                  hadCursor: cursorByChatJid.get(envelope.chatJid) !== null,
                });
              }
            }

            const message = options.store.upsertMessage({
              externalId: envelope.idempotencyKey,
              providerMessageId: envelope.providerMessageId,
              groupId: group.id,
              senderId: participant.id,
              occurredAt: envelope.occurredAt ?? new Date().toISOString(),
              text: envelope.content.text ?? envelope.content.caption,
              messageType: envelope.content.messageType ?? envelope.content.kind,
              quotedExternalId: envelope.content.quotedMessageId,
              triageKind: shouldTriage ? "unclassified" : "context",
              triageState: shouldTriage ? "unreviewed" : "context",
              ingestionSource: ingestionSource(envelope),
              raw: envelope.rawMessage,
            });
            if (message.inserted) insertedMessages += 1;

            for (const attachment of envelope.content.attachments) {
              const pendingAttachment = upsertPendingAttachment(
                options.store,
                message.id,
                attachment,
              );
              if (
                pendingAttachment &&
                attachment.kind === "audio" &&
                envelope.source !== "history" &&
                queueRealtimeAudioTranscription(
                  options.store.database,
                  pendingAttachment.id,
                  message.id,
                )
              ) {
                options.store.deferTriageForPendingAudio(message.id);
              }
            }
            if (envelope.isStaff && message.inserted) {
              if (envelope.source === "history") {
                options.store.captureHistoricalStaffResponse(message.id);
              } else {
                options.store.captureStaffResponse(message.id);
              }
            }
          }

          for (const [groupId, observation] of latestObservedByConversation) {
            options.store.advanceConversationTriageWatermark(
              groupId,
              observation.occurredAt,
              observation.hadCursor ? undefined : batchObservedAt,
            );
          }
        },
      );
      transaction(messages);

      const counts = readRuntimeCounts(options.store.database);
      await options.runtimeState.patch({
        messagesStored: counts.messagesStored,
        groupsDiscovered: counts.groupsDiscovered,
        groupsSynced: counts.groupsSynced,
        privateConversations: counts.privateConversations,
        ticketsCreated: counts.ticketsCreated,
        ...(insertedMessages > 0 ? { lastError: null } : {}),
      });
    },

    upsertIdentityLinks(links) {
      options.store.database.transaction(
        (batch: readonly InboundIdentityLink[]) => {
          for (const link of batch) {
            options.store.upsertIdentityLink(link);
          }
        },
      )(links);
    },

    upsertContactNames(contacts) {
      options.store.database.transaction(
        (batch: readonly InboundContactName[]) => {
          for (const contact of batch) {
            const phoneE164 = phoneFromIdentity(contact.externalJid);
            const participantIds = options.store.findParticipantIds({
              externalJids: [contact.externalJid],
              phoneE164s: phoneE164 ? [phoneE164] : [],
            });
            if (!participantIds.length) continue;
            const participants = options.store.database
              .prepare(
                `SELECT id, external_jid, phone_e164, display_name
                 FROM participants
                 WHERE id IN (${participantIds.map(() => "?").join(", ")})`,
              )
              .all(...participantIds) as Array<{
              id: string;
              external_jid: string;
              phone_e164: string | null;
              display_name: string;
            }>;
            const update = options.store.database.prepare(
              `UPDATE participants
               SET display_name = ?, updated_at = ?
               WHERE id = ? AND display_name != ?`,
            );
            for (const participant of participants) {
              const displayName = preferredParticipantDisplayName({
                externalJid: participant.external_jid,
                phoneE164: participant.phone_e164,
                incoming: contact.displayName,
                existing: participant.display_name,
              });
              update.run(
                displayName,
                contact.observedAt,
                participant.id,
                displayName,
              );
            }
          }
        },
      )(contacts);
    },

    syncGroupRosters(rosters) {
      options.store.database.transaction(
        (batch: readonly InboundGroupRoster[]) => {
          const account = options.store.upsertAccount({
            phoneNumber: options.accountPhone,
            displayName: options.accountName,
          });
          for (const roster of batch) {
            const existingGroup = findExistingGroup(options.store, roster.groupJid);
            const subject = roster.subject.trim() || existingGroup?.subject || roster.groupJid;
            syncFallbackClientName(
              options.store,
              existingGroup,
              subject,
              roster.groupJid,
              roster.observedAt,
            );
            const clientId =
              existingGroup?.clientId ??
              createFallbackClient(options.store, subject, roster.groupJid, "group");
            const group = options.store.upsertGroup({
              accountId: account.id,
              clientId,
              externalJid: roster.groupJid,
              subject,
              monitored: existingGroup?.monitored ?? false,
              historyOldestAt: existingGroup?.historyOldestAt ?? null,
              historyNewestAt: existingGroup?.historyNewestAt ?? null,
              historyComplete: existingGroup?.historyComplete ?? false,
              clientLinkSource: existingGroup?.clientLinkSource ?? "fallback",
            });
            const activeParticipantIds = roster.participants.flatMap((participant) => {
              const participantIds = upsertRosterParticipant(
                options.store,
                group.id,
                participant,
                "group_roster",
                roster.observedAt,
              );
              return participantIds;
            });
            options.store.replaceActiveGroupRoster(
              group.id,
              activeParticipantIds,
              roster.observedAt,
            );
          }
        },
      )(rosters);
    },

    applyGroupParticipantsUpdate(update) {
      options.store.database.transaction(
        (event: InboundGroupParticipantUpdate) => {
          const existingGroup = findExistingGroup(options.store, event.groupJid);
          if (event.action === "remove") {
            if (!existingGroup) return;
            const identities = participantIdentities(event.participants);
            const participantIds = options.store.findParticipantIds({
              externalJids: identities,
              phoneE164s: identities
                .map(phoneFromIdentity)
                .filter((value): value is string => Boolean(value)),
            });
            options.store.deactivateGroupParticipants(
              existingGroup.id,
              participantIds,
              event.observedAt,
            );
            return;
          }

          const account = options.store.upsertAccount({
            phoneNumber: options.accountPhone,
            displayName: options.accountName,
          });
          const subject = existingGroup?.subject || `Grupo ${event.groupJid.split("@")[0]}`;
          const clientId =
            existingGroup?.clientId ??
            createFallbackClient(options.store, subject, event.groupJid, "group");
          const group = options.store.upsertGroup({
            accountId: account.id,
            clientId,
            externalJid: event.groupJid,
            subject,
            monitored: existingGroup?.monitored ?? false,
            historyOldestAt: existingGroup?.historyOldestAt ?? null,
            historyNewestAt: existingGroup?.historyNewestAt ?? null,
            historyComplete: existingGroup?.historyComplete ?? false,
            clientLinkSource: existingGroup?.clientLinkSource ?? "fallback",
          });
          for (const participant of event.participants) {
            upsertRosterParticipant(
              options.store,
              group.id,
              participant,
              "group_participant_update",
              event.observedAt,
            );
          }
        },
      )(update);
    },

    hasMedia(sourceKey) {
      return options.store.hasAttachmentSourceKey(sourceKey);
    },

    async storeMedia(media) {
      await persistDownloadedMedia(options, media);
    },

    async emitRuntimeEvent(event) {
      if (event.type === "qr") ephemeralQr = event.qr;
      if (event.type === "connection" && event.state === "open") {
        ephemeralQr = null;
        beginHistorySession();
      } else if (event.type === "connection" && event.state === "close") {
        historySessionCursorByChatJid.clear();
        historySessionActive = false;
      }
      if (event.type === "history_sync" && event.status === "batch") {
        if (!historySessionActive) {
          beginHistorySession();
        }
      }
      if (event.type === "history_sync" && event.status === "complete") {
        options.store.database
          .prepare(
            `UPDATE whatsapp_groups
             SET history_complete = 1, updated_at = ?
             WHERE history_complete = 0`,
          )
          .run(event.occurredAt);
        historySessionCursorByChatJid.clear();
        historySessionActive = false;
      }
      await applyRuntimeEvent(options.runtimeState, event);
    },

    getEphemeralQr() {
      return ephemeralQr;
    },

    clearEphemeralQr() {
      ephemeralQr = null;
    },
  };
}

function upsertPendingAttachment(
  store: SupportStore,
  messageId: string,
  attachment: InboundAttachment,
): { id: string } | null {
  if (store.hasAttachmentSourceKey(attachment.idempotencyKey)) return null;
  const placeholderHash = `pending-${createHash("sha256")
    .update(attachment.idempotencyKey)
    .digest("hex")}`;
  return store.upsertAttachment({
    messageId,
    sourceKey: attachment.idempotencyKey,
    kind: attachmentKind(attachment),
    mimeType: attachment.mimeType ?? "application/octet-stream",
    fileName: attachment.fileName,
    localPath: `unavailable://${attachment.idempotencyKey}`,
    sizeBytes: attachment.sizeBytes,
    sha256: placeholderHash,
    available: false,
  });
}

async function persistDownloadedMedia(
  options: SqliteInboundSinkOptions,
  media: DownloadedInboundMedia,
): Promise<void> {
  const message = options.store.database
    .prepare(
      `SELECT id, occurred_at, ingestion_source
       FROM messages WHERE external_id = ? LIMIT 1`,
    )
    .get(media.messageIdempotencyKey) as
    | { id: string; occurred_at: string; ingestion_source: string }
    | undefined;
  if (!message) {
    throw new Error(`Mensagem não encontrada para mídia ${media.idempotencyKey}`);
  }

  const date = new Date(message.occurred_at);
  const folder = path.join(
    options.attachmentsDirectory,
    String(date.getUTCFullYear()),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
  );
  const pdf = isPdf(media);
  const extension = safeExtension(media, pdf);
  const localPath = path.join(folder, `${media.sha256Hex}${extension}`);
  await writeOnce(localPath, media.bytes);

  let extractedText: string | null = null;
  let rasterizedPages: Awaited<ReturnType<typeof analysePdf>>["rasterizedPages"] = [];
  if (pdf) {
    try {
      const analysis = await analysePdf(media.bytes);
      extractedText = analysis.text || null;
      rasterizedPages = analysis.rasterizedPages;
    } catch {
      // The original PDF remains available even when text extraction fails.
    }
  }

  const storedAttachment = options.store.upsertAttachment({
    messageId: message.id,
    sourceKey: media.idempotencyKey,
    kind:
      pdf
        ? "pdf"
        : media.kind === "image"
          ? "image"
          : media.kind === "audio"
            ? "audio"
            : "document",
    mimeType: media.mimeType ?? (pdf ? "application/pdf" : "application/octet-stream"),
    fileName: media.fileName,
    localPath,
    sizeBytes: media.sizeBytes,
    sha256: media.sha256Hex,
    extractedText,
    available: true,
  });

  if (media.kind === "audio" && message.ingestion_source !== "history") {
    const queued = queueRealtimeAudioTranscription(
      options.store.database,
      storedAttachment.id,
      message.id,
    );
    if (queued) options.store.deferTriageForPendingAudio(message.id);
  }

  for (const page of rasterizedPages) {
    const pageHash = createHash("sha256").update(page.png).digest("hex");
    const pagePath = path.join(folder, `${media.sha256Hex}-page-${page.pageNumber}.png`);
    await writeOnce(pagePath, page.png);
    options.store.upsertAttachment({
      messageId: message.id,
      sourceKey: `${media.idempotencyKey}:page:${page.pageNumber}`,
      kind: "image",
      mimeType: "image/png",
      fileName: `${media.fileName ?? "documento"} · página ${page.pageNumber}.png`,
      localPath: pagePath,
      sizeBytes: page.png.byteLength,
      sha256: pageHash,
      available: true,
    });
  }

  requeueMessageAfterAnalysableMedia(options.store, message.id);
}

async function writeOnce(filePath: string, bytes: Uint8Array): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(filePath), 0o700);
  try {
    await stat(filePath);
    await chmod(filePath, 0o600);
    return;
  } catch {
    // Write atomically below.
  }
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  try {
    await rename(temporary, filePath);
    await chmod(filePath, 0o600);
  } catch (error) {
    try {
      await stat(filePath);
      await chmod(filePath, 0o600);
    } catch {
      throw error;
    }
  }
}

function persistMessageIdentityLink(
  store: SupportStore,
  identities: readonly string[],
  observedAt: string,
): void {
  const phoneJid = identities.find((identity) => identity.endsWith("@s.whatsapp.net"));
  const lidJid = identities.find((identity) => identity.endsWith("@lid"));
  if (!phoneJid || !lidJid) return;
  store.upsertIdentityLink({
    phoneJid,
    lidJid,
    source: "message",
    observedAt,
  });
}

function participantIdentities(
  participants: readonly InboundGroupParticipant[],
): string[] {
  return [
    ...new Set(
      participants
        .flatMap((participant) => [
          participant.externalJid,
          participant.lidJid,
          participant.phoneJid,
        ])
        .filter((value): value is string => Boolean(value)),
    ),
  ];
}

function upsertRosterParticipant(
  store: SupportStore,
  groupId: string,
  participant: InboundGroupParticipant,
  source: "group_roster" | "group_participant_update",
  observedAt: string,
): string[] {
  const identities = participantIdentities([participant]);
  const phoneE164s = identities
    .map(phoneFromIdentity)
    .filter((value): value is string => Boolean(value));
  const existingParticipantIds = store.findParticipantIds({
    externalJids: identities,
    phoneE164s,
  });
  const existingName = existingParticipantName(store, existingParticipantIds);
  const primary = participant.externalJid || participant.lidJid || participant.phoneJid;
  if (!primary) return [];
  const record = store.upsertParticipant({
    externalJid: primary,
    phoneE164: phoneE164s[0] ?? null,
    displayName:
      participant.displayName?.trim() ||
      existingName ||
      phoneE164s[0] ||
      primary,
  });
  const participantIds = [...new Set([...existingParticipantIds, record.id])];
  for (const participantId of participantIds) {
    store.addGroupParticipant(
      groupId,
      participantId,
      participant.role,
      source,
      observedAt,
    );
  }
  return participantIds;
}

function existingParticipantName(
  store: SupportStore,
  participantIds: readonly string[],
): string | null {
  if (!participantIds.length) return null;
  const rows = store.database
    .prepare(
      `SELECT display_name, external_jid, phone_e164
       FROM participants
       WHERE id IN (${participantIds.map(() => "?").join(", ")})
       ORDER BY updated_at DESC`,
    )
    .all(...participantIds) as Array<{
      display_name: string;
      external_jid: string;
      phone_e164: string | null;
    }>;
  return (
    rows.find((row) =>
      isHumanParticipantDisplayName(row.display_name, [
        row.external_jid,
        row.phone_e164,
      ]),
    )?.display_name ?? null
  );
}

interface ExistingGroup {
  id: string;
  clientId: string;
  clientIgnoredAt: string | null;
  clientManualOverride: boolean;
  clientHasGroupConversation: boolean;
  clientIdentificationPending: boolean;
  clientLinkSource: "fallback" | "participant_match" | "manual";
  monitored: boolean;
  suggestionsMuted: boolean;
  subject: string;
  historyOldestAt: string | null;
  historyNewestAt: string | null;
  historyComplete: boolean;
}

function findExistingGroup(
  store: SupportStore,
  externalJid: string,
): ExistingGroup | null {
  const row = store.database
    .prepare(
      `SELECT g.id, g.client_id, g.monitored, g.suggestions_muted_at,
              g.client_link_source,
              c.ignored_at AS client_ignored_at,
              c.manual_override AS client_manual_override,
              c.identification_pending AS client_identification_pending,
              EXISTS (
                SELECT 1 FROM whatsapp_groups client_group
                WHERE client_group.client_id = c.id
                  AND client_group.external_jid LIKE '%@g.us'
              ) AS client_has_group_conversation,
              g.subject,
              g.history_oldest_at, g.history_newest_at, g.history_complete
       FROM whatsapp_groups g
       JOIN clients c ON c.id = g.client_id
       WHERE g.external_jid = ?`,
    )
    .get(externalJid) as
    | {
        id: string;
        client_id: string;
        monitored: number;
        suggestions_muted_at: string | null;
        client_link_source: "fallback" | "participant_match" | "manual";
        client_ignored_at: string | null;
        client_manual_override: number;
        client_has_group_conversation: number;
        client_identification_pending: number;
        subject: string;
        history_oldest_at: string | null;
        history_newest_at: string | null;
        history_complete: number;
      }
    | undefined;
  return row
    ? {
        id: row.id,
        clientId: row.client_id,
        clientIgnoredAt: row.client_ignored_at,
        clientManualOverride: Boolean(row.client_manual_override),
        clientHasGroupConversation: Boolean(row.client_has_group_conversation),
        clientIdentificationPending: Boolean(row.client_identification_pending),
        clientLinkSource: row.client_link_source,
        monitored: Boolean(row.monitored),
        suggestionsMuted: Boolean(row.suggestions_muted_at),
        subject: row.subject,
        historyOldestAt: row.history_oldest_at,
        historyNewestAt: row.history_newest_at,
        historyComplete: Boolean(row.history_complete),
      }
    : null;
}

function createFallbackClient(
  store: SupportStore,
  subject: string,
  externalJid: string,
  scope: InboundMessageEnvelope["scope"],
): string {
  return store.upsertClient({
    name: scope === "direct" ? "Cliente não identificado" : subject,
    slug: clientSlug(subject, externalJid),
    kind: "ecommerce",
    notes:
      scope === "direct"
        ? "Contato privado armazenado como contexto; novas demandas devem ser associadas a uma agência ou ecommerce."
        : "Criado automaticamente a partir do grupo WhatsApp; confirme se é agência ou ecommerce.",
  }).id;
}

function syncFallbackClientName(
  store: SupportStore,
  group: ExistingGroup | null,
  subject: string,
  externalJid: string,
  observedAt: string,
): void {
  if (
    !group ||
    group.clientLinkSource !== "fallback" ||
    group.clientManualOverride ||
    isTechnicalGroupName(subject, externalJid)
  ) {
    return;
  }
  const currentName = store.database
    .prepare("SELECT name FROM clients WHERE id = ?")
    .pluck()
    .get(group.clientId) as string | undefined;
  if (!currentName || !isTechnicalGroupName(currentName, externalJid)) return;
  store.database
    .prepare(
      `UPDATE clients
       SET name = ?, updated_at = ?
       WHERE id = ? AND manual_override = 0`,
    )
    .run(subject, observedAt, group.clientId);
}

function isTechnicalGroupName(value: string, externalJid: string): boolean {
  const candidate = value.trim().toLocaleLowerCase("pt-BR");
  const id = externalJid.split("@")[0]?.trim().toLocaleLowerCase("pt-BR") ?? "";
  return Boolean(
    id &&
      (candidate === externalJid.toLocaleLowerCase("pt-BR") ||
        candidate === id ||
        candidate === `grupo ${id}`),
  );
}

function earliestTimestamp(
  current: string | null | undefined,
  incoming: string | null,
): string | null {
  if (!current) return incoming;
  if (!incoming) return current;
  return incoming < current ? incoming : current;
}

function latestTimestamp(
  current: string | null | undefined,
  incoming: string | null,
): string | null {
  if (!current) return incoming;
  if (!incoming) return current;
  return incoming > current ? incoming : current;
}

function isRecoveredMessageAfterCursor(
  envelope: InboundMessageEnvelope,
  cursor: ConversationTriageCursor | null,
  directParticipantIsLinked: boolean,
): boolean {
  const isRecoveredMessage =
    envelope.source === "history" ||
    (envelope.source === "realtime" &&
      "upsertType" in envelope.observedAs &&
      envelope.observedAs.upsertType === "append");
  if (
    !isRecoveredMessage ||
    envelope.isStaff ||
    !envelope.occurredAt ||
    !cursor ||
    (envelope.scope === "group" && !envelope.isAllowlistedGroup) ||
    (envelope.scope === "direct" && !directParticipantIsLinked)
  ) {
    return false;
  }

  const cutoff =
    cursor.watermarkAt && cursor.watermarkAt > cursor.enabledAt
      ? cursor.watermarkAt
      : cursor.enabledAt;
  return envelope.occurredAt > cutoff;
}

function tracksConversationCursor(envelope: InboundMessageEnvelope): boolean {
  return (
    envelope.scope === "direct" ||
    (envelope.scope === "group" && envelope.isAllowlistedGroup)
  );
}

function requeueMessageAfterAnalysableMedia(
  store: SupportStore,
  messageId: string,
): void {
  store.database
    .prepare(
      `UPDATE messages
       SET triage_kind = 'unclassified', triage_state = 'unreviewed', updated_at = ?
       WHERE id = ?
         AND triage_state = 'ignored'
         AND NOT EXISTS (
           SELECT 1 FROM whatsapp_groups conversation
           WHERE conversation.id = messages.group_id
             AND conversation.suggestions_muted_at IS NOT NULL
         )
         AND EXISTS (
           SELECT 1 FROM attachments
           WHERE message_id = messages.id
             AND available = 1
             AND kind IN ('image', 'pdf', 'document')
         )
         AND NOT EXISTS (
           SELECT 1 FROM ticket_messages WHERE message_id = messages.id
         )`,
    )
    .run(new Date().toISOString(), messageId);
}

function prepareSecureAttachmentsDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stats = lstatSync(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("Attachments path must be a real local directory");
  }
  chmodSync(directory, 0o700);
}

async function applyRuntimeEvent(
  runtimeState: RuntimeStateFile,
  event: InboundRuntimeEvent,
): Promise<void> {
  switch (event.type) {
    case "qr":
      await runtimeState.patch({
        phase: "waiting_qr",
        qrAvailable: true,
        whatsappConnected: false,
      });
      break;
    case "connection":
      await runtimeState.patch({
        phase:
          event.state === "open"
            ? "online"
            : event.state === "connecting"
              ? "starting"
              : "offline",
        qrAvailable: false,
        whatsappConnected: event.state === "open",
        lastError: event.errorMessage,
      });
      break;
    case "history_sync":
      await runtimeState.patch({
        phase: event.status === "complete" ? "online" : "syncing",
      });
      break;
    case "ingestion_error":
      await runtimeState.patch({ phase: "error", lastError: event.errorMessage });
      break;
  }
}

function conversationSubject(envelope: InboundMessageEnvelope): string {
  if (envelope.scope === "direct") {
    return (
      envelope.chatDisplayName?.trim() ||
      envelope.participantDisplayName?.trim() ||
      phoneFromIdentity(envelope.chatJid) ||
      `Conversa privada ${envelope.chatJid.split("@")[0]}`
    );
  }
  return envelope.chatDisplayName?.trim() || `Grupo ${envelope.chatJid.split("@")[0]}`;
}

function directRemoteSubject(
  envelope: InboundMessageEnvelope,
  existingParticipantName: string | null,
): string | null {
  if (envelope.scope !== "direct" || envelope.isStaff) return null;
  const incomingName = envelope.participantDisplayName?.trim();
  if (
    incomingName &&
    isHumanParticipantDisplayName(incomingName, [
      envelope.chatJid,
      envelope.participantJid,
      envelope.participantAltJid,
    ])
  ) {
    return incomingName;
  }
  return existingParticipantName;
}

function shouldSkipDirectConversationEnvelope(
  envelope: InboundMessageEnvelope,
  conversationExists: boolean,
): boolean {
  if (envelope.scope !== "direct") return false;
  if (
    envelope.content.revocation ||
    envelope.content.messageType === "protocolMessage"
  ) {
    return true;
  }
  if (envelope.content.reaction) {
    return !conversationExists;
  }
  if (
    envelope.content.text?.trim() ||
    envelope.content.caption?.trim() ||
    envelope.content.attachments.length
  ) {
    return false;
  }

  // Unknown/rich WhatsApp message types can carry useful text in rawMessage.
  // Only empty system envelopes are safe to discard here.
  return envelope.content.kind === "system";
}

function ingestionSource(
  envelope: InboundMessageEnvelope,
): "history" | "realtime_append" | "realtime_notify" {
  if (envelope.source === "history") return "history";
  return "upsertType" in envelope.observedAs && envelope.observedAs.upsertType === "notify"
    ? "realtime_notify"
    : "realtime_append";
}

function clientSlug(subject: string, jid: string): string {
  const base = subject
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 55) || "grupo";
  return `${base}-${createHash("sha256").update(jid).digest("hex").slice(0, 8)}`;
}

function phoneFromIdentity(identity: string): string | null {
  if (identity.includes("@lid") || identity.startsWith("unknown:") || identity.startsWith("self:")) {
    return null;
  }
  const digits = identity.split("@")[0]?.split(":")[0]?.replace(/\D/g, "") ?? "";
  return digits.length >= 8 ? `+${digits}` : null;
}

function attachmentKind(attachment: InboundAttachment): "image" | "pdf" | "document" | "video" | "audio" | "other" {
  if (attachment.kind === "image") return "image";
  if (attachment.kind === "video") return "video";
  if (attachment.kind === "audio") return "audio";
  if (attachment.kind === "document") {
    return attachment.mimeType === "application/pdf" || attachment.fileName?.toLowerCase().endsWith(".pdf")
      ? "pdf"
      : "document";
  }
  return "other";
}

function isPdf(media: DownloadedInboundMedia): boolean {
  return (
    media.mimeType?.toLowerCase() === "application/pdf" ||
    media.fileName?.toLowerCase().endsWith(".pdf") === true
  );
}

function safeExtension(media: DownloadedInboundMedia, pdf: boolean): string {
  if (pdf) return ".pdf";
  const fromName = path.extname(media.fileName ?? "").toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(fromName)) return fromName;
  const mimeExtension: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "audio/ogg": ".ogg",
    "audio/ogg; codecs=opus": ".ogg",
    "audio/opus": ".opus",
  };
  return mimeExtension[media.mimeType?.toLowerCase() ?? ""] ?? ".bin";
}

function isAudioOnlyMessage(envelope: InboundMessageEnvelope): boolean {
  return (
    !envelope.content.text?.trim() &&
    envelope.content.attachments.some((attachment) => attachment.kind === "audio")
  );
}
