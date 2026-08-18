import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { createDatabase, type SupportDatabase } from "../server/db/index.js";
import { DirectoryStore, SupportStore } from "../server/domain/index.js";

const databases: SupportDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture() {
  const database = createDatabase(":memory:");
  databases.push(database);
  const support = new SupportStore(database);
  const directory = new DirectoryStore(database);
  const account = support.upsertAccount({
    id: "directory-account",
    phoneNumber: "+5547000000000",
    displayName: "Conta local",
  });
  const client = support.upsertClient({
    id: "directory-client",
    name: "Grupo sem classificação",
    slug: "grupo-sem-classificacao",
    kind: "ecommerce",
  });
  const group = support.upsertGroup({
    id: "directory-group",
    accountId: account.id,
    clientId: client.id,
    externalJid: "120363009999@g.us",
    subject: "Grupo da operação",
  });
  const external = support.upsertParticipant({
    id: "directory-person",
    externalJid: "5547999999999@s.whatsapp.net",
    phoneE164: "+5547999999999",
    displayName: "Pessoa externa",
  });
  const staff = support.upsertParticipant({
    id: "directory-staff",
    externalJid: "5547888888888@s.whatsapp.net",
    phoneE164: "+5547888888888",
    displayName: "Pessoa da equipe",
  });
  support.setStaffMember(staff.id, "Pessoa da equipe");
  support.addGroupParticipant(group.id, external.id);
  support.addGroupParticipant(group.id, staff.id);
  const message = support.upsertMessage({
    id: "directory-message",
    externalId: "directory-message-external",
    groupId: group.id,
    senderId: external.id,
    occurredAt: "2026-07-19T13:00:00.000Z",
    text: "O indicador parece incorreto.",
    messageType: "text",
    triageKind: "demand",
  });
  support.createTicket({
    id: "directory-ticket",
    groupId: group.id,
    sourceMessageId: message.id,
    title: "Indicador incorreto",
    summary: "Pessoa relata diferença em um indicador.",
  });
  return { directory, externalId: external.id, staffId: staff.id };
}

test("Diretório expõe somente grupos e pessoas nativos", () => {
  const current = fixture();
  const snapshot = current.directory.getSnapshot();

  assert.deepEqual(snapshot.totals, { groups: 1, people: 2 });
  assert.equal(snapshot.groups[0]?.subject, "Grupo da operação");
  assert.equal(snapshot.groups[0]?.participantCount, 2);
  assert.equal(snapshot.groups[0]?.ticketCount, 1);
  assert.deepEqual(
    snapshot.people
      .map((person) => ({ id: person.id, isStaff: person.isStaff }))
      .toSorted((left, right) => left.id.localeCompare(right.id)),
    [
      { id: current.externalId, isStaff: false },
      { id: current.staffId, isStaff: true },
    ],
  );
  assert.deepEqual(Object.keys(snapshot).toSorted(), ["groups", "people", "totals"]);
});

test("Diretório colapsa aliases PN e LID em uma pessoa canônica", () => {
  const database = createDatabase(":memory:");
  databases.push(database);
  const support = new SupportStore(database);
  const directory = new DirectoryStore(database);
  const account = support.upsertAccount({ phoneNumber: "+5547000000001", displayName: "Conta" });
  const client = support.upsertClient({ name: "Operação", slug: "operacao", kind: "ecommerce" });
  const group = support.upsertGroup({
    accountId: account.id,
    clientId: client.id,
    externalJid: "120363000001@g.us",
    subject: "Grupo A",
  });
  const phone = support.upsertParticipant({
    id: "canonical-phone",
    externalJid: "5511912345678@s.whatsapp.net",
    phoneE164: "+5511912345678",
    displayName: "+5511912345678",
  });
  const lid = support.upsertParticipant({
    id: "canonical-lid",
    externalJid: "900000000000101@lid",
    phoneE164: "+5511912345678",
    displayName: "Pessoa Fictícia",
  });
  support.upsertIdentityLink({
    phoneJid: "5511912345678@s.whatsapp.net",
    lidJid: "900000000000101@lid",
    source: "test",
    observedAt: "2026-07-19T13:00:00.000Z",
  });
  support.addGroupParticipant(group.id, phone.id);
  support.addGroupParticipant(group.id, lid.id);
  support.upsertMessage({
    externalId: "canonical-message",
    groupId: group.id,
    senderId: lid.id,
    occurredAt: "2026-07-19T13:05:00.000Z",
    text: "Mensagem pelo LID",
    messageType: "text",
  });

  const snapshot = directory.getSnapshot();
  assert.equal(snapshot.groups[0]?.participantCount, 1);
  assert.equal(snapshot.people.length, 1);
  assert.equal(snapshot.people[0]?.displayName, "Pessoa Fictícia");
  assert.equal(snapshot.people[0]?.externalJid, "5511912345678@s.whatsapp.net");
  assert.equal(snapshot.people[0]?.phoneE164, "+5511912345678");
});
