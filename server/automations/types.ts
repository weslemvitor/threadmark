export const AUTOMATION_NODE_TYPES = [
  "trigger",
  "condition",
  "wait",
  "approval",
  "internal_action",
  "app_action",
] as const;

export type AutomationNodeType = (typeof AUTOMATION_NODE_TYPES)[number];

export type WorkflowStatus = "draft" | "active" | "paused" | "archived";

export type AutomationRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type AutomationStepStatus =
  | "queued"
  | "running"
  | "sleeping"
  | "awaiting_approval"
  | "retry"
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped";

export type AutomationComparisonOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "exists"
  | "not_exists"
  | "greater_than"
  | "greater_than_or_equal"
  | "less_than"
  | "less_than_or_equal";

export interface AutomationFilter {
  field: string;
  operator: AutomationComparisonOperator;
  value?: unknown;
}

export interface AutomationRetryPolicy {
  maxAttempts: number;
  delayMs: number;
}

export interface AutomationTriggerConfig {
  eventType: string;
  filters?: AutomationFilter[];
}

export type AutomationConditionConfig = AutomationFilter;

export interface AutomationWaitConfig {
  durationMs: number;
}

export interface AutomationApprovalConfig {
  instructions?: string;
}

export interface AutomationInternalActionConfig {
  actionId: string;
  input?: Record<string, unknown>;
  retry?: AutomationRetryPolicy;
}

export interface AutomationAppActionConfig {
  appId: string;
  actionId: string;
  input?: Record<string, unknown>;
  retry?: AutomationRetryPolicy;
}

export type AutomationNode =
  | AutomationNodeOfType<"trigger", AutomationTriggerConfig>
  | AutomationNodeOfType<"condition", AutomationConditionConfig>
  | AutomationNodeOfType<"wait", AutomationWaitConfig>
  | AutomationNodeOfType<"approval", AutomationApprovalConfig>
  | AutomationNodeOfType<"internal_action", AutomationInternalActionConfig>
  | AutomationNodeOfType<"app_action", AutomationAppActionConfig>;

interface AutomationNodeOfType<Type extends AutomationNodeType, Config> {
  id: string;
  type: Type;
  name?: string;
  position?: { x: number; y: number };
  config: Config;
}

export interface AutomationEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
}

export interface AutomationWorkflowDefinition {
  nodes: AutomationNode[];
  edges: AutomationEdge[];
}

export type AutomationWorkflowLayout = Record<
  string,
  { x: number; y: number }
>;

export interface AutomationWorkflow {
  id: string;
  name: string;
  description: string | null;
  status: WorkflowStatus;
  activationEventSequence: number | null;
  currentVersion: number;
  definition: AutomationWorkflowDefinition;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationEventInput {
  eventType: string;
  subjectType: string;
  subjectId: string;
  payload?: Record<string, unknown>;
  occurredAt?: string;
  idempotencyKey: string;
}

export interface AutomationEvent {
  id: string;
  eventType: string;
  subjectType: string;
  subjectId: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  state: "queued" | "processing" | "completed" | "failed";
}

export interface AutomationRun {
  id: string;
  workflowId: string;
  workflowVersion: number;
  eventId: string | null;
  idempotencyKey: string;
  status: AutomationRunStatus;
  input: Record<string, unknown>;
  definition: AutomationWorkflowDefinition | null;
  lastError: string | null;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
}

export interface AutomationRunStep {
  id: string;
  runId: string;
  nodeId: string;
  nodeType: AutomationNodeType;
  status: AutomationStepStatus;
  attemptCount: number;
  maxAttempts: number;
  idempotencyKey: string;
  input: Record<string, unknown>;
  output: unknown;
  availableAt: string;
  leaseExpiresAt: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationActionContext {
  run: AutomationRun;
  step: AutomationRunStep;
  node: AutomationNode;
  workflow: AutomationWorkflow;
  input: Record<string, unknown>;
  previousSteps: Record<string, unknown>;
  idempotencyKey: string;
  signal?: AbortSignal;
}

export type AutomationActionHandler = (
  context: AutomationActionContext,
) => Promise<unknown> | unknown;

export interface AutomationActionHandlers {
  internal?: Record<string, AutomationActionHandler>;
  apps?: Record<string, Record<string, AutomationActionHandler>>;
}

export interface AutomationEngineOptions {
  leaseMs?: number;
  pollIntervalMs?: number;
  eventRetryDelayMs?: number;
  clock?: () => Date;
  executionDataResolver?: (
    run: AutomationRun,
    defaultData: Record<string, unknown>,
  ) => Record<string, unknown>;
}

export interface AutomationDispatchResult {
  event: AutomationEvent;
  created: boolean;
}

export interface AutomationTickResult {
  kind: "event" | "step" | "idle";
  id?: string;
}
