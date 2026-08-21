import type {
  AnswerSuggestion,
  TicketCategory,
  TicketDetail,
  TicketPriority,
  TicketStatus,
  TicketSummary,
} from "./types.js";
import { DASHBOARD_TIME_ZONE } from "../../shared/contracts.js";

export const statusLabels: Record<TicketStatus, string> = {
  new: "Novo",
  triage: "Em revisão",
  in_progress: "Em andamento",
  waiting_customer: "Aguardando resposta",
  blocked: "Aguardando interno",
  resolved: "Resolvido",
  cancelled: "Cancelado",
  archived: "Arquivado",
};

export const priorityLabels: Record<TicketPriority, string> = {
  urgent: "Urgente",
  high: "Alta",
  normal: "Normal",
  low: "Baixa",
};

export const activeStatuses: TicketStatus[] = [
  "new",
  "triage",
  "in_progress",
  "waiting_customer",
  "blocked",
];

let supportTimeZone: string = DASHBOARD_TIME_ZONE;
const formatterCache = new Map<string, Intl.DateTimeFormat>();

const relativeFormatter = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });

function asDate(value?: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatMessageTime(value?: string | null): string {
  const date = asDate(value);
  return date ? formatter("time").format(date) : "—";
}

export function formatFullDate(value?: string | null): string {
  const date = asDate(value);
  return date ? formatter("full").format(date).replace(" de ", " ") : "—";
}

export function formatDayDate(value?: string | null): string {
  const date = asDate(value);
  if (!date) return "Data desconhecida";
  const formatted = formatter("day").format(date);
  return formatted.charAt(0).toLocaleUpperCase("pt-BR") + formatted.slice(1);
}

export function configureSupportTimeZone(value?: string | null): string {
  const candidate = value?.trim() || DASHBOARD_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format();
    supportTimeZone = candidate;
  } catch {
    supportTimeZone = DASHBOARD_TIME_ZONE;
  }
  return supportTimeZone;
}

export function formatRelativeTime(value?: string | null): string {
  const date = asDate(value);
  if (!date) return "sem horário";

  const minutes = Math.round((date.getTime() - Date.now()) / 60_000);
  if (Math.abs(minutes) < 60) return relativeFormatter.format(minutes, "minute");

  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relativeFormatter.format(hours, "hour");

  return relativeFormatter.format(Math.round(hours / 24), "day");
}

export function getTicketTimestamp(ticket: TicketSummary): string | null | undefined {
  return ticket.lastMessageAt ?? ticket.updatedAt ?? ticket.createdAt;
}

export function getClientName(ticket: TicketSummary): string {
  return ticket.client.name;
}

export function getStoreName(ticket: TicketSummary): string | null {
  return ticket.affectedStore?.name ?? null;
}

type RequesterIdentity = {
  displayName: string;
  phoneE164: string | null;
} | null | undefined;

export type RequesterPresentation = {
  name: string;
  phone: string | null;
  compact: string;
};

export function formatPhoneNumber(value?: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  if (digits.length === 13 && digits.startsWith("55")) {
    return `+55 (${digits.slice(2, 4)}) ${digits.slice(4, 9)}-${digits.slice(9)}`;
  }
  if (digits.length === 12 && digits.startsWith("55")) {
    return `+55 (${digits.slice(2, 4)}) ${digits.slice(4, 8)}-${digits.slice(8)}`;
  }
  return value.trim() || null;
}

const PROTECTED_WHATSAPP_IDENTITY = "Identidade protegida do WhatsApp";
const WHATSAPP_TECHNICAL_ID = /@(s\.whatsapp\.net|lid|g\.us)$/i;
const SYNTHETIC_WHATSAPP_PARTICIPANT = /^participante\s+\d{8,}$/i;

type DirectoryGroupIdentity = {
  subject: string;
  externalJid: string;
};

type DirectoryPersonIdentity = {
  displayName: string;
  phoneE164: string | null;
  externalJid: string;
};

export type DirectoryPersonPresentation = {
  name: string;
  detail: string;
  phone: string;
};

export type DirectoryGroupPresentation = {
  name: string;
  detail: "Grupo do WhatsApp";
};

function phoneFromWhatsAppJid(value: string): string | null {
  const match = /^(\d{8,15})@s\.whatsapp\.net$/i.exec(value.trim());
  return match ? `+${match[1]}` : null;
}

function looksLikePhone(value: string): boolean {
  return /^[+()\d\s.-]+$/.test(value) && value.replace(/\D/g, "").length >= 8;
}

function isTechnicalWhatsAppLabel(value: string): boolean {
  return WHATSAPP_TECHNICAL_ID.test(value)
    || SYNTHETIC_WHATSAPP_PARTICIPANT.test(value);
}

export function getDirectoryGroupPresentation(
  group: DirectoryGroupIdentity,
): DirectoryGroupPresentation {
  const subject = group.subject.trim();
  return {
    name: subject && !WHATSAPP_TECHNICAL_ID.test(subject)
      ? subject
      : "Grupo sem nome",
    detail: "Grupo do WhatsApp",
  };
}

export function getDirectoryPersonPresentation(
  person: DirectoryPersonIdentity,
): DirectoryPersonPresentation {
  const rawName = person.displayName.trim();
  const safeName = isTechnicalWhatsAppLabel(rawName) ? "" : rawName;
  const phone = formatPhoneNumber(person.phoneE164)
    ?? formatPhoneNumber(looksLikePhone(safeName) ? safeName : null)
    ?? formatPhoneNumber(phoneFromWhatsAppJid(person.externalJid));
  const name = safeName
    ? (looksLikePhone(safeName) ? formatPhoneNumber(safeName) ?? safeName : safeName)
    : phone ?? PROTECTED_WHATSAPP_IDENTITY;
  const sameAsPhone = Boolean(phone) && name.replace(/\D/g, "") === phone?.replace(/\D/g, "");

  return {
    name,
    detail: phone
      ? (sameAsPhone ? "Contato do WhatsApp" : phone)
      : PROTECTED_WHATSAPP_IDENTITY,
    phone: phone ?? PROTECTED_WHATSAPP_IDENTITY,
  };
}

export function getRequesterPresentation(
  requester: RequesterIdentity,
): RequesterPresentation | null {
  if (!requester) return null;

  const rawName = requester.displayName.trim();
  const safeName = isTechnicalWhatsAppLabel(rawName) ? "" : rawName;
  const phone = formatPhoneNumber(requester.phoneE164)
    ?? formatPhoneNumber(phoneFromWhatsAppJid(rawName));
  const nameDigits = safeName.replace(/\D/g, "");
  const phoneDigits = phone?.replace(/\D/g, "") ?? "";
  const nameAlreadyRepresentsPhone =
    Boolean(phoneDigits) &&
    Boolean(nameDigits) &&
    (phoneDigits.endsWith(nameDigits) || nameDigits.endsWith(phoneDigits));
  const name = safeName && !nameAlreadyRepresentsPhone
    ? safeName
    : phone ?? PROTECTED_WHATSAPP_IDENTITY;
  const nameMatchesPhone = Boolean(phoneDigits)
    && name.replace(/\D/g, "") === phoneDigits;

  return {
    name,
    phone,
    compact: phone && !nameMatchesPhone ? `${name} · ${phone}` : name,
  };
}

export function getCategoryName(category: TicketCategory | string): string {
  return typeof category === "string" ? category : category.label;
}

function getNewestSuggestionByStatus(
  suggestions: AnswerSuggestion[],
  status: AnswerSuggestion["status"],
  createdAfter: string | null = null,
): AnswerSuggestion | null {
  return suggestions.reduce<AnswerSuggestion | null>((newest, suggestion) => {
    if (suggestion.status !== status) return newest;
    if (createdAfter && suggestion.createdAt <= createdAfter) return newest;
    if (!newest) return suggestion;
    return suggestion.createdAt > newest.createdAt ? suggestion : newest;
  }, null);
}

type SuggestionTicket = Pick<
  TicketDetail,
  "suggestions" | "latestInvestigation"
> & Partial<Pick<
  TicketDetail,
  "sentResponses" | "status" | "lastMessageAt" | "investigationThread"
>>;

function hasTerminalTicketStatus(ticket: SuggestionTicket): boolean {
  return ticket.status === "resolved" || ticket.status === "cancelled" || ticket.status === "archived";
}

function getLastSentResponseAt(ticket: SuggestionTicket): string | null {
  return (ticket.sentResponses ?? []).reduce<string | null>((latest, response) => {
    return !latest || response.sentAt > latest ? response.sentAt : latest;
  }, null);
}

function getInvestigationTimestamp(
  investigation: NonNullable<SuggestionTicket["latestInvestigation"]>,
): string {
  return (
    investigation.finishedAt ??
    investigation.startedAt ??
    investigation.requestedAt
  );
}

function latestTimestamp(...values: Array<string | null>): string | null {
  return values.reduce<string | null>(
    (latest, value) =>
      value && (!latest || value > latest) ? value : latest,
    null,
  );
}

export function isLatestInvestigationSuperseded(
  ticket: SuggestionTicket,
): boolean {
  const investigation = ticket.latestInvestigation;
  if (!investigation || investigation.state !== "completed") return false;
  if (hasTerminalTicketStatus(ticket)) return true;

  const investigationAt = getInvestigationTimestamp(investigation);
  const latestActivityAt = latestTimestamp(
    getLastSentResponseAt(ticket),
    ticket.lastMessageAt ?? null,
    ticket.investigationThread?.lastAssistantMessageAt ?? null,
  );
  return Boolean(latestActivityAt && latestActivityAt > investigationAt);
}

export function getSuggestion(
  ticket: SuggestionTicket,
): AnswerSuggestion | null {
  if (hasTerminalTicketStatus(ticket)) return null;

  const lastSentResponseAt = getLastSentResponseAt(ticket);
  const answeredAt =
    ticket.latestInvestigation?.outcome === "already_answered"
      ? getInvestigationTimestamp(ticket.latestInvestigation)
      : null;
  const validAfter = latestTimestamp(lastSentResponseAt, answeredAt);

  return (
    getNewestSuggestionByStatus(
      ticket.suggestions,
      "candidate",
      validAfter,
    ) ?? null
  );
}

export function getSuggestedResponse(
  ticket: SuggestionTicket,
): string | null {
  if (hasTerminalTicketStatus(ticket)) return null;

  const lastSentResponseAt = getLastSentResponseAt(ticket);
  const answeredAt =
    ticket.latestInvestigation?.outcome === "already_answered"
      ? getInvestigationTimestamp(ticket.latestInvestigation)
      : null;
  const validAfter = latestTimestamp(lastSentResponseAt, answeredAt);
  const candidate = getNewestSuggestionByStatus(
    ticket.suggestions,
    "candidate",
    validAfter,
  );
  if (candidate) return candidate.body;
  return null;
}

export function formatDuration(minutes?: number | null): string {
  if (minutes == null) return "—";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = Math.round(minutes % 60);
  return remainder ? `${hours}h ${remainder}min` : `${hours}h`;
}

export function formatNumber(value?: number | null): string {
  return new Intl.NumberFormat("pt-BR").format(value ?? 0);
}

export function formatBytes(bytes?: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

function formatter(kind: "time" | "full" | "day"): Intl.DateTimeFormat {
  const key = `${supportTimeZone}:${kind}`;
  const existing = formatterCache.get(key);
  if (existing) return existing;
  const options: Intl.DateTimeFormatOptions = kind === "time"
    ? { timeZone: supportTimeZone, hour: "2-digit", minute: "2-digit" }
    : kind === "full"
      ? {
          timeZone: supportTimeZone,
          day: "2-digit",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }
      : {
          timeZone: supportTimeZone,
          weekday: "long",
          day: "2-digit",
          month: "long",
          year: "numeric",
        };
  const created = new Intl.DateTimeFormat("pt-BR", options);
  formatterCache.set(key, created);
  return created;
}
