import type { InvestigationThreadInput } from "./types.js";

export type InvestigationWorkload = "quick" | "deep";

export interface InvestigationExecutionPolicy {
  workload: InvestigationWorkload;
  maxToolRounds: number;
  maxToolOperations: number;
  maxSameOperation: number;
  maxCodeSearchOperations: number;
}

const deepInvestigationSignal =
  /\b(?:investigue|investigar|investigacao|investigação|analise profundamente|análise profunda|causa raiz|diagnostique|diagnosticar|logs?|cloudwatch|aws|clickhouse|postgres(?:ql)?|banco de dados|sql|codigo|código|repositorio|repositório|producao|produção|incidente|timeout|stack trace|traceback)\b/iu;

export function investigationExecutionPolicy(
  input: Pick<
    InvestigationThreadInput,
    "currentOperatorMessageId" | "recentMessages" | "images" | "imageAnalysisApproved"
  >,
): InvestigationExecutionPolicy {
  const currentMessage = input.recentMessages.find(
    (message) => message.id === input.currentOperatorMessageId,
  );
  const asksForDeepInvestigation = deepInvestigationSignal.test(
    currentMessage?.body ?? "",
  );
  const requiresImageReasoning = Boolean(
    input.imageAnalysisApproved && input.images?.length,
  );

  if (asksForDeepInvestigation || requiresImageReasoning) {
    return {
      workload: "deep",
      maxToolRounds: 8,
      maxToolOperations: 24,
      maxSameOperation: 8,
      maxCodeSearchOperations: 5,
    };
  }

  return {
    workload: "quick",
    maxToolRounds: 3,
    maxToolOperations: 8,
    maxSameOperation: 3,
    maxCodeSearchOperations: 1,
  };
}
