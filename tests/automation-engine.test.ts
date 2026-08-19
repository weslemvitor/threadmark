import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import {
  AutomationEngine,
  AutomationStore,
  AutomationValidationError,
  matchesFilter,
  type AutomationWorkflowDefinition,
  validateWorkflowDefinition,
} from "../server/automations/index.js";
import { createDatabase, type SupportDatabase } from "../server/db/index.js";

const databases: SupportDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

test("condições distinguem campos preenchidos e vazios", () => {
  assert.equal(
    matchesFilter({ assignee: null }, { field: "assignee", operator: "not_exists" }),
    true,
  );
  assert.equal(
    matchesFilter(
      { assignee: "operator-1" },
      { field: "assignee", operator: "not_exists" },
    ),
    false,
  );
  assert.equal(
    matchesFilter({ assignee: "operator-1" }, { field: "assignee", operator: "exists" }),
    true,
  );
});

test("workflow mantém somente a definição atual e continua ativo ao ser editado", () => {
  const { database, store } = fixture();
  const first = store.createWorkflow({
    id: "workflow-current-definition",
    name: "Triagem urgente",
    definition: triggerToActionDefinition(),
    actor: "Operador",
  });
  assert.equal(first.currentVersion, 1);
  store.setWorkflowStatus(first.id, "active", "Operador");

  const updatedDefinition = triggerToActionDefinition("notify-updated");
  const updated = store.updateWorkflow(first.id, {
    name: "Triagem urgente atualizada",
    definition: updatedDefinition,
    actor: "Operador",
  });
  assert.equal(updated.currentVersion, 1);
  assert.equal(updated.status, "active");
  assert.equal(store.getWorkflow(first.id).definition.nodes[1]?.id, "notify-updated");
  const versions = database.prepare(
    "SELECT version FROM automation_workflow_versions WHERE workflow_id = ?",
  ).all(first.id) as Array<{ version: number }>;
  assert.deepEqual(versions, [{ version: 1 }]);
});

test("execução em andamento preserva a definição usada ao iniciar", async () => {
  let currentTime = Date.parse("2026-08-19T18:00:00.000Z");
  const clock = () => new Date(currentTime);
  const { database } = fixture();
  const store = new AutomationStore(database, { clock });
  const workflow = store.createWorkflow({
    id: "workflow-snapshot",
    name: "Snapshot durante espera",
    definition: waitDefinition("assign-original"),
    actor: "Operador",
  });
  store.setWorkflowStatus(workflow.id, "active", "Operador");
  const calls: string[] = [];
  const engine = new AutomationEngine(store, {
    internal: {
      "assign-original"() {
        calls.push("original");
      },
      "assign-updated"() {
        calls.push("updated");
      },
    },
  });

  engine.dispatchEvent(ticketEvent("snapshot-event"));
  await engine.runUntilIdle();
  store.updateWorkflow(workflow.id, {
    definition: waitDefinition("assign-updated"),
    actor: "Operador",
  });

  assert.equal(store.getWorkflow(workflow.id).status, "active");
  currentTime += 60_000;
  await engine.runUntilIdle();
  assert.deepEqual(calls, ["original"]);
  assert.equal(store.getRun(readOnlyRunId(database, workflow.id)).definition, null);
  const versions = database.prepare(
    "SELECT COUNT(*) AS total FROM automation_workflow_versions WHERE workflow_id = ?",
  ).get(workflow.id) as { total: number };
  assert.equal(versions.total, 1);
});

test("alterar a duração atualiza etapas de espera que ainda estão pendentes", async () => {
  let currentTime = Date.parse("2026-08-19T18:00:00.000Z");
  const clock = () => new Date(currentTime);
  const { database } = fixture();
  const store = new AutomationStore(database, { clock });
  const workflow = store.createWorkflow({
    id: "workflow-reschedule-wait",
    name: "Arquivar depois da espera",
    definition: waitDefinition("archive", 7 * 24 * 60 * 60 * 1_000),
    actor: "Operador",
  });
  store.setWorkflowStatus(workflow.id, "active", "Operador");
  const calls: string[] = [];
  const engine = new AutomationEngine(store, {
    internal: {
      archive() {
        calls.push("archived");
      },
    },
  });

  engine.dispatchEvent(ticketEvent("reschedule-wait-event"));
  await engine.runUntilIdle();
  const runId = readOnlyRunId(database, workflow.id);
  assert.equal(
    store.listRunSteps(runId).find((step) => step.nodeId === "wait")?.availableAt,
    "2026-08-26T18:00:00.000Z",
  );

  store.updateWorkflow(workflow.id, {
    definition: waitDefinition("archive", 60_000),
    actor: "Operador",
  });
  assert.equal(
    store.listRunSteps(runId).find((step) => step.nodeId === "wait")?.availableAt,
    "2026-08-19T18:01:00.000Z",
  );

  currentTime += 60_000;
  await engine.runUntilIdle();
  assert.deepEqual(calls, ["archived"]);
});

test("layout visual é salvo sem tirar o workflow ativo nem criar nova versão", () => {
  const { database, store } = fixture();
  const workflow = store.createWorkflow({
    id: "workflow-layout",
    name: "Organizar visualmente",
    definition: triggerToActionDefinition(),
    actor: "Operador",
  });
  store.setWorkflowStatus(workflow.id, "active", "Operador");

  const updated = store.updateWorkflowLayout(
    workflow.id,
    {
      start: { x: 180, y: 120 },
      notify: { x: 540, y: 300 },
    },
    "Operador",
  );

  assert.equal(updated.status, "active");
  assert.equal(updated.currentVersion, 1);
  assert.deepEqual(updated.definition.nodes[0]?.position, { x: 180, y: 120 });
  assert.deepEqual(updated.definition.nodes[1]?.position, { x: 540, y: 300 });
  const versionCount = database.prepare(
    "SELECT COUNT(*) AS total FROM automation_workflow_versions WHERE workflow_id = ?",
  ).get(workflow.id) as { total: number };
  assert.equal(versionCount.total, 1);
  assert.notDeepEqual(
    store.getWorkflow(workflow.id, 1).definition.nodes[0]?.position,
    { x: 180, y: 120 },
  );
});

test("nome e descrição são salvos sem tirar o workflow ativo nem criar nova versão", () => {
  const { database, store } = fixture();
  const workflow = store.createWorkflow({
    id: "workflow-metadata",
    name: "Nome inicial",
    description: "Descrição inicial",
    definition: triggerToActionDefinition(),
    actor: "Operador",
  });
  store.setWorkflowStatus(workflow.id, "active", "Operador");

  const updated = store.updateWorkflowMetadata(
    workflow.id,
    {
      name: "Arquivamento de tickets",
      description: "Arquiva tickets resolvidos depois do prazo configurado.",
    },
    "Operador",
  );

  assert.equal(updated.status, "active");
  assert.equal(updated.currentVersion, 1);
  assert.equal(updated.name, "Arquivamento de tickets");
  assert.equal(
    updated.description,
    "Arquiva tickets resolvidos depois do prazo configurado.",
  );
  const versionCount = database.prepare(
    "SELECT COUNT(*) AS total FROM automation_workflow_versions WHERE workflow_id = ?",
  ).get(workflow.id) as { total: number };
  assert.equal(versionCount.total, 1);
});

test("validação bloqueia ciclos, junções ambíguas e qualquer ação outbound do WhatsApp", () => {
  assert.throws(
    () =>
      validateWorkflowDefinition({
        nodes: [
          { id: "start", type: "trigger", config: { eventType: "ticket.created" } },
        ],
        edges: [],
      }),
    /ao menos uma ação/,
  );
  assert.throws(
    () =>
      validateWorkflowDefinition({
        nodes: [
          { id: "start", type: "trigger", config: { eventType: "ticket.created" } },
          {
            id: "condition",
            type: "condition",
            config: { field: "payload.priority", operator: "equals", value: "urgent" },
          },
        ],
        edges: [
          { id: "to-condition", source: "start", target: "condition" },
          {
            id: "cycle",
            source: "condition",
            target: "start",
            sourceHandle: "true",
          },
        ],
      }),
    (error: unknown) =>
      error instanceof AutomationValidationError && /ciclos/.test(error.message),
  );

  assert.throws(
    () =>
      validateWorkflowDefinition({
        nodes: [
          { id: "start", type: "trigger", config: { eventType: "ticket.created" } },
          {
            id: "forbidden",
            type: "app_action",
            config: { appId: "WhatsApp", actionId: "send-message" },
          },
        ],
        edges: [{ id: "edge", source: "start", target: "forbidden" }],
      }),
    /ações outbound do WhatsApp são proibidas/,
  );
});

test("evento filtrado dispara uma única execução e ação idempotente", async () => {
  const { database, store } = fixture();
  const workflow = store.createWorkflow({
    id: "workflow-urgent",
    name: "Avisar urgência",
    definition: triggerToActionDefinition(),
    actor: "Operador",
  });
  store.setWorkflowStatus(workflow.id, "active", "Operador");
  const calls: string[] = [];
  const engine = new AutomationEngine(store, {
    internal: {
      notify(context) {
        calls.push(context.idempotencyKey);
        return { notified: true };
      },
    },
  });

  const event = {
    eventType: "ticket.priority_changed",
    subjectType: "ticket",
    subjectId: "ticket-1",
    idempotencyKey: "ticket-1:urgent:2026-08-18",
    payload: { priority: "urgent" },
  };
  assert.equal(engine.dispatchEvent(event).created, true);
  assert.equal(engine.dispatchEvent(event).created, false);
  await engine.runUntilIdle();

  const runRows = database.prepare(
    "SELECT id, status FROM automation_runs WHERE workflow_id = ?",
  ).all(workflow.id) as Array<{ id: string; status: string }>;
  assert.equal(runRows.length, 1);
  assert.equal(runRows[0]?.status, "completed");
  assert.equal(calls.length, 1);
  assert.match(calls[0] ?? "", new RegExp(`^${runRows[0]?.id}:notify$`));
});

test("ação falha, respeita retry limitado e reutiliza a mesma chave idempotente", async () => {
  const { database, store } = fixture();
  const definition = triggerToActionDefinition();
  const action = definition.nodes[1];
  if (action?.type !== "internal_action") throw new Error("fixture inválida");
  action.config.retry = { maxAttempts: 2, delayMs: 0 };
  const workflow = store.createWorkflow({
    id: "workflow-retry",
    name: "Retry",
    definition,
    actor: "Operador",
  });
  store.setWorkflowStatus(workflow.id, "active", "Operador");
  const keys: string[] = [];
  const engine = new AutomationEngine(store, {
    internal: {
      notify(context) {
        keys.push(context.idempotencyKey);
        if (keys.length === 1) throw new Error("Slack indisponível");
        return { ok: true };
      },
    },
  });
  engine.dispatchEvent(ticketEvent("retry-event"));
  await engine.runUntilIdle();

  const step = database.prepare(`
    SELECT attempt_count, status FROM automation_run_steps WHERE node_id = 'notify'
  `).get() as { attempt_count: number; status: string };
  assert.deepEqual(keys, [keys[0], keys[0]]);
  assert.equal(step.attempt_count, 2);
  assert.equal(step.status, "completed");
});

test("wait persiste e é retomado por outra instância após reinício", async () => {
  let currentTime = Date.parse("2026-08-18T18:00:00.000Z");
  const clock = () => new Date(currentTime);
  const { database } = fixture();
  const storeBeforeRestart = new AutomationStore(database, { clock });
  const workflow = storeBeforeRestart.createWorkflow({
    id: "workflow-wait",
    name: "Esperar antes de atribuir",
    definition: waitDefinition(),
    actor: "Operador",
  });
  storeBeforeRestart.setWorkflowStatus(workflow.id, "active", "Operador");
  let actionCalls = 0;
  const handlers = {
    internal: {
      assign() {
        actionCalls += 1;
        return { assigned: true };
      },
    },
  };
  const firstEngine = new AutomationEngine(storeBeforeRestart, handlers);
  firstEngine.dispatchEvent(ticketEvent("wait-event"));
  await firstEngine.runUntilIdle();
  const runId = readOnlyRunId(database, workflow.id);
  assert.equal(storeBeforeRestart.getRun(runId).status, "waiting");
  assert.equal(actionCalls, 0);

  currentTime += 60_000;
  const storeAfterRestart = new AutomationStore(database, { clock });
  const restartedEngine = new AutomationEngine(storeAfterRestart, handlers);
  await restartedEngine.runUntilIdle();
  assert.equal(storeAfterRestart.getRun(runId).status, "completed");
  assert.equal(actionCalls, 1);
});

test("aprovação, pausa, retomada e cancelamento preservam o estado no SQLite", async () => {
  const { database, store } = fixture();
  const workflow = store.createWorkflow({
    id: "workflow-approval",
    name: "Aprovação humana",
    definition: approvalDefinition(),
    actor: "Operador",
  });
  store.setWorkflowStatus(workflow.id, "active", "Operador");
  let publications = 0;
  const engine = new AutomationEngine(store, {
    internal: {
      publish() {
        publications += 1;
        return { published: true };
      },
    },
  });
  engine.dispatchEvent(ticketEvent("approval-event"));
  await engine.runUntilIdle();
  const runId = readOnlyRunId(database, workflow.id);
  const approval = store.listRunSteps(runId).find((step) => step.nodeId === "approval");
  assert.equal(approval?.status, "awaiting_approval");

  assert.equal(engine.pauseRun(runId).status, "paused");
  assert.throws(
    () =>
      engine.approveStep(approval?.id ?? "", {
        approved: true,
        actor: "Agente responsável",
      }),
    /pausada/,
  );
  assert.equal(engine.resumeRun(runId).status, "waiting");
  engine.approveStep(approval?.id ?? "", {
    approved: true,
    actor: "Agente responsável",
  });
  await engine.runUntilIdle();
  assert.equal(store.getRun(runId).status, "completed");
  assert.equal(publications, 1);

  engine.dispatchEvent(ticketEvent("cancel-event"));
  assert.equal((await engine.tick()).kind, "event");
  const cancelRunId = database.prepare(`
    SELECT id FROM automation_runs WHERE idempotency_key = 'cancel-event'
  `).get() as { id: string };
  assert.equal(engine.cancelRun(cancelRunId.id).status, "cancelled");
  assert.equal(
    store.listRunSteps(cancelRunId.id).every((step) => step.status === "cancelled"),
    true,
  );
});

function fixture() {
  const database = createDatabase(":memory:");
  databases.push(database);
  return { database, store: new AutomationStore(database) };
}

function triggerToActionDefinition(actionId = "notify"): AutomationWorkflowDefinition {
  return {
    nodes: [
      {
        id: "start",
        type: "trigger",
        config: {
          eventType: "ticket.priority_changed",
          filters: [{ field: "payload.priority", operator: "equals", value: "urgent" }],
        },
      },
      { id: actionId, type: "internal_action", config: { actionId: "notify" } },
    ],
    edges: [{ id: "start-action", source: "start", target: actionId }],
  };
}

function waitDefinition(
  actionId = "assign",
  durationMs = 60_000,
): AutomationWorkflowDefinition {
  return {
    nodes: [
      { id: "start", type: "trigger", config: { eventType: "ticket.priority_changed" } },
      { id: "wait", type: "wait", config: { durationMs } },
      { id: actionId, type: "internal_action", config: { actionId } },
    ],
    edges: [
      { id: "start-wait", source: "start", target: "wait" },
      { id: "wait-assign", source: "wait", target: actionId },
    ],
  };
}

function approvalDefinition(): AutomationWorkflowDefinition {
  return {
    nodes: [
      { id: "start", type: "trigger", config: { eventType: "ticket.priority_changed" } },
      { id: "approval", type: "approval", config: { instructions: "Revisar conteúdo" } },
      { id: "publish", type: "internal_action", config: { actionId: "publish" } },
    ],
    edges: [
      { id: "start-approval", source: "start", target: "approval" },
      {
        id: "approval-publish",
        source: "approval",
        target: "publish",
        sourceHandle: "approved",
      },
    ],
  };
}

function ticketEvent(idempotencyKey: string) {
  return {
    eventType: "ticket.priority_changed",
    subjectType: "ticket",
    subjectId: "ticket-1",
    idempotencyKey,
    payload: { priority: "urgent" },
  };
}

function readOnlyRunId(database: SupportDatabase, workflowId: string): string {
  const row = database.prepare(
    "SELECT id FROM automation_runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1",
  ).get(workflowId) as { id: string } | undefined;
  if (!row) throw new Error("Execução não encontrada no teste.");
  return row.id;
}
