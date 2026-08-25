import { AutomationStore } from "./store.js";
import type { CapacityQueueInput } from "./store.js";
import type {
  AutomationActionContext,
  AutomationActionHandler,
  AutomationActionHandlers,
  AutomationDispatchResult,
  AutomationEngineOptions,
  AutomationEvent,
  AutomationEventInput,
  AutomationNode,
  AutomationRun,
  AutomationRunStep,
  AutomationTickResult,
  AutomationWorkflow,
} from "./types.js";
import { matchesFilter } from "./validation.js";

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_EVENT_RETRY_DELAY_MS = 1_000;

export class AutomationCapacityDeferredError extends Error {
  constructor(readonly queue: CapacityQueueInput) {
    super("Aguardando capacidade disponível para atribuir o ticket.");
    this.name = "AutomationCapacityDeferredError";
  }
}

export class AutomationEngine {
  private readonly leaseMs: number;
  private readonly pollIntervalMs: number;
  private readonly eventRetryDelayMs: number;
  private readonly executionDataResolver?: AutomationEngineOptions["executionDataResolver"];

  constructor(
    readonly store: AutomationStore,
    private readonly handlers: AutomationActionHandlers = {},
    options: AutomationEngineOptions = {},
  ) {
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.eventRetryDelayMs = options.eventRetryDelayMs ?? DEFAULT_EVENT_RETRY_DELAY_MS;
    this.executionDataResolver = options.executionDataResolver;
  }

  dispatchEvent(input: AutomationEventInput): AutomationDispatchResult {
    return this.store.enqueueEvent(input);
  }

  enqueueEvent(input: AutomationEventInput): AutomationDispatchResult {
    return this.dispatchEvent(input);
  }

  async tick(signal?: AbortSignal): Promise<AutomationTickResult> {
    throwIfAborted(signal);
    this.store.recoverExpiredWork();
    const event = this.store.claimNextEvent(this.leaseMs);
    if (event) {
      await this.processEvent(event);
      return { kind: "event", id: event.id };
    }
    const step = this.store.claimNextStep(this.leaseMs);
    if (!step) return { kind: "idle" };
    await this.processStep(step, signal);
    return { kind: "step", id: step.id };
  }

  async run(signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted) {
        const result = await this.tick(signal);
        if (result.kind === "idle") await abortableDelay(this.pollIntervalMs, signal);
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }

  async runUntilIdle(maxTicks = 500, signal?: AbortSignal): Promise<number> {
    let processed = 0;
    while (processed < maxTicks) {
      const result = await this.tick(signal);
      if (result.kind === "idle") return processed;
      processed += 1;
    }
    throw new Error(`Motor não ficou ocioso após ${maxTicks} ciclos.`);
  }

  approveStep(
    stepId: string,
    input: { approved: boolean; actor: string; note?: string },
  ): AutomationRun {
    const step = this.store.getStep(stepId);
    if (step.status !== "awaiting_approval") {
      throw new Error("Esta etapa não está aguardando aprovação.");
    }
    const run = this.store.getRun(step.runId);
    const workflow = this.store.getWorkflowForRun(run);
    return this.store.advanceStep(
      step.id,
      workflow.definition,
      { approved: input.approved, actor: input.actor, note: input.note ?? null },
      input.approved ? "approved" : "rejected",
    );
  }

  pauseRun(runId: string): AutomationRun {
    return this.store.pauseRun(runId);
  }

  resumeRun(runId: string): AutomationRun {
    return this.store.resumeRun(runId);
  }

  cancelRun(runId: string): AutomationRun {
    return this.store.cancelRun(runId);
  }

  private async processEvent(event: AutomationEvent): Promise<void> {
    try {
      const context = eventContext(event);
      for (const workflow of this.store.listWorkflows("active")) {
        const trigger = workflow.definition.nodes.find((node) => node.type === "trigger");
        if (!trigger || trigger.config.eventType !== event.eventType) continue;
        const sourceEventSequence = finiteNumber(event.payload.sourceEventSequence);
        if (
          sourceEventSequence !== null &&
          workflow.activationEventSequence !== null &&
          sourceEventSequence <= workflow.activationEventSequence
        ) {
          continue;
        }
        if (!(trigger.config.filters ?? []).every((filter) => matchesFilter(context, filter))) {
          continue;
        }
        this.store.startRun({
          workflowId: workflow.id,
          eventId: event.id,
          idempotencyKey: event.idempotencyKey,
          input: context,
        });
      }
      this.store.completeEvent(event.id);
    } catch (error) {
      this.store.retryEvent(
        event.id,
        errorMessage(error),
        this.eventRetryDelayMs,
      );
    }
  }

  private async processStep(step: AutomationRunStep, signal?: AbortSignal): Promise<void> {
    const run = this.store.getRun(step.runId);
    const workflow = this.store.getWorkflowForRun(run);
    const node = findNode(workflow, step.nodeId);
    try {
      throwIfAborted(signal);
      await this.executeNode(workflow, run, step, node, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof AutomationCapacityDeferredError) {
        this.store.deferStepForCapacity(step.id, error.queue);
        return;
      }
      this.store.failStep(step.id, errorMessage(error), retryDelay(node));
    }
  }

  private async executeNode(
    workflow: AutomationWorkflow,
    run: AutomationRun,
    step: AutomationRunStep,
    node: AutomationNode,
    signal?: AbortSignal,
  ): Promise<void> {
    switch (node.type) {
      case "trigger":
        this.store.advanceStep(step.id, workflow.definition, run.input);
        return;
      case "condition": {
        const matched = matchesFilter(this.executionData(run), node.config);
        this.store.advanceStep(step.id, workflow.definition, { matched }, String(matched));
        return;
      }
      case "wait":
        if (isScheduledWait(step)) {
          this.store.advanceStep(step.id, workflow.definition, {
            waitedMs: node.config.durationMs,
          });
        } else {
          this.store.markStepSleeping(step.id, node.config.durationMs);
        }
        return;
      case "approval":
        this.store.markStepAwaitingApproval(step.id);
        return;
      case "internal_action":
        await this.executeAction(
          this.handlers.internal?.[node.config.actionId],
          workflow,
          run,
          step,
          node,
          signal,
        );
        return;
      case "app_action":
        await this.executeAction(
          this.handlers.apps?.[node.config.appId]?.[node.config.actionId],
          workflow,
          run,
          step,
          node,
          signal,
        );
    }
  }

  private async executeAction(
    handler: AutomationActionHandler | undefined,
    workflow: AutomationWorkflow,
    run: AutomationRun,
    step: AutomationRunStep,
    node: AutomationNode,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!handler) throw new Error(`Ação não registrada para o nó ${node.id}.`);
    const context: AutomationActionContext = {
      run,
      step,
      node,
      workflow,
      input: run.input,
      previousSteps: this.store.getCompletedStepOutputs(run.id),
      idempotencyKey: step.idempotencyKey,
      signal,
    };
    const output = await handler(context);
    throwIfAborted(signal);
    this.store.advanceStep(step.id, workflow.definition, output);
  }

  private executionData(run: AutomationRun): Record<string, unknown> {
    const defaultData = {
      ...run.input,
      trigger: run.input,
      steps: this.store.getCompletedStepOutputs(run.id),
    };
    return this.executionDataResolver?.(run, defaultData) ?? defaultData;
  }
}

function eventContext(event: AutomationEvent): Record<string, unknown> {
  return {
    eventType: event.eventType,
    subjectType: event.subjectType,
    subjectId: event.subjectId,
    payload: event.payload,
    occurredAt: event.occurredAt,
  };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function findNode(workflow: AutomationWorkflow, nodeId: string): AutomationNode {
  const node = workflow.definition.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`Nó ${nodeId} não existe na versão do fluxo.`);
  return node;
}

function retryDelay(node: AutomationNode): number {
  if (node.type !== "internal_action" && node.type !== "app_action") return 0;
  return node.config.retry?.delayMs ?? 0;
}

function isScheduledWait(step: AutomationRunStep): boolean {
  return (
    typeof step.output === "object" &&
    step.output !== null &&
    "__waitScheduled" in step.output
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Execução interrompida.");
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      reject(signal.reason ?? new Error("Execução interrompida."));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
