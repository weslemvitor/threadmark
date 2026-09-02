import { z } from "zod";

import {
  executeExternalHttp,
  type ExternalHttpExecutorOptions,
} from "../http-executor.js";
import type {
  IntegrationActionExecutor,
  IntegrationExecutionContext,
  IntegrationSecretVault,
} from "../types.js";
import {
  idempotencyKeySchema,
  safeHttpUrlSchema,
  secretReferenceSchema,
  timeoutSchema,
} from "../validation.js";

export const slackWebhookConfigSchema = z
  .object({
    webhookSecretRef: secretReferenceSchema,
    timeoutMs: timeoutSchema,
    allowPrivateNetwork: z.boolean().default(false),
  })
  .strict();

export const slackMessageInputSchema = z
  .object({
    text: z.string().trim().min(1).max(4_000),
  })
  .strict();

export type SlackWebhookConfig = z.input<typeof slackWebhookConfigSchema>;
export type SlackMessageInput = z.input<typeof slackMessageInputSchema>;

export function createSlackWebhookExecutor(
  vault: IntegrationSecretVault,
  options: ExternalHttpExecutorOptions = {},
): IntegrationActionExecutor<SlackWebhookConfig, SlackMessageInput> {
  return {
    async execute(config, input, context) {
      const parsedConfig = slackWebhookConfigSchema.parse(config);
      const parsedInput = slackMessageInputSchema.parse(input);
      assertExecutionContext(context);
      const webhookUrl = await vault.get(parsedConfig.webhookSecretRef);
      if (!webhookUrl) throw new TypeError("O webhook do Slack não está disponível no cofre local.");
      safeHttpUrlSchema.parse(webhookUrl);

      return executeExternalHttp(
        {
          endpoint: webhookUrl,
          method: "POST",
          body: { text: parsedInput.text },
          idempotencyKey: context.idempotencyKey,
          // Slack Incoming Webhooks do not expose an idempotency contract.
          // The durable automation engine owns deduplication for this action.
          idempotencyHeader: null,
          timeoutMs: parsedConfig.timeoutMs,
          allowPrivateNetwork: parsedConfig.allowPrivateNetwork,
          secretValues: [webhookUrl],
          ...(context.signal ? { signal: context.signal } : {}),
        },
        options,
      );
    },
  };
}
function assertExecutionContext(context: IntegrationExecutionContext): void {
  idempotencyKeySchema.parse(context.idempotencyKey);
  for (const value of [context.executionId, context.automationId, context.nodeId]) {
    if (!value || value.length > 200) throw new TypeError("Contexto de execução inválido.");
  }
}
