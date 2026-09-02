import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { SupportDatabase } from "../db/index.js";
import {
  validateWorkflowDefinition,
  type AutomationEdge,
  type AutomationNode,
  type AutomationRun,
  type AutomationWorkflow,
  type AutomationWorkflowDefinition,
} from "../automations/index.js";
import type {
  ConnectedAppDto,
  ConnectedAppType,
  ConnectedAppWriteInput,
} from "../integrations/index.js";
import { AutomationRuntime } from "./index.js";

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1_000).nullable().optional(),
}).strict();

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1_000).nullable(),
  definition: z.object({
    version: z.number().int().positive().optional(),
    nodes: z.array(z.unknown()).max(100),
    edges: z.array(z.unknown()).max(200),
  }).passthrough(),
}).strict();

const layoutSchema = z.object({
  nodes: z.array(z.object({
    id: z.string().trim().min(1).max(200),
    position: z.object({
      x: z.number().finite(),
      y: z.number().finite(),
    }).strict(),
  }).strict()).max(100),
}).strict();

const metadataSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1_000).nullable(),
}).strict();

const connectedAppSchema = z.object({
  type: z.enum(["slack_webhook", "intercom", "custom_http", "mcp_remote"]),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1_000).nullable().optional(),
  enabled: z.boolean().default(true),
  aiEnabled: z.boolean().optional(),
  endpoint: z.string().trim().max(2_000),
  secret: z.string().trim().max(16_384).optional(),
  headers: z.record(z.string(), z.string().max(8_192)).optional(),
  allowPrivateNetwork: z.boolean().optional(),
  mcpTools: z.array(z.object({
    name: z.string().trim().min(1).max(200),
    aiEnabled: z.boolean(),
    automationEnabled: z.boolean(),
    confirmationRequired: z.boolean(),
  }).strict()).max(200).optional(),
}).strict();

const decisionSchema = z.object({
  approved: z.boolean(),
  note: z.string().trim().max(1_000).optional(),
}).strict();

type ExecutionRow = {
  run: AutomationRun;
  workflow: AutomationWorkflow;
  stepStatuses: Array<{ status: string; node_id: string; error: string | null }>;
};

type DryRunStep = {
  nodeId: string;
  nodeType: AutomationNode["type"];
  label: string;
  status: "passed";
  detail: string;
};

export class AutomationApiError extends Error {
  constructor(
    message: string,
    readonly kind: "invalid" | "not_found" | "conflict" = "invalid",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AutomationApiError";
  }
}

export class AutomationApiService {
  constructor(
    private readonly database: SupportDatabase,
    readonly runtime: AutomationRuntime,
  ) {}

  listAutomations() {
    return {
      items: this.runtime.workflows
        .listWorkflows()
        .filter((workflow) => workflow.status !== "archived")
        .map((workflow) => this.summary(workflow)),
    };
  }

  createAutomation(input: unknown, actor: string) {
    const parsed = createSchema.parse(input);
    const workflow = this.runtime.workflows.createWorkflow({
      name: parsed.name,
      description: parsed.description ?? null,
      definition: { nodes: [], edges: [] },
      actor,
    });
    return this.detail(workflow);
  }

  getAutomation(id: string) {
    return this.detail(this.getWorkflow(id));
  }

  updateAutomation(id: string, input: unknown, actor: string) {
    const parsed = updateSchema.parse(input);
    const workflow = this.runtime.workflows.updateWorkflow(id, {
      name: parsed.name,
      description: parsed.description,
      definition: normalizeDefinition(parsed.definition, this.runtime),
      actor,
    });
    return this.detail(workflow);
  }

  updateAutomationLayout(id: string, input: unknown, actor: string) {
    const parsed = layoutSchema.parse(input);
    const positions = Object.fromEntries(
      parsed.nodes.map((node) => [node.id, node.position]),
    );
    return this.detail(
      this.runtime.workflows.updateWorkflowLayout(id, positions, actor),
    );
  }

  updateAutomationMetadata(id: string, input: unknown, actor: string) {
    const parsed = metadataSchema.parse(input);
    return this.detail(
      this.runtime.workflows.updateWorkflowMetadata(id, parsed, actor),
    );
  }

  deleteAutomation(id: string, actor: string) {
    this.getWorkflow(id);
    this.runtime.workflows.deleteWorkflow(id, actor);
    return { deleted: true as const, id };
  }

  activateAutomation(id: string, actor: string) {
    const workflow = this.getWorkflow(id);
    validateWorkflowDefinition(workflow.definition);
    validateConnectedApps(workflow.definition, this.runtime);
    return this.summary(this.runtime.workflows.setWorkflowStatus(id, "active", actor));
  }

  pauseAutomation(id: string, actor: string) {
    this.getWorkflow(id);
    return this.summary(this.runtime.workflows.setWorkflowStatus(id, "paused", actor));
  }

  testAutomation(id: string) {
    const workflow = this.getWorkflow(id);
    validateWorkflowDefinition(workflow.definition);
    validateConnectedApps(workflow.definition, this.runtime);
    const steps = buildDryRunSteps(workflow);
    const timestamp = new Date().toISOString();
    const trigger = workflow.definition.nodes.find((node) => node.type === "trigger");
    return {
      id: `dry-run:${randomUUID()}`,
      automationId: workflow.id,
      status: "completed" as const,
      triggerLabel: trigger?.name || trigger?.config.eventType || "Execução manual",
      currentNodeLabel: "Validação segura concluída, sem executar ações",
      startedAt: timestamp,
      finishedAt: timestamp,
      error: null,
      stepsCompleted: steps.length,
      stepsTotal: workflow.definition.nodes.length,
      dryRun: true,
      steps,
    };
  }

  decideExecution(runId: string, input: unknown, actor: string) {
    const parsed = decisionSchema.parse(input);
    const step = this.runtime.workflows
      .listRunSteps(runId)
      .find((candidate) => candidate.status === "awaiting_approval");
    if (!step) {
      throw new AutomationApiError(
        "Esta execução não está aguardando uma decisão.",
        "conflict",
      );
    }
    const run = this.runtime.engine.approveStep(step.id, { ...parsed, actor });
    return this.executionRow(run);
  }

  pauseExecution(runId: string) {
    return this.executionRow(this.runtime.engine.pauseRun(runId));
  }

  resumeExecution(runId: string) {
    return this.executionRow(this.runtime.engine.resumeRun(runId));
  }

  cancelExecution(runId: string) {
    return this.executionRow(this.runtime.engine.cancelRun(runId));
  }

  listConnectedApps() {
    return { items: this.runtime.connectedApps.list().map(withActions) };
  }

  async createConnectedApp(input: unknown, actor: string) {
    const parsed = connectedAppSchema.parse(input);
    if (!parsed.endpoint) throw new AutomationApiError("Informe o endpoint do app.");
    const created = await this.runtime.connectedApps.create(
      parsed as ConnectedAppWriteInput,
      actor,
    );
    if (created.type === "mcp_remote") {
      await this.runtime.connectedApps.validateConnection(created.id);
    }
    return withActions(this.runtime.connectedApps.get(created.id));
  }

  async updateConnectedApp(id: string, input: unknown, actor: string) {
    const parsed = connectedAppSchema.parse(input);
    const updated = await this.runtime.connectedApps.update(
      id,
      parsed as ConnectedAppWriteInput,
      actor,
    );
    if (updated.type === "mcp_remote") {
      await this.runtime.connectedApps.validateConnection(updated.id);
    }
    return withActions(this.runtime.connectedApps.get(updated.id));
  }

  async deleteConnectedApp(id: string) {
    await this.runtime.connectedApps.delete(id);
    return { deleted: true as const, id };
  }

  testConnectedApp(id: string) {
    return this.runtime.connectedApps.validateConnection(id);
  }

  private getWorkflow(id: string): AutomationWorkflow {
    try {
      return this.runtime.workflows.getWorkflow(id);
    } catch (error) {
      throw new AutomationApiError("Fluxo não encontrado.", "not_found", { cause: error });
    }
  }

  private summary(workflow: AutomationWorkflow) {
    const runs = this.runtime.workflows.listRuns({ workflowId: workflow.id, limit: 200 });
    return {
      id: workflow.id,
      name: workflow.name,
      description: workflow.description,
      status: workflow.status,
      nodeCount: workflow.definition.nodes.length,
      runCount: countRuns(this.database, workflow.id),
      lastRunAt: runs[0]?.createdAt ?? null,
      updatedAt: workflow.updatedAt,
    };
  }

  private detail(workflow: AutomationWorkflow) {
    return {
      ...this.summary(workflow),
      definition: definitionForUi(workflow.definition, workflow.currentVersion, this.runtime),
      createdAt: workflow.createdAt,
    };
  }

  private execution({ run, workflow, stepStatuses }: ExecutionRow) {
    const current = [...stepStatuses].reverse().find((step) =>
      ["queued", "running", "sleeping", "awaiting_approval", "retry"].includes(step.status),
    );
    const currentNode = workflow.definition.nodes.find((node) => node.id === current?.node_id);
    const trigger = workflow.definition.nodes.find((node) => node.type === "trigger");
    const awaitingApproval = stepStatuses.some((step) => step.status === "awaiting_approval");
    const isDryRun = run.input.dryRun === true;
    const steps = isDryRun
      ? dryRunStepsFromInput(run.input.dryRunSteps, workflow)
      : executionSteps(stepStatuses, workflow);
    const stepsTotal = workflow.definition.nodes.length;
    return {
      id: run.id,
      automationId: run.workflowId,
      status: awaitingApproval ? "awaiting_approval" : run.status,
      triggerLabel: trigger?.name || trigger?.config.eventType || "Execução manual",
      currentNodeLabel: isDryRun
        ? "Validação segura concluída, sem executar ações"
        : currentNode?.name ?? currentNode?.type ?? null,
      startedAt: run.startedAt ?? run.createdAt,
      finishedAt: run.finishedAt,
      error: run.lastError ?? stepStatuses.find((step) => step.error)?.error ?? null,
      stepsCompleted: isDryRun
        ? steps.filter((step) => step.status === "passed").length
        : stepStatuses.filter((step) => step.status === "completed").length,
      stepsTotal,
      dryRun: isDryRun,
      steps,
    };
  }

  private executionRow(run: AutomationRun) {
    const workflow = this.runtime.workflows.getWorkflowForRun(run);
    const stepStatuses = this.database.prepare(`
      SELECT status, node_id, error
      FROM automation_run_steps
      WHERE run_id = ?
      ORDER BY created_at, id
    `).all(run.id) as ExecutionRow["stepStatuses"];
    return this.execution({ run, workflow, stepStatuses });
  }
}

function buildDryRunSteps(workflow: AutomationWorkflow): DryRunStep[] {
  return orderedNodes(workflow.definition).map((node) => ({
    nodeId: node.id,
    nodeType: node.type,
    label: dryRunNodeLabel(node),
    status: "passed",
    detail: dryRunNodeDetail(node),
  }));
}

function dryRunStepsFromInput(
  value: unknown,
  workflow: AutomationWorkflow,
): DryRunStep[] {
  if (!Array.isArray(value)) return buildDryRunSteps(workflow);
  const nodes = new Map(workflow.definition.nodes.map((node) => [node.id, node]));
  const steps = value.flatMap((candidate): DryRunStep[] => {
    if (!isRecord(candidate)) return [];
    const nodeId = stringValue(candidate.nodeId);
    const node = nodeId ? nodes.get(nodeId) : undefined;
    if (!node) return [];
    return [{
      nodeId: node.id,
      nodeType: node.type,
      label: stringValue(candidate.label) ?? dryRunNodeLabel(node),
      status: "passed",
      detail: stringValue(candidate.detail) ?? dryRunNodeDetail(node),
    }];
  });
  return steps.length ? steps : buildDryRunSteps(workflow);
}

function executionSteps(
  stepStatuses: ExecutionRow["stepStatuses"],
  workflow: AutomationWorkflow,
) {
  const nodes = new Map(workflow.definition.nodes.map((node) => [node.id, node]));
  return stepStatuses.flatMap((step) => {
    const node = nodes.get(step.node_id);
    if (!node) return [];
    return [{
      nodeId: node.id,
      nodeType: node.type,
      label: dryRunNodeLabel(node),
      status: executionStepStatus(step.status),
      detail: step.error ?? executionStepDetail(step.status),
    }];
  });
}

function executionStepStatus(status: string) {
  if (status === "completed") return "passed" as const;
  if (status === "failed" || status === "cancelled") return "failed" as const;
  if (status === "skipped") return "skipped" as const;
  if (status === "running" || status === "retry") return "running" as const;
  if (status === "sleeping" || status === "awaiting_approval") return "waiting" as const;
  return "pending" as const;
}

function executionStepDetail(status: string): string {
  if (status === "completed") return "Etapa concluída.";
  if (status === "skipped") return "Etapa não necessária neste caminho.";
  if (status === "sleeping") return "Aguardando o intervalo configurado.";
  if (status === "awaiting_approval") return "Aguardando aprovação humana.";
  if (status === "running" || status === "retry") return "Etapa em execução.";
  if (status === "cancelled") return "Etapa cancelada.";
  return "Etapa aguardando execução.";
}

function orderedNodes(definition: AutomationWorkflowDefinition): AutomationNode[] {
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]));
  const order = new Map(definition.nodes.map((node, index) => [node.id, index]));
  const inDegree = new Map(definition.nodes.map((node) => [node.id, 0]));
  const targets = new Map<string, string[]>();

  for (const edge of definition.edges) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) continue;
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
    targets.set(edge.source, [...(targets.get(edge.source) ?? []), edge.target]);
  }

  const queue = definition.nodes
    .filter((node) => (inDegree.get(node.id) ?? 0) === 0)
    .sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
  const result: AutomationNode[] = [];
  while (queue.length) {
    const node = queue.shift();
    if (!node) break;
    result.push(node);
    for (const targetId of targets.get(node.id) ?? []) {
      const nextDegree = (inDegree.get(targetId) ?? 0) - 1;
      inDegree.set(targetId, nextDegree);
      if (nextDegree === 0) {
        const target = nodes.get(targetId);
        if (target) {
          queue.push(target);
          queue.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
        }
      }
    }
  }
  return result.length === definition.nodes.length ? result : definition.nodes;
}

function dryRunNodeLabel(node: AutomationNode): string {
  if (node.name?.trim()) return node.name.trim();
  if (node.type === "trigger") return `Gatilho: ${node.config.eventType}`;
  if (node.type === "condition") return "Condição";
  if (node.type === "wait") return "Espera";
  if (node.type === "approval") return "Aprovação humana";
  if (node.type === "internal_action") {
    if (
      node.config.actionId === "create_in_app_notification" ||
      node.config.actionId === "send_push_notification"
    ) return "Criar notificação";
    return `Ação interna: ${node.config.actionId}`;
  }
  return `App conectado: ${node.config.actionId}`;
}

function dryRunNodeDetail(node: AutomationNode): string {
  if (node.type === "trigger") {
    return `O evento “${node.config.eventType}” foi reconhecido sem criar um evento real.`;
  }
  if (node.type === "condition") {
    return "A condição e seus caminhos foram validados sem alterar tickets.";
  }
  if (node.type === "wait") {
    return `A espera de ${formatDuration(node.config.durationMs)} foi validada sem aguardar o período.`;
  }
  if (node.type === "approval") {
    return "A aprovação foi conferida sem abrir uma solicitação real.";
  }
  if (node.type === "internal_action") {
    if (
      node.config.actionId === "create_in_app_notification" ||
      node.config.actionId === "send_push_notification"
    ) {
      return "Destinatários e conteúdo foram validados sem criar uma notificação real.";
    }
    return "A configuração foi validada sem alterar nenhum ticket.";
  }
  return "A conexão e o payload foram validados sem enviar uma requisição externa.";
}

function formatDuration(durationMs: number): string {
  const minutes = Math.max(1, Math.round(durationMs / 60_000));
  if (minutes < 60) return `${minutes} min`;
  if (minutes >= 1_440) {
    const days = minutes / 1_440;
    return Number.isInteger(days) ? `${days} d` : `${days.toFixed(1)} d`;
  }
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours} h` : `${hours.toFixed(1)} h`;
}

function normalizeDefinition(
  value: { nodes: unknown[]; edges: unknown[] },
  runtime: AutomationRuntime,
): AutomationWorkflowDefinition {
  const nodes = value.nodes.map((raw) => {
    if (!isRecord(raw) || !isRecord(raw.config)) {
      throw new AutomationApiError("Um dos nós possui configuração inválida.");
    }
    const node = structuredClone(raw) as unknown as AutomationNode & {
      config: Record<string, unknown>;
    };
    if (node.type === "app_action") {
      const connectionId = stringValue(node.config.connectionId);
      if (connectionId) {
        const app = runtime.connectedApps.get(connectionId);
        const provider = providerId(app.type);
        const selectedProvider = stringValue(node.config.appId);
        if (selectedProvider && selectedProvider !== provider && selectedProvider !== connectionId) {
          throw new AutomationApiError("O nó está vinculado ao tipo errado de app.");
        }
        node.config.providerId = provider;
        node.config.appId = connectionId;
      }
      const input = isRecord(node.config.input) ? node.config.input : {};
      if (node.config.actionId === "send_message" && !input.text && input.message) {
        node.config.input = { ...input, text: input.message };
      }
    }
    return node as AutomationNode;
  });
  const edges = value.edges.map((raw) => {
    if (!isRecord(raw)) throw new AutomationApiError("Uma das conexões é inválida.");
    return {
      id: requireString(raw.id, "id da conexão"),
      source: requireString(raw.source, "origem da conexão"),
      target: requireString(raw.target, "destino da conexão"),
      ...(stringValue(raw.sourceHandle) ? { sourceHandle: stringValue(raw.sourceHandle)! } : {}),
    } satisfies AutomationEdge;
  });
  return { nodes, edges };
}

function definitionForUi(
  definition: AutomationWorkflowDefinition,
  version: number,
  runtime: AutomationRuntime,
) {
  return {
    version,
    nodes: definition.nodes.map((node) => {
      if (node.type !== "app_action") return node;
      const config = { ...node.config } as Record<string, unknown>;
      const connectionId = stringValue(config.connectionId) ?? stringValue(config.appId);
      if (connectionId) {
        try {
          const app = runtime.connectedApps.get(connectionId);
          config.connectionId = connectionId;
          config.appId = providerId(app.type);
        } catch {
          config.connectionId = connectionId;
          config.appId = stringValue(config.providerId) ?? "unavailable";
        }
      }
      return { ...node, config };
    }),
    edges: definition.edges,
  };
}

function validateConnectedApps(
  definition: AutomationWorkflowDefinition,
  runtime: AutomationRuntime,
): void {
  for (const node of definition.nodes) {
    if (node.type !== "app_action") continue;
    const app = runtime.connectedApps.get(node.config.appId);
    if (app.status !== "active") {
      throw new AutomationApiError(`Ative o app conectado “${app.name}” antes do fluxo.`);
    }
    if (app.type === "intercom") {
      throw new AutomationApiError(
        "O Intercom nativo está disponível no Threadmark AI, mas ainda não expõe etapas automáticas. Use uma conexão MCP para este fluxo.",
      );
    }
    if (app.type !== "mcp_remote") continue;
    const tool = app.mcpTools.find(
      (candidate) =>
        candidate.name === node.config.actionId && candidate.automationEnabled,
    );
    if (!tool) {
      throw new AutomationApiError(
        `A ferramenta “${node.config.actionId}” não está autorizada para automações em “${app.name}”.`,
      );
    }
    if (tool.confirmationRequired && !hasApprovalAncestor(definition, node.id)) {
      throw new AutomationApiError(
        `Adicione uma etapa de aprovação antes de “${tool.title}” ou desative a confirmação dessa ferramenta no app conectado.`,
      );
    }
  }
}

function hasApprovalAncestor(
  definition: AutomationWorkflowDefinition,
  nodeId: string,
): boolean {
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, string[]>();
  for (const edge of definition.edges) {
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source]);
  }
  const pending = [...(incoming.get(nodeId) ?? [])];
  const visited = new Set<string>();
  while (pending.length) {
    const current = pending.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    if (nodes.get(current)?.type === "approval") return true;
    pending.push(...(incoming.get(current) ?? []));
  }
  return false;
}

function countRuns(database: SupportDatabase, workflowId: string): number {
  return (
    database.prepare("SELECT COUNT(*) AS count FROM automation_runs WHERE workflow_id = ?")
      .get(workflowId) as { count: number }
  ).count;
}

function withActions(app: ConnectedAppDto) {
  if (app.type === "mcp_remote") {
    return {
      ...app,
      actions: app.mcpTools.map((tool) => ({
        id: tool.name,
        name: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
        aiEnabled: tool.aiEnabled,
        automationEnabled: tool.automationEnabled,
        confirmationRequired: tool.confirmationRequired,
      })),
    };
  }
  return {
    ...app,
    actions:
      app.type === "slack_webhook"
        ? [{ id: "send_message", name: "Enviar mensagem", description: "Publica no canal do webhook." }]
        : app.type === "intercom"
          ? []
          : [{ id: "request", name: "Executar requisição", description: "Envia um payload para a API." }],
  };
}

function providerId(type: ConnectedAppType): "slack-webhook" | "intercom" | "custom-http" | "mcp-remote" {
  if (type === "slack_webhook") return "slack-webhook";
  if (type === "intercom") return "intercom";
  if (type === "mcp_remote") return "mcp-remote";
  return "custom-http";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requireString(value: unknown, label: string): string {
  const parsed = stringValue(value);
  if (!parsed) throw new AutomationApiError(`Informe ${label}.`);
  return parsed;
}
