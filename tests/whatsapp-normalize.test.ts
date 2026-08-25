import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { proto, type WAMessage } from "baileys";

import {
  normalizeHistoryContacts,
  normalizeHistorySet,
  normalizeMessagesUpsert,
  type HistorySetPayload,
  type MessagesUpsertPayload,
} from "../server/whatsapp/index.js";

const groupJid = "120363000000000000@g.us";
const otherGroupJid = "120363999999999999@g.us";
const customerJid = "5511999999999@s.whatsapp.net";
const staffJid = "5511888888888@s.whatsapp.net";

describe("WhatsApp inbound normalization", () => {
  it("normaliza nomes da agenda do histórico para todos os aliases conhecidos", () => {
    const contacts = normalizeHistoryContacts(
      {
        chats: [],
        contacts: [
          {
            id: "5511999999999@s.whatsapp.net",
            lid: "123456789@lid",
            phoneNumber: "5511999999999@s.whatsapp.net",
            notify: "Pessoa Fictícia Eta",
          },
        ],
        messages: [],
      },
      "2026-08-21T14:00:00.000Z",
    );

    assert.deepEqual(contacts, [
      {
        externalJid: "123456789@lid",
        displayName: "Pessoa Fictícia Eta",
        observedAt: "2026-08-21T14:00:00.000Z",
      },
      {
        externalJid: "5511999999999@s.whatsapp.net",
        displayName: "Pessoa Fictícia Eta",
        observedAt: "2026-08-21T14:00:00.000Z",
      },
    ]);
  });

  it("normalizes group history as stored context, never as a retroactive candidate", () => {
    const message = textMessage({
      id: "HISTORY-1",
      participant: customerJid,
      text: "Os pedidos de hoje não apareceram",
    });
    const payload: HistorySetPayload = {
      chats: [{ id: groupJid, name: "Agência Norte" }],
      contacts: [{ id: customerJid, name: "Pessoa Fictícia Eta" }],
      messages: [message],
      isLatest: false,
      progress: 42,
      syncType: 1,
      chunkOrder: 3,
      peerDataRequestSessionId: "sync-1",
    };

    const [envelope] = normalizeHistorySet(payload, {
      allowlistedGroupJids: [groupJid],
      staffIdentities: [staffJid],
    });

    assert.ok(envelope);
    assert.equal(envelope.source, "history");
    assert.equal(envelope.chatDisplayName, "Agência Norte");
    assert.equal(envelope.participantDisplayName, "Pessoa Fictícia Eta");
    assert.equal(envelope.scope, "group");
    assert.equal(envelope.isAllowlistedGroup, true);
    assert.equal(envelope.isStaff, false);
    assert.equal(envelope.eligibleForTicket, false);
    assert.equal(envelope.content.kind, "text");
    assert.equal(
      envelope.content.text,
      "Os pedidos de hoje não apareceram",
    );
    assert.equal(envelope.occurredAt, "2024-03-09T16:00:00.000Z");
    assert.deepEqual(envelope.observedAs, {
      syncType: 1,
      progress: 42,
      isLatest: false,
      chunkOrder: 3,
      peerDataRequestSessionId: "sync-1",
    });
  });

  it("sends only notify realtime from an allowlisted group to supervised triage", () => {
    const message = textMessage({
      id: "GROUP-REALTIME-1",
      participant: customerJid,
      text: "Os pedidos de hoje não apareceram",
    });
    const [append] = normalizeMessagesUpsert(
      { messages: [message], type: "append" },
      { allowlistedGroupJids: [groupJid] },
    );
    const [notify] = normalizeMessagesUpsert(
      { messages: [message], type: "notify" },
      { allowlistedGroupJids: [groupJid] },
    );

    assert.equal(append?.eligibleForTicket, false);
    assert.equal(notify?.eligibleForTicket, true);
  });

  it("uses the same idempotency key for history and real-time redelivery", () => {
    const message = textMessage({
      id: "DUPLICATE-1",
      participant: customerJid,
      text: "Continua com erro",
    });
    const [history] = normalizeHistorySet({
      chats: [],
      contacts: [],
      messages: [message],
    });
    const [realtime] = normalizeMessagesUpsert({
      messages: [message],
      type: "notify",
    });

    assert.ok(history);
    assert.ok(realtime);
    assert.equal(history.idempotencyKey, realtime.idempotencyKey);
    assert.equal(history.source, "history");
    assert.equal(realtime.source, "realtime");
  });

  it("retains staff and non-allowlisted messages as non-ticket context", () => {
    const payload: MessagesUpsertPayload = {
      type: "notify",
      messages: [
        textMessage({
          id: "STAFF-1",
          participant: staffJid,
          text: "Já estamos verificando",
        }),
        textMessage({
          id: "OUTSIDE-1",
          participant: customerJid,
          remoteJid: otherGroupJid,
          text: "Preciso de ajuda",
        }),
        textMessage({
          id: "OWN-1",
          fromMe: true,
          text: "Resposta enviada pelo comercial",
        }),
      ],
    };

    const envelopes = normalizeMessagesUpsert(payload, {
      allowlistedGroupJids: [groupJid],
      staffIdentities: ["+55 (11) 88888-8888"],
    });

    assert.equal(envelopes.length, 3);
    assert.equal(envelopes[0]?.isStaff, true);
    assert.equal(envelopes[0]?.eligibleForTicket, false);
    assert.equal(envelopes[1]?.isAllowlistedGroup, false);
    assert.equal(envelopes[1]?.eligibleForTicket, false);
    assert.equal(envelopes[2]?.fromMe, true);
    assert.equal(envelopes[2]?.isStaff, true);
    assert.equal(envelopes[2]?.eligibleForTicket, false);
  });

  it("sends only new inbound private messages to triage", () => {
    const directMessage = textMessage({
      id: "DIRECT-1",
      remoteJid: customerJid,
      participant: undefined,
      text: "Como funciona a métrica total de clientes?",
    });

    const [history] = normalizeHistorySet({
      chats: [{ id: customerJid, name: "Contato antigo" }],
      contacts: [{ id: customerJid, name: "Contato antigo" }],
      messages: [directMessage],
    });
    const [append] = normalizeMessagesUpsert({
      messages: [directMessage],
      type: "append",
    });
    const [notify] = normalizeMessagesUpsert({
      messages: [directMessage],
      type: "notify",
    });

    assert.equal(history?.scope, "direct");
    assert.equal(history?.eligibleForTicket, false);
    assert.equal(append?.eligibleForTicket, false);
    assert.equal(notify?.scope, "direct");
    assert.equal(notify?.eligibleForTicket, true);
  });

  it("reconhece funcionário privado quando o evento traz somente o alias LID", () => {
    const staffLid = "900000000000108@lid";
    const message = textMessage({
      id: "DIRECT-STAFF-LID",
      remoteJid: staffJid,
      participant: staffLid,
      text: "Vou verificar este atendimento.",
    });
    const [envelope] = normalizeMessagesUpsert(
      { messages: [message], type: "notify" },
      { staffIdentities: [staffLid] },
    );

    assert.equal(envelope?.participantJid, staffLid);
    assert.equal(envelope?.isStaff, true);
    assert.equal(envelope?.eligibleForTicket, false);
  });

  it("preserva o envelope de REVOKE como controle sem torná-lo elegível para ticket", () => {
    const [envelope] = normalizeMessagesUpsert(
      {
        messages: [
          protocolMessage({
            id: "REVOKE-EVENT-1",
            targetId: "ORIGINAL-MESSAGE-1",
            type: proto.Message.ProtocolMessage.Type.REVOKE,
          }),
        ],
        type: "notify",
      },
      { allowlistedGroupJids: [groupJid] },
    );

    assert.ok(envelope);
    assert.equal(envelope.content.kind, "system");
    assert.equal(envelope.content.messageType, "protocolMessage");
    assert.equal(envelope.content.text, null);
    assert.deepEqual(envelope.content.revocation, {
      targetProviderMessageId: "ORIGINAL-MESSAGE-1",
    });
    assert.equal(envelope.eligibleForTicket, false);
  });

  it("trata MESSAGE_EDIT como controle sem bolha elegível para ticket", () => {
    const [envelope] = normalizeMessagesUpsert(
      {
        messages: [
          protocolMessage({
            id: "EDIT-EVENT-1",
            targetId: "ORIGINAL-MESSAGE-2",
            type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
            editedMessage: { conversation: "Texto corrigido" },
          }),
        ],
        type: "notify",
      },
      { allowlistedGroupJids: [groupJid] },
    );

    assert.ok(envelope);
    assert.equal(envelope.content.messageType, "protocolMessage");
    assert.equal(envelope.content.revocation, undefined);
    assert.equal(envelope.eligibleForTicket, false);
  });

  it("trata atualização administrativa de grupo como metadado não elegível", () => {
    const update: WAMessage = {
      key: {
        id: "GROUP-STUB-1",
        remoteJid: groupJid,
        participant: customerJid,
        fromMe: false,
      },
      messageTimestamp: 1_710_000_000,
      messageStubType: 27 as proto.WebMessageInfo.StubType,
      messageStubParameters: [
        '{"id":"900000000000108@lid","admin":null}',
      ],
    };
    const [envelope] = normalizeMessagesUpsert(
      { messages: [update], type: "notify" },
      { allowlistedGroupJids: [groupJid] },
    );

    assert.ok(envelope);
    assert.equal(envelope.content.kind, "system");
    assert.equal(envelope.eligibleForTicket, false);
  });

  it("normaliza reação com alvo, emoji e horário sem torná-la elegível para ticket", () => {
    const [envelope] = normalizeMessagesUpsert(
      {
        messages: [
          reactionMessage({
            id: "REACTION-EVENT-1",
            targetId: "ORIGINAL-MESSAGE-3",
            emoji: "❤️",
            senderTimestampMs: 1_710_000_000_123,
          }),
        ],
        type: "notify",
      },
      { allowlistedGroupJids: [groupJid] },
    );

    assert.ok(envelope);
    assert.equal(envelope.content.kind, "reaction");
    assert.equal(envelope.content.quotedMessageId, "ORIGINAL-MESSAGE-3");
    assert.deepEqual(envelope.content.reaction, {
      targetProviderMessageId: "ORIGINAL-MESSAGE-3",
      emoji: "❤️",
      reactedAt: "2024-03-09T16:00:00.123Z",
    });
    assert.equal(envelope.eligibleForTicket, false);
  });

  it("extrai texto de templates e convites em vez de criar bolhas vazias", () => {
    const template: WAMessage = {
      key: {
        id: "RICH-TEMPLATE-1",
        remoteJid: customerJid,
        fromMe: false,
      },
      messageTimestamp: 1_710_000_000,
      message: {
        templateMessage: {
          hydratedFourRowTemplate: {
            hydratedContentText: "Atualização importante sobre seu atendimento",
          },
        },
      },
    };
    const invite: WAMessage = {
      key: {
        id: "GROUP-INVITE-1",
        remoteJid: customerJid,
        fromMe: false,
      },
      messageTimestamp: 1_710_000_001,
      message: {
        groupInviteMessage: {
          groupJid,
          groupName: "Comunidade Acme",
          caption: "Entre no grupo de acompanhamento",
        },
      },
    };

    const [normalizedTemplate, normalizedInvite] = normalizeMessagesUpsert({
      type: "append",
      messages: [template, invite],
    });

    assert.equal(
      normalizedTemplate?.content.text,
      "Atualização importante sobre seu atendimento",
    );
    assert.equal(normalizedTemplate?.content.kind, "text");
    assert.equal(
      normalizedInvite?.content.text,
      "Entre no grupo de acompanhamento",
    );
    assert.equal(normalizedInvite?.content.kind, "text");
  });

  it("unwraps images and PDF documents with analysis metadata", () => {
    const image = mediaMessage("IMAGE-1", {
      imageMessage: {
        caption: "Erro exibido no dashboard",
        mimetype: "image/png",
        fileLength: 1234,
        fileSha256: Uint8Array.from([1, 2, 3]),
        mediaKey: Uint8Array.from([4, 5, 6]),
        directPath: "/v/t62/image.enc",
      },
    });
    const document = mediaMessage("PDF-1", {
      ephemeralMessage: {
        message: {
          documentMessage: {
            caption: "Relatório do período",
            mimetype: "application/pdf",
            fileName: "relatorio.pdf",
            pageCount: 4,
            fileLength: 4321,
            mediaKey: Uint8Array.from([7, 8, 9]),
            directPath: "/v/t62/document.enc",
          },
        },
      },
    });
    const audio = mediaMessage("AUDIO-1", {
      audioMessage: {
        mimetype: "audio/ogg; codecs=opus",
        seconds: 12,
        fileLength: 999,
      },
    });

    const envelopes = normalizeMessagesUpsert({
      type: "append",
      messages: [image, document, audio],
    });

    assert.equal(envelopes[0]?.content.kind, "image");
    assert.equal(envelopes[0]?.content.text, "Erro exibido no dashboard");
    assert.equal(
      envelopes[0]?.content.attachments[0]?.eligibleForAnalysis,
      true,
    );
    assert.match(
      envelopes[0]?.content.attachments[0]?.idempotencyKey ?? "",
      /:attachment:0$/,
    );
    assert.equal(envelopes[1]?.content.kind, "document");
    assert.equal(
      envelopes[1]?.content.attachments[0]?.fileName,
      "relatorio.pdf",
    );
    assert.equal(envelopes[1]?.content.attachments[0]?.pageCount, 4);
    assert.equal(envelopes[2]?.content.kind, "audio");
    assert.equal(
      envelopes[2]?.content.attachments[0]?.eligibleForAnalysis,
      true,
    );
  });
});

function textMessage(input: {
  id: string;
  text: string;
  participant?: string;
  remoteJid?: string;
  fromMe?: boolean;
}): WAMessage {
  return {
    key: {
      id: input.id,
      remoteJid: input.remoteJid ?? groupJid,
      participant: input.participant ?? customerJid,
      fromMe: input.fromMe ?? false,
    },
    messageTimestamp: 1_710_000_000,
    message: { conversation: input.text },
  };
}

function mediaMessage(
  id: string,
  message: NonNullable<WAMessage["message"]>,
): WAMessage {
  return {
    key: {
      id,
      remoteJid: groupJid,
      participant: customerJid,
      fromMe: false,
    },
    messageTimestamp: 1_710_000_000,
    message,
  };
}

function protocolMessage(input: {
  id: string;
  targetId: string;
  type: proto.Message.ProtocolMessage.Type;
  editedMessage?: NonNullable<WAMessage["message"]>;
}): WAMessage {
  return {
    key: {
      id: input.id,
      remoteJid: groupJid,
      participant: customerJid,
      fromMe: false,
    },
    messageTimestamp: 1_710_000_000,
    message: {
      protocolMessage: {
        type: input.type,
        key: {
          id: input.targetId,
          remoteJid: groupJid,
          participant: customerJid,
          fromMe: false,
        },
        editedMessage: input.editedMessage,
      },
    },
  };
}

function reactionMessage(input: {
  id: string;
  targetId: string;
  emoji: string;
  senderTimestampMs: number;
}): WAMessage {
  return {
    key: {
      id: input.id,
      remoteJid: groupJid,
      participant: customerJid,
      fromMe: false,
    },
    messageTimestamp: 1_710_000_000,
    message: {
      reactionMessage: {
        key: {
          id: input.targetId,
          remoteJid: groupJid,
          participant: staffJid,
          fromMe: true,
        },
        text: input.emoji,
        senderTimestampMs: input.senderTimestampMs,
      },
    },
  };
}
