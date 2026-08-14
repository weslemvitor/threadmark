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

export interface OpenAIProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
  attachmentsRoot?: string;
  fetchImpl?: FetchImplementation;
}

export class OpenAIResponsesClient implements StructuredJsonClient {
  readonly #apiKey: string;
  private readonly endpoint: URL;
  private readonly timeoutMs: number;
  private readonly maxOutputTokens: number;
  private readonly fetchImpl: FetchImplementation;

  constructor(options: Omit<OpenAIProviderOptions, "model" | "attachmentsRoot">) {
    this.#apiKey = requiredSecret(options.apiKey);
    this.endpoint = resolveEndpoint(
      options.baseUrl ?? "https://api.openai.com/v1",
      "responses",
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
      { type: "input_text", text: request.prompt },
      ...request.images.map((image) => ({
        type: "input_image",
        image_url: `data:${image.mimeType};base64,${image.dataBase64}`,
      })),
    ];
    const payload = await postProviderJson({
      providerId: "openai",
      endpoint: this.endpoint,
      headers: { authorization: `Bearer ${this.#apiKey}` },
      body: {
        model: request.model,
        store: false,
        max_output_tokens: this.maxOutputTokens,
        input: [{ role: "user", content }],
        text: {
          format: {
            type: "json_schema",
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
    return parseStructuredJsonText("openai", extractOpenAIOutputText(payload));
  }
}

export class OpenAISupportAgent extends StructuredSupportAgent {
  constructor(options: OpenAIProviderOptions) {
    super({
      providerId: "openai",
      model: options.model,
      attachmentsRoot: options.attachmentsRoot,
      client: new OpenAIResponsesClient(options),
    });
  }
}

function extractOpenAIOutputText(payload: unknown): string | null {
  const root = asRecord(payload);
  if (!root) return null;
  if (typeof root.output_text === "string") return root.output_text;

  for (const item of asArray(root.output)) {
    const output = asRecord(item);
    if (!output) continue;
    for (const part of asArray(output.content)) {
      const content = asRecord(part);
      if (
        content?.type === "output_text" &&
        typeof content.text === "string"
      ) {
        return content.text;
      }
    }
  }
  return null;
}
