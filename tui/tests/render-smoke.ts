import assert from "node:assert/strict";

import { createTestRenderer } from "@opentui/core/testing";

import type {
  DashboardResponse,
  RuntimeStatusDto,
  TicketDetailDto,
} from "../../shared/contracts.js";
import { EMPTY_INVESTIGATIONS, type TuiState } from "../model.js";
import { renderSupportTui, selectedSuggestionBody } from "../view.js";

const runtime: RuntimeStatusDto = {
  state: "offline",
  pid: 123,
  startedAt: "2026-07-16T12:00:00.000Z",
  lastHeartbeatAt: "2026-07-16T15:00:00.000Z",
  lastSyncAt: null,
  connectedAccount: null,
  whatsappConnected: false,
  qrAvailable: false,
  groupsDiscovered: 30,
  groupsSynced: 30,
  privateConversations: 120,
  messagesStored: 1_500,
  ticketsCreated: 42,
  monitoredGroups: 30,
  lastError: null,
  whatsappEnabled: false,
  agentEnabled: true,
};

const ticket: TicketDetailDto = {
  id: "ticket",
  number: 42,
  title: "Pedidos da Loja Exemplo Gama ausentes no dashboard",
  summary: "Cliente relata pedidos ausentes no período da manhã.",
  status: "in_progress",
  priority: "high",
  confidence: 0.92,
  needsReview: false,
  relation: "new",
  nextAction: "Validar os IDs dos pedidos no banco de produção em modo readonly.",
  requester: {
    id: "requester",
    displayName: "Pessoa Exemplo",
    phoneE164: "+5500000000001",
  },
  assignee: null,
  requesterOverrideId: null,
  requesterCandidates: [
    {
      id: "requester",
      displayName: "Pessoa Exemplo",
      phoneE164: "+5500000000001",
    },
  ],
  client: {
    id: "client",
    name: "Organização Exemplo Alfa",
    kind: "agency",
    isUnidentified: false,
  },
  group: {
    id: "group",
    subject: "Atendimento + Organização Exemplo Alfa",
    externalJid: "group@g.us",
  },
  affectedStore: {
    id: "store",
    name: "Loja Exemplo Gama",
    businessId: "business",
    platform: "VTEX",
  },
  productForwarding: null,
  categories: [
    { id: "category", facet: "symptom", slug: "pedidos-ausentes", label: "Pedidos ausentes", color: null },
  ],
  firstMessageAt: "2026-07-16T14:00:00.000Z",
  lastMessageAt: "2026-07-16T14:05:00.000Z",
  createdAt: "2026-07-16T14:00:00.000Z",
  updatedAt: "2026-07-16T14:05:00.000Z",
  resolvedAt: null,
  messageCount: 2,
  latestSuggestion: { id: "suggestion", confidence: 0.88, status: "candidate" },
  directoryContext: {
    records: [],
    explicitRecordIds: [],
  },
  timeline: [],
  suggestions: [
    {
      id: "suggestion",
      body: "Recebemos os exemplos e estamos validando a sincronização dos pedidos informados.",
      confidence: 0.88,
      evidence: [],
      missingInformation: ["Horário exato"],
      status: "candidate",
      model: "codex",
      promptVersion: null,
      createdAt: "2026-07-16T14:10:00.000Z",
    },
  ],
  sentResponses: [],
  resolution: null,
  latestInvestigation: null,
  investigationThread: null,
};

const dashboard: DashboardResponse = {
  totals: {
    tickets: 42,
    open: 8,
    needsReview: 3,
    resolved: 34,
    orphanDemands: 1,
    clients: 18,
    groups: 18,
    records: 0,
  },
  statusCounts: [],
  ticketsByDay: [],
  topCategories: [],
  topGroups: [],
  topRecords: [],
  recordBreakdowns: [],
  fieldBreakdowns: [],
  topClients: [],
  recentTickets: [ticket],
};

function state(
  compactPane: TuiState["compactPane"] = "queue",
  selectedTicket: TicketDetailDto = ticket,
): TuiState {
  return {
    runtime,
    dashboard,
    tickets: [selectedTicket],
    groups: [],
    investigations: EMPTY_INVESTIGATIONS,
    refreshedAt: "2026-07-16T15:00:00.000Z",
    apiOnline: true,
    error: null,
    selectedTicketId: selectedTicket.id,
    selectedTicket,
    selectedIndex: 0,
    filter: "open",
    compactPane,
    overlay: null,
    loading: false,
    notice: null,
  };
}

async function capture(width: number, height: number, tuiState: TuiState) {
  const setup = await createTestRenderer({ width, height });
  try {
    renderSupportTui(setup.renderer, tuiState);
    await setup.flush();
    return setup.captureCharFrame();
  } finally {
    setup.renderer.destroy();
  }
}

const wide = await capture(140, 40, state());
assert.match(wide, /THREADMARK/);
assert.match(wide, /INBOX/);
assert.match(wide, /OPERAÇÃO/);
assert.match(wide, /Pedidos da Loja Exemplo Gama/);
assert.match(wide, /Pessoa Exemplo/);

const medium = await capture(100, 30, state());
assert.match(medium, /ABERTOS 8/);
assert.match(medium, /INBOX/);
assert.match(medium, /PRÓXIMA AÇÃO|AÇÃO/);

const compactQueue = await capture(72, 24, state("queue"));
assert.match(compactQueue, /INBOX/);
assert.match(compactQueue, /#42/);

const compactDetail = await capture(72, 24, state("detail"));
assert.match(compactDetail, /#42/);
assert.match(compactDetail, /SUGESTÃO/);
assert.match(compactDetail, /Recebemos os exemplos/);

const supersededTicket: TicketDetailDto = {
  ...ticket,
  suggestions: ticket.suggestions.map((suggestion) => ({
    ...suggestion,
    status: "superseded",
  })),
};
const supersededState = state("detail", supersededTicket);
const supersededDetail = await capture(72, 24, supersededState);
assert.doesNotMatch(supersededDetail, /Recebemos os exemplos/);
assert.match(supersededDetail, /Nenhuma sugestão atual/);
assert.equal(selectedSuggestionBody(supersededState), null);

const manuallyAnsweredTicket: TicketDetailDto = {
  ...ticket,
  sentResponses: [
    {
      id: "sent-response",
      body: "Resposta enviada pela equipe.",
      messageId: "staff-message",
      sentAt: "2026-07-16T14:11:00.000Z",
      capturedAt: "2026-07-16T14:11:00.000Z",
    },
  ],
};
const manuallyAnsweredState = state("detail", manuallyAnsweredTicket);
const manuallyAnsweredDetail = await capture(72, 24, manuallyAnsweredState);
assert.doesNotMatch(manuallyAnsweredDetail, /Recebemos os exemplos/);
assert.equal(selectedSuggestionBody(manuallyAnsweredState), null);

const alreadyAnsweredTicket: TicketDetailDto = {
  ...ticket,
  latestInvestigation: {
    id: "answered-investigation",
    state: "completed",
    instructions: null,
    requestedAt: "2026-07-16T14:15:00.000Z",
    startedAt: "2026-07-16T14:16:00.000Z",
    finishedAt: "2026-07-16T14:20:00.000Z",
    error: null,
    outcome: "already_answered",
    confidence: 0.98,
    evidence: [],
    missingInformation: [],
    nextAction: null,
    suggestedResponse: null,
  },
};
const alreadyAnsweredState = state("detail", alreadyAnsweredTicket);
const alreadyAnsweredDetail = await capture(72, 24, alreadyAnsweredState);
assert.doesNotMatch(alreadyAnsweredDetail, /Recebemos os exemplos/);
assert.equal(selectedSuggestionBody(alreadyAnsweredState), null);

const resolvedTicket: TicketDetailDto = {
  ...ticket,
  status: "resolved",
  resolvedAt: "2026-07-16T14:30:00.000Z",
};
const resolvedState = state("detail", resolvedTicket);
const resolvedDetail = await capture(72, 24, resolvedState);
assert.doesNotMatch(resolvedDetail, /Recebemos os exemplos/);
assert.doesNotMatch(resolvedDetail, /Validar os IDs dos pedidos/);
assert.equal(selectedSuggestionBody(resolvedState), null);

console.log(
  "OpenTUI render smoke: layouts e seleção operacional de sugestões passaram.",
);
