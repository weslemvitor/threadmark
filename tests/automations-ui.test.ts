import assert from "node:assert/strict";
import test from "node:test";

import {
  automationNodeCatalogId,
  catalogWithConnectedApps,
  defaultAutomationNodeCatalog,
  editableAutomationSignature,
  automationMetadataSignature,
  automationNodeConfigurationSummary,
  initialNodeConfig,
  insertAutomationTemplateVariable,
  validateAutomation,
  type AutomationDefinition,
} from "../app/features/automations/domain/index.js";
import { persistedNodeChanges } from "../app/features/automations/components/persisted-node-changes.js";

test("canvas persiste apenas alterações definitivas do React Flow", () => {
  const changes = persistedNodeChanges([
    { id: "node", type: "dimensions", dimensions: { width: 250, height: 120 } },
    { id: "node", type: "select", selected: true },
    {
      id: "node",
      type: "position",
      position: { x: 10, y: 20 },
      dragging: true,
    },
    {
      id: "node",
      type: "position",
      position: { x: 20, y: 40 },
      dragging: false,
    },
    { id: "other", type: "remove" },
  ]);

  assert.deepEqual(changes.map((change) => change.type), ["position", "remove"]);
  assert.deepEqual(changes[0], {
    id: "node",
    type: "position",
    position: { x: 20, y: 40 },
    dragging: false,
  });
});

test("mover nós não transforma uma automação ativa em alteração funcional", () => {
  const base = {
    id: "workflow-active",
    name: "Avisar suporte",
    description: null,
    status: "active" as const,
    nodeCount: 1,
    runCount: 0,
    lastRunAt: null,
    updatedAt: "2026-08-19T12:00:00.000Z",
    createdAt: "2026-08-19T12:00:00.000Z",
    definition: {
      version: 1,
      nodes: [{
        id: "trigger",
        type: "trigger" as const,
        position: { x: 0, y: 0 },
        config: { eventType: "ticket_created" },
      }],
      edges: [],
    },
  };
  const moved = structuredClone(base);
  moved.definition.nodes[0]!.position = { x: 420, y: 240 };

  assert.equal(
    editableAutomationSignature(base),
    editableAutomationSignature(moved),
  );
});

test("editar nome e descrição não transforma uma automação ativa em alteração funcional", () => {
  const base = {
    id: "workflow-active",
    name: "Nome inicial",
    description: "Descrição inicial",
    status: "active" as const,
    nodeCount: 0,
    runCount: 0,
    lastRunAt: null,
    updatedAt: "2026-08-19T12:00:00.000Z",
    createdAt: "2026-08-19T12:00:00.000Z",
    definition: { version: 1, nodes: [], edges: [] },
  };
  const renamed = {
    ...base,
    name: "Novo nome",
    description: "Nova descrição",
  };

  assert.equal(
    editableAutomationSignature(base),
    editableAutomationSignature(renamed),
  );
  assert.notEqual(
    automationMetadataSignature(base),
    automationMetadataSignature(renamed),
  );
});

test("nós exibem a configuração operacional mais importante no canvas", () => {
  const waitDefinition = defaultAutomationNodeCatalog.find(
    (item) => item.id === "flow.wait",
  );
  const statusDefinition = defaultAutomationNodeCatalog.find(
    (item) => item.id === "internal.update_status",
  );
  assert.ok(waitDefinition);
  assert.ok(statusDefinition);

  assert.equal(
    automationNodeConfigurationSummary(
      {
        id: "wait",
        type: "wait",
        position: { x: 0, y: 0 },
        config: { durationMs: 7 * 86_400_000, durationUnit: "days" },
      },
      waitDefinition,
    ),
    "7 dias",
  );
  assert.equal(
    automationNodeConfigurationSummary(
      {
        id: "archive",
        type: "internal_action",
        position: { x: 0, y: 0 },
        config: { actionId: "change_status", input: { status: "archived" } },
      },
      statusDefinition,
    ),
    "Arquivar ticket",
  );
  assert.equal(
    automationNodeConfigurationSummary(
      {
        id: "condition",
        type: "condition",
        position: { x: 0, y: 0 },
        config: { field: "status", operator: "equals", value: "triage" },
      },
      defaultAutomationNodeCatalog.find((item) => item.id === "flow.condition")!,
    ),
    "Status · É igual a · Em revisão",
  );
});

test("catálogo nunca oferece WhatsApp como ação de automação", () => {
  const appActions = defaultAutomationNodeCatalog.filter(
    (item) => item.category === "connected_app",
  );

  assert.ok(appActions.length > 0);
  assert.equal(
    appActions.some((item) =>
      `${item.id} ${item.label}`.toLocaleLowerCase("pt-BR").includes("whatsapp"),
    ),
    false,
  );
});

test("Intercom nativo fica disponível ao Threadmark AI sem expor uma ação incompleta no editor", () => {
  const catalog = catalogWithConnectedApps([{
    id: "intercom-1",
    type: "intercom",
    name: "Intercom do suporte",
    description: null,
    status: "active",
    aiEnabled: true,
    secretConfigured: true,
    endpointPreview: "https://api.intercom.io/",
    lastTestAt: null,
    lastTestSucceeded: true,
    updatedAt: "2026-08-20T12:00:00.000Z",
  }]);

  assert.equal(
    catalog.some((item) => item.id.includes("intercom") || item.baseConfig?.appId === "intercom"),
    false,
  );
});

test("catálogo transforma somente ferramentas MCP autorizadas em etapas configuráveis", () => {
  const catalog = catalogWithConnectedApps([{
    id: "mcp-1",
    type: "mcp_remote",
    name: "Projetos MCP",
    description: null,
    status: "active",
    aiEnabled: true,
    secretConfigured: true,
    endpointPreview: "https://mcp.example.com/mcp",
    lastTestAt: "2026-08-20T12:00:00.000Z",
    lastTestSucceeded: true,
    updatedAt: "2026-08-20T12:00:00.000Z",
    actions: [{
      id: "create_issue",
      name: "Criar issue",
      description: "Cria uma issue no projeto selecionado.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", title: "Título" },
          priority: { type: "string", enum: ["low", "high"] },
          notify: { type: "boolean", title: "Notificar" },
          metadata: { type: "object", title: "Metadados" },
        },
        required: ["title"],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      aiEnabled: true,
      automationEnabled: true,
      confirmationRequired: true,
    }, {
      id: "delete_issue",
      name: "Excluir issue",
      description: "Exclui uma issue.",
      automationEnabled: false,
    }, {
      id: "compound_action",
      name: "Ação composta",
      description: "Usa um schema composto.",
      inputSchema: { oneOf: [{ type: "object" }, { type: "object" }] },
      automationEnabled: true,
    }],
  }]);

  const node = catalog.find((item) => item.id === "app-connection.mcp-1.create_issue");
  assert.ok(node);
  assert.equal(node.baseConfig?.appId, "mcp-remote");
  assert.equal(node.baseConfig?.connectionId, "mcp-1");
  assert.equal(node.baseConfig?.actionId, "create_issue");
  assert.deepEqual(
    node.fields.map((field) => [field.key, field.type, field.required]),
    [
      ["input.title", "text", true],
      ["input.priority", "select", false],
      ["input.notify", "boolean", false],
      ["input.metadata", "textarea", false],
    ],
  );
  assert.equal(catalog.some((item) => item.id.includes("delete_issue")), false);
  assert.deepEqual(
    catalog.find((item) => item.id.includes("compound_action"))?.fields.map((field) => field.key),
    ["input.__argumentsJson"],
  );
});

test("espera aceita minutos, horas e dias sem alterar o formato do motor", () => {
  const wait = defaultAutomationNodeCatalog.find((item) => item.id === "flow.wait");
  assert.ok(wait);
  const duration = wait.fields.find((field) => field.key === "durationMs");
  assert.equal(duration?.type, "duration");
  assert.deepEqual(
    duration?.durationUnits?.map((unit) => [unit.value, unit.multiplier]),
    [
      ["minutes", 60_000],
      ["hours", 3_600_000],
      ["days", 86_400_000],
    ],
  );
  assert.deepEqual(initialNodeConfig(wait), {
    durationMs: 900_000,
    durationUnit: "minutes",
  });
});

test("alteração de status oferece arquivamento somente após resolução", () => {
  const status = defaultAutomationNodeCatalog.find(
    (item) => item.id === "internal.update_status",
  );
  assert.ok(status);
  const target = status.fields.find((field) => field.key === "input.status");
  assert.ok(target?.options?.some((option) => option.value === "archived"));
  assert.match(target?.description ?? "", /já esteja resolvido/i);
});

test("catálogo oferece notificação interna com destinatário e conteúdo configuráveis", () => {
  const push = defaultAutomationNodeCatalog.find(
    (item) => item.id === "internal.create_notification",
  );
  assert.ok(push);
  assert.equal(push.category, "internal_action");
  assert.equal(push.baseConfig?.actionId, "create_in_app_notification");
  assert.deepEqual(
    push.fields.map((field) => field.key),
    [
      "input.recipient",
      "input.title",
      "input.body",
      "input.targetUrl",
    ],
  );
  assert.equal(
    automationNodeCatalogId({
      type: "internal_action",
      config: initialNodeConfig(push),
    }),
    "internal.create_notification",
  );
  const personalized = catalogWithConnectedApps([], [
    { id: "operator-1", displayName: "Pessoa do suporte" },
  ]).find((item) => item.id === "internal.create_notification");
  assert.ok(
    personalized?.fields
      .find((field) => field.key === "input.recipient")
      ?.options?.some((option) => option.value === "user:operator-1"),
  );
  assert.deepEqual(
    push.fields
      .filter((field) => field.supportsVariables)
      .map((field) => field.key),
    ["input.title", "input.body", "input.targetUrl"],
  );
});

test("atribuição de responsável oferece os usuários ativos do Threadmark", () => {
  const catalog = catalogWithConnectedApps([], [
    { id: "user-owner", displayName: "Pessoa proprietária", role: "owner" },
    { id: "user-operator", displayName: "Pessoa operadora", role: "operator" },
  ]);
  const assignment = catalog.find((definition) => definition.id === "internal.assign");
  const assignee = assignment?.fields.find((field) => field.key === "input.assigneeId");

  assert.equal(assignee?.type, "select");
  assert.deepEqual(assignee?.options, [
    { label: "Pessoa proprietária · Proprietário", value: "user-owner" },
    { label: "Pessoa operadora · Operador", value: "user-operator" },
  ]);
});

test("distribuição por capacidade oferece limites individuais para a equipe", () => {
  const catalog = catalogWithConnectedApps([], [
    { id: "owner-user", displayName: "Pessoa Proprietária", role: "owner" },
    { id: "operator-user", displayName: "Pessoa Operadora", role: "operator" },
  ]);
  const capacity = catalog.find(
    (definition) => definition.id === "internal.assign_by_capacity",
  );
  const members = capacity?.fields.find((field) => field.key === "input.members");

  assert.equal(capacity?.baseConfig?.actionId, "assign_ticket_by_capacity");
  assert.equal(members?.type, "assignee_capacities");
  assert.deepEqual(members?.options, [
    { label: "Pessoa Proprietária · Proprietário", value: "owner-user" },
    { label: "Pessoa Operadora · Operador", value: "operator-user" },
  ]);
});

test("variável é inserida no cursor e substitui somente o texto selecionado", () => {
  assert.deepEqual(
    insertAutomationTemplateVariable(
      "Ticket aguarda responsável",
      "{{ticket.number}}",
      7,
      14,
    ),
    {
      cursor: 24,
      value: "Ticket {{ticket.number}} responsável",
    },
  );
  assert.deepEqual(
    insertAutomationTemplateVariable("Abrir ", "{{ticket.title}}"),
    {
      cursor: 22,
      value: "Abrir {{ticket.title}}",
    },
  );
});

test("condição de campo vazio não exige valor manual", () => {
  const trigger = defaultAutomationNodeCatalog.find((item) => item.id === "trigger.ticket")!;
  const push = defaultAutomationNodeCatalog.find((item) => item.id === "internal.create_notification")!;
  const definition: AutomationDefinition = {
    version: 1,
    nodes: [
      { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, config: initialNodeConfig(trigger) },
      {
        id: "condition",
        type: "condition",
        position: { x: 0, y: 180 },
        config: { field: "assignee", operator: "not_exists" },
      },
      { id: "push", type: "internal_action", position: { x: 0, y: 360 }, config: initialNodeConfig(push) },
    ],
    edges: [
      { id: "one", source: "trigger", target: "condition" },
      { id: "two", source: "condition", target: "push", sourceHandle: "true" },
    ],
  };

  const issues = validateAutomation(definition, defaultAutomationNodeCatalog);
  assert.equal(issues.some((issue) => issue.id === "field-condition-value"), false);
});

test("catálogo concentra os eventos operacionais em um único nó de ticket", () => {
  const expectedTriggers = [
    "ticket_created",
    "message_attached",
    "priority_changed",
    "status_changed",
    "ticket_entered_triage",
    "ticket_entered_in_progress",
    "ticket_waiting_customer",
    "ticket_waiting_internal",
    "ticket_resolved",
    "ticket_cancelled",
    "ticket_archived",
    "ticket_assigned",
    "ticket_unassigned",
    "ticket_category_added",
    "ticket_category_removed",
  ];

  const configuredTriggers = defaultAutomationNodeCatalog.filter(
    (item) => item.category === "trigger",
  );
  const ticketTrigger = configuredTriggers[0];
  const eventField = ticketTrigger?.fields.find((field) => field.key === "eventType");

  assert.equal(configuredTriggers.length, 1);
  assert.equal(ticketTrigger?.id, "trigger.ticket");
  assert.deepEqual(eventField?.options?.map((option) => option.value), expectedTriggers);
  assert.equal(
    automationNodeCatalogId({ type: "trigger", config: { eventType: "ticket_cancelled" } }),
    "trigger.ticket",
  );
});

test("catálogo cria uma ação para cada instância ativa de app conectado", () => {
  const catalog = catalogWithConnectedApps([
    {
      id: "support-alerts",
      type: "slack_webhook",
      name: "Alertas do suporte",
      description: null,
      status: "active",
      aiEnabled: false,
      secretConfigured: true,
      endpointPreview: "https://hooks.slack.com/••••",
      lastTestAt: null,
      lastTestSucceeded: null,
      updatedAt: "2026-08-18T12:00:00.000Z",
    },
    {
      id: "disabled-api",
      type: "custom_http",
      name: "API pausada",
      description: null,
      status: "disabled",
      aiEnabled: false,
      secretConfigured: true,
      endpointPreview: "https://example.com/••••",
      lastTestAt: null,
      lastTestSucceeded: null,
      updatedAt: "2026-08-18T12:00:00.000Z",
    },
  ]);

  const slack = catalog.find((item) => item.id.includes("support-alerts"));
  assert.ok(slack);
  assert.equal(slack.connected, true);
  assert.equal(slack.baseConfig?.connectionId, "support-alerts");
  assert.equal(catalog.some((item) => item.id.includes("disabled-api")), false);
});

test("validação bloqueia fluxo vazio, campos obrigatórios e ciclos", () => {
  const emptyIssues = validateAutomation({ version: 1, nodes: [], edges: [] }, defaultAutomationNodeCatalog);
  assert.equal(emptyIssues.some((issue) => issue.id === "empty-flow"), true);

  const triggerDefinition = defaultAutomationNodeCatalog.find((item) => item.id === "trigger.ticket");
  const noteDefinition = defaultAutomationNodeCatalog.find((item) => item.id === "internal.add_note");
  assert.ok(triggerDefinition);
  assert.ok(noteDefinition);

  const definition: AutomationDefinition = {
    version: 1,
    nodes: [
      {
        id: "trigger",
        type: triggerDefinition.nodeType,
        position: { x: 0, y: 0 },
        config: initialNodeConfig(triggerDefinition),
      },
      {
        id: "note",
        type: noteDefinition.nodeType,
        position: { x: 0, y: 180 },
        config: initialNodeConfig(noteDefinition),
      },
    ],
    edges: [
      { id: "one", source: "trigger", target: "note" },
      { id: "two", source: "note", target: "trigger" },
    ],
  };

  assert.equal(automationNodeCatalogId(definition.nodes[1]!), "internal.add_note");
  const issues = validateAutomation(definition, defaultAutomationNodeCatalog);
  assert.equal(issues.some((issue) => issue.id === "field-note-input.body"), true);
  assert.equal(issues.some((issue) => issue.id === "cycle-trigger"), true);
  assert.equal(issues.some((issue) => issue.id === "cycle-note"), true);
});

test("validação impede ativar um fluxo sem ação", () => {
  const issues = validateAutomation(
    {
      version: 1,
      nodes: [
        {
          id: "trigger-only",
          type: "trigger",
          position: { x: 0, y: 0 },
          config: { eventType: "ticket_created" },
        },
      ],
      edges: [],
    },
    defaultAutomationNodeCatalog,
  );
  assert.ok(issues.some((issue) => issue.id === "action-count" && issue.severity === "error"));
});

test("fluxo mínimo configurado não possui erro impeditivo", () => {
  const catalog = defaultAutomationNodeCatalog.filter(
    (item) => item.category !== "connected_app",
  );
  const triggerDefinition = catalog.find((item) => item.id === "trigger.ticket")!;
  const priorityDefinition = catalog.find((item) => item.id === "internal.update_priority")!;
  const definition: AutomationDefinition = {
    version: 1,
    nodes: [
      {
        id: "trigger",
        type: "trigger",
        position: { x: 0, y: 0 },
        config: initialNodeConfig(triggerDefinition),
      },
      {
        id: "priority",
        type: "internal_action",
        position: { x: 0, y: 180 },
        config: initialNodeConfig(priorityDefinition),
      },
    ],
    edges: [{ id: "edge", source: "trigger", target: "priority" }],
  };

  const issues = validateAutomation(definition, catalog);
  assert.deepEqual(issues.filter((issue) => issue.severity === "error"), []);
});
