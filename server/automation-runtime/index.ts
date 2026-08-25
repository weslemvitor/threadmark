import type { SupportDatabase } from "../db/index.js";
import type { SupportStore } from "../domain/index.js";
import { LocalSecretVault } from "../runtime/secret-vault.js";
import {
  AutomationEngine,
  AutomationCapacityDeferredError,
  AutomationStore,
  type AutomationActionContext,
  type AutomationActionHandlers,
  type AutomationAppActionConfig,
  type AutomationInternalActionConfig,
  type AutomationWorkflow,
} from "../automations/index.js";
import {
  ConnectedAppService,
  createCustomHttpExecutor,
  createSlackWebhookExecutor,
  customHttpConfigSchema,
  renderJsonTemplate,
  slackWebhookConfigSchema,
} from "../integrations/index.js";
import type { NotificationService } from "../notifications/index.js";

const TICKET_EVENT_SOURCE = "ticket_events";
const AUTOMATION_ACTOR_PREFIX = "Automação:";

type TicketEventRow = {
  event_sequence: number;
  id: string;
  ticket_id: string;
  event_type: string;
  actor: string;
  from_status: string | null;
  to_status: string | null;
  data_json: string;
  occurred_at: string;
};

type CursorRow = {
  event_sequence: number;
  reconciled_event_sequence: number;
  occurred_at: string;
  event_id: string;
};

export interface AutomationRuntimeOptions {
  pollIntervalMs?: number;
  logger?: Pick<Console, "error">;
  notifications?: NotificationService;
  connectedApps?: ConnectedAppService;
}

/**
 * Wires the durable workflow engine to Threadmark's ticket audit trail and to
 * the explicitly configured integration registry. The runtime never exposes a
 * WhatsApp outbound capability.
 */
export class AutomationRuntime {
  readonly workflows: AutomationStore;
  readonly connectedApps: ConnectedAppService;
  readonly engine: AutomationEngine;

  private readonly pollIntervalMs: number;
  private readonly logger: Pick<Console, "error">;
  private readonly notifications?: NotificationService;
  private controller: AbortController | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly database: SupportDatabase,
    private readonly support: SupportStore,
    private readonly vault: LocalSecretVault,
    options: AutomationRuntimeOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.logger = options.logger ?? console;
    this.notifications = options.notifications;
    this.workflows = new AutomationStore(database);
    this.connectedApps = options.connectedApps ?? new ConnectedAppService(database, vault);
    this.engine = new AutomationEngine(
      this.workflows,
      this.createActionHandlers(),
      {
        pollIntervalMs: Math.min(this.pollIntervalMs, 500),
        executionDataResolver: (run, defaultData) =>
          currentTicketExecutionData(this.support, run.input, defaultData),
      },
    );
  }

  start(): void {
    if (this.controller) return;
    try {
      this.reconcileMissedTicketEvents();
    } catch (error) {
      this.logger.error("Falha ao reconciliar eventos anteriores das automações", error);
    }
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.running = Promise.all([
      this.engine.run(signal),
      this.runTicketEventBridge(signal),
    ])
      .then(() => undefined)
      .catch((error) => {
        if (!signal.aborted) this.logger.error("Motor de automações interrompido", error);
      });
  }

  async stop(): Promise<void> {
    const controller = this.controller;
    if (!controller) return;
    controller.abort();
    await this.running;
    this.controller = null;
    this.running = null;
  }

  /** Enqueues every new ticket event since the durable cursor. */
  pumpTicketEvents(limit = 100): number {
    const cursor = this.getOrInitializeCursor();
    const rows = this.database.prepare(`
      SELECT ingestion_sequence AS event_sequence,
             id, ticket_id, event_type, actor, from_status, to_status,
             data_json, occurred_at
      FROM ticket_events
      WHERE ingestion_sequence > ?
      ORDER BY ingestion_sequence
      LIMIT ?
    `).all(cursor.event_sequence, limit) as TicketEventRow[];

    for (const row of rows) {
      this.dispatchTicketEvent(row);
      this.updateCursor(row);
    }
    return rows.length;
  }

  /** Repairs events skipped by an older cursor without replaying pre-activation history. */
  reconcileMissedTicketEvents(limit = 500): number {
    const cursor = this.getOrInitializeCursor();
    if (cursor.reconciled_event_sequence >= cursor.event_sequence) return 0;
    const thresholds = activeTriggerThresholds(this.workflows.listWorkflows("active"));
    if (thresholds.size === 0) {
      this.updateReconciledSequence(cursor.event_sequence);
      return 0;
    }

    let scannedAfter = cursor.reconciled_event_sequence;
    let created = 0;
    while (scannedAfter < cursor.event_sequence) {
      const rows = this.database.prepare(`
        SELECT ingestion_sequence AS event_sequence,
               id, ticket_id, event_type, actor, from_status, to_status,
               data_json, occurred_at
        FROM ticket_events
        WHERE ingestion_sequence > ? AND ingestion_sequence <= ?
        ORDER BY ingestion_sequence
        LIMIT ?
      `).all(scannedAfter, cursor.event_sequence, limit) as TicketEventRow[];
      if (rows.length === 0) break;
      for (const row of rows) {
        if (!row.actor.startsWith(AUTOMATION_ACTOR_PREFIX)) {
          const data = parseObject(row.data_json);
          const eligibleTypes = eventTypesFor(row, data).filter((eventType) => {
            const activationSequence = thresholds.get(eventType);
            return activationSequence !== undefined && row.event_sequence > activationSequence;
          });
          created += this.dispatchTicketEvent(row, data, eligibleTypes);
        }
        scannedAfter = row.event_sequence;
        this.updateReconciledSequence(scannedAfter);
      }
    }
    return created;
  }

  private async runTicketEventBridge(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        let processed = this.pumpTicketEvents();
        while (processed === 100 && !signal.aborted) {
          processed = this.pumpTicketEvents();
        }
      } catch (error) {
        this.logger.error("Falha ao capturar eventos para automações", error);
      }
      await delay(this.pollIntervalMs, signal);
    }
  }

  private getOrInitializeCursor(): CursorRow {
    const existing = this.database.prepare(
      `SELECT event_sequence, reconciled_event_sequence, occurred_at, event_id
       FROM automation_event_cursors WHERE source = ?`,
    ).get(TICKET_EVENT_SOURCE) as CursorRow | undefined;
    if (existing) return existing;

    const latest = this.database.prepare(`
      SELECT ingestion_sequence AS event_sequence,
             ingestion_sequence AS reconciled_event_sequence,
             occurred_at, id AS event_id
      FROM ticket_events
      WHERE ingestion_sequence IS NOT NULL
      ORDER BY ingestion_sequence DESC
      LIMIT 1
    `).get() as CursorRow | undefined;
    const cursor = latest ?? {
      event_sequence: 0,
      reconciled_event_sequence: 0,
      occurred_at: "1970-01-01T00:00:00.000Z",
      event_id: "",
    };
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT OR IGNORE INTO automation_event_cursors
        (source, event_sequence, reconciled_event_sequence, occurred_at, event_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      TICKET_EVENT_SOURCE,
      cursor.event_sequence,
      cursor.reconciled_event_sequence,
      cursor.occurred_at,
      cursor.event_id,
      now,
    );
    return (
      this.database.prepare(
        `SELECT event_sequence, reconciled_event_sequence, occurred_at, event_id
         FROM automation_event_cursors WHERE source = ?`,
      ).get(TICKET_EVENT_SOURCE) as CursorRow
    );
  }

  private updateCursor(row: TicketEventRow): void {
    this.database.prepare(`
      UPDATE automation_event_cursors
      SET event_sequence = ?, reconciled_event_sequence = ?,
          occurred_at = ?, event_id = ?, updated_at = ?
      WHERE source = ?
    `).run(
      row.event_sequence,
      row.event_sequence,
      row.occurred_at,
      row.id,
      new Date().toISOString(),
      TICKET_EVENT_SOURCE,
    );
  }

  private updateReconciledSequence(sequence: number): void {
    this.database.prepare(`
      UPDATE automation_event_cursors
      SET reconciled_event_sequence = ?, updated_at = ?
      WHERE source = ?
    `).run(sequence, new Date().toISOString(), TICKET_EVENT_SOURCE);
  }

  private dispatchTicketEvent(
    row: TicketEventRow,
    parsedData?: Record<string, unknown>,
    selectedTypes?: string[],
  ): number {
    if (
      row.event_type === "status_changed" ||
      row.event_type === "ticket_assigned" ||
      row.event_type === "ticket_unassigned"
    ) {
      this.workflows.wakeCapacityAssignmentSteps();
    }
    if (row.actor.startsWith(AUTOMATION_ACTOR_PREFIX)) return 0;
    const data = parsedData ?? parseObject(row.data_json);
    const ticket = this.support.getTicketDetail(row.ticket_id);
    const payload = {
      sourceEventId: row.id,
      sourceEventSequence: row.event_sequence,
      sourceEventType: row.event_type,
      actor: row.actor,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      data,
      ticket,
    };
    let created = 0;
    for (const eventType of selectedTypes ?? eventTypesFor(row, data)) {
      const result = this.engine.dispatchEvent({
        eventType,
        subjectType: "ticket",
        subjectId: row.ticket_id,
        payload,
        occurredAt: row.occurred_at,
        idempotencyKey: `ticket-event:${row.id}:${eventType}`,
      });
      if (result.created) created += 1;
    }
    return created;
  }

  private createActionHandlers(): AutomationActionHandlers {
    const internal = Object.fromEntries(
      [
        "assign_ticket",
        "assign_ticket_by_capacity",
        "change_status",
        "change_priority",
        "add_category",
        "add_internal_note",
        "create_in_app_notification",
        // Compatibilidade temporária com versões de fluxos salvas antes da migração v44.
        "send_push_notification",
      ].map((actionId) => [actionId, (context: AutomationActionContext) => this.executeInternal(actionId, context)]),
    );
    const dynamicApps = new Proxy<Record<string, Record<string, (context: AutomationActionContext) => Promise<unknown>>>>(
      {},
      {
        get: (_target, connectedAppId) =>
          new Proxy<Record<string, (context: AutomationActionContext) => Promise<unknown>>>(
            {},
            {
              get: (_actions, actionId) => (context: AutomationActionContext) =>
                this.executeConnectedApp(String(connectedAppId), String(actionId), context),
            },
          ),
      },
    );
    return { internal, apps: dynamicApps };
  }

  private executeInternal(
    actionId: string,
    context: AutomationActionContext,
  ): unknown {
    const config = (context.node.config as AutomationInternalActionConfig).input ?? {};
    const input = renderRecord(
      config,
      currentTicketExecutionData(this.support, context.input, {
        ...context.input,
        trigger: context.input,
        steps: context.previousSteps,
        workflow: { id: context.workflow.id, name: context.workflow.name },
      }),
    );
    const ticketId = stringValue(input.ticketId) ?? ticketIdFromContext(context);
    const actor = `${AUTOMATION_ACTOR_PREFIX} ${context.workflow.name}`;

    switch (actionId) {
      case "assign_ticket":
        return this.support.updateTicketAssignee(
          ticketId,
          nullableString(input.assigneeId),
          actor,
        );
      case "assign_ticket_by_capacity":
        return this.assignTicketByCapacity(ticketId, context, actor);
      case "change_status":
        return this.support.updateTicketStatus(ticketId, {
          status: requireString(input.status, "status") as Parameters<SupportStore["updateTicketStatus"]>[1]["status"],
          actor,
          reason: nullableString(input.reason) ?? undefined,
          resolution: isRecord(input.resolution)
            ? {
                summary: requireString(input.resolution.summary, "resolution.summary"),
                rootCause: nullableString(input.resolution.rootCause) ?? undefined,
                outcome: nullableString(input.resolution.outcome) ?? undefined,
                validatedBy: actor,
              }
            : undefined,
        });
      case "change_priority": {
        const current = this.support.getTicketDetail(ticketId);
        return this.support.updateTicketMetadata(
          ticketId,
          {
            title: current.title,
            summary: current.summary,
            priority: requireString(input.priority, "priority") as typeof current.priority,
            requesterId: current.requester?.id ?? null,
          },
          actor,
        );
      }
      case "add_category":
        return this.support.attachCategoryToTicket(
          ticketId,
          requireString(input.categoryId, "categoryId"),
          actor,
        );
      case "add_internal_note":
        return this.support.addTicketInternalNote(
          ticketId,
          {
            body: requireString(input.body, "body"),
            clientNoteId: context.idempotencyKey,
          },
          actor,
        );
      case "create_in_app_notification":
      case "send_push_notification":
        return this.createInAppNotification(ticketId, input, context);
      default:
        throw new Error(`Ação interna não suportada: ${actionId}.`);
    }
  }

  private assignTicketByCapacity(
    ticketId: string,
    context: AutomationActionContext,
    actor: string,
  ): unknown {
    const currentWorkflow = this.workflows.getWorkflow(context.workflow.id);
    const currentNode = currentWorkflow.definition.nodes.find(
      (node) => node.id === context.node.id,
    );
    const currentConfig =
      currentNode?.type === "internal_action" &&
      currentNode.config.actionId === "assign_ticket_by_capacity"
        ? currentNode.config.input
        : (context.node.config as AutomationInternalActionConfig).input;
    const members = capacityLimits(currentConfig?.members);
    const queue = {
      workflowId: context.workflow.id,
      nodeId: context.node.id,
      ticketId,
      retryAfterMs: 15_000,
      sourceOrder: sourceEventSequence(context.input),
    } as const;
    const currentTicket = this.support.getTicketDetail(ticketId);
    if (
      currentTicket.assignee ||
      currentTicket.status === "resolved" ||
      currentTicket.status === "cancelled" ||
      currentTicket.status === "archived"
    ) {
      const result = this.support.assignTicketByCapacity(ticketId, members, actor);
      this.workflows.wakeCapacityAssignmentSteps({
        workflowId: context.workflow.id,
        nodeId: context.node.id,
      });
      return result;
    }

    if (
      this.workflows.hasEarlierCapacityAssignment(
        context.workflow.id,
        context.node.id,
        context.step.id,
      )
    ) {
      throw new AutomationCapacityDeferredError({ ...queue, reason: "fifo_wait" });
    }

    const result = this.support.assignTicketByCapacity(ticketId, members, actor);
    if (result.kind === "waiting") {
      throw new AutomationCapacityDeferredError({ ...queue, reason: result.reason });
    }
    this.workflows.wakeCapacityAssignmentSteps({
      workflowId: context.workflow.id,
      nodeId: context.node.id,
    });
    return result;
  }

  private createInAppNotification(
    ticketId: string,
    input: Record<string, unknown>,
    context: AutomationActionContext,
  ): unknown {
    if (!this.notifications) {
      throw new Error("A central de notificações não está disponível.");
    }
    const ticket = this.support.getTicketDetail(ticketId);
    const recipient = stringValue(input.recipient) ?? "assignee";
    let userIds: string[];
    if (recipient === "all") {
      userIds = this.notifications.activeUserIds();
    } else if (recipient.startsWith("user:")) {
      userIds = [requireString(recipient.slice(5), "recipient")];
    } else {
      userIds = ticket.assignee?.id ? [ticket.assignee.id] : [];
    }
    if (!userIds.length) {
      throw new Error(
        recipient === "assignee"
          ? "O ticket não possui um responsável para receber a notificação."
          : "Nenhum destinatário foi encontrado para a notificação.",
      );
    }
    const result = this.notifications.createForUsers(userIds, {
      title: requireString(input.title, "title"),
      body: requireString(input.body, "body"),
      targetUrl: nullableString(input.targetUrl) ?? `/tickets/${ticket.number}`,
      sourceType: "automation",
      sourceId: context.run.id,
      idempotencyKey: context.idempotencyKey,
      tone: ticket.priority === "urgent" ? "urgent" : "info",
    });
    if (result.created === 0 && result.deduplicated === 0) {
      throw new Error("Nenhum usuário ativo foi encontrado para receber a notificação.");
    }
    return result;
  }

  private async executeConnectedApp(
    connectedAppId: string,
    actionId: string,
    context: AutomationActionContext,
  ): Promise<unknown> {
    const connected = await this.connectedApps.resolveForExecution(connectedAppId);
    const variables = currentTicketExecutionData(this.support, context.input, {
      ...context.input,
      trigger: context.input,
      steps: context.previousSteps,
      workflow: { id: context.workflow.id, name: context.workflow.name },
    });
    const nodeInput = (context.node.config as AutomationAppActionConfig).input ?? {};
    const rendered = renderRecord(nodeInput, variables);
    const executionContext = {
      executionId: context.run.id,
      idempotencyKey: context.idempotencyKey,
      automationId: context.workflow.id,
      nodeId: context.node.id,
      ...(context.signal ? { signal: context.signal } : {}),
    };

    if (connected.providerId === "slack-webhook" && actionId === "send_message") {
      const result = await createSlackWebhookExecutor(this.vault).execute(
        slackWebhookConfigSchema.parse(connected.config),
        { text: requireString(rendered.text ?? rendered.message, "mensagem") },
        executionContext,
      );
      if (!result.ok) throw new Error(`Slack respondeu com status ${result.status}.`);
      return result;
    }
    if (connected.providerId === "custom-http" && actionId === "request") {
      const payload = parseJsonInput("payload" in rendered ? rendered.payload : rendered);
      const result = await createCustomHttpExecutor(this.vault).execute(
        customHttpConfigSchema.parse(connected.config),
        { variables: { ...variables, payload } },
        executionContext,
      );
      if (!result.ok) throw new Error(`API respondeu com status ${result.status}.`);
      return result;
    }
    if (connected.providerId === "mcp-remote") {
      const result = await this.connectedApps.callMcpTool(
        connectedAppId,
        actionId,
        mcpAutomationArguments(rendered),
        "automation",
        context.signal,
      );
      return result.structuredContent ?? result.content;
    }
    throw new Error("A ação escolhida não pertence ao app conectado.");
  }
}

function mcpAutomationArguments(value: Record<string, unknown>): Record<string, unknown> {
  const raw = value.__argumentsJson;
  if (raw === undefined || raw === null || raw === "") return value;
  if (typeof raw !== "string") throw new Error("Os argumentos MCP precisam ser um JSON válido.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Os argumentos MCP precisam ser um JSON válido.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Os argumentos MCP precisam formar um objeto JSON.");
  }
  return parsed as Record<string, unknown>;
}

function eventTypesFor(row: TicketEventRow, data: Record<string, unknown>): string[] {
  const types = [row.event_type];
  if (row.event_type === "status_changed") {
    const eventTypeByStatus: Partial<Record<NonNullable<TicketEventRow["to_status"]>, string>> = {
      triage: "ticket_entered_triage",
      in_progress: "ticket_entered_in_progress",
      waiting_customer: "ticket_waiting_customer",
      blocked: "ticket_waiting_internal",
      resolved: "ticket_resolved",
      cancelled: "ticket_cancelled",
      archived: "ticket_archived",
    };
    const specificType = row.to_status ? eventTypeByStatus[row.to_status] : undefined;
    if (specificType) types.push(specificType);
  }
  if (
    row.event_type === "ticket_metadata_updated" &&
    Array.isArray(data.changedFields) &&
    data.changedFields.includes("priority")
  ) {
    types.push("priority_changed");
  }
  return [...new Set(types)];
}

function activeTriggerThresholds(
  workflows: AutomationWorkflow[],
): Map<string, number> {
  const thresholds = new Map<string, number>();
  for (const workflow of workflows) {
    if (workflow.activationEventSequence === null) continue;
    const trigger = workflow.definition.nodes.find((node) => node.type === "trigger");
    if (!trigger) continue;
    const current = thresholds.get(trigger.config.eventType);
    thresholds.set(
      trigger.config.eventType,
      current === undefined
        ? workflow.activationEventSequence
        : Math.min(current, workflow.activationEventSequence),
    );
  }
  return thresholds;
}

function currentTicketExecutionData(
  support: SupportStore,
  input: Record<string, unknown>,
  defaultData: Record<string, unknown>,
): Record<string, unknown> {
  const payload = isRecord(input.payload) ? input.payload : {};
  let ticket = isRecord(payload.ticket) ? payload.ticket : {};
  if (input.subjectType === "ticket" && typeof input.subjectId === "string") {
    ticket = support.getTicketDetail(input.subjectId) as unknown as Record<string, unknown>;
  }
  const categories = Array.isArray(ticket.categories)
    ? ticket.categories
        .map((category) => {
          if (typeof category === "string") return category;
          if (!isRecord(category)) return null;
          return typeof category.name === "string"
            ? category.name
            : typeof category.label === "string"
              ? category.label
              : typeof category.id === "string"
                ? category.id
                : null;
        })
        .filter((category): category is string => Boolean(category))
    : [];
  const assignee = isRecord(ticket.assignee)
    ? ticket.assignee.id ?? ticket.assignee.name ?? null
    : ticket.assignee ?? null;
  return {
    ...defaultData,
    ...payload,
    ...ticket,
    ticket,
    assignee,
    category: categories,
  };
}

function parseJsonInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error("O corpo da API personalizada precisa conter JSON válido.");
  }
}

function ticketIdFromContext(context: AutomationActionContext): string {
  if (context.input.subjectType === "ticket") {
    return requireString(context.input.subjectId, "subjectId");
  }
  const payload = isRecord(context.input.payload) ? context.input.payload : {};
  const ticket = isRecord(payload.ticket) ? payload.ticket : {};
  return requireString(ticket.id, "ticket.id");
}

function renderRecord(
  value: Record<string, unknown>,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const rendered = renderJsonTemplate(value, variables);
  if (!isRecord(rendered)) throw new Error("A configuração da ação precisa ser um objeto.");
  return rendered;
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function capacityLimits(
  value: unknown,
): Array<{ assigneeId: string; maxTickets: number }> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Selecione ao menos um atendente para a distribuição por capacidade.");
  }
  return value.map((item) => {
    if (!isRecord(item)) throw new Error("A configuração de capacidade é inválida.");
    const assigneeId = requireString(item.assigneeId, "members.assigneeId");
    const maxTickets = Number(item.maxTickets);
    if (!Number.isInteger(maxTickets) || maxTickets < 1 || maxTickets > 500) {
      throw new Error("O limite por atendente deve ser um número inteiro entre 1 e 500.");
    }
    return { assigneeId, maxTickets };
  });
}

function sourceEventSequence(input: Record<string, unknown>): number | undefined {
  const payload = isRecord(input.payload) ? input.payload : {};
  const sequence = Number(payload.sourceEventSequence);
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : undefined;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined || value === "" ? null : requireString(value, "valor");
}

function requireString(value: unknown, field: string): string {
  const parsed = stringValue(value);
  if (!parsed) throw new Error(`Informe ${field} para executar a automação.`);
  return parsed;
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}
