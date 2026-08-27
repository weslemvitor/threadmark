import type { ClaimedAgentJob, SupportStore } from "../domain/index.js";
import {
  CodexRunAbortedError,
} from "./codex-runner.js";
import { InvestigationExecutionRegistry } from "./investigation-execution-registry.js";
import type { SupportAgent } from "./provider.js";
import { buildLocalTriageAnalysis } from "../triage/triage-worker.js";

export interface InvestigationWorkerOptions {
  pollIntervalMs?: number;
  recoverOrphanedJobs?: boolean;
  automaticMessageLimit?: number;
  executionRegistry?: InvestigationExecutionRegistry;
  concurrency?: number;
  leaseMs?: number;
  leaseHeartbeatMs?: number;
  onEvent?: (event: InvestigationWorkerEvent) => void;
}

export type InvestigationWorkerEvent =
  | { type: "idle" }
  | {
      type: "started";
      jobId: string;
      ticketId?: string;
      groupId?: string;
      jobKind: "automatic" | "thread_turn" | "triage" | "documentation";
    }
  | {
      type: "completed";
      jobId: string;
      ticketId?: string;
      groupId?: string;
      jobKind: "automatic" | "thread_turn" | "triage" | "documentation";
    }
  | {
      type: "failed";
      jobId: string;
      ticketId?: string;
      groupId?: string;
      jobKind: "automatic" | "thread_turn" | "triage" | "documentation";
      error: string;
    }
  | {
      type: "cancelled";
      jobId: string;
      ticketId?: string;
      jobKind: "thread_turn";
    }
  | {
      type: "requeued";
      jobId: string;
      ticketId?: string;
      groupId?: string;
      jobKind: "automatic" | "thread_turn" | "triage" | "documentation";
      reason: "shutdown" | "retry";
    };

export class InvestigationWorker {
  private readonly pollIntervalMs: number;
  private readonly recoverOrphanedJobs: boolean;
  private readonly automaticMessageLimit: number;
  private readonly executionRegistry: InvestigationExecutionRegistry;
  private readonly concurrency: number;
  private readonly leaseMs: number;
  private readonly leaseHeartbeatMs: number;
  private readonly onEvent: (event: InvestigationWorkerEvent) => void;

  constructor(
    private readonly store: SupportStore,
    private readonly agent: Pick<
      SupportAgent,
      "analyse" | "investigateThread"
    > & Partial<Pick<SupportAgent, "triage" | "generateDocumentation" | "extractKnowledge">>,
    options: InvestigationWorkerOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 1_500;
    this.recoverOrphanedJobs = options.recoverOrphanedJobs ?? true;
    this.automaticMessageLimit = options.automaticMessageLimit ?? 50;
    this.executionRegistry =
      options.executionRegistry ?? new InvestigationExecutionRegistry();
    this.concurrency = options.concurrency ?? 2;
    this.leaseMs = options.leaseMs ?? 10 * 60_000;
    this.leaseHeartbeatMs = options.leaseHeartbeatMs ?? Math.min(
      60_000,
      Math.floor(this.leaseMs / 3),
    );
    if (
      !Number.isInteger(this.automaticMessageLimit) ||
      this.automaticMessageLimit < 1 ||
      this.automaticMessageLimit > 500
    ) {
      throw new RangeError(
        "automaticMessageLimit deve ser um inteiro entre 1 e 500",
      );
    }
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 4) {
      throw new RangeError("concurrency deve ser um inteiro entre 1 e 4");
    }
    if (!Number.isFinite(this.leaseMs) || this.leaseMs < 1_000) {
      throw new RangeError("leaseMs deve ser de pelo menos 1000ms");
    }
    if (
      !Number.isFinite(this.leaseHeartbeatMs) ||
      this.leaseHeartbeatMs < 100 ||
      this.leaseHeartbeatMs >= this.leaseMs
    ) {
      throw new RangeError("leaseHeartbeatMs deve ser menor que o lease e de pelo menos 100ms");
    }
    this.onEvent = options.onEvent ?? (() => undefined);
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.recoverOrphanedJobs) {
      this.store.recoverRunningAgentJobs();
    }

    await Promise.all(
      Array.from({ length: this.concurrency }, () => this.runSlot(signal)),
    );
  }

  private async runSlot(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const processed = await this.runOne(signal);
      if (!processed) {
        this.onEvent({ type: "idle" });
        await waitFor(this.pollIntervalMs, signal);
      }
    }
  }

  async runOne(signal?: AbortSignal): Promise<boolean> {
    const job = this.store.claimNextAgentJob(this.leaseMs);
    if (!job) return false;
    const stopLeaseHeartbeat = this.startLeaseHeartbeat(job);

    this.onEvent({
      type: "started",
      jobId: job.id,
      ...(job.kind === "triage"
        ? { groupId: job.groupId }
        : job.ticketId ? { ticketId: job.ticketId } : {}),
      jobKind: job.kind,
    });
    const execution = job.kind === "thread_turn"
      ? this.executionRegistry.begin(job.id, signal)
      : null;
    const jobSignal = execution?.signal ?? signal;
    try {
      if (job.kind === "automatic") {
        const input = this.store.getInvestigationContext(
          job.ticketId,
          this.automaticMessageLimit,
        );
        input.operatorInstructions = job.instructions;
        const analysis = await this.agent.analyse(input, jobSignal);
        this.store.completeInvestigationJob(job.id, analysis);
      } else if (job.kind === "thread_turn") {
        const input = this.store.getInvestigationThreadContext(job.id);
        input.onToolExecution = (execution) => {
          this.store.appendInvestigationThreadToolExecution(job.id, execution);
        };
        const result = await this.agent.investigateThread(input, jobSignal);
        this.store.completeInvestigationThreadJob(job.id, result);
      } else if (job.kind === "triage") {
        if (!this.agent.triage) {
          throw new Error("Agente de triagem Codex não está configurado.");
        }
        const input = this.store.getTriageAiJobInput(job.id);
        const result = await this.agent.triage(input, job.model, jobSignal);
        this.store.completeTriageAiJob(job.id, result);
      } else if (job.phase === "extraction") {
        if (!this.agent.extractKnowledge) {
          // Compatibilidade com provedores legados durante a migração. Novos provedores
          // sempre executam a extração estruturada antes da renderização.
          if (!this.agent.generateDocumentation) {
            throw new Error("Agente de extração de conhecimento não está configurado.");
          }
          const input = this.store.getDocumentationJobInput(job.id);
          const result = await this.agent.generateDocumentation(input, jobSignal);
          this.store.completeDocumentationJob(job.id, result);
        } else {
          const input = this.store.getKnowledgeExtractionJobInput(job.id);
          const result = await this.agent.extractKnowledge(input, jobSignal);
          this.store.completeKnowledgeExtractionJob(job.id, result);
        }
      } else {
        this.store.completeDocumentationFromKnowledgeJob(job.id);
      }
      this.onEvent({
        type: "completed",
        jobId: job.id,
        ...(job.kind === "triage"
          ? { groupId: job.groupId }
          : job.ticketId ? { ticketId: job.ticketId } : {}),
        jobKind: job.kind,
      });
    } catch (error) {
      if (job.kind === "triage") {
        const conversationStillExists = this.store.database
          .prepare("SELECT 1 FROM whatsapp_groups WHERE id = ?")
          .get(job.groupId);
        if (!conversationStillExists) return true;
      } else if (job.kind !== "thread_turn" || job.ticketId) {
        const ticketStillExists = this.store.database
          .prepare("SELECT 1 FROM tickets WHERE id = ?")
          .get(job.ticketId);
        if (!ticketStillExists) return true;
      }
      if (
        job.kind === "thread_turn" &&
        this.store.isInvestigationThreadJobCancelled(job.id)
      ) {
        this.onEvent({
          type: "cancelled",
          jobId: job.id,
          ...(job.ticketId ? { ticketId: job.ticketId } : {}),
          jobKind: "thread_turn",
        });
        return true;
      }
      if (signal?.aborted || error instanceof CodexRunAbortedError) {
        this.store.recoverRunningAgentJobs();
        this.onEvent({
          type: "requeued",
          jobId: job.id,
          ...(job.kind === "triage"
            ? { groupId: job.groupId }
            : job.ticketId ? { ticketId: job.ticketId } : {}),
          jobKind: job.kind,
          reason: "shutdown",
        });
        return true;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (job.kind === "triage") {
        if (this.store.isTriageAiJobObsolete(job.id)) {
          this.onEvent({
            type: "failed",
            jobId: job.id,
            groupId: job.groupId,
            jobKind: "triage",
            error: "Análise descartada porque a conversa recebeu novo contexto.",
          });
          return true;
        }
        if (job.attemptCount < 2) {
          this.store.requeueTriageAiJob(job.id, message);
          this.onEvent({
            type: "requeued",
            jobId: job.id,
            groupId: job.groupId,
            jobKind: "triage",
            reason: "retry",
          });
          return true;
        }
        const fallback = buildLocalTriageAnalysis(
          this.store,
          this.store.getTriageAiJobCandidates(job.id),
        );
        this.store.completeTriageAiJob(job.id, fallback, {
          fallbackUsed: true,
          error: message,
        });
        this.onEvent({
          type: "completed",
          jobId: job.id,
          groupId: job.groupId,
          jobKind: "triage",
        });
        return true;
      } else if (job.kind === "automatic") {
        this.store.failInvestigationJob(job.id, message);
      } else if (job.kind === "thread_turn") {
        if (job.attemptCount < 3) {
          this.store.requeueInvestigationThreadJob(job.id, message);
          this.onEvent({
            type: "requeued",
            jobId: job.id,
            ...(job.ticketId ? { ticketId: job.ticketId } : {}),
            jobKind: "thread_turn",
            reason: "retry",
          });
          return true;
        }
        this.store.failInvestigationThreadJob(job.id, message);
      } else if (job.attemptCount < 2) {
        this.store.requeueDocumentationJob(job.id, message);
        this.onEvent({
          type: "requeued",
          jobId: job.id,
          ticketId: job.ticketId,
          jobKind: "documentation",
          reason: "retry",
        });
        return true;
      } else {
        this.store.failDocumentationJob(job.id, message);
      }
      this.onEvent({
        type: "failed",
        jobId: job.id,
        ...(job.ticketId ? { ticketId: job.ticketId } : {}),
        jobKind: job.kind,
        error: message,
      });
    } finally {
      stopLeaseHeartbeat();
      execution?.release();
    }

    return true;
  }

  private startLeaseHeartbeat(job: ClaimedAgentJob): () => void {
    const timer = setInterval(() => {
      try {
        if (!this.store.renewAgentJobLease(job, this.leaseMs)) clearInterval(timer);
      } catch {
        clearInterval(timer);
      }
    }, this.leaseHeartbeatMs);
    timer.unref();
    return () => clearInterval(timer);
  }
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
