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
