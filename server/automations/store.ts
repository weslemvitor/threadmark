import { randomUUID } from "node:crypto";

import type { SupportDatabase } from "../db/index.js";
import type {
  AutomationDispatchResult,
  AutomationEvent,
  AutomationEventInput,
  AutomationNode,
  AutomationRun,
  AutomationRunStep,
  AutomationStepStatus,
  AutomationWorkflow,
  AutomationWorkflowDefinition,
  AutomationWorkflowLayout,
  WorkflowStatus,
} from "./types.js";
import {
  validateWorkflowDefinition,
  validateWorkflowDraftDefinition,
} from "./validation.js";

interface StoreOptions {
  clock?: () => Date;
  idFactory?: () => string;
}

interface CreateWorkflowInput {
  id?: string;
  name: string;
  description?: string | null;
  definition: AutomationWorkflowDefinition;
  actor: string;
}

interface UpdateWorkflowInput {
  name?: string;
  description?: string | null;
  definition: AutomationWorkflowDefinition;
  actor: string;
}

interface UpdateWorkflowMetadataInput {
  name: string;
  description: string | null;
}

interface StartRunInput {
  workflowId: string;
  idempotencyKey: string;
  input: Record<string, unknown>;
  eventId?: string | null;
}

interface WorkflowRow {
  id: string;
  name: string;
  description: string | null;
  status: WorkflowStatus;
  activation_event_sequence: number | null;
  current_version: number;
  definition_json: string;
  layout_json: string | null;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: string;
  event_type: string;
  subject_type: string;
  subject_id: string;
  idempotency_key: string;
  payload_json: string;
  occurred_at: string;
  state: AutomationEvent["state"];
}

interface RunRow {
  id: string;
  workflow_id: string;
  workflow_version: number;
  event_id: string | null;
  idempotency_key: string;
  status: AutomationRun["status"];
  input_json: string;
  definition_json: string | null;
  last_error: string | null;
  created_at: string;
  started_at: string | null;
  updated_at: string;
  finished_at: string | null;
}

interface StepRow {
  id: string;
  run_id: string;
  node_id: string;
  node_type: AutomationNode["type"];
  status: AutomationStepStatus;
  attempt_count: number;
  max_attempts: number;
  idempotency_key: string;
  input_json: string;
  output_json: string | null;
  available_at: string;
  lease_expires_at: string | null;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SleepingWaitRow {
  step_id: string;
  node_id: string;
  started_at: string | null;
  created_at: string;
  run_definition_json: string | null;
  current_definition_json: string;
}

export class AutomationStore {
  private readonly clock: () => Date;
  private readonly idFactory: () => string;

  constructor(
    private readonly database: SupportDatabase,
    options: StoreOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.reconcileSleepingWaitSchedules();
  }

  createWorkflow(input: CreateWorkflowInput): AutomationWorkflow {
    const definition = validateWorkflowDraftDefinition(input.definition);
    const id = input.id ?? this.idFactory();
    const now = this.now();
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO automation_workflows (
          id, name, description, status, current_version,
          created_by, updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, 'draft', 1, ?, ?, ?, ?)
      `).run(
        id,
        requireText(input.name, "name"),
        input.description?.trim() || null,
        requireText(input.actor, "actor"),
        input.actor,
        now,
        now,
      );
      this.insertVersion(id, 1, definition, input.actor, now);
    })();
    return this.getWorkflow(id);
  }

  updateWorkflow(id: string, input: UpdateWorkflowInput): AutomationWorkflow {
    const definition = validateWorkflowDraftDefinition(input.definition);
    const current = this.getWorkflow(id);
    if (current.status === "archived") throw new Error("Fluxo arquivado não pode ser editado.");
    const now = this.now();
    this.database.transaction(() => {
      this.database.prepare(`
        UPDATE automation_workflow_versions
        SET definition_json = ?, created_by = ?, created_at = ?
        WHERE workflow_id = ? AND version = 1
      `).run(
        toJson(definition),
        requireText(input.actor, "actor"),
        now,
        id,
      );
      this.database.prepare(`
        UPDATE automation_workflows
        SET name = ?, description = ?, current_version = 1,
            activation_event_sequence = CASE
              WHEN status = 'active' THEN ?
              ELSE activation_event_sequence
            END,
            updated_by = ?, updated_at = ?
        WHERE id = ?
      `).run(
        input.name === undefined ? current.name : requireText(input.name, "name"),
        input.description === undefined
          ? current.description
          : input.description?.trim() || null,
        this.currentTicketEventSequence(),
        requireText(input.actor, "actor"),
        now,
        id,
      );
      this.reconcileSleepingWaitSchedules(id, now);
    })();
    return this.getWorkflow(id);
  }

  reconcileSleepingWaitSchedules(workflowId?: string, timestamp?: string): number {
    const now = timestamp ?? this.now();
    const rows = this.database.prepare(`
      SELECT
        step.id AS step_id,
        step.node_id,
        step.started_at,
        step.created_at,
        run.definition_json AS run_definition_json,
        version.definition_json AS current_definition_json
      FROM automation_run_steps AS step
      JOIN automation_runs AS run ON run.id = step.run_id
      JOIN automation_workflows AS workflow ON workflow.id = run.workflow_id
      JOIN automation_workflow_versions AS version
        ON version.workflow_id = workflow.id
       AND version.version = workflow.current_version
      WHERE step.status = 'sleeping'
        AND step.node_type = 'wait'
        AND run.status IN ('queued', 'running', 'waiting', 'paused')
        AND (? IS NULL OR workflow.id = ?)
    `).all(workflowId ?? null, workflowId ?? null) as SleepingWaitRow[];

    let changes = 0;
    for (const row of rows) {
      if (!row.run_definition_json) continue;
      const runDefinition = fromJson(
        row.run_definition_json,
      ) as AutomationWorkflowDefinition;
      const currentDefinition = fromJson(
        row.current_definition_json,
      ) as AutomationWorkflowDefinition;
      const previousNode = runDefinition.nodes.find((node) => node.id === row.node_id);
      const currentNode = currentDefinition.nodes.find((node) => node.id === row.node_id);
      if (previousNode?.type !== "wait" || currentNode?.type !== "wait") continue;
      if (previousNode.config.durationMs === currentNode.config.durationMs) continue;

      const waitStartedAt = row.started_at ?? row.created_at;
      const configuredDueAt = addMs(waitStartedAt, currentNode.config.durationMs);
      const availableAt = Date.parse(configuredDueAt) <= Date.parse(now)
        ? now
        : configuredDueAt;
      const result = this.database.prepare(`
        UPDATE automation_run_steps
        SET available_at = ?, updated_at = ?
        WHERE id = ? AND status = 'sleeping'
      `).run(availableAt, now, row.step_id);
      changes += result.changes;
    }
    return changes;
  }

  updateWorkflowLayout(
    id: string,
    positions: AutomationWorkflowLayout,
    actor: string,
  ): AutomationWorkflow {
    const current = this.getWorkflow(id);
    if (current.status === "archived") {
      throw new Error("Fluxo arquivado não pode ser editado.");
    }
    const nodeIds = new Set(current.definition.nodes.map((node) => node.id));
    const normalized = Object.fromEntries(
      Object.entries(positions).map(([nodeId, position]) => {
        if (!nodeIds.has(nodeId)) {
          throw new Error(`Nó não encontrado no fluxo: ${nodeId}`);
        }
        if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
          throw new Error(`Posição inválida para o nó: ${nodeId}`);
        }
        return [nodeId, { x: position.x, y: position.y }];
      }),
    );
    const now = this.now();
    this.database.prepare(`
      INSERT INTO automation_workflow_layouts (
        workflow_id, positions_json, updated_by, updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(workflow_id) DO UPDATE SET
        positions_json = excluded.positions_json,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
    `).run(
      id,
      toJson(normalized),
      requireText(actor, "actor"),
      now,
    );
    return this.getWorkflow(id);
  }

  updateWorkflowMetadata(
    id: string,
    input: UpdateWorkflowMetadataInput,
    actor: string,
  ): AutomationWorkflow {
    const current = this.getWorkflow(id);
    if (current.status === "archived") {
      throw new Error("Fluxo arquivado não pode ser editado.");
    }
    const now = this.now();
    this.database.prepare(`
      UPDATE automation_workflows
      SET name = ?, description = ?, updated_by = ?, updated_at = ?
      WHERE id = ?
    `).run(
      requireText(input.name, "name"),
      input.description?.trim() || null,
      requireText(actor, "actor"),
      now,
      id,
    );
    return this.getWorkflow(id);
  }

  setWorkflowStatus(id: string, status: WorkflowStatus, actor: string): AutomationWorkflow {
    const current = this.getWorkflow(id);
    if (current.status === "archived" && status !== "archived") {
      throw new Error("Fluxo arquivado não pode ser reativado.");
    }
    if (status === "active") validateWorkflowDefinition(current.definition);
    const now = this.now();
    const activationEventSequence =
      status === "active" && current.status !== "active"
        ? this.currentTicketEventSequence()
        : current.activationEventSequence;
    this.database.prepare(`
      UPDATE automation_workflows
      SET status = ?, activation_event_sequence = ?, updated_by = ?, updated_at = ?
      WHERE id = ?
    `).run(
      status,
      activationEventSequence,
      requireText(actor, "actor"),
      now,
      id,
    );
    return this.getWorkflow(id);
  }

  getWorkflow(id: string, version?: number): AutomationWorkflow {
    const row = this.database.prepare(`
      SELECT workflow.*, version.definition_json,
             layout.positions_json AS layout_json
      FROM automation_workflows AS workflow
      JOIN automation_workflow_versions AS version
        ON version.workflow_id = workflow.id
       AND version.version = COALESCE(?, workflow.current_version)
      LEFT JOIN automation_workflow_layouts AS layout
        ON layout.workflow_id = workflow.id
      WHERE workflow.id = ?
    `).get(version ?? null, id) as WorkflowRow | undefined;
    if (!row) throw new Error(`Fluxo não encontrado: ${id}`);
    return workflowFromRow(row, version, version === undefined);
  }

  getWorkflowForRun(run: AutomationRun): AutomationWorkflow {
    const current = this.getWorkflow(run.workflowId);
    return run.definition
      ? { ...current, currentVersion: run.workflowVersion, definition: run.definition }
      : current;
  }

  listWorkflows(status?: WorkflowStatus): AutomationWorkflow[] {
    const rows = this.database.prepare(`
      SELECT workflow.*, version.definition_json,
             layout.positions_json AS layout_json
      FROM automation_workflows AS workflow
      JOIN automation_workflow_versions AS version
        ON version.workflow_id = workflow.id
       AND version.version = workflow.current_version
      LEFT JOIN automation_workflow_layouts AS layout
        ON layout.workflow_id = workflow.id
      WHERE (? IS NULL OR workflow.status = ?)
      ORDER BY workflow.updated_at DESC, workflow.id
    `).all(status ?? null, status ?? null) as WorkflowRow[];
    return rows.map((row) => workflowFromRow(row, undefined, true));
  }

  deleteWorkflow(id: string, actor: string): { deleted: boolean; archived: boolean } {
    const workflow = this.getWorkflow(id);
    const hasRuns = Boolean(
      this.database
        .prepare("SELECT 1 FROM automation_runs WHERE workflow_id = ? LIMIT 1")
        .get(id),
    );
    if (hasRuns) {
      if (workflow.status !== "archived") this.setWorkflowStatus(id, "archived", actor);
      return { deleted: false, archived: true };
    }
    this.database.prepare("DELETE FROM automation_workflows WHERE id = ?").run(id);
    return { deleted: true, archived: false };
  }

  enqueueEvent(input: AutomationEventInput): AutomationDispatchResult {
    const now = this.now();
    const id = this.idFactory();
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO automation_events (
        id, event_type, subject_type, subject_id, idempotency_key,
        payload_json, occurred_at, state, available_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
    `).run(
      id,
      requireText(input.eventType, "eventType"),
      requireText(input.subjectType, "subjectType"),
      requireText(input.subjectId, "subjectId"),
      requireText(input.idempotencyKey, "idempotencyKey"),
      toJson(input.payload ?? {}),
      input.occurredAt ?? now,
      now,
      now,
    );
    const event = this.getEventByKey(input.idempotencyKey);
    return { event, created: result.changes === 1 };
  }

  claimNextEvent(leaseMs: number): AutomationEvent | null {
    const now = this.now();
    const leaseExpiresAt = addMs(now, leaseMs);
    return this.database.transaction(() => {
      const row = this.database.prepare(`
        SELECT * FROM automation_events
        WHERE state = 'queued' AND available_at <= ?
        ORDER BY occurred_at, id
        LIMIT 1
      `).get(now) as EventRow | undefined;
      if (!row) return null;
      this.database.prepare(`
        UPDATE automation_events
        SET state = 'processing', attempt_count = attempt_count + 1,
            lease_expires_at = ?, error = NULL
        WHERE id = ? AND state = 'queued'
      `).run(leaseExpiresAt, row.id);
      return eventFromRow({ ...row, state: "processing" });
    })();
  }

  completeEvent(id: string): void {
    const now = this.now();
    this.database.prepare(`
      UPDATE automation_events
      SET state = 'completed', lease_expires_at = NULL, error = NULL, processed_at = ?
      WHERE id = ? AND state = 'processing'
    `).run(now, id);
  }

  retryEvent(id: string, error: string, delayMs: number, maxAttempts = 3): void {
    const row = this.database.prepare(
      "SELECT attempt_count FROM automation_events WHERE id = ?",
    ).get(id) as { attempt_count: number } | undefined;
    if (!row) throw new Error(`Evento não encontrado: ${id}`);
    const now = this.now();
    if (row.attempt_count >= maxAttempts) {
      this.database.prepare(`
        UPDATE automation_events
        SET state = 'failed', lease_expires_at = NULL, error = ?, processed_at = ?
        WHERE id = ?
      `).run(error, now, id);
      return;
    }
    this.database.prepare(`
      UPDATE automation_events
      SET state = 'queued', available_at = ?, lease_expires_at = NULL, error = ?
      WHERE id = ?
    `).run(addMs(now, delayMs), error, id);
  }

  startRun(input: StartRunInput): { run: AutomationRun; created: boolean } {
    const workflow = this.getWorkflow(input.workflowId);
    if (workflow.status !== "active") {
      throw new Error(`Fluxo ${workflow.id} não está ativo.`);
    }
    const trigger = workflow.definition.nodes.find((node) => node.type === "trigger");
    if (!trigger) throw new Error("Definição sem gatilho.");
    const runId = this.idFactory();
    const stepId = this.idFactory();
    const now = this.now();
    const created = this.database.transaction(() => {
      const result = this.database.prepare(`
        INSERT OR IGNORE INTO automation_runs (
          id, workflow_id, workflow_version, event_id, idempotency_key,
          status, input_json, definition_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)
      `).run(
        runId,
        workflow.id,
        workflow.currentVersion,
        input.eventId ?? null,
        requireText(input.idempotencyKey, "idempotencyKey"),
        toJson(input.input),
        toJson(workflow.definition),
        now,
        now,
      );
      if (result.changes === 0) return false;
      this.insertStep(
        stepId,
        runId,
        trigger,
        `${runId}:${trigger.id}`,
        {},
        now,
      );
      return true;
    })();
    const run = created
      ? this.getRun(runId)
      : this.getRunByIdempotencyKey(workflow.id, input.idempotencyKey);
    return { run, created };
  }

  getRun(id: string): AutomationRun {
    const row = this.database.prepare(
      "SELECT * FROM automation_runs WHERE id = ?",
    ).get(id) as RunRow | undefined;
    if (!row) throw new Error(`Execução não encontrada: ${id}`);
    return runFromRow(row);
  }

  listRuns(input: { workflowId?: string; limit?: number } = {}): AutomationRun[] {
    const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 50)));
    const rows = this.database.prepare(`
      SELECT * FROM automation_runs
      WHERE (? IS NULL OR workflow_id = ?)
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(input.workflowId ?? null, input.workflowId ?? null, limit) as RunRow[];
    return rows.map(runFromRow);
  }

  listRunSteps(runId: string): AutomationRunStep[] {
    const rows = this.database.prepare(`
      SELECT * FROM automation_run_steps
      WHERE run_id = ? ORDER BY created_at, id
    `).all(runId) as StepRow[];
    return rows.map(stepFromRow);
  }

  getStep(id: string): AutomationRunStep {
    const row = this.database.prepare(
      "SELECT * FROM automation_run_steps WHERE id = ?",
    ).get(id) as StepRow | undefined;
    if (!row) throw new Error(`Etapa não encontrada: ${id}`);
    return stepFromRow(row);
  }

  claimNextStep(leaseMs: number): AutomationRunStep | null {
    const now = this.now();
    const leaseExpiresAt = addMs(now, leaseMs);
    return this.database.transaction(() => {
      const row = this.database.prepare(`
        SELECT step.*
        FROM automation_run_steps AS step
        JOIN automation_runs AS run ON run.id = step.run_id
        WHERE step.status IN ('queued', 'retry', 'sleeping')
          AND step.available_at <= ?
          AND run.status IN ('queued', 'running', 'waiting')
        ORDER BY step.available_at, step.created_at, step.id
        LIMIT 1
      `).get(now) as StepRow | undefined;
      if (!row) return null;
      const incrementAttempt = row.status === "sleeping" ? 0 : 1;
      const updated = this.database.prepare(`
        UPDATE automation_run_steps
        SET status = 'running', attempt_count = attempt_count + ?,
            lease_expires_at = ?, error = NULL,
            started_at = COALESCE(started_at, ?), updated_at = ?
        WHERE id = ? AND status = ?
      `).run(incrementAttempt, leaseExpiresAt, now, now, row.id, row.status);
      if (updated.changes === 0) return null;
      this.database.prepare(`
        UPDATE automation_runs
        SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
        WHERE id = ? AND status IN ('queued', 'running', 'waiting')
      `).run(now, now, row.run_id);
      return this.getStep(row.id);
    })();
  }

  markStepSleeping(stepId: string, durationMs: number): void {
    const step = this.getStep(stepId);
    const now = this.now();
    this.database.transaction(() => {
      this.database.prepare(`
        UPDATE automation_run_steps
        SET status = 'sleeping', available_at = ?, lease_expires_at = NULL,
            output_json = '{"__waitScheduled":true}', updated_at = ?
        WHERE id = ? AND status = 'running'
      `).run(addMs(now, durationMs), now, stepId);
      this.refreshRunStatus(step.runId, now);
    })();
  }

  markStepAwaitingApproval(stepId: string): void {
    const step = this.getStep(stepId);
    const now = this.now();
    this.database.transaction(() => {
      this.database.prepare(`
        UPDATE automation_run_steps
        SET status = 'awaiting_approval', lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'running'
      `).run(now, stepId);
      this.refreshRunStatus(step.runId, now);
    })();
  }

  advanceStep(
    stepId: string,
    definition: AutomationWorkflowDefinition,
    output: unknown,
    selectedHandle?: string,
  ): AutomationRun {
    const now = this.now();
    return this.database.transaction(() => {
      const step = this.getStep(stepId);
      const run = this.getRun(step.runId);
      if (run.status === "cancelled") {
        this.markStepCancelled(stepId, now);
        return this.getRun(run.id);
      }
      if (run.status === "paused") {
        throw new Error("A execução está pausada.");
      }
      if (!new Set<AutomationStepStatus>(["running", "awaiting_approval"]).has(step.status)) {
        throw new Error(`Etapa ${stepId} não pode ser concluída em ${step.status}.`);
      }
      this.database.prepare(`
        UPDATE automation_run_steps
        SET status = 'completed', output_json = ?, lease_expires_at = NULL,
            error = NULL, completed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(toJson(output), now, now, stepId);

      const outgoing = definition.edges.filter(
        (edge) =>
          edge.source === step.nodeId &&
          (edge.sourceHandle === undefined || edge.sourceHandle === selectedHandle),
      );
      for (const edge of outgoing) {
        const node = definition.nodes.find((candidate) => candidate.id === edge.target);
        if (!node) throw new Error(`Nó de destino não encontrado: ${edge.target}`);
        this.insertStep(
          this.idFactory(),
          run.id,
          node,
          `${run.id}:${node.id}`,
          { sourceNodeId: step.nodeId, sourceOutput: output },
          now,
        );
      }
      this.refreshRunStatus(run.id, now);
      return this.getRun(run.id);
    })();
  }

  failStep(stepId: string, error: string, retryDelayMs: number): AutomationRun {
    const step = this.getStep(stepId);
    const now = this.now();
    this.database.transaction(() => {
      const run = this.getRun(step.runId);
      if (run.status === "cancelled") {
        this.markStepCancelled(step.id, now);
        return;
      }
      if (step.attemptCount < step.maxAttempts) {
        this.database.prepare(`
          UPDATE automation_run_steps
          SET status = 'retry', available_at = ?, lease_expires_at = NULL,
              error = ?, updated_at = ?
          WHERE id = ?
        `).run(addMs(now, retryDelayMs), error, now, stepId);
        this.refreshRunStatus(run.id, now);
        return;
      }
      this.database.prepare(`
        UPDATE automation_run_steps
        SET status = 'failed', lease_expires_at = NULL, error = ?,
            completed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(error, now, now, stepId);
      this.database.prepare(`
        UPDATE automation_runs
        SET status = 'failed', last_error = ?, definition_json = NULL,
            updated_at = ?, finished_at = ?
        WHERE id = ?
      `).run(error, now, now, run.id);
    })();
    return this.getRun(step.runId);
  }

  pauseRun(runId: string): AutomationRun {
    const now = this.now();
    this.database.prepare(`
      UPDATE automation_runs SET status = 'paused', updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running', 'waiting')
    `).run(now, runId);
    return this.getRun(runId);
  }

  resumeRun(runId: string): AutomationRun {
    const now = this.now();
    this.database.transaction(() => {
      const run = this.getRun(runId);
      if (run.status !== "paused") throw new Error("A execução não está pausada.");
      this.refreshRunStatus(runId, now, true);
    })();
    return this.getRun(runId);
  }

  cancelRun(runId: string): AutomationRun {
    const now = this.now();
    this.database.transaction(() => {
      this.database.prepare(`
        UPDATE automation_runs
        SET status = 'cancelled', definition_json = NULL,
            updated_at = ?, finished_at = ?
        WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled')
      `).run(now, now, runId);
      this.database.prepare(`
        UPDATE automation_run_steps
        SET status = 'cancelled', lease_expires_at = NULL,
            completed_at = ?, updated_at = ?
        WHERE run_id = ?
          AND status NOT IN ('completed', 'failed', 'cancelled', 'skipped')
      `).run(now, now, runId);
    })();
    return this.getRun(runId);
  }

  recoverExpiredWork(): void {
    const now = this.now();
    this.database.transaction(() => {
      this.database.prepare(`
        UPDATE automation_events
        SET state = 'queued', available_at = ?, lease_expires_at = NULL,
            error = 'Lease expirou; evento recuperado.'
        WHERE state = 'processing' AND lease_expires_at <= ?
      `).run(now, now);

      const expired = this.database.prepare(`
        SELECT * FROM automation_run_steps
        WHERE status = 'running' AND lease_expires_at <= ?
      `).all(now) as StepRow[];
      for (const row of expired) {
        if (row.attempt_count < row.max_attempts) {
          this.database.prepare(`
            UPDATE automation_run_steps
            SET status = 'retry', available_at = ?, lease_expires_at = NULL,
                error = 'Lease expirou; etapa recuperada.', updated_at = ?
            WHERE id = ?
          `).run(now, now, row.id);
          this.refreshRunStatus(row.run_id, now);
          continue;
        }
        this.database.prepare(`
          UPDATE automation_run_steps
          SET status = 'failed', lease_expires_at = NULL,
              error = 'Lease expirou e o limite de tentativas foi atingido.',
              completed_at = ?, updated_at = ?
          WHERE id = ?
        `).run(now, now, row.id);
        this.database.prepare(`
          UPDATE automation_runs
          SET status = 'failed',
              last_error = 'Lease expirou e o limite de tentativas foi atingido.',
              definition_json = NULL, updated_at = ?, finished_at = ?
          WHERE id = ? AND status <> 'cancelled'
        `).run(now, now, row.run_id);
      }
    })();
  }

  getCompletedStepOutputs(runId: string): Record<string, unknown> {
    const rows = this.database.prepare(`
      SELECT node_id, output_json FROM automation_run_steps
      WHERE run_id = ? AND status = 'completed'
    `).all(runId) as Array<{ node_id: string; output_json: string | null }>;
    return Object.fromEntries(rows.map((row) => [row.node_id, fromJson(row.output_json)]));
  }

  private getEventByKey(idempotencyKey: string): AutomationEvent {
    const row = this.database.prepare(
      "SELECT * FROM automation_events WHERE idempotency_key = ?",
    ).get(idempotencyKey) as EventRow | undefined;
    if (!row) throw new Error(`Evento não encontrado: ${idempotencyKey}`);
    return eventFromRow(row);
  }

  private getRunByIdempotencyKey(workflowId: string, key: string): AutomationRun {
    const row = this.database.prepare(`
      SELECT * FROM automation_runs WHERE workflow_id = ? AND idempotency_key = ?
    `).get(workflowId, key) as RunRow | undefined;
    if (!row) throw new Error(`Execução idempotente não encontrada: ${workflowId}/${key}`);
    return runFromRow(row);
  }

  private insertVersion(
    workflowId: string,
    version: number,
    definition: AutomationWorkflowDefinition,
    actor: string,
    createdAt: string,
  ): void {
    this.database.prepare(`
      INSERT INTO automation_workflow_versions (
        workflow_id, version, definition_json, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(workflowId, version, toJson(definition), actor, createdAt);
  }

  private insertStep(
    id: string,
    runId: string,
    node: AutomationNode,
    idempotencyKey: string,
    input: Record<string, unknown>,
    createdAt: string,
  ): void {
    this.database.prepare(`
      INSERT OR IGNORE INTO automation_run_steps (
        id, run_id, node_id, node_type, status, max_attempts,
        idempotency_key, input_json, available_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      runId,
      node.id,
      node.type,
      maxAttempts(node),
      idempotencyKey,
      toJson(input),
      createdAt,
      createdAt,
      createdAt,
    );
  }

  private refreshRunStatus(runId: string, now: string, includePaused = false): void {
    const run = this.getRun(runId);
    if (run.status === "cancelled" || run.status === "failed" || run.status === "completed") {
      return;
    }
    if (run.status === "paused" && !includePaused) return;
    const counts = this.database.prepare(`
      SELECT
        SUM(CASE WHEN status IN ('queued', 'running', 'retry') THEN 1 ELSE 0 END) AS runnable,
        SUM(CASE WHEN status IN ('sleeping', 'awaiting_approval') THEN 1 ELSE 0 END) AS waiting,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
      FROM automation_run_steps WHERE run_id = ?
    `).get(runId) as { runnable: number | null; waiting: number | null; failed: number | null };
    const runnable = counts.runnable ?? 0;
    const waiting = counts.waiting ?? 0;
    const failed = counts.failed ?? 0;
    const status: AutomationRun["status"] = failed
      ? "failed"
      : runnable
        ? "running"
        : waiting
          ? "waiting"
          : "completed";
    this.database.prepare(`
      UPDATE automation_runs
      SET status = ?, updated_at = ?,
          finished_at = CASE WHEN ? IN ('completed', 'failed') THEN ? ELSE NULL END,
          definition_json = CASE
            WHEN ? IN ('completed', 'failed') THEN NULL
            ELSE definition_json
          END
      WHERE id = ?
    `).run(status, now, status, now, status, runId);
  }

  private markStepCancelled(stepId: string, now: string): void {
    this.database.prepare(`
      UPDATE automation_run_steps
      SET status = 'cancelled', lease_expires_at = NULL,
          completed_at = ?, updated_at = ?
      WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled', 'skipped')
    `).run(now, now, stepId);
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private currentTicketEventSequence(): number {
    const row = this.database.prepare(
      "SELECT last_value FROM ticket_event_sequence WHERE singleton = 1",
    ).get() as { last_value: number } | undefined;
    return row?.last_value ?? 0;
  }
}

function workflowFromRow(
  row: WorkflowRow,
  requestedVersion?: number,
  applyCurrentLayout = false,
): AutomationWorkflow {
  const storedDefinition = fromJson(row.definition_json) as AutomationWorkflowDefinition;
  const definition = applyCurrentLayout
    ? definitionWithLayout(storedDefinition, fromJson(row.layout_json))
    : storedDefinition;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    activationEventSequence: row.activation_event_sequence,
    currentVersion: requestedVersion ?? row.current_version,
    definition,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function definitionWithLayout(
  definition: AutomationWorkflowDefinition,
  value: unknown,
): AutomationWorkflowDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return definition;
  const positions = value as Record<string, unknown>;
  return {
    ...definition,
    nodes: definition.nodes.map((node) => {
      const position = positions[node.id];
      if (!position || typeof position !== "object" || Array.isArray(position)) return node;
      const { x, y } = position as { x?: unknown; y?: unknown };
      return typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)
        ? { ...node, position: { x, y } }
        : node;
    }),
  };
}

function eventFromRow(row: EventRow): AutomationEvent {
  return {
    id: row.id,
    eventType: row.event_type,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    idempotencyKey: row.idempotency_key,
    payload: fromJson(row.payload_json) as Record<string, unknown>,
    occurredAt: row.occurred_at,
    state: row.state,
  };
}

function runFromRow(row: RunRow): AutomationRun {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowVersion: row.workflow_version,
    eventId: row.event_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    input: fromJson(row.input_json) as Record<string, unknown>,
    definition: row.definition_json
      ? fromJson(row.definition_json) as AutomationWorkflowDefinition
      : null,
    lastError: row.last_error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

function stepFromRow(row: StepRow): AutomationRunStep {
  return {
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    nodeType: row.node_type,
    status: row.status,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    idempotencyKey: row.idempotency_key,
    input: fromJson(row.input_json) as Record<string, unknown>,
    output: fromJson(row.output_json),
    availableAt: row.available_at,
    leaseExpiresAt: row.lease_expires_at,
    error: row.error,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function maxAttempts(node: AutomationNode): number {
  if (node.type !== "internal_action" && node.type !== "app_action") return 1;
  return node.config.retry?.maxAttempts ?? 1;
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} é obrigatório.`);
  return normalized;
}

function addMs(iso: string, milliseconds: number): string {
  return new Date(Date.parse(iso) + milliseconds).toISOString();
}

function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function fromJson(value: string | null): unknown {
  return value === null ? null : JSON.parse(value);
}
