import { BadRequestException } from '@nestjs/common';

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReportDateRange {
  from?: Date;
  to?: Date;
}

function parseBoundary(value: string, label: 'from' | 'to', endOfDay: boolean): Date {
  const iso = endOfDay && DATE_ONLY_RE.test(value) ? `${value}T23:59:59.999Z` : value;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException({
      message: `Invalid \`${label}\` date: ${value}`,
      code: 'INVALID_DATE_RANGE',
    });
  }
  return date;
}

/**
 * Resolves optional `from`/`to` report query strings into UTC instant boundaries.
 * - `from` is the start of the given instant. A date-only value (e.g. "2026-07-01")
 *   resolves to 00:00:00.000 UTC on that day.
 * - `to` is INCLUSIVE. A date-only value resolves to 23:59:59.999 UTC on that day
 *   (i.e. the whole day is included); a full ISO datetime is used as-is.
 * - Omitting both means "all time" (no filter) — callers get `{}` back.
 * - Never falls back to the server's local timezone; all parsing is UTC-explicit.
 *
 * Throws BadRequestException (code INVALID_DATE_RANGE) if `from` is after `to`,
 * or if either value fails to parse as a valid ISO date.
 */
export function resolveDateRange(from?: string, to?: string): ReportDateRange {
  const fromDate = from ? parseBoundary(from, 'from', false) : undefined;
  const toDate = to ? parseBoundary(to, 'to', true) : undefined;
  if (fromDate && toDate && fromDate.getTime() > toDate.getTime()) {
    throw new BadRequestException({
      message: '`from` must not be after `to`',
      code: 'INVALID_DATE_RANGE',
    });
  }
  return { from: fromDate, to: toDate };
}

/** Converts a resolved range into a Prisma `createdAt` filter, or `undefined` when unbounded on both sides. */
export function dateRangeWhereClause(range: ReportDateRange): { gte?: Date; lte?: Date } | undefined {
  if (!range.from && !range.to) {
    return undefined;
  }
  return {
    ...(range.from && { gte: range.from }),
    ...(range.to && { lte: range.to }),
  };
}

/**
 * Same parsing/validation as resolveDateRange, but always returns a concrete
 * bounded range: any side left unspecified defaults so the window spans
 * `defaultDays` trailing UTC days ending "today" (UTC). Used by the sales
 * timeline endpoint, which must fill gaps and therefore needs a finite range.
 */
export function resolveBoundedDateRange(
  from?: string,
  to?: string,
  defaultDays = 30,
): { from: Date; to: Date } {
  const range = resolveDateRange(from, to);
  const now = new Date();
  const endOfToday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999),
  );
  const to_ = range.to ?? endOfToday;
  const toDayStart = new Date(Date.UTC(to_.getUTCFullYear(), to_.getUTCMonth(), to_.getUTCDate()));
  const from_ = range.from ?? new Date(toDayStart.getTime() - (defaultDays - 1) * DAY_MS);
  return { from: from_, to: to_ };
}
