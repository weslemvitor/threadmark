import type { KnowledgeObjectDto } from "../../shared/contracts.js";
import type { DocumentationDraftResult } from "../agent/types.js";

const CUSTOMER_FORBIDDEN_TERMS = /\b(postgresql|clickhouse|worker|lambda|kubernetes|cluster|banco de dados|sql|api key|credencial|infraestrutura|cloudwatch|sqs|redis)\b/i;
const GENERIC_ONLY = /^(problema resolvido|orientação validada|verifique as configurações|entre em contato com o suporte)[.!]?$/i;
const SENSITIVE_IDENTIFIER = /(?:\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|\+?\d[\d\s().-]{8,}\d|\b\d{8,}@(?:lid|s\.whatsapp\.net|g\.us)\b)/i;

export function renderKnowledgeDocument(
  knowledge: KnowledgeObjectDto,
): DocumentationDraftResult {
  const warnings = reviewWarnings(knowledge);
  const bodyMarkdown = renderBody(knowledge, warnings);
  const result: DocumentationDraftResult = {
    title: knowledge.title,
    summary: summaryFor(knowledge),
    audience: audienceLabel(knowledge.audience),
    bodyMarkdown,
    prerequisites: knowledge.prerequisites,
    sourceMessageIds: knowledge.evidence
      .filter((item) => item.source === "MESSAGE")
      .map((item) => item.reference),
    imagePlacements: [],
    warnings,
  };
  assertRenderedDocumentQuality(knowledge, result);
  return result;
}

export function assertRenderedDocumentQuality(
  knowledge: KnowledgeObjectDto,
  document: DocumentationDraftResult,
): void {
  if (!document.title.trim() || !document.bodyMarkdown.trim()) {
    throw new Error("O conhecimento não possui conteúdo suficiente para gerar o documento.");
  }
  if (GENERIC_ONLY.test(document.summary.trim())) {
    throw new Error("O documento ficou genérico demais para ser reutilizável.");
  }
  if (SENSITIVE_IDENTIFIER.test(`${document.title}\n${document.summary}\n${document.bodyMarkdown}`)) {
    throw new Error("A documentação contém identificador pessoal ou específico do atendimento.");
  }
  if (
    (knowledge.audience === "CUSTOMER" || knowledge.suggestedType === "CUSTOMER_FACING") &&
    CUSTOMER_FORBIDDEN_TERMS.test(`${document.summary}\n${document.bodyMarkdown}`)
  ) {
    throw new Error("A documentação para cliente expõe detalhes técnicos internos.");
  }
  if (
    knowledge.audience === "SUPPORT" &&
    knowledge.suggestedType !== "INTERNAL_RUNBOOK" &&
    CUSTOMER_FORBIDDEN_TERMS.test(`${document.summary}\n${document.bodyMarkdown}`)
  ) {
    throw new Error("A documentação para suporte contém infraestrutura sem tradução operacional.");
  }
  if (
    ["HOW_TO", "TROUBLESHOOTING", "INTERNAL_RUNBOOK"].includes(knowledge.suggestedType) &&
    knowledge.procedure.length > 0 &&
    !/(^|\n)1\./.test(document.bodyMarkdown)
  ) {
    throw new Error("A documentação procedural não apresentou passos numerados.");
  }
  if (
    knowledge.procedure.length > 0 &&
    knowledge.operationalEvidenceIds.length === 0
  ) {
    throw new Error("Procedimento sem evidência operacional não pode ser renderizado.");
  }
}

function renderBody(knowledge: KnowledgeObjectDto, warnings: string[]): string {
  switch (knowledge.suggestedType) {
    case "FAQ":
      return renderFaq(knowledge, warnings);
    case "HOW_TO":
      return renderHowTo(knowledge, warnings);
    case "TROUBLESHOOTING":
      return renderTroubleshooting(knowledge, warnings);
    case "INTERNAL_RUNBOOK":
      return renderRunbook(knowledge, warnings);
    case "CUSTOMER_FACING":
      return renderCustomerFacing(knowledge, warnings);
    case "EXPLANATION":
    default:
      return renderExplanation(knowledge, warnings);
  }
}

function renderFaq(knowledge: KnowledgeObjectDto, warnings: string[]): string {
  const answer = audienceText(knowledge) ?? knowledge.solution ?? knowledge.problem;
  return [
    "## Pergunta",
    questionTitle(knowledge.title),
    "## Resposta",
    answer ?? "Não há evidência suficiente para responder esta pergunta.",
    uncertaintySection(warnings),
  ].filter(Boolean).join("\n\n");
}

function renderHowTo(knowledge: KnowledgeObjectDto, warnings: string[]): string {
  return [
    section("Quando usar", first(knowledge.applicableConditions) ?? knowledge.context ?? knowledge.problem),
    listSection("Antes de começar", knowledge.prerequisites),
    knowledge.procedure.length
      ? `## Passo a passo\n\n${numbered(knowledge.procedure)}`
      : section("Passo a passo", "⚠️ Procedimento não confirmado. Não há evidência suficiente para determinar o procedimento de correção."),
    section("Resultado esperado", knowledge.solution ?? audienceText(knowledge)),
    listSection("Se não funcionar", knowledge.confirmationsNeeded),
    escalationSection(knowledge),
    uncertaintySection(warnings),
  ].filter(Boolean).join("\n\n");
}

function renderTroubleshooting(knowledge: KnowledgeObjectDto, warnings: string[]): string {
  const causes = knowledge.causes.length
    ? knowledge.causes.map((cause, index) => [
        `## Causa ${index + 1}: ${cause.description}`,
        section("Como identificar", cause.confirmation),
        section("Solução", cause.solution),
        cause.confidence !== "HIGH" ? `> Confiança desta causa: ${cause.confidence}.` : null,
      ].filter(Boolean).join("\n\n")).join("\n\n")
    : section("Possíveis causas", "As causas ainda não foram confirmadas.");
  return [
    section("Sintoma", knowledge.symptom ?? knowledge.problem),
    listSection("Verifique primeiro", knowledge.prerequisites.length ? knowledge.prerequisites : knowledge.confirmationsNeeded),
    causes,
    knowledge.procedure.length ? `## Procedimento confirmado\n\n${numbered(knowledge.procedure)}` : null,
    section("Resultado esperado", knowledge.solution),
    listSection("Se não resolver", knowledge.confirmationsNeeded),
    escalationSection(knowledge),
    uncertaintySection(warnings),
  ].filter(Boolean).join("\n\n");
}

function renderExplanation(knowledge: KnowledgeObjectDto, warnings: string[]): string {
  return [
    section("Em resumo", audienceText(knowledge) ?? knowledge.problem),
    section("Como funciona", knowledge.context),
    section("O que foi confirmado", knowledge.solution ?? knowledge.cause),
    listSection("Condições importantes", knowledge.applicableConditions),
    listSection("Quando não aplicar", knowledge.contraindications),
    uncertaintySection(warnings),
  ].filter(Boolean).join("\n\n");
}

function renderRunbook(knowledge: KnowledgeObjectDto, warnings: string[]): string {
  return [
    section("Objetivo", knowledge.problem),
    section("Contexto técnico confirmado", knowledge.technicalCause ?? knowledge.languageLevels.technical),
    listSection("Pré-requisitos", knowledge.prerequisites),
    knowledge.procedure.length ? `## Procedimento\n\n${numbered(knowledge.procedure)}` : section("Procedimento", "⚠️ Procedimento não confirmado."),
    section("Resultado esperado", knowledge.solution),
    listSection("Não utilizar quando", knowledge.contraindications),
    listSection("Quando escalar", knowledge.confirmationsNeeded),
    uncertaintySection(warnings),
  ].filter(Boolean).join("\n\n");
}

function renderCustomerFacing(knowledge: KnowledgeObjectDto, warnings: string[]): string {
  return [
    section("O que aconteceu", knowledge.languageLevels.customer ?? knowledge.problem),
    section("Como resolver", knowledge.solution),
    knowledge.procedure.length ? `## O que fazer\n\n${numbered(knowledge.procedure)}` : null,
    section("Resultado esperado", knowledge.languageLevels.customer ?? knowledge.solution),
    warnings.length ? "> Algumas informações ainda precisam ser confirmadas pela equipe de suporte." : null,
  ].filter(Boolean).join("\n\n");
}

function reviewWarnings(knowledge: KnowledgeObjectDto): string[] {
  const warnings = [
    ...knowledge.unknowns.map((item) => `Desconhecido: ${item}`),
    ...knowledge.confirmationsNeeded.map((item) => `Precisa de confirmação: ${item}`),
  ];
  if (knowledge.confidence === "LOW") warnings.unshift("Conhecimento com baixa confiança.");
  if (knowledge.candidate === "UNCERTAIN") warnings.unshift("Reutilização ainda não confirmada.");
  if (!knowledge.procedure.length && ["HOW_TO", "TROUBLESHOOTING", "INTERNAL_RUNBOOK"].includes(knowledge.suggestedType)) {
    warnings.push("Procedimento não confirmado.");
  }
  return [...new Set(warnings)];
}

function summaryFor(knowledge: KnowledgeObjectDto): string {
  return audienceText(knowledge) ?? knowledge.problem ?? knowledge.symptom ?? knowledge.title;
}

function audienceText(knowledge: KnowledgeObjectDto): string | null {
  if (knowledge.audience === "CUSTOMER") return knowledge.languageLevels.customer;
  if (knowledge.audience === "TECHNICAL") return knowledge.languageLevels.technical;
  return knowledge.languageLevels.support ?? knowledge.languageLevels.operational;
}

function audienceLabel(audience: KnowledgeObjectDto["audience"]): string {
  if (audience === "CUSTOMER") return "Cliente";
  if (audience === "TECHNICAL") return "Time técnico";
  return "Time de suporte";
}

function section(title: string, value: string | null | undefined): string | null {
  return value?.trim() ? `## ${title}\n\n${value.trim()}` : null;
}

function listSection(title: string, items: string[]): string | null {
  const values = items.map((item) => item.trim()).filter(Boolean);
  return values.length ? `## ${title}\n\n${values.map((item) => `- ${item}`).join("\n")}` : null;
}

function numbered(items: string[]): string {
  return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

function first(items: string[]): string | null {
  return items.find((item) => item.trim()) ?? null;
}

function escalationSection(knowledge: KnowledgeObjectDto): string | null {
  const items = knowledge.confirmationsNeeded.length
    ? knowledge.confirmationsNeeded
    : knowledge.unknowns;
  return listSection("Quando encaminhar para outro time", items);
}

function uncertaintySection(warnings: string[]): string | null {
  return warnings.length
    ? `## Informações ainda não confirmadas\n\n${warnings.map((item) => `- ⚠️ ${item}`).join("\n")}`
    : null;
}

function questionTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.endsWith("?") ? trimmed : `${trimmed}?`;
}
