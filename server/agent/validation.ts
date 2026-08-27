import { z } from "zod";

import type {
  InvestigationThreadInput,
  InvestigationTurnResult,
  DocumentationDraftInput,
  DocumentationDraftResult,
  KnowledgeExtractionInput,
  KnowledgeExtractionResult,
  SupportAnalysis,
  SupportAnalysisInput,
} from "./types.js";

const knowledgeConfidenceSchema = z.enum(["HIGH", "MEDIUM", "LOW"]);
const knowledgeEvidenceSchema = z.object({
  id: z.string().trim().min(1).max(100),
  source: z.enum(["MESSAGE", "RESOLUTION", "TICKET", "TOOL_RESULT", "RELATED_TICKET"]),
  reference: z.string().trim().min(1).max(500),
  excerpt: z.string().trim().min(1).max(3_000),
  observedAt: z.string().trim().max(100).nullable(),
});

export const knowledgeExtractionSchema = z.object({
  title: z.string().trim().min(1).max(160),
  problem: z.string().trim().max(2_000).nullable(),
  symptom: z.string().trim().max(2_000).nullable(),
  context: z.string().trim().max(4_000).nullable(),
  cause: z.string().trim().max(2_000).nullable(),
  technicalCause: z.string().trim().max(4_000).nullable(),
  solution: z.string().trim().max(4_000).nullable(),
  procedure: z.array(z.string().trim().min(1).max(2_000)).max(50),
  prerequisites: z.array(z.string().trim().min(1).max(2_000)).max(50),
  occurrenceConditions: z.array(z.string().trim().min(1).max(2_000)).max(50),
  applicableConditions: z.array(z.string().trim().min(1).max(2_000)).max(50),
  contraindications: z.array(z.string().trim().min(1).max(2_000)).max(50),
  impact: z.string().trim().max(2_000).nullable(),
  affectedAudience: z.string().trim().max(1_000).nullable(),
  productFeature: z.string().trim().max(500).nullable(),
  causes: z.array(z.object({
    description: z.string().trim().min(1).max(2_000),
    confirmation: z.string().trim().max(2_000).nullable(),
    solution: z.string().trim().max(2_000).nullable(),
    evidenceIds: z.array(z.string().trim().min(1).max(500)).max(120),
    confidence: knowledgeConfidenceSchema,
  })).max(20),
  claims: z.array(z.object({
    id: z.string().trim().min(1).max(100),
    kind: z.enum(["FACT", "EVIDENCE", "INFERENCE", "HYPOTHESIS"]),
    statement: z.string().trim().min(1).max(3_000),
    evidenceIds: z.array(z.string().trim().min(1).max(500)).max(120),
    confidence: knowledgeConfidenceSchema,
  })).max(100),
  evidence: z.array(knowledgeEvidenceSchema).max(120),
  operationalEvidenceIds: z.array(z.string().trim().min(1).max(500)).max(120),
  toolsUsed: z.array(z.string().trim().min(1).max(2_000)).max(50),
  relatedTicketIds: z.array(z.string().trim().min(1).max(500)).max(120),
  unknowns: z.array(z.string().trim().min(1).max(2_000)).max(50),
  confirmationsNeeded: z.array(z.string().trim().min(1).max(2_000)).max(50),
  languageLevels: z.object({
    technical: z.string().trim().max(4_000).nullable(),
    operational: z.string().trim().max(4_000).nullable(),
    support: z.string().trim().max(4_000).nullable(),
    customer: z.string().trim().max(4_000).nullable(),
  }),
  candidate: z.enum(["YES", "NO", "UNCERTAIN"]),
  confidence: knowledgeConfidenceSchema,
  suggestedType: z.enum(["FAQ", "HOW_TO", "TROUBLESHOOTING", "EXPLANATION", "INTERNAL_RUNBOOK", "CUSTOMER_FACING"]),
  audience: z.enum(["SUPPORT", "TECHNICAL", "CUSTOMER"]),
  duplicateCandidateId: z.string().trim().max(200).nullable(),
  duplicateDifferences: z.array(z.string().trim().min(1).max(2_000)).max(50),
});

export function parseKnowledgeExtraction(
  value: unknown,
  input: KnowledgeExtractionInput,
): KnowledgeExtractionResult {
  const result = knowledgeExtractionSchema.parse(value);
  const evidenceIds = new Set(result.evidence.map((item) => item.id));
  if (evidenceIds.size !== result.evidence.length) {
    throw new Error("A extração repetiu identificadores de evidência.");
  }
  const claimIds = new Set(result.claims.map((item) => item.id));
  if (claimIds.size !== result.claims.length) {
    throw new Error("A extração repetiu identificadores de afirmação.");
  }
  const messageIds = new Set(input.messages.map((message) => message.id));
  const knownKnowledgeIds = new Set(input.existingKnowledge.map((item) => item.id));
  const knownRelatedTicketIds = new Set(input.existingKnowledge.map((item) => item.ticketId));
  const knownToolEvidenceIds = new Set(input.technicalEvidence.map((item) => item.id));
  const knownToolNames = new Set(input.technicalEvidence.map((item) => item.toolName));
  for (const evidence of result.evidence) {
    if (evidence.source === "MESSAGE" && !messageIds.has(evidence.reference)) {
      throw new Error("A extração citou uma mensagem fora do ticket.");
    }
    if (evidence.source === "RESOLUTION" && evidence.reference !== `resolution:${input.ticketId}`) {
      throw new Error("A extração citou uma resolução não fornecida.");
    }
    if (evidence.source === "TICKET" && evidence.reference !== `ticket:${input.ticketId}`) {
      throw new Error("A extração citou um ticket não fornecido.");
    }
    if (evidence.source === "TOOL_RESULT" && !knownToolEvidenceIds.has(evidence.reference)) {
      throw new Error("A extração citou uma fonte técnica não fornecida.");
    }
    if (evidence.source === "RELATED_TICKET" && !knownRelatedTicketIds.has(evidence.reference)) {
      throw new Error("A extração citou um ticket relacionado não fornecido.");
    }
  }
  const referencedEvidenceIds = [
    ...result.operationalEvidenceIds,
    ...result.claims.flatMap((claim) => claim.evidenceIds),
    ...result.causes.flatMap((cause) => cause.evidenceIds),
  ];
  if (referencedEvidenceIds.some((id) => !evidenceIds.has(id))) {
    throw new Error("A extração referenciou uma evidência inexistente.");
  }
  if (result.claims.some((claim) => claim.kind !== "HYPOTHESIS" && claim.evidenceIds.length === 0)) {
    throw new Error("Fatos, evidências e inferências precisam de referência auditável.");
  }
  const hasOperationalContent = Boolean(result.solution || result.procedure.length);
  if (hasOperationalContent && result.operationalEvidenceIds.length === 0) {
    throw new Error("Solução e procedimento exigem evidência operacional.");
  }
  if (hasOperationalContent && result.confidence === "LOW") {
    throw new Error("Conhecimento de baixa confiança não pode conter procedimento operacional.");
  }
  if (
    result.candidate === "YES" && result.confidence === "LOW" &&
    ["HOW_TO", "TROUBLESHOOTING", "INTERNAL_RUNBOOK"].includes(result.suggestedType)
  ) {
    throw new Error("Conhecimento operacional de baixa confiança não pode ser candidato reutilizável.");
  }
  if (result.duplicateCandidateId && !knownKnowledgeIds.has(result.duplicateCandidateId)) {
    throw new Error("A extração indicou uma duplicidade fora da base conhecida.");
  }
  if (result.relatedTicketIds.some((id) => !knownRelatedTicketIds.has(id))) {
    throw new Error("A extração indicou um ticket relacionado fora do contexto.");
  }
  if (result.toolsUsed.some((name) => !knownToolNames.has(name))) {
    throw new Error("A extração indicou uma ferramenta fora da investigação auditada.");
  }
  return result;
}

export const documentationDraftSchema = z.object({
  title: z.string().trim().min(1).max(160),
  summary: z.string().trim().min(1).max(600),
  audience: z.string().trim().min(1).max(200),
  bodyMarkdown: z.string().trim().min(1).max(30_000),
  prerequisites: z.array(z.string().trim().min(1).max(500)).max(20),
  sourceMessageIds: z.array(z.string().trim().min(1)).max(100),
  imagePlacements: z.array(z.object({
    attachmentId: z.string().trim().min(1),
    afterHeading: z.string().trim().max(200).nullable(),
    caption: z.string().trim().min(1).max(500),
  })).max(10),
  warnings: z.array(z.string().trim().min(1).max(1_000)).max(20),
});

export function parseDocumentationDraft(
  value: unknown,
  input: DocumentationDraftInput,
): DocumentationDraftResult {
  const result = documentationDraftSchema.parse(value);
  const messageIds = new Set(input.messages.map((message) => message.id));
  const attachmentIds = new Set(input.availableImages.map((image) => image.attachmentId));
  if (result.sourceMessageIds.some((id) => !messageIds.has(id))) {
    throw new Error("A documentação citou uma mensagem fora do ticket.");
  }
  if (result.imagePlacements.some((image) => !attachmentIds.has(image.attachmentId))) {
    throw new Error("A documentação citou uma imagem que não pertence ao ticket.");
  }
  return result;
}

export const supportAnalysisSchema = z.object({
  createTicket: z.boolean(),
  outcome: z.enum([
    "reply_ready",
    "already_answered",
    "needs_information",
    "technical_investigation_required",
  ]),
  relation: z.enum([
    "new",
    "continuation",
    "possible_reopen",
    "informational",
    "social",
    "uncertain",
  ]),
  relatedTicketId: z.string().nullable(),
  title: z.string().trim(),
  summary: z.string().trim(),
  affectedEcommerce: z.string().trim().nullable(),
  priority: z.enum(["low", "normal", "high", "urgent"]),
  categories: z.object({
    contactReason: z.array(z.string().trim()),
    productArea: z.array(z.string().trim()),
    platform: z.array(z.string().trim()),
    symptom: z.array(z.string().trim()),
  }),
  evidence: z.array(
    z.object({
      source: z.enum(["conversation", "resolved_ticket"]),
      summary: z.string().trim(),
      reference: z.string().trim().nullable(),
    }),
  ),
  suggestedResponse: z.string().trim().nullable(),
  missingInformation: z.array(z.string().trim()),
  nextAction: z.string().trim(),
  confidence: z.number().min(0).max(1),
}).superRefine((analysis, context) => {
  const hasSuggestedResponse = Boolean(analysis.suggestedResponse?.trim());
  const hasMissingInformation = analysis.missingInformation.some(Boolean);

  if (analysis.outcome === "reply_ready" && !hasSuggestedResponse) {
    context.addIssue({
      code: "custom",
      path: ["suggestedResponse"],
      message: "reply_ready exige uma resposta sugerida segura",
    });
  }

  if (analysis.outcome === "reply_ready" && hasMissingInformation) {
    context.addIssue({
      code: "custom",
      path: ["missingInformation"],
      message: "reply_ready nao pode depender de informacoes ausentes",
    });
  }

  if (analysis.outcome === "reply_ready" && analysis.evidence.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["evidence"],
      message: "reply_ready exige pelo menos uma evidência auditável",
    });
  }

  if (
    analysis.outcome === "already_answered" &&
    analysis.suggestedResponse !== null
  ) {
    context.addIssue({
      code: "custom",
      path: ["suggestedResponse"],
      message: "already_answered exige suggestedResponse=null",
    });
  }

  if (
    analysis.outcome === "already_answered" &&
    analysis.missingInformation.length > 0
  ) {
    context.addIssue({
      code: "custom",
      path: ["missingInformation"],
      message: "already_answered exige missingInformation vazio",
    });
  }

  if (analysis.outcome === "needs_information" && !hasMissingInformation) {
    context.addIssue({
      code: "custom",
      path: ["missingInformation"],
      message: "needs_information exige pelo menos uma informacao ausente",
    });
  }

  if (analysis.outcome === "needs_information" && !hasSuggestedResponse) {
    context.addIssue({
      code: "custom",
      path: ["suggestedResponse"],
      message: "needs_information exige uma resposta que solicite os dados ausentes",
    });
  }

  if (
    analysis.outcome === "technical_investigation_required" &&
    hasSuggestedResponse
  ) {
    context.addIssue({
      code: "custom",
      path: ["suggestedResponse"],
      message:
        "technical_investigation_required nao permite resposta sugerida sem conclusao segura",
    });
  }
});

export function parseSupportAnalysis(
  value: unknown,
  input: Pick<
    SupportAnalysisInput,
    | "conversationState"
    | "messages"
    | "resolvedPrecedents"
    | "sentResponses"
  >,
): SupportAnalysis {
  const allowedMessages = new Set(input.messages.map((message) => message.id));
  const allowedPrecedents = new Set(
    input.resolvedPrecedents.map((precedent) => precedent.ticketId),
  );
  const analysis = supportAnalysisSchema
    .superRefine((analysis, context) => {
      if (
        analysis.outcome === "already_answered" &&
        (input.conversationState.hasUnansweredExternalMessages ||
          input.conversationState.unansweredExternalMessageIds.length > 0)
      ) {
        context.addIssue({
          code: "custom",
          path: ["outcome"],
          message:
            "already_answered não é permitido enquanto houver mensagem externa pendente",
        });
      }

      if (
        analysis.outcome === "already_answered" &&
        !hasCoherentSentResponse(input)
      ) {
        context.addIssue({
          code: "custom",
          path: ["outcome"],
          message:
            "already_answered exige uma resposta capturada no mesmo momento ou depois da última mensagem externa",
        });
      }

      for (const [index, evidence] of analysis.evidence.entries()) {
        if (
          evidence.source === "conversation" &&
          (!evidence.reference || !allowedMessages.has(evidence.reference))
        ) {
          context.addIssue({
            code: "custom",
            path: ["evidence", index, "reference"],
            message:
              "conversation exige o id exato de uma mensagem fornecida",
          });
        }
        if (
          evidence.source === "resolved_ticket" &&
          (!evidence.reference || !allowedPrecedents.has(evidence.reference))
        ) {
          context.addIssue({
            code: "custom",
            path: ["evidence", index, "reference"],
            message:
              "resolved_ticket exige o ticketId exato de um precedente fornecido",
          });
        }
      }
    })
    .parse(value) as SupportAnalysis;
  return normalizeExplicitSupportRelation(analysis, input);
}

const explicitNewTopicSignal = /\b(outro problema|outra duvida|outra coisa|novo problema|nova duvida|novo assunto|separadamente|alem disso|mudando de assunto|aproveitando)\b/i;
const explicitContinuationSignal = /\b(continua|continuando|complementando|complemento|mesmo problema|sobre isso|sobre esse|sobre essa)\b/i;

function normalizeExplicitSupportRelation(
  analysis: SupportAnalysis,
  input: Pick<SupportAnalysisInput, "conversationState" | "messages">,
): SupportAnalysis {
  if (!input.conversationState.hasUnansweredExternalMessages) return analysis;

  const pendingIds = new Set(
    input.conversationState.unansweredExternalMessageIds,
  );
  const pendingText = normalizeRelationText(
    input.messages
      .filter(
        (message) =>
          message.role === "external" && pendingIds.has(message.id),
      )
      .map((message) => message.text)
      .filter((text): text is string => Boolean(text?.trim()))
      .join("\n"),
  );
  if (!pendingText) return analysis;

  const explicitRelation = explicitNewTopicSignal.test(pendingText)
    ? "new"
    : explicitContinuationSignal.test(pendingText)
      ? "continuation"
      : null;
  if (!explicitRelation || analysis.relation === explicitRelation) {
    return analysis;
  }
  return { ...analysis, relation: explicitRelation };
}

function normalizeRelationText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/\s+/g, " ")
    .trim();
}

function hasCoherentSentResponse(
  input: Pick<SupportAnalysisInput, "conversationState" | "sentResponses">,
): boolean {
  const lastExternalAt = timestampValue(
    input.conversationState.lastExternalMessageAt,
  );
  if (lastExternalAt === null) return false;

  const responseTimes = [
    input.conversationState.lastSentResponseAt,
    ...input.sentResponses.map((response) => response.sentAt),
  ].flatMap((timestamp) => {
    const parsed = timestampValue(timestamp);
    return parsed === null ? [] : [parsed];
  });
  if (!responseTimes.length) return false;
  return Math.max(...responseTimes) >= lastExternalAt;
}

function timestampValue(value: string | null): number | null {
  if (!value?.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export const investigationTurnResultSchema = z
  .object({
    assistantMessage: z.string().trim().min(1).max(40_000),
    phase: z.enum(["analysis", "needs_information", "conclusion"]),
    threadSummary: z.string().trim().min(1).max(12_000),
    findings: z.array(
      z.object({
        statement: z.string().trim().min(1).max(4_000),
        kind: z.enum(["fact", "hypothesis", "missing_information"]),
        evidenceReferences: z.array(z.string().trim().min(1).max(4_000)).max(10),
      }).strict(),
    ).min(1).max(30),
    evidence: z.array(
      z.object({
        source: z.enum([
          "conversation",
          "knowledge",
          "resolved_ticket",
          "database",
          "clickhouse",
          "aws",
          "code",
          "deployment",
          "external_app",
        ]),
        summary: z.string().trim().min(1).max(4_000),
        reference: z.string().trim().max(4_000).nullable(),
      }),
    ),
    suggestedResponse: z.string().trim().min(1).max(20_000).nullable(),
    nextAction: z.string().trim().min(1).max(8_000).nullable(),
    confidence: z.number().min(0).max(1),
    toolRequests: z
      .array(
        z.object({
          requestId: z.string().trim().min(1).max(100),
          toolId: z.string().trim().min(1).max(200),
          operation: z.string().trim().min(1).max(100),
          argumentsJson: z.string().trim().min(2).max(20_000),
          purpose: z.string().trim().min(1).max(1_000),
        }),
      )
      .max(5),
  })
  .superRefine((result, context) => {
    const evidenceReferences = new Set(
      result.evidence.flatMap((item) => item.reference ? [item.reference] : []),
    );
    for (const [index, finding] of result.findings.entries()) {
      if (finding.kind === "fact" && finding.evidenceReferences.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["findings", index, "evidenceReferences"],
          message: "fato comprovado exige ao menos uma referência auditável",
        });
      }
      for (const [referenceIndex, reference] of finding.evidenceReferences.entries()) {
        if (evidenceReferences.has(reference)) continue;
        context.addIssue({
          code: "custom",
          path: ["findings", index, "evidenceReferences", referenceIndex],
          message: "a referência da descoberta deve existir em evidence",
        });
      }
    }

    for (const [index, evidence] of result.evidence.entries()) {
      if (
        evidence.source !== "conversation" &&
        (!evidence.reference || !evidence.reference.trim())
      ) {
        context.addIssue({
          code: "custom",
          path: ["evidence", index, "reference"],
          message: "evidência técnica exige uma referência auditável",
        });
      }
    }

    if (result.phase === "analysis" && result.suggestedResponse) {
      context.addIssue({
        code: "custom",
        path: ["suggestedResponse"],
        message: "analysis nao permite resposta sugerida antes de uma conclusao segura",
      });
    }

    if (
      result.phase === "conclusion" &&
      result.suggestedResponse &&
      result.evidence.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "uma resposta conclusiva exige pelo menos uma evidência auditável",
      });
    }

    if (result.phase === "needs_information" && !result.nextAction) {
      context.addIssue({
        code: "custom",
        path: ["nextAction"],
        message: "needs_information exige a proxima informacao necessaria",
      });
    }

    if (result.toolRequests.length > 0 && result.phase !== "analysis") {
      context.addIssue({
        code: "custom",
        path: ["toolRequests"],
        message: "uma solicitação de ferramenta exige phase=analysis",
      });
    }

    if (result.toolRequests.length > 0 && result.suggestedResponse) {
      context.addIssue({
        code: "custom",
        path: ["suggestedResponse"],
        message: "não é seguro sugerir resposta antes do resultado da ferramenta",
      });
    }

    if (
      new Set(result.toolRequests.map((request) => request.requestId)).size !==
      result.toolRequests.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["toolRequests"],
        message: "requestId deve ser único dentro do turno",
      });
    }
  });

export function parseInvestigationTurnResult(
  value: unknown,
  input: Pick<
    InvestigationThreadInput,
    | "availableTools"
    | "ticket"
    | "relatedTickets"
    | "recentMessages"
    | "toolResults"
  >,
): InvestigationTurnResult {
  const tickets = [input.ticket, ...(input.relatedTickets ?? [])];
  const allowedMessages = new Set(
    [
      ...tickets.flatMap((ticket) => ticket.messages.map((message) => message.id)),
      ...input.recentMessages.map((message) => message.id),
    ],
  );
  const allowedKnowledge = new Set<string>();
  const knowledgeToolIds = new Set(
    (input.availableTools ?? [])
      .filter((tool) => tool.type === "knowledge")
      .map((tool) => tool.id),
  );
  for (const result of input.toolResults ?? []) {
    if (
      result.status === "success" &&
      result.reference &&
      knowledgeToolIds.has(result.toolId)
    ) {
      allowedKnowledge.add(result.reference);
    }
  }
  const allowedPrecedents = new Set(
    tickets.flatMap((ticket) =>
      ticket.resolvedPrecedents.map((precedent) => precedent.ticketId),
    ),
  );

  const parsed = investigationTurnResultSchema.parse(
    value,
  ) as InvestigationTurnResult;
  const evidence = parsed.evidence.filter(
    (item) =>
      item.source !== "conversation" ||
      Boolean(item.reference && allowedMessages.has(item.reference)),
  );
  const discardedConversationEvidence =
    evidence.length !== parsed.evidence.length;
  const retainedReferences = new Set(
    evidence.flatMap((item) => item.reference ? [item.reference] : []),
  );
  const findings = parsed.findings.flatMap((finding) => {
    const evidenceReferences = finding.evidenceReferences.filter((reference) =>
      retainedReferences.has(reference)
    );
    if (finding.kind === "fact" && evidenceReferences.length === 0) return [];
    return [{ ...finding, evidenceReferences }];
  });
  const discardedFinding = findings.length !== parsed.findings.length;
  const lostRequiredGrounding = discardedConversationEvidence &&
    (evidence.length === 0 || discardedFinding);
  const normalized = discardedConversationEvidence
    ? {
        ...parsed,
        phase:
          lostRequiredGrounding && parsed.phase === "conclusion"
            ? "analysis" as const
            : parsed.phase,
        evidence,
        findings: lostRequiredGrounding
          ? [{
              statement: "A conclusão perdeu a evidência necessária durante a validação.",
              kind: "missing_information" as const,
              evidenceReferences: [],
            }]
          : findings,
        suggestedResponse: lostRequiredGrounding ? null : parsed.suggestedResponse,
        nextAction: lostRequiredGrounding
          ? "Continue a investigação e cite o ID exato de uma mensagem fornecida antes de concluir."
          : parsed.nextAction,
        confidence: lostRequiredGrounding
          ? Math.min(parsed.confidence, 0.5)
          : parsed.confidence,
      }
    : parsed;

  return investigationTurnResultSchema
    .superRefine((result, context) => {
      for (const [index, evidence] of result.evidence.entries()) {
        if (
          evidence.source === "knowledge" &&
          (!evidence.reference || !allowedKnowledge.has(evidence.reference))
        ) {
          context.addIssue({
            code: "custom",
            path: ["evidence", index, "reference"],
            message:
              "knowledge exige a referência exata de uma leitura knowledge bem-sucedida",
          });
        }
        if (
          evidence.source === "resolved_ticket" &&
          (!evidence.reference || !allowedPrecedents.has(evidence.reference))
        ) {
          context.addIssue({
            code: "custom",
            path: ["evidence", index, "reference"],
            message:
              "resolved_ticket exige o ticketId exato de um precedente fornecido",
          });
        }
      }
    })
    .parse(normalized) as InvestigationTurnResult;
}

export const triageAnalysisSchema = z.object({
  groups: z
    .array(
      z
        .object({
          messageIds: z.array(z.string().trim().min(1)).min(1).max(50),
          contextMessageIds: z
            .array(z.string().trim().min(1))
            .max(50)
            .default([]),
          kind: z.enum([
            "demand",
            "uncertain",
            "continuation",
            "information",
            "social",
          ]),
          suggestedAction: z.enum(["create", "attach", "ignore", "wait"]),
          relatedTicketId: z.string().trim().min(1).nullable(),
          relatedSuggestionId: z.string().trim().min(1).nullable(),
          title: z.string().trim().min(1).max(200),
          summary: z.string().trim().min(1).max(4_000),
          priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
          affectedEcommerce: z.string().trim().min(1).max(500).nullable(),
          categories: z.object({
            contactReason: z.array(z.string().trim()).max(1),
            productArea: z.array(z.string().trim()).max(1),
            platform: z.array(z.string().trim()).max(3),
            symptom: z.array(z.string().trim()).max(1),
          }),
          reason: z.string().trim().min(1).max(1_000),
          confidence: z.number().min(0).max(1),
        })
        .superRefine((decision, context) => {
          if (
            decision.suggestedAction === "attach" &&
            !decision.relatedTicketId &&
            !decision.relatedSuggestionId
          ) {
            context.addIssue({
              code: "custom",
              path: ["relatedTicketId"],
              message: "attach exige um ticket ou uma sugestão pendente relacionada",
            });
          }
          if (
            decision.suggestedAction !== "attach" &&
            decision.relatedTicketId
          ) {
            context.addIssue({
              code: "custom",
              path: ["relatedTicketId"],
              message: "somente attach permite ticket relacionado",
            });
          }
          if (decision.relatedTicketId && decision.relatedSuggestionId) {
            context.addIssue({
              code: "custom",
              path: ["relatedSuggestionId"],
              message: "ticket e sugestão relacionada são mutuamente exclusivos",
            });
          }
          if (
            decision.suggestedAction === "ignore" &&
            decision.kind !== "social" &&
            decision.kind !== "information"
          ) {
            context.addIssue({
              code: "custom",
              path: ["suggestedAction"],
              message: "somente conteúdo social ou informativo pode ser ignorado",
            });
          }
          if (
            decision.suggestedAction === "ignore" &&
            Object.values(decision.categories).some((values) => values.length)
          ) {
            context.addIssue({
              code: "custom",
              path: ["categories"],
              message: "conteúdo ignorado não recebe categorias",
            });
          }
          if (
            decision.suggestedAction === "ignore" &&
            decision.relatedSuggestionId
          ) {
            context.addIssue({
              code: "custom",
              path: ["relatedSuggestionId"],
              message: "ignore não pode alterar uma sugestão pendente",
            });
          }
          if (
            (decision.suggestedAction === "ignore" ||
              decision.suggestedAction === "wait") &&
            decision.contextMessageIds.length
          ) {
            context.addIssue({
              code: "custom",
              path: ["contextMessageIds"],
              message: "ignore e wait não recebem contexto interno associado",
            });
          }
          if (
            decision.suggestedAction === "wait" &&
            decision.kind !== "uncertain"
          ) {
            context.addIssue({
              code: "custom",
              path: ["kind"],
              message: "wait exige kind uncertain",
            });
          }
          if (
            decision.suggestedAction === "wait" &&
            Object.values(decision.categories).some((values) => values.length)
          ) {
            context.addIssue({
              code: "custom",
              path: ["categories"],
              message: "wait não recebe categorias",
            });
          }
          if (
            decision.suggestedAction === "wait" &&
            (decision.relatedTicketId || decision.relatedSuggestionId)
          ) {
            context.addIssue({
              code: "custom",
              path: ["relatedSuggestionId"],
              message: "wait não permite ticket nem sugestão relacionada",
            });
          }
        }),
    )
    .min(1)
    .max(50),
});
