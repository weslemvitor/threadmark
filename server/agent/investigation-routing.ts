import type { InvestigationThreadInput } from "./types.js";
import { isTaskContinuationInstruction } from "./confirmation-intent.js";

export type InvestigationWorkload = "quick" | "deep";

export interface InvestigationExecutionPolicy {
  workload: InvestigationWorkload;
  promptMode: "conversation" | "task" | "deep";
  maxToolRounds: number;
  maxToolOperations: number;
  maxSameOperation: number;
  maxCodeSearchOperations: number;
}

const simpleConversationSignal =
  /^(?:\s*(?:oi|ol[aá]|opa|e a[ií]|bom dia|boa tarde|boa noite|obrigad[oa]|valeu|beleza|show|tudo bem)[!.?\s]*)$|(?:qual (?:e|é) o meu nome|qual (?:e|é) meu nome|quem sou eu|quem (?:e|é) voc[eê]|o que voc[eê] (?:consegue|pode) (?:fazer(?: e executar)?|executar)|como voc[eê] pode me ajudar)(?:\?|$|\s)/iu;

export function investigationExecutionPolicy(
  input: Pick<
    InvestigationThreadInput,
    | "currentOperatorMessageId"
    | "recentMessages"
    | "durableSummary"
    | "activeTask"
    | "images"
    | "imageAnalysisApproved"
  >,
): InvestigationExecutionPolicy {
  const currentMessage = input.recentMessages.find(
    (message) => message.id === input.currentOperatorMessageId,
  );
  const currentBody = currentMessage?.body ?? "";
  const continuesTask = input.activeTask?.continuation ??
    isTaskContinuationInstruction(currentBody);

  const simpleConversation =
    !continuesTask &&
    simpleConversationSignal.test(currentBody.trim());

  if (simpleConversation) {
    return {
      workload: "quick",
      promptMode: "conversation",
      maxToolRounds: 0,
      maxToolOperations: 0,
      maxSameOperation: 0,
      maxCodeSearchOperations: 0,
    };
  }

  return {
    workload: "deep",
    promptMode: "deep",
    maxToolRounds: 8,
    maxToolOperations: 16,
    maxSameOperation: 6,
    maxCodeSearchOperations: 4,
  };
}
