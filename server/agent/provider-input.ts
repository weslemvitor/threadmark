import type {
  AnalysisMessage,
  SupportAnalysisInput,
  TriageAnalysisInput,
} from "./types.js";

const SUPPORT_MESSAGE_LIMIT = 50;
const TRIAGE_CONTEXT_LIMIT = 20;
const CONVERSATION_CHARACTER_BUDGET = 160_000;
const TRIAGE_CHARACTER_BUDGET = 100_000;
const SENT_RESPONSE_CHARACTER_BUDGET = 60_000;
const RESOLVED_PRECEDENT_CHARACTER_BUDGET = 100_000;
const SENT_RESPONSE_LIMIT = 30;
const RESOLVED_PRECEDENT_LIMIT = 20;
const TRUNCATION_MARKER = "\n...[conteúdo truncado pelo limite do provedor]...\n";

export function boundProviderSupportInput(
  input: SupportAnalysisInput,
): SupportAnalysisInput {
  const conversationBudget = { remaining: CONVERSATION_CHARACTER_BUDGET };
  const messages = input.messages
    .slice(-SUPPORT_MESSAGE_LIMIT)
    .toReversed()
    .map((message) => boundMessage(message, conversationBudget))
    .reverse();
  const sentResponseBudget = { remaining: SENT_RESPONSE_CHARACTER_BUDGET };
  const precedentBudget = {
    remaining: RESOLVED_PRECEDENT_CHARACTER_BUDGET,
  };

  return {
    ...input,
    operatorInstructions: input.operatorInstructions
      ? truncate(input.operatorInstructions, 4_000)
      : input.operatorInstructions,
    accountName: truncate(input.accountName, 500),
    groupName: truncate(input.groupName, 500),
    knownEcommerces: input.knownEcommerces
      .slice(0, 250)
      .map((name) => truncate(name, 500)),
    categoryCatalog: boundCategoryCatalog(input.categoryCatalog),
    conversationState: boundConversationState(input.conversationState),
    messages,
    sentResponses: input.sentResponses
      .slice(-SENT_RESPONSE_LIMIT)
      .map((response) => ({
        id: truncate(response.id, 500),
        messageId: response.messageId
          ? truncate(response.messageId, 500)
          : null,
        body:
          consumeBudget(response.body, 8_000, sentResponseBudget) ??
          "[resposta omitida pelo limite do provedor]",
        sentAt: truncate(response.sentAt, 100),
      })),
    openTickets: input.openTickets.slice(0, 30).map((ticket) => ({
      id: ticket.id,
      title: truncate(ticket.title, 2_000),
      summary: truncate(ticket.summary, 4_000),
      status: truncate(ticket.status, 100),
    })),
    resolvedPrecedents: input.resolvedPrecedents
      .slice(0, RESOLVED_PRECEDENT_LIMIT)
      .map((precedent) => boundResolvedPrecedent(precedent, precedentBudget)),
  };
}

export function boundProviderTriageInput(
  input: TriageAnalysisInput,
): TriageAnalysisInput {
  const candidateIds = new Set(input.candidateMessageIds);
  const messagesById = new Map(
    input.messages.map((message) => [message.id, message] as const),
  );
  const context: AnalysisMessage[] = [];
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index]!;
    if (candidateIds.has(message.id)) continue;
    context.push(message);
    if (context.length >= TRIAGE_CONTEXT_LIMIT) break;
  }
  context.reverse();

  const budget = { remaining: TRIAGE_CHARACTER_BUDGET };
  const boundedById = new Map<string, AnalysisMessage>();
  for (const messageId of input.candidateMessageIds) {
    const message = messagesById.get(messageId);
    if (message) boundedById.set(messageId, boundMessage(message, budget));
  }
  for (const message of context) {
    boundedById.set(message.id, boundMessage(message, budget));
  }
  const messages = input.messages.flatMap((message) => {
    const bounded = boundedById.get(message.id);
    return bounded ? [bounded] : [];
  });

  return {
    ...input,
    accountName: truncate(input.accountName, 500),
    groupName: truncate(input.groupName, 500),
    knownEcommerces: input.knownEcommerces
      .slice(0, 250)
      .map((name) => truncate(name, 500)),
    categoryCatalog: boundCategoryCatalog(input.categoryCatalog),
    messages,
    openTickets: input.openTickets.slice(0, 30).map((ticket) => ({
      id: ticket.id,
      title: truncate(ticket.title, 2_000),
      summary: truncate(ticket.summary, 4_000),
      status: truncate(ticket.status, 100),
    })),
    pendingSuggestions: input.pendingSuggestions.slice(0, 30).map((suggestion) => ({
      id: truncate(suggestion.id, 500),
      title: truncate(suggestion.title, 2_000),
      summary: truncate(suggestion.summary, 4_000),
      suggestedAction: suggestion.suggestedAction,
      suggestedTicketId: suggestion.suggestedTicketId
        ? truncate(suggestion.suggestedTicketId, 500)
        : null,
      lastMessageAt: truncate(suggestion.lastMessageAt, 100),
    })),
  };
}

function boundCategoryCatalog(
  catalog: SupportAnalysisInput["categoryCatalog"],
): SupportAnalysisInput["categoryCatalog"] {
  if (!catalog) return undefined;
  const labels = (values: string[]) =>
    values.slice(0, 200).map((value) => truncate(value, 200));
  return {
    contactReason: labels(catalog.contactReason),
    productArea: labels(catalog.productArea),
    platform: labels(catalog.platform),
    symptom: labels(catalog.symptom),
  };
}

function boundConversationState(
  state: SupportAnalysisInput["conversationState"],
): SupportAnalysisInput["conversationState"] {
  return {
    lastExternalMessageAt: state.lastExternalMessageAt
      ? truncate(state.lastExternalMessageAt, 100)
      : null,
    lastSentResponseAt: state.lastSentResponseAt
      ? truncate(state.lastSentResponseAt, 100)
      : null,
    unansweredExternalMessageIds: state.unansweredExternalMessageIds
      .slice(-50)
      .map((id) => truncate(id, 500)),
    hasUnansweredExternalMessages: state.hasUnansweredExternalMessages,
  };
}

function boundResolvedPrecedent(
  precedent: SupportAnalysisInput["resolvedPrecedents"][number],
  budget: { remaining: number },
): SupportAnalysisInput["resolvedPrecedents"][number] {
  const requiredContent = (value: string, limit: number): string =>
    consumeBudget(value, limit, budget) ??
    "[conteúdo omitido pelo limite do provedor]";
  const optionalContent = (value: string | null, limit: number): string | null =>
    value === null ? null : requiredContent(value, limit);

  return {
    ticketId: truncate(precedent.ticketId, 500),
    title: requiredContent(precedent.title, 2_000),
    summary: requiredContent(precedent.summary, 4_000),
    resolvedAt: precedent.resolvedAt
      ? truncate(precedent.resolvedAt, 100)
      : null,
    affectedStore: precedent.affectedStore
      ? {
          id: truncate(precedent.affectedStore.id, 500),
          name: truncate(precedent.affectedStore.name, 500),
        }
      : null,
    categories: precedent.categories
      .slice(0, 30)
      .map((category) => truncate(category, 200)),
    resolution: {
      summary: requiredContent(precedent.resolution.summary, 8_000),
      rootCause: optionalContent(precedent.resolution.rootCause, 4_000),
      outcome: optionalContent(precedent.resolution.outcome, 4_000),
      validatedAt: truncate(precedent.resolution.validatedAt, 100),
    },
    finalResponse: optionalContent(precedent.finalResponse, 8_000),
  };
}

function boundMessage(
  message: AnalysisMessage,
  budget: { remaining: number },
): AnalysisMessage {
  return {
    ...message,
    author: truncate(message.author, 500),
    text: consumeBudget(message.text, 8_000, budget),
    attachments: message.attachments.slice(0, 10).map((attachment) => ({
      ...attachment,
      fileName: attachment.fileName
        ? truncate(attachment.fileName, 500)
        : null,
      // Filesystem paths are only used locally to load trusted images. They are
      // never necessary in a cloud prompt.
      localPath: null,
      extractedText: consumeBudget(
        attachment.extractedText,
        16_000,
        budget,
      ),
    })),
  };
}

function consumeBudget(
  value: string | null,
  itemLimit: number,
  budget: { remaining: number },
): string | null {
  if (value === null) return null;
  const allowed = Math.min(itemLimit, budget.remaining);
  if (allowed <= 0) return null;
  const bounded = truncate(value, allowed);
  budget.remaining -= bounded.length;
  return bounded;
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  if (limit <= TRUNCATION_MARKER.length) return value.slice(0, limit);
  const available = limit - TRUNCATION_MARKER.length;
  const start = Math.ceil(available / 2);
  const end = available - start;
  return `${value.slice(0, start)}${TRUNCATION_MARKER}${
    end ? value.slice(-end) : ""
  }`;
}
