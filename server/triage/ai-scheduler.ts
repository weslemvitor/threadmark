import type { SupportStore, TriageCandidate } from "../domain/index.js";
import { classifyTriageCandidate } from "./classifier.js";
import { TriageWorker } from "./triage-worker.js";

export const TRIAGE_PROMPT_VERSION = "conversation-triage-v2";

export interface TriageAiSchedulerOptions {
  quietPeriodMs?: number;
  clusterGapMs?: number;
  pollIntervalMs?: number;
  candidateLimit?: number;
  onError?: (error: unknown) => void;
}

export class TriageAiScheduler {
  private readonly quietPeriodMs: number | null;
  private readonly clusterGapMs: number;
  private readonly pollIntervalMs: number;
  private readonly candidateLimit: number;
  private readonly onError: (error: unknown) => void;
  private readonly fallback: TriageWorker;

  constructor(
    private readonly store: SupportStore,
    options: TriageAiSchedulerOptions = {},
  ) {
    this.quietPeriodMs = options.quietPeriodMs ?? null;
    this.clusterGapMs = options.clusterGapMs ?? 30 * 60_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.candidateLimit = options.candidateLimit ?? 500;
    this.onError = options.onError ?? (() => undefined);
    this.fallback = new TriageWorker(store, { onError: (_, error) => this.onError(error) });
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let processed = 0;
      try {
        processed = this.runBatch();
      } catch (error) {
        this.onError(error);
      }
      if (!processed) await waitFor(this.pollIntervalMs, signal);
    }
  }

  runBatch(): number {
    const settings = this.store.getTriageAiSettings();
    if (settings.enabled) return this.scheduleBatch(settings.model);
    this.store.releaseQueuedTriageAiJobs("triage-fallback");
    return this.scheduleFallbackBatch(settings.silenceWindowSeconds * 1_000);
  }

  scheduleBatch(model = this.store.getTriageAiSettings().model): number {
    const settings = this.store.getTriageAiSettings();
    const quietPeriodMs =
      this.quietPeriodMs ?? settings.silenceWindowSeconds * 1_000;
    const candidates = this.store.listTriageCandidates(this.candidateLimit);
    if (!candidates.length) return 0;
    const byConversation = new Map<string, TriageCandidate[]>();
    for (const candidate of candidates) {
      const current = byConversation.get(candidate.group.id) ?? [];
      current.push(candidate);
      byConversation.set(candidate.group.id, current);
    }

    const settledBefore = new Date(Date.now() - quietPeriodMs).toISOString();
    let scheduled = 0;
    for (const [groupId, conversationCandidates] of byConversation) {
      const latestAt = this.store.latestEligibleTriageMessageAt(groupId);
      if (!latestAt || latestAt > settledBefore) continue;
      if (this.store.hasBlockingAudioTranscriptions(groupId)) {
        continue;
      }
      for (const cluster of clusterCandidates(
        conversationCandidates,
        this.clusterGapMs,
      )) {
        if (this.store.isTriageContextWaiting(groupId, cluster.map(({ id }) => id))) {
          continue;
        }
        if (
          cluster.every(
            (candidate) => !classifyTriageCandidate(candidate).shouldOpenTicket,
          )
        ) {
          scheduled += this.fallback.runCandidates(cluster).processed;
          continue;
        }
        if (
          this.store.enqueueTriageAiJob(cluster, {
            model,
            promptVersion: TRIAGE_PROMPT_VERSION,
          })
        ) {
          scheduled += 1;
          // A próxima parte da mesma conversa deve enxergar o card criado ou
          // atualizado por este job antes de congelar um novo input semântico.
          break;
        }
      }
    }
    return scheduled;
  }

  private scheduleFallbackBatch(configuredQuietPeriodMs: number): number {
    const candidates = this.store.listTriageCandidates(this.candidateLimit);
    if (!candidates.length) return 0;
    const quietPeriodMs = this.quietPeriodMs ?? configuredQuietPeriodMs;
    const settledBefore = new Date(Date.now() - quietPeriodMs).toISOString();
    const byConversation = new Map<string, TriageCandidate[]>();
    for (const candidate of candidates) {
      const current = byConversation.get(candidate.group.id) ?? [];
      current.push(candidate);
      byConversation.set(candidate.group.id, current);
    }
    let processed = 0;
    for (const [groupId, conversationCandidates] of byConversation) {
      const latestAt = this.store.latestEligibleTriageMessageAt(groupId);
      if (!latestAt || latestAt > settledBefore) continue;
      if (this.store.hasBlockingAudioTranscriptions(groupId)) {
        continue;
      }
      for (const cluster of clusterCandidates(
        conversationCandidates,
        this.clusterGapMs,
      )) {
        processed += this.fallback.runCandidates(cluster).processed;
      }
    }
    return processed;
  }
}

function clusterCandidates(
  candidates: TriageCandidate[],
  gapMs: number,
): TriageCandidate[][] {
  const sorted = candidates.toSorted((left, right) =>
    left.occurredAt.localeCompare(right.occurredAt),
  );
  const clusters: TriageCandidate[][] = [];
  let current: TriageCandidate[] = [];
  let previousAt: number | null = null;
  for (const candidate of sorted) {
    const occurredAt = new Date(candidate.occurredAt).getTime();
    if (
      current.length &&
      (current.length >= 50 ||
        (previousAt !== null && occurredAt - previousAt > gapMs))
    ) {
      clusters.push(current);
      current = [];
    }
    current.push(candidate);
    previousAt = occurredAt;
  }
  if (current.length) clusters.push(current);
  return clusters;
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
