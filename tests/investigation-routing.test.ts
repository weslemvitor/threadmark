import assert from "node:assert/strict";
import test from "node:test";

import { investigationExecutionPolicy } from "../server/agent/investigation-routing.js";

function input(body: string) {
  return {
    currentOperatorMessageId: "operator-current",
    recentMessages: [{
      id: "operator-current",
      role: "operator" as const,
      body,
      phase: null,
      createdAt: "2026-08-27T12:00:00.000Z",
    }],
    images: [],
    imageAnalysisApproved: false,
  };
}

for (const body of [
  "Pode criar o ticket.",
  "Qual a diferença entre faturamento e aprovado?",
  "Atualize o título do ticket #240.",
]) {
  test(`conversa objetiva usa rota rápida: ${body}`, () => {
    const policy = investigationExecutionPolicy(input(body));
    assert.equal(policy.workload, "quick");
    assert.equal(policy.maxToolRounds, 3);
    assert.equal(policy.maxToolOperations, 8);
    assert.equal(policy.maxCodeSearchOperations, 1);
  });
}

for (const body of [
  "Investigue a causa raiz do ticket #240.",
  "Analise profundamente os logs do CloudWatch e o banco de dados.",
  "Diagnostique esse incidente em produção.",
]) {
  test(`investigação explícita preserva rota profunda: ${body}`, () => {
    const policy = investigationExecutionPolicy(input(body));
    assert.equal(policy.workload, "deep");
    assert.equal(policy.maxToolRounds, 8);
    assert.equal(policy.maxToolOperations, 24);
  });
}

test("análise visual autorizada preserva rota profunda", () => {
  const policy = investigationExecutionPolicy({
    ...input("O que aparece nessa imagem?"),
    images: [{
      id: "image-1",
      messageId: "operator-current",
      fileName: "captura.png",
      mimeType: "image/png" as const,
      sizeBytes: 100,
      localPath: "/tmp/captura.png",
    }],
    imageAnalysisApproved: true,
  });
  assert.equal(policy.workload, "deep");
});
