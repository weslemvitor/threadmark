import type { TriageCandidate } from "../domain/index.js";

export type TriageDecisionKind =
  | "demand"
  | "uncertain"
  | "information"
  | "social";

export interface TriageDecision {
  kind: TriageDecisionKind;
  shouldOpenTicket: boolean;
  explicitNewTopic: boolean;
  title: string;
  summary: string;
  confidence: number;
}

const resolutionOnly = /^(ok[,!\s]*(agora)?|resolvido|resolveu|funcionou|deu certo|voltou|normalizou|obrigad[oa])[\s!.?]*$/i;
const demandSignals = /\b(erro|falha|problema|bug|ajuda|duvida|dúvida|nao|não|parou|sumiu|ausente|divergencia|divergência|incorreto|incorreta|como|quando|onde|qual|porque|por que|consegue|podem|poderia|preciso|gostaria|verificar|olhar|analisar|urgente)\b/i;
const explicitNewTopic = /\b(outro problema|outra duvida|outra dúvida|outra coisa|novo problema|nova duvida|nova dúvida|novo assunto|separadamente|alem disso|além disso|mudando de assunto|aproveitando)\b/i;
const socialEmoji = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\uFE0F\u200D]/gu;
const containsSocialEmoji = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}]/u;
const emojiOnly = /^(?:[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\uFE0F\u200D\s,!.?])+$/u;
const socialPhrase = [
  "oi+",
  "ol[aá]+",
  "bom dia",
  "boa tarde",
  "boa noite",
  "tudo bem",
  "que bom",
  "ok",
  "muito obrigad[oa]",
  "obrigad[oa](?: mesmo)?(?: pela (?:ajuda|aten[cç][aã]o|resposta))?",
  "obg",
  "valeu(?: mesmo)?",
  "vlw",
  "show(?: de bola)?",
  "perfeito",
  "[oó]timo",
  "excelente",
  "maravilha",
  "maravilhoso",
  "sensacional",
  "incr[ií]vel",
  "top",
  "massa",
  "bacana",
  "legal",
  "eita",
  "boa",
  "beleza",
  "bele",
  "blz",
  "tranquilo",
  "combinado",
  "certo",
  "entendi",
  "simm?",
  "isso",
  "exato",
  "exatamente",
  "est[aã]o sim",
  "nada+",
  "t[aá] bom",
  "t[aá] certo",
  "funcionou(?: agora)?",
  "resolveu",
  "resolvido",
  "deu certo",
  "voltou",
  "normalizou",
  "parab[eé]ns(?: pelo (?:trabalho|atendimento|suporte))?",
  "(?:ficou|est[aá]) (?:muito )?(?:bom|boa|[oó]timo|[oó]tima|excelente)",
  "(?:bom|boa|[oó]timo|[oó]tima|excelente) (?:trabalho|atendimento|suporte|retorno)",
].join("|");
const socialSequence = new RegExp(
  `^(?:${socialPhrase})(?:[\\s,]+(?:pessoal|gente|time|galera|turma))?` +
    `(?:(?:\\s*[,;:.!?+/&-]\\s*|\\s+e\\s+|\\s+)(?:${socialPhrase})` +
    `(?:[\\s,]+(?:pessoal|gente|time|galera|turma))?)*[\\s!.?]*$`,
  "i",
);

export function classifyTriageCandidate(
  candidate: TriageCandidate,
): TriageDecision {
  const rawText = candidate.text?.replace(/\s+/g, " ").trim() ?? "";
  const attachments = candidate.attachments.filter((attachment) => attachment.available);
  const hasAnalysableAttachment = attachments.some(
    (attachment) => attachment.kind === "image" || attachment.kind === "pdf" || attachment.kind === "document",
  );
  const isAudio = candidate.messageType.toLowerCase().includes("audio");

  if (isAudio && !rawText) {
    return {
      kind: "uncertain",
      shouldOpenTicket: true,
      explicitNewTopic: false,
      title: "Áudio recebido — revisão manual",
      summary: "O cliente enviou um áudio. O conteúdo foi preservado, mas áudio não é analisado nesta versão.",
      confidence: 0.2,
    };
  }

  if (!hasAnalysableAttachment && isClearlyNonDemand(rawText)) {
    return {
      kind: "social",
      shouldOpenTicket: false,
      explicitNewTopic: false,
      title: "Saudação",
      summary: rawText,
      confidence: 0.98,
    };
  }

  if (!hasAnalysableAttachment && resolutionOnly.test(rawText)) {
    return {
      kind: "information",
      shouldOpenTicket: false,
      explicitNewTopic: false,
      title: "Confirmação do cliente",
      summary: rawText,
      confidence: 0.9,
    };
  }

  const hasDemandSignal = rawText.includes("?") || demandSignals.test(rawText);
  if (hasAnalysableAttachment || hasDemandSignal) {
    return {
      kind: "demand",
      shouldOpenTicket: true,
      explicitNewTopic: explicitNewTopic.test(rawText),
      title: buildTitle(rawText, hasAnalysableAttachment),
      summary: buildSummary(rawText, attachments.length),
      confidence: hasDemandSignal ? 0.72 : 0.58,
    };
  }

  if (rawText) {
    return {
      kind: "uncertain",
      shouldOpenTicket: true,
      explicitNewTopic: explicitNewTopic.test(rawText),
      title: buildTitle(rawText, false),
      summary: rawText,
      confidence: 0.35,
    };
  }

  return {
    kind: "information",
    shouldOpenTicket: false,
    explicitNewTopic: false,
    title: "Evento sem conteúdo analisável",
    summary: `Mensagem do tipo ${candidate.messageType}.`,
    confidence: 0.8,
  };
}

function isClearlyNonDemand(text: string): boolean {
  if (!text) return false;
  if (containsSocialEmoji.test(text) && emojiOnly.test(text)) return true;
  const withoutEmoji = text.replace(socialEmoji, " ").replace(/\s+/g, " ").trim();
  if (!withoutEmoji) return false;
  if (socialSequence.test(withoutEmoji)) return true;
  const withoutFiller = withoutEmoji.replace(
    /^(?:a+h+|opa+|eba+)[\s,!.-]+/i,
    "",
  );
  if (socialSequence.test(withoutFiller)) return true;
  const withoutVocative = withoutFiller.replace(
    /[\s,]+\p{Lu}[\p{L}'’-]{1,30}([\s!.?]*)$/u,
    "$1",
  );
  return withoutVocative !== withoutFiller && socialSequence.test(withoutVocative);
}

function buildTitle(text: string, hasAttachment: boolean): string {
  const withoutGreeting = text
    .replace(/^(oi+|ola+|bom dia|boa tarde|boa noite)[\s,!.-]*/i, "")
    .trim();
  const source = withoutGreeting || (hasAttachment ? "Anexo recebido para análise" : "Demanda em revisão");
  return source.length > 92 ? `${source.slice(0, 89).trimEnd()}…` : source;
}

function buildSummary(text: string, attachmentCount: number): string {
  const attachmentNote = attachmentCount
    ? `${attachmentCount} anexo${attachmentCount === 1 ? "" : "s"} armazenado${attachmentCount === 1 ? "" : "s"}.`
    : "";
  return [text || "O cliente enviou conteúdo sem texto.", attachmentNote]
    .filter(Boolean)
    .join(" ");
}
