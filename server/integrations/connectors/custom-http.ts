import { z } from "zod";

import {
  executeExternalHttp,
  type ExternalHttpExecutorOptions,
} from "../http-executor.js";
import { renderJsonTemplate, validateJsonTemplate } from "../template.js";
import type {
  IntegrationActionExecutor,
  IntegrationExecutionContext,
  IntegrationSecretVault,
} from "../types.js";
import {
  idempotencyKeySchema,
  publicHeaderSchema,
  safeHttpUrlSchema,
  secretHeaderSchema,
  timeoutSchema,
} from "../validation.js";

export const customHttpConfigSchema = z
  .object({
    endpoint: safeHttpUrlSchema.transform((value) => value.toString()),
    method: z.enum(["POST", "PUT", "PATCH", "DELETE"]).default("POST"),
    publicHeaders: z.array(publicHeaderSchema).max(30).default([]),
    secretHeaders: z.array(secretHeaderSchema).max(20).default([]),
    bodyTemplate: z.unknown().refine((value) => value !== undefined, "Informe o corpo da requisição"),
    idempotencyHeader: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/)
      .nullable()
      .default("Idempotency-Key"),
    timeoutMs: timeoutSchema,
    allowPrivateNetwork: z.boolean().default(false),
  })
  .strict()
  .superRefine((config, context) => {
    try {
      validateJsonTemplate(config.bodyTemplate);
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["bodyTemplate"],
        message: error instanceof Error ? error.message : "Template inválido",
      });
    }
    const names = [
      ...config.publicHeaders.map((header) => header.name.toLowerCase()),
      ...config.secretHeaders.map((header) => header.name.toLowerCase()),
    ];
    if (new Set(names).size !== names.length) {
      context.addIssue({ code: "custom", path: ["publicHeaders"], message: "Header duplicado" });
    }
    const idempotencyName = config.idempotencyHeader?.toLowerCase();
    if (idempotencyName && names.includes(idempotencyName)) {
      context.addIssue({
        code: "custom",
        path: ["idempotencyHeader"],
        message: "O header de idempotência é controlado pelo Threadmark",
      });
    }
  });

export const customHttpInputSchema = z
  .object({
    variables: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export type CustomHttpConfig = z.input<typeof customHttpConfigSchema>;
export type CustomHttpInput = z.input<typeof customHttpInputSchema>;

export function createCustomHttpExecutor(
  vault: IntegrationSecretVault,
  options: ExternalHttpExecutorOptions = {},
): IntegrationActionExecutor<CustomHttpConfig, CustomHttpInput> {
  return {
    async execute(config, input, context) {
      const parsedConfig = customHttpConfigSchema.parse(config);
      const parsedInput = customHttpInputSchema.parse(input);
      assertExecutionContext(context);
      const headers: Record<string, string> = Object.fromEntries(
        parsedConfig.publicHeaders.map(({ name, value }) => [name, value]),
      );
      const secretValues: string[] = [];
      for (const secretHeader of parsedConfig.secretHeaders) {
        const secret = await vault.get(secretHeader.secretRef);
        if (!secret) {
          throw new TypeError(`O segredo do header ${secretHeader.name} não está disponível.`);
        }
        headers[secretHeader.name] = secret;
        secretValues.push(secret);
      }

      return executeExternalHttp(
        {
          endpoint: parsedConfig.endpoint,
          method: parsedConfig.method,
          headers,
          body: renderJsonTemplate(parsedConfig.bodyTemplate, parsedInput.variables),
          idempotencyKey: context.idempotencyKey,
          idempotencyHeader: parsedConfig.idempotencyHeader,
          timeoutMs: parsedConfig.timeoutMs,
          allowPrivateNetwork: parsedConfig.allowPrivateNetwork,
          secretValues,
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
