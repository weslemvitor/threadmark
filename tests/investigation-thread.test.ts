import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { createDatabase, type SupportDatabase } from "../server/db/index.js";
import {
  ConflictError,
  SupportStore,
  ValidationError,
} from "../server/domain/index.js";
import type { InvestigationTurnResult } from "../server/agent/types.js";

const databases: SupportDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture() {
  const database = createDatabase(":memory:");
  databases.push(database);
  const store = new SupportStore(database);
  const account = store.upsertAccount({
    id: "account-thread",
    phoneNumber: "+5548999999000",
    displayName: "Comercial",
  });
  const client = store.upsertClient({
    id: "client-thread",
    name: "Cliente Sala",
    slug: "cliente-sala",
    kind: "ecommerce",
  });
  const group = store.upsertGroup({
    id: "group-thread",
    accountId: account.id,
    clientId: client.id,
    externalJid: "thread@g.us",
    subject: "Suporte Cliente Sala",
  });
  const participant = store.upsertParticipant({
    id: "participant-thread",
    externalJid: "thread@s.whatsapp.net",
    displayName: "Cliente",
  });
  store.addGroupParticipant(group.id, participant.id);
  const message = store.upsertMessage({
    id: "whatsapp-thread-message",
    externalId: "wa-thread-message",
    groupId: group.id,
    senderId: participant.id,
    occurredAt: "2026-07-16T15:00:00.000Z",
    text: "Os pedidos não aparecem desde ontem.",
    messageType: "text",
    triageKind: "demand",
  });
  const ticket = store.createTicket({
    id: "ticket-thread",
    groupId: group.id,
    sourceMessageId: message.id,
    title: "Pedidos ausentes",
    summary: "Cliente relata pedidos ausentes.",
  });
  return { database, store, ticketId: ticket.id };
}

function turnResult(
  overrides: Partial<InvestigationTurnResult> = {},
): InvestigationTurnResult {
  return {
    assistantMessage: "Investiguei o caso em modo somente leitura.",
    phase: "conclusion",
    threadSummary: "Pedidos ausentes; consulta readonly concluída.",
    findings: [{
      statement: "O cliente relatou pedidos ausentes.",
      kind: "fact",
      evidenceReferences: ["wa-thread-message"],
    }],
    evidence: [
      {
        source: "conversation",
        summary: "Cliente relatou pedidos ausentes.",
        reference: "wa-thread-message",
      },
    ],
    suggestedResponse: "Validamos os pedidos e identificamos a causa.",
    nextAction: "Revisar e copiar a resposta sugerida.",
    confidence: 0.94,
    toolRequests: [],
    ...overrides,
  };
}

test("sala e mensagens são idempotentes e permitem apenas um turno ativo", () => {
  const current = fixture();
  const first = current.store.getOrCreateInvestigationThread(current.ticketId);
  const duplicate = current.store.getOrCreateInvestigationThread(current.ticketId);
  assert.equal(duplicate.id, first.id);
  assert.equal(
    current.store.getTicketDetail(current.ticketId).investigationThread?.id,
    first.id,
  );

  const queued = current.store.addInvestigationThreadMessage(first.id, {
    body: "Investigue banco e logs.",
    clientMessageId: "browser-message-1",
  });
  assert.equal(queued.messages.length, 1);
  assert.equal(queued.activeTurnState, "queued");

  const idempotent = current.store.addInvestigationThreadMessage(first.id, {
    body: "Texto repetido que não deve ser persistido.",
    clientMessageId: "browser-message-1",
  });
  assert.equal(idempotent.messages.length, 1);
  assert.throws(
    () =>
      current.store.addInvestigationThreadMessage(first.id, {
        body: "Outra pergunta antes da resposta.",
      }),
    ConflictError,
  );
});

test("cancelamento é terminal, idempotente e libera a sala sem apagar auditoria", () => {
  const current = fixture();
  const thread = current.store.getOrCreateInvestigationThread(current.ticketId);
  current.store.addInvestigationThreadMessage(thread.id, {
    body: "Investigue até eu pedir para parar.",
  });
  const claimed = current.store.claimNextAgentJob();
  assert.equal(claimed?.kind, "thread_turn");
  if (!claimed || claimed.kind !== "thread_turn") assert.fail("turno não reivindicado");

  current.store.appendInvestigationThreadToolExecution(claimed.id, {
    requestId: "cancel-tool-1",
    toolId: "debugger",
    toolName: "Debugger",
    operation: "query_readonly",
    argumentsJson: '{"query":"SELECT 1"}',
    purpose: "Registrar evidência antes da interrupção.",
    status: "success",
    summary: "Consulta concluída.",
    content: "1",
    reference: "tool:debugger:query:cancel-1",
    executedAt: "2026-07-20T14:20:00.000Z",
  });

  const cancellation = current.store.cancelInvestigationThread(
    thread.id,
    "Operador de teste",
  );
  assert.equal(cancellation.newlyCancelled, true);
  assert.equal(cancellation.cancelledJobId, claimed.id);
  assert.equal(cancellation.thread.activeTurnState, null);
  assert.equal(cancellation.thread.turns[0]?.state, "cancelled");
  assert.equal(cancellation.thread.turns[0]?.cancelledBy, "Operador de teste");
  assert.ok(cancellation.thread.turns[0]?.cancelledAt);
  assert.equal(cancellation.thread.turns[0]?.error, null);
  assert.equal(cancellation.thread.turns[0]?.toolExecutions.length, 1);
  assert.equal(current.store.isInvestigationThreadJobCancelled(claimed.id), true);

  assert.throws(
    () => current.store.completeInvestigationThreadJob(claimed.id, turnResult()),
    /estado failed/,
    "uma conclusão tardia não pode sobrescrever o cancelamento",
  );
  const idempotent = current.store.cancelInvestigationThread(thread.id, "Operador de teste");
  assert.equal(idempotent.newlyCancelled, false);
  assert.equal(idempotent.cancelledJobId, claimed.id);
  assert.equal(idempotent.thread.turns[0]?.state, "cancelled");

  const cancellationEvents = current.database
    .prepare(
      `SELECT COUNT(*) AS count FROM ticket_events
       WHERE ticket_id = ? AND event_type = 'investigation_thread_turn_cancelled'`,
    )
    .get(current.ticketId) as { count: number };
  assert.equal(cancellationEvents.count, 1);
  const cancellationTimeline = current.store
    .getTicketDetail(current.ticketId)
    .timeline.find(
      (item) =>
        item.type === "event" &&
        item.eventType === "investigation_thread_turn_cancelled",
    );
  assert.equal(cancellationTimeline?.type, "event");
  if (cancellationTimeline?.type !== "event") {
    assert.fail("evento de cancelamento não encontrado na timeline");
  }
  assert.match(cancellationTimeline.description, /interrompida por Operador de teste/);

  const continued = current.store.addInvestigationThreadMessage(thread.id, {
    body: "Comece um novo caminho de investigação.",
  });
  assert.equal(continued.activeTurnState, "queued");
  assert.equal(continued.turns.at(-1)?.state, "queued");
});

test("cancelar turno ainda enfileirado impede sua execução", () => {
  const current = fixture();
  const thread = current.store.getOrCreateInvestigationThread(current.ticketId);
  current.store.addInvestigationThreadMessage(thread.id, {
    body: "Não execute esta investigação.",
  });

  const cancelled = current.store.cancelInvestigationThread(thread.id, "Operador");
  assert.equal(cancelled.thread.turns[0]?.state, "cancelled");
  assert.equal(cancelled.thread.turns[0]?.attemptCount, 0);
  assert.equal(current.store.claimNextAgentJob(), null);
});

test("mensagem longa demais é rejeitada em vez de ser truncada silenciosamente", () => {
  const current = fixture();
  const thread = current.store.getOrCreateInvestigationThread(current.ticketId);
  assert.throws(
    () =>
      current.store.addInvestigationThreadMessage(thread.id, {
        body: "x".repeat(24_001),
      }),
    ValidationError,
  );
  assert.equal(current.store.getInvestigationThread(thread.id).messages.length, 0);
});

test("texto grande de PDF permanece completo no SQLite e entra limitado no prompt", () => {
  const current = fixture();
  const extractedText = `INÍCIO-${"x".repeat(99_980)}-FIM`;
  current.store.upsertAttachment({
    id: "large-pdf",
    messageId: "whatsapp-thread-message",
    kind: "pdf",
    mimeType: "application/pdf",
    fileName: "relatorio.pdf",
    localPath: "/tmp/relatorio.pdf",
    sizeBytes: 120_000,
    sha256: "large-pdf-sha",
    extractedText,
    available: true,
  });

  const context = current.store.getInvestigationContext(current.ticketId);
  const promptText = context.messages[0]?.attachments[0]?.extractedText ?? "";
  assert.ok(promptText.length <= 8_000);
  assert.match(promptText, /^INÍCIO-/);
  assert.match(promptText, /-FIM$/);
  const persisted = current.database
    .prepare("SELECT extracted_text FROM attachments WHERE id = 'large-pdf'")
    .get() as { extracted_text: string };
  assert.equal(persisted.extracted_text, extractedText);
});

test("turno concluído persiste conversa, evidências, resumo e supersede sugestão anterior", () => {
  const current = fixture();
  current.store.addSuggestion({
    ticketId: current.ticketId,
    body: "Resposta antiga.",
    confidence: 0.4,
  });
  const thread = current.store.getOrCreateInvestigationThread(current.ticketId);
  current.store.addInvestigationThreadMessage(thread.id, {
    body: "Faça uma investigação completa.",
  });
  const claimed = current.store.claimNextAgentJob();
  assert.equal(claimed?.kind, "thread_turn");
  if (!claimed || claimed.kind !== "thread_turn") assert.fail("turno não reivindicado");

  const completed = current.store.completeInvestigationThreadJob(
    claimed.id,
    turnResult({
      toolExecutions: [{
        requestId: "read-metric",
        toolId: "codebase-product",
        toolName: "Código do produto",
        operation: "read_files",
        argumentsJson: '{"paths":["metrics.ts"]}',
        purpose: "Confirmar a fórmula no código.",
        status: "success",
        summary: "Arquivo lido.",
        content: "42: return recurring + newCustomers;",
        reference: "tool:codebase-product:read:metrics.ts",
        executedAt: "2026-07-18T20:00:00.000Z",
      }],
    }),
  );
  assert.equal(completed.status, "concluded");
  assert.equal(completed.activeTurnState, null);
  assert.equal(completed.messages.length, 2);
  assert.equal(completed.messages[1]?.role, "assistant");
  assert.equal(completed.messages[1]?.phase, "conclusion");
  assert.equal(completed.messages[1]?.evidence.length, 1);
  assert.equal(completed.messages[1]?.toolExecutions.length, 1);
  assert.equal(completed.messages[1]?.toolExecutions[0]?.operation, "read_files");
  assert.match(completed.messages[1]?.toolExecutions[0]?.content ?? "", /recurring/);
  assert.equal(completed.turns[0]?.state, "completed");
  assert.equal(completed.turns[0]?.result?.confidence, 0.94);
  assert.equal(completed.turns[0]?.result?.toolExecutions.length, 1);

  const repeatedCompletion = current.store.completeInvestigationThreadJob(
    claimed.id,
    turnResult(),
  );
  assert.equal(repeatedCompletion.messages.length, 2);

  const suggestions = current.store.getTicketDetail(current.ticketId).suggestions;
  assert.equal(suggestions.filter((item) => item.status === "candidate").length, 1);
  assert.equal(suggestions.find((item) => item.body === "Resposta antiga.")?.status, "superseded");
  const auditedEvidenceCount = current.database
    .prepare(
      "SELECT COUNT(*) AS count FROM evidence_queries WHERE operation = 'codex_conversational_investigation'",
    )
    .get() as { count: number };
  assert.equal(
    auditedEvidenceCount.count,
    0,
    "alegações do modelo ficam no resultado/mensagem, não como consulta auditada",
  );

  const continued = current.store.addInvestigationThreadMessage(thread.id, {
    body: "Agora compare com o período anterior.",
  });
  assert.equal(continued.status, "active");
  assert.equal(continued.activeTurnState, "queued");
});

test("conclusão profunda tardia em ticket resolvido não cria minuta que reaparece ao reabrir", () => {
  const current = fixture();
  const thread = current.store.getOrCreateInvestigationThread(current.ticketId);
  current.store.addInvestigationThreadMessage(thread.id, {
    body: "Investigue enquanto o atendimento ainda está aberto.",
  });
  const claimed = current.store.claimNextAgentJob();
  assert.equal(claimed?.kind, "thread_turn");
  if (!claimed || claimed.kind !== "thread_turn") assert.fail("turno não reivindicado");

  current.store.updateTicketStatus(current.ticketId, {
    status: "resolved",
    actor: "Operador",
    resolution: {
      summary: "Caso resolvido manualmente antes do fim da investigação.",
      outcome: "Orientação enviada pelo operador.",
      validatedBy: "Operador",
    },
  });
  current.store.completeInvestigationThreadJob(claimed.id, turnResult());

  let ticket = current.store.getTicketDetail(current.ticketId);
  assert.equal(ticket.status, "resolved");
  assert.equal(ticket.suggestions.some((item) => item.status === "candidate"), false);
  const assistant = current.store.getInvestigationThread(thread.id).messages.at(-1);
  assert.equal(assistant?.role, "assistant");
  assert.equal(assistant?.suggestedResponse, null);

  current.store.updateTicketStatus(current.ticketId, {
    status: "in_progress",
    actor: "Operador",
  });
  ticket = current.store.getTicketDetail(current.ticketId);
  assert.equal(ticket.suggestions.some((item) => item.status === "candidate"), false);
});

test("auditoria de ferramenta é imediata, append-only e sobrevive à falha do turno", () => {
  const current = fixture();
  const thread = current.store.getOrCreateInvestigationThread(current.ticketId);
  current.store.addInvestigationThreadMessage(thread.id, {
    body: "Consulte os logs antes de responder.",
  });
  const claimed = current.store.claimNextAgentJob();
  assert.equal(claimed?.kind, "thread_turn");
  if (!claimed || claimed.kind !== "thread_turn") assert.fail("turno não reivindicado");

  const firstWrite = current.store.appendInvestigationThreadToolExecution(
    claimed.id,
    {
      requestId: "logs-1",
      toolId: "cloudwatch-production",
      toolName: "CloudWatch de produção",
      operation: "query_logs",
      argumentsJson: '{"logGroup":"/app/api","minutes":30}',
      purpose: "Procurar a falha relatada pelo cliente.",
      status: "error",
      summary: "Consulta readonly indisponível.",
      content: "A credencial configurada não possui acesso ao grupo solicitado.",
      reference: null,
      executedAt: "2026-07-18T20:05:00.000Z",
    },
  );
  assert.equal(firstWrite.status, "error");

  const idempotent = current.store.appendInvestigationThreadToolExecution(
    claimed.id,
    {
      ...firstWrite,
      status: "success",
      summary: "Este retry não pode reescrever a auditoria original.",
      content: "resultado posterior",
      executedAt: "2026-07-18T20:06:00.000Z",
    },
  );
  assert.equal(idempotent.status, "error");
  assert.equal(idempotent.summary, "Consulta readonly indisponível.");

  const resumedContext = current.store.getInvestigationThreadContext(claimed.id);
  assert.equal(resumedContext.toolResults?.length, 1);
  assert.equal(resumedContext.toolResults?.[0]?.requestId, "logs-1");

  current.store.failInvestigationThreadJob(
    claimed.id,
    "O modelo falhou depois da operação readonly.",
  );
  const failed = current.store.getInvestigationThread(thread.id);
  assert.equal(failed.messages[0]?.role, "operator");
  assert.equal(failed.messages[0]?.toolExecutions.length, 1);
  assert.equal(failed.messages[0]?.toolExecutions[0]?.status, "error");
  assert.equal(failed.turns[0]?.state, "failed");
  assert.equal(failed.turns[0]?.result, null);
  assert.equal(failed.turns[0]?.toolExecutions.length, 1);

  const row = current.database
    .prepare(
      `SELECT COUNT(*) AS count, MIN(status) AS status
       FROM investigation_thread_tool_executions WHERE job_id = ?`,
    )
    .get(claimed.id) as { count: number; status: string };
  assert.deepEqual(row, { count: 1, status: "error" });
  assert.throws(() => {
    current.database
      .prepare(
        "UPDATE investigation_thread_tool_executions SET summary = 'alterado' WHERE job_id = ?",
      )
      .run(claimed.id);
  }, /append-only/);
});

test("conclusão sem próxima ação limpa a ação obsoleta do ticket", () => {
  const current = fixture();
  current.database
    .prepare("UPDATE tickets SET next_action = ? WHERE id = ?")
    .run("Consultar banco antigo.", current.ticketId);
  const thread = current.store.getOrCreateInvestigationThread(current.ticketId);
  current.store.addInvestigationThreadMessage(thread.id, {
    body: "Conclua com os dados atuais.",
  });
  const claimed = current.store.claimNextAgentJob();
  assert.equal(claimed?.kind, "thread_turn");
  if (!claimed || claimed.kind !== "thread_turn") assert.fail("turno não reivindicado");

  current.store.completeInvestigationThreadJob(
    claimed.id,
    turnResult({ nextAction: null }),
  );
  assert.equal(current.store.getTicketDetail(current.ticketId).nextAction, null);
});

test("contexto da sala inclui análise automática e limita somente a janela do prompt", () => {
  const current = fixture();
  const automatic = current.store.queueInvestigation(current.ticketId);
  current.store.completeInvestigationJob(automatic.jobId, {
    createTicket: true,
    outcome: "technical_investigation_required",
    relation: "new",
    relatedTicketId: null,
    title: "Pedidos ausentes",
    summary: "A análise automática não concluiu a causa.",
    affectedEcommerce: null,
    priority: "high",
    categories: {
      contactReason: ["Problema"],
      productArea: ["Pedidos"],
      platform: [],
      symptom: ["Pedidos ausentes"],
    },
    evidence: [],
    suggestedResponse: null,
    missingInformation: [],
    nextAction: "Escalar para investigação técnica.",
    confidence: 0.55,
  });

  const thread = current.store.getOrCreateInvestigationThread(current.ticketId);
  for (let index = 0; index < 20; index += 1) {
    current.store.addInvestigationThreadMessage(thread.id, {
      body: `Pergunta ${index}: ${"x".repeat(1_900)}`,
    });
    const claimed = current.store.claimNextAgentJob();
    assert.equal(claimed?.kind, "thread_turn");
    if (!claimed || claimed.kind !== "thread_turn") assert.fail("turno não reivindicado");
    current.store.completeInvestigationThreadJob(
      claimed.id,
      turnResult({
        assistantMessage: `Resposta ${index}: ${"y".repeat(1_900)}`,
        suggestedResponse: null,
        phase: "analysis",
        threadSummary: `Resumo durável do turno ${index}`,
      }),
    );
  }
  current.store.addInvestigationThreadMessage(thread.id, {
    body: `Pergunta final: ${"z".repeat(1_900)}`,
  });
  const claimed = current.store.claimNextAgentJob();
  assert.equal(claimed?.kind, "thread_turn");
  if (!claimed || claimed.kind !== "thread_turn") assert.fail("turno não reivindicado");

  const context = current.store.getInvestigationThreadContext(claimed.id);
  const persisted = current.store.getInvestigationThread(thread.id);
  assert.equal(persisted.messages.length, 41);
  assert.ok(context.recentMessages.length <= 16);
  assert.ok(
    context.recentMessages.reduce((total, message) => total + message.body.length, 0) <=
      24_000,
  );
  assert.match(context.recentMessages.at(-1)?.body ?? "", /Pergunta final/);
  assert.equal(context.durableSummary, "Resumo durável do turno 19");
  assert.equal(
    context.automaticInvestigation?.outcome,
    "technical_investigation_required",
  );
});

test("jobs conversacionais em execução são recuperados após reinício", () => {
  const current = fixture();
  const thread = current.store.getOrCreateInvestigationThread(current.ticketId);
  current.store.addInvestigationThreadMessage(thread.id, { body: "Investigue." });
  const claimed = current.store.claimNextAgentJob();
  assert.equal(claimed?.kind, "thread_turn");
  assert.equal(current.store.recoverRunningAgentJobs(), 1);
  const recovered = current.store.claimNextAgentJob();
  assert.equal(recovered?.id, claimed?.id);
});
