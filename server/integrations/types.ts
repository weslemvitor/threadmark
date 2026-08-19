export type IntegrationAppId =
  | "threadmark"
  | "slack-webhook"
  | "custom-http";

export type IntegrationCapability =
  | "ticket_management"
  | "internal_note"
  | "external_notification"
  | "http_request";

export type IntegrationExecutionMode = "internal" | "external";
export type IntegrationIdempotencyMode = "engine" | "provider";

export interface IntegrationActionDescriptor<
  TAppId extends string = IntegrationAppId,
  TActionId extends string = string,
> {
  appId: TAppId;
  id: TActionId;
  name: string;
  description: string;
  capability: IntegrationCapability;
  executionMode: IntegrationExecutionMode;
  /**
   * `engine` means the automation runtime must persist the execution key before
   * calling the connector. `provider` means the connector also forwards it to
   * a provider that supports idempotency.
   */
  idempotency: IntegrationIdempotencyMode;
}
export interface IntegrationAppDescriptor<TAppId extends string = IntegrationAppId> {
  id: TAppId;
  name: string;
  description: string;
  category: "threadmark" | "communication" | "developer";
  capabilities: readonly IntegrationCapability[];
  actions: readonly IntegrationActionDescriptor<TAppId>[];
}

export interface IntegrationExecutionContext {
  executionId: string;
  idempotencyKey: string;
  automationId: string;
  nodeId: string;
  signal?: AbortSignal;
}

export interface IntegrationExecutionResult {
  ok: boolean;
  status: number;
  requestId: string | null;
  /** Provider output is bounded and redacted before it reaches the engine. */
  output: unknown;
  truncated: boolean;
}

/** Minimum surface accepted from LocalSecretVault. */
export interface IntegrationSecretVault {
  get(reference: string): Promise<string | null>;
}

export interface IntegrationActionExecutor<TConfig, TInput> {
  execute(
    config: TConfig,
    input: TInput,
    context: IntegrationExecutionContext,
  ): Promise<IntegrationExecutionResult>;
}
