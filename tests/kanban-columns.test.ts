import assert from "node:assert/strict";
import test from "node:test";

import { kanbanColumns } from "../app/features/kanban/domain/kanban-columns.js";
import { allowedStatusTransitions } from "../server/domain/status.js";
import { TICKET_STATUSES, type TicketStatus } from "../shared/contracts.js";

function columnFor(status: TicketStatus) {
  return kanbanColumns.find((column) => column.statuses.includes(status));
}

test("tickets novos e em triagem ficam separados e aceitam movimentação entre as duas etapas", () => {
  const newColumn = columnFor("new");
  const triageColumn = columnFor("triage");
  assert.ok(newColumn);
  assert.ok(triageColumn);
  assert.notEqual(newColumn.id, triageColumn.id);
  assert.equal(newColumn.targetStatus, "new");
  assert.equal(triageColumn.targetStatus, "triage");
  assert.equal(newColumn.statuses.includes("triage"), false);
  assert.equal(triageColumn.statuses.includes("new"), false);
  assert.ok(allowedStatusTransitions("new").includes(triageColumn.targetStatus));
  assert.ok(allowedStatusTransitions("triage").includes(newColumn.targetStatus));
  assert.ok(kanbanColumns.indexOf(newColumn) < kanbanColumns.indexOf(triageColumn));
});

test("a esteira preserva todos os status existentes sem duplicar tickets ou exibir arquivados", () => {
  for (const status of TICKET_STATUSES) {
    const matchingColumns = kanbanColumns.filter((column) => column.statuses.includes(status));
    assert.equal(matchingColumns.length, status === "archived" ? 0 : 1, status);
  }
  for (const column of kanbanColumns) {
    assert.ok(column.statuses.includes(column.targetStatus), column.id);
  }

  assert.equal(columnFor("waiting_customer")?.id, columnFor("blocked")?.id);
  assert.equal(columnFor("waiting_customer")?.targetStatus, "waiting_customer");
  assert.notEqual(columnFor("cancelled")?.id, columnFor("resolved")?.id);
  assert.equal(columnFor("cancelled")?.targetStatus, "cancelled");
});
