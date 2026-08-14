import assert from "node:assert/strict";
import test from "node:test";

import type { TriageCandidate } from "../server/domain/index.js";
import { classifyTriageCandidate } from "../server/triage/classifier.js";

function candidate(
  text: string | null,
  overrides: Partial<TriageCandidate> = {},
): TriageCandidate {
  return {
    id: "message-1",
    externalId: "external-1",
    quotedExternalId: null,
    occurredAt: "2026-07-16T12:00:00.000Z",
    text,
    messageType: "conversation",
    triageKind: "unclassified",
    group: { id: "group-1", externalJid: "group@g.us", subject: "Cliente" },
    client: { id: "client-1", name: "Cliente", kind: "ecommerce" },
    sender: {
      id: "participant-1",
      displayName: "Pessoa Fictícia Teta",
      phoneE164: null,
      isStaff: false,
    },
    attachments: [],
    ...overrides,
  };
}

test("saudacao isolada nao abre ticket", () => {
  const result = classifyTriageCandidate(candidate("Bom dia!"));
  assert.equal(result.kind, "social");
  assert.equal(result.shouldOpenTicket, false);
});

test("saudacao acompanhada de problema abre ticket", () => {
  const result = classifyTriageCandidate(
    candidate("Bom dia! Os pedidos sumiram do dashboard, conseguem verificar?"),
  );
  assert.equal(result.kind, "demand");
  assert.equal(result.shouldOpenTicket, true);
  assert.match(result.title, /pedidos sumiram/i);
});

for (const text of [
  "Perfeito, obrigado",
  "Perfeito! Muito obrigado!",
  "Parabéns pelo trabalho 👏",
  "Excelente atendimento, valeu!",
  "Show, valeu!",
  "massa",
  "👏",
  "❤️🙏",
  "Perfeito, funcionou agora. Obrigada!",
  "Obrigado pela ajuda",
  "Bom dia, perfeito, obrigado",
  "Ahh legal Operador.",
  "Ok obrigada",
  "Opa, bom dia",
]) {
  test(`interacao social combinada nao abre ticket: ${text}`, () => {
    const result = classifyTriageCandidate(candidate(text));
    assert.equal(result.kind, "social");
    assert.equal(result.shouldOpenTicket, false);
  });
}

for (const text of [
  "Perfeito, mas os pedidos ainda não apareceram",
  "Obrigado, não funcionou",
  "Parabéns, mas preciso de ajuda com a integração",
  "👍 Os pedidos sumiram",
  "Tem uma situação aqui",
  "Tudo bem com o total de clientes?",
  "Ajuda",
  "Não consigo acessar",
  "?",
]) {
  test(`demanda ou ambiguidade continua em revisao: ${text}`, () => {
    const result = classifyTriageCandidate(candidate(text));
    assert.equal(result.shouldOpenTicket, true);
    assert.notEqual(result.kind, "social");
  });
}

test("agradecimento com anexo analisavel continua em revisao", () => {
  const result = classifyTriageCandidate(candidate("Obrigado", {
    attachments: [{
      id: "attachment-1",
      kind: "image",
      mimeType: "image/png",
      fileName: "evidencia.png",
      url: "/api/attachments/attachment-1",
      sizeBytes: 123,
      sha256: "sha",
      extractedText: null,
      available: true,
    }],
  }));
  assert.equal(result.kind, "demand");
  assert.equal(result.shouldOpenTicket, true);
});

test("mensagem ambigua entra em revisao para nao perder demanda", () => {
  const result = classifyTriageCandidate(candidate("Tem uma situação aqui"));
  assert.equal(result.kind, "uncertain");
  assert.equal(result.shouldOpenTicket, true);
});

test("audio sem texto cria revisao manual sem analisar conteudo", () => {
  const result = classifyTriageCandidate(
    candidate(null, { messageType: "audioMessage" }),
  );
  assert.equal(result.kind, "uncertain");
  assert.equal(result.shouldOpenTicket, true);
  assert.match(result.title, /Áudio recebido/);
});

for (const text of [
  "Outra coisa: os pedidos sumiram.",
  "Mudando de assunto, a receita está zerada.",
  "Aproveitando, tenho uma nova dúvida sobre clientes.",
]) {
  test(`marcador de novo assunto abre ticket separado: ${text}`, () => {
    const result = classifyTriageCandidate(candidate(text));

    assert.equal(result.shouldOpenTicket, true);
    assert.equal(result.explicitNewTopic, true);
  });
}
