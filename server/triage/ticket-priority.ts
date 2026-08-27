import type { TicketPriority } from "../../shared/contracts.js";

const urgentImpact = [
  /\b(?:produto|plataforma|sistema|servico|serviço|aplicacao|aplicação)\b.{0,36}\b(?:fora(?: do ar)?|indisponivel|indisponível|caiu|caindo|instavel|instável|instabilidade)\b/iu,
  /\b(?:fora(?: do ar)?|indisponivel|indisponível|instabilidade)\b.{0,36}\b(?:geral|todos?|inteiro|inteira|produto|plataforma|sistema|servico|serviço)\b/iu,
  /\b(?:nao|não)\s+(?:abre|carrega|entra|funciona)\b.{0,48}\b(?:produto|plataforma|sistema|servico|serviço|aplicacao|aplicação)\b/iu,
];

const highImpact = [
  /\b(?:dados?|valores?|metricas?|métricas?|faturamento|pedidos?|relatorio|relatório|dashboard)\b.{0,48}\b(?:incorret[oa]s?|divergente?s?|zerad[oa]s?|ausentes?|sumiram|sem dados)\b/iu,
  /\b(?:sem dados|dados? incorret[oa]s?|divergencia|divergência)\b/iu,
  /\b(?:nao|não|sem)\s+(?:consigo\s+)?(?:acessar|logar|entrar)\b|\b(?:acesso|login)\b.{0,32}\b(?:bloqueado|negado|indisponivel|indisponível|falhou|erro)\b/iu,
];

const normalQuestion = [
  /\b(?:duvida|dúvida)\b.{0,40}\b(?:metrica|métrica|ferramenta|funcionalidade|relatorio|relatório|dashboard)\b/iu,
  /\b(?:como funciona|o que (?:e|é)|qual a diferenca|qual a diferença)\b/iu,
];

const resolvedContext =
  /\b(?:normalizou|voltou|resolveu|resolvido|funcionou agora|ja voltou|já voltou|nao acontece mais|não acontece mais)\b/iu;

/**
 * Conservative fallback used when the structured triage model is unavailable.
 * Severity follows confirmed operational impact, never the word "urgente" alone.
 */
export function inferTicketPriority(text: string | null | undefined): TicketPriority {
  const normalized = text?.replace(/\s+/g, " ").trim() ?? "";
  if (!normalized || resolvedContext.test(normalized)) return "normal";
  if (urgentImpact.some((pattern) => pattern.test(normalized))) return "urgent";
  if (highImpact.some((pattern) => pattern.test(normalized))) return "high";
  if (normalQuestion.some((pattern) => pattern.test(normalized))) return "normal";
  return "normal";
}

const priorityWeight: Record<TicketPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
};

export function highestTicketPriority(
  current: TicketPriority | null | undefined,
  candidate: TicketPriority | null | undefined,
): TicketPriority {
  const left = current ?? "normal";
  const right = candidate ?? "normal";
  return priorityWeight[right] > priorityWeight[left] ? right : left;
}
