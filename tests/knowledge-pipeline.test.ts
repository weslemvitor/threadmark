import assert from "node:assert/strict";
import test from "node:test";

import type { KnowledgeObjectDto } from "../shared/contracts.js";
import type { KnowledgeExtractionInput, KnowledgeExtractionResult } from "../server/agent/types.js";
import { KNOWLEDGE_EXTRACTION_PROMPT_INSTRUCTIONS } from "../server/agent/prompt.js";
import { parseKnowledgeExtraction } from "../server/agent/validation.js";
import { renderKnowledgeDocument } from "../server/knowledge/renderer.js";
import { InvestigationWorker } from "../server/agent/investigation-worker.js";
import { createDatabase } from "../server/db/index.js";
import { SupportStore } from "../server/domain/index.js";

const input = {
  draftId: "draft-1", ticketId: "ticket-1", ticketNumber: 1,
  title: "Relatório vazio", summary: "O relatório não mostra dados.",
  resolution: "Preenchemos a data final e o cliente confirmou o resultado.",
  categories: ["Dashboard"], availableImages: [], existingKnowledge: [], technicalEvidence: [],
  messages: [{ id: "message-1", body: "Após preencher a data final funcionou." }],
} as unknown as KnowledgeExtractionInput;

function extraction(overrides: Partial<KnowledgeExtractionResult> = {}): KnowledgeExtractionResult {
  return {
    title: "Como corrigir relatório vazio", problem: "O relatório não apresenta dados.",
    symptom: "Relatório vazio.", context: "Período sem data final.",
    cause: "Data final não preenchida.", technicalCause: null,
    solution: "Preencher a data final.", procedure: ["Informe a data final.", "Consulte novamente."],
    prerequisites: ["Ter acesso ao relatório."], occurrenceConditions: ["Período incompleto."],
    applicableConditions: ["O relatório abre sem dados."], contraindications: [], impact: null,
    affectedAudience: "Usuários do relatório", productFeature: "Relatórios", causes: [],
    evidence: [{ id: "e1", source: "MESSAGE", reference: "message-1", excerpt: "Após preencher a data final funcionou.", observedAt: null }],
    claims: [{ id: "c1", kind: "FACT", statement: "A correção funcionou.", evidenceIds: ["e1"], confidence: "HIGH" }],
    operationalEvidenceIds: ["e1"], toolsUsed: [], relatedTicketIds: [], unknowns: [], confirmationsNeeded: [],
    languageLevels: {
      technical: "O intervalo não possuía limite final.", operational: "O período estava incompleto.",
      support: "Preencha a data final e consulte novamente.", customer: "Preencha a data final e tente novamente.",
    },
    candidate: "YES", confidence: "HIGH", suggestedType: "HOW_TO", audience: "SUPPORT",
    duplicateCandidateId: null, duplicateDifferences: [], ...overrides,
  };
}

function knowledge(overrides: Partial<KnowledgeObjectDto> = {}): KnowledgeObjectDto {
  const result = extraction();
  return {
    id: "knowledge-1", ticketId: "ticket-1", ticketNumber: 1, version: 1, status: "IN_REVIEW",
    candidate: result.candidate, confidence: result.confidence, suggestedType: result.suggestedType,
    audience: result.audience, title: result.title, problem: result.problem, symptom: result.symptom,
    context: result.context, cause: result.cause, technicalCause: result.technicalCause,
    solution: result.solution, procedure: result.procedure, prerequisites: result.prerequisites,
    occurrenceConditions: result.occurrenceConditions, applicableConditions: result.applicableConditions,
    contraindications: result.contraindications, impact: result.impact,
    affectedAudience: result.affectedAudience, productFeature: result.productFeature,
    causes: result.causes, claims: result.claims, evidence: result.evidence,
    operationalEvidenceIds: result.operationalEvidenceIds, toolsUsed: [], relatedTicketIds: [],
    unknowns: [], confirmationsNeeded: [], languageLevels: result.languageLevels, duplicate: null,
    aiProviderId: "codex", aiModel: "test", extractedAt: "2026-08-25T12:00:00.000Z",
    reviewedAt: null, reviewedBy: null, createdAt: "2026-08-25T12:00:00.000Z",
    updatedAt: "2026-08-25T12:00:00.000Z", ...overrides,
  };
}

test("ticket simples gera conhecimento auditável e HOW_TO curto", () => {
  const parsed = parseKnowledgeExtraction(extraction(), input);
  assert.equal(parsed.confidence, "HIGH");
  assert.match(renderKnowledgeDocument(knowledge()).bodyMarkdown, /1\. Informe a data final/);
});

test("ticket técnico preserva detalhe somente no nível técnico", () => {
  const doc = renderKnowledgeDocument(knowledge({ audience: "SUPPORT", technicalCause: "Worker expirou no PostgreSQL." }));
  assert.doesNotMatch(doc.bodyMarkdown, /PostgreSQL|Worker/);
});

test("ticket sem solução declara informação desconhecida", () => {
  const parsed = parseKnowledgeExtraction(extraction({ solution: null, procedure: [], operationalEvidenceIds: [], confidence: "LOW", candidate: "UNCERTAIN", suggestedType: "EXPLANATION", unknowns: ["Procedimento de correção."] }), input);
  assert.deepEqual(parsed.unknowns, ["Procedimento de correção."]);
});

test("ticket com solução confirmada aceita procedimento sustentado", () => {
  assert.doesNotThrow(() => parseKnowledgeExtraction(extraction(), input));
});

test("ticket com hipótese não transforma hipótese em procedimento", () => {
  assert.throws(() => parseKnowledgeExtraction(extraction({ confidence: "LOW", claims: [{ id: "h1", kind: "HYPOTHESIS", statement: "Pode ser processamento.", evidenceIds: [], confidence: "LOW" }] }), input), /baixa confiança/);
});

test("ticket com múltiplas causas mantém confirmação e confiança separadas", () => {
  const parsed = parseKnowledgeExtraction(extraction({ causes: [
    { description: "Período incompleto", confirmation: "Data final vazia", solution: "Preencher a data", evidenceIds: ["e1"], confidence: "HIGH" },
    { description: "Processamento pendente", confirmation: null, solution: null, evidenceIds: [], confidence: "LOW" },
  ] }), input);
  assert.equal(parsed.causes[1]?.confidence, "LOW");
});

test("ticket muito técnico não contamina conteúdo CUSTOMER", () => {
  assert.throws(() => renderKnowledgeDocument(knowledge({ audience: "CUSTOMER", suggestedType: "CUSTOMER_FACING", languageLevels: { technical: null, operational: null, support: null, customer: "Consulte o PostgreSQL." } })), /detalhes técnicos/);
});

test("ticket muito curto permanece LOW e UNCERTAIN", () => {
  const parsed = parseKnowledgeExtraction(extraction({ solution: null, procedure: [], operationalEvidenceIds: [], confidence: "LOW", candidate: "UNCERTAIN", suggestedType: "EXPLANATION" }), input);
  assert.equal(parsed.candidate, "UNCERTAIN");
});

test("ticket contraditório explicita confirmação pendente", () => {
  const parsed = parseKnowledgeExtraction(extraction({ confidence: "MEDIUM", confirmationsNeeded: ["Confirmar se a correção funcionou para todos os períodos."] }), input);
  assert.equal(parsed.confirmationsNeeded.length, 1);
});

test("ticket não reutilizável é classificado como NO", () => {
  const parsed = parseKnowledgeExtraction(extraction({ candidate: "NO", solution: null, procedure: [], operationalEvidenceIds: [], confidence: "LOW", suggestedType: "EXPLANATION" }), input);
  assert.equal(parsed.candidate, "NO");
});

test("documentação duplicada referencia somente conhecimento conhecido", () => {
  const duplicateInput = { ...input, existingKnowledge: [{ id: "known", ticketId: "ticket-known", title: "Relatório vazio", problem: null, solution: null, productFeature: null, suggestedType: "FAQ" as const, audience: "SUPPORT" as const }] };
  assert.equal(parseKnowledgeExtraction(extraction({ duplicateCandidateId: "known" }), duplicateInput).duplicateCandidateId, "known");
  assert.throws(() => parseKnowledgeExtraction(extraction({ duplicateCandidateId: "invented" }), duplicateInput), /fora da base/);
});

test("documentação para cliente é curta e sem infraestrutura", () => {
  const doc = renderKnowledgeDocument(knowledge({ audience: "CUSTOMER", suggestedType: "CUSTOMER_FACING" }));
  assert.doesNotMatch(doc.bodyMarkdown, /worker|banco de dados|infraestrutura/i);
});

test("documentação para suporte prioriza ação e linguagem simples", () => {
  const doc = renderKnowledgeDocument(knowledge({ audience: "SUPPORT" }));
  assert.match(doc.bodyMarkdown, /Passo a passo/);
  assert.match(doc.bodyMarkdown, /Informe a data final/);
});

test("documentação técnica preserva causa comprovada", () => {
  const doc = renderKnowledgeDocument(knowledge({ audience: "TECHNICAL", suggestedType: "INTERNAL_RUNBOOK", technicalCause: "A consulta excedeu o tempo limite.", languageLevels: { technical: "A consulta excedeu o tempo limite.", operational: null, support: null, customer: null } }));
  assert.match(doc.bodyMarkdown, /consulta excedeu o tempo limite/);
});

test("prompt proíbe invenção e separa fato, inferência e hipótese", () => {
  assert.match(KNOWLEDGE_EXTRACTION_PROMPT_INSTRUCTIONS, /Não invente/);
  assert.match(KNOWLEDGE_EXTRACTION_PROMPT_INSTRUCTIONS, /FACT/);
  assert.match(KNOWLEDGE_EXTRACTION_PROMPT_INSTRUCTIONS, /HYPOTHESIS/);
});

test("pipeline persiste extração, revisão, versão e renderização em etapas separadas", async () => {
  const database = createDatabase(":memory:");
  try {
    const store = new SupportStore(database);
    const account = store.upsertAccount({ phoneNumber: "+550000000001", displayName: "Conta" });
    const client = store.upsertClient({ name: "Organização exemplo", slug: "knowledge-e2e", kind: "ecommerce" });
    const group = store.upsertGroup({ accountId: account.id, clientId: client.id, externalJid: "knowledge@g.us", subject: "Atendimento" });
    const participant = store.upsertParticipant({ externalJid: "knowledge@s.whatsapp.net", displayName: "Pessoa" });
    store.addGroupParticipant(group.id, participant.id);
    const message = store.upsertMessage({ externalId: "knowledge-message", groupId: group.id, senderId: participant.id, occurredAt: "2026-08-25T12:00:00.000Z", text: "Após preencher a data final funcionou.", messageType: "text" });
    const ticket = store.createTicket({ groupId: group.id, sourceMessageId: message.id, title: "Relatório vazio", summary: "Relatório sem dados." });
    store.updateTicketStatus(ticket.id, { status: "in_progress" });
    store.updateTicketStatus(ticket.id, { status: "resolved", resolution: { summary: "Preenchemos a data final e o cliente confirmou o resultado." } });
    const draft = store.queueDocumentationDraft(ticket.id, "Analista");
    const worker = new InvestigationWorker(store, {
      analyse: async () => { throw new Error("não utilizado"); },
      investigateThread: async () => { throw new Error("não utilizado"); },
      extractKnowledge: async (received) => extraction({
        evidence: [{ id: "e1", source: "MESSAGE", reference: received.messages[0]!.id, excerpt: "Funcionou.", observedAt: null }],
      }),
    }, { recoverOrphanedJobs: false });
    assert.equal(await worker.runOne(), true);
    const extracted = store.getDocumentationDraft(draft.id);
    assert.equal(extracted.knowledgeObject?.status, "IN_REVIEW");
    assert.equal(extracted.bodyMarkdown, "");
    const approved = store.reviewKnowledgeObject(extracted.knowledgeObject!.id, { decision: "APPROVE", reasons: [] }, "Analista");
    assert.equal(approved.status, "APPROVED");
    store.queueKnowledgeDocument(approved.id, "Analista");
    assert.equal(await worker.runOne(), true);
    const rendered = store.getDocumentationDraft(draft.id);
    assert.match(rendered.bodyMarkdown, /Passo a passo/);
    assert.equal(rendered.documentType, "HOW_TO");
    assert.equal(rendered.audienceCode, "SUPPORT");
  } finally {
    database.close();
  }
});
