import type {
  InvestigationThreadInput,
  InvestigationTurnResult,
  SupportAnalysis,
  SupportAnalysisInput,
  TriageAnalysis,
  TriageAnalysisInput,
} from "./types.js";

export type AiProviderId =
  | "codex"
  | "openai"
  | "anthropic"
  | "openrouter"
  | "ollama";

export type ImageInputCapability =
  | "supported"
  | "model_dependent"
  | "none";

export interface AiProviderCapabilities {
  automaticAnalysis: boolean;
  triage: boolean;
  deepInvestigation: boolean;
  codebaseAccess: boolean;
  structuredOutput: boolean;
  imageInput: ImageInputCapability;
  requiresApiKey: boolean;
  localExecution: boolean;
}

export const AI_PROVIDER_CAPABILITIES: Readonly<
  Record<AiProviderId, Readonly<AiProviderCapabilities>>
> = Object.freeze({
  codex: Object.freeze({
    automaticAnalysis: true,
    triage: true,
    deepInvestigation: true,
    codebaseAccess: true,
    structuredOutput: true,
    imageInput: "supported",
    requiresApiKey: false,
    localExecution: true,
  }),
  openai: Object.freeze({
    automaticAnalysis: true,
    triage: true,
    deepInvestigation: true,
    codebaseAccess: false,
    structuredOutput: true,
    imageInput: "model_dependent",
    requiresApiKey: true,
    localExecution: false,
  }),
  anthropic: Object.freeze({
    automaticAnalysis: true,
    triage: true,
    deepInvestigation: true,
    codebaseAccess: false,
    structuredOutput: true,
    imageInput: "model_dependent",
    requiresApiKey: true,
    localExecution: false,
  }),
  openrouter: Object.freeze({
    automaticAnalysis: true,
    triage: true,
    deepInvestigation: true,
    codebaseAccess: false,
    structuredOutput: true,
    imageInput: "model_dependent",
    requiresApiKey: true,
    localExecution: false,
  }),
  ollama: Object.freeze({
    automaticAnalysis: true,
    triage: true,
    deepInvestigation: true,
    codebaseAccess: false,
    structuredOutput: true,
    imageInput: "model_dependent",
    requiresApiKey: false,
    localExecution: true,
  }),
});

/** Common contract consumed by the investigation worker. */
export interface SupportAgent {
  readonly providerId: AiProviderId;
  readonly capabilities: Readonly<AiProviderCapabilities>;

  analyse(
    input: SupportAnalysisInput,
    signal?: AbortSignal,
  ): Promise<SupportAnalysis>;

  investigateThread(
    input: InvestigationThreadInput,
    signal?: AbortSignal,
  ): Promise<InvestigationTurnResult>;

  triage(
    input: TriageAnalysisInput,
    model: string,
    signal?: AbortSignal,
  ): Promise<TriageAnalysis>;
}

export interface JsonSchemaDocument {
  readonly [key: string]: unknown;
}

export interface ProviderImage {
  mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  dataBase64: string;
}

export interface StructuredJsonRequest {
  prompt: string;
  schemaName: string;
  schema: JsonSchemaDocument;
  model: string;
  images: ProviderImage[];
  signal?: AbortSignal;
}

export interface StructuredJsonClient {
  generateJson(request: StructuredJsonRequest): Promise<unknown>;
}

export class ProviderCapabilityError extends Error {
  constructor(
    readonly providerId: AiProviderId,
    readonly capability: keyof AiProviderCapabilities,
  ) {
    super(
      `O provedor ${providerId} não oferece a capacidade ${capability} neste modo.`,
    );
    this.name = "ProviderCapabilityError";
  }
}

export class ProviderRequestError extends Error {
  constructor(
    readonly providerId: Exclude<AiProviderId, "codex">,
    message: string,
    readonly status: number | null = null,
    readonly requestId: string | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProviderRequestError";
  }
}

export class ProviderOutputError extends Error {
  constructor(
    readonly providerId: Exclude<AiProviderId, "codex">,
    message = "O provedor devolveu uma saída estruturada inválida.",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProviderOutputError";
  }
}
