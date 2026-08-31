import { DASHBOARD_TIME_ZONE } from "../../shared/contracts.js";

export type DashboardPeriodId =
  | "today"
  | "last_7_days"
  | "last_30_days"
  | "last_90_days"
  | "all_time"
  | "custom";

export interface DashboardDateRange {
  from?: string;
  to?: string;
}

export const dashboardPeriodOptions: Array<{
  id: DashboardPeriodId;
  label: string;
}> = [
  { id: "today", label: "Hoje" },
  { id: "last_7_days", label: "Últimos 7 dias" },
  { id: "last_30_days", label: "Últimos 30 dias" },
  { id: "last_90_days", label: "Últimos 90 dias" },
  { id: "all_time", label: "Todo o período" },
  { id: "custom", label: "Personalizado" },
];

export function getDashboardPresetRange(
  period: Exclude<DashboardPeriodId, "custom">,
  today = new Date(),
  timeZone: string = DASHBOARD_TIME_ZONE,
): DashboardDateRange {
  if (period === "all_time") return {};

  const days = period === "today"
    ? 1
    : period === "last_7_days"
      ? 7
      : period === "last_30_days"
        ? 30
        : 90;
  const currentDate = dateInSupportTimeZone(today, timeZone);
  const to = new Date(Date.UTC(
    currentDate.year,
    currentDate.month - 1,
    currentDate.day,
    12,
  ));
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - (days - 1));
  return {
    from: toUtcDateInputValue(from),
    to: toUtcDateInputValue(to),
  };
}

export function dashboardDateRangeError(
  from: string,
  to: string,
): string | null {
  const fromDate = parseDateInput(from);
  const toDate = parseDateInput(to);
  if (!fromDate || !toDate) return "Informe as datas inicial e final.";
  if (fromDate.getTime() > toDate.getTime()) {
    return "A data inicial não pode ser posterior à data final.";
  }
  return null;
}

export function formatDashboardRangeLabel(
  range: DashboardDateRange,
  timeZone: string = DASHBOARD_TIME_ZONE,
): string {
  if (!range.from || !range.to) return "Todo o histórico";
  const from = parseDateInput(range.from);
  const to = parseDateInput(range.to);
  if (!from || !to) return "Período personalizado";
  const formatter = dashboardDateFormatter(timeZone);
  if (range.from === range.to) return formatter.format(from);
  return `${formatter.format(from)} a ${formatter.format(to)}`;
}

export function dashboardRangeKey(range: DashboardDateRange): string {
  return `${range.from ?? "all"}:${range.to ?? "all"}`;
}

export function dashboardExportFallbackName(range: DashboardDateRange): string {
  if (!range.from || !range.to) return "threadmark-dashboard-todo-periodo.csv";
  return `threadmark-dashboard-${range.from}-a-${range.to}.csv`;
}

function toUtcDateInputValue(value: Date): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateInSupportTimeZone(value: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
} {
  const parts = Object.fromEntries(
    supportDatePartsFormatter(timeZone)
      .formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
  };
}

function dashboardDateFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone,
  });
}

function supportDatePartsFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function parseDateInput(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day, 12));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) return null;
  return parsed;
}
