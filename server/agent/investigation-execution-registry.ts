export class InvestigationCancelledError extends Error {
  constructor(readonly jobId: string) {
    super("Investigação interrompida pelo operador.");
    this.name = "InvestigationCancelledError";
  }
}

export interface InvestigationExecutionHandle {
  signal: AbortSignal;
  release(): void;
}

/**
 * Process-local bridge between the API and the worker. Durable cancellation is
 * recorded by SupportStore first; this registry only interrupts active I/O.
 */
export class InvestigationExecutionRegistry {
  private readonly controllers = new Map<string, AbortController>();

  begin(
    jobId: string,
    shutdownSignal?: AbortSignal,
  ): InvestigationExecutionHandle {
    if (this.controllers.has(jobId)) {
      throw new Error(`A investigação ${jobId} já possui uma execução ativa.`);
    }

    const controller = new AbortController();
    const abortForShutdown = () => controller.abort(shutdownSignal?.reason);
    shutdownSignal?.addEventListener("abort", abortForShutdown, { once: true });
    if (shutdownSignal?.aborted) abortForShutdown();
    this.controllers.set(jobId, controller);

    let released = false;
    return {
      signal: controller.signal,
      release: () => {
        if (released) return;
        released = true;
        shutdownSignal?.removeEventListener("abort", abortForShutdown);
        if (this.controllers.get(jobId) === controller) {
          this.controllers.delete(jobId);
        }
      },
    };
  }

  cancel(jobId: string): boolean {
    const controller = this.controllers.get(jobId);
    if (!controller || controller.signal.aborted) return false;
    controller.abort(new InvestigationCancelledError(jobId));
    return true;
  }

  isRunning(jobId: string): boolean {
    return this.controllers.has(jobId);
  }
}
