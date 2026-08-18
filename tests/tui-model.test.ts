import assert from "node:assert/strict";
import test from "node:test";

import type {
  LatestInvestigationDto,
  SentResponseDto,
  SuggestionDto,
  TicketStatus,
  TicketSummaryDto,
} from "../shared/contracts.js";
import {
  filterTickets,
  formatRelativeTime,
  getLayoutMode,
  getOperationalNextAction,
  getOperationalSuggestion,
  nextFilter,
  truncateText,
  visibleTicketWindow,
} from "../tui/model.js";

function ticket(
  id: string,
  overrides: Partial<TicketSummaryDto> = {},
): TicketSummaryDto {
  return {
    id,
    number: Number(id),
    title: `Ticket ${id}`,
    summary: "Resumo",
    status: "new",
    priority: "normal",
    confidence: null,
    needsReview: false,
    relation: null,
    nextAction: null,
    requester: {
      id: "requester",
      displayName: "Pessoa Fictícia Gama",
      phoneE164: "+5547999999999",
    },
    assignee: null,
    client: {
      id: "client",
      name: "Cliente",
      kind: "ecommerce",
      isUnidentified: false,
    },
    group: { id: "group", subject: "Grupo", externalJid: "group@g.us" },
    affectedStore: null,
    productForwarding: null,
    categories: [],
    firstMessageAt: "2026-07-16T12:00:00.000Z",
    lastMessageAt: "2026-07-16T12:00:00.000Z",
    createdAt: "2026-07-16T12:00:00.000Z",
    updatedAt: "2026-07-16T12:00:00.000Z",
    resolvedAt: null,
    messageCount: 1,
    latestSuggestion: null,
    ...overrides,
  };
}

function suggestion(
  id: string,
  createdAt: string,
  status: SuggestionDto["status"] = "candidate",
): SuggestionDto {
  return {
    id,
    body: `Resposta ${id}`,
    confidence: 0.9,
    evidence: [],
    missingInformation: [],
    status,
    model: "codex",
    promptVersion: null,
    createdAt,
  };
}

function investigation(
  overrides: Partial<LatestInvestigationDto> = {},
): LatestInvestigationDto {
  return {
    id: "investigation",
    state: "completed",
    instructions: null,
    requestedAt: "2026-07-16T14:15:00.000Z",
    startedAt: "2026-07-16T14:16:00.000Z",
    finishedAt: "2026-07-16T14:20:00.000Z",
    error: null,
    outcome: "already_answered",
    confidence: 0.95,
    evidence: [],
    missingInformation: [],
    nextAction: null,
    suggestedResponse: null,
    ...overrides,
  };
}

function response(
  sentAt: string,
  capturedAt: string,
): SentResponseDto {
  return {
    id: "sent-response",
    body: "Resposta enviada pela equipe",
    messageId: "message",
    sentAt,
    capturedAt,
  };
}

function suggestionTicket(input: {
  suggestions: SuggestionDto[];
  status?: TicketStatus;
  sentResponses?: SentResponseDto[];
  latestInvestigation?: LatestInvestigationDto | null;
  lastMessageAt?: string;
  nextAction?: string | null;
}) {
  return {
    suggestions: input.suggestions,
    status: input.status ?? "in_progress",
    sentResponses: input.sentResponses ?? [],
    latestInvestigation: input.latestInvestigation ?? null,
    lastMessageAt: input.lastMessageAt ?? "2026-07-16T14:10:00.000Z",
    nextAction: input.nextAction ?? null,
  };
}

test("TUI escolhe layouts estáveis nos breakpoints suportados", () => {
  assert.equal(getLayoutMode(160), "wide");
  assert.equal(getLayoutMode(120), "wide");
  assert.equal(getLayoutMode(119), "medium");
  assert.equal(getLayoutMode(80), "medium");
  assert.equal(getLayoutMode(79), "compact");
  assert.equal(getLayoutMode(48), "compact");
});

test("filtros separam atenção, abertos, revisão e todos", () => {
  const tickets = [
    ticket("1", { priority: "high" }),
    ticket("2", { needsReview: true }),
    ticket("3", { status: "in_progress" }),
    ticket("4", { status: "resolved", needsReview: true }),
  ];

  assert.deepEqual(filterTickets(tickets, "attention").map(({ id }) => id), [
    "1",
    "2",
  ]);
  assert.deepEqual(filterTickets(tickets, "open").map(({ id }) => id), [
    "1",
    "2",
    "3",
  ]);
  assert.deepEqual(filterTickets(tickets, "review").map(({ id }) => id), [
    "2",
    "4",
  ]);
  assert.equal(filterTickets(tickets, "all").length, 4);
  assert.equal(nextFilter("all"), "attention");
});

test("janela da fila acompanha a seleção sem perder os limites", () => {
  const items = Array.from({ length: 10 }, (_, index) => index);
  assert.deepEqual(visibleTicketWindow(items, 0, 4), {
    items: [0, 1, 2, 3],
    start: 0,
  });
  assert.deepEqual(visibleTicketWindow(items, 7, 4), {
    items: [5, 6, 7, 8],
    start: 5,
  });
  assert.deepEqual(visibleTicketWindow(items, 9, 4), {
    items: [6, 7, 8, 9],
    start: 6,
  });
});

test("formatação compacta é legível e determinística", () => {
  const now = Date.parse("2026-07-16T15:00:00.000Z");
  assert.equal(formatRelativeTime("2026-07-16T14:59:20.000Z", now), "40s");
  assert.equal(formatRelativeTime("2026-07-16T14:15:00.000Z", now), "45m");
  assert.equal(formatRelativeTime("2026-07-14T15:00:00.000Z", now), "2d");
  assert.equal(truncateText("  texto   com espaços  ", 20), "texto com espaços");
  assert.equal(truncateText("abcdefghij", 6), "abcde…");
});

test("TUI ignora sugestões que não são mais candidatas", () => {
  const current = suggestion("current", "2026-07-16T14:20:00.000Z");
  const superseded = suggestion(
    "superseded",
    "2026-07-16T14:30:00.000Z",
    "superseded",
  );

  assert.equal(
    getOperationalSuggestion(
      suggestionTicket({ suggestions: [superseded, current] }),
    )?.id,
    "current",
  );
  assert.equal(
    getOperationalSuggestion(
      suggestionTicket({ suggestions: [superseded] }),
    ),
    null,
  );
});

test("TUI usa o horário de envio, não o de importação da resposta", () => {
  const stale = suggestion("stale", "2026-07-16T14:10:00.000Z");
  const fresh = suggestion("fresh", "2026-07-16T14:13:00.000Z");
  const sentResponse = response(
    "2026-07-16T14:12:00.000Z",
    "2026-07-16T14:12:00.000Z",
  );

  assert.equal(
    getOperationalSuggestion(
      suggestionTicket({ suggestions: [stale], sentResponses: [sentResponse] }),
    ),
    null,
  );
  assert.equal(
    getOperationalSuggestion(
      suggestionTicket({
        suggestions: [stale, fresh],
        sentResponses: [sentResponse],
      }),
    )?.id,
    "fresh",
  );
});

test("TUI preserva minuta final criada após ACK capturado com atraso", () => {
  const finalAnswer = suggestion("final", "2026-07-16T14:10:00.000Z");
  const lateCapturedAck = response(
    "2026-07-16T14:05:00.000Z",
    "2026-07-16T14:12:00.000Z",
  );

  assert.equal(
    getOperationalSuggestion(
      suggestionTicket({
        suggestions: [finalAnswer],
        sentResponses: [lateCapturedAck],
      }),
    )?.id,
    "final",
  );
});

test("TUI não oferece sugestão superada por investigação já respondida", () => {
  const stale = suggestion("stale", "2026-07-16T14:19:00.000Z");
  const fresh = suggestion("fresh", "2026-07-16T14:21:00.000Z");
  const answered = investigation();

  assert.equal(
    getOperationalSuggestion(
      suggestionTicket({ suggestions: [stale], latestInvestigation: answered }),
    ),
    null,
  );
  assert.equal(
    getOperationalSuggestion(
      suggestionTicket({
        suggestions: [stale, fresh],
        latestInvestigation: answered,
      }),
    )?.id,
    "fresh",
  );
});

test("TUI nunca oferece sugestão em ticket terminal", () => {
  const current = suggestion("current", "2026-07-16T14:20:00.000Z");

  for (const status of ["resolved", "archived"] as const) {
    assert.equal(
      getOperationalSuggestion(
        suggestionTicket({ suggestions: [current], status }),
      ),
      null,
    );
  }
});

test("TUI oculta próxima ação antiga em ticket terminal ou reanálise ativa", () => {
  const oldAction = "Ação da análise anterior";
  assert.equal(
    getOperationalNextAction(
      suggestionTicket({
        suggestions: [],
        status: "resolved",
        nextAction: oldAction,
      }),
    ),
    null,
  );
  assert.equal(
    getOperationalNextAction(
      suggestionTicket({
        suggestions: [],
        nextAction: oldAction,
        latestInvestigation: investigation({
          state: "queued",
          outcome: null,
          finishedAt: null,
        }),
      }),
    ),
    null,
  );
});
