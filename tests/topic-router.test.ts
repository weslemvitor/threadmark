import assert from "node:assert/strict";
import test from "node:test";

import {
  routeTopic,
  topicSimilarity,
  type TopicRoutingInput,
  type TopicTicketCandidate,
} from "../server/triage/topic-router.js";

const occurredAt = "2026-07-17T12:00:00.000Z";

function candidate(
  id: string,
  overrides: Partial<TopicTicketCandidate> = {},
): TopicTicketCandidate {
  return {
    id,
    status: "in_progress",
    lastMessageAt: "2026-07-17T11:50:00.000Z",
    lastSenderId: "customer-a",
    affectedStoreId: "store-a",
    topicText: "total de clientes novos e recorrentes no dashboard",
    ...overrides,
  };
}

function input(overrides: Partial<TopicRoutingInput> = {}): TopicRoutingInput {
  return {
    occurredAt,
    text: "Por que o total de clientes não bate com clientes novos e recorrentes?",
    senderId: "customer-a",
    explicitNewTopic: false,
    affectedStoreId: "store-a",
    quotedTicket: null,
    candidates: [candidate("ticket-a")],
    ...overrides,
  };
}

test("novo assunto explícito sempre cria outro ticket, mesmo com quote", () => {
  const decision = routeTopic(
    input({
      explicitNewTopic: true,
      quotedTicket: { id: "ticket-citado", status: "in_progress" },
    }),
  );

  assert.deepEqual(decision, {
    action: "create",
    targetTicketId: null,
    relatedTicketId: null,
    needsReview: false,
    reason: "explicit_new_topic",
    scores: [],
  });
});

test("quote para ticket aberto tem prioridade sobre janela, loja e similaridade", () => {
  const decision = routeTopic(
    input({
      text: "Conseguiu verificar?",
      affectedStoreId: "store-b",
      quotedTicket: { id: "ticket-citado", status: "waiting_customer" },
      candidates: [],
    }),
  );

  assert.equal(decision.action, "attach");
  assert.equal(decision.targetTicketId, "ticket-citado");
  assert.equal(decision.reason, "quoted_open_ticket");
});

test("quote para ticket encerrado cria possível reabertura em revisão", () => {
  const decision = routeTopic(
    input({
      quotedTicket: { id: "ticket-resolvido", status: "resolved" },
    }),
  );

  assert.equal(decision.action, "create");
  assert.equal(decision.relatedTicketId, "ticket-resolvido");
  assert.equal(decision.needsReview, true);
  assert.equal(decision.reason, "quoted_closed_ticket");
});

test("candidato posterior à mensagem nunca recebe histórico antigo", () => {
  const decision = routeTopic(
    input({
      candidates: [
        candidate("ticket-do-futuro", {
          lastMessageAt: "2026-07-17T12:05:00.000Z",
        }),
      ],
    }),
  );

  assert.equal(decision.action, "create");
  assert.equal(decision.reason, "no_candidate");
});

test("loja conhecida diferente cria outro ticket", () => {
  const decision = routeTopic(
    input({
      affectedStoreId: "store-b",
      candidates: [candidate("ticket-store-a")],
    }),
  );

  assert.equal(decision.action, "create");
  assert.equal(decision.reason, "different_store");
  assert.equal(decision.needsReview, false);
});

test("marcador forte anexa ao único candidato compatível em até 30 minutos", () => {
  const decision = routeTopic(
    input({
      text: "Também continua acontecendo depois de atualizar.",
      candidates: [
        candidate("ticket-continuacao", {
          topicText: "pedidos ausentes no dashboard",
          lastMessageAt: "2026-07-17T11:31:00.000Z",
        }),
      ],
    }),
  );

  assert.equal(decision.action, "attach");
  assert.equal(decision.targetTicketId, "ticket-continuacao");
  assert.equal(decision.reason, "strong_continuation");
});

test("burst de mensagens do mesmo remetente e família permanece no ticket", () => {
  const decision = routeTopic(
    input({
      occurredAt: "2026-07-17T12:01:00.000Z",
      text: "Total 1248, Novos 730, Recorrentes 412",
      candidates: [
        candidate("ticket-metricas", {
          lastMessageAt: "2026-07-17T12:00:00.000Z",
          topicText: "Dúvida sobre métricas de clientes",
        }),
      ],
    }),
  );

  assert.equal(decision.action, "attach");
  assert.equal(decision.targetTicketId, "ticket-metricas");
  assert.equal(decision.reason, "message_burst");
});

test("burst do mesmo remetente não mistura famílias métricas e pedidos", () => {
  const decision = routeTopic(
    input({
      occurredAt: "2026-07-17T12:01:00.000Z",
      text: "Os pedidos sumiram da loja",
      candidates: [
        candidate("ticket-metricas", {
          lastMessageAt: "2026-07-17T12:00:00.000Z",
          topicText: "Dúvida sobre total de clientes novos e recorrentes",
        }),
      ],
    }),
  );

  assert.equal(decision.action, "create");
  assert.equal(decision.reason, "ambiguous");
  assert.equal(decision.needsReview, true);
});

test("marcador forte não escolhe silenciosamente entre dois candidatos", () => {
  const decision = routeTopic(
    input({
      text: "Ainda continua acontecendo.",
      candidates: [
        candidate("ticket-a", { topicText: "pedidos ausentes" }),
        candidate("ticket-b", { topicText: "receita zerada" }),
      ],
    }),
  );

  assert.equal(decision.action, "create");
  assert.equal(decision.reason, "ambiguous");
  assert.equal(decision.needsReview, true);
});

test("marcador forte não mistura famílias temáticas conflitantes", () => {
  const decision = routeTopic(
    input({
      text: "Também os pedidos sumiram da integração.",
      candidates: [
        candidate("ticket-metricas", {
          topicText: "Dúvida sobre total de clientes novos e recorrentes",
        }),
      ],
    }),
  );

  assert.equal(decision.action, "create");
  assert.equal(decision.reason, "ambiguous");
  assert.equal(decision.needsReview, true);
});

test("similaridade suficiente e margem de 0,15 anexam ao candidato único", () => {
  const decision = routeTopic(
    input({
      text: "clientes total novos recorrentes dashboard",
      candidates: [
        candidate("ticket-metrica", {
          topicText: "clientes total novos recorrentes dashboard",
        }),
        candidate("ticket-pedidos", {
          topicText: "pedidos ausentes integração ecommerce",
        }),
      ],
    }),
  );

  assert.equal(decision.action, "attach");
  assert.equal(decision.targetTicketId, "ticket-metrica");
  assert.equal(decision.reason, "topic_similarity");
  assert.equal(decision.scores[0]?.similarity, 1);
});

test("similaridade acima do limiar mas sem margem suficiente abre revisão", () => {
  const decision = routeTopic(
    input({
      text: "clientes novos recorrentes total",
      candidates: [
        candidate("ticket-a", {
          topicText: "clientes novos recorrentes total dashboard",
        }),
        candidate("ticket-b", {
          topicText: "clientes novos recorrentes total relatório",
        }),
      ],
    }),
  );

  assert.equal(decision.action, "create");
  assert.equal(decision.reason, "ambiguous");
  assert.equal(decision.needsReview, true);
});

test("similaridade lexical normaliza acentos e ignora palavras vazias", () => {
  assert.equal(
    topicSimilarity(
      "Por que a métrica de clientes recorrentes diverge?",
      "Metrica clientes recorrentes diverge",
    ),
    1,
  );
});
