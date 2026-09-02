import assert from "node:assert/strict";
import test from "node:test";
import {
  isInvestigationActive,
  type InvestigationSnapshot,
} from "../app/lib/investigation.js";

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

test("mantém polling somente durante fila e execução", () => {
  assert.equal(isInvestigationActive(investigation("queued")), true);
  assert.equal(isInvestigationActive(investigation("running")), true);
  assert.equal(isInvestigationActive(investigation("completed")), false);
  assert.equal(isInvestigationActive(investigation("failed")), false);
  assert.equal(isInvestigationActive(null), false);
});
