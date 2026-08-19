import { StructuredSupportAgent } from "../provider-agent.js";
import type {
  StructuredJsonClient,
  StructuredJsonRequest,
} from "../provider.js";
import {
  asRecord,
  parseStructuredJsonText,
  positiveInteger,
  postProviderJson,
  resolveEndpoint,
  type FetchImplementation,
} from "./http.js";

export interface OllamaProviderOptions {
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  attachmentsRoot?: string;
  fetchImpl?: FetchImplementation;
}

export class OllamaChatClient implements StructuredJsonClient {
  private readonly endpoint: URL;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchImplementation;

  constructor(options: Omit<OllamaProviderOptions, "model" | "attachmentsRoot">) {
    this.endpoint = resolveEndpoint(
      options.baseUrl ?? "http://127.0.0.1:11434/api",
      "chat",
    );
    this.timeoutMs = positiveInteger(options.timeoutMs, 180_000, "timeoutMs");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async generateJson(request: StructuredJsonRequest): Promise<unknown> {
    const payload = await postProviderJson({
      providerId: "ollama",
      endpoint: this.endpoint,
      body: {
        model: request.model,
        stream: false,
        format: request.schema,
        messages: [
          ...(request.instructions
            ? [{ role: "system", content: request.instructions }]
            : []),
          {
            role: "user",
            content: request.prompt,
            ...(request.images.length
              ? { images: request.images.map((image) => image.dataBase64) }
              : {}),
          },
        ],
        options: { temperature: 0 },
      },
      timeoutMs: this.timeoutMs,
      signal: request.signal,
      fetchImpl: this.fetchImpl,
    });
    const root = asRecord(payload);
    const message = asRecord(root?.message);
    return parseStructuredJsonText("ollama", message?.content);
  }
}

export class OllamaSupportAgent extends StructuredSupportAgent {
  constructor(options: OllamaProviderOptions) {
    super({
      providerId: "ollama",
      model: options.model,
      attachmentsRoot: options.attachmentsRoot,
      client: new OllamaChatClient(options),
    });
  }
}
