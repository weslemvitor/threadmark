import assert from "node:assert/strict";
import test from "node:test";
import {
  getInvestigationPresentation,
  isInvestigationActive,
  type InvestigationSnapshot,
} from "../app/lib/investigation.js";
import {
  getInvestigationThreadPresentation,
  getInvestigationTurnLabel,
  isInvestigationTurnActive,
} from "../app/lib/investigation-thread.js";

function investigation(
  state: InvestigationSnapshot["state"],
  outcome: InvestigationSnapshot["outcome"] = null,
): InvestigationSnapshot {
  return {
    id: "investigation-1",
    state,
    instructions: null,
    requestedAt: "2026-07-17T01:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    error: null,
    outcome,
    confidence: null,
    evidence: [],
    missingInformation: [],
    nextAction: null,
    suggestedResponse: null,
  };
}

test("apresenta todos os estados operacionais da investigação em português", () => {
  assert.equal(getInvestigationPresentation(investigation("queued"))?.label, "Na fila");
  assert.equal(getInvestigationPresentation(investigation("running"))?.label, "Investigando");
  assert.equal(getInvestigationPresentation(investigation("failed"))?.label, "Falhou");
  assert.equal(
    getInvestigationPresentation(investigation("completed", "reply_ready"))?.label,
    "Resposta pronta",
  );
  assert.equal(
    getInvestigationPresentation(investigation("completed", "reply_ready"), {
      replyAvailable: false,
    })?.label,
    "Análise superada",
  );
  assert.deepEqual(
    getInvestigationPresentation(investigation("completed", "reply_ready"), {
      snapshotSuperseded: true,
    }),
    {
      label: "Análise superada",
      description: "O atendimento mudou após esta análise. A minuta anterior não está mais disponível.",
      tone: "neutral",
    },
  );
  assert.equal(
    getInvestigationPresentation(investigation("completed", "already_answered"), {
      replyAvailable: true,
    })?.label,
    "Resposta pronta",
  );
  assert.deepEqual(
    getInvestigationPresentation(investigation("completed", "already_answered")),
    {
      label: "Já respondido",
      description: "A equipe já respondeu a esta solicitação. Nenhuma nova resposta é necessária.",
      tone: "success",
    },
  );
  assert.equal(
    getInvestigationPresentation(investigation("completed", "needs_information"))?.label,
    "Aguardando informações",
  );
  assert.equal(
    getInvestigationPresentation(
      investigation("completed", "technical_investigation_required"),
    )?.label,
    "Requer investigação técnica",
  );
  assert.equal(getInvestigationPresentation(investigation("completed"))?.label, "Concluída");
});

test("mantém polling somente durante fila e execução", () => {
  assert.equal(isInvestigationActive(investigation("queued")), true);
  assert.equal(isInvestigationActive(investigation("running")), true);
  assert.equal(isInvestigationActive(investigation("completed")), false);
  assert.equal(isInvestigationActive(investigation("failed")), false);
  assert.equal(isInvestigationActive(null), false);
});

test("mantém polling da sala somente enquanto o turno está ativo", () => {
  assert.equal(isInvestigationTurnActive("queued"), true);
  assert.equal(isInvestigationTurnActive("running"), true);
  assert.equal(isInvestigationTurnActive("completed"), false);
  assert.equal(isInvestigationTurnActive("cancelled"), false);
  assert.equal(isInvestigationTurnActive("failed"), false);
  assert.equal(isInvestigationTurnActive(null), false);
  assert.equal(getInvestigationTurnLabel("running"), "Codex investigando");
  assert.equal(
    getInvestigationTurnLabel("cancelled"),
    "Investigação interrompida",
  );
  assert.equal(getInvestigationTurnLabel("failed"), "Falha na investigação");
});

test("último turno com falha mantém apresentação de falha sem selo pronto", () => {
  const presentation = getInvestigationThreadPresentation(
    null,
    "failed",
    "active",
  );

  assert.equal(presentation.state, "failed");
  assert.equal(presentation.active, false);
  assert.equal(presentation.failed, true);
  assert.equal(presentation.cancelled, false);
  assert.equal(presentation.label, "Falha na investigação");
});

test("turno interrompido tem estado terminal próprio sem parecer falha", () => {
  const presentation = getInvestigationThreadPresentation(
    null,
    "cancelled",
    "active",
  );

  assert.equal(presentation.state, "cancelled");
  assert.equal(presentation.active, false);
  assert.equal(presentation.failed, false);
  assert.equal(presentation.cancelled, true);
  assert.equal(presentation.label, "Investigação interrompida");
});
