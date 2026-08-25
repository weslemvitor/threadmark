import { createHash } from "node:crypto";

import { z } from "zod";

import type { AuthRole } from "../../shared/contracts.js";
import {
  AutomationStore,
  validateWorkflowDefinition,
  type AutomationNode,
  type AutomationWorkflow,
  type AutomationWorkflowDefinition,
} from "../automations/index.js";
import type { SupportDatabase } from "../db/index.js";
import type { ConnectedAppService } from "../integrations/index.js";
import type {
  InvestigationToolDescriptor,
  InvestigationToolRequest,
  InvestigationToolResult,
} from "../agent/types.js";

export const THREADMARK_AUTOMATIONS_TOOL_ID = "threadmark-automations";

const TOOL_NAME = "Automações do Threadmark";
const MAX_RESULT_BYTES = 80_000;
const MUTATION_ROLES = new Set<AuthRole>(["owner", "admin"]);
const WORKFLOW_STATUSES = ["draft", "active", "paused", "archived"] as const;
const TRIGGER_EVENTS = [
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
] as const;
const CONDITION_FIELDS = ["priority", "status", "category", "assignee"] as const;
const INTERNAL_ACTIONS = [
  "assign_ticket",
  "assign_ticket_by_capacity",
  "change_priority",
  "change_status",
  "add_internal_note",
  "create_in_app_notification",
] as const;
const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
const TICKET_STATUSES = [
  "triage",
  "in_progress",
  "waiting_customer",
  "blocked",
  "cancelled",
  "archived",
] as const;

const workflowDefinitionSchema = z.object({
  nodes: z.array(z.unknown()).max(100),
  edges: z.array(z.unknown()).max(200),
}).strict();

const listSchema = z.object({
  status: z.enum(WORKFLOW_STATUSES).optional(),
  query: z.string().trim().max(200).optional(),
  limit: z.number().int().min(1).max(100).default(30),
}).strict();

const getSchema = z.object({ automationId: z.string().trim().min(1).max(200) }).strict();

const testSchema = getSchema;

const prepareSchema = z.object({
  operatorMessageId: z.string().trim().min(1).max(200),
  automationId: z.string().trim().min(1).max(200).nullable().optional(),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1_000).nullable().optional(),
  definition: workflowDefinitionSchema,
}).strict();

const applySchema = z.object({
  confirmationMessageId: z.string().trim().min(1).max(200),
  draftId: z.string().trim().min(1).max(200),
}).strict();

const statusSchema = z.object({
  confirmationMessageId: z.string().trim().min(1).max(200),
  automationId: z.string().trim().min(1).max(200),
  status: z.enum(["active", "paused"]),
}).strict();

const deleteSchema = z.object({
  confirmationMessageId: z.string().trim().min(1).max(200),
  automationId: z.string().trim().min(1).max(200),
}).strict();

interface OperatorIdentity {
  messageId: string;
  messageOrder: number;
  threadId: string;
  actor: string;
  role: AuthRole;
  body: string;
}

interface AutomationDraftRow {
  id: string;
  thread_id: string;
  operator_message_id: string;
  intent: "create" | "update";
  target_workflow_id: string | null;
  name: string;
  description: string | null;
  definition_json: string;
  base_updated_at: string | null;
  state: "pending" | "applied";
  applied_workflow_id: string | null;
}

export class ThreadmarkAutomationTool {
  private readonly workflows: AutomationStore;

  constructor(
    private readonly database: SupportDatabase,
    private readonly connectedApps: ConnectedAppService | null,
  ) {
    this.workflows = new AutomationStore(database);
  }

  descriptor(): InvestigationToolDescriptor {
    return {
      id: THREADMARK_AUTOMATIONS_TOOL_ID,
      name: TOOL_NAME,
      type: "knowledge",
      description:
        "Consulta, valida e prepara fluxos internos. Escritas exigem proprietário/admin e confirmação explícita em duas etapas.",
      scope:
        "Automações persistidas no SQLite local. Nunca envia WhatsApp; testes são dry-run e não executam ações.",
      operations: [
        {
          name: "get_automation_capabilities",
          description: "Lista gatilhos, condições, ações, usuários e apps realmente disponíveis.",
          argumentsExample: "{}",
        },
        {
          name: "list_automations",
          description: "Lista automações existentes, com status e identificadores reais.",
          argumentsExample: '{"status":"active","query":"SLA","limit":30}',
        },
        {
          name: "get_automation",
          description: "Carrega a definição atual de uma automação pelo ID.",
          argumentsExample: '{"automationId":"<id encontrado>"}',
        },
        {
          name: "test_automation",
          description: "Valida a automação em dry-run sem disparar ações nem persistir execução.",
          argumentsExample: '{"automationId":"<id encontrado>"}',
        },
        {
          name: "prepare_automation_draft",
          description:
            "Valida e persiste uma proposta completa de criação ou edição, sem alterar a automação real.",
          argumentsExample:
            '{"operatorMessageId":"<currentOperatorMessageId>","automationId":null,"name":"Nome","description":"Objetivo","definition":{"nodes":[],"edges":[]}}',
        },
        {
          name: "apply_automation_draft",
          description:
            "Aplica uma proposta já apresentada. Exige uma mensagem posterior confirmando explicitamente.",
          argumentsExample:
            '{"confirmationMessageId":"<currentOperatorMessageId>","draftId":"<id apresentado>"}',
        },
        {
          name: "set_automation_status",
          description: "Ativa ou pausa uma automação existente com confirmação explícita atual.",
          argumentsExample:
            '{"confirmationMessageId":"<currentOperatorMessageId>","automationId":"<id>","status":"active"}',
        },
        {
          name: "delete_automation",
          description:
            "Exclui uma automação sem histórico ou arquiva quando há execuções auditáveis. Exige confirmação explícita atual.",
          argumentsExample:
            '{"confirmationMessageId":"<currentOperatorMessageId>","automationId":"<id>"}',
        },
      ],
    };
  }

  execute(request: InvestigationToolRequest, executedAt: string): InvestigationToolResult {
    try {
      const raw = JSON.parse(request.argumentsJson) as unknown;
      switch (request.operation) {
        case "get_automation_capabilities":
          z.object({}).strict().parse(raw);
          return this.success(request, this.capabilities(), "Capacidades reais de automação carregadas.", executedAt);
        case "list_automations":
          return this.list(request, listSchema.parse(raw), executedAt);
        case "get_automation":
          return this.get(request, getSchema.parse(raw), executedAt);
        case "test_automation":
          return this.test(request, testSchema.parse(raw), executedAt);
        case "prepare_automation_draft":
          return this.prepare(request, prepareSchema.parse(raw), executedAt);
        case "apply_automation_draft":
          return this.apply(request, applySchema.parse(raw), executedAt);
        case "set_automation_status":
          return this.setStatus(request, statusSchema.parse(raw), executedAt);
        case "delete_automation":
          return this.delete(request, deleteSchema.parse(raw), executedAt);
        default:
          throw new Error("Operação de automação não autorizada.");
      }
    } catch (error) {
      return this.failure(request, safeMessage(error), executedAt);
    }
  }

  private capabilities() {
    const apps = (this.connectedApps?.list() ?? [])
      .filter((app) => app.status === "active" && app.aiEnabled && app.type !== "intercom")
      .map((app) => ({
        appId: app.id,
        name: app.name,
        type: app.type,
        actions: app.type === "slack_webhook"
          ? ["send_message"]
          : app.type === "mcp_remote"
            ? app.mcpTools
                .filter((tool) => tool.automationEnabled)
                .map((tool) => ({
                  actionId: tool.name,
                  name: tool.title,
                  description: tool.description,
                  inputSchema: tool.inputSchema,
                }))
            : ["request"],
      }));
    const users = this.database.prepare(`
      SELECT id, display_name, role
      FROM local_users
      WHERE active = 1
      ORDER BY display_name COLLATE NOCASE, id
    `).all() as Array<{ id: string; display_name: string; role: AuthRole }>;
    return {
      triggers: TRIGGER_EVENTS,
      conditions: {
        fields: CONDITION_FIELDS,
        operators: ["equals", "not_equals", "contains", "exists", "not_exists"],
      },
      internalActions: [
        { actionId: "assign_ticket", input: { assigneeId: "<active-user-id>" } },
        {
          actionId: "assign_ticket_by_capacity",
          input: {
            members: [{ assigneeId: "<active-user-id>", maxTickets: 5 }],
          },
          behavior: "menor ocupação proporcional, fila FIFO quando todos atingirem o limite",
        },
        { actionId: "change_priority", input: { priority: PRIORITIES } },
        { actionId: "change_status", input: { status: TICKET_STATUSES } },
        { actionId: "add_internal_note", input: { body: "texto com variáveis opcionais" } },
        {
          actionId: "create_in_app_notification",
          input: { recipient: "assignee | all | user:<active-user-id>", title: "texto", body: "texto", targetUrl: "caminho opcional" },
        },
      ],
      users: users.map((user) => ({ id: user.id, name: user.display_name, role: user.role })),
      connectedApps: apps,
      constraints: {
        exactlyOneTrigger: true,
        requiresAction: true,
        whatsappOutbound: "proibido",
        mutations: "somente owner/admin com confirmação explícita",
      },
    };
  }

  private list(
    request: InvestigationToolRequest,
    args: z.infer<typeof listSchema>,
    executedAt: string,
  ): InvestigationToolResult {
    const query = args.query?.toLocaleLowerCase("pt-BR") ?? "";
    const items = this.workflows
      .listWorkflows(args.status)
      .filter((workflow) => !query || `${workflow.name} ${workflow.description ?? ""}`.toLocaleLowerCase("pt-BR").includes(query))
      .slice(0, args.limit)
      .map(workflowSummary);
    return this.success(request, { items }, `${items.length} automação(ões) encontrada(s).`, executedAt);
  }

  private get(
    request: InvestigationToolRequest,
    args: z.infer<typeof getSchema>,
    executedAt: string,
  ): InvestigationToolResult {
    const workflow = this.workflows.getWorkflow(args.automationId);
    return this.success(request, workflow, `Automação “${workflow.name}” carregada.`, executedAt);
  }

  private test(
    request: InvestigationToolRequest,
    args: z.infer<typeof testSchema>,
    executedAt: string,
  ): InvestigationToolResult {
    const workflow = this.workflows.getWorkflow(args.automationId);
    this.validateDefinition(workflow.definition);
    const steps = orderedNodes(workflow.definition).map((node, index) => ({
      order: index + 1,
      nodeId: node.id,
      type: node.type,
      name: node.name ?? nodeLabel(node),
      result: "validado_sem_executar",
    }));
    return this.success(
      request,
      { dryRun: true, automation: workflowSummary(workflow), steps },
      `Dry-run concluído: ${steps.length} etapa(s) validadas sem executar ações.`,
      executedAt,
    );
  }

  private prepare(
    request: InvestigationToolRequest,
    args: z.infer<typeof prepareSchema>,
    executedAt: string,
  ): InvestigationToolResult {
    const operator = this.requireMutationOperator(args.operatorMessageId);
    const definition = structuredClone(args.definition) as AutomationWorkflowDefinition;
    this.validateDefinition(definition);
    const target = args.automationId ? this.workflows.getWorkflow(args.automationId) : null;
    if (target?.status === "archived") throw new Error("Uma automação arquivada não pode ser editada.");
    const intent = target ? "update" : "create";
    const fingerprint = JSON.stringify({
      threadId: operator.threadId,
      operatorMessageId: args.operatorMessageId,
      targetId: target?.id ?? null,
      name: args.name,
      description: args.description ?? null,
      definition,
      baseUpdatedAt: target?.updatedAt ?? null,
    });
    const draftId = `threadmark-ai-automation:${createHash("sha256").update(fingerprint).digest("hex").slice(0, 32)}`;
    this.database.prepare(`
      INSERT OR IGNORE INTO threadmark_ai_automation_drafts (
        id, thread_id, operator_message_id, intent, target_workflow_id,
        name, description, definition_json, base_updated_at, state,
        applied_workflow_id, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?)
    `).run(
      draftId,
      operator.threadId,
      args.operatorMessageId,
      intent,
      target?.id ?? null,
      args.name,
      args.description ?? null,
      JSON.stringify(definition),
      target?.updatedAt ?? null,
      operator.actor,
      executedAt,
      executedAt,
    );
    return this.success(
      request,
      {
        draftId,
        intent,
        target: target ? workflowSummary(target) : null,
        preview: { name: args.name, description: args.description ?? null, definition },
        confirmationRequired:
          "Apresente esta proposta e aguarde uma nova mensagem do operador confirmando explicitamente antes de aplicar.",
      },
      `Proposta de ${intent === "create" ? "criação" : "edição"} validada; a automação real não foi alterada.`,
      executedAt,
    );
  }

  private apply(
    request: InvestigationToolRequest,
    args: z.infer<typeof applySchema>,
    executedAt: string,
  ): InvestigationToolResult {
    const operator = this.requireMutationOperator(args.confirmationMessageId);
    if (!explicitApplyConfirmation(operator.body)) {
      throw new Error("A mensagem atual não confirma explicitamente a aplicação da proposta de automação.");
    }
    const draft = this.database.prepare(`
      SELECT * FROM threadmark_ai_automation_drafts WHERE id = ?
    `).get(args.draftId) as AutomationDraftRow | undefined;
    if (!draft || draft.thread_id !== operator.threadId) {
      throw new Error("A proposta não pertence a esta conversa do Threadmark AI.");
    }
    const sourceMessage = this.database.prepare(`
      SELECT rowid AS message_order
      FROM investigation_thread_messages
      WHERE id = ?
    `).get(draft.operator_message_id) as { message_order: number } | undefined;
    if (
      !sourceMessage ||
      operator.messageId === draft.operator_message_id ||
      operator.messageOrder <= sourceMessage.message_order
    ) {
      throw new Error("A confirmação precisa ser enviada depois da apresentação da proposta.");
    }
    if (draft.state === "applied" && draft.applied_workflow_id) {
      const existing = this.workflows.getWorkflow(draft.applied_workflow_id);
      return this.success(request, { idempotent: true, workflow: existing }, "A proposta já havia sido aplicada.", executedAt);
    }
    const definition = JSON.parse(draft.definition_json) as AutomationWorkflowDefinition;
    this.validateDefinition(definition);
    let workflow: AutomationWorkflow;
    if (draft.intent === "create") {
      workflow = this.workflows.createWorkflow({
        name: draft.name,
        description: draft.description,
        definition,
        actor: operator.actor,
      });
    } else {
      if (!draft.target_workflow_id || !draft.base_updated_at) throw new Error("Proposta de edição incompleta.");
      const current = this.workflows.getWorkflow(draft.target_workflow_id);
      if (current.updatedAt !== draft.base_updated_at) {
        throw new Error("A automação foi alterada depois da proposta. Gere uma nova prévia antes de salvar.");
      }
      workflow = this.workflows.updateWorkflow(current.id, {
        name: draft.name,
        description: draft.description,
        definition,
        actor: operator.actor,
      });
    }
    this.database.prepare(`
      UPDATE threadmark_ai_automation_drafts
      SET state = 'applied', applied_workflow_id = ?, updated_at = ?
      WHERE id = ? AND state = 'pending'
    `).run(workflow.id, executedAt, draft.id);
    return this.success(
      request,
      { idempotent: false, workflow },
      `Automação “${workflow.name}” ${draft.intent === "create" ? "criada como rascunho" : "atualizada"}.`,
      executedAt,
    );
  }

  private setStatus(
    request: InvestigationToolRequest,
    args: z.infer<typeof statusSchema>,
    executedAt: string,
  ): InvestigationToolResult {
    const operator = this.requireMutationOperator(args.confirmationMessageId);
    if (!explicitStatusConfirmation(operator.body, args.status)) {
      throw new Error(`A mensagem atual não confirma explicitamente ${args.status === "active" ? "a ativação" : "a pausa"} da automação.`);
    }
    const current = this.workflows.getWorkflow(args.automationId);
    if (args.status === "active") this.validateDefinition(current.definition);
    const workflow = this.workflows.setWorkflowStatus(current.id, args.status, operator.actor);
    return this.success(request, workflowSummary(workflow), `Automação “${workflow.name}” ${args.status === "active" ? "ativada" : "pausada"}.`, executedAt);
  }

  private delete(
    request: InvestigationToolRequest,
    args: z.infer<typeof deleteSchema>,
    executedAt: string,
  ): InvestigationToolResult {
    const operator = this.requireMutationOperator(args.confirmationMessageId);
    if (!explicitDeleteConfirmation(operator.body)) {
      throw new Error("A mensagem atual não confirma explicitamente a exclusão da automação.");
    }
    const workflow = this.workflows.getWorkflow(args.automationId);
    const result = this.workflows.deleteWorkflow(workflow.id, operator.actor);
    return this.success(
      request,
      { automationId: workflow.id, name: workflow.name, ...result },
      result.deleted
        ? `Automação “${workflow.name}” excluída definitivamente.`
        : `Automação “${workflow.name}” arquivada porque possui histórico de execução.`,
      executedAt,
    );
  }

  private validateDefinition(definition: AutomationWorkflowDefinition): void {
    validateWorkflowDefinition(definition);
    for (const node of definition.nodes) this.validateNode(node);
  }

  private validateNode(node: AutomationNode): void {
    if (node.type === "trigger" && !TRIGGER_EVENTS.includes(node.config.eventType as typeof TRIGGER_EVENTS[number])) {
      throw new Error(`Gatilho não suportado: ${node.config.eventType}.`);
    }
    if (node.type === "condition" && !CONDITION_FIELDS.includes(node.config.field as typeof CONDITION_FIELDS[number])) {
      throw new Error(`Campo de condição não suportado: ${node.config.field}.`);
    }
    if (node.type === "internal_action") {
      if (!INTERNAL_ACTIONS.includes(node.config.actionId as typeof INTERNAL_ACTIONS[number])) {
        throw new Error(`Ação interna não suportada: ${node.config.actionId}.`);
      }
      const input = node.config.input ?? {};
      if (node.config.actionId === "assign_ticket") {
        const assigneeId = requiredString(input.assigneeId, "assigneeId");
        const user = this.database.prepare("SELECT active FROM local_users WHERE id = ?").get(assigneeId) as { active: number } | undefined;
        if (!user?.active) throw new Error("O responsável escolhido não é um usuário ativo do Threadmark.");
      }
      if (node.config.actionId === "assign_ticket_by_capacity") {
        const members = input.members;
        if (!Array.isArray(members) || members.length === 0) {
          throw new Error("Selecione ao menos um usuário para a distribuição por capacidade.");
        }
        const seen = new Set<string>();
        for (const member of members) {
          if (!member || Array.isArray(member) || typeof member !== "object") {
            throw new Error("A capacidade da equipe é inválida.");
          }
          const assigneeId = requiredString(member.assigneeId, "assigneeId");
          const maxTickets = Number(member.maxTickets);
          if (seen.has(assigneeId)) throw new Error("Um usuário aparece mais de uma vez na capacidade.");
          seen.add(assigneeId);
          if (!Number.isInteger(maxTickets) || maxTickets < 1 || maxTickets > 500) {
            throw new Error("O limite de tickets precisa estar entre 1 e 500.");
          }
          const user = this.database.prepare(
            "SELECT active FROM local_users WHERE id = ?",
          ).get(assigneeId) as { active: number } | undefined;
          if (!user?.active) {
            throw new Error("Todos os responsáveis da capacidade precisam estar ativos.");
          }
        }
      }
      if (node.config.actionId === "change_priority" && !PRIORITIES.includes(input.priority as typeof PRIORITIES[number])) {
        throw new Error("A prioridade da automação é inválida.");
      }
      if (node.config.actionId === "change_status" && !TICKET_STATUSES.includes(input.status as typeof TICKET_STATUSES[number])) {
        throw new Error("O status da automação é inválido.");
      }
      if (node.config.actionId === "add_internal_note") requiredString(input.body, "body");
    }
    if (node.type === "app_action") {
      const app = this.connectedApps?.get(node.config.appId);
      if (!app || app.status !== "active") throw new Error("O app conectado da automação não está ativo.");
      if (!app.aiEnabled) {
        throw new Error(`O app ${app.name} não está autorizado para ações solicitadas pelo Threadmark AI.`);
      }
      if (app.type === "intercom") throw new Error("O Intercom ainda não está disponível como nó de automação.");
      if (app.type === "mcp_remote") {
        const tool = app.mcpTools.find(
          (candidate) =>
            candidate.name === node.config.actionId && candidate.automationEnabled,
        );
        if (!tool) throw new Error(`A ação ${node.config.actionId} não foi autorizada no app ${app.name}.`);
      } else {
        const expected = app.type === "slack_webhook" ? "send_message" : "request";
        if (node.config.actionId !== expected) throw new Error(`A ação ${node.config.actionId} não pertence ao app ${app.name}.`);
      }
    }
  }

  private requireMutationOperator(messageId: string): OperatorIdentity {
    const row = this.database.prepare(`
      SELECT message.id, message.rowid AS message_order,
             message.thread_id, message.body,
             message.actor_user_id, message.actor_role,
             COALESCE(user.display_name, thread.created_by, 'Operador local') AS actor,
             user.role AS current_role, user.active AS user_active
      FROM investigation_thread_messages message
      JOIN investigation_threads thread ON thread.id = message.thread_id
      LEFT JOIN local_users user ON user.id = message.actor_user_id
      WHERE message.id = ? AND message.role = 'operator' AND thread.scope = 'workspace'
    `).get(messageId) as {
      id: string;
      message_order: number;
      thread_id: string;
      body: string;
      actor_user_id: string | null;
      actor_role: AuthRole | null;
      actor: string;
      current_role: AuthRole | null;
      user_active: number | null;
    } | undefined;
    if (!row) throw new Error("A confirmação não pertence ao Threadmark AI.");
    if (row.actor_user_id && row.user_active !== 1) throw new Error("O usuário que solicitou a ação não está ativo.");
    const role = row.current_role ?? row.actor_role;
    if (!role || !MUTATION_ROLES.has(role)) {
      throw new Error("Somente proprietário ou administrador pode alterar automações pelo Threadmark AI.");
    }
    return {
      messageId: row.id,
      messageOrder: row.message_order,
      threadId: row.thread_id,
      actor: row.actor,
      role,
      body: row.body,
    };
  }

  private success(
    request: InvestigationToolRequest,
    value: unknown,
    summary: string,
    executedAt: string,
  ): InvestigationToolResult {
    return {
      requestId: request.requestId,
      toolId: THREADMARK_AUTOMATIONS_TOOL_ID,
      toolName: TOOL_NAME,
      operation: request.operation,
      argumentsJson: request.argumentsJson,
      purpose: request.purpose,
      status: "success",
      summary,
      content: boundedJson(value),
      reference: `tool:${THREADMARK_AUTOMATIONS_TOOL_ID}:${request.operation}:request:${encodeURIComponent(request.requestId)}`,
      executedAt,
    };
  }

  private failure(
    request: InvestigationToolRequest,
    message: string,
    executedAt: string,
  ): InvestigationToolResult {
    return {
      requestId: request.requestId,
      toolId: THREADMARK_AUTOMATIONS_TOOL_ID,
      toolName: TOOL_NAME,
      operation: request.operation,
      argumentsJson: request.argumentsJson,
      purpose: request.purpose,
      status: "error",
      summary: message,
      content: message,
      reference: null,
      executedAt,
    };
  }
}

function workflowSummary(workflow: AutomationWorkflow) {
  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    status: workflow.status,
    nodeCount: workflow.definition.nodes.length,
    updatedAt: workflow.updatedAt,
  };
}

function orderedNodes(definition: AutomationWorkflowDefinition): AutomationNode[] {
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]));
  const incoming = new Map(definition.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of definition.edges) {
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
  }
  const queue = definition.nodes.filter((node) => incoming.get(node.id) === 0).map((node) => node.id);
  const ordered: AutomationNode[] = [];
  while (queue.length) {
    const nodeId = queue.shift()!;
    const node = nodes.get(nodeId);
    if (node) ordered.push(node);
    for (const target of outgoing.get(nodeId) ?? []) {
      incoming.set(target, (incoming.get(target) ?? 1) - 1);
      if (incoming.get(target) === 0) queue.push(target);
    }
  }
  return ordered.length === definition.nodes.length ? ordered : definition.nodes;
}

function nodeLabel(node: AutomationNode): string {
  if (node.type === "trigger") return `Gatilho: ${node.config.eventType}`;
  if (node.type === "condition") return `Condição: ${node.config.field}`;
  if (node.type === "wait") return `Esperar ${node.config.durationMs} ms`;
  if (node.type === "approval") return "Aprovação humana";
  return node.config.actionId;
}

function explicitApplyConfirmation(message: string): boolean {
  const value = normalize(message);
  return /\b(confirmo|pode|quero)\b/.test(value) && /\b(criar|crie|salvar|salve|aplicar|aplique|atualizar|atualize)\b/.test(value) && /\b(automacao|fluxo|proposta)\b/.test(value);
}

function explicitStatusConfirmation(message: string, status: "active" | "paused"): boolean {
  const value = normalize(message);
  const action = status === "active" ? /\b(ativar|ative|ativa|ligar|ligue)\b/ : /\b(pausar|pause|pausa|desativar|desative)\b/;
  return action.test(value) && /\b(automacao|fluxo)\b/.test(value);
}

function explicitDeleteConfirmation(message: string): boolean {
  const value = normalize(message);
  return /\b(excluir|exclua|deletar|delete|apagar|apague)\b/.test(value) && /\b(automacao|fluxo)\b/.test(value);
}

function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR");
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Informe ${field}.`);
  return value.trim();
}

function safeMessage(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map((issue) => issue.message).join("; ");
  return error instanceof Error ? error.message : "A operação de automação falhou.";
}

function boundedJson(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2);
  const bytes = Buffer.from(serialized, "utf8");
  if (bytes.byteLength <= MAX_RESULT_BYTES) return serialized;
  return `${bytes.subarray(0, MAX_RESULT_BYTES).toString("utf8")}\n[resultado truncado]`;
}
