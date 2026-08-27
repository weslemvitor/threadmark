import assert from "node:assert/strict";
import test from "node:test";

import {
  highestTicketPriority,
  inferTicketPriority,
} from "../server/triage/ticket-priority.js";

for (const text of [
  "A plataforma está fora do ar para todo mundo.",
  "O sistema caiu e ninguém consegue carregar a plataforma.",
  "Estamos com instabilidade geral na aplicação.",
]) {
  test(`impacto geral sugere urgente: ${text}`, () => {
    assert.equal(inferTicketPriority(text), "urgent");
  });
}

for (const text of [
  "O dashboard está sem dados desde ontem.",
  "Os valores de faturamento estão incorretos.",
  "Não consigo acessar minha conta.",
]) {
  test(`dados ou acesso sugerem alta: ${text}`, () => {
    assert.equal(inferTicketPriority(text), "high");
  });
}

for (const text of [
  "Tenho uma dúvida sobre a métrica de faturamento.",
  "Como funciona essa ferramenta?",
  "Isso é urgente para mim, pode explicar a métrica?",
  "O sistema caiu ontem, mas já voltou e está normal.",
]) {
  test(`duvida ou impacto encerrado permanece normal: ${text}`, () => {
    assert.equal(inferTicketPriority(text), "normal");
  });
}

test("uma continuação não rebaixa a prioridade já identificada", () => {
  assert.equal(highestTicketPriority("urgent", "normal"), "urgent");
  assert.equal(highestTicketPriority("normal", "high"), "high");
});
