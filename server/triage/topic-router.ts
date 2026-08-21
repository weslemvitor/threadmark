export const TOPIC_CANDIDATE_WINDOW_MS = 4 * 60 * 60_000;
export const MESSAGE_BURST_WINDOW_MS = 3 * 60_000;
export const STRONG_CONTINUATION_WINDOW_MS = 30 * 60_000;
export const TOPIC_SIMILARITY_THRESHOLD = 0.35;
export const TOPIC_SIMILARITY_MARGIN = 0.15;

export interface TopicTicketCandidate {
  id: string;
  status: string;
  lastMessageAt: string;
  lastSenderId: string | null;
  affectedStoreId: string | null;
  topicText: string;
}

export interface QuotedTicketReference {
  id: string;
  status: string;
}

export interface TopicRoutingInput {
  occurredAt: string;
  text: string | null;
  senderId: string | null;
  explicitNewTopic: boolean;
  affectedStoreId: string | null;
  quotedTicket: QuotedTicketReference | null;
  candidates: readonly TopicTicketCandidate[];
  candidateWindowMs?: number;
}

export type TopicRoutingReason =
  | "explicit_new_topic"
  | "quoted_open_ticket"
  | "quoted_closed_ticket"
  | "different_store"
  | "message_burst"
  | "strong_continuation"
  | "topic_similarity"
  | "no_candidate"
  | "ambiguous";

export interface TopicCandidateScore {
  ticketId: string;
  similarity: number;
}

export interface TopicRoutingDecision {
  action: "attach" | "create";
  targetTicketId: string | null;
  relatedTicketId: string | null;
  needsReview: boolean;
  reason: TopicRoutingReason;
  scores: TopicCandidateScore[];
}

const closedStatuses = new Set(["resolved", "cancelled", "archived"]);
const continuationSignals = /\b(tambem|ainda|continua|continuando|sobre isso|sobre esse|sobre essa|nesse caso|neste caso|segue|segue o anexo|conforme|complementando|mais detalhes|mais um print|mesmo problema|resolvido|resolveu|funcionou|deu certo|voltou|normalizou)\b/i;
const topicFamilies: ReadonlyArray<readonly [string, RegExp]> = [
  ["customer_metrics", /\b(clientes?|recorrentes?|novos? clientes?|total de clientes|ltv|coorte)\b/i],
  ["orders", /\b(pedidos?|orders?|vendas?|receita|faturamento|ticket medio)\b/i],
  ["tracking", /\b(rastreamento|tracking|pixel|utm|eventos?|pageview|conversao)\b/i],
  ["feed", /\b(feed|catalogo|sku|merchant|produto rejeitado|produtos rejeitados)\b/i],
  ["popup", /\b(pop-?up|captura de leads?|newsletter)\b/i],
  ["integration", /\b(integracao|api|token|credenciais?|oauth|webhook)\b/i],
  ["audience", /\b(audiencias?|segmentos?|filtros? de audiencia)\b/i],
  ["campaign", /\b(campanhas?|anuncios?|meta ads|google ads|criativos?)\b/i],
];
const stopWords = new Set([
  "a",
  "ao",
  "aos",
  "as",
  "com",
  "como",
  "da",
  "das",
  "de",
  "do",
  "dos",
  "e",
  "ela",
  "ele",
  "em",
  "essa",
  "esse",
  "esta",
  "este",
  "eu",
  "foi",
  "isso",
  "ja",
  "mas",
  "na",
  "nas",
  "no",
  "nos",
  "o",
  "os",
  "ou",
  "para",
  "por",
  "que",
  "se",
  "sem",
  "so",
  "um",
  "uma",
  "vocês",
  "voces",
]);

export function routeTopic(input: TopicRoutingInput): TopicRoutingDecision {
  if (input.explicitNewTopic) {
    return createDecision("explicit_new_topic");
  }

  if (input.quotedTicket) {
    if (isOpen(input.quotedTicket.status)) {
      return attachDecision(input.quotedTicket.id, "quoted_open_ticket");
    }
    return createDecision("quoted_closed_ticket", {
      relatedTicketId: input.quotedTicket.id,
      needsReview: true,
    });
  }

  const occurredAt = timestamp(input.occurredAt);
  const candidateWindowMs = Math.max(
    0,
    input.candidateWindowMs ?? TOPIC_CANDIDATE_WINDOW_MS,
  );
  const temporallyEligible = input.candidates.filter((candidate) => {
    const lastMessageAt = timestamp(candidate.lastMessageAt);
    return (
      isOpen(candidate.status) &&
      lastMessageAt <= occurredAt &&
      lastMessageAt >= occurredAt - candidateWindowMs
    );
  });
  const storeCompatible = temporallyEligible.filter((candidate) =>
    isStoreCompatible(input.affectedStoreId, candidate.affectedStoreId),
  );

  if (storeCompatible.length === 0) {
    const excludedByStore = temporallyEligible.some(
      (candidate) =>
        input.affectedStoreId !== null &&
        candidate.affectedStoreId !== null &&
        input.affectedStoreId !== candidate.affectedStoreId,
    );
    return createDecision(excludedByStore ? "different_store" : "no_candidate");
  }

  const burstCandidates = storeCompatible.filter((candidate) => {
    const elapsed = occurredAt - timestamp(candidate.lastMessageAt);
    return (
      elapsed <= MESSAGE_BURST_WINDOW_MS &&
      input.senderId !== null &&
      candidate.lastSenderId !== null &&
      input.senderId === candidate.lastSenderId &&
      !hasTopicFamilyConflict(input.text, candidate.topicText)
    );
  });
  if (burstCandidates.length === 1) {
    return attachDecision(burstCandidates[0]!.id, "message_burst");
  }

  const recentCandidates = storeCompatible.filter(
    (candidate) =>
      occurredAt - timestamp(candidate.lastMessageAt) <=
        STRONG_CONTINUATION_WINDOW_MS &&
      !hasTopicFamilyConflict(input.text, candidate.topicText),
  );
  if (hasStrongContinuationSignal(input.text) && recentCandidates.length === 1) {
    return attachDecision(recentCandidates[0]!.id, "strong_continuation");
  }

  const scores = scoreCandidates(input.text, storeCompatible);
  const best = scores[0];
  const second = scores[1];
  const margin = best ? best.similarity - (second?.similarity ?? 0) : 0;
  if (
    best &&
    best.similarity >= TOPIC_SIMILARITY_THRESHOLD &&
    (scores.length === 1 || margin >= TOPIC_SIMILARITY_MARGIN)
  ) {
    return attachDecision(best.ticketId, "topic_similarity", scores);
  }

  return createDecision("ambiguous", { needsReview: true, scores });
}

export function topicSimilarity(left: string | null, right: string | null): number {
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  const union = leftTokens.size + rightTokens.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function hasStrongContinuationSignal(text: string | null): boolean {
  return continuationSignals.test(normalize(text));
}

export function hasTopicFamilyConflict(
  left: string | null,
  right: string | null,
): boolean {
  const leftFamilies = detectTopicFamilies(left);
  const rightFamilies = detectTopicFamilies(right);
  if (leftFamilies.size === 0 || rightFamilies.size === 0) return false;
  return ![...leftFamilies].some((family) => rightFamilies.has(family));
}

function detectTopicFamilies(text: string | null): Set<string> {
  const normalized = normalize(text);
  return new Set(
    topicFamilies
      .filter(([, pattern]) => pattern.test(normalized))
      .map(([family]) => family),
  );
}

function scoreCandidates(
  text: string | null,
  candidates: readonly TopicTicketCandidate[],
): TopicCandidateScore[] {
  return candidates
    .map((candidate) => ({
      ticketId: candidate.id,
      similarity: topicSimilarity(text, candidate.topicText),
      lastMessageAt: timestamp(candidate.lastMessageAt),
    }))
    .sort(
      (left, right) =>
        right.similarity - left.similarity ||
        right.lastMessageAt - left.lastMessageAt ||
        left.ticketId.localeCompare(right.ticketId),
    )
    .map(({ ticketId, similarity }) => ({ ticketId, similarity }));
}

function tokens(text: string | null): Set<string> {
  return new Set(
    normalize(text)
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 2 && !stopWords.has(token)),
  );
}

function normalize(text: string | null): string {
  return (text ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new RangeError(`Timestamp inválido no roteamento: ${value}`);
  }
  return parsed;
}

function isOpen(status: string): boolean {
  return !closedStatuses.has(status);
}

function isStoreCompatible(
  incomingStoreId: string | null,
  candidateStoreId: string | null,
): boolean {
  return (
    incomingStoreId === null ||
    candidateStoreId === null ||
    incomingStoreId === candidateStoreId
  );
}

function attachDecision(
  ticketId: string,
  reason: TopicRoutingReason,
  scores: TopicCandidateScore[] = [],
): TopicRoutingDecision {
  return {
    action: "attach",
    targetTicketId: ticketId,
    relatedTicketId: null,
    needsReview: false,
    reason,
    scores,
  };
}

function createDecision(
  reason: TopicRoutingReason,
  options: {
    relatedTicketId?: string | null;
    needsReview?: boolean;
    scores?: TopicCandidateScore[];
  } = {},
): TopicRoutingDecision {
  return {
    action: "create",
    targetTicketId: null,
    relatedTicketId: options.relatedTicketId ?? null,
    needsReview: options.needsReview ?? false,
    reason,
    scores: options.scores ?? [],
  };
}
