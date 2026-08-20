import {
  DASHBOARD_TIME_ZONE,
  type DashboardPeriodDto,
  type DashboardPeriodInput,
} from "../../shared/contracts.js";

import { ValidationError } from "./errors.js";

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const zonedPartsFormatters = new Map<string, Intl.DateTimeFormat>();

export function resolveDashboardPeriod(
  input?: DashboardPeriodInput,
  timeZone: string = DASHBOARD_TIME_ZONE,
): DashboardPeriodDto | null {
  if (!input) return null;

  assertTimeZone(timeZone);

  assertCalendarDate(input.from, "from", timeZone);
  assertCalendarDate(input.to, "to", timeZone);
  if (input.from > input.to) {
    throw new ValidationError("from não pode ser posterior a to", {
      from: input.from,
      to: input.to,
    });
  }

  return {
    from: input.from,
    to: input.to,
    timeZone,
    fromUtc: calendarDateStartUtc(input.from, timeZone),
    toUtcExclusive: calendarDateStartUtc(nextCalendarDate(input.to), timeZone),
  };
}

export function dashboardCalendarDates(period: DashboardPeriodDto): string[] {
  const dates: string[] = [];
  let current = period.from;
  while (current <= period.to) {
    dates.push(current);
    current = nextCalendarDate(current);
  }
  return dates;
}

export function previousDashboardPeriod(
  period: DashboardPeriodDto,
): DashboardPeriodDto {
  const days = dashboardCalendarDates(period).length;
  const to = addCalendarDays(period.from, -1);
  const from = addCalendarDays(to, 1 - days);
  return resolveDashboardPeriod({ from, to }, period.timeZone) as DashboardPeriodDto;
}

export function dashboardDateInTimeZone(
  timestamp: string,
  timeZone: string = DASHBOARD_TIME_ZONE,
): string {
  const parts = zonedDateParts(new Date(timestamp), timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function dashboardDateTimeInTimeZone(
  timestamp: string,
  timeZone: string = DASHBOARD_TIME_ZONE,
): string {
  const parts = zonedDateParts(new Date(timestamp), timeZone);
  return `${pad(parts.day)}/${pad(parts.month)}/${parts.year} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

export function recentDashboardPeriod(
  days = 14,
  now = new Date(),
  timeZone: string = DASHBOARD_TIME_ZONE,
): DashboardPeriodDto {
  if (!Number.isInteger(days) || days < 1) {
    throw new ValidationError("days deve ser um inteiro positivo");
  }
  const to = dashboardDateInTimeZone(now.toISOString(), timeZone);
  const from = addCalendarDays(to, 1 - days);
  return resolveDashboardPeriod({ from, to }, timeZone) as DashboardPeriodDto;
}

function assertCalendarDate(
  value: string,
  field: "from" | "to",
  timeZone: string,
): void {
  if (!CALENDAR_DATE_PATTERN.test(value) || normalizedCalendarDate(value) !== value) {
    throw new ValidationError(`${field} deve ser uma data válida em YYYY-MM-DD`, {
      field,
      value,
      timeZone,
    });
  }
}

function normalizedCalendarDate(value: string): string | null {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  const normalized = new Date(Date.UTC(year, month - 1, day));
  return [
    normalized.getUTCFullYear(),
    pad(normalized.getUTCMonth() + 1),
    pad(normalized.getUTCDate()),
  ].join("-");
}

function nextCalendarDate(value: string): string {
  return addCalendarDays(value, 1);
}

function addCalendarDays(value: string, amount: number): string {
  const [year, month, day] = value.split("-").map(Number);
  const next = new Date(
    Date.UTC(year as number, (month as number) - 1, (day as number) + amount),
  );
  return [next.getUTCFullYear(), pad(next.getUTCMonth() + 1), pad(next.getUTCDate())].join("-");
}

function calendarDateStartUtc(value: string, timeZone: string): string {
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const desiredWallClock = Date.UTC(year, month - 1, day);
  let instant = desiredWallClock;

  // Intl knows the IANA time-zone rules. Converge the guessed UTC instant until
  // its wall clock in the workspace timezone is the requested local midnight.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = zonedDateParts(new Date(instant), timeZone);
    const representedWallClock = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const correction = desiredWallClock - representedWallClock;
    instant += correction;
    if (correction === 0) break;
  }

  return new Date(instant).toISOString();
}

function zonedDateParts(date: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const values = new Map(
    zonedPartsFormatter(timeZone)
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: values.get("year") as number,
    month: values.get("month") as number,
    day: values.get("day") as number,
    hour: values.get("hour") as number,
    minute: values.get("minute") as number,
    second: values.get("second") as number,
  };
}

function zonedPartsFormatter(timeZone: string): Intl.DateTimeFormat {
  const existing = zonedPartsFormatters.get(timeZone);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  zonedPartsFormatters.set(timeZone, formatter);
  return formatter;
}

function assertTimeZone(timeZone: string): void {
  try {
    zonedPartsFormatter(timeZone).format();
  } catch {
    throw new ValidationError("Fuso horário IANA inválido", { timeZone });
  }
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
