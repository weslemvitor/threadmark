import { StructuredSupportAgent } from "../provider-agent.js";
import type {
  StructuredJsonClient,
  StructuredJsonRequest,
} from "../provider.js";
import {
  asArray,
  asRecord,
  parseStructuredJsonText,
  positiveInteger,
  postProviderJson,
  requiredSecret,
  resolveEndpoint,
  type FetchImplementation,
} from "./http.js";

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  apiVersion?: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
  attachmentsRoot?: string;
  fetchImpl?: FetchImplementation;
}

export class AnthropicMessagesClient implements StructuredJsonClient {
  readonly #apiKey: string;
  private readonly apiVersion: string;
  private readonly endpoint: URL;
  private readonly timeoutMs: number;
  private readonly maxOutputTokens: number;
  private readonly fetchImpl: FetchImplementation;

  constructor(
    options: Omit<AnthropicProviderOptions, "model" | "attachmentsRoot">,
  ) {
    this.#apiKey = requiredSecret(options.apiKey);
    this.apiVersion = options.apiVersion?.trim() || "2023-06-01";
    this.endpoint = resolveEndpoint(
      options.baseUrl ?? "https://api.anthropic.com/v1",
      "messages",
    );
    this.timeoutMs = positiveInteger(options.timeoutMs, 120_000, "timeoutMs");
    this.maxOutputTokens = positiveInteger(
      options.maxOutputTokens,
      8_192,
      "maxOutputTokens",
    );
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async generateJson(request: StructuredJsonRequest): Promise<unknown> {
    const content: Array<Record<string, unknown>> = [
      { type: "text", text: request.prompt },
      ...request.images.map((image) => ({
        type: "image",
        source: {
          type: "base64",
          media_type: image.mimeType,
          data: image.dataBase64,
        },
      })),
    ];
    const payload = await postProviderJson({
      providerId: "anthropic",
      endpoint: this.endpoint,
      headers: {
        "x-api-key": this.#apiKey,
        "anthropic-version": this.apiVersion,
      },
      body: {
        model: request.model,
        max_tokens: this.maxOutputTokens,
        messages: [{ role: "user", content }],
        output_config: {
          format: {
            type: "json_schema",
            schema: request.schema,
          },
        },
      },
      timeoutMs: this.timeoutMs,
      signal: request.signal,
      fetchImpl: this.fetchImpl,
    });
    return parseStructuredJsonText(
      "anthropic",
      extractAnthropicOutputText(payload),
    );
  }
}

export class AnthropicSupportAgent extends StructuredSupportAgent {
  constructor(options: AnthropicProviderOptions) {
    super({
      providerId: "anthropic",
      model: options.model,
      attachmentsRoot: options.attachmentsRoot,
      client: new AnthropicMessagesClient(options),
    });
  }
}

function extractAnthropicOutputText(payload: unknown): string | null {
  const root = asRecord(payload);
  if (!root) return null;
  for (const part of asArray(root.content)) {
    const content = asRecord(part);
    if (content?.type === "text" && typeof content.text === "string") {
      return content.text;
    }
  }
  return null;
}
