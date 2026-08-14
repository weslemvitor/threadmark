import assert from "node:assert/strict";
import test from "node:test";

import {
  conversationDistanceFromBottom,
  isCurrentConversationRequest,
  isNearConversationBottom,
  scrollTopForPreservedAnchor,
} from "../app/lib/conversation-scroll.js";

test("mede a distância até o fim da conversa", () => {
  assert.equal(conversationDistanceFromBottom({
    scrollHeight: 1_000,
    clientHeight: 400,
    scrollTop: 475,
  }), 125);
  assert.equal(conversationDistanceFromBottom({
    scrollHeight: 1_000,
    clientHeight: 400,
    scrollTop: 650,
  }), 0);
});

test("acompanha mensagens novas somente quando o leitor está perto do fim", () => {
  assert.equal(isNearConversationBottom({
    scrollHeight: 1_000,
    clientHeight: 400,
    scrollTop: 480,
  }), true);
  assert.equal(isNearConversationBottom({
    scrollHeight: 1_000,
    clientHeight: 400,
    scrollTop: 479,
  }), false);
});

test("aceita um limite customizado sem permitir limite negativo", () => {
  const metrics = {
    scrollHeight: 800,
    clientHeight: 300,
    scrollTop: 450,
  };
  assert.equal(isNearConversationBottom(metrics, 50), true);
  assert.equal(isNearConversationBottom(metrics, 49), false);
  assert.equal(isNearConversationBottom(metrics, -1), false);
});

test("rejeita paginação antiga mesmo quando a conversa volta de A para B e A", () => {
  const staleRequest = { conversationId: "conversation-a", generation: 4 };
  assert.equal(isCurrentConversationRequest(staleRequest, {
    conversationId: "conversation-b",
    generation: 5,
  }), false);
  assert.equal(isCurrentConversationRequest(staleRequest, {
    conversationId: "conversation-a",
    generation: 6,
  }), false);
  assert.equal(isCurrentConversationRequest(staleRequest, {
    conversationId: "conversation-a",
    generation: 4,
  }), true);
});

test("preserva o offset da mensagem âncora após prepend e resize tardio", () => {
  assert.equal(scrollTopForPreservedAnchor({
    currentScrollTop: 240,
    currentViewportOffset: 310,
    preservedViewportOffset: 70,
  }), 480);
  assert.equal(scrollTopForPreservedAnchor({
    currentScrollTop: 20,
    currentViewportOffset: -40,
    preservedViewportOffset: 15,
  }), 0);
});
