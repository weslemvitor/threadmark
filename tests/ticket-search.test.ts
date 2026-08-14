import assert from "node:assert/strict";
import test from "node:test";

import { matchesTicketSearch } from "../app/lib/ticket-search.js";
import type { TicketSummary } from "../app/lib/types.js";

const ticket = {
  number: 42,
  title: "Pedidos não sincronizados",
  summary: "A loja não recebeu os pedidos de hoje.",
  client: { name: "Agência São José" },
  group: { subject: "Atendimento principal" },
  requester: { displayName: "Maria", phoneE164: "+5547999999999" },
  affectedStore: { name: "Loja Aurora" },
  productForwarding: null,
  categories: [{ label: "Sincronização" }],
} as TicketSummary;

test("pesquisa tickets pelo título e pelo cliente ignorando acentos e caixa", () => {
  assert.equal(matchesTicketSearch(ticket, "PEDIDOS NÃO"), true);
  assert.equal(matchesTicketSearch(ticket, "agencia sao jose"), true);
});

test("pesquisa mantém campos auxiliares e rejeita termos ausentes", () => {
  assert.equal(matchesTicketSearch(ticket, "Loja Aurora"), true);
  assert.equal(matchesTicketSearch(ticket, "#42"), true);
  assert.equal(matchesTicketSearch(ticket, "financeiro"), false);
});

test("pesquisa vazia preserva todos os tickets", () => {
  assert.equal(matchesTicketSearch(ticket, "   "), true);
});
