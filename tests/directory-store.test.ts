import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { createDatabase, type SupportDatabase } from "../server/db/index.js";
import {
  ConflictError,
  DirectoryStore,
  SupportStore,
  ValidationError,
} from "../server/domain/index.js";
import type {
  DirectoryFieldDefinitionDto,
  DirectoryFieldValue,
} from "../shared/contracts.js";

const databases: SupportDatabase[] = [];
const actor = "Teste do Diretório";

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
  const compatibilityClient = support.upsertClient({
    id: "directory-compatibility-client",
    name: "Grupo sem classificação",
    slug: "grupo-sem-classificacao",
    kind: "ecommerce",
  });
  const group = support.upsertGroup({
    id: "directory-group",
    accountId: account.id,
    clientId: compatibilityClient.id,
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
  const ticket = support.createTicket({
    id: "directory-ticket",
    groupId: group.id,
    sourceMessageId: message.id,
    title: "Indicador incorreto",
    summary: "Pessoa relata diferença em um indicador.",
  });

  return {
    database,
    directory,
    externalId: external.id,
    groupId: group.id,
    staffId: staff.id,
    ticketId: ticket.id,
  };
}

function organizationTypeId(directory: DirectoryStore): string {
  const organization = directory
    .getSnapshot()
    .recordTypes.find((type) => type.slug === "organizacao");
  assert.ok(organization);
  return organization.id;
}

test("grupos e pessoas são nativos e um grupo aceita múltiplos registros", () => {
  const current = fixture();
  const initial = current.directory.getSnapshot();

  assert.equal(initial.totals.groups, 1);
  assert.equal(initial.totals.people, 2);
  assert.equal(initial.totals.records, 0);
  assert.deepEqual(initial.groups[0]?.linkedRecordIds, []);
  assert.deepEqual(
    initial.people
      .map((person) => ({
        id: person.id,
        isStaff: person.isStaff,
        activeGroupCount: person.activeGroupCount,
      }))
      .toSorted((left, right) => left.id.localeCompare(right.id)),
    [
      { id: current.externalId, isStaff: false, activeGroupCount: 1 },
      { id: current.staffId, isStaff: true, activeGroupCount: 1 },
    ],
  );

  const typeId = organizationTypeId(current.directory);
  const operation = current.directory.createRecord(
    {
      typeId,
      name: "Operação Sul",
      groupIds: [current.groupId],
      personIds: [current.externalId],
    },
    actor,
  );
  const department = current.directory.createRecord(
    {
      typeId,
      name: "Departamento Financeiro",
      groupIds: [current.groupId],
    },
    actor,
  );

  const snapshot = current.directory.getSnapshot();
  assert.deepEqual(
    snapshot.groups[0]?.linkedRecordIds.toSorted(),
    [operation.id, department.id].toSorted(),
  );
  assert.deepEqual(
    snapshot.people.find((person) => person.id === current.externalId)
      ?.linkedRecordIds,
    [operation.id],
  );
  assert.deepEqual(
    snapshot.records.find((record) => record.id === operation.id)?.groupIds,
    [current.groupId],
  );
});

test("diretório colapsa aliases PN e LID em uma pessoa canônica", () => {
  const database = createDatabase(":memory:");
  databases.push(database);
  const support = new SupportStore(database);
  const directory = new DirectoryStore(database);
  const account = support.upsertAccount({
    id: "canonical-directory-account",
    phoneNumber: "+5547000000001",
    displayName: "Conta canônica",
  });
  const client = support.upsertClient({
    id: "canonical-directory-client",
    name: "Operação canônica",
    slug: "operacao-canonica",
    kind: "ecommerce",
  });
  const firstGroup = support.upsertGroup({
    id: "canonical-directory-group-a",
    accountId: account.id,
    clientId: client.id,
    externalJid: "120363000001@g.us",
    subject: "Grupo A",
  });
  const secondGroup = support.upsertGroup({
    id: "canonical-directory-group-b",
    accountId: account.id,
    clientId: client.id,
    externalJid: "120363000002@g.us",
    subject: "Grupo B",
  });
  const phone = support.upsertParticipant({
    id: "canonical-directory-phone",
    externalJid: "5511912345678@s.whatsapp.net",
    phoneE164: "+5511912345678",
    displayName: "+5511912345678",
  });
  const lid = support.upsertParticipant({
    id: "canonical-directory-lid",
    externalJid: "900000000000101@lid",
    phoneE164: "+5511912345678",
    displayName: "Pessoa Fictícia Épsilon",
  });
  support.upsertIdentityLink({
    phoneJid: "5511912345678@s.whatsapp.net",
    lidJid: "900000000000101@lid",
    source: "test",
    observedAt: "2026-07-19T13:00:00.000Z",
  });
  support.addGroupParticipant(firstGroup.id, phone.id);
  support.addGroupParticipant(firstGroup.id, lid.id);
  support.addGroupParticipant(secondGroup.id, lid.id);
  support.setStaffMember(lid.id, "Pessoa Fictícia Épsilon");
  support.upsertMessage({
    id: "canonical-directory-message-phone",
    externalId: "canonical-directory-message-phone-external",
    groupId: firstGroup.id,
    senderId: phone.id,
    occurredAt: "2026-07-19T13:05:00.000Z",
    text: "Mensagem pelo PN",
    messageType: "text",
    triageKind: "context",
  });
  support.upsertMessage({
    id: "canonical-directory-message-lid",
    externalId: "canonical-directory-message-lid-external",
    groupId: secondGroup.id,
    senderId: lid.id,
    occurredAt: "2026-07-19T13:10:00.000Z",
    text: "Mensagem pelo LID",
    messageType: "text",
    triageKind: "context",
  });

  const typeId = organizationTypeId(directory);
  const linkedByLid = directory.createRecord(
    {
      typeId,
      name: "Registro pelo LID",
      personIds: [lid.id],
    },
    actor,
  );
  const linkedByPhone = directory.createRecord(
    {
      typeId,
      name: "Registro pelo telefone",
      personIds: [phone.id],
    },
    actor,
  );

  const snapshot = directory.getSnapshot();
  assert.equal(snapshot.people.length, 1);
  assert.equal(snapshot.totals.people, 1);
  assert.deepEqual(snapshot.people[0], {
    id: phone.id,
    displayName: "Pessoa Fictícia Épsilon",
    phoneE164: "+5511912345678",
    externalJid: "5511912345678@s.whatsapp.net",
    isStaff: true,
    activeGroupCount: 2,
    lastActivityAt: "2026-07-19T13:10:00.000Z",
    linkedRecordIds: [linkedByLid.id, linkedByPhone.id].toSorted(),
  });
  assert.deepEqual(
    snapshot.records
      .filter((record) =>
        [linkedByLid.id, linkedByPhone.id].includes(record.id),
      )
      .map((record) => record.personIds),
    [[phone.id], [phone.id]],
  );

  assert.deepEqual(
    database
      .prepare(
        `SELECT participant_id
         FROM directory_person_links
         WHERE record_id = ? AND archived_at IS NULL`,
      )
      .all(linkedByLid.id),
    [{ participant_id: phone.id }],
  );
});

test("diretório omite identidade placeholder sem nome ou telefone e preserva o histórico", () => {
  const database = createDatabase(":memory:");
  databases.push(database);
  const support = new SupportStore(database);
  const directory = new DirectoryStore(database);
  const account = support.upsertAccount({
    id: "placeholder-directory-account",
    phoneNumber: "+5547000000002",
    displayName: "Conta local",
  });
  const client = support.upsertClient({
    id: "placeholder-directory-client",
    name: "Operação sem identificação",
    slug: "operacao-sem-identificacao",
    kind: "ecommerce",
  });
  const group = support.upsertGroup({
    id: "placeholder-directory-group",
    accountId: account.id,
    clientId: client.id,
    externalJid: "120363000003@g.us",
    subject: "Grupo da operação",
  });
  const participant = support.upsertParticipant({
    id: "placeholder-directory-participant",
    externalJid: "900000000000101@lid",
    phoneE164: null,
    displayName: "Participante 900000000000101",
  });
  support.addGroupParticipant(group.id, participant.id);
  const message = support.upsertMessage({
    id: "placeholder-directory-message",
    externalId: "placeholder-directory-message-external",
    groupId: group.id,
    senderId: participant.id,
    occurredAt: "2026-07-19T13:15:00.000Z",
    text: "Mensagem preservada no histórico.",
    messageType: "text",
    triageKind: "context",
  });

  const snapshot = directory.getSnapshot();

  assert.equal(snapshot.totals.people, 0);
  assert.equal(
    snapshot.people.some((person) => person.id === participant.id),
    false,
  );
  assert.deepEqual(
    database
      .prepare(
        `SELECT id, external_jid, display_name
         FROM participants
         WHERE id = ?`,
      )
      .get(participant.id),
    {
      id: participant.id,
      external_jid: "900000000000101@lid",
      display_name: "900000000000101@lid",
    },
  );
  assert.deepEqual(
    database
      .prepare(
        `SELECT id, sender_id, text
         FROM messages
         WHERE id = ?`,
      )
      .get(message.id),
    {
      id: message.id,
      sender_id: participant.id,
      text: "Mensagem preservada no histórico.",
    },
  );
});

test("diretório exibe pelo telefone a identidade placeholder que possui número", () => {
  const database = createDatabase(":memory:");
  databases.push(database);
  const support = new SupportStore(database);
  const directory = new DirectoryStore(database);
  const account = support.upsertAccount({
    id: "phone-placeholder-account",
    phoneNumber: "+5547000000003",
    displayName: "Conta local",
  });
  const client = support.upsertClient({
    id: "phone-placeholder-client",
    name: "Operação identificada pelo telefone",
    slug: "operacao-identificada-pelo-telefone",
    kind: "ecommerce",
  });
  const group = support.upsertGroup({
    id: "phone-placeholder-group",
    accountId: account.id,
    clientId: client.id,
    externalJid: "120363000004@g.us",
    subject: "Grupo identificado pelo telefone",
  });
  const participant = support.upsertParticipant({
    id: "phone-placeholder-participant",
    externalJid: "900000000000102@lid",
    phoneE164: "+5511912345679",
    displayName: "Participante 900000000000102",
  });
  support.addGroupParticipant(group.id, participant.id);

  const snapshot = directory.getSnapshot();

  assert.equal(snapshot.totals.people, 1);
  assert.deepEqual(snapshot.people[0], {
    id: participant.id,
    displayName: "+5511912345679",
    phoneE164: "+5511912345679",
    externalJid: "900000000000102@lid",
    isStaff: false,
    activeGroupCount: 1,
    lastActivityAt: null,
    linkedRecordIds: [],
  });
});

test("tipos, campos e registros têm CRUD e validação forte por tipo", () => {
  const current = fixture();
  const partnerType = current.directory.createRecordType(
    {
      name: "Parceiro",
      pluralName: "Parceiros",
      description: "Entidades externas relacionadas à operação.",
      color: "#334155",
    },
    actor,
  );
  const updatedType = current.directory.updateRecordType(
    partnerType.id,
    {
      name: "Parceiro comercial",
      pluralName: "Parceiros comerciais",
      slug: "parceiro-comercial",
      description: null,
      icon: "handshake",
      color: "#475569",
    },
    actor,
  );
  assert.equal(updatedType.name, "Parceiro comercial");
  assert.equal(updatedType.slug, "parceiro-comercial");

  const target = current.directory.createRecord(
    {
      typeId: organizationTypeId(current.directory),
      name: "Organização relacionada",
    },
    actor,
  );

  const fields = new Map<string, DirectoryFieldDefinitionDto>();
  const createField = (
    label: string,
    type: DirectoryFieldDefinitionDto["type"],
    extra: Partial<{
      required: boolean;
      options: string[];
      relationRecordTypeId: string;
    }> = {},
  ) => {
    const field = current.directory.createField(
      {
        recordTypeId: partnerType.id,
        label,
        type,
        ...extra,
      },
      actor,
    );
    fields.set(type, field);
    return field;
  };

  const text = createField("Responsável", "text", { required: true });
  const number = createField("Pontuação", "number");
  const boolean = createField("Ativo", "boolean");
  const date = createField("Desde", "date");
  const url = createField("Site", "url");
  const select = createField("Plano", "select", {
    options: ["Essencial", "Pro"],
  });
  const multiSelect = createField("Regiões", "multi_select", {
    options: ["Sul", "Sudeste"],
  });
  const relation = createField("Matriz", "relation", {
    relationRecordTypeId: organizationTypeId(current.directory),
  });

  const values: Record<string, DirectoryFieldValue> = {
    [text.id]: "Pessoa Fictícia Teta",
    [number.id]: 42,
    [boolean.id]: true,
    [date.id]: "2026-07-19",
    [url.id]: "https://example.com",
    [select.id]: "Pro",
    [multiSelect.id]: ["Sul", "Sudeste"],
    [relation.id]: target.id,
  };
  const record = current.directory.createRecord(
    {
      typeId: partnerType.id,
      name: "Registro Exemplo Ômega",
      values,
      groupIds: [current.groupId],
    },
    actor,
  );
  assert.deepEqual(record.values, values);
  assert.ok(record.relatedRecordIds.includes(target.id));

  const updatedField = current.directory.updateField(
    number.id,
    {
      recordTypeId: partnerType.id,
      key: number.key,
      label: "Pontuação de relacionamento",
      type: "number",
      position: 2,
    },
    actor,
  );
  assert.equal(updatedField.label, "Pontuação de relacionamento");

  const updatedRecord = current.directory.updateRecord(
    record.id,
    {
      typeId: partnerType.id,
      name: "Registro Exemplo Ômega Atualizado",
      values: { ...values, [number.id]: 50 },
      groupIds: [],
      relatedRecordIds: [],
    },
    actor,
  );
  assert.equal(updatedRecord.name, "Registro Exemplo Ômega Atualizado");
  assert.equal(updatedRecord.values[number.id], 50);
  assert.deepEqual(updatedRecord.groupIds, []);

  assert.throws(
    () =>
      current.directory.createRecord(
        { typeId: partnerType.id, name: "Sem obrigatório" },
        actor,
      ),
    ValidationError,
  );

  const validRequired = { [text.id]: "Valor válido" };
  const invalidValues: Array<[DirectoryFieldDefinitionDto, DirectoryFieldValue]> = [
    [text, 12],
    [number, "12"],
    [boolean, "true"],
    [date, "19/07/2026"],
    [url, "javascript:alert(1)"],
    [select, "Enterprise"],
    [multiSelect, ["Norte"]],
    [relation, "registro-inexistente"],
  ];
  for (const [field, invalidValue] of invalidValues) {
    assert.throws(
      () =>
        current.directory.createRecord(
          {
            typeId: partnerType.id,
            name: `Valor inválido ${field.type}`,
            values: { ...validRequired, [field.id]: invalidValue },
          },
          actor,
        ),
      ValidationError,
      `o campo ${field.type} deve rejeitar valor incompatível`,
    );
  }

  assert.throws(
    () =>
      current.directory.createField(
        {
          recordTypeId: partnerType.id,
          label: "Seleção vazia",
          type: "select",
          options: [],
        },
        actor,
      ),
    ValidationError,
  );
  assert.throws(
    () =>
      current.directory.createField(
        {
          recordTypeId: partnerType.id,
          label: "Texto com opções",
          type: "text",
          options: ["Não deveria"],
        },
        actor,
      ),
    ValidationError,
  );
  assert.throws(
    () =>
      current.directory.createField(
        {
          recordTypeId: partnerType.id,
          label: "Relação sem destino",
          type: "relation",
        },
        actor,
      ),
    ValidationError,
  );
  assert.throws(
    () =>
      current.directory.createRecordType(
        {
          name: "Outro parceiro",
          pluralName: "Outros parceiros",
          slug: updatedType.slug,
        },
        actor,
      ),
    ConflictError,
  );
});

test("segmentos são recalculados quando os valores dos registros mudam", () => {
  const current = fixture();
  const type = current.directory.createRecordType(
    { name: "Unidade", pluralName: "Unidades" },
    actor,
  );
  const status = current.directory.createField(
    {
      recordTypeId: type.id,
      label: "Status",
      type: "select",
      options: ["Ativa", "Pausada"],
    },
    actor,
  );
  const score = current.directory.createField(
    { recordTypeId: type.id, label: "Pontuação", type: "number" },
    actor,
  );
  const active = current.directory.createRecord(
    {
      typeId: type.id,
      name: "Unidade ativa",
      values: { [status.id]: "Ativa", [score.id]: 80 },
    },
    actor,
  );
  const lowScore = current.directory.createRecord(
    {
      typeId: type.id,
      name: "Unidade com pontuação baixa",
      values: { [status.id]: "Ativa", [score.id]: 20 },
    },
    actor,
  );
  const paused = current.directory.createRecord(
    {
      typeId: type.id,
      name: "Unidade pausada",
      values: { [status.id]: "Pausada", [score.id]: 95 },
    },
    actor,
  );
  const segment = current.directory.createSegment(
    {
      name: "Ativas com alta pontuação",
      recordTypeId: type.id,
      match: "all",
      filters: [
        { fieldId: status.id, operator: "equals", value: "Ativa" },
        { fieldId: score.id, operator: "greater_than", value: 50 },
      ],
    },
    actor,
  );
  assert.deepEqual(segment.memberRecordIds, [active.id]);
  assert.equal(segment.memberCount, 1);

  current.directory.updateRecord(
    active.id,
    {
      typeId: type.id,
      name: active.name,
      values: { [status.id]: "Ativa", [score.id]: 40 },
    },
    actor,
  );
  const recalculated = current.directory
    .getSnapshot()
    .segments.find((item) => item.id === segment.id);
  assert.ok(recalculated);
  assert.equal(recalculated.memberCount, 0);

  const any = current.directory.updateSegment(
    segment.id,
    {
      name: "Ativa ou alta pontuação",
      recordTypeId: type.id,
      match: "any",
      filters: [
        { fieldId: status.id, operator: "equals", value: "Ativa" },
        { fieldId: score.id, operator: "greater_than", value: 90 },
      ],
    },
    actor,
  );
  assert.deepEqual(
    any.memberRecordIds.toSorted(),
    [active.id, lowScore.id, paused.id].toSorted(),
  );
  current.directory.deleteSegment(segment.id);
  assert.equal(
    current.directory.getSnapshot().segments.some((item) => item.id === segment.id),
    false,
  );
});

test("arquivar um registro preserva grupo, mensagens e ticket", () => {
  const current = fixture();
  const record = current.directory.createRecord(
    {
      typeId: organizationTypeId(current.directory),
      name: "Registro temporário",
      groupIds: [current.groupId],
      personIds: [current.externalId],
    },
    actor,
  );

  const archived = current.directory.archiveRecord(record.id, actor);
  assert.ok(archived.archivedAt);
  assert.equal(
    (
      current.database
        .prepare("SELECT COUNT(*) AS count FROM whatsapp_groups WHERE id = ?")
        .get(current.groupId) as { count: number }
    ).count,
    1,
  );
  assert.equal(
    (
      current.database
        .prepare("SELECT COUNT(*) AS count FROM tickets WHERE id = ?")
        .get(current.ticketId) as { count: number }
    ).count,
    1,
  );
  assert.equal(
    (
      current.database
        .prepare("SELECT COUNT(*) AS count FROM messages WHERE group_id = ?")
        .get(current.groupId) as { count: number }
    ).count,
    1,
  );
  assert.deepEqual(
    current.directory.getSnapshot().groups[0]?.linkedRecordIds,
    [],
  );
  assert.deepEqual(current.database.pragma("foreign_key_check"), []);
});

test("ticket reúne contexto explícito, do grupo e do solicitante com aliases PN e LID", () => {
  const database = createDatabase(":memory:");
  databases.push(database);
  const support = new SupportStore(database);
  const directory = new DirectoryStore(database);
  const account = support.upsertAccount({
    id: "ticket-context-account",
    phoneNumber: "+5547000000099",
    displayName: "Conta do contexto",
  });
  const client = support.upsertClient({
    id: "ticket-context-client",
    name: "Cadastro técnico",
    slug: "cadastro-tecnico-contexto",
    kind: "ecommerce",
  });
  const group = support.upsertGroup({
    id: "ticket-context-group",
    accountId: account.id,
    clientId: client.id,
    externalJid: "120363000099@g.us",
    subject: "Grupo do contexto",
  });
  const phone = support.upsertParticipant({
    id: "ticket-context-phone",
    externalJid: "5511912345699@s.whatsapp.net",
    phoneE164: "+5511912345699",
    displayName: "Pessoa do contexto",
  });
  const lid = support.upsertParticipant({
    id: "ticket-context-lid",
    externalJid: "900000000000199@lid",
    phoneE164: "+5511912345699",
    displayName: "Pessoa do contexto",
  });
  support.upsertIdentityLink({
    phoneJid: "5511912345699@s.whatsapp.net",
    lidJid: "900000000000199@lid",
    source: "test",
    observedAt: "2026-07-20T12:00:00.000Z",
  });
  support.addGroupParticipant(group.id, lid.id);
  const message = support.upsertMessage({
    id: "ticket-context-message",
    externalId: "ticket-context-message-external",
    groupId: group.id,
    senderId: lid.id,
    occurredAt: "2026-07-20T12:05:00.000Z",
    text: "Preciso revisar este atendimento.",
    messageType: "text",
    triageKind: "demand",
  });
  const ticket = support.createTicket({
    id: "ticket-context-ticket",
    groupId: group.id,
    sourceMessageId: message.id,
    title: "Revisar atendimento",
    summary: "Solicitante pede uma revisão.",
  });

  const typeId = organizationTypeId(directory);
  const plan = directory.createField(
    {
      recordTypeId: typeId,
      label: "Plano",
      type: "select",
      options: ["Essencial", "Pro"],
    },
    actor,
  );
  const groupRecord = directory.createRecord(
    {
      typeId,
      name: "Registro do grupo",
      groupIds: [group.id],
      values: { [plan.id]: "Pro" },
    },
    actor,
  );
  const requesterRecord = directory.createRecord(
    {
      typeId,
      name: "Registro do solicitante",
      personIds: [phone.id],
    },
    actor,
  );
  const explicitRecord = directory.createRecord(
    {
      typeId,
      name: "Registro específico",
    },
    actor,
  );

  const updated = support.updateTicketDirectoryContext(
    ticket.id,
    { recordIds: [explicitRecord.id, groupRecord.id] },
    "Pessoa operadora",
  );
  const byName = new Map(
    updated.directoryContext.records.map((record) => [record.name, record]),
  );
  assert.deepEqual(
    [...byName.keys()].toSorted(),
    [
      "Registro do grupo",
      "Registro do solicitante",
      "Registro específico",
    ].toSorted(),
  );
  assert.deepEqual(byName.get("Registro do grupo")?.sources, ["ticket", "group"]);
  assert.deepEqual(byName.get("Registro do solicitante")?.sources, [
    "requester",
  ]);
  assert.equal(
    byName.get("Registro do solicitante")?.id,
    requesterRecord.id,
  );
  assert.deepEqual(byName.get("Registro específico")?.sources, ["ticket"]);
  assert.deepEqual(
    byName.get("Registro do grupo")?.fields.map((field) => ({
      label: field.label,
      value: field.value,
      displayValue: field.displayValue,
    })),
    [{ label: "Plano", value: "Pro", displayValue: "Pro" }],
  );
  assert.deepEqual(
    updated.directoryContext.explicitRecordIds,
    [explicitRecord.id, groupRecord.id].toSorted(),
  );
  assert.deepEqual(
    support
      .getInvestigationContext(ticket.id)
      .directoryContext?.map((record) => record.name)
      .toSorted(),
    [
      "Registro do grupo",
      "Registro do solicitante",
      "Registro específico",
    ].toSorted(),
  );

  const eventCount = (
    database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM ticket_events
         WHERE ticket_id = ? AND event_type = 'ticket_directory_context_changed'`,
      )
      .get(ticket.id) as { count: number }
  ).count;
  const jobCount = (
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM investigation_jobs WHERE ticket_id = ?",
      )
      .get(ticket.id) as { count: number }
  ).count;
  support.updateTicketDirectoryContext(
    ticket.id,
    { recordIds: [groupRecord.id, explicitRecord.id] },
    "Pessoa operadora",
  );
  assert.equal(
    (
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM ticket_events
           WHERE ticket_id = ? AND event_type = 'ticket_directory_context_changed'`,
        )
        .get(ticket.id) as { count: number }
    ).count,
    eventCount,
  );
  assert.equal(
    (
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM investigation_jobs WHERE ticket_id = ?",
        )
        .get(ticket.id) as { count: number }
    ).count,
    jobCount,
  );
});
