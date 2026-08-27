import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import {
  buildInvestigationThreadPrompt,
  buildDocumentationPrompt,
  DOCUMENTATION_PROMPT_INSTRUCTIONS,
  buildKnowledgeExtractionPrompt,
  KNOWLEDGE_EXTRACTION_PROMPT_INSTRUCTIONS,
  buildSupportPrompt,
  buildTriagePrompt,
} from "./prompt.js";
import {
  AI_PROVIDER_CAPABILITIES,
  type AiProviderCapabilities,
  type AiProviderId,
  type ProviderImage,
  type StructuredJsonClient,
  type SupportAgent,
} from "./provider.js";
import {
  INVESTIGATION_TURN_JSON_SCHEMA,
  SUPPORT_ANALYSIS_JSON_SCHEMA,
  TRIAGE_ANALYSIS_JSON_SCHEMA,
  DOCUMENTATION_DRAFT_JSON_SCHEMA,
  KNOWLEDGE_EXTRACTION_JSON_SCHEMA,
} from "./provider-schemas.js";
import {
  boundProviderSupportInput,
  boundProviderDocumentationInput,
  boundProviderTriageInput,
} from "./provider-input.js";
import type { CodexSupportAgent } from "./codex-runner.js";
import type {
  AnalysisMessage,
  DocumentationDraftInput,
  DocumentationDraftResult,
  KnowledgeExtractionInput,
  KnowledgeExtractionResult,
  InvestigationThreadInput,
  InvestigationTurnResult,
  SupportAnalysis,
  SupportAnalysisInput,
  TriageAnalysis,
  TriageAnalysisInput,
} from "./types.js";
import {
  parseInvestigationTurnResult,
  parseDocumentationDraft,
  parseKnowledgeExtraction,
  parseSupportAnalysis,
  triageAnalysisSchema,
} from "./validation.js";

const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 25 * 1024 * 1024;

const SUPPORTED_IMAGE_MIME_TYPES = new Set<ProviderImage["mimeType"]>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const MIME_TYPE_BY_EXTENSION: Record<string, ProviderImage["mimeType"]> = {
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export interface StructuredSupportAgentOptions {
  providerId: Exclude<AiProviderId, "codex">;
  model: string;
  attachmentsRoot?: string;
  client: StructuredJsonClient;
}

/**
 * Shared implementation for providers that can analyse supplied context but
 * cannot execute tools or inspect the local codebase.
 */
export class StructuredSupportAgent implements SupportAgent {
  readonly providerId: Exclude<AiProviderId, "codex">;
  readonly capabilities: Readonly<AiProviderCapabilities>;
  private readonly model: string;
  private readonly attachmentsRoot: string | null;
  private readonly client: StructuredJsonClient;

  constructor(options: StructuredSupportAgentOptions) {
    this.providerId = options.providerId;
    this.capabilities = AI_PROVIDER_CAPABILITIES[options.providerId];
    this.model = requireNonEmpty(options.model, "model");
    this.attachmentsRoot = options.attachmentsRoot
      ? path.resolve(options.attachmentsRoot)
      : null;
    this.client = options.client;
  }

  async analyse(
    input: SupportAnalysisInput,
    signal?: AbortSignal,
  ): Promise<SupportAnalysis> {
    const boundedInput = boundProviderSupportInput(input);
    const raw = await this.client.generateJson({
      prompt: buildSupportPrompt(boundedInput),
      schemaName: "support_analysis",
      schema: SUPPORT_ANALYSIS_JSON_SCHEMA,
      model: this.model,
      images: await this.collectTrustedImages(input.messages),
      signal,
    });
    return parseSupportAnalysis(raw, boundedInput);
  }

  async investigateThread(
    input: InvestigationThreadInput,
    signal?: AbortSignal,
  ): Promise<InvestigationTurnResult> {
    const boundedInput: InvestigationThreadInput = {
      ...input,
      ticket: boundProviderSupportInput(input.ticket),
      relatedTickets: (input.relatedTickets ?? [])
        .slice(0, 4)
        .map((ticket) => boundProviderSupportInput(ticket)),
    };
    const raw = await this.client.generateJson({
      prompt: buildInvestigationThreadPrompt(boundedInput),
      schemaName: "investigation_turn",
      schema: INVESTIGATION_TURN_JSON_SCHEMA,
      model: this.model,
      images: await this.collectTrustedImages(
        input.imageAnalysisApproved
          ? approvedInvestigationImageMessages(input)
          : input.ticket.messages,
      ),
      signal,
    });
    return parseInvestigationTurnResult(raw, boundedInput);
  }

  async triage(
    input: TriageAnalysisInput,
    model: string,
    signal?: AbortSignal,
  ): Promise<TriageAnalysis> {
    assertValidTriageInput(input);
    const boundedInput = boundProviderTriageInput(input);
    const raw = await this.client.generateJson({
      prompt: buildTriagePrompt(boundedInput),
      schemaName: "triage_analysis",
      schema: TRIAGE_ANALYSIS_JSON_SCHEMA,
      model: model.trim() || this.model,
      images: await this.collectTrustedImages(
        orderedTriageMessages(input),
      ),
      signal,
    });
    const result = triageAnalysisSchema.parse(raw);
    assertExactTriageCoverage(boundedInput, result);
    return result;
  }

  async generateDocumentation(
    input: DocumentationDraftInput,
    signal?: AbortSignal,
  ): Promise<DocumentationDraftResult> {
    const boundedInput = boundProviderDocumentationInput(input);
    const raw = await this.client.generateJson({
      instructions: DOCUMENTATION_PROMPT_INSTRUCTIONS,
      prompt: buildDocumentationPrompt(boundedInput),
      schemaName: "documentation_draft",
      schema: DOCUMENTATION_DRAFT_JSON_SCHEMA,
      model: this.model,
      images: await this.collectTrustedImages(input.messages),
      signal,
    });
    return parseDocumentationDraft(raw, boundedInput);
  }

  async extractKnowledge(
    input: KnowledgeExtractionInput,
    signal?: AbortSignal,
  ): Promise<KnowledgeExtractionResult> {
    const boundedInput = boundProviderDocumentationInput(input) as KnowledgeExtractionInput;
    const raw = await this.client.generateJson({
      instructions: KNOWLEDGE_EXTRACTION_PROMPT_INSTRUCTIONS,
      prompt: buildKnowledgeExtractionPrompt(boundedInput),
      schemaName: "knowledge_extraction",
      schema: KNOWLEDGE_EXTRACTION_JSON_SCHEMA,
      model: this.model,
      images: await this.collectTrustedImages(input.messages),
      signal,
    });
    return parseKnowledgeExtraction(raw, boundedInput);
  }

  private async collectTrustedImages(
    messages: AnalysisMessage[],
  ): Promise<ProviderImage[]> {
    if (!this.attachmentsRoot) return [];

    let trustedRoot: string;
    try {
      trustedRoot = await realpath(this.attachmentsRoot);
    } catch {
      return [];
    }

    const candidates = messages.flatMap((message) =>
      message.attachments.flatMap((attachment) => {
        if (attachment.kind !== "image" || !attachment.localPath) return [];
        return [{
          localPath: attachment.localPath,
          mimeType: normaliseImageMimeType(
            attachment.mimeType,
            attachment.localPath,
          ),
        }];
      }),
    );
    const images: ProviderImage[] = [];
    const observed = new Set<string>();
    let totalBytes = 0;

    for (const candidate of candidates) {
      if (images.length >= MAX_IMAGES) break;
      if (!candidate.mimeType) continue;

      try {
        const resolved = await realpath(path.resolve(candidate.localPath));
        const relative = path.relative(trustedRoot, resolved);
        if (
          relative.startsWith("..") ||
          path.isAbsolute(relative) ||
          observed.has(resolved)
        ) {
          continue;
        }

        const bytes = await readFile(resolved);
        if (
          bytes.byteLength > MAX_IMAGE_BYTES ||
          totalBytes + bytes.byteLength > MAX_TOTAL_IMAGE_BYTES
        ) {
          continue;
        }
        observed.add(resolved);
        totalBytes += bytes.byteLength;
        images.push({
          mimeType: candidate.mimeType,
          dataBase64: bytes.toString("base64"),
        });
      } catch {
        // Missing and untrusted files remain represented by prompt metadata.
      }
    }

    return images;
  }
}

/** Routes a task-scoped Codex model through the runner's mode-specific boundary. */
export class CodexProviderAdapter implements SupportAgent {
  readonly providerId = "codex" as const;
  readonly capabilities = AI_PROVIDER_CAPABILITIES.codex;

  private readonly model: string;

  constructor(
    private readonly agent: CodexSupportAgent,
    model: string,
  ) {
    this.model = requireNonEmpty(model, "model");
  }

  analyse(
    input: SupportAnalysisInput,
    signal?: AbortSignal,
  ): Promise<SupportAnalysis> {
    return this.agent.analyse(input, this.model, signal);
  }

  investigateThread(
    input: InvestigationThreadInput,
    signal?: AbortSignal,
  ): Promise<InvestigationTurnResult> {
    return this.agent.investigateThread(input, this.model, signal);
  }

  triage(
    input: TriageAnalysisInput,
    model: string,
    signal?: AbortSignal,
  ): Promise<TriageAnalysis> {
    return this.agent.triage(input, model.trim() || this.model, signal);
  }

  generateDocumentation(
    input: DocumentationDraftInput,
    signal?: AbortSignal,
  ): Promise<DocumentationDraftResult> {
    return this.agent.generateDocumentation(input, this.model, signal);
  }
}

function approvedInvestigationImageMessages(
  input: InvestigationThreadInput,
): AnalysisMessage[] {
  const operatorMessage = input.recentMessages.find(
    (message) => message.id === input.currentOperatorMessageId,
  );
  const approvedImages: AnalysisMessage = {
    id: input.currentOperatorMessageId,
    author: "Operador local",
    role: "staff",
    timestampUtc: operatorMessage?.createdAt ?? new Date(0).toISOString(),
    text: operatorMessage?.body ?? null,
    attachments: (input.images ?? []).map((image) => ({
      id: image.id,
      kind: "image",
      fileName: image.fileName,
      mimeType: image.mimeType,
      localPath: image.localPath,
      extractedText: null,
    })),
    quotedMessageId: null,
  };
  return [approvedImages, ...input.ticket.messages];
}

function requireNonEmpty(value: string, field: string): string {
  const normalised = value.trim();
  if (!normalised) throw new TypeError(`${field} é obrigatório.`);
  return normalised;
}

function normaliseImageMimeType(
  value: string | null | undefined,
  localPath: string,
): ProviderImage["mimeType"] | null {
  const normalised = value?.toLowerCase().trim();
  if (
    normalised &&
    SUPPORTED_IMAGE_MIME_TYPES.has(normalised as ProviderImage["mimeType"])
  ) {
    return normalised as ProviderImage["mimeType"];
  }
  return MIME_TYPE_BY_EXTENSION[path.extname(localPath).toLowerCase()] ?? null;
}

function orderedTriageMessages(input: TriageAnalysisInput): AnalysisMessage[] {
  const candidates = new Set(input.candidateMessageIds);
  const byId = new Map(input.messages.map((message) => [message.id, message]));
  return [
    ...input.candidateMessageIds.flatMap((id) => {
      const message = byId.get(id);
      return message ? [message] : [];
    }),
    ...input.messages.filter((message) => !candidates.has(message.id)),
  ];
}

function assertValidTriageInput(input: TriageAnalysisInput): void {
  if (!input.candidateMessageIds.length) {
    throw new Error("A triagem exige pelo menos uma mensagem candidata.");
  }
  if (input.candidateMessageIds.length > 50) {
    throw new Error("A triagem aceita no máximo 50 mensagens candidatas.");
  }

  const candidates = new Set(input.candidateMessageIds);
  if (candidates.size !== input.candidateMessageIds.length) {
    throw new Error("A triagem recebeu id candidato repetido.");
  }
  const messages = new Map(input.messages.map((message) => [message.id, message]));
  for (const messageId of candidates) {
    const message = messages.get(messageId);
    if (!message) {
      throw new Error(`A triagem recebeu candidato sem mensagem: ${messageId}.`);
    }
    if (message.role === "staff" || message.role === "self") {
      throw new Error(
        `A triagem recebeu mensagem interna como candidata: ${messageId}.`,
      );
    }
  }

  const suggestionIds = input.pendingSuggestions.map((suggestion) => suggestion.id);
  if (new Set(suggestionIds).size !== suggestionIds.length) {
    throw new Error("A triagem recebeu id de sugestão pendente repetido.");
  }
}

function assertExactTriageCoverage(
  input: TriageAnalysisInput,
  result: TriageAnalysis,
): void {
  const expected = new Set(input.candidateMessageIds);
  const observed = new Set<string>();
  const allowedContext = new Set(
    input.messages
      .filter((message) => message.role === "staff" || message.role === "self")
      .map((message) => message.id),
  );
  const observedContext = new Set<string>();
  const allowedTickets = new Set(input.openTickets.map((ticket) => ticket.id));
  const allowedSuggestions = new Set(
    input.pendingSuggestions.map((suggestion) => suggestion.id),
  );
  let nextExpectedIndex = 0;

  for (const [groupIndex, group] of result.groups.entries()) {
    for (const messageId of group.contextMessageIds ?? []) {
      if (!allowedContext.has(messageId)) {
        throw new Error(
          `A triagem devolveu contexto interno desconhecido: ${messageId}.`,
        );
      }
      if (expected.has(messageId) || observedContext.has(messageId)) {
        throw new Error(
          `A triagem repetiu ou misturou a mensagem de contexto: ${messageId}.`,
        );
      }
      if (
        group.suggestedAction === "ignore" ||
        group.suggestedAction === "wait"
      ) {
        throw new Error(
          "A triagem não pode associar contexto interno a ignore ou wait.",
        );
      }
      observedContext.add(messageId);
    }
    const expectedSegment = input.candidateMessageIds.slice(
      nextExpectedIndex,
      nextExpectedIndex + group.messageIds.length,
    );
    for (const [messageIndex, messageId] of group.messageIds.entries()) {
      if (!expected.has(messageId)) {
        throw new Error(`A triagem devolveu mensagem desconhecida: ${messageId}.`);
      }
      if (observed.has(messageId)) {
        throw new Error(`A triagem repetiu a mensagem: ${messageId}.`);
      }
      if (messageId !== expectedSegment[messageIndex]) {
        throw new Error(
          `A triagem alterou a ordem da conversa no grupo ${groupIndex + 1}.`,
        );
      }
      observed.add(messageId);
    }
    if (
      group.suggestedAction === "attach" &&
      group.relatedTicketId &&
      !allowedTickets.has(group.relatedTicketId)
    ) {
      throw new Error("A triagem sugeriu um ticket fora do contexto permitido.");
    }
    if (
      group.relatedSuggestionId &&
      !allowedSuggestions.has(group.relatedSuggestionId)
    ) {
      throw new Error("A triagem sugeriu uma sugestão fora do contexto permitido.");
    }
    nextExpectedIndex += group.messageIds.length;
  }

  const missing = input.candidateMessageIds.filter((id) => !observed.has(id));
  if (missing.length) {
    throw new Error(`A triagem omitiu ${missing.length} mensagem(ns).`);
  }
}
