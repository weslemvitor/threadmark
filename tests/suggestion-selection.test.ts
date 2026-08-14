import assert from "node:assert/strict";
import test from "node:test";
import type { LatestInvestigationDto, SuggestionDto } from "../shared/contracts.js";
import {
  getSuggestedResponse,
  getSuggestion,
  isLatestInvestigationSuperseded,
} from "../app/lib/format.js";

function suggestion(
  id: string,
  body: string,
  status: SuggestionDto["status"],
  createdAt: string,
  model: string | null = null,
  promptVersion: string | null = null,
): SuggestionDto {
  return {
    id,
    body,
    confidence: 0.9,
    evidence: [],
    missingInformation: [],
    status,
    model,
    promptVersion,
    createdAt,
  };
}

function automaticResponse(
  body: string | null,
  outcome: LatestInvestigationDto["outcome"] = body
    ? "reply_ready"
    : "technical_investigation_required",
): LatestInvestigationDto {
  return {
    id: "automatic-1",
    state: "completed",
    instructions: null,
    requestedAt: "2026-07-17T00:00:00.000Z",
    startedAt: "2026-07-17T00:00:01.000Z",
    finishedAt: "2026-07-17T00:00:02.000Z",
    error: null,
    outcome,
    confidence: 0.8,
    evidence: [],
    missingInformation: [],
    nextAction: null,
    suggestedResponse: body,
  };
}

test("sugestão candidata mais recente vence análise automática antiga", () => {
  const olderCandidate = suggestion(
    "candidate-old",
    "Resposta candidata antiga",
    "candidate",
    "2026-07-17T00:05:00.000Z",
  );
  const conversationalCandidate = suggestion(
    "candidate-chat",
    "Resposta produzida na sala",
    "candidate",
    "2026-07-17T00:10:00.000Z",
    "codex-conversational",
    "investigation-thread-v1",
  );
  const ticket = {
    suggestions: [olderCandidate, conversationalCandidate],
    latestInvestigation: automaticResponse("Resposta automática antiga"),
  };

  assert.equal(getSuggestion(ticket)?.id, "candidate-chat");
  assert.equal(getSuggestedResponse(ticket), "Resposta produzida na sala");
});

test("não ressuscita sugestão superseded quando análise atual não tem resposta", () => {
  const ticket = {
    suggestions: [
      suggestion(
        "superseded-1",
        "Não deve aparecer",
        "superseded",
        "2026-07-17T00:10:00.000Z",
      ),
    ],
    latestInvestigation: automaticResponse(null),
  };

  assert.equal(getSuggestion(ticket), null);
  assert.equal(getSuggestedResponse(ticket), null);
});

test("não exibe nem permite copiar sugestão antiga quando o atendimento já foi respondido", () => {
  const ticket = {
    suggestions: [
      suggestion(
        "candidate-before-reply",
        "Resposta candidata que ficou obsoleta",
        "candidate",
        "2026-07-17T00:00:01.000Z",
      ),
      suggestion(
        "accepted-before-reply",
        "Resposta aceita anteriormente",
        "accepted",
        "2026-07-17T00:00:00.000Z",
      ),
    ],
    latestInvestigation: automaticResponse(null, "already_answered"),
  };

  assert.equal(getSuggestion(ticket), null);
  assert.equal(getSuggestedResponse(ticket), null);
});

test("sala profunda pode publicar resposta nova após análise já respondida", () => {
  const ticket = {
    suggestions: [
      suggestion(
        "deep-after-answered",
        "Conclusão nova da investigação profunda",
        "candidate",
        "2026-07-17T00:10:00.000Z",
      ),
    ],
    latestInvestigation: automaticResponse(null, "already_answered"),
    sentResponses: [],
  };

  assert.equal(getSuggestion(ticket)?.id, "deep-after-answered");
  assert.equal(
    getSuggestedResponse(ticket),
    "Conclusão nova da investigação profunda",
  );
});

test("marca o snapshot automático como superado após nova atividade do atendimento", () => {
  const ticket = {
    suggestions: [],
    latestInvestigation: automaticResponse(null),
    lastMessageAt: "2026-07-17T00:03:00.000Z",
  };

  assert.equal(isLatestInvestigationSuperseded(ticket), true);
});

test("não invalida snapshot concluído depois da última atividade conhecida", () => {
  const ticket = {
    suggestions: [],
    latestInvestigation: automaticResponse(null),
    lastMessageAt: "2026-07-17T00:00:00.000Z",
  };

  assert.equal(isLatestInvestigationSuperseded(ticket), false);
});

test("turno profundo posterior supera orientação automática sem nova minuta", () => {
  const ticket = {
    suggestions: [],
    latestInvestigation: automaticResponse("Resposta automática antiga"),
    investigationThread: {
      id: "thread-1",
      status: "concluded" as const,
      updatedAt: "2026-07-17T00:10:00.000Z",
      lastAssistantMessageAt: "2026-07-17T00:10:00.000Z",
      activeTurnState: null,
    },
  };

  assert.equal(isLatestInvestigationSuperseded(ticket), true);
  assert.equal(getSuggestedResponse(ticket), null);
});

test("abrir uma sala vazia não supera a análise automática", () => {
  const ticket = {
    suggestions: [],
    latestInvestigation: automaticResponse(null),
    investigationThread: {
      id: "thread-empty",
      status: "active" as const,
      updatedAt: "2026-07-17T00:10:00.000Z",
      lastAssistantMessageAt: null,
      activeTurnState: null,
    },
  };

  assert.equal(isLatestInvestigationSuperseded(ticket), false);
});

test("result_json nunca ressuscita resposta sem sugestão candidata materializada", () => {
  const ticket = {
    suggestions: [
      suggestion(
        "duplicate-superseded",
        "Resposta que já havia sido enviada",
        "superseded",
        "2026-07-17T00:10:00.000Z",
      ),
    ],
    latestInvestigation: automaticResponse(
      "Resposta que já havia sido enviada",
    ),
    sentResponses: [
      {
        id: "sent-before-analysis",
        body: "Resposta que já havia sido enviada",
        messageId: "staff-message-before-analysis",
        sentAt: "2026-07-17T00:00:00.000Z",
        capturedAt: "2026-07-17T00:00:00.000Z",
      },
    ],
  };

  assert.equal(getSuggestedResponse(ticket), null);
});

test("status accepted legado permanece apenas no histórico", () => {
  const ticket = {
    suggestions: [
      suggestion(
        "legacy-accepted",
        "Resposta aceita em um fluxo legado",
        "accepted",
        "2026-07-17T00:10:00.000Z",
      ),
    ],
    latestInvestigation: null,
    sentResponses: [],
  };

  assert.equal(getSuggestion(ticket), null);
  assert.equal(getSuggestedResponse(ticket), null);
});

test("ticket resolvido nunca oferece resposta para copiar", () => {
  const ticket = {
    status: "resolved" as const,
    suggestions: [
      suggestion(
        "candidate-before-resolution",
        "Minuta anterior ao encerramento",
        "candidate",
        "2026-07-17T00:10:00.000Z",
      ),
    ],
    latestInvestigation: automaticResponse("Minuta anterior ao encerramento"),
    sentResponses: [],
  };

  assert.equal(getSuggestion(ticket), null);
  assert.equal(getSuggestedResponse(ticket), null);
});

test("resposta manual posterior não ressuscita a minuta da última investigação", () => {
  const ticket = {
    suggestions: [
      suggestion(
        "superseded-after-manual-reply",
        "Minuta que já foi respondida manualmente",
        "superseded",
        "2026-07-17T00:00:02.000Z",
      ),
    ],
    latestInvestigation: automaticResponse(
      "Minuta que já foi respondida manualmente",
    ),
    sentResponses: [
      {
        id: "sent-after-investigation",
        body: "Resposta realmente enviada pelo operador",
        messageId: "message-staff-1",
        sentAt: "2026-07-17T00:05:00.000Z",
        capturedAt: "2026-07-17T00:05:01.000Z",
      },
    ],
  };

  assert.equal(getSuggestion(ticket), null);
  assert.equal(getSuggestedResponse(ticket), null);
});

test("resposta enviada no mesmo instante invalida a minuta", () => {
  const ticket = {
    suggestions: [
      suggestion(
        "same-second-candidate",
        "Minuta obsoleta",
        "candidate",
        "2026-07-17T10:00:00.000Z",
      ),
    ],
    latestInvestigation: {
      ...automaticResponse("Minuta obsoleta"),
      finishedAt: "2026-07-17T10:00:00.500Z",
    },
    sentResponses: [
      {
        id: "same-second-response",
        body: "Resposta enviada no mesmo segundo",
        messageId: "message-staff-same-second",
        sentAt: "2026-07-17T10:00:00.000Z",
        capturedAt: "2026-07-17T10:00:01.000Z",
      },
    ],
  };

  assert.equal(getSuggestedResponse(ticket), null);
});

test("captura tardia de resposta anterior não apaga uma minuta final nova", () => {
  const ticket = {
    suggestions: [
      suggestion(
        "candidate-after-ack",
        "Resposta final produzida depois do aviso inicial",
        "candidate",
        "2026-07-17T10:05:00.000Z",
      ),
    ],
    latestInvestigation: automaticResponse(
      "Resposta final produzida depois do aviso inicial",
    ),
    sentResponses: [
      {
        id: "late-captured-ack",
        body: "Vou verificar e retorno em seguida.",
        messageId: "message-staff-ack",
        sentAt: "2026-07-17T10:00:00.000Z",
        capturedAt: "2026-07-17T10:10:00.000Z",
      },
    ],
  };

  assert.equal(getSuggestion(ticket)?.id, "candidate-after-ack");
  assert.equal(
    getSuggestedResponse(ticket),
    "Resposta final produzida depois do aviso inicial",
  );
});

test("nova sugestão posterior à resposta manual continua disponível", () => {
  const ticket = {
    suggestions: [
      suggestion(
        "candidate-after-new-demand",
        "Resposta nova para a demanda posterior",
        "candidate",
        "2026-07-17T00:10:00.000Z",
      ),
    ],
    latestInvestigation: automaticResponse(
      "Resposta nova para a demanda posterior",
    ),
    sentResponses: [
      {
        id: "sent-before-new-demand",
        body: "Resposta do assunto anterior",
        messageId: "message-staff-1",
        sentAt: "2026-07-17T00:05:00.000Z",
        capturedAt: "2026-07-17T00:05:01.000Z",
      },
    ],
  };

  assert.equal(getSuggestion(ticket)?.id, "candidate-after-new-demand");
  assert.equal(
    getSuggestedResponse(ticket),
    "Resposta nova para a demanda posterior",
  );
});
