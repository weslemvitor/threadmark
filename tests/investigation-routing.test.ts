import assert from "node:assert/strict";
import test from "node:test";

import { investigationExecutionPolicy } from "../server/agent/investigation-routing.js";

function input(body: string) {
  return {
    currentOperatorMessageId: "operator-current",
    durableSummary: "",
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
  test(`tarefa não trivial usa o agente adaptativo: ${body}`, () => {
    const policy = investigationExecutionPolicy(input(body));
    assert.equal(policy.workload, "deep");
    assert.equal(policy.promptMode, "deep");
    assert.equal(policy.maxToolRounds, 8);
    assert.equal(policy.maxToolOperations, 16);
    assert.equal(policy.maxCodeSearchOperations, 4);
  });
}

for (const body of [
  "Qual é o meu nome?",
  "Quem é você?",
  "O que você consegue fazer?",
  "Valeu!",
]) {
  test(`conversa simples não recebe ferramentas: ${body}`, () => {
    const policy = investigationExecutionPolicy(input(body));
    assert.equal(policy.workload, "quick");
    assert.equal(policy.promptMode, "conversation");
    assert.equal(policy.maxToolRounds, 0);
    assert.equal(policy.maxToolOperations, 0);
  });
}

test("criação de ticket que exige descobrir conversa usa rota profunda", () => {
  const policy = investigationExecutionPolicy(input(
    "Preciso criar um ticket do Renato; existe um contexto de conversa no Intercom.",
  ));
  assert.equal(policy.workload, "deep");
  assert.equal(policy.promptMode, "deep");
  assert.equal(policy.maxToolRounds, 8);
  assert.equal(policy.maxToolOperations, 16);
});

test("continuação curta herda a rota profunda do ticket pendente", () => {
  const policy = investigationExecutionPolicy({
    ...input("Tenta novamente"),
    durableSummary:
      "Objetivo pendente: criar ticket usando o contexto da conversa do Intercom e anexar as mensagens.",
  });
  assert.equal(policy.workload, "deep");
  assert.equal(policy.maxToolRounds, 8);
  assert.equal(policy.maxToolOperations, 16);
});

test("edição de automações usa orçamento profundo inclusive após confirmação curta", () => {
  const policy = investigationExecutionPolicy({
    ...input("Pode aplicar as mudanças"),
    durableSummary:
      "Objetivo pendente: melhorar e editar as quatro automações ativas.",
    activeTask: {
      rootOperatorMessageId: "operator-root",
      objective: "Melhorar as automações existentes.",
      operatorDirectives: [{
        id: "operator-root",
        body: "Melhore as automações existentes e aplique os ajustes.",
        createdAt: "2026-08-29T04:00:00.000Z",
      }],
      continuation: true,
    },
  });

  assert.equal(policy.workload, "deep");
  assert.equal(policy.promptMode, "deep");
  assert.equal(policy.maxToolRounds, 8);
  assert.equal(policy.maxToolOperations, 16);
  assert.equal(policy.maxSameOperation, 6);
});

test("confirmação natural herda a análise de automações e mantém orçamento profundo", () => {
  const policy = investigationExecutionPolicy({
    ...input("Pode seguir com os ajustes"),
    durableSummary:
      "Foram sugeridas melhorias nas automações atuais e a aplicação está pendente.",
    activeTask: {
      rootOperatorMessageId: "operator-root",
      objective: "Analisar as automações atuais e sugerir melhorias.",
      operatorDirectives: [{
        id: "operator-root",
        body: "Consegues dar uma olhada nas automações atual e sugerir melhorias?",
        createdAt: "2026-08-29T17:44:00.000Z",
      }, {
        id: "operator-current",
        body: "Pode seguir com os ajustes",
        createdAt: "2026-08-29T17:46:00.000Z",
      }],
      continuation: true,
    },
  });

  assert.equal(policy.workload, "deep");
  assert.equal(policy.promptMode, "deep");
  assert.equal(policy.maxToolOperations, 16);
});

test("revisão rápida comporta a leitura de mais de três automações", () => {
  const policy = investigationExecutionPolicy(input(
    "Revise as automações existentes e me apresente sugestões.",
  ));

  assert.equal(policy.workload, "deep");
  assert.equal(policy.maxSameOperation, 6);
});

for (const body of [
  "Investigue a causa raiz do ticket #240.",
  "Referente ao ticket #305, qual foi a causa de tão poucos envios?",
  "Analise profundamente os logs do CloudWatch e o banco de dados.",
  "Diagnostique esse incidente em produção.",
]) {
  test(`investigação explícita preserva rota profunda: ${body}`, () => {
    const policy = investigationExecutionPolicy(input(body));
    assert.equal(policy.workload, "deep");
    assert.equal(policy.maxToolRounds, 8);
    assert.equal(policy.maxToolOperations, 16);
  });
}

test("pedido de solução para problema de cliente entra no ciclo profundo sem verbo investigar", () => {
  const policy = investigationExecutionPolicy(input(
    "A Maloa está com problema de bloqueio de rede, como podemos ajudar ela a resolver? Ela diz que não tem, mas ficou claro que tem.",
  ));

  assert.equal(policy.workload, "deep");
  assert.equal(policy.promptMode, "deep");
  assert.equal(policy.maxToolRounds, 8);
  assert.equal(policy.maxToolOperations, 16);
});

test("pedido para validar dado externo usa o mesmo agente sem depender de palavras-chave", () => {
  const policy = investigationExecutionPolicy(input(
    "Veja a situação dos pedidos da loja IAP considerando o hostname e me diga se o comportamento está correto.",
  ));

  assert.equal(policy.workload, "deep");
  assert.equal(policy.promptMode, "deep");
});

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
