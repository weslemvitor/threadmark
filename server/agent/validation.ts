import { z } from "zod";

import type {
  InvestigationThreadInput,
  InvestigationTurnResult,
  SupportAnalysis,
  SupportAnalysisInput,
} from "./types.js";

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
    "availableTools" | "ticket" | "toolResults"
  >,
): InvestigationTurnResult {
  const allowedMessages = new Set(
    input.ticket.messages.map((message) => message.id),
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
    input.ticket.resolvedPrecedents.map((precedent) => precedent.ticketId),
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
  const lostAllEvidence =
    discardedConversationEvidence && evidence.length === 0;
  const normalized = discardedConversationEvidence
    ? {
        ...parsed,
        phase:
          lostAllEvidence && parsed.phase === "conclusion"
            ? "analysis" as const
            : parsed.phase,
        evidence,
        suggestedResponse: lostAllEvidence ? null : parsed.suggestedResponse,
        nextAction: lostAllEvidence
          ? "Continue a investigação e cite o ID exato de uma mensagem fornecida antes de concluir."
          : parsed.nextAction,
        confidence: lostAllEvidence
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
