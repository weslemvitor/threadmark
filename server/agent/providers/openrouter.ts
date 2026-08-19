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

export interface OpenRouterProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
  appUrl?: string;
  appName?: string;
  attachmentsRoot?: string;
  fetchImpl?: FetchImplementation;
}

export class OpenRouterChatClient implements StructuredJsonClient {
  readonly #apiKey: string;
  private readonly endpoint: URL;
  private readonly timeoutMs: number;
  private readonly maxOutputTokens: number;
  private readonly appUrl: string | null;
  private readonly appName: string | null;
  private readonly fetchImpl: FetchImplementation;

  constructor(
    options: Omit<OpenRouterProviderOptions, "model" | "attachmentsRoot">,
  ) {
    this.#apiKey = requiredSecret(options.apiKey);
    this.endpoint = resolveEndpoint(
      options.baseUrl ?? "https://openrouter.ai/api/v1",
      "chat/completions",
    );
    this.timeoutMs = positiveInteger(options.timeoutMs, 120_000, "timeoutMs");
    this.maxOutputTokens = positiveInteger(
      options.maxOutputTokens,
      8_192,
      "maxOutputTokens",
    );
    this.appUrl = options.appUrl?.trim() || null;
    this.appName = options.appName?.trim() || null;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async generateJson(request: StructuredJsonRequest): Promise<unknown> {
    const content: Array<Record<string, unknown>> = [
      { type: "text", text: request.prompt },
      ...request.images.map((image) => ({
        type: "image_url",
        image_url: {
          url: `data:${image.mimeType};base64,${image.dataBase64}`,
        },
      })),
    ];
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#apiKey}`,
    };
    if (this.appUrl) headers["HTTP-Referer"] = this.appUrl;
    if (this.appName) headers["X-Title"] = this.appName;

    const payload = await postProviderJson({
      providerId: "openrouter",
      endpoint: this.endpoint,
      headers,
      body: {
        model: request.model,
        max_tokens: this.maxOutputTokens,
        messages: [
          ...(request.instructions
            ? [{ role: "system", content: request.instructions }]
            : []),
          { role: "user", content },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: request.schemaName,
            strict: true,
            schema: request.schema,
          },
        },
      },
      timeoutMs: this.timeoutMs,
      signal: request.signal,
      fetchImpl: this.fetchImpl,
    });
    return parseStructuredJsonText(
      "openrouter",
      extractOpenRouterOutputText(payload),
    );
  }
}

export class OpenRouterSupportAgent extends StructuredSupportAgent {
  constructor(options: OpenRouterProviderOptions) {
    super({
      providerId: "openrouter",
      model: options.model,
      attachmentsRoot: options.attachmentsRoot,
      client: new OpenRouterChatClient(options),
    });
  }
}

function extractOpenRouterOutputText(payload: unknown): string | null {
  const root = asRecord(payload);
  const choice = asRecord(asArray(root?.choices)[0]);
  const message = asRecord(choice?.message);
  if (typeof message?.content === "string") return message.content;

  for (const part of asArray(message?.content)) {
    const content = asRecord(part);
    if (content?.type === "text" && typeof content.text === "string") {
      return content.text;
    }
  }
  return null;
}
