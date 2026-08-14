import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import type { TriageAnalysis } from "../server/agent/types.js";
import { InvestigationWorker } from "../server/agent/investigation-worker.js";
import {
  createDatabase,
  type SupportDatabase,
} from "../server/db/index.js";
import { SupportStore } from "../server/domain/index.js";
import {
  TRIAGE_PROMPT_VERSION,
  TriageAiScheduler,
} from "../server/triage/index.js";

interface Fixture {
  database: SupportDatabase;
  store: SupportStore;
  groupId: string;
  customerId: string;
  selfId: string;
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
    id: "triage-ai-account",
    phoneNumber: "+5547999999999",
    displayName: "Acme Comercial",
  });
  const client = store.upsertClient({
    id: "triage-ai-client",
    name: "Agência Semântica",
    slug: "agencia-semantica",
    kind: "agency",
  });
  store.upsertStore({
    id: "triage-ai-store",
    clientId: client.id,
    name: "Loja Exemplo Ômega",
    businessId: "example-business-omega",
    platform: "Shopify",
  });
  const group = store.upsertGroup({
    id: "triage-ai-group",
    accountId: account.id,
    clientId: client.id,
    externalJid: "120363000777@g.us",
    subject: "Acme + Agência Semântica",
  });
  const customer = store.upsertParticipant({
    id: "triage-ai-customer",
    externalJid: "5547888888888@s.whatsapp.net",
    phoneE164: "+5547888888888",
    displayName: "Cliente",
  });
  store.addGroupParticipant(group.id, customer.id);
  const self = store.upsertParticipant({
    id: "triage-ai-self",
    externalJid: "self:commercial-account",
    displayName: "Acme Comercial",
  });
  store.setStaffMember(self.id, "Acme Comercial");
  store.addGroupParticipant(group.id, self.id);
  store.initializeTriageAiSettings({
    enabled: true,
    model: "gpt-5.4-mini-test",
    actor: "test",
  });
  return {
    database,
    store,
    groupId: group.id,
    customerId: customer.id,
    selfId: self.id,
  };
}

function addMessage(
  current: Fixture,
  id: string,
  occurredAt: string,
  text: string,
): string {
  return current.store.upsertMessage({
    id,
    externalId: `wa-${id}`,
    groupId: current.groupId,
    senderId: current.customerId,
    occurredAt,
    text,
    messageType: "conversation",
    triageKind: "unclassified",
    triageState: "unreviewed",
    ingestionSource: "realtime_notify",
  }).id;
}

function addStaffMessage(
  current: Fixture,
  id: string,
  occurredAt: string,
  text: string,
  quotedExternalId?: string,
): string {
  return current.store.upsertMessage({
    id,
    externalId: `wa-${id}`,
    providerMessageId: `provider-${id}`,
    groupId: current.groupId,
    senderId: current.selfId,
    occurredAt,
    text,
    messageType: "conversation",
    quotedExternalId,
    triageKind: "context",
    triageState: "context",
    ingestionSource: "realtime_notify",
  }).id;
}

function rowCount(database: SupportDatabase, table: string): number {
  return (
    database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    }
  ).count;
}

function seedTriageContextWait(
  current: Fixture,
  messageIds: readonly string[],
): void {
  const timestamp = new Date().toISOString();
  current.database
    .prepare(
      `INSERT INTO triage_context_waits
        (group_id, message_ids_json, reason, model, prompt_version,
         created_at, updated_at)
       VALUES (?, ?, 'Aguardando contexto', 'test-model', ?, ?, ?)
       ON CONFLICT(group_id) DO UPDATE SET
         message_ids_json = excluded.message_ids_json,
         updated_at = excluded.updated_at`,
    )
    .run(
      current.groupId,
      JSON.stringify(messageIds),
      TRIAGE_PROMPT_VERSION,
      timestamp,
      timestamp,
    );
}

function waitingMessageIds(current: Fixture): string[] {
  const row = current.database
    .prepare(
      "SELECT message_ids_json FROM triage_context_waits WHERE group_id = ?",
    )
    .get(current.groupId) as { message_ids_json: string } | undefined;
  return row ? JSON.parse(row.message_ids_json) as string[] : [];
}

function scheduler(current: Fixture, model = "triage-semantic-test") {
  return new TriageAiScheduler(current.store, {
    quietPeriodMs: 0,
    clusterGapMs: 30 * 60_000,
    candidateLimit: 50,
  }).scheduleBatch(model);
}

function twoGroupAnalysis(
  metricMessageIds: string[],
  campaignMessageIds: string[],
): TriageAnalysis {
  return {
    groups: [
      {
        messageIds: metricMessageIds,
        kind: "demand",
        suggestedAction: "create",
        relatedTicketId: null,
        relatedSuggestionId: null,
        title: "Divergência no total de clientes",
        summary: "O total não confere com clientes novos e recorrentes.",
        affectedEcommerce: "Loja Exemplo Ômega",
        categories: {
          contactReason: ["Pergunta"],
          productArea: ["Painel"],
          platform: ["Google"],
          symptom: ["Dados divergentes"],
        },
        reason: "As mensagens descrevem a mesma dúvida de métrica.",
        confidence: 0.91,
      },
      {
        messageIds: campaignMessageIds,
        kind: "demand",
        suggestedAction: "create",
        relatedTicketId: null,
        relatedSuggestionId: null,
        title: "Campanha sem envios",
        summary: "Uma campanha do CRM não realizou os envios esperados.",
        affectedEcommerce: "Loja Exemplo Ômega",
        categories: {
          contactReason: ["Problema"],
          productArea: ["Campanhas"],
          platform: ["Meta Ads"],
          symptom: ["Mensagens não enviadas"],
        },
        reason: "A campanha é um assunto diferente da dúvida de métrica.",
        confidence: 0.92,
      },
    ],
  };
}

function completeTwoGroupJob(current: Fixture) {
  const metricQuestion = addMessage(
    current,
    "metric-question",
    "2026-07-17T12:00:00.000Z",
    "Como funciona o total de clientes?",
  );
  const metricDetail = addMessage(
    current,
    "metric-detail",
    "2026-07-17T12:00:30.000Z",
    "A soma de novos e recorrentes não chega no total.",
  );
  const campaignProblem = addMessage(
    current,
    "campaign-problem",
    "2026-07-17T12:01:00.000Z",
    "Outra coisa: a campanha não enviou nenhuma mensagem.",
  );
  assert.equal(scheduler(current), 1);
  const claimed = current.store.claimNextAgentJob();
  assert.ok(claimed);
  assert.equal(claimed.kind, "triage");
  if (claimed.kind !== "triage") assert.fail("Job de triagem não foi reivindicado");

  const analysis = twoGroupAnalysis(
    [metricQuestion, metricDetail],
    [campaignProblem],
  );
  assert.equal(current.store.completeTriageAiJob(claimed.id, analysis), 2);
  return {
    jobId: claimed.id,
    metricQuestion,
    metricDetail,
    campaignProblem,
  };
}

test("configuração da triagem por IA permanece no SQLite", () => {
  const current = fixture();

  const updated = current.store.updateTriageAiSettings({
    enabled: false,
    model: "gpt-5.4-mini-custom",
    actor: "Operador",
  });

  assert.equal(updated.enabled, false);
  assert.equal(updated.model, "gpt-5.4-mini-custom");
  assert.equal(updated.updatedBy, "Operador");
  assert.deepEqual(
    current.database
      .prepare(
        `SELECT singleton, enabled, model, updated_by
         FROM triage_ai_settings`,
      )
      .get(),
    {
      singleton: 1,
      enabled: 0,
      model: "gpt-5.4-mini-custom",
      updated_by: "Operador",
    },
  );
  assert.deepEqual(new SupportStore(current.database).getTriageAiSettings(), updated);
});

test("scheduler espera o bloco ficar quieto, enfileira uma vez e deduplica", () => {
  const current = fixture();
  addMessage(
    current,
    "quiet-first",
    "2026-07-17T10:00:00.000Z",
    "Os pedidos não aparecem no dashboard.",
  );
  addMessage(
    current,
    "quiet-detail",
    "2026-07-17T10:00:20.000Z",
    "A loja afetada é a Loja Exemplo Ômega.",
  );
  const aiScheduler = new TriageAiScheduler(current.store, {
    quietPeriodMs: 60_000,
    clusterGapMs: 30 * 60_000,
  });

  assert.equal(aiScheduler.scheduleBatch("triage-quiet-model"), 1);
  assert.equal(aiScheduler.scheduleBatch("triage-quiet-model"), 0);
  assert.equal(rowCount(current.database, "triage_ai_jobs"), 1);
  assert.equal(rowCount(current.database, "triage_ai_job_messages"), 2);
  assert.deepEqual(
    current.database
      .prepare(
        `SELECT state, model, prompt_version
         FROM triage_ai_jobs`,
      )
      .get(),
    {
      state: "queued",
      model: "triage-quiet-model",
      prompt_version: TRIAGE_PROMPT_VERSION,
    },
  );
  assert.equal(current.store.listTriageCandidates().length, 0);
});

test("triagem aguarda a transcrição do áudio antes de montar o contexto", () => {
  const current = fixture();
  const messageId = addMessage(
    current,
    "audio-pending-triage",
    "2026-07-17T10:00:00.000Z",
    "Áudio recebido",
  );
  current.database
    .prepare("UPDATE messages SET message_type = 'audioMessage' WHERE id = ?")
    .run(messageId);
  const attachment = current.store.upsertAttachment({
    id: "audio-pending-triage-attachment",
    messageId,
    kind: "audio",
    mimeType: "audio/ogg; codecs=opus",
    fileName: "audio.ogg",
    localPath: "/tmp/audio-pending-triage.ogg",
    sizeBytes: 128,
    sha256: "audio-pending-triage-sha",
    available: true,
  });
  const timestamp = new Date().toISOString();
  current.database
    .prepare(
      `INSERT INTO audio_transcriptions (
         attachment_id, message_id, status, source, model_id, language,
         text, confidence, duration_seconds, error, attempts,
         requested_at, started_at, completed_at, created_at, updated_at
       ) VALUES (?, ?, 'queued', 'realtime', 'onnx-community/whisper-small',
                 'pt', NULL, NULL, NULL, NULL, 0, ?, NULL, NULL, ?, ?)`,
    )
    .run(attachment.id, messageId, timestamp, timestamp, timestamp);

  assert.equal(scheduler(current), 0);
  assert.equal(
    current.store.getConversationSuggestionAnalysis(current.groupId).state,
    "waiting_for_audio",
  );
  assert.throws(
    () => current.store.triggerConversationTriageAnalysis(current.groupId, {
      promptVersion: TRIAGE_PROMPT_VERSION,
    }),
    /transcrição do áudio/i,
  );

  current.database.transaction(() => {
    current.database
      .prepare(
        `UPDATE audio_transcriptions
         SET status = 'completed', text = ?, completed_at = ?, updated_at = ?
         WHERE attachment_id = ?`,
      )
      .run("O dashboard não atualizou os pedidos.", timestamp, timestamp, attachment.id);
    current.database
      .prepare("UPDATE attachments SET extracted_text = ?, updated_at = ? WHERE id = ?")
      .run(
        "Transcrição do áudio:\nO dashboard não atualizou os pedidos.",
        timestamp,
        attachment.id,
      );
  })();

  assert.equal(scheduler(current), 1);
  const claimed = current.store.claimNextAgentJob();
  assert.ok(claimed?.kind === "triage");
  if (!claimed || claimed.kind !== "triage") assert.fail("Job não encontrado");
  const input = current.store.getTriageAiJobInput(claimed.id);
  assert.match(JSON.stringify(input.messages), /dashboard não atualizou os pedidos/i);
});

test("áudio enfileirado depois da mensagem invalida uma triagem que perdeu a corrida", () => {
  const current = fixture();
  const messageId = addMessage(
    current,
    "audio-race-triage",
    "2026-07-17T10:00:00.000Z",
    "Conseguem verificar este áudio?",
  );
  assert.equal(scheduler(current), 1);

  current.store.deferTriageForPendingAudio(messageId);

  assert.deepEqual(
    current.database
      .prepare("SELECT state, error FROM triage_ai_jobs")
      .get(),
    {
      state: "failed",
      error: "Áudio aguardando transcrição; contexto reagendado",
    },
  );
});

test("job reivindicado separa dois assuntos exatos e expõe IA e categorias canonizadas no DTO", () => {
  const current = fixture();
  const completed = completeTwoGroupJob(current);

  assert.equal(
    current.store.completeTriageAiJob(
      completed.jobId,
      twoGroupAnalysis(
        [completed.metricQuestion, completed.metricDetail],
        [completed.campaignProblem],
      ),
    ),
    0,
  );
  const blocks = current.store.listConversationTriageBlocks(current.groupId).items;
  assert.equal(blocks.length, 2);
  const metric = blocks.find((block) => block.messageIds.length === 2);
  const campaign = blocks.find((block) => block.messageIds.length === 1);
  assert.ok(metric);
  assert.ok(campaign);
  assert.deepEqual(metric.messageIds, [
    completed.metricQuestion,
    completed.metricDetail,
  ]);
  assert.deepEqual(metric.proposedCategories, {
    contactReason: ["Dúvida"],
    productArea: ["Dashboard"],
    platform: ["Google Ads"],
    symptom: ["Dados incorretos"],
  });
  assert.deepEqual(metric.ai, {
    model: "triage-semantic-test",
    promptVersion: TRIAGE_PROMPT_VERSION,
    fallbackUsed: false,
  });
  assert.deepEqual(campaign.proposedCategories, {
    contactReason: ["Problema"],
    productArea: ["CRM"],
    platform: ["Meta"],
    symptom: ["Mensagens não enviadas"],
  });
  assert.equal(rowCount(current.database, "categories"), 0);
  assert.equal(rowCount(current.database, "triage_blocks"), 2);
  assert.deepEqual(
    current.database
      .prepare(
        `SELECT state, attempt_count, fallback_used
         FROM triage_ai_jobs WHERE id = ?`,
      )
      .get(completed.jobId),
    { state: "completed", attempt_count: 1, fallback_used: 0 },
  );
});

test("IA vincula automaticamente ao ticket apenas com contexto interno e alta confiança", () => {
  const current = fixture();
  const source = addMessage(
    current,
    "auto-attach-source",
    "2026-07-17T13:00:00.000Z",
    "Os totais de clientes do dashboard estão incorretos.",
  );
  const ticket = current.store.createTicket({
    id: "auto-attach-ticket",
    groupId: current.groupId,
    sourceMessageId: source,
    title: "Totais incorretos no dashboard",
    summary: "Cliente relata divergência nos totais de clientes.",
  });
  const continuation = addMessage(
    current,
    "auto-attach-continuation",
    "2026-07-17T13:05:00.000Z",
    "A divergência de clientes recorrentes continua no mesmo dashboard.",
  );
  const response = addStaffMessage(
    current,
    "auto-attach-staff-response",
    "2026-07-17T13:06:00.000Z",
    "Vou conferir a regra de clientes recorrentes desse dashboard.",
  );

  assert.equal(scheduler(current), 1);
  const claimed = current.store.claimNextAgentJob();
  assert.ok(claimed?.kind === "triage");
  if (!claimed || claimed.kind !== "triage") assert.fail("Job não encontrado");
  const input = current.store.getTriageAiJobInput(claimed.id);
  assert.equal(
    input.messages.find((message) => message.id === response)?.role,
    "self",
  );

  assert.equal(
    current.store.completeTriageAiJob(claimed.id, {
      groups: [{
        messageIds: [continuation],
        contextMessageIds: [response],
        kind: "continuation",
        suggestedAction: "attach",
        relatedTicketId: ticket.id,
        relatedSuggestionId: null,
        title: "Continuação da divergência no dashboard",
        summary: "A divergência de clientes recorrentes continua.",
        affectedEcommerce: null,
        categories: {
          contactReason: ["Problema"],
          productArea: ["Dashboard"],
          platform: [],
          symptom: ["Dados incorretos"],
        },
        reason: "A mensagem e a resposta da equipe continuam o mesmo assunto.",
        confidence: 0.97,
      }],
    }),
    1,
  );

  const linkedIds = (
    current.database
      .prepare(
        `SELECT message_id FROM ticket_messages
         WHERE ticket_id = ? ORDER BY message_id`,
      )
      .all(ticket.id) as Array<{ message_id: string }>
  ).map((row) => row.message_id);
  assert.deepEqual(linkedIds, [continuation, source, response].toSorted());
  assert.equal(
    current.store.getTicketDetail(ticket.id).sentResponses[0]?.messageId,
    response,
  );
  assert.equal(
    current.store.listConversationTriageBlocks(current.groupId).items.length,
    0,
  );
  assert.deepEqual(
    current.database
      .prepare(
        "SELECT triage_kind, triage_state FROM messages WHERE id = ?",
      )
      .get(response),
    { triage_kind: "context", triage_state: "context" },
  );
});

test("mudança explícita de assunto impede vínculo automático e mantém resposta da equipe para revisão", () => {
  const current = fixture();
  const source = addMessage(
    current,
    "topic-switch-source",
    "2026-07-17T14:00:00.000Z",
    "Os dados do dashboard estão incorretos.",
  );
  const ticket = current.store.createTicket({
    id: "topic-switch-ticket",
    groupId: current.groupId,
    sourceMessageId: source,
    title: "Dados incorretos no dashboard",
    summary: "Cliente relata divergência no dashboard.",
  });
  const otherProblem = addMessage(
    current,
    "topic-switch-email",
    "2026-07-17T14:05:00.000Z",
    "Outro problema é que não estou recebendo os e-mails de algumas campanhas.",
  );
  const response = addStaffMessage(
    current,
    "topic-switch-staff-response",
    "2026-07-17T14:06:00.000Z",
    "Vou verificar quais campanhas não enviaram os e-mails.",
  );

  assert.equal(scheduler(current), 1);
  const claimed = current.store.claimNextAgentJob();
  assert.ok(claimed?.kind === "triage");
  if (!claimed || claimed.kind !== "triage") assert.fail("Job não encontrado");

  current.store.completeTriageAiJob(claimed.id, {
    groups: [{
      messageIds: [otherProblem],
      contextMessageIds: [response],
      kind: "demand",
      suggestedAction: "attach",
      relatedTicketId: ticket.id,
      relatedSuggestionId: null,
      title: "Campanhas sem envio de e-mail",
      summary: "O cliente não recebe e-mails de algumas campanhas.",
      affectedEcommerce: null,
      categories: {
        contactReason: ["Problema"],
        productArea: ["CRM"],
        platform: [],
        symptom: ["Mensagens não enviadas"],
      },
      reason: "Modelo sugeriu vínculo, mas a mensagem declara outro problema.",
      confidence: 0.99,
    }],
  });

  const detail = current.store.getTicketDetail(ticket.id);
  assert.equal(detail.messageCount, 1);
  assert.equal(detail.sentResponses.length, 0);
  const pending = current.store.listConversationTriageBlocks(current.groupId).items;
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0]?.messageIds, [otherProblem, response]);
  assert.equal(pending[0]?.suggestedTicketId, ticket.id);
});

test("seleção exata promove as categorias provisórias para o ticket", () => {
  const current = fixture();
  const completed = completeTwoGroupJob(current);

  const created = current.store.createTicketFromConversation(current.groupId, {
    messageIds: [completed.metricQuestion, completed.metricDetail],
    clientRequestId: "exact-ai-selection",
    actor: "Operador",
  });

  assert.ok(created.ticket);
  assert.deepEqual(
    created.ticket.categories
      .map(({ facet, label }) => ({ facet, label }))
      .sort((left, right) => left.facet.localeCompare(right.facet)),
    [
      { facet: "platform", label: "Google Ads" },
      { facet: "product", label: "Dashboard" },
      { facet: "reason", label: "Dúvida" },
      { facet: "symptom", label: "Dados incorretos" },
    ],
  );
  assert.equal(
    (
      current.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM ticket_categories WHERE ticket_id = ? AND source = 'ai'`,
        )
        .get(created.ticket.id) as { count: number }
    ).count,
    4,
  );
});

test("seleção parcial não promove categorias provisórias", () => {
  const current = fixture();
  const completed = completeTwoGroupJob(current);

  const created = current.store.createTicketFromConversation(current.groupId, {
    messageIds: [completed.metricQuestion],
    clientRequestId: "partial-ai-selection",
    actor: "Operador",
  });

  assert.ok(created.ticket);
  assert.deepEqual(created.ticket.categories, []);
  assert.equal(
    (
      current.database
        .prepare(
          "SELECT COUNT(*) AS count FROM ticket_categories WHERE ticket_id = ?",
        )
        .get(created.ticket.id) as { count: number }
    ).count,
    0,
  );
});

test("restaurar mensagens libera uma nova geração de triagem por IA", () => {
  const current = fixture();
  const completed = completeTwoGroupJob(current);

  current.store.ignoreConversationMessages(current.groupId, {
    messageIds: [completed.metricQuestion, completed.metricDetail],
    clientRequestId: "ignore-ai-generation",
  });
  current.store.restoreConversationMessages(current.groupId, {
    messageIds: [completed.metricQuestion, completed.metricDetail],
    clientRequestId: "restore-ai-generation",
  });

  assert.equal(scheduler(current), 1);
  assert.equal(rowCount(current.database, "triage_ai_jobs"), 2);
  const jobs = current.database
    .prepare(
      `SELECT id, fingerprint, state
       FROM triage_ai_jobs ORDER BY requested_at, id`,
    )
    .all() as Array<{ id: string; fingerprint: string; state: string }>;
  assert.equal(new Set(jobs.map((job) => job.fingerprint)).size, 2);
  assert.equal(jobs.some((job) => job.state === "queued"), true);
  assert.equal(
    (
      current.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM triage_ai_job_messages
           WHERE message_id IN (?, ?) AND active = 1`,
        )
        .get(completed.metricQuestion, completed.metricDetail) as {
        count: number;
      }
    ).count,
    2,
  );
});

test("worker usa fallback local depois de duas falhas da triagem Codex", async () => {
  const current = fixture();
  addMessage(
    current,
    "fallback-demand",
    "2026-07-17T18:00:00.000Z",
    "Os pedidos sumiram do dashboard, conseguem verificar?",
  );
  assert.equal(scheduler(current, "triage-fallback-model"), 1);
  let attempts = 0;
  const events: string[] = [];
  const worker = new InvestigationWorker(
    current.store,
    {
      async analyse() {
        throw new Error("investigação de ticket não esperada");
      },
      async investigateThread() {
        throw new Error("turno profundo não esperado");
      },
      async triage() {
        attempts += 1;
        throw new Error(`falha semântica ${attempts}`);
      },
    },
    {
      recoverOrphanedJobs: false,
      onEvent: (event) =>
        events.push(
          event.type === "idle" ? event.type : `${event.type}:${event.jobKind}`,
        ),
    },
  );

  assert.equal(await worker.runOne(), true);
  assert.deepEqual(
    current.database
      .prepare(
        `SELECT state, attempt_count, fallback_used
         FROM triage_ai_jobs`,
      )
      .get(),
    { state: "queued", attempt_count: 1, fallback_used: 0 },
  );
  assert.equal(await worker.runOne(), true);

  assert.equal(attempts, 2);
  assert.deepEqual(events, [
    "started:triage",
    "requeued:triage",
    "started:triage",
    "completed:triage",
  ]);
  assert.deepEqual(
    current.database
      .prepare(
        `SELECT state, attempt_count, fallback_used, error
         FROM triage_ai_jobs`,
      )
      .get(),
    {
      state: "completed",
      attempt_count: 2,
      fallback_used: 1,
      error: "falha semântica 2",
    },
  );
  assert.equal(
    current.store.listConversationTriageBlocks(current.groupId).items.length,
    0,
  );
  assert.deepEqual(
    current.database
      .prepare(
        `SELECT confidence, ai_model, ai_prompt_version, ai_fallback_used,
                proposed_categories_json
         FROM triage_blocks`,
      )
      .get(),
    {
      confidence: 0.72,
      ai_model: "triage-fallback-model",
      ai_prompt_version: TRIAGE_PROMPT_VERSION,
      ai_fallback_used: 1,
      proposed_categories_json: JSON.stringify({
        contactReason: [],
        productArea: [],
        platform: [],
        symptom: [],
      }),
    },
  );
});

test("janela persistida de três minutos espera a conversa e ignora mensagens da equipe", () => {
  const current = fixture();
  current.store.updateTriageAiSettings({
    enabled: true,
    model: "triage-silence-model",
    silenceWindowSeconds: 180,
    actor: "Operador",
  });
  const externalAt = new Date(Date.now() - 181_000).toISOString();
  addMessage(
    current,
    "silence-external",
    externalAt,
    "Os pedidos não aparecem desde a troca da credencial.",
  );
  const staff = current.store.upsertParticipant({
    id: "triage-silence-staff",
    externalJid: "5500000000001@s.whatsapp.net",
    phoneE164: "+5500000000001",
    displayName: "Operador",
  });
  current.store.setStaffMember(staff.id, "Operador");
  current.store.upsertMessage({
    id: "silence-staff-context",
    externalId: "wa-silence-staff-context",
    groupId: current.groupId,
    senderId: staff.id,
    occurredAt: new Date().toISOString(),
    text: "Vou verificar o contexto.",
    messageType: "conversation",
    triageKind: "context",
    triageState: "context",
    ingestionSource: "realtime_notify",
  });

  const persistedScheduler = new TriageAiScheduler(current.store);
  assert.equal(persistedScheduler.scheduleBatch(), 1);
  assert.equal(
    current.store.getConversationSuggestionAnalysis(current.groupId).state,
    "queued",
  );
});

test("nova mensagem externa reinicia a janela e torna o job antigo obsoleto", () => {
  const current = fixture();
  const first = addMessage(
    current,
    "rescheduled-first",
    new Date(Date.now() - 181_000).toISOString(),
    "O dashboard não carrega os pedidos.",
  );
  const persistedScheduler = new TriageAiScheduler(current.store);
  assert.equal(persistedScheduler.scheduleBatch(), 1);

  const second = addMessage(
    current,
    "rescheduled-second",
    new Date().toISOString(),
    "A loja afetada é a Loja Exemplo Ômega.",
  );

  assert.deepEqual(
    current.database
      .prepare("SELECT state, error FROM triage_ai_jobs")
      .get(),
    {
      state: "failed",
      error: "Nova mensagem recebida; contexto reagendado",
    },
  );
  assert.equal(persistedScheduler.scheduleBatch(), 0);
  assert.equal(
    current.store.getConversationSuggestionAnalysis(current.groupId).state,
    "waiting_for_silence",
  );
  assert.deepEqual(
    current.store.listTriageCandidates().map(({ id }) => id),
    [first, second],
  );
});

test("nova resposta da equipe reagenda job para incluir o contexto interno", () => {
  const current = fixture();
  const candidate = addMessage(
    current,
    "staff-context-refresh-candidate",
    new Date(Date.now() - 5 * 60_000).toISOString(),
    "Os e-mails de algumas campanhas não foram enviados.",
  );
  assert.equal(scheduler(current), 1);

  const response = addStaffMessage(
    current,
    "staff-context-refresh-response",
    new Date().toISOString(),
    "Vou conferir quais campanhas não enviaram os e-mails.",
  );
  assert.deepEqual(
    current.database
      .prepare("SELECT state, error FROM triage_ai_jobs")
      .get(),
    {
      state: "failed",
      error: "Nova resposta da equipe recebida; contexto reagendado",
    },
  );

  assert.equal(scheduler(current), 1);
  const refreshed = current.store.claimNextAgentJob();
  assert.ok(refreshed?.kind === "triage");
  if (!refreshed || refreshed.kind !== "triage") {
    assert.fail("Job reagendado não encontrado");
  }
  const input = current.store.getTriageAiJobInput(refreshed.id);
  assert.deepEqual(input.candidateMessageIds, [candidate]);
  assert.equal(
    input.messages.find((message) => message.id === response)?.role,
    "self",
  );
});

test("IA pode aguardar contexto sem criar card nem repetir até haver novidade", () => {
  const current = fixture();
  const first = addMessage(
    current,
    "waiting-context-first",
    "2026-07-17T20:00:00.000Z",
    "Conseguem olhar isso?",
  );
  assert.equal(scheduler(current), 1);
  const claimed = current.store.claimNextAgentJob();
  assert.ok(claimed?.kind === "triage");
  if (!claimed || claimed.kind !== "triage") assert.fail("Job não encontrado");

  assert.equal(
    current.store.completeTriageAiJob(claimed.id, {
      groups: [{
        messageIds: [first],
        kind: "uncertain",
        suggestedAction: "wait",
        relatedTicketId: null,
        relatedSuggestionId: null,
        title: "Aguardando contexto",
        summary: "A mensagem ainda não descreve uma demanda identificável.",
        affectedEcommerce: null,
        categories: {
          contactReason: [],
          productArea: [],
          platform: [],
          symptom: [],
        },
        reason: "Falta o relato do problema ou da dúvida.",
        confidence: 0.97,
      }],
    }),
    0,
  );
  assert.equal(
    current.store.listConversationTriageBlocks(current.groupId).items.length,
    0,
  );
  assert.equal(current.store.listTriageCandidates().length, 0);
  assert.equal(scheduler(current), 0);
  assert.equal(
    current.store.getConversationSuggestionAnalysis(current.groupId).state,
    "waiting_for_context",
  );

  const forced = current.store.triggerConversationTriageAnalysis(current.groupId, {
    promptVersion: TRIAGE_PROMPT_VERSION,
  });
  assert.equal(forced.accepted, true);
  assert.ok(forced.jobId);
  const repeated = current.store.triggerConversationTriageAnalysis(current.groupId, {
    promptVersion: TRIAGE_PROMPT_VERSION,
  });
  assert.equal(repeated.jobId, forced.jobId);
  assert.equal(rowCount(current.database, "triage_ai_jobs"), 2);
});

test("nova mensagem externa libera uma espera por contexto e reinicia o silêncio", () => {
  const current = fixture();
  const first = addMessage(
    current,
    "waiting-context-reset-first",
    "2026-07-17T20:00:00.000Z",
    "Conseguem olhar isso?",
  );
  assert.equal(scheduler(current), 1);
  const claimed = current.store.claimNextAgentJob();
  assert.ok(claimed?.kind === "triage");
  if (!claimed || claimed.kind !== "triage") assert.fail("Job não encontrado");

  current.store.completeTriageAiJob(claimed.id, {
    groups: [{
      messageIds: [first],
      kind: "uncertain",
      suggestedAction: "wait",
      relatedTicketId: null,
      relatedSuggestionId: null,
      title: "Aguardando contexto",
      summary: "Ainda não existe uma demanda identificável.",
      affectedEcommerce: null,
      categories: {
        contactReason: [],
        productArea: [],
        platform: [],
        symptom: [],
      },
      reason: "Falta o relato do problema ou da dúvida.",
      confidence: 0.97,
    }],
  });
  assert.equal(
    current.store.getConversationSuggestionAnalysis(current.groupId).state,
    "waiting_for_context",
  );

  const second = current.store.upsertMessage({
    id: "waiting-context-reset-second",
    externalId: "wa-waiting-context-reset-second",
    groupId: current.groupId,
    senderId: current.customerId,
    occurredAt: new Date().toISOString(),
    text: "O dashboard não atualiza os pedidos desde ontem.",
    messageType: "conversation",
    triageKind: "unclassified",
    triageState: "unreviewed",
    ingestionSource: "realtime_append",
  }).id;

  assert.equal(
    current.store.getConversationSuggestionAnalysis(current.groupId).state,
    "waiting_for_silence",
  );
  assert.deepEqual(
    current.store.listTriageCandidates().map(({ id }) => id),
    [first, second],
  );
  assert.equal(new TriageAiScheduler(current.store).scheduleBatch(), 0);
  assert.equal(
    rowCount(current.database, "triage_context_waits"),
    0,
  );

  assert.equal(scheduler(current), 1);
  const retriedOldJob = current.store.claimNextAgentJob();
  assert.ok(retriedOldJob?.kind === "triage");
  if (!retriedOldJob || retriedOldJob.kind !== "triage") {
    assert.fail("Job antigo não encontrado");
  }
  current.store.completeTriageAiJob(retriedOldJob.id, {
    groups: [{
      messageIds: [first],
      kind: "uncertain",
      suggestedAction: "wait",
      relatedTicketId: null,
      relatedSuggestionId: null,
      title: "Aguardando contexto",
      summary: "A mensagem antiga ainda não descreve uma demanda.",
      affectedEcommerce: null,
      categories: {
        contactReason: [],
        productArea: [],
        platform: [],
        symptom: [],
      },
      reason: "O novo assunto está distante e não esclarece a mensagem antiga.",
      confidence: 0.96,
    }],
  });

  assert.equal(scheduler(current), 1);
  const newContextJob = current.store.claimNextAgentJob();
  assert.ok(newContextJob?.kind === "triage");
  if (!newContextJob || newContextJob.kind !== "triage") {
    assert.fail("Job do novo contexto não encontrado");
  }
  current.store.completeTriageAiJob(newContextJob.id, {
    groups: [{
      messageIds: [second],
      kind: "demand",
      suggestedAction: "create",
      relatedTicketId: null,
      relatedSuggestionId: null,
      title: "Dashboard sem pedidos",
      summary: "O cliente relata que o dashboard não atualiza os pedidos.",
      affectedEcommerce: null,
      categories: {
        contactReason: ["Problema"],
        productArea: ["Dashboard"],
        platform: [],
        symptom: ["Pedidos ausentes"],
      },
      reason: "Existe uma demanda identificável no novo contexto.",
      confidence: 0.94,
    }],
  });

  assert.deepEqual(
    JSON.parse(
      (
        current.database
          .prepare(
            "SELECT message_ids_json FROM triage_context_waits WHERE group_id = ?",
          )
          .get(current.groupId) as { message_ids_json: string }
      ).message_ids_json,
    ),
    [first],
  );
  assert.equal(
    current.store.getConversationSuggestionAnalysis(current.groupId).state,
    "waiting_for_context",
  );

  const third = addMessage(
    current,
    "waiting-context-reset-third",
    new Date(Date.now() + 1_000).toISOString(),
    "Sobre a primeira mensagem: o erro exibido é credencial inválida.",
  );
  assert.equal(rowCount(current.database, "triage_context_waits"), 0);
  assert.deepEqual(
    current.store.listTriageCandidates(500).map(({ id }) => id),
    [first, third],
  );
});

test("ações manuais removem somente as mensagens selecionadas da espera por contexto", () => {
  for (const action of ["create", "attach", "ignore", "context", "restore"] as const) {
    const current = fixture();
    let ticketId: string | null = null;
    if (action === "attach") {
      const seed = addMessage(
        current,
        "manual-wait-attach-seed",
        "2026-07-20T10:00:00.000Z",
        "Ticket já existente para receber contexto.",
      );
      ticketId = current.store.createTicketFromConversation(current.groupId, {
        messageIds: [seed],
        clientRequestId: "manual-wait-attach-ticket",
      }).ticket?.id ?? null;
      assert.ok(ticketId);
    }

    const selected = addMessage(
      current,
      `manual-wait-${action}-selected`,
      "2026-07-20T10:01:00.000Z",
      `Mensagem selecionada para ${action}.`,
    );
    const preserved = addMessage(
      current,
      `manual-wait-${action}-preserved`,
      "2026-07-20T10:02:00.000Z",
      "Esta mensagem deve continuar aguardando contexto.",
    );
    if (action === "restore") {
      current.store.markMessageTriage(selected, {
        kind: "context",
        state: "context",
      });
    }
    seedTriageContextWait(current, [selected, preserved]);

    if (action === "create") {
      current.store.createTicketFromConversation(current.groupId, {
        messageIds: [selected],
        clientRequestId: "manual-wait-create",
      });
    } else if (action === "attach") {
      current.store.attachConversationMessages(current.groupId, {
        messageIds: [selected],
        ticketId: ticketId!,
        clientRequestId: "manual-wait-attach",
      });
    } else if (action === "ignore") {
      current.store.ignoreConversationMessages(current.groupId, {
        messageIds: [selected],
        clientRequestId: "manual-wait-ignore",
      });
    } else if (action === "context") {
      current.store.contextualizeConversationMessages(current.groupId, {
        messageIds: [selected],
        clientRequestId: "manual-wait-context",
      });
    } else {
      current.store.restoreConversationMessages(current.groupId, {
        messageIds: [selected],
        clientRequestId: "manual-wait-restore",
      });
    }

    assert.deepEqual(waitingMessageIds(current), [preserved], action);
    current.store.contextualizeConversationMessages(current.groupId, {
      messageIds: [preserved],
      clientRequestId: `manual-wait-${action}-clear-last`,
    });
    assert.deepEqual(waitingMessageIds(current), [], `${action}: último id`);
  }
});

test("continuação semântica atualiza o mesmo card sugerido", () => {
  const current = fixture();
  const first = addMessage(
    current,
    "continuation-first",
    "2026-07-17T21:00:00.000Z",
    "Os pedidos não aparecem no dashboard.",
  );
  assert.equal(scheduler(current), 1);
  const firstJob = current.store.claimNextAgentJob();
  assert.ok(firstJob?.kind === "triage");
  if (!firstJob || firstJob.kind !== "triage") assert.fail("Job não encontrado");
  current.store.completeTriageAiJob(firstJob.id, {
    groups: [{
      messageIds: [first],
      kind: "demand",
      suggestedAction: "create",
      relatedTicketId: null,
      relatedSuggestionId: null,
      title: "Pedidos ausentes",
      summary: "O cliente relata pedidos ausentes no dashboard.",
      affectedEcommerce: null,
      categories: {
        contactReason: ["Problema"],
        productArea: ["Pedidos"],
        platform: [],
        symptom: ["Pedidos ausentes"],
      },
      reason: "Nova demanda de suporte.",
      confidence: 0.93,
    }],
  });
  const existing = current.store.listConversationTriageBlocks(current.groupId).items[0];
  assert.ok(existing);

  const second = addMessage(
    current,
    "continuation-second",
    "2026-07-17T21:04:00.000Z",
    "A loja afetada é a Loja Exemplo Ômega.",
  );
  assert.equal(scheduler(current), 1);
  const secondJob = current.store.claimNextAgentJob();
  assert.ok(secondJob?.kind === "triage");
  if (!secondJob || secondJob.kind !== "triage") assert.fail("Job não encontrado");
  const secondInput = current.store.getTriageAiJobInput(secondJob.id);
  assert.equal(secondInput.pendingSuggestions[0]?.id, existing.id);
  current.store.completeTriageAiJob(secondJob.id, {
    groups: [{
      messageIds: [second],
      kind: "continuation",
      suggestedAction: "create",
      relatedTicketId: null,
      relatedSuggestionId: existing.id,
      title: "Pedidos ausentes na Loja Exemplo Ômega",
      summary: "O problema de pedidos ausentes afeta a Loja Exemplo Ômega.",
      affectedEcommerce: "Loja Exemplo Ômega",
      categories: {
        contactReason: [],
        productArea: [],
        platform: [],
        symptom: [],
      },
      reason: "Complemento explícito do card pendente.",
      confidence: 0.98,
    }],
  });

  const blocks = current.store.listConversationTriageBlocks(current.groupId).items;
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.id, existing.id);
  assert.deepEqual(blocks[0]?.messageIds, [first, second]);
  assert.equal(blocks[0]?.title, "Pedidos ausentes na Loja Exemplo Ômega");
  assert.deepEqual(blocks[0]?.proposedCategories, {
    contactReason: ["Problema"],
    productArea: ["Pedidos"],
    platform: [],
    symptom: ["Pedidos ausentes"],
  });
  assert.equal(
    (
      current.database
        .prepare(
          `SELECT COUNT(*) AS count FROM triage_block_events
           WHERE block_id = ? AND event_type = 'suggestion_updated'`,
        )
        .get(existing.id) as { count: number }
    ).count,
    1,
  );
});

test("scheduler mantém somente um job ativo por conversa com backlog grande", () => {
  const current = fixture();
  for (let index = 0; index < 51; index += 1) {
    addMessage(
      current,
      `serialized-backlog-${index}`,
      new Date(Date.now() - 5 * 60_000 + index).toISOString(),
      `O dashboard continua sem mostrar os pedidos; detalhe ${index}.`,
    );
  }

  const aiScheduler = new TriageAiScheduler(current.store, {
    quietPeriodMs: 0,
    candidateLimit: 500,
  });
  assert.equal(aiScheduler.scheduleBatch("serialized-model"), 1);
  assert.equal(rowCount(current.database, "triage_ai_jobs"), 1);
  assert.equal(rowCount(current.database, "triage_ai_job_messages"), 50);
  assert.equal(current.store.listTriageCandidates(500).length, 1);
  assert.equal(aiScheduler.scheduleBatch("serialized-model"), 0);
  assert.equal(rowCount(current.database, "triage_ai_jobs"), 1);
});

test("job obsoleto não é reenfileirado quando chega novo contexto durante a IA", async () => {
  const current = fixture();
  addMessage(
    current,
    "stale-running-first",
    new Date(Date.now() - 5 * 60_000).toISOString(),
    "Os pedidos não aparecem no dashboard.",
  );
  assert.equal(scheduler(current, "stale-running-model"), 1);
  let attempts = 0;
  const events: string[] = [];
  const worker = new InvestigationWorker(
    current.store,
    {
      async analyse() {
        throw new Error("investigação de ticket não esperada");
      },
      async investigateThread() {
        throw new Error("turno profundo não esperado");
      },
      async triage() {
        attempts += 1;
        addMessage(
          current,
          "stale-running-second",
          new Date().toISOString(),
          "A loja afetada é a Loja Exemplo Ômega.",
        );
        throw new Error("execução antiga falhou depois da nova mensagem");
      },
    },
    {
      recoverOrphanedJobs: false,
      onEvent: (event) => {
        if (event.type !== "idle") events.push(`${event.type}:${event.jobKind}`);
      },
    },
  );

  assert.equal(await worker.runOne(), true);
  assert.equal(attempts, 1);
  assert.deepEqual(events, ["started:triage", "failed:triage"]);
  assert.deepEqual(
    current.database
      .prepare("SELECT state, attempt_count FROM triage_ai_jobs")
      .get(),
    { state: "failed", attempt_count: 1 },
  );
  assert.equal(
    (
      current.database
        .prepare(
          "SELECT COUNT(*) AS count FROM triage_ai_job_messages WHERE active = 1",
        )
        .get() as { count: number }
    ).count,
    0,
  );

  const forced = current.store.triggerConversationTriageAnalysis(
    current.groupId,
    { promptVersion: TRIAGE_PROMPT_VERSION },
  );
  assert.equal(forced.accepted, true);
  assert.ok(forced.jobId);
  assert.equal(rowCount(current.database, "triage_ai_jobs"), 2);
});
