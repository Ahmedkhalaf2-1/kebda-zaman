import { BadRequestException } from '@nestjs/common';
import { SalesGroupBy } from './dto/sales-timeline-query.dto';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_BUCKETS = 1000;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function startOfUtcWeek(d: Date): Date {
  const day = startOfUtcDay(d);
  const weekday = day.getUTCDay(); // 0 (Sun) .. 6 (Sat)
  const daysSinceMonday = (weekday + 6) % 7;
  return new Date(day.getTime() - daysSinceMonday * DAY_MS);
}

function startOfUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export function bucketStart(d: Date, groupBy: SalesGroupBy): Date {
  if (groupBy === 'week') return startOfUtcWeek(d);
  if (groupBy === 'month') return startOfUtcMonth(d);
  return startOfUtcDay(d);
}

export function nextBucket(d: Date, groupBy: SalesGroupBy): Date {
  if (groupBy === 'week') return new Date(d.getTime() + 7 * DAY_MS);
  if (groupBy === 'month') return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return new Date(d.getTime() + DAY_MS);
}

/** "YYYY-MM-DD" for day/week buckets (week is keyed by its Monday start date); "YYYY-MM" for month. */
export function periodKey(d: Date, groupBy: SalesGroupBy): string {
  if (groupBy === 'month') return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Guards against a caller requesting an enormous, mostly-empty series (e.g. groupBy=day over decades). */
export function assertBucketCountReasonable(from: Date, to: Date, groupBy: SalesGroupBy): void {
  const spanMs = to.getTime() - from.getTime();
  const bucketMs = groupBy === 'week' ? 7 * DAY_MS : groupBy === 'month' ? 30 * DAY_MS : DAY_MS;
  if (spanMs / bucketMs > MAX_BUCKETS) {
    throw new BadRequestException({
      message: 'Requested date range produces too many periods; narrow the range or use a coarser groupBy',
      code: 'DATE_RANGE_TOO_LARGE',
    });
  }
}
