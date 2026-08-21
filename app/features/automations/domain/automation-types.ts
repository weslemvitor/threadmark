export type AutomationStatus = "draft" | "active" | "paused" | "archived";

export type AutomationRuntimeNodeType =
  | "trigger"
  | "condition"
  | "wait"
  | "approval"
  | "internal_action"
  | "app_action";

export type AutomationNodeCategory =
  | "trigger"
  | "flow_control"
  | "internal_action"
  | "connected_app";

export type AutomationFieldType =
  | "text"
  | "textarea"
  | "number"
  | "duration"
  | "select"
  | "boolean";

export type AutomationNodeConfigValue =
  | string
  | number
  | boolean
  | null
  | AutomationNodeConfig
  | AutomationNodeConfigValue[];
export interface AutomationNodeConfig {
  [key: string]: AutomationNodeConfigValue;
}

export type AutomationNodePosition = {
  x: number;
  y: number;
};

export type AutomationNodeDto = {
  id: string;
  type: AutomationRuntimeNodeType;
  name?: string;
  position: AutomationNodePosition;
  config: AutomationNodeConfig;
};

export type AutomationEdgeDto = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  label?: string | null;
};

export type AutomationDefinition = {
  version: number;
  nodes: AutomationNodeDto[];
  edges: AutomationEdgeDto[];
};

export type AutomationSummary = {
  id: string;
  name: string;
  description: string | null;
  status: AutomationStatus;
  nodeCount: number;
  runCount: number;
  lastRunAt: string | null;
  updatedAt: string;
};

export type AutomationDetail = AutomationSummary & {
  definition: AutomationDefinition;
  createdAt: string;
};

export type AutomationExecutionStatus =
  | "queued"
  | "running"
  | "waiting"
  | "paused"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type AutomationExecutionStepStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "skipped"
  | "waiting";

export type AutomationExecutionStep = {
  nodeId: string;
  nodeType: AutomationRuntimeNodeType;
  label: string;
  status: AutomationExecutionStepStatus;
  detail: string;
};

export type AutomationExecution = {
  id: string;
  automationId: string;
  status: AutomationExecutionStatus;
  triggerLabel: string;
  currentNodeLabel: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  stepsCompleted: number;
  stepsTotal: number;
  dryRun: boolean;
  steps: AutomationExecutionStep[];
};

export type AutomationListResponse = {
  items: AutomationSummary[];
};

export type AutomationNodeField = {
  key: string;
  label: string;
  description?: string;
  type: AutomationFieldType;
  required?: boolean;
  min?: number;
  max?: number;
  placeholder?: string;
  options?: Array<{ label: string; value: string }>;
  defaultValue?: AutomationNodeConfigValue;
  storageMultiplier?: number;
  durationUnitKey?: string;
  durationUnits?: Array<{
    label: string;
    value: string;
    multiplier: number;
  }>;
  /** Exibe o seletor de dados dinâmicos disponíveis durante a execução. */
  supportsVariables?: boolean;
};

export type AutomationNodeDefinition = {
  id: string;
  nodeType: AutomationRuntimeNodeType;
  category: AutomationNodeCategory;
  label: string;
  description: string;
  icon: string;
  accent: "violet" | "blue" | "amber" | "emerald";
  fields: AutomationNodeField[];
  connected?: boolean;
  connectionLabel?: string;
  terminal?: boolean;
  baseConfig?: AutomationNodeConfig;
};

export type ConnectedAppType = "slack_webhook" | "intercom" | "custom_http" | "mcp_remote";
export type ConnectedAppStatus = "active" | "disabled" | "error";

export type ConnectedAppSummary = {
  id: string;
  type: ConnectedAppType;
  name: string;
  description: string | null;
  status: ConnectedAppStatus;
  aiEnabled: boolean;
  secretConfigured: boolean;
  endpointPreview: string | null;
  allowPrivateNetwork?: boolean;
  lastTestAt: string | null;
  lastTestSucceeded: boolean | null;
  updatedAt: string;
  actions?: Array<{
    id: string;
    name: string;
    description: string;
    inputSchema?: Record<string, unknown>;
    annotations?: {
      readOnlyHint: boolean;
      destructiveHint: boolean;
      idempotentHint: boolean;
      openWorldHint: boolean;
    };
    aiEnabled?: boolean;
    automationEnabled?: boolean;
    confirmationRequired?: boolean;
  }>;
};

export type ConnectedAppListResponse = {
  items: ConnectedAppSummary[];
};

export type UpsertConnectedAppInput = {
  type: ConnectedAppType;
  name: string;
  description?: string | null;
  enabled: boolean;
  aiEnabled: boolean;
  endpoint: string;
  secret?: string;
  headers?: Record<string, string>;
  allowPrivateNetwork?: boolean;
  mcpTools?: Array<{
    name: string;
    aiEnabled: boolean;
    automationEnabled: boolean;
    confirmationRequired: boolean;
  }>;
};

export type AutomationValidationIssue = {
  id: string;
  nodeId: string | null;
  message: string;
  severity: "error" | "warning";
};

export type CreateAutomationInput = {
  name: string;
  description?: string | null;
};

export type UpdateAutomationInput = {
  name: string;
  description: string | null;
  definition: AutomationDefinition;
};

export type UpdateAutomationLayoutInput = {
  nodes: Array<{
    id: string;
    position: AutomationNodePosition;
  }>;
};

export type UpdateAutomationMetadataInput = {
  name: string;
  description: string | null;
};
