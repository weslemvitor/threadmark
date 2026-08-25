import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AutomationApiService } from "../server/automation-runtime/api-service.js";
import { AutomationRuntime } from "../server/automation-runtime/index.js";
import { createDatabase } from "../server/db/index.js";
import { SupportStore } from "../server/domain/index.js";
import { ConnectedAppService } from "../server/integrations/index.js";
import { createTestApiApp } from "../server/index.js";
import { LocalSecretVault } from "../server/runtime/secret-vault.js";

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "threadmark-automations-"));
  const database = createDatabase(":memory:");
  const support = new SupportStore(database);
  const runtime = new AutomationRuntime(
    database,
    support,
    new LocalSecretVault(directory),
    { pollIntervalMs: 5 },
  );
  const api = new AutomationApiService(database, runtime);
  return {
    api,
    database,
    directory,
    runtime,
    support,
    async close() {
      await runtime.stop();
      database.close();
      await rm(directory, { force: true, recursive: true });
    },
  };
}

function createTicket(
  support: SupportStore,
  occurredAt = new Date().toISOString(),
  externalId = "automation-message",
) {
  const account = support.upsertAccount({
    phoneNumber: "+550000000000",
    displayName: "Comercial",
  });
  const client = support.upsertClient({
    name: "Empresa exemplo",
    slug: "empresa-automacao",
    kind: "ecommerce",
  });
  const group = support.upsertGroup({
    accountId: account.id,
    clientId: client.id,
    externalJid: "automation@g.us",
    subject: "Atendimento de automação",
  });
  const participant = support.upsertParticipant({
    externalJid: "automation@s.whatsapp.net",
    displayName: "Pessoa cliente",
  });
  support.addGroupParticipant(group.id, participant.id);
  const message = support.upsertMessage({
    externalId,
    groupId: group.id,
    senderId: participant.id,
    occurredAt,
    text: "Preciso de ajuda com a configuração.",
    messageType: "text",
    triageKind: "demand",
  });
  return support.createTicket({
    groupId: group.id,
    sourceMessageId: message.id,
    title: "Configurar acesso",
    summary: "Cliente precisa de ajuda.",
    createdAt: occurredAt,
  });
}

function addSupportUser(
  database: ReturnType<typeof createDatabase>,
  id: string,
  displayName: string,
) {
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO local_users (
      id, username, display_name, role, password_hash, active,
      failed_login_attempts, locked_until, last_login_at,
      password_changed_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'operator', 'test-only', 1, 0, NULL, NULL, ?, ?, ?)
  `).run(id, id, displayName, now, now, now);
}

function capacityWorkflowDefinition(
  members: Array<{ assigneeId: string; maxTickets: number }>,
) {
  return {
    nodes: [
      { id: "created", type: "trigger" as const, config: { eventType: "ticket_created" } },
      {
        id: "capacity",
        type: "internal_action" as const,
        config: {
          actionId: "assign_ticket_by_capacity",
          input: { members },
        },
      },
    ],
    edges: [{ id: "created-capacity", source: "created", target: "capacity" }],
  };
}

test("ponte captura evento inserido depois do cursor mesmo com data retroativa", async () => {
  const current = await fixture();
  try {
    createTicket(current.support, "2026-08-19T12:00:00.000Z", "cursor-baseline");
    assert.equal(current.runtime.pumpTicketEvents(), 0);
    const workflow = current.runtime.workflows.createWorkflow({
      name: "Registrar ticket retroativo",
      actor: "Teste",
      definition: {
        nodes: [
          { id: "created", type: "trigger", config: { eventType: "ticket_created" } },
          {
            id: "note",
            type: "internal_action",
            config: {
              actionId: "add_internal_note",
              input: { body: "Evento retroativo capturado." },
            },
          },
        ],
        edges: [{ id: "created-note", source: "created", target: "note" }],
      },
    });
    current.runtime.workflows.setWorkflowStatus(workflow.id, "active", "Teste");

    const ticket = createTicket(
      current.support,
      "2020-01-01T10:00:00.000Z",
      "retroactive-message",
    );
    const inserted = current.database.prepare(
      "SELECT occurred_at FROM ticket_events WHERE ticket_id = ? AND event_type = 'ticket_created'",
    ).get(ticket.id) as { occurred_at: string };
    assert.equal(inserted.occurred_at, "2020-01-01T10:00:00.000Z");

    assert.ok(current.runtime.pumpTicketEvents() > 0);
    await current.runtime.engine.runUntilIdle();
    const notes = current.support.getTicketDetail(ticket.id).timeline.filter(
      (item) => item.type === "event" && item.eventType === "internal_note_added",
    );
    assert.equal(notes.length, 1);
  } finally {
    await current.close();
  }
});

test("reconciliação recupera lacuna após ativação sem executar histórico anterior", async () => {
  const current = await fixture();
  try {
    assert.equal(current.runtime.pumpTicketEvents(), 0);
    const historicalTicket = createTicket(
      current.support,
      "2026-08-19T10:00:00.000Z",
      "pre-activation-message",
    );
    const workflow = current.runtime.workflows.createWorkflow({
      name: "Recuperar somente eventos durante a ativação",
      actor: "Teste",
      definition: {
        nodes: [
          { id: "created", type: "trigger", config: { eventType: "ticket_created" } },
          {
            id: "note",
            type: "internal_action",
            config: {
              actionId: "add_internal_note",
              input: { body: "Evento perdido recuperado." },
            },
          },
        ],
        edges: [{ id: "created-note", source: "created", target: "note" }],
      },
    });
    const active = current.runtime.workflows.setWorkflowStatus(workflow.id, "active", "Teste");
    assert.equal(active.activationEventSequence, 1);

    const recoveredTicket = createTicket(
      current.support,
      "2026-08-19T11:00:00.000Z",
      "post-activation-message",
    );
    current.database.prepare(`
      UPDATE automation_event_cursors
      SET event_sequence = 2, reconciled_event_sequence = 0
      WHERE source = 'ticket_events'
    `).run();

    assert.equal(current.runtime.reconcileMissedTicketEvents(), 1);
    await current.runtime.engine.runUntilIdle();
    assert.equal(current.runtime.reconcileMissedTicketEvents(), 0);

    assert.equal(
      current.runtime.workflows.listRuns({ workflowId: workflow.id }).length,
      1,
    );
    const historicalNotes = current.support.getTicketDetail(historicalTicket.id).timeline.filter(
      (item) => item.type === "event" && item.eventType === "internal_note_added",
    );
    const recoveredNotes = current.support.getTicketDetail(recoveredTicket.id).timeline.filter(
      (item) => item.type === "event" && item.eventType === "internal_note_added",
    );
    assert.equal(historicalNotes.length, 0);
    assert.equal(recoveredNotes.length, 1);
  } finally {
    await current.close();
  }
});

test("ponte captura apenas eventos novos e executa ação interna uma única vez", async () => {
  const current = await fixture();
  try {
    assert.equal(current.runtime.pumpTicketEvents(), 0);
    const workflow = current.runtime.workflows.createWorkflow({
      name: "Registrar ticket novo",
      actor: "Teste",
      definition: {
        nodes: [
          { id: "created", type: "trigger", config: { eventType: "ticket_created" } },
          {
            id: "note",
            type: "internal_action",
            config: {
              actionId: "add_internal_note",
              input: { body: "Automação recebeu: {{ticket.title}}" },
            },
          },
        ],
        edges: [{ id: "created-note", source: "created", target: "note" }],
      },
    });
    current.runtime.workflows.setWorkflowStatus(workflow.id, "active", "Teste");
    const ticket = createTicket(current.support);

    assert.ok(current.runtime.pumpTicketEvents() > 0);
    await current.runtime.engine.runUntilIdle();
    // A nota também entra no audit trail, mas o bridge apenas avança seu cursor
    // porque eventos produzidos pela própria automação não geram recursão.
    current.runtime.pumpTicketEvents();
    assert.equal(current.runtime.pumpTicketEvents(), 0);
    await current.runtime.engine.runUntilIdle();

    const notes = current.support.getTicketDetail(ticket.id).timeline.filter(
      (item) => item.type === "event" && item.eventType === "internal_note_added",
    );
    assert.equal(notes.length, 1);
    assert.match(JSON.stringify(notes[0]), /Automação recebeu: Configurar acesso/);
    assert.equal(current.runtime.workflows.listRuns({ workflowId: workflow.id }).length, 1);
  } finally {
    await current.close();
  }
});

test("mudanças de etapa disparam os gatilhos específicos do ciclo do ticket", async () => {
  const current = await fixture();
  try {
    assert.equal(current.runtime.pumpTicketEvents(), 0);
    const expectedRuns = new Map<string, number>([
      ["ticket_entered_triage", 1],
      ["ticket_entered_in_progress", 3],
      ["ticket_waiting_customer", 1],
      ["ticket_waiting_internal", 1],
      ["ticket_cancelled", 1],
      ["ticket_archived", 1],
    ]);
    const workflows = new Map<string, string>();

    for (const eventType of expectedRuns.keys()) {
      const workflow = current.runtime.workflows.createWorkflow({
        name: `Gatilho ${eventType}`,
        actor: "Teste",
        definition: {
          nodes: [
            { id: "trigger", type: "trigger", config: { eventType } },
            {
              id: "note",
              type: "internal_action",
              config: {
                actionId: "add_internal_note",
                input: { body: `Executado por ${eventType}.` },
              },
            },
          ],
          edges: [{ id: "trigger-note", source: "trigger", target: "note" }],
        },
      });
      current.runtime.workflows.setWorkflowStatus(workflow.id, "active", "Teste");
      workflows.set(eventType, workflow.id);
    }

    const ticket = createTicket(current.support, undefined, "status-trigger-message");
    for (const status of [
      "in_progress",
      "triage",
      "in_progress",
      "waiting_customer",
      "blocked",
      "in_progress",
      "cancelled",
      "archived",
    ] as const) {
      current.support.updateTicketStatus(ticket.id, { status, actor: "Operador" });
    }

    assert.ok(current.runtime.pumpTicketEvents() > 0);
    await current.runtime.engine.runUntilIdle();

    for (const [eventType, expected] of expectedRuns) {
      assert.equal(
        current.runtime.workflows.listRuns({ workflowId: workflows.get(eventType)! }).length,
        expected,
        `quantidade de execuções para ${eventType}`,
      );
    }
  } finally {
    await current.close();
  }
});

test("condição após espera consulta o estado atual do ticket", async () => {
  const current = await fixture();
  try {
    assert.equal(current.runtime.pumpTicketEvents(), 0);
    const workflow = current.runtime.workflows.createWorkflow({
      name: "Lembrar somente ticket ainda em revisão",
      actor: "Teste",
      definition: {
        nodes: [
          { id: "created", type: "trigger", config: { eventType: "ticket_created" } },
          { id: "wait", type: "wait", config: { durationMs: 0 } },
          {
            id: "still-triage",
            type: "condition",
            config: { field: "status", operator: "equals", value: "triage" },
          },
          {
            id: "note",
            type: "internal_action",
            config: {
              actionId: "add_internal_note",
              input: { body: "Este lembrete não deveria ser criado." },
            },
          },
        ],
        edges: [
          { id: "created-wait", source: "created", target: "wait" },
          { id: "wait-condition", source: "wait", target: "still-triage" },
          {
            id: "condition-note",
            source: "still-triage",
            target: "note",
            sourceHandle: "true",
          },
        ],
      },
    });
    current.runtime.workflows.setWorkflowStatus(workflow.id, "active", "Teste");
    const ticket = createTicket(current.support);

    current.runtime.pumpTicketEvents();
    await current.runtime.engine.tick();
    await current.runtime.engine.tick();
    await current.runtime.engine.tick();
    current.support.updateTicketStatus(ticket.id, {
      status: "in_progress",
      actor: "Operador",
      reason: "Ticket assumido antes do lembrete.",
    });
    await current.runtime.engine.runUntilIdle();

    const notes = current.support.getTicketDetail(ticket.id).timeline.filter(
      (item) => item.type === "event" && item.eventType === "internal_note_added",
    );
    assert.equal(notes.length, 0);
    assert.equal(
      current.runtime.workflows.listRuns({ workflowId: workflow.id })[0]?.status,
      "completed",
    );
  } finally {
    await current.close();
  }
});

test("automação arquiva um ticket resolvido após a etapa de espera", async () => {
  const current = await fixture();
  try {
    assert.equal(current.runtime.pumpTicketEvents(), 0);
    const workflow = current.runtime.workflows.createWorkflow({
      name: "Arquivar resolvidos depois da espera",
      actor: "Teste",
      definition: {
        nodes: [
          { id: "resolved", type: "trigger", config: { eventType: "ticket_resolved" } },
          {
            id: "wait-days",
            type: "wait",
            config: { durationMs: 0 },
          },
          {
            id: "archive",
            type: "internal_action",
            config: {
              actionId: "change_status",
              input: { status: "archived" },
            },
          },
        ],
        edges: [
          { id: "resolved-wait", source: "resolved", target: "wait-days" },
          { id: "wait-archive", source: "wait-days", target: "archive" },
        ],
      },
    });
    current.runtime.workflows.setWorkflowStatus(workflow.id, "active", "Teste");
    const ticket = createTicket(current.support);
    current.support.updateTicketStatus(ticket.id, { status: "in_progress" });
    current.support.updateTicketStatus(ticket.id, {
      status: "resolved",
      resolution: {
        summary: "Atendimento concluído.",
        validatedBy: "Teste",
      },
    });

    current.runtime.pumpTicketEvents();
    await current.runtime.engine.runUntilIdle();

    assert.equal(current.support.getTicketDetail(ticket.id).status, "archived");
    assert.equal(
      current.runtime.workflows.listRuns({ workflowId: workflow.id })[0]?.status,
      "completed",
    );
  } finally {
    await current.close();
  }
});

test("distribuição por capacidade atribui ao atendente disponível e persiste fila FIFO", async () => {
  const current = await fixture();
  try {
    addSupportUser(current.database, "owner-user", "Pessoa Proprietária");
    addSupportUser(current.database, "operator-user", "Pessoa Operadora");

    const occupiedByOwner = Array.from({ length: 4 }, (_, index) =>
      createTicket(current.support, undefined, `capacity-owner-${index}`));
    for (const ticket of occupiedByOwner) {
      current.support.updateTicketAssignee(ticket.id, "owner-user", "Teste");
    }
    const occupiedByOperator = createTicket(
      current.support,
      undefined,
      "capacity-operator",
    );
    current.support.updateTicketAssignee(occupiedByOperator.id, "operator-user", "Teste");
    assert.equal(current.runtime.pumpTicketEvents(), 0);

    const workflow = current.runtime.workflows.createWorkflow({
      name: "Distribuir por capacidade",
      actor: "Teste",
      definition: capacityWorkflowDefinition([
        { assigneeId: "owner-user", maxTickets: 5 },
        { assigneeId: "operator-user", maxTickets: 1 },
      ]),
    });
    current.runtime.workflows.setWorkflowStatus(workflow.id, "active", "Teste");

    const assigned = createTicket(current.support, undefined, "capacity-assigned");
    current.runtime.pumpTicketEvents();
    await current.runtime.engine.runUntilIdle();
    assert.equal(current.support.getTicketDetail(assigned.id).assignee?.id, "owner-user");

    const queuedFirst = createTicket(current.support, undefined, "capacity-queued-first");
    const queuedSecond = createTicket(current.support, undefined, "capacity-queued-second");
    current.runtime.pumpTicketEvents();
    await current.runtime.engine.runUntilIdle();
    assert.equal(current.support.getTicketDetail(queuedFirst.id).assignee, null);
    assert.equal(current.support.getTicketDetail(queuedFirst.id).assignmentPending, true);
    assert.equal(current.support.getTicketDetail(queuedSecond.id).assignmentPending, true);

    const queuedRows = current.database.prepare(`
      SELECT ticket_id FROM automation_assignment_queue ORDER BY queue_order
    `).all() as Array<{ ticket_id: string }>;
    assert.deepEqual(queuedRows.map((row) => row.ticket_id), [queuedFirst.id, queuedSecond.id]);

    current.support.updateTicketStatus(occupiedByOperator.id, {
      status: "cancelled",
      actor: "Teste",
      reason: "Liberar capacidade para validar a fila.",
    });
    current.runtime.pumpTicketEvents();
    await current.runtime.engine.runUntilIdle();

    assert.equal(current.support.getTicketDetail(queuedFirst.id).assignee?.id, "operator-user");
    assert.equal(current.support.getTicketDetail(queuedFirst.id).assignmentPending, false);
    assert.equal(current.support.getTicketDetail(queuedSecond.id).assignee, null);
    assert.equal(current.support.getTicketDetail(queuedSecond.id).assignmentPending, true);
  } finally {
    await current.close();
  }
});

test("fila de capacidade sobrevive ao reinício do runtime e ignora tickets finalizados", async () => {
  const current = await fixture();
  try {
    addSupportUser(current.database, "operator-only", "Pessoa operadora");
    const occupied = createTicket(current.support, undefined, "restart-occupied");
    current.support.updateTicketAssignee(occupied.id, "operator-only", "Teste");
    assert.equal(current.runtime.pumpTicketEvents(), 0);
    const workflow = current.runtime.workflows.createWorkflow({
      name: "Fila persistente",
      actor: "Teste",
      definition: capacityWorkflowDefinition([
        { assigneeId: "operator-only", maxTickets: 1 },
      ]),
    });
    current.runtime.workflows.setWorkflowStatus(workflow.id, "active", "Teste");
    const waiting = createTicket(current.support, undefined, "restart-waiting");
    current.runtime.pumpTicketEvents();
    await current.runtime.engine.runUntilIdle();
    assert.equal(current.support.getTicketDetail(waiting.id).assignmentPending, true);

    const restarted = new AutomationRuntime(
      current.database,
      current.support,
      new LocalSecretVault(current.directory),
      { pollIntervalMs: 5 },
    );
    current.support.updateTicketStatus(occupied.id, {
      status: "resolved",
      actor: "Teste",
      resolution: { summary: "Vaga liberada.", validatedBy: "Teste" },
    });
    restarted.pumpTicketEvents();
    await restarted.engine.runUntilIdle();

    assert.equal(current.support.getTicketDetail(waiting.id).assignee?.id, "operator-only");
    assert.equal(current.support.getTicketDetail(waiting.id).assignmentPending, false);
  } finally {
    await current.close();
  }
});

test("editar o limite reavalia imediatamente a fila sem tirar a automação do ar", async () => {
  const current = await fixture();
  try {
    addSupportUser(current.database, "capacity-editor", "Pessoa da equipe");
    const occupied = createTicket(current.support, undefined, "capacity-edit-occupied");
    current.support.updateTicketAssignee(occupied.id, "capacity-editor", "Teste");
    assert.equal(current.runtime.pumpTicketEvents(), 0);

    const workflow = current.runtime.workflows.createWorkflow({
      name: "Capacidade editável",
      actor: "Teste",
      definition: capacityWorkflowDefinition([
        { assigneeId: "capacity-editor", maxTickets: 1 },
      ]),
    });
    current.runtime.workflows.setWorkflowStatus(workflow.id, "active", "Teste");
    const waiting = createTicket(current.support, undefined, "capacity-edit-waiting");
    current.runtime.pumpTicketEvents();
    await current.runtime.engine.runUntilIdle();
    assert.equal(current.support.getTicketDetail(waiting.id).assignmentPending, true);

    const updated = current.runtime.workflows.updateWorkflow(workflow.id, {
      actor: "Teste",
      definition: capacityWorkflowDefinition([
        { assigneeId: "capacity-editor", maxTickets: 2 },
      ]),
    });
    assert.equal(updated.status, "active");
    await current.runtime.engine.runUntilIdle();

    assert.equal(current.support.getTicketDetail(waiting.id).assignee?.id, "capacity-editor");
    assert.equal(current.support.getTicketDetail(waiting.id).assignmentPending, false);
  } finally {
    await current.close();
  }
});

test("distribuição ignora atendente inativo e preserva atribuição manual da fila", async () => {
  const current = await fixture();
  try {
    addSupportUser(current.database, "inactive-capacity", "Pessoa inativa");
    addSupportUser(current.database, "active-capacity", "Pessoa ativa");
    current.database.prepare(
      "UPDATE local_users SET active = 0 WHERE id = ?",
    ).run("inactive-capacity");
    const occupied = createTicket(current.support, undefined, "manual-queue-occupied");
    current.support.updateTicketAssignee(occupied.id, "active-capacity", "Teste");
    assert.equal(current.runtime.pumpTicketEvents(), 0);

    const workflow = current.runtime.workflows.createWorkflow({
      name: "Capacidade com usuário inativo",
      actor: "Teste",
      definition: capacityWorkflowDefinition([
        { assigneeId: "inactive-capacity", maxTickets: 5 },
        { assigneeId: "active-capacity", maxTickets: 1 },
      ]),
    });
    current.runtime.workflows.setWorkflowStatus(workflow.id, "active", "Teste");
    const waiting = createTicket(current.support, undefined, "manual-queue-waiting");
    current.runtime.pumpTicketEvents();
    await current.runtime.engine.runUntilIdle();

    assert.equal(current.support.getTicketDetail(waiting.id).assignee, null);
    assert.equal(current.support.getTicketDetail(waiting.id).assignmentPending, true);

    current.support.updateTicketAssignee(waiting.id, "active-capacity", "Operador local");
    current.runtime.pumpTicketEvents();
    await current.runtime.engine.runUntilIdle();

    assert.equal(
      current.support.getTicketDetail(waiting.id).assignee?.id,
      "active-capacity",
    );
    assert.equal(current.support.getTicketDetail(waiting.id).assignmentPending, false);
    const remaining = current.database.prepare(
      "SELECT COUNT(*) AS count FROM automation_assignment_queue WHERE ticket_id = ?",
    ).get(waiting.id) as { count: number };
    assert.equal(remaining.count, 0);
  } finally {
    await current.close();
  }
});

test("API persiste rascunho incompleto e nunca devolve segredo de app", async () => {
  const current = await fixture();
  try {
    const draft = current.api.createAutomation(
      { name: "Avisar o time", description: "Fluxo em construção" },
      "Teste",
    );
    assert.equal(draft.status, "draft");
    assert.deepEqual(draft.definition.nodes, []);

    const incompleteDraft = current.api.updateAutomation(
      draft.id,
      {
        name: draft.name,
        description: draft.description,
        definition: {
          version: 1,
          nodes: [
            {
              id: "trigger-incompleto",
              type: "trigger",
              position: { x: 120, y: 80 },
              config: { eventType: "ticket_created" },
            },
          ],
          edges: [],
        },
      },
      "Teste",
    );
    assert.equal(incompleteDraft.definition.nodes.length, 1);
    assert.equal(current.api.getAutomation(draft.id).definition.nodes[0]?.id, "trigger-incompleto");

    const app = await current.api.createConnectedApp(
      {
        type: "slack_webhook",
        name: "Slack do suporte",
        enabled: true,
        aiEnabled: true,
        endpoint: "https://hooks.slack.com/services/example/example/example",
      },
      "Teste",
    );
    assert.equal(app.secretConfigured, true);
    assert.equal(app.aiEnabled, true);
    assert.equal("endpoint" in app, false);
    assert.doesNotMatch(JSON.stringify(current.api.listConnectedApps()), /services\/example/);

    const updated = await current.api.updateConnectedApp(
      app.id,
      {
        type: "slack_webhook",
        name: "Slack principal",
        enabled: false,
        endpoint: "",
      },
      "Teste",
    );
    assert.equal(updated.status, "disabled");
    assert.equal(updated.aiEnabled, true, "atualização antiga preserva a autorização da IA");
    assert.equal(updated.secretConfigured, true);
  } finally {
    await current.close();
  }
});

test("automação executa somente uma ferramenta MCP descoberta e autorizada", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "threadmark-mcp-automation-"));
  const database = createDatabase(":memory:");
  const support = new SupportStore(database);
  const vault = new LocalSecretVault(directory);
  const methods: string[] = [];
  const connectedApps = new ConnectedAppService(
    database,
    vault,
    async (_input, init) => {
      const request = JSON.parse(String(init?.body ?? "{}")) as {
        id?: string | number;
        method?: string;
      };
      methods.push(request.method ?? "");
      if (request.id === undefined) return new Response(null, { status: 202 });
      const result = request.method === "initialize"
        ? {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "mock", version: "1.0.0" },
          }
        : request.method === "tools/list"
          ? {
              tools: [{
                name: "create_issue",
                title: "Criar issue",
                description: "Cria uma issue a partir do ticket.",
                inputSchema: {
                  type: "object",
                  properties: { title: { type: "string" } },
                  required: ["title"],
                },
                annotations: { readOnlyHint: false, destructiveHint: false },
              }],
            }
          : request.method === "tools/call"
            ? { structuredContent: { id: "ISSUE-101" }, content: [] }
            : {};
      return Response.json({ jsonrpc: "2.0", id: request.id, result }, {
        headers: { "mcp-session-id": "automation-test" },
      });
    },
    async () => [{ address: "93.184.216.34" }],
  );
  const runtime = new AutomationRuntime(database, support, vault, {
    pollIntervalMs: 5,
    connectedApps,
  });
  const api = new AutomationApiService(database, runtime);

  try {
    const app = await connectedApps.create({
      type: "mcp_remote",
      name: "Projetos MCP",
      enabled: true,
      aiEnabled: true,
      endpoint: "https://mcp.example.com/mcp",
    }, "Teste");
    await connectedApps.validateConnection(app.id);
    await connectedApps.update(app.id, {
      type: "mcp_remote",
      name: "Projetos MCP",
      enabled: true,
      aiEnabled: true,
      endpoint: "",
      mcpTools: [{
        name: "create_issue",
        aiEnabled: true,
        automationEnabled: true,
        confirmationRequired: false,
      }],
    }, "Teste");
    assert.equal(runtime.pumpTicketEvents(), 0);
    const workflow = api.createAutomation({ name: "Criar issue externa" }, "Teste");
    api.updateAutomation(workflow.id, {
      name: workflow.name,
      description: null,
      definition: {
        nodes: [{
          id: "created",
          type: "trigger",
          position: { x: 0, y: 0 },
          config: { eventType: "ticket_created" },
        }, {
          id: "external",
          type: "app_action",
          position: { x: 0, y: 180 },
          config: {
            appId: "mcp-remote",
            connectionId: app.id,
            actionId: "create_issue",
            input: { title: "Ticket {{ticket.number}} · {{ticket.title}}" },
          },
        }],
        edges: [{ id: "created-external", source: "created", target: "external" }],
      },
    }, "Teste");
    api.activateAutomation(workflow.id, "Teste");
    createTicket(support, "2026-08-20T16:00:00.000Z", "mcp-automation-message");
    runtime.pumpTicketEvents();
    await runtime.engine.runUntilIdle();

    assert.equal(methods.includes("tools/call"), true);
    assert.equal(
      runtime.workflows.listRuns({ workflowId: workflow.id })[0]?.status,
      "completed",
    );
  } finally {
    await runtime.stop();
    database.close();
    await rm(directory, { force: true, recursive: true });
  }
});

test("rotas HTTP criam, salvam, ativam e retornam Dry Run sem persistência", async () => {
  const current = await fixture();
  try {
    const app = createTestApiApp(current.support, undefined, undefined, {
      automations: current.api,
    });
    const createdResponse = await app.request("/api/automations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Fluxo via HTTP" }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { id: string };

    const savedResponse = await app.request(`/api/automations/${created.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Fluxo via HTTP",
        description: null,
        definition: {
          version: 1,
          nodes: [
            {
              id: "trigger",
              type: "trigger",
              position: { x: 0, y: 0 },
              config: { eventType: "ticket_created" },
            },
            {
              id: "wait",
              type: "wait",
              position: { x: 0, y: 160 },
              config: { durationMs: 60_000 },
            },
            {
              id: "note",
              type: "internal_action",
              position: { x: 0, y: 320 },
              config: {
                actionId: "add_internal_note",
                input: { body: "Revisado pela automação de QA." },
              },
            },
          ],
          edges: [
            { id: "trigger-wait", source: "trigger", target: "wait" },
            { id: "wait-note", source: "wait", target: "note" },
          ],
        },
      }),
    });
    assert.equal(savedResponse.status, 200);
    assert.equal((await savedResponse.json() as { definition: { nodes: unknown[] } }).definition.nodes.length, 3);

    assert.equal(
      (await app.request(`/api/automations/${created.id}/activate`, { method: "POST" })).status,
      200,
    );
    const layoutResponse = await app.request(
      `/api/automations/${created.id}/layout`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          nodes: [
            { id: "trigger", position: { x: 120, y: 80 } },
            { id: "wait", position: { x: 360, y: 240 } },
            { id: "note", position: { x: 600, y: 400 } },
          ],
        }),
      },
    );
    assert.equal(layoutResponse.status, 200);
    const layout = await layoutResponse.json() as {
      status: string;
      definition: { nodes: Array<{ id: string; position: { x: number; y: number } }> };
    };
    assert.equal(layout.status, "active");
    assert.deepEqual(
      layout.definition.nodes.map((node) => node.position),
      [{ x: 120, y: 80 }, { x: 360, y: 240 }, { x: 600, y: 400 }],
    );
    const metadataResponse = await app.request(
      `/api/automations/${created.id}/metadata`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Fluxo HTTP renomeado",
          description: "Metadados sem alterar a lógica ativa.",
        }),
      },
    );
    assert.equal(metadataResponse.status, 200);
    const metadata = await metadataResponse.json() as {
      name: string;
      description: string | null;
      status: string;
    };
    assert.equal(metadata.name, "Fluxo HTTP renomeado");
    assert.equal(metadata.description, "Metadados sem alterar a lógica ativa.");
    assert.equal(metadata.status, "active");
    const testResponse = await app.request(`/api/automations/${created.id}/test`, {
      method: "POST",
    });
    assert.equal(testResponse.status, 200);
    const dryRun = await testResponse.json() as {
      status: string;
      dryRun: boolean;
      steps: Array<{ nodeId: string; status: string; detail: string }>;
    };
    assert.equal(dryRun.status, "completed");
    assert.equal(dryRun.dryRun, true);
    assert.deepEqual(dryRun.steps.map((step) => step.nodeId), ["trigger", "wait", "note"]);
    assert.equal(dryRun.steps.every((step) => step.status === "passed"), true);
    assert.match(dryRun.steps[1]?.detail ?? "", /sem aguardar/i);
    assert.match(dryRun.steps[2]?.detail ?? "", /sem alterar/i);

    const persisted = current.database.prepare(`
      SELECT COUNT(*) AS count
      FROM automation_runs
      WHERE workflow_id = ?
    `).get(created.id) as { count: number };
    assert.equal(persisted.count, 0);
  } finally {
    await current.close();
  }
});
