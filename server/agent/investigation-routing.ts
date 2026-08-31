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

const deepInvestigationSignal =
  /\b(?:investigue|investigar|investigacao|investigação|analise profundamente|análise profunda|causa raiz|diagnostique|diagnosticar|logs?|cloudwatch|aws|clickhouse|postgres(?:ql)?|banco de dados|sql|codigo|código|repositorio|repositório|producao|produção|incidente|timeout|stack trace|traceback)\b/iu;

const investigativeActionSignal =
  /\b(?:investigue|investigar|analise|analisar|diagnostique|diagnosticar|procure|procurar|pesquise|pesquisar|consulte|consultar|verifique|verificar|confira|conferir|compare|comparar|cruze|cruzar|descubra|descobrir)\b/iu;

const liveDataLookupSignal =
  /\b(?:banco|database|postgres(?:ql)?|clickhouse|sql|logs?|cloudwatch|aws|api|shopify|tray|pedidos?|orders?|order[_\s-]?id|ecommerce(?:s|[_\s-]?id|[_\s-]?orders?)?|tickets?|conversas?|documentos?|indexa(?:cao|ção)|configura(?:cao|ção|coes|ções))\b/iu;

const investigativeQuestionSignal =
  /\b(?:o que (?:esta|está) acontecendo|qual (?:e|é) o problema|por que .+ (?:nao|não) (?:funciona|responde|carrega|aparece))\b/iu;

const rootCauseQuestionSignal =
  /\b(?:qual (?:foi|e|é|seria) (?:a )?(?:causa|motivo)|por que|porque|o que causou|o que provocou|causa dos?|motivo dos?)\b/iu;

const ticketSourceDiscoverySignal =
  /\b(?:ticket|chamado)\b/iu;

const ticketMutationSignal =
  /\b(?:cri(?:a|ar|e)|abr(?:a|ir)|ger(?:a|ar|e)|atualiz(?:a|ar|e)|edit(?:a|ar|e)|anex(?:a|ar|e)|vincul(?:a|ar|e)|atribu(?:a|ir))\b/iu;

const ticketContextSignal =
  /\b(?:contexto|conversa|mensage(?:m|ns)|intercom|whatsapp|grupo|cliente|pessoa|hist[oó]rico)\b/iu;

const automationSignal =
  /\b(?:automacao|automação|automacoes|automações|fluxo|fluxos)\b/iu;

const automationMutationSignal =
  /\b(?:cri(?:a|ar|e)|edit(?:a|ar|e)|atualiz(?:a|ar|e)|alter(?:a|ar|e)|ajust(?:a|ar|e)|melhor(?:a|ar|e)|aplic(?:a|ar|e)|salv(?:a|ar|e))\b/iu;

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
  const activeTaskBody = input.activeTask?.operatorDirectives
    .map((directive) => directive.body)
    .join("\n") ?? "";
  const continuesTask = input.activeTask?.continuation ??
    isTaskContinuationInstruction(currentBody);
  const effectiveBody = continuesTask
    ? [activeTaskBody, currentBody, input.durableSummary].filter(Boolean).join("\n")
    : currentBody;
  const asksForDeepInvestigation =
    deepInvestigationSignal.test(effectiveBody) ||
    investigativeQuestionSignal.test(effectiveBody) ||
    (
      ticketSourceDiscoverySignal.test(effectiveBody) &&
      rootCauseQuestionSignal.test(effectiveBody)
    ) ||
    (
      automationSignal.test(effectiveBody) &&
      automationMutationSignal.test(effectiveBody)
    ) ||
    (
      ticketSourceDiscoverySignal.test(effectiveBody) &&
      ticketMutationSignal.test(effectiveBody) &&
      ticketContextSignal.test(effectiveBody)
    ) ||
    (
      investigativeActionSignal.test(effectiveBody) &&
      liveDataLookupSignal.test(effectiveBody)
    );
  const requiresImageReasoning = Boolean(
    input.imageAnalysisApproved && input.images?.length,
  );

  if (asksForDeepInvestigation || requiresImageReasoning) {
    return {
      workload: "deep",
      promptMode: "deep",
      maxToolRounds: 16,
      maxToolOperations: 64,
      maxSameOperation: 16,
      maxCodeSearchOperations: 12,
    };
  }

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
    workload: "quick",
    promptMode: "task",
    maxToolRounds: 4,
    maxToolOperations: 12,
    maxSameOperation: 8,
    maxCodeSearchOperations: 0,
  };
}
