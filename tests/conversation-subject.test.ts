import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import {
  createDatabase,
  migrateDatabase,
  migrations,
} from "../server/db/index.js";
import {
  isDirectConversationJid,
  normalizeConversationSubject,
} from "../server/domain/conversation-subject.js";
import { SupportStore } from "../server/domain/index.js";

test("normaliza somente placeholders de conversas privadas", () => {
  assert.equal(
    normalizeConversationSubject("Grupo 90000000000101", "90000000000101@lid"),
    "90000000000101",
  );
  assert.equal(
    normalizeConversationSubject(
      "Conversa privada 5511999999999",
      "5511999999999@s.whatsapp.net",
    ),
    "5511999999999",
  );
  assert.equal(
    normalizeConversationSubject("Pessoa Fictícia Zeta", "90000000000101@lid"),
    "Pessoa Fictícia Zeta",
  );
  assert.equal(
    normalizeConversationSubject("Grupo 120363000999", "120363000999@g.us"),
    "Grupo 120363000999",
  );
  assert.equal(isDirectConversationJid("90000000000101@lid"), true);
  assert.equal(isDirectConversationJid("120363000999@g.us"), false);
});

test("upsert persiste o número e o read model corrige registro privado legado", () => {
  const database = createDatabase(":memory:");
  try {
    const store = new SupportStore(database);
    const account = store.upsertAccount({
      id: "subject-account",
      phoneNumber: "+5547000000000",
      displayName: "Acme Comercial",
    });
    const client = store.upsertClient({
      id: "subject-client",
      name: "Cliente não identificado",
      slug: "cliente-subject",
      kind: "ecommerce",
    });
    const direct = store.upsertGroup({
      id: "direct-placeholder",
      accountId: account.id,
      clientId: client.id,
      externalJid: "90000000000101@lid",
      subject: "Grupo 90000000000101",
      monitored: false,
    });
    const namedContact = store.upsertGroup({
      id: "direct-named",
      accountId: account.id,
      clientId: client.id,
      externalJid: "5511991111111@s.whatsapp.net",
      subject: "Pessoa Fictícia Zeta",
      monitored: false,
    });
    const realGroup = store.upsertGroup({
      id: "real-group",
      accountId: account.id,
      clientId: client.id,
      externalJid: "120363000999@g.us",
      subject: "Grupo 120363000999",
    });

    assert.deepEqual(
      database
        .prepare("SELECT id, subject FROM whatsapp_groups ORDER BY id")
        .all(),
      [
        { id: namedContact.id, subject: "Pessoa Fictícia Zeta" },
        { id: direct.id, subject: "90000000000101" },
        { id: realGroup.id, subject: "Grupo 120363000999" },
      ],
    );

    const sender = store.upsertParticipant({
      id: "subject-sender",
      externalJid: "5511888888888@s.whatsapp.net",
      displayName: "Contato",
    });
    for (const [index, conversation] of [direct, namedContact, realGroup].entries()) {
      store.addGroupParticipant(conversation.id, sender.id);
      store.upsertMessage({
        id: `subject-message-${index}`,
        externalId: `subject-external-${index}`,
        groupId: conversation.id,
        senderId: sender.id,
        occurredAt: `2026-07-17T17:0${index}:00.000Z`,
        text: "Mensagem com conteúdo",
        messageType: "conversation",
      });
    }

    const emptyDirect = store.upsertGroup({
      id: "empty-direct-placeholder",
      accountId: account.id,
      clientId: client.id,
      externalJid: "5511777777777@s.whatsapp.net",
      subject: "Grupo 5511777777777",
      monitored: false,
    });
    const emptyRealGroup = store.upsertGroup({
      id: "empty-real-group",
      accountId: account.id,
      clientId: client.id,
      externalJid: "120363000777@g.us",
      subject: "Grupo interno sem histórico",
    });

    database
      .prepare("UPDATE whatsapp_groups SET subject = ? WHERE id = ?")
      .run("Grupo 90000000000101", direct.id);

    const conversations = store.listConversations({ attention: "all" }).items;
    assert.equal(
      conversations.find((conversation) => conversation.id === direct.id)?.subject,
      "Usuário não identificado",
    );
    assert.equal(
      store.getConversationMessages(direct.id).conversation.subject,
      "Usuário não identificado",
    );
    assert.equal(
      conversations.find((conversation) => conversation.id === namedContact.id)
        ?.subject,
      "Pessoa Fictícia Zeta",
    );
    assert.equal(
      conversations.find((conversation) => conversation.id === realGroup.id)?.subject,
      "Grupo 120363000999",
    );
    assert.equal(
      conversations.some((conversation) => conversation.id === emptyDirect.id),
      false,
      "conversa privada sem conteúdo útil não deve aparecer",
    );
    assert.equal(
      conversations.some((conversation) => conversation.id === emptyRealGroup.id),
      true,
      "grupo real continua visível mesmo antes de receber mensagens",
    );
  } finally {
    database.close();
  }
});

test("read model privado prioriza o contato remoto e nunca o nome da conta", () => {
  const database = createDatabase(":memory:");
  try {
    const store = new SupportStore(database);
    const account = store.upsertAccount({
      id: "direct-name-account",
      phoneNumber: "+5547000000000",
      displayName: "Equipe Comercial",
    });
    const client = store.upsertClient({
      id: "direct-name-client",
      name: "Cliente não identificado",
      slug: "direct-name-client",
      kind: "ecommerce",
    });
    const direct = store.upsertGroup({
      id: "direct-wrong-subject",
      accountId: account.id,
      clientId: client.id,
      externalJid: "90000000000999@lid",
      subject: "Operador de teste",
      monitored: false,
    });
    const self = store.upsertParticipant({
      id: "direct-name-self",
      externalJid: "self:commercial-account",
      displayName: "Equipe Comercial",
    });
    store.setStaffMember(self.id, "Equipe Comercial");
    store.addGroupParticipant(direct.id, self.id);
    const remote = store.upsertParticipant({
      id: "direct-name-remote",
      externalJid: "5511999999999@s.whatsapp.net",
      phoneE164: "+5511999999999",
      displayName: "Pessoa Fictícia Zeta",
    });
    store.upsertIdentityLink({
      phoneJid: "5511999999999@s.whatsapp.net",
      lidJid: "90000000000999@lid",
      source: "message",
      observedAt: "2026-07-27T11:00:00.000Z",
    });
    store.addGroupParticipant(direct.id, remote.id);
    store.upsertMessage({
      id: "direct-name-self-message",
      externalId: "direct-name-self-message",
      groupId: direct.id,
      senderId: self.id,
      occurredAt: "2026-07-27T11:00:00.000Z",
      text: "Mensagem da equipe",
      messageType: "conversation",
      triageKind: "context",
      triageState: "context",
    });
    store.upsertMessage({
      id: "direct-name-remote-message",
      externalId: "direct-name-remote-message",
      groupId: direct.id,
      senderId: remote.id,
      occurredAt: "2026-07-27T11:01:00.000Z",
      text: "Mensagem do contato",
      messageType: "conversation",
      triageKind: "unclassified",
      triageState: "unreviewed",
    });

    const summary = store
      .listConversations({ scope: "direct" })
      .items.find((conversation) => conversation.id === direct.id);
    const detail = store.getConversationMessages(direct.id);

    assert.equal(summary?.subject, "Pessoa Fictícia Zeta");
    assert.equal(detail.conversation.subject, "Pessoa Fictícia Zeta");
    assert.deepEqual(
      database
        .prepare("SELECT subject FROM whatsapp_groups WHERE id = ?")
        .get(direct.id),
      { subject: "Operador de teste" },
      "o read model corrige a exibição sem reescrever silenciosamente o histórico",
    );
  } finally {
    database.close();
  }
});

test("migração corrige placeholders privados antigos sem renomear contatos ou grupos", () => {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    for (const migration of migrations.filter((item) => item.version < 14)) {
      database.transaction(() => {
        database.exec(migration.sql);
        database
          .prepare(
            "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
          )
          .run(migration.version, migration.name, "2026-07-17T17:00:00.000Z");
      })();
    }

    const timestamp = "2026-07-17T17:00:00.000Z";
    database
      .prepare(
        `INSERT INTO whatsapp_accounts
          (id, phone_number, display_name, created_at, updated_at)
         VALUES ('legacy-subject-account', '+5547000000000', 'Comercial', ?, ?)`,
      )
      .run(timestamp, timestamp);
    database
      .prepare(
        `INSERT INTO clients
          (id, name, slug, kind, created_at, updated_at)
         VALUES ('legacy-subject-client', 'Cliente', 'legacy-subject-client',
                 'ecommerce', ?, ?)`,
      )
      .run(timestamp, timestamp);
    const insertConversation = database.prepare(
      `INSERT INTO whatsapp_groups
        (id, account_id, client_id, external_jid, subject, created_at, updated_at)
       VALUES (?, 'legacy-subject-account', 'legacy-subject-client', ?, ?, ?, ?)`,
    );
    insertConversation.run(
      "legacy-lid",
      "90000000000101@lid",
      "Grupo 90000000000101",
      timestamp,
      timestamp,
    );
    insertConversation.run(
      "legacy-phone",
      "5511999999999@s.whatsapp.net",
      "Conversa privada 5511999999999",
      timestamp,
      timestamp,
    );
    insertConversation.run(
      "named-contact",
      "5511991111111@s.whatsapp.net",
      "Pessoa Fictícia Zeta",
      timestamp,
      timestamp,
    );
    insertConversation.run(
      "real-group",
      "120363000999@g.us",
      "Grupo 120363000999",
      timestamp,
      timestamp,
    );

    migrateDatabase(database);

    assert.deepEqual(
      database
        .prepare("SELECT id, subject FROM whatsapp_groups ORDER BY id")
        .all(),
      [
        { id: "legacy-lid", subject: "90000000000101" },
        { id: "legacy-phone", subject: "5511999999999" },
        { id: "named-contact", subject: "Pessoa Fictícia Zeta" },
        { id: "real-group", subject: "Grupo 120363000999" },
      ],
    );
  } finally {
    database.close();
  }
});
