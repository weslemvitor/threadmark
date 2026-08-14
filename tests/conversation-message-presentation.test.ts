import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { createDatabase, type SupportDatabase } from "../server/db/index.js";
import { SupportStore } from "../server/domain/index.js";
import { createTestApiApp } from "../server/index.js";

interface PresentedSender {
  id: string;
  displayName: string;
  isStaff: boolean;
}

interface PresentedReplyReference {
  providerMessageId: string;
  messageId: string | null;
  available: boolean;
  sender: PresentedSender | null;
  text: string | null;
  messageType: string | null;
  occurredAt: string | null;
}

interface PresentedReaction {
  emoji: string;
  count: number;
  reactors: PresentedSender[];
}

interface PresentedMessage {
  id: string;
  text: string | null;
  messageType: string;
  replyTo: PresentedReplyReference | null;
  reactions: PresentedReaction[];
}

interface ConversationMessagesPayload {
  items: PresentedMessage[];
  reactionUpdates: Array<{
    messageId: string;
    reactions: PresentedReaction[];
  }>;
  hasMore: boolean;
}

const databases: SupportDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture() {
  const database = createDatabase(":memory:");
  databases.push(database);
  const store = new SupportStore(database);
  const account = store.upsertAccount({
    id: "presentation-account",
    phoneNumber: "+5548999999999",
    displayName: "Acme Comercial",
  });
  const client = store.upsertClient({
    id: "presentation-client",
    name: "Cliente Apresentação",
    slug: "cliente-apresentacao",
    kind: "ecommerce",
  });
  const group = store.upsertGroup({
    id: "presentation-group",
    accountId: account.id,
    clientId: client.id,
    externalJid: "120363000777@g.us",
    subject: "Acme + Cliente Apresentação",
  });
  const customer = store.upsertParticipant({
    id: "presentation-customer",
    externalJid: "5511991111111@s.whatsapp.net",
    phoneE164: "+5511991111111",
    displayName: "Pessoa Fictícia Alfa",
  });
  const secondCustomer = store.upsertParticipant({
    id: "presentation-second-customer",
    externalJid: "5511992222222@s.whatsapp.net",
    phoneE164: "+5511992222222",
    displayName: "Pessoa Fictícia Beta",
  });
  const staff = store.upsertParticipant({
    id: "presentation-staff",
    externalJid: "5547999999999@s.whatsapp.net",
    phoneE164: "+5547999999999",
    displayName: "Operador",
  });
  store.setStaffMember(staff.id, "Operador");
  for (const participant of [customer, secondCustomer, staff]) {
    store.addGroupParticipant(group.id, participant.id);
  }

  return {
    database,
    store,
    groupId: group.id,
    customerId: customer.id,
    secondCustomerId: secondCustomer.id,
    staffId: staff.id,
  };
}

test("API inclui o preview citado mesmo quando a mensagem original não está na página", async () => {
  const current = fixture();
  const original = current.store.upsertMessage({
    id: "quoted-original",
    externalId: "quoted-original-idempotency",
    providerMessageId: "quoted-original-provider",
    groupId: current.groupId,
    senderId: current.staffId,
    occurredAt: "2026-07-17T18:00:00.000Z",
    text: "Pessoal, uma dúvida sobre a configuração do recurso de exemplo.",
    messageType: "conversation",
    triageKind: "context",
    triageState: "context",
    ingestionSource: "realtime_notify",
  });
  const reply = current.store.upsertMessage({
    id: "quoted-reply",
    externalId: "quoted-reply-idempotency",
    providerMessageId: "quoted-reply-provider",
    groupId: current.groupId,
    senderId: current.customerId,
    occurredAt: "2026-07-17T18:01:00.000Z",
    text: "Pode ser, estou marcando o Operador Fictício Beta para continuar.",
    messageType: "extendedTextMessage",
    quotedExternalId: "quoted-original-provider",
    triageKind: "information",
    triageState: "context",
    ingestionSource: "realtime_notify",
  });
  const app = createTestApiApp(current.store);

  const response = await app.request(
    `/api/conversations/${current.groupId}/messages?limit=1`,
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as ConversationMessagesPayload;

  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0]?.id, reply.id);
  assert.equal(payload.hasMore, true);
  assert.deepEqual(payload.items[0]?.replyTo, {
    providerMessageId: "quoted-original-provider",
    messageId: original.id,
    available: true,
    sender: {
      id: current.staffId,
      displayName: "Operador",
      isStaff: true,
    },
    text: "Pessoal, uma dúvida sobre a configuração do recurso de exemplo.",
    messageType: "conversation",
    occurredAt: "2026-07-17T18:00:00.000Z",
  });
  assert.deepEqual(payload.items[0]?.reactions, []);
});

test("API mantém referência indisponível quando a mensagem citada não existe no SQLite", async () => {
  const current = fixture();
  const reply = current.store.upsertMessage({
    id: "missing-quoted-reply",
    externalId: "missing-quoted-reply-idempotency",
    providerMessageId: "missing-quoted-reply-provider",
    groupId: current.groupId,
    senderId: current.customerId,
    occurredAt: "2026-07-17T18:05:00.000Z",
    text: "Esta resposta chegou sem o trecho antigo sincronizado.",
    messageType: "extendedTextMessage",
    quotedExternalId: "provider-not-stored-locally",
    triageKind: "information",
    triageState: "context",
    ingestionSource: "realtime_notify",
  });

  const payload = current.store.getConversationMessages(
    current.groupId,
  ) as ConversationMessagesPayload;
  assert.equal(payload.items[0]?.id, reply.id);
  assert.deepEqual(payload.items[0]?.replyTo, {
    providerMessageId: "provider-not-stored-locally",
    messageId: null,
    available: false,
    sender: null,
    text: null,
    messageType: null,
    occurredAt: null,
  });
});

test("API apresenta menção do WhatsApp pelo nome conhecido sem alterar o texto armazenado", () => {
  const current = fixture();
  const mentioned = current.store.upsertParticipant({
    id: "mentioned-contact-lid",
    externalJid: "900000000000197@lid",
    phoneE164: "+5500000000976",
    displayName: "Pessoa Fictícia Menção",
  });
  current.store.addGroupParticipant(current.groupId, mentioned.id);
  const message = current.store.upsertMessage({
    id: "message-with-mentioned-lid",
    externalId: "message-with-mentioned-lid-idempotency",
    providerMessageId: "message-with-mentioned-lid-provider",
    groupId: current.groupId,
    senderId: current.staffId,
    occurredAt: "2026-07-17T18:07:00.000Z",
    text: "Oi @900000000000197, tudo bem?",
    messageType: "extendedTextMessage",
    triageKind: "context",
    triageState: "context",
    ingestionSource: "realtime_notify",
    raw: {
      message: {
        extendedTextMessage: {
          text: "Oi @900000000000197, tudo bem?",
          contextInfo: {
            mentionedJid: ["900000000000197@lid"],
          },
        },
      },
    },
  });

  const payload = current.store.getConversationMessages(
    current.groupId,
  ) as ConversationMessagesPayload;

  assert.equal(payload.items[0]?.id, message.id);
  assert.equal(payload.items[0]?.text, "Oi @Pessoa Fictícia Menção, tudo bem?");
  assert.equal(
    (
      current.database
        .prepare("SELECT text FROM messages WHERE id = ?")
        .get(message.id) as { text: string }
    ).text,
    "Oi @900000000000197, tudo bem?",
  );
});

test("store agrega a reação mais recente por participante e não cria bolhas de eventos", () => {
  const current = fixture();
  const original = current.store.upsertMessage({
    id: "reacted-original",
    externalId: "reacted-original-idempotency",
    providerMessageId: "reacted-original-provider",
    groupId: current.groupId,
    senderId: current.staffId,
    occurredAt: "2026-07-17T18:10:00.000Z",
    text: "O cadastro foi atualizado.",
    messageType: "conversation",
    triageKind: "context",
    triageState: "context",
    ingestionSource: "realtime_notify",
  });
  const addReaction = (
    id: string,
    senderId: string,
    occurredAt: string,
    text: string | null,
  ) => current.store.upsertMessageReactionEvent({
    externalId: `${id}-idempotency`,
    groupId: current.groupId,
    reactorId: senderId,
    targetProviderMessageId: "reacted-original-provider",
    occurredAt,
    emoji: text,
  });

  addReaction(
    "reaction-fictional-alpha-heart",
    current.customerId,
    "2026-07-17T18:10:10.000Z",
    "❤️",
  );
  addReaction(
    "reaction-fictional-beta-heart",
    current.secondCustomerId,
    "2026-07-17T18:10:20.000Z",
    "❤️",
  );
  current.store.upsertMessage({
    id: "protocol-event",
    externalId: "protocol-event-idempotency",
    providerMessageId: "protocol-event-provider",
    groupId: current.groupId,
    senderId: current.customerId,
    occurredAt: "2026-07-17T18:10:30.000Z",
    text: null,
    messageType: "protocolMessage",
    triageKind: "context",
    triageState: "context",
    ingestionSource: "realtime_notify",
    raw: {
      message: {
        protocolMessage: {
          type: 3,
          key: { id: "reacted-original-provider" },
        },
      },
    },
  });

  let payload = current.store.getConversationMessages(
    current.groupId,
  ) as ConversationMessagesPayload;
  assert.deepEqual(payload.items.map((message) => message.id), [original.id]);
  assert.deepEqual(payload.items[0]?.reactions, [{
    emoji: "❤️",
    count: 2,
    reactors: [
      { id: current.customerId, displayName: "Pessoa Fictícia Alfa", isStaff: false },
      { id: current.secondCustomerId, displayName: "Pessoa Fictícia Beta", isStaff: false },
    ],
  }]);

  addReaction(
    "reaction-fictional-alpha-thumb",
    current.customerId,
    "2026-07-17T18:10:40.000Z",
    "👍",
  );
  payload = current.store.getConversationMessages(
    current.groupId,
  ) as ConversationMessagesPayload;
  assert.deepEqual(payload.items[0]?.reactions, [
    {
      emoji: "❤️",
      count: 1,
      reactors: [
        { id: current.secondCustomerId, displayName: "Pessoa Fictícia Beta", isStaff: false },
      ],
    },
    {
      emoji: "👍",
      count: 1,
      reactors: [
        { id: current.customerId, displayName: "Pessoa Fictícia Alfa", isStaff: false },
      ],
    },
  ]);

  addReaction(
    "reaction-fictional-alpha-removed",
    current.customerId,
    "2026-07-17T18:10:50.000Z",
    null,
  );
  payload = current.store.getConversationMessages(
    current.groupId,
  ) as ConversationMessagesPayload;
  assert.deepEqual(payload.items[0]?.reactions, [{
    emoji: "❤️",
    count: 1,
    reactors: [
      { id: current.secondCustomerId, displayName: "Pessoa Fictícia Beta", isStaff: false },
    ],
  }]);
});

test("API atualiza reação de mensagem antiga sem recolocá-la na página recente", () => {
  const current = fixture();
  const original = current.store.upsertMessage({
    id: "old-reaction-target",
    externalId: "old-reaction-target-idempotency",
    providerMessageId: "old-reaction-target-provider",
    groupId: current.groupId,
    senderId: current.staffId,
    occurredAt: "2026-07-17T17:00:00.000Z",
    text: "Mensagem antiga já carregada pelo operador.",
    messageType: "conversation",
    triageKind: "context",
    triageState: "context",
    ingestionSource: "realtime_notify",
  });
  const recent = current.store.upsertMessage({
    id: "recent-message",
    externalId: "recent-message-idempotency",
    providerMessageId: "recent-message-provider",
    groupId: current.groupId,
    senderId: current.customerId,
    occurredAt: "2026-07-17T18:00:00.000Z",
    text: "Mensagem mais recente.",
    messageType: "conversation",
    triageKind: "information",
    triageState: "context",
    ingestionSource: "realtime_notify",
  });
  current.store.upsertMessageReactionEvent({
    externalId: "old-target-reaction-idempotency",
    groupId: current.groupId,
    reactorId: current.customerId,
    targetProviderMessageId: "old-reaction-target-provider",
    occurredAt: "2026-07-17T18:01:00.000Z",
    emoji: "👍",
  });

  const payload = current.store.getConversationMessages(current.groupId, {
    limit: 1,
  }) as ConversationMessagesPayload;

  assert.deepEqual(payload.items.map((message) => message.id), [recent.id]);
  assert.deepEqual(payload.reactionUpdates, [{
    messageId: original.id,
    reactions: [{
      emoji: "👍",
      count: 1,
      reactors: [
        { id: current.customerId, displayName: "Pessoa Fictícia Alfa", isStaff: false },
      ],
    }],
  }]);
});

test("remoção por PN substitui reação adicionada pelo LID da mesma pessoa", () => {
  const current = fixture();
  const lid = current.store.upsertParticipant({
    id: "canonical-reactor-lid",
    externalJid: "123456789012345@lid",
    displayName: "Pessoa Fictícia Gama",
  });
  const phone = current.store.upsertParticipant({
    id: "canonical-reactor-phone",
    externalJid: "5511993333333@s.whatsapp.net",
    phoneE164: "+5511993333333",
    displayName: "Pessoa Fictícia Gama",
  });
  current.store.upsertIdentityLink({
    phoneJid: "5511993333333@s.whatsapp.net",
    lidJid: "123456789012345@lid",
    source: "test",
    observedAt: "2026-07-17T18:20:00.000Z",
  });
  current.store.addGroupParticipant(current.groupId, lid.id);
  current.store.addGroupParticipant(current.groupId, phone.id);
  const original = current.store.upsertMessage({
    id: "canonical-reaction-target",
    externalId: "canonical-reaction-target-idempotency",
    providerMessageId: "canonical-reaction-target-provider",
    groupId: current.groupId,
    senderId: current.staffId,
    occurredAt: "2026-07-17T18:20:00.000Z",
    text: "A configuração foi concluída.",
    messageType: "conversation",
    triageKind: "context",
    triageState: "context",
    ingestionSource: "realtime_notify",
  });

  current.store.upsertMessageReactionEvent({
    externalId: "canonical-reaction-add",
    groupId: current.groupId,
    reactorId: lid.id,
    targetProviderMessageId: "canonical-reaction-target-provider",
    occurredAt: "2026-07-17T18:20:10.000Z",
    observedAt: "2026-07-17T18:20:10.100Z",
    emoji: "❤️",
  });
  current.store.upsertMessageReactionEvent({
    externalId: "canonical-reaction-remove",
    groupId: current.groupId,
    reactorId: phone.id,
    targetProviderMessageId: "canonical-reaction-target-provider",
    occurredAt: "2026-07-17T18:20:20.000Z",
    observedAt: "2026-07-17T18:20:20.100Z",
    emoji: null,
  });

  const payload = current.store.getConversationMessages(
    current.groupId,
  ) as ConversationMessagesPayload;
  assert.equal(payload.items[0]?.id, original.id);
  assert.deepEqual(payload.items[0]?.reactions, []);
});

test("redelivery do add antigo não ressuscita reação removida no mesmo occurredAt", () => {
  const current = fixture();
  const original = current.store.upsertMessage({
    id: "redelivered-reaction-target",
    externalId: "redelivered-reaction-target-idempotency",
    providerMessageId: "redelivered-reaction-target-provider",
    groupId: current.groupId,
    senderId: current.staffId,
    occurredAt: "2026-07-17T18:30:00.000Z",
    text: "Mensagem com reação removida.",
    messageType: "conversation",
    triageKind: "context",
    triageState: "context",
    ingestionSource: "realtime_notify",
  });
  const occurredAt = "2026-07-17T18:30:10.000Z";
  const addReaction = (observedAt: string) =>
    current.store.upsertMessageReactionEvent({
      externalId: "redelivered-reaction-add",
      groupId: current.groupId,
      reactorId: current.customerId,
      targetProviderMessageId: "redelivered-reaction-target-provider",
      occurredAt,
      observedAt,
      emoji: "❤️",
    });

  addReaction("2026-07-17T18:30:10.100Z");
  current.store.upsertMessageReactionEvent({
    externalId: "redelivered-reaction-remove",
    groupId: current.groupId,
    reactorId: current.customerId,
    targetProviderMessageId: "redelivered-reaction-target-provider",
    occurredAt,
    observedAt: "2026-07-17T18:30:10.200Z",
    emoji: null,
  });
  assert.deepEqual(
    (current.store.getConversationMessages(
      current.groupId,
    ) as ConversationMessagesPayload).items[0]?.reactions,
    [],
  );

  addReaction("2026-07-17T18:30:11.000Z");

  const payload = current.store.getConversationMessages(
    current.groupId,
  ) as ConversationMessagesPayload;
  assert.equal(payload.items[0]?.id, original.id);
  assert.deepEqual(payload.items[0]?.reactions, []);
  assert.equal(
    (
      current.database
        .prepare("SELECT COUNT(*) AS count FROM message_reaction_events")
        .get() as { count: number }
    ).count,
    2,
  );
});
