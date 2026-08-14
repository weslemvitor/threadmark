import type { CodexSupportAgent } from "./codex-runner.js";
import {
  CodexProviderAdapter,
} from "./provider-agent.js";
import type { SupportAgent } from "./provider.js";
import {
  AnthropicSupportAgent,
  type AnthropicProviderOptions,
} from "./providers/anthropic.js";
import {
  OllamaSupportAgent,
  type OllamaProviderOptions,
} from "./providers/ollama.js";
import {
  OpenAISupportAgent,
  type OpenAIProviderOptions,
} from "./providers/openai.js";
import {
  OpenRouterSupportAgent,
  type OpenRouterProviderOptions,
} from "./providers/openrouter.js";

export type SupportAgentProviderConfig =
  | {
      providerId: "codex";
      agent: CodexSupportAgent;
      model: string;
    }
  | ({ providerId: "openai" } & OpenAIProviderOptions)
  | ({ providerId: "anthropic" } & AnthropicProviderOptions)
  | ({ providerId: "openrouter" } & OpenRouterProviderOptions)
  | ({ providerId: "ollama" } & OllamaProviderOptions);

/**
 * Creates an in-memory provider instance. The caller remains responsible for
 * loading credentials from its protected secret store and never persists them
 * through this factory.
 */
export function createSupportAgent(
  config: SupportAgentProviderConfig,
): SupportAgent {
  switch (config.providerId) {
    case "codex":
      return new CodexProviderAdapter(config.agent, config.model);
    case "openai":
      return new OpenAISupportAgent(config);
    case "anthropic":
      return new AnthropicSupportAgent(config);
    case "openrouter":
      return new OpenRouterSupportAgent(config);
    case "ollama":
      return new OllamaSupportAgent(config);
  }
}
