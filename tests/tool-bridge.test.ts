import assert from "node:assert/strict";
import test from "node:test";

import {
  boundToolResultForModel,
  ThreadmarkToolBridge,
} from "../server/agent/tool-bridge.js";
import type {
  InvestigationToolDescriptor,
  InvestigationToolRequest,
  InvestigationToolResult,
} from "../server/agent/types.js";

const descriptors: InvestigationToolDescriptor[] = [{
  id: "code",
  name: "Código do produto",
  type: "codebase",
  description: "Regras de campanha",
  scope: "/produto",
  operations: [
    {
      name: "search_files",
      description: "Busca texto nos arquivos autorizados.",
      argumentsExample: '{"query":"campaign"}',
      effect: "read",
    },
    {
      name: "rewrite_file",
      description: "Altera um arquivo.",
      argumentsExample: "{}",
      effect: "write",
      authorization: "task",
    },
  ],
}];

function success(request: InvestigationToolRequest): InvestigationToolResult {
  return {
    ...request,
    toolName: "Código do produto",
    status: "success",
    summary: "Busca concluída.",
    content: "campaign-service.ts:10",
    reference: `tool:code:${request.requestId}`,
    executedAt: "2026-09-01T12:00:00.000Z",
  };
}

test("bridge exige descoberta antes de executar e nunca oferece escrita", async () => {
  const calls: InvestigationToolRequest[] = [];
  const audited: InvestigationToolResult[] = [];
  const bridge = new ThreadmarkToolBridge({
    executeMany: async (requests) => {
      calls.push(...requests);
      return requests.map(success);
    },
  }, descriptors, {
    onExecution: async (result) => {
      audited.push(result);
    },
  });

  const undiscovered = await bridge.execute({
    requestId: "read-before-search",
    toolId: "code",
    operation: "search_files",
    argumentsJson: '{"query":"campaign"}',
    purpose: "Tentar pular a descoberta.",
  });
  assert.equal(undiscovered.status, "error");
  assert.equal(calls.length, 0);

  const discovery = bridge.search({ query: "buscar regra de campanha no código" });
  assert.deepEqual(discovery.matches.map((match) => match.operation), ["search_files"]);
  assert.ok(discovery.descriptors.every((descriptor) =>
    descriptor.operations.every((operation) => operation.effect !== "write")
  ));

  const execution = await bridge.execute({
    requestId: "read-after-search",
    toolId: "code",
    operation: "search_files",
    argumentsJson: '{"query":"campaign"}',
    purpose: "Localizar a regra da campanha.",
  });
  assert.equal(execution.status, "success");
  assert.equal(calls.length, 1);
  assert.equal(audited.length, 2);
  assert.equal(audited[0]?.status, "error");
  assert.deepEqual(audited[1], execution);

  const write = await bridge.execute({
    requestId: "write-must-fail",
    toolId: "code",
    operation: "rewrite_file",
    argumentsJson: "{}",
    purpose: "Tentar escrita.",
  });
  assert.equal(write.status, "error");
  assert.equal(calls.length, 1);
  assert.equal(audited.length, 3);
});

test("bridge aplica orçamento dentro da mesma sessão MCP", async () => {
  let calls = 0;
  const bridge = new ThreadmarkToolBridge({
    executeMany: async (requests) => {
      calls += requests.length;
      return requests.map(success);
    },
  }, descriptors, { maxOperations: 1 });

  bridge.search({ query: "buscar no código" });
  const first = await bridge.execute({
    requestId: "budget-1",
    toolId: "code",
    operation: "search_files",
    argumentsJson: '{"query":"primeira"}',
    purpose: "Primeira leitura.",
  });
  const second = await bridge.execute({
    requestId: "budget-2",
    toolId: "code",
    operation: "search_files",
    argumentsJson: '{"query":"segunda"}',
    purpose: "Segunda leitura.",
  });

  assert.equal(first.status, "success");
  assert.equal(second.status, "error");
  assert.match(second.summary, /orçamento/i);
  assert.equal(calls, 1);
});

test("bridge bloqueia repetição semântica da mesma leitura", async () => {
  let calls = 0;
  const bridge = new ThreadmarkToolBridge({
    executeMany: async (requests) => {
      calls += requests.length;
      return requests.map(success);
    },
  }, descriptors);

  bridge.search({ query: "buscar regra no código" });
  const first = await bridge.execute({
    requestId: "semantic-1",
    toolId: "code",
    operation: "search_files",
    argumentsJson: '{"query":"Campaign Service","maxResults":20}',
    purpose: "Localizar a regra.",
  });
  const repeated = await bridge.execute({
    requestId: "semantic-2",
    toolId: "code",
    operation: "search_files",
    argumentsJson: '{"maxResults":50,"query":" campaign   service "}',
    purpose: "Repetir a mesma busca com limite maior.",
  });

  assert.equal(first.status, "success");
  assert.equal(repeated.status, "error");
  assert.equal(repeated.error?.code, "duplicate_semantic_request");
  assert.match(repeated.summary, /já foi executada/i);
  assert.equal(calls, 1);
});

test("bridge limita payload grande para o modelo sem perder começo e fim", () => {
  const result = success({
    requestId: "large-result",
    toolId: "code",
    operation: "search_files",
    argumentsJson: '{"query":"campaign"}',
    purpose: "Ler resultado extenso.",
  });
  result.content = `INICIO-${"a".repeat(10_000)}-FINAL`;

  const bounded = boundToolResultForModel(result);

  assert.ok(bounded.content.length < result.content.length);
  assert.match(bounded.content, /^INICIO-/);
  assert.match(bounded.content, /-FINAL$/);
  assert.match(bounded.content, /caracteres omitidos/);
});
