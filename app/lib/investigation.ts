import type { LatestInvestigationDto } from "../../shared/contracts.js";

export type InvestigationSnapshot = LatestInvestigationDto;

export type InvestigationPresentation = {
  label: string;
  description: string;
  tone: "neutral" | "progress" | "success" | "warning" | "danger";
};

export type InvestigationPresentationOptions = {
  replyAvailable?: boolean;
  snapshotSuperseded?: boolean;
};

export function isInvestigationActive(
  investigation: Pick<InvestigationSnapshot, "state"> | null | undefined,
): boolean {
  return investigation?.state === "queued" || investigation?.state === "running";
}

export function getInvestigationPresentation(
  investigation: Pick<InvestigationSnapshot, "state" | "outcome"> | null | undefined,
  options: InvestigationPresentationOptions = {},
): InvestigationPresentation | null {
  if (!investigation) return null;

  if (investigation.state === "queued") {
    return {
      label: "Na fila",
      description: "Aguardando o worker local iniciar a análise.",
      tone: "neutral",
    };
  }

  if (investigation.state === "running") {
    return {
      label: "Investigando",
      description: "O Codex está analisando o contexto e reunindo evidências.",
      tone: "progress",
    };
  }

  if (investigation.state === "failed") {
    return {
      label: "Falhou",
      description: "A execução não terminou. Revise o erro e tente escalar novamente.",
      tone: "danger",
    };
  }

  if (options.replyAvailable) {
    return {
      label: "Resposta pronta",
      description: "Há evidências suficientes para revisar uma resposta ao cliente.",
      tone: "success",
    };
  }

  if (options.snapshotSuperseded) {
    return {
      label: "Análise superada",
      description: "O atendimento mudou após esta análise. A minuta anterior não está mais disponível.",
      tone: "neutral",
    };
  }

  if (
    investigation.outcome === "reply_ready" &&
    options.replyAvailable === false
  ) {
    return {
      label: "Análise superada",
      description: "A minuta desta análise não está mais ativa no atendimento.",
      tone: "neutral",
    };
  }

  switch (investigation.outcome) {
    case "reply_ready":
      return {
        label: "Resposta pronta",
        description: "Há evidências suficientes para revisar uma resposta ao cliente.",
        tone: "success",
      };
    case "already_answered":
      return {
        label: "Já respondido",
        description: "A equipe já respondeu a esta solicitação. Nenhuma nova resposta é necessária.",
        tone: "success",
      };
    case "needs_information":
      return {
        label: "Aguardando informações",
        description: "Ainda faltam dados do atendimento antes de concluir a análise.",
        tone: "warning",
      };
    case "technical_investigation_required":
      return {
        label: "Requer investigação técnica",
        description: "O caso precisa de uma análise técnica mais profunda e orientada.",
        tone: "warning",
      };
    default:
      return {
        label: "Concluída",
        description: "A última execução do Codex foi finalizada.",
        tone: "success",
      };
  }
}
