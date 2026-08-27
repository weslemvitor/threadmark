import type { SupportStore, TriageCandidate } from "../domain/index.js";
import type { TriageAnalysis } from "../agent/types.js";
import { classifyTriageCandidate } from "./classifier.js";
import { routeTopic } from "./topic-router.js";

export interface TriageBatchResult {
  processed: number;
  suggestedCreate: number;
  suggestedAttach: number;
  suggestedIgnore: number;
  failed: number;
}

export function buildLocalTriageAnalysis(
  store: SupportStore,
  candidates: TriageCandidate[],
  recentConversationWindowMs = 4 * 60 * 60_000,
): TriageAnalysis {
  return {
    groups: candidates.map((candidate) => {
      const decision = classifyTriageCandidate(candidate);
      const sinceAt = new Date(
        new Date(candidate.occurredAt).getTime() - recentConversationWindowMs,
      ).toISOString();
      const routingText = candidateRoutingText(candidate);
      const affectedStoreId = store.findMentionedStoreId(
        candidate.client.id,
        routingText,
      );
      const quotedTicket = candidate.quotedExternalId
        ? store.findQuotedTicketReference(
            candidate.group.id,
            candidate.quotedExternalId,
          )
        : null;
      const routing = routeTopic({
        occurredAt: candidate.occurredAt,
        text: routingText,
        senderId: candidate.sender.id,
        explicitNewTopic: decision.explicitNewTopic,
        affectedStoreId,
        quotedTicket,
        candidates: store.listTopicTicketCandidates(
          candidate.group.id,
          sinceAt,
          candidate.occurredAt,
        ),
        candidateWindowMs: recentConversationWindowMs,
      });
      const action = suggestionAction(decision, routing);
      return {
        messageIds: [candidate.id],
        contextMessageIds: [],
        kind: decision.kind,
        suggestedAction: action,
        relatedTicketId:
          action === "attach" ? routing.targetTicketId : null,
        relatedSuggestionId: null,
        title: decision.title,
        summary: decision.summary,
        priority: decision.priority,
        affectedEcommerce: null,
        categories: {
          contactReason: [],
          productArea: [],
          platform: [],
          symptom: [],
        },
        reason: routing.reason,
        confidence: decision.confidence,
      };
    }),
  };
}

export interface TriageWorkerOptions {
  recentConversationWindowMs?: number;
  pollIntervalMs?: number;
  onError?: (candidate: TriageCandidate, error: unknown) => void;
}

export class TriageWorker {
  private readonly recentConversationWindowMs: number;
  private readonly pollIntervalMs: number;
  private readonly onError: (candidate: TriageCandidate, error: unknown) => void;

  constructor(
    private readonly store: SupportStore,
    options: TriageWorkerOptions = {},
  ) {
    this.recentConversationWindowMs =
      options.recentConversationWindowMs ?? 4 * 60 * 60_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.onError = options.onError ?? (() => undefined);
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const result = this.runBatch();
      if (result.processed === 0) {
        await waitFor(this.pollIntervalMs, signal);
      }
    }
  }

  runBatch(limit = 100): TriageBatchResult {
    return this.runCandidates(this.store.listTriageCandidates(limit));
  }

  runCandidates(candidates: TriageCandidate[]): TriageBatchResult {
    const result: TriageBatchResult = {
      processed: 0,
      suggestedCreate: 0,
      suggestedAttach: 0,
      suggestedIgnore: 0,
      failed: 0,
    };

    for (const candidate of candidates) {
      try {
        this.processCandidate(candidate, result);
      } catch (error) {
        result.failed += 1;
        this.onError(candidate, error);
      } finally {
        result.processed += 1;
      }
    }

    return result;
  }

  private processCandidate(
    candidate: TriageCandidate,
    result: TriageBatchResult,
  ): void {
    this.store.database.transaction(() => {
      this.processCandidateAtomically(candidate, result);
    })();
  }

  private processCandidateAtomically(
    candidate: TriageCandidate,
    result: TriageBatchResult,
  ): void {
    const decision = classifyTriageCandidate(candidate);
    const sinceAt = new Date(
      new Date(candidate.occurredAt).getTime() - this.recentConversationWindowMs,
    ).toISOString();
    const routingText = candidateRoutingText(candidate);
    const affectedStoreId = this.store.findMentionedStoreId(
      candidate.client.id,
      routingText,
    );
    const quotedTicket = candidate.quotedExternalId
      ? this.store.findQuotedTicketReference(
          candidate.group.id,
          candidate.quotedExternalId,
        )
      : null;
    const routing = routeTopic({
      occurredAt: candidate.occurredAt,
      text: routingText,
      senderId: candidate.sender.id,
      explicitNewTopic: decision.explicitNewTopic,
      affectedStoreId,
      quotedTicket,
      candidates: this.store.listTopicTicketCandidates(
        candidate.group.id,
        sinceAt,
        candidate.occurredAt,
      ),
      candidateWindowMs: this.recentConversationWindowMs,
    });

    const action = suggestionAction(decision, routing);
    const targetTicketId = action === "attach" ? routing.targetTicketId : null;
    const ignoreReason =
      decision.kind === "social" ? "social_only" : "informational_only";
    if (
      action === "ignore" &&
      (decision.kind === "social" || decision.kind === "information")
    ) {
      this.store.collapseTriageMessage(candidate.id, {
        kind: decision.kind,
        actor: "triage",
        reason: ignoreReason,
      });
    } else {
      this.store.recordTriageSuggestion(candidate.id, {
        kind: decision.kind,
        suggestedAction: action,
        suggestedTicketId: targetTicketId,
        title: decision.title,
        summary: decision.summary,
        priority: decision.priority,
        affectedStoreId,
        confidence: decision.confidence,
        actor: "triage",
        reason: routing.reason,
      });
    }
    if (action === "create") result.suggestedCreate += 1;
    else if (action === "attach") result.suggestedAttach += 1;
    else result.suggestedIgnore += 1;
  }
}

function suggestionAction(
  decision: ReturnType<typeof classifyTriageCandidate>,
  routing: ReturnType<typeof routeTopic>,
): "create" | "attach" | "ignore" {
  if (!decision.shouldOpenTicket) {
    return decision.kind === "information" && routing.targetTicketId
      ? "attach"
      : "ignore";
  }
  return routing.action === "attach" && routing.targetTicketId
    ? "attach"
    : "create";
}

function candidateRoutingText(candidate: TriageCandidate): string | null {
  const parts = [
    candidate.text,
    ...candidate.attachments.map((attachment) => attachment.extractedText),
  ].filter((value): value is string => Boolean(value?.trim()));
  return parts.length ? parts.join("\n") : null;
}

async function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
