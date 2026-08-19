import type { SupportStore } from "../domain/index.js";
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
      ticketId: string;
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
  private readonly onEvent: (event: InvestigationWorkerEvent) => void;

  constructor(
    private readonly store: SupportStore,
    private readonly agent: Pick<
      SupportAgent,
      "analyse" | "investigateThread"
    > & Partial<Pick<SupportAgent, "triage" | "generateDocumentation">>,
    options: InvestigationWorkerOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 1_500;
    this.recoverOrphanedJobs = options.recoverOrphanedJobs ?? true;
    this.automaticMessageLimit = options.automaticMessageLimit ?? 50;
    this.executionRegistry =
      options.executionRegistry ?? new InvestigationExecutionRegistry();
    if (
      !Number.isInteger(this.automaticMessageLimit) ||
      this.automaticMessageLimit < 1 ||
      this.automaticMessageLimit > 500
    ) {
      throw new RangeError(
        "automaticMessageLimit deve ser um inteiro entre 1 e 500",
      );
    }
    this.onEvent = options.onEvent ?? (() => undefined);
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.recoverOrphanedJobs) {
      this.store.recoverRunningAgentJobs();
    }

    while (!signal.aborted) {
      const processed = await this.runOne(signal);
      if (!processed) {
        this.onEvent({ type: "idle" });
        await waitFor(this.pollIntervalMs, signal);
      }
    }
  }

  async runOne(signal?: AbortSignal): Promise<boolean> {
    const job = this.store.claimNextAgentJob();
    if (!job) return false;

    this.onEvent({
      type: "started",
      jobId: job.id,
      ...(job.kind === "triage"
        ? { groupId: job.groupId }
        : { ticketId: job.ticketId }),
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
      } else {
        if (!this.agent.generateDocumentation) {
          throw new Error("Agente de documentação não está configurado.");
        }
        const input = this.store.getDocumentationJobInput(job.id);
        const result = await this.agent.generateDocumentation(input, jobSignal);
        this.store.completeDocumentationJob(job.id, result);
      }
      this.onEvent({
        type: "completed",
        jobId: job.id,
        ...(job.kind === "triage"
          ? { groupId: job.groupId }
          : { ticketId: job.ticketId }),
        jobKind: job.kind,
      });
    } catch (error) {
      if (job.kind === "triage") {
        const conversationStillExists = this.store.database
          .prepare("SELECT 1 FROM whatsapp_groups WHERE id = ?")
          .get(job.groupId);
        if (!conversationStillExists) return true;
      } else {
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
          ticketId: job.ticketId,
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
            : { ticketId: job.ticketId }),
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
        ticketId: job.ticketId,
        jobKind: job.kind,
        error: message,
      });
    } finally {
      execution?.release();
    }

    return true;
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
