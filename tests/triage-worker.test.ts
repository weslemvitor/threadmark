import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import {
  createDatabase,
  type SupportDatabase,
} from "../server/db/index.js";
import { SupportStore } from "../server/domain/index.js";
import { TriageWorker } from "../server/triage/triage-worker.js";

interface Fixture {
  database: SupportDatabase;
  store: SupportStore;
  worker: TriageWorker;
  groupId: string;
  customerId: string;
  staffId: string;
}

const databases: SupportDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture(): Fixture {
  const database = createDatabase(":memory:");
  databases.push(database);
  const store = new SupportStore(database);
  const account = store.upsertAccount({
    id: "account",
    phoneNumber: "+5548999999999",
    displayName: "Acme Comercial",
  });
  const client = store.upsertClient({
    id: "client",
    name: "Cliente Teste",
    slug: "cliente-teste",
    kind: "ecommerce",
  });
  const group = store.upsertGroup({
    id: "group",
    accountId: account.id,
    clientId: client.id,
    externalJid: "120363000000@g.us",
    subject: "Acme + Cliente Teste",
  });
  const customer = store.upsertParticipant({
    id: "customer",
    externalJid: "5511999999999@s.whatsapp.net",
    phoneE164: "+5511999999999",
    displayName: "Cliente",
  });
  const staff = store.upsertParticipant({
    id: "staff",
    externalJid: "5548999999999@s.whatsapp.net",
    phoneE164: "+5548999999999",
    displayName: "Operador",
  });
  store.addGroupParticipant(group.id, customer.id);
  store.addGroupParticipant(group.id, staff.id);
  store.setStaffMember(staff.id, "Operador");

  return {
    database,
    store,
    worker: new TriageWorker(store),
    groupId: group.id,
    customerId: customer.id,
    staffId: staff.id,
  };
}

function addMessage(
  current: Fixture,
  input: {
    id: string;
    senderId?: string;
    occurredAt: string;
    text: string;
    triageState?: "unreviewed" | "context";
  },
): string {
  return current.store.upsertMessage({
    id: input.id,
    externalId: `wa-${input.id}`,
    groupId: current.groupId,
    senderId: input.senderId ?? current.customerId,
    occurredAt: input.occurredAt,
    text: input.text,
    messageType: "conversation",
    triageState: input.triageState,
  }).id;
}

function rowCount(database: SupportDatabase, table: string): number {
  return (
    database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    }
  ).count;
}

test("triagem registra sugestão supervisionada sem criar ticket nem executar Codex", () => {
  const current = fixture();
  addMessage(current, {
    id: "first-demand",
    occurredAt: "2026-07-16T12:00:00.000Z",
    text: "Os pedidos sumiram do dashboard, conseguem verificar?",
  });

  assert.deepEqual(current.worker.runBatch(), {
    processed: 1,
    suggestedCreate: 1,
    suggestedAttach: 0,
    suggestedIgnore: 0,
    failed: 0,
  });
  assert.equal(rowCount(current.database, "tickets"), 0);
  assert.equal(rowCount(current.database, "investigation_jobs"), 0);
  assert.deepEqual(
    current.database
      .prepare(
        `SELECT state, triage_kind, suggested_action
         FROM triage_blocks`,
      )
      .get(),
    { state: "pending", triage_kind: "demand", suggested_action: "create" },
  );
  assert.deepEqual(
    current.database
      .prepare(
        `SELECT triage_kind, triage_state
         FROM messages WHERE id = 'first-demand'`,
      )
      .get(),
    { triage_kind: "demand", triage_state: "unreviewed" },
  );

  assert.equal(current.worker.runBatch().processed, 0);
  assert.equal(rowCount(current.database, "triage_blocks"), 1);
});

test("sequência da Loja Fictícia Ômega promove a saudação e forma um único bloco pendente", () => {
  const current = fixture();
  addMessage(current, {
    id: "fictional-omega-greeting",
    occurredAt: "2026-07-16T12:00:00.000Z",
    text: "Bom dia, pessoal",
  });
  addMessage(current, {
    id: "fictional-omega-demand",
    occurredAt: "2026-07-16T12:00:40.000Z",
    text: "Não estamos conseguindo integrar a Loja Fictícia Ômega",
  });
  addMessage(current, {
    id: "fictional-omega-context",
    occurredAt: "2026-07-16T12:01:30.000Z",
    text: "Esse é o cliente",
  });

  assert.deepEqual(current.worker.runBatch(), {
    processed: 3,
    suggestedCreate: 2,
    suggestedAttach: 0,
    suggestedIgnore: 1,
    failed: 0,
  });
  assert.equal(rowCount(current.database, "tickets"), 0);
  assert.equal(rowCount(current.database, "investigation_jobs"), 0);
  assert.equal(rowCount(current.database, "triage_blocks"), 1);
  assert.deepEqual(
    current.database
      .prepare(
        `SELECT state, suggested_action, first_message_at, last_message_at
         FROM triage_blocks WHERE state = 'pending'`,
      )
      .get(),
    {
      state: "pending",
      suggested_action: "create",
      first_message_at: "2026-07-16T12:00:00.000Z",
      last_message_at: "2026-07-16T12:01:30.000Z",
    },
  );
  assert.deepEqual(
    current.database
      .prepare(
        `SELECT message.id, message.triage_kind, message.triage_state
         FROM triage_block_messages link
         JOIN messages message ON message.id = link.message_id
         WHERE link.active = 1
         ORDER BY message.occurred_at`,
      )
      .all(),
    [
      {
        id: "fictional-omega-greeting",
        triage_kind: "social",
        triage_state: "unreviewed",
      },
      {
        id: "fictional-omega-demand",
        triage_kind: "demand",
        triage_state: "unreviewed",
      },
      {
        id: "fictional-omega-context",
        triage_kind: "uncertain",
        triage_state: "unreviewed",
      },
    ],
  );
});

test("saudação isolada é colapsada sem bloco pendente e permanece auditável", () => {
  const current = fixture();
  addMessage(current, {
    id: "greeting",
    occurredAt: "2026-07-16T12:00:00.000Z",
    text: "Bom dia!",
  });

  assert.equal(current.worker.runBatch().suggestedIgnore, 1);
  assert.deepEqual(
    current.database
      .prepare(
        `SELECT block.state, block.suggested_action, message.triage_state
         FROM triage_blocks block
         JOIN triage_block_messages link ON link.block_id = block.id
         JOIN messages message ON message.id = link.message_id`,
      )
    .get(),
    {
      state: "ignored",
      suggested_action: "ignore",
      triage_state: "ignored",
    },
  );
  assert.equal(
    (
      current.database
        .prepare("SELECT COUNT(*) AS count FROM triage_blocks WHERE state = 'pending'")
        .get() as { count: number }
    ).count,
    0,
  );
});

test("agradecimento isolado é ignorado pelo worker sem bloco pendente", () => {
  const current = fixture();
  addMessage(current, {
    id: "thanks",
    occurredAt: "2026-07-16T12:00:00.000Z",
    text: "Perfeito, obrigado",
  });

  assert.deepEqual(current.worker.runBatch(), {
    processed: 1,
    suggestedCreate: 0,
    suggestedAttach: 0,
    suggestedIgnore: 1,
    failed: 0,
  });
  assert.deepEqual(
    current.database
      .prepare(
        `SELECT block.state, block.triage_kind AS block_triage_kind,
                block.suggested_action,
                message.triage_kind AS message_triage_kind,
                message.triage_state
         FROM triage_blocks block
         JOIN triage_block_messages link ON link.block_id = block.id
         JOIN messages message ON message.id = link.message_id`,
      )
      .get(),
    {
      state: "ignored",
      block_triage_kind: "social",
      suggested_action: "ignore",
      message_triage_kind: "social",
      triage_state: "ignored",
    },
  );
  assert.equal(
    (
      current.database
        .prepare("SELECT COUNT(*) AS count FROM triage_blocks WHERE state = 'pending'")
        .get() as { count: number }
    ).count,
    0,
  );
});

test("sugestão de anexar não altera o ticket confirmado nem enfileira investigação", () => {
  const current = fixture();
  const sourceMessageId = addMessage(current, {
    id: "existing-source",
    occurredAt: "2026-07-16T12:00:00.000Z",
    text: "Os pedidos sumiram do dashboard.",
    triageState: "context",
  });
  const ticket = current.store.createTicket({
    id: "existing-ticket",
    groupId: current.groupId,
    sourceMessageId,
    title: "Pedidos ausentes",
    summary: "Os pedidos sumiram do dashboard.",
  });
  addMessage(current, {
    id: "continuation",
    occurredAt: "2026-07-16T12:01:00.000Z",
    text: "Também reparei que a receita está zerada.",
  });

  assert.equal(current.worker.runBatch().suggestedAttach, 1);
  assert.deepEqual(
    current.database
      .prepare(
        `SELECT suggested_action, suggested_ticket_id, confirmed_ticket_id
         FROM triage_blocks`,
      )
      .get(),
    {
      suggested_action: "attach",
      suggested_ticket_id: ticket.id,
      confirmed_ticket_id: null,
    },
  );
  assert.equal(rowCount(current.database, "ticket_messages"), 1);
  assert.equal(rowCount(current.database, "investigation_jobs"), 0);
});

test("falha ao persistir sugestão é atômica e permite nova tentativa", () => {
  const current = fixture();
  addMessage(current, {
    id: "retry-demand",
    occurredAt: "2026-07-16T13:00:00.000Z",
    text: "Os pedidos sumiram, conseguem verificar?",
  });

  const recordSuggestion = current.store.recordTriageSuggestion.bind(current.store);
  current.store.recordTriageSuggestion = () => {
    throw new Error("interrupção simulada");
  };
  assert.deepEqual(current.worker.runBatch(), {
    processed: 1,
    suggestedCreate: 0,
    suggestedAttach: 0,
    suggestedIgnore: 0,
    failed: 1,
  });
  assert.equal(rowCount(current.database, "triage_blocks"), 0);
  assert.equal(current.store.listTriageCandidates().length, 1);

  current.store.recordTriageSuggestion = recordSuggestion;
  assert.equal(current.worker.runBatch().suggestedCreate, 1);
  assert.equal(rowCount(current.database, "triage_blocks"), 1);
  assert.equal(rowCount(current.database, "tickets"), 0);
});
