import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import type { TriageAnalysis } from "../server/agent/types.js";
import {
  createDatabase,
  type SupportDatabase,
} from "../server/db/index.js";
import { SupportStore } from "../server/domain/index.js";
import { TriageAiScheduler } from "../server/triage/index.js";

interface Fixture {
  database: SupportDatabase;
  store: SupportStore;
  accountId: string;
  clientId: string;
  groupId: string;
  customerId: string;
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
    id: "edge-account",
    phoneNumber: "+5547999999999",
    displayName: "Acme Comercial",
  });
  const client = store.upsertClient({
    id: "edge-client",
    name: "Agência Edge",
    slug: "agencia-edge",
    kind: "agency",
  });
  const group = store.upsertGroup({
    id: "edge-group",
    accountId: account.id,
    clientId: client.id,
    externalJid: "120363000888@g.us",
    subject: "Acme + Agência Edge",
  });
  const customer = store.upsertParticipant({
    id: "edge-customer",
    externalJid: "5547888888888@s.whatsapp.net",
    phoneE164: "+5547888888888",
    displayName: "Cliente",
  });
  store.addGroupParticipant(group.id, customer.id);
  store.initializeTriageAiSettings({
    enabled: true,
    model: "gpt-5.4-mini-edge",
    actor: "test",
  });
  return {
    database,
    store,
    accountId: account.id,
    clientId: client.id,
    groupId: group.id,
    customerId: customer.id,
  };
}

function addMessage(
  current: Fixture,
  input: {
    id: string;
    occurredAt: string;
    text: string;
    groupId?: string;
    senderId?: string;
    providerMessageId?: string;
    quotedExternalId?: string;
    triageState?: "unreviewed" | "context";
    triageKind?: "unclassified" | "context";
  },
): string {
  return current.store.upsertMessage({
    id: input.id,
    externalId: `external-${input.id}`,
    providerMessageId: input.providerMessageId ?? `provider-${input.id}`,
    groupId: input.groupId ?? current.groupId,
    senderId: input.senderId ?? current.customerId,
    occurredAt: input.occurredAt,
    text: input.text,
    messageType: "conversation",
    quotedExternalId: input.quotedExternalId ?? null,
    triageKind: input.triageKind ?? "unclassified",
    triageState: input.triageState ?? "unreviewed",
    ingestionSource: "realtime_notify",
  }).id;
}

function scheduler(current: Fixture, candidateLimit = 50): TriageAiScheduler {
  return new TriageAiScheduler(current.store, {
    quietPeriodMs: 0,
    candidateLimit,
  });
}

function createAnalysis(messageIds: string[]): TriageAnalysis {
  return {
    groups: [
      {
        messageIds,
        kind: "demand",
        suggestedAction: "create",
        relatedTicketId: null,
        relatedSuggestionId: null,
        title: "Problema no dashboard",
        summary: "O cliente relatou um problema no dashboard.",
        affectedEcommerce: null,
        categories: {
          contactReason: ["Problema"],
          productArea: ["Dashboard"],
          platform: [],
          symptom: ["Dados não carregados"],
        },
        reason: "As mensagens descrevem a mesma demanda.",
        confidence: 0.9,
      },
    ],
  };
}

test("fallback libera e processa job recuperado depois que a IA foi desabilitada", () => {
  const current = fixture();
  const messageId = addMessage(current, {
    id: "disabled-demand",
    occurredAt: "2026-07-17T10:00:00.000Z",
    text: "O dashboard está com dados incorretos, podem verificar?",
  });
  assert.equal(scheduler(current).scheduleBatch(), 1);
  const claimed = current.store.claimNextAgentJob();
  assert.ok(claimed && claimed.kind === "triage");

  current.store.updateTriageAiSettings({
    enabled: false,
    model: "gpt-5.4-mini-edge",
    actor: "Operador",
  });
  assert.equal(current.store.recoverRunningTriageAiJobs(), 1);
  assert.equal(scheduler(current).runBatch(), 1);

  const job = current.database
    .prepare(
      "SELECT state, error FROM triage_ai_jobs WHERE id = ?",
    )
    .get(claimed.id) as { state: string; error: string };
  assert.equal(job.state, "failed");
  assert.match(job.error, /mensagens liberadas para fallback local/);
  assert.deepEqual(
    current.database
      .prepare(
        "SELECT active FROM triage_ai_job_messages WHERE job_id = ?",
      )
      .all(claimed.id),
    [{ active: 0 }],
  );
  assert.equal(current.store.listTriageCandidates().length, 0);
  const blocks = current.store.listConversationTriageBlocks(current.groupId).items;
  assert.equal(blocks.length, 0);
  assert.deepEqual(
    current.database
      .prepare(
        `
          SELECT block.confidence, membership.message_id
          FROM triage_blocks block
          JOIN triage_block_messages membership
            ON membership.block_id = block.id
          WHERE block.group_id = ?
        `,
      )
      .all(current.groupId),
    [{ confidence: 0.72, message_id: messageId }],
  );
});

test("resultado stale valida cobertura e libera todos os vínculos após restauração parcial", () => {
  const current = fixture();
  const first = addMessage(current, {
    id: "stale-first",
    occurredAt: "2026-07-17T11:00:00.000Z",
    text: "O dashboard não carrega.",
  });
  const second = addMessage(current, {
    id: "stale-second",
    occurredAt: "2026-07-17T11:00:30.000Z",
    text: "Também mostra dados incorretos.",
  });
  const context = addMessage(current, {
    id: "stale-context",
    occurredAt: "2026-07-17T11:00:15.000Z",
    text: "Vou verificar.",
    triageKind: "context",
    triageState: "context",
  });
  assert.equal(scheduler(current).scheduleBatch(), 1);
  const claimed = current.store.claimNextAgentJob();
  assert.ok(claimed && claimed.kind === "triage");

  current.store.ignoreConversationMessages(current.groupId, {
    messageIds: [first],
    clientRequestId: "ignore-running-job",
  });
  current.store.restoreConversationMessages(current.groupId, {
    messageIds: [first],
    clientRequestId: "restore-running-job",
  });

  assert.throws(
    () =>
      current.store.completeTriageAiJob(
        claimed.id,
        createAnalysis([first, second, context]),
      ),
    /mensagem fora do job/,
  );
  assert.equal(
    (
      current.database
        .prepare("SELECT state FROM triage_ai_jobs WHERE id = ?")
        .get(claimed.id) as { state: string }
    ).state,
    "running",
  );

  assert.equal(
    current.store.completeTriageAiJob(
      claimed.id,
      createAnalysis([first, second]),
    ),
    0,
  );
  assert.deepEqual(
    current.database
      .prepare(
        `SELECT message_id, active FROM triage_ai_job_messages
         WHERE job_id = ? ORDER BY position`,
      )
      .all(claimed.id),
    [
      { message_id: first, active: 0 },
      { message_id: second, active: 0 },
    ],
  );
  assert.deepEqual(
    current.store.listTriageCandidates().map((candidate) => candidate.id).sort(),
    [first, second].sort(),
  );
});

test("snapshot de triagem inclui staff, self, alvo citado e adjacências sem torná-los candidatos", () => {
  const current = fixture();
  const staff = current.store.upsertParticipant({
    id: "edge-staff",
    externalJid: "5500000000002@s.whatsapp.net",
    phoneE164: "+5500000000002",
    displayName: "Operador Fictício Beta",
  });
  const self = current.store.upsertParticipant({
    id: "edge-self",
    externalJid: "self:commercial-account",
    phoneE164: "+5500000000003",
    displayName: "Acme Comercial",
  });
  current.store.setStaffMember(staff.id, "Operador Fictício Beta");
  current.store.setStaffMember(self.id, "Acme Comercial");
  const quoted = addMessage(current, {
    id: "quoted-staff",
    providerMessageId: "quoted-provider-id",
    occurredAt: "2026-07-17T08:00:00.000Z",
    text: "A métrica considera clientes identificados no período.",
    senderId: staff.id,
    triageKind: "context",
    triageState: "context",
  });
  const before = addMessage(current, {
    id: "adjacent-before",
    occurredAt: "2026-07-17T09:59:00.000Z",
    text: "Estamos olhando a Loja Exemplo Ômega.",
    triageKind: "context",
    triageState: "context",
  });
  const selfMessage = addMessage(current, {
    id: "adjacent-self",
    occurredAt: "2026-07-17T09:59:30.000Z",
    text: "Pode enviar um print?",
    senderId: self.id,
    triageKind: "context",
    triageState: "context",
  });
  const candidate = addMessage(current, {
    id: "contextual-candidate",
    occurredAt: "2026-07-17T10:00:00.000Z",
    text: "Por que a soma de novos e recorrentes não fecha o total?",
    quotedExternalId: "quoted-provider-id",
  });
  const after = addMessage(current, {
    id: "adjacent-after",
    occurredAt: "2026-07-17T10:00:30.000Z",
    text: "Isso acontece no dashboard de clientes.",
    triageKind: "context",
    triageState: "context",
  });

  assert.equal(scheduler(current).scheduleBatch(), 1);
  const job = current.database
    .prepare("SELECT id FROM triage_ai_jobs")
    .get() as { id: string };
  const input = current.store.getTriageAiJobInput(job.id);
  assert.deepEqual(input.candidateMessageIds, [candidate]);
  assert.equal(input.messages.length, 5);
  assert.deepEqual(
    new Set(input.messages.map((message) => message.id)),
    new Set([quoted, before, selfMessage, candidate, after]),
  );
  assert.equal(
    input.messages.find((message) => message.id === quoted)?.role,
    "staff",
  );
  assert.equal(
    input.messages.find((message) => message.id === selfMessage)?.role,
    "self",
  );
  assert.equal(
    input.messages.find((message) => message.id === before)?.role,
    "external",
  );
  assert.equal(
    input.messages.find((message) => message.id === candidate)?.quotedMessageId,
    quoted,
  );
});

test("seleção de candidatos distribui o limite entre conversas", () => {
  const current = fixture();
  const secondGroup = current.store.upsertGroup({
    id: "edge-second-group",
    accountId: current.accountId,
    clientId: current.clientId,
    externalJid: "120363000999@g.us",
    subject: "Acme + Segundo Grupo",
  });
  for (let index = 0; index < 8; index += 1) {
    addMessage(current, {
      id: `busy-${index}`,
      occurredAt: `2026-07-17T12:00:0${index}.000Z`,
      text: `Problema ${index} no dashboard.`,
    });
  }
  const otherConversation = addMessage(current, {
    id: "other-conversation",
    groupId: secondGroup.id,
    occurredAt: "2026-07-17T13:00:00.000Z",
    text: "Problema nos pedidos desta outra conversa.",
  });

  const selected = current.store.listTriageCandidates(2);
  assert.deepEqual(
    new Set(selected.map((candidate) => candidate.group.id)),
    new Set([current.groupId, secondGroup.id]),
  );
  assert.equal(selected.some((candidate) => candidate.id === otherConversation), true);
  assert.equal(scheduler(current, 2).scheduleBatch(), 2);
  assert.equal(
    (
      current.database
        .prepare("SELECT COUNT(*) AS count FROM triage_ai_jobs")
        .get() as { count: number }
    ).count,
    2,
  );
});
