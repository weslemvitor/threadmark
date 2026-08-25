import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { InvestigationWorker } from "../server/agent/investigation-worker.js";
import { InvestigationExecutionRegistry } from "../server/agent/investigation-execution-registry.js";
import type {
  InvestigationThreadInput,
  InvestigationTurnResult,
  SupportAnalysis,
  SupportAnalysisInput,
} from "../server/agent/types.js";
import { createDatabase, type SupportDatabase } from "../server/db/index.js";
import { SupportStore } from "../server/domain/index.js";

const databases: SupportDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function workerFixture() {
  const database = createDatabase(":memory:");
  databases.push(database);
  const store = new SupportStore(database);
  const account = store.upsertAccount({ phoneNumber: "+5548000000111", displayName: "Comercial" });
  const client = store.upsertClient({ name: "Cliente Worker", slug: "cliente-worker", kind: "ecommerce" });
  const group = store.upsertGroup({
    accountId: account.id,
    clientId: client.id,
    externalJid: "worker@g.us",
    subject: "Cliente Worker",
  });
  const participant = store.upsertParticipant({
    externalJid: "worker@s.whatsapp.net",
    displayName: "Cliente",
  });
  store.addGroupParticipant(group.id, participant.id);
  const message = store.upsertMessage({
    externalId: "worker-message",
    groupId: group.id,
    senderId: participant.id,
    occurredAt: "2026-07-16T16:00:00.000Z",
    text: "Preciso de ajuda.",
    messageType: "text",
  });
  const ticket = store.createTicket({
    groupId: group.id,
    sourceMessageId: message.id,
    title: "Ajuda",
    summary: "Cliente precisa de ajuda.",
  });
  return {
    database,
    store,
    ticketId: ticket.id,
    groupId: group.id,
    participantId: participant.id,
  };
}

const automaticResult: SupportAnalysis = {
  createTicket: true,
  outcome: "technical_investigation_required",
  relation: "new",
  relatedTicketId: null,
  title: "Ajuda",
  summary: "Investigação automática concluída.",
  affectedEcommerce: null,
  priority: "normal",
  categories: { contactReason: [], productArea: [], platform: [], symptom: [] },
  evidence: [],
  suggestedResponse: null,
  missingInformation: [],
  nextAction: "Escalar.",
  confidence: 0.5,
};

const threadResult: InvestigationTurnResult = {
  assistantMessage: "Analisei o caso completo.",
  phase: "conclusion",
  threadSummary: "Caso analisado e concluído.",
  findings: [],
  evidence: [],
  suggestedResponse: "Esta é a resposta segura.",
  nextAction: "Revisar a resposta.",
  confidence: 0.9,
  toolRequests: [],
};

test("worker ignora a fila automática legada e processa somente a sala manual", async () => {
  const current = workerFixture();
  const calls: string[] = [];
  const agent = {
    async analyse() {
      calls.push("automatic");
      return automaticResult;
    },
    async investigateThread() {
      calls.push("thread_turn");
      return threadResult;
    },
  };
  const worker = new InvestigationWorker(current.store, agent, {
    recoverOrphanedJobs: false,
  });

  current.store.queueInvestigation(current.ticketId);
  assert.equal(await worker.runOne(), false);
  const thread = current.store.getOrCreateInvestigationThread(current.ticketId);
  current.store.addInvestigationThreadMessage(thread.id, { body: "Aprofunde a análise." });
  assert.equal(await worker.runOne(), true);
  assert.deepEqual(calls, ["thread_turn"]);
  assert.equal(current.store.getInvestigationThread(thread.id).status, "concluded");
  assert.equal(await worker.runOne(), false);
});

test("falha do Codex tenta novamente antes de bloquear sem perder mensagem ou auditoria", async () => {
  const current = workerFixture();
  const agent = {
    async analyse() {
      return automaticResult;
    },
    async investigateThread(input: InvestigationThreadInput) {
      await input.onToolExecution?.({
        requestId: "worker-tool-1",
        toolId: "readonly-code",
        toolName: "Código readonly",
        operation: "search_files",
        argumentsJson: '{"query":"customer_total"}',
        purpose: "Confirmar a regra de negócio.",
        status: "success",
        summary: "Regra localizada.",
        content: "customer_total não é a soma das coortes.",
        reference: "tool:readonly-code:search:customer_total",
        executedAt: "2026-07-18T20:10:00.000Z",
      });
      throw new Error("fonte readonly indisponível");
    },
  };
  const worker = new InvestigationWorker(current.store, agent, {
    recoverOrphanedJobs: false,
  });
  const thread = current.store.getOrCreateInvestigationThread(current.ticketId);
  current.store.addInvestigationThreadMessage(thread.id, { body: "Investigue os logs." });

  assert.equal(await worker.runOne(), true);
  assert.equal(current.store.getInvestigationThread(thread.id).activeTurnState, "queued");
  assert.equal(await worker.runOne(), true);
  assert.equal(current.store.getInvestigationThread(thread.id).activeTurnState, "queued");
  assert.equal(await worker.runOne(), true);
  const failed = current.store.getInvestigationThread(thread.id);
  assert.equal(failed.messages.length, 1);
  assert.equal(failed.messages[0]?.toolExecutions.length, 1);
  assert.equal(failed.messages[0]?.toolExecutions[0]?.operation, "search_files");
  assert.equal(failed.turns[0]?.state, "failed");
  assert.equal(failed.turns[0]?.attemptCount, 3);
  assert.equal(failed.turns[0]?.toolExecutions.length, 1);
  assert.match(failed.turns[0]?.error ?? "", /readonly indisponível/);
});

test("cancelamento do operador aborta a execução running sem reenfileirar", async () => {
  const current = workerFixture();
  const registry = new InvestigationExecutionRegistry();
  const events: string[] = [];
  const agent = {
    async analyse() {
      return automaticResult;
    },
    async investigateThread(
      input: InvestigationThreadInput,
      signal?: AbortSignal,
    ): Promise<InvestigationTurnResult> {
      await input.onToolExecution?.({
        requestId: "cancelled-worker-tool",
        toolId: "debugger",
        toolName: "Debugger",
        operation: "query_readonly",
        argumentsJson: '{"query":"SELECT 1"}',
        purpose: "Persistir uma evidência antes de aguardar.",
        status: "success",
        summary: "Consulta concluída.",
        content: "1",
        reference: "tool:debugger:query:worker-cancel",
        executedAt: "2026-07-20T14:25:00.000Z",
      });
      return await new Promise<InvestigationTurnResult>((_resolve, reject) => {
        const onAbort = () => reject(signal?.reason ?? new Error("cancelada"));
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    },
  };
  const worker = new InvestigationWorker(current.store, agent, {
    recoverOrphanedJobs: false,
    executionRegistry: registry,
    onEvent: (event) => events.push(event.type),
  });
  const thread = current.store.getOrCreateInvestigationThread(current.ticketId);
  current.store.addInvestigationThreadMessage(thread.id, {
    body: "Continue até eu interromper.",
  });

  const running = worker.runOne();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const job = current.database
    .prepare(
      `SELECT id FROM investigation_thread_jobs
       WHERE thread_id = ? AND state = 'running'`,
    )
    .get(thread.id) as { id: string };
  assert.equal(registry.isRunning(job.id), true);

  const cancellation = current.store.cancelInvestigationThread(
    thread.id,
    "Operador",
  );
  assert.equal(cancellation.cancelledJobId, job.id);
  assert.equal(registry.cancel(job.id), true);
  assert.equal(await running, true);

  const persisted = current.store.getInvestigationThread(thread.id);
  assert.equal(persisted.turns[0]?.state, "cancelled");
  assert.equal(persisted.turns[0]?.toolExecutions.length, 1);
  assert.equal(registry.isRunning(job.id), false);
  assert.deepEqual(events, ["started", "cancelled"]);
  assert.equal(await worker.runOne(), false);
});

test("mensagem anexada não reativa a fila automática legada", async () => {
  const current = workerFixture();
  let automaticCalls = 0;
  const agent = {
    async analyse() {
      automaticCalls += 1;
      return automaticResult;
    },
    async investigateThread() {
      return threadResult;
    },
  };
  const worker = new InvestigationWorker(current.store, agent, {
    recoverOrphanedJobs: false,
  });

  current.store.queueInvestigation(current.ticketId);
  const followUp = current.store.upsertMessage({
    id: "worker-follow-up",
    externalId: "worker-follow-up",
    groupId: current.groupId,
    senderId: current.participantId,
    occurredAt: "2026-07-16T16:05:00.000Z",
    text: "Também começou a falhar no relatório.",
    messageType: "text",
  });
  current.store.attachMessageToTicket(current.ticketId, followUp.id, "triage");
  assert.equal(await worker.runOne(), false);
  assert.equal(automaticCalls, 0);
});

test("excluir ticket com job automático legado pendente não derruba o worker", async () => {
  const current = workerFixture();
  const events: string[] = [];
  const agent = {
    async analyse() {
      return automaticResult;
    },
    async investigateThread() {
      return threadResult;
    },
  };
  const worker = new InvestigationWorker(current.store, agent, {
    recoverOrphanedJobs: false,
    onEvent: (event) => events.push(event.type),
  });
  current.store.queueInvestigation(current.ticketId);
  assert.equal(await worker.runOne(), false);
  current.store.deleteTicket(current.ticketId, {
    actor: "Operador",
    reason: "Falso positivo identificado durante a investigação",
  });
  assert.deepEqual(events, []);
  assert.equal(await worker.runOne(), false);
});

test("worker nunca entrega contexto à investigação automática legada", async () => {
  const current = workerFixture();
  for (let index = 0; index < 3; index += 1) {
    const message = current.store.upsertMessage({
      externalId: `worker-window-${index}`,
      groupId: current.groupId,
      senderId: current.participantId,
      occurredAt: `2026-07-16T17:0${index}:00.000Z`,
      text: `Mensagem adicional ${index}`,
      messageType: "text",
    });
    current.store.attachMessageToTicket(current.ticketId, message.id);
  }
  let received: SupportAnalysisInput | null = null;
  const agent = {
    async analyse(input: SupportAnalysisInput) {
      received = input;
      return automaticResult;
    },
    async investigateThread() {
      return threadResult;
    },
  };
  const worker = new InvestigationWorker(current.store, agent, {
    recoverOrphanedJobs: false,
    automaticMessageLimit: 2,
  });
  current.store.queueInvestigation(current.ticketId);

  assert.equal(await worker.runOne(), false);
  assert.equal(received, null);
});

test("shutdown não tenta executar investigação automática legada", async () => {
  const current = workerFixture();
  const controller = new AbortController();
  const events: string[] = [];
  const agent = {
    async analyse() {
      controller.abort();
      throw new Error("processo interrompido");
    },
    async investigateThread() {
      return threadResult;
    },
  };
  const worker = new InvestigationWorker(current.store, agent, {
    recoverOrphanedJobs: false,
    onEvent: (event) => events.push(event.type),
  });
  current.store.queueInvestigation(current.ticketId);

  assert.equal(await worker.runOne(controller.signal), false);
  assert.equal(
    current.store.listInvestigationJobs().items[0]?.state,
    "queued",
  );
  assert.deepEqual(events, []);
});

test("shutdown reenfileira turno da sala e preserva a mensagem", async () => {
  const current = workerFixture();
  const controller = new AbortController();
  const agent = {
    async analyse() {
      return automaticResult;
    },
    async investigateThread() {
      controller.abort();
      throw new Error("processo interrompido");
    },
  };
  const worker = new InvestigationWorker(current.store, agent, {
    recoverOrphanedJobs: false,
  });
  const thread = current.store.getOrCreateInvestigationThread(current.ticketId);
  current.store.addInvestigationThreadMessage(thread.id, {
    body: "Continue depois do reinício.",
  });

  assert.equal(await worker.runOne(controller.signal), true);
  const recovered = current.store.getInvestigationThread(thread.id);
  assert.equal(recovered.messages.length, 1);
  assert.equal(recovered.turns[0]?.state, "queued");
  assert.equal(recovered.turns[0]?.error, "Recuperado após reinício do worker");
});
