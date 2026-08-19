import { CUSTOM_HTTP_APP } from "./connectors/custom-http.js";
import { SLACK_WEBHOOK_APP } from "./connectors/slack-webhook.js";
import { THREADMARK_APP } from "./connectors/threadmark.js";
import { IntegrationRegistry } from "./registry.js";

export * from "./connectors/custom-http.js";
export * from "./connectors/slack-webhook.js";
export * from "./connectors/threadmark.js";
export * from "./connected-app-service.js";
export * from "./http-executor.js";
export * from "./registry.js";
export * from "./template.js";
export * from "./types.js";
export * from "./validation.js";

export function createDefaultIntegrationRegistry(): IntegrationRegistry {
  return new IntegrationRegistry()
    .register(THREADMARK_APP)
    .register(SLACK_WEBHOOK_APP)
    .register(CUSTOM_HTTP_APP);
}
