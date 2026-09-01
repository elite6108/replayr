/** Canonical analytics time. Store and aggregate in UTC. Week is Monday–Sunday. */

export const ANALYTICS_WEEK_STARTS_ON = 1; // Monday
export const ANALYTICS_RECENT_ROLLUP_DAYS = 3; // today + previous 2
export const ANALYTICS_BACKFILL_MAX_DAYS = 366;

export type UtcDay = string; // YYYY-MM-DD

export function utcDay(at: Date = new Date()): UtcDay {
  return at.toISOString().slice(0, 10);
}

export function parseUtcDay(value: string): UtcDay {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("Date must be YYYY-MM-DD in UTC.");
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || utcDay(date) !== value) {
    throw new Error("Date must be a real UTC calendar day.");
  }
  return value;
}

export function addUtcDays(day: UtcDay, days: number): UtcDay {
  const date = new Date(`${parseUtcDay(day)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return utcDay(date);
}

export function utcDayStart(day: UtcDay): Date {
  return new Date(`${parseUtcDay(day)}T00:00:00.000Z`);
}

/** Half-open [from, to) in UTC days. */
export function halfOpenUtcRange(fromInclusive: string, toExclusive: string): { from: UtcDay; to: UtcDay } {
  const from = parseUtcDay(fromInclusive);
  const to = parseUtcDay(toExclusive);
  if (to <= from) throw new Error("Range must be [from, to) with to after from.");
  return { from, to };
}

export function inclusiveUtcRange(fromInclusive: string, toInclusive: string): { from: UtcDay; to: UtcDay } {
  return halfOpenUtcRange(fromInclusive, addUtcDays(parseUtcDay(toInclusive), 1));
}

export function utcWeekStart(day: UtcDay): UtcDay {
  const date = utcDayStart(day);
  const weekday = date.getUTCDay(); // 0 Sunday
  const delta = weekday === 0 ? -6 : ANALYTICS_WEEK_STARTS_ON - weekday;
  return addUtcDays(day, delta);
}

export function utcWeekRange(day: UtcDay): { from: UtcDay; to: UtcDay } {
  const from = utcWeekStart(day);
  return { from, to: addUtcDays(from, 7) };
}

export function utcMonthStart(day: UtcDay): UtcDay {
  return `${parseUtcDay(day).slice(0, 7)}-01`;
}

export function utcMonthRange(day: UtcDay): { from: UtcDay; to: UtcDay } {
  const from = utcMonthStart(day);
  const date = utcDayStart(from);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return { from, to: utcDay(date) };
}

/** Cron window: current UTC day plus the previous two days, as [from, to). */
export function recentRollupRange(now = new Date()): { from: UtcDay; to: UtcDay } {
  const today = utcDay(now);
  return { from: addUtcDays(today, -(ANALYTICS_RECENT_ROLLUP_DAYS - 1)), to: addUtcDays(today, 1) };
}

export function assertBackfillRange(fromInclusive: string, toExclusive: string): { from: UtcDay; to: UtcDay } {
  const range = halfOpenUtcRange(fromInclusive, toExclusive);
  const start = utcDayStart(range.from).getTime();
  const end = utcDayStart(range.to).getTime();
  const days = Math.round((end - start) / 86_400_000);
  if (days > ANALYTICS_BACKFILL_MAX_DAYS) {
    throw new Error(`Backfill cannot exceed ${ANALYTICS_BACKFILL_MAX_DAYS} days.`);
  }
  return range;
}

export function daysInRange(from: UtcDay, to: UtcDay): UtcDay[] {
  const days: UtcDay[] = [];
  let cursor = from;
  while (cursor < to) {
    days.push(cursor);
    cursor = addUtcDays(cursor, 1);
  }
  return days;
}

export const ANALYTICS_DEFAULT_TZ = "America/New_York";
export const ANALYTICS_FIRST_DAY: UtcDay = "2026-08-21";
export const ANALYTICS_DOWNLOADS_AVAILABLE_FROM: UtcDay = "2026-08-31";

export type AnalyticsPreset =
  | "today"
  | "yesterday"
  | "this_week"
  | "last_week"
  | "last_7"
  | "last_14"
  | "last_30"
  | "last_90"
  | "this_month"
  | "last_month"
  | "ytd"
  | "all_time"
  | "custom";

export type AnalyticsGranularity = "day" | "week" | "month";

export function zonedCalendarDay(at: Date, timeZone: string): UtcDay {
  const formatted = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
  return parseUtcDay(formatted);
}

function tzOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const num = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const hourRaw = num("hour");
  const hour = hourRaw === 24 ? 0 : hourRaw;
  const asUtc = Date.UTC(num("year"), num("month") - 1, num("day"), hour, num("minute"), num("second"));
  return asUtc - at.getTime();
}

/** Instant of local midnight for a calendar date in `timeZone`. */
export function dateRangeToUtc(fromInclusive: string, toExclusive: string, timeZone: string): { from: Date; to: Date } {
  const from = parseUtcDay(fromInclusive);
  const to = parseUtcDay(toExclusive);
  if (to <= from) throw new Error("Range must be [from, to) with to after from.");
  return { from: zonedDayStartUtc(from, timeZone), to: zonedDayStartUtc(to, timeZone) };
}

export function zonedDayStartUtc(day: UtcDay, timeZone: string): Date {
  parseUtcDay(day);
  let guess = new Date(`${day}T00:00:00.000Z`);
  guess = new Date(guess.getTime() - tzOffsetMs(guess, timeZone));
  if (zonedCalendarDay(guess, timeZone) !== day) {
    guess = new Date(guess.getTime() + 3_600_000);
  }
  if (zonedCalendarDay(guess, timeZone) !== day) {
    guess = new Date(guess.getTime() - 7_200_000);
  }
  return guess;
}

export function zonedWeekStart(day: UtcDay, timeZone = ANALYTICS_DEFAULT_TZ): UtcDay {
  const start = zonedDayStartUtc(day, timeZone);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(start);
  const map: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  return addUtcDays(day, -(map[weekday] ?? 0));
}

export function weekRange(day: UtcDay, timeZone = ANALYTICS_DEFAULT_TZ): { from: UtcDay; to: UtcDay } {
  const from = zonedWeekStart(day, timeZone);
  return { from, to: addUtcDays(from, 7) };
}

export function monthRange(day: UtcDay): { from: UtcDay; to: UtcDay } {
  return utcMonthRange(day);
}

export function utcQuarterStart(day: UtcDay): UtcDay {
  const month = Number(parseUtcDay(day).slice(5, 7));
  const startMonth = Math.floor((month - 1) / 3) * 3 + 1;
  return `${day.slice(0, 4)}-${String(startMonth).padStart(2, "0")}-01`;
}

export function utcQuarterRange(day: UtcDay): { from: UtcDay; to: UtcDay } {
  const from = utcQuarterStart(day);
  const date = utcDayStart(from);
  date.setUTCMonth(date.getUTCMonth() + 3);
  return { from, to: utcDay(date) };
}

export function quarterLabel(day: UtcDay): string {
  const month = Number(parseUtcDay(day).slice(5, 7));
  return `Q${Math.floor((month - 1) / 3) + 1} ${day.slice(0, 4)}`;
}

export function formatMonthYear(day: UtcDay): string {
  return utcDayStart(day).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

export function previousPeriod(from: UtcDay, to: UtcDay): { from: UtcDay; to: UtcDay } {
  const days = daysInRange(from, to).length;
  if (days <= 0) throw new Error("Range must contain at least one day.");
  return { from: addUtcDays(from, -days), to: from };
}

export const COMPARISON_UNAVAILABLE_REASON = "No tracked data for previous period";
export const COMPARISON_PARTIAL_REASON = "Previous period only partially overlaps tracked data";

export type AnalyticsComparison = {
  requested: { from: UtcDay; to: UtcDay };
  from: UtcDay;
  to: UtcDay;
  available: boolean;
  complete: boolean;
  reason: string | null;
};

export function isValidHalfOpen(from: string, to: string): boolean {
  try {
    halfOpenUtcRange(from, to);
    return true;
  } catch {
    return false;
  }
}

/** Intersect a valid [from, to) with analytics availability. Null if no overlap. */
export function intersectUtcRange(
  from: UtcDay,
  to: UtcDay,
  availableFrom: UtcDay = ANALYTICS_FIRST_DAY,
  availableTo?: UtcDay,
): { from: UtcDay; to: UtcDay } | null {
  const requested = halfOpenUtcRange(from, to);
  const start = requested.from > availableFrom ? requested.from : availableFrom;
  const end = availableTo && availableTo < requested.to ? availableTo : requested.to;
  if (end <= start) return null;
  return { from: start, to: end };
}

/** Clip a requested previous [from, to) to analytics availability. Never inverts. */
export function clipRequestedComparison(
  requested: { from: UtcDay; to: UtcDay },
  availableFrom: UtcDay = ANALYTICS_FIRST_DAY,
): AnalyticsComparison {
  const overlap = intersectUtcRange(requested.from, requested.to, availableFrom);
  if (!overlap) {
    return {
      requested,
      from: requested.from,
      to: requested.to,
      available: false,
      complete: false,
      reason: COMPARISON_UNAVAILABLE_REASON,
    };
  }
  const complete = overlap.from === requested.from && overlap.to === requested.to;
  return {
    requested,
    from: overlap.from,
    to: overlap.to,
    available: true,
    complete,
    reason: complete ? null : COMPARISON_PARTIAL_REASON,
  };
}

/** Previous period clipped to analytics availability. Never returns an inverted query range. */
export function resolveComparisonPeriod(
  from: UtcDay,
  to: UtcDay,
  availableFrom: UtcDay = ANALYTICS_FIRST_DAY,
): AnalyticsComparison {
  return clipRequestedComparison(previousPeriod(from, to), availableFrom);
}

export type ReportType = "daily" | "weekly" | "monthly" | "quarterly" | "ytd" | "custom";

export function requestedPreviousForReport(type: ReportType, from: UtcDay, to: UtcDay): { from: UtcDay; to: UtcDay } {
  if (type === "monthly") return monthRange(addUtcDays(from, -1));
  if (type === "quarterly") return utcQuarterRange(addUtcDays(from, -1));
  return previousPeriod(from, to);
}

export function resolveReportPeriod(
  type: ReportType,
  input: { date?: string; from?: string; toInclusive?: string },
  now = new Date(),
  timeZone = ANALYTICS_DEFAULT_TZ,
): { type: ReportType; from: UtcDay; to: UtcDay; label: string } {
  const today = zonedCalendarDay(now, timeZone);
  const anchor = input.date ? parseUtcDay(input.date) : today;
  if (type === "daily") {
    const from = anchor;
    const to = addUtcDays(from, 1);
    return { type, from, to, label: formatLongDay(from) };
  }
  if (type === "weekly") {
    const range = weekRange(anchor, timeZone);
    return { type, ...range, label: formatRangeLabel(range.from, range.to) };
  }
  if (type === "monthly") {
    const range = monthRange(anchor);
    return { type, ...range, label: formatMonthYear(range.from) };
  }
  if (type === "quarterly") {
    const range = utcQuarterRange(anchor);
    return { type, ...range, label: quarterLabel(range.from) };
  }
  if (type === "ytd") {
    const from = `${anchor.slice(0, 4)}-01-01`;
    const last = anchor <= today ? anchor : today;
    const to = addUtcDays(last, 1);
    return { type, from, to, label: `${from.slice(0, 4)} year to date` };
  }
  if (!input.from || !input.toInclusive) throw new Error("Custom report requires from and to.");
  const range = inclusiveUtcRange(input.from, input.toInclusive);
  return { type, ...range, label: formatRangeLabel(range.from, range.to) };
}

export function reportTitle(type: ReportType, from: UtcDay, to: UtcDay, label: string): string {
  if (type === "daily") return `${label} Daily Report`;
  if (type === "weekly") return `${label} Weekly Report`;
  if (type === "monthly") return `${label} Monthly Report`;
  if (type === "quarterly") return `${label} Quarterly Report`;
  if (type === "ytd") return `${from.slice(0, 4)} Year to Date Report`;
  return `Custom ${label}`;
}

/** Queryable overlap. Null when comparison is unavailable or inverted. */
export function comparisonQueryRange(comparison: AnalyticsComparison | null | undefined): { from: UtcDay; to: UtcDay } | null {
  if (!comparison?.available) return null;
  if (comparison.to <= comparison.from) return null;
  return { from: comparison.from, to: comparison.to };
}

/** Equal-length previous window. Null when unavailable or only a partial overlap. */
export function comparisonPeriodRange(comparison: AnalyticsComparison | null | undefined): { from: UtcDay; to: UtcDay } | null {
  if (!comparison?.complete) return null;
  return comparisonQueryRange(comparison);
}

/** Cumulative [availableFrom, to). Null when that would invert. */
export function cumulativeThrough(toExclusive: string, availableFrom: UtcDay = ANALYTICS_FIRST_DAY): { from: UtcDay; to: UtcDay } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(toExclusive) || toExclusive <= availableFrom) return null;
  return { from: availableFrom, to: toExclusive };
}

export function serializeComparisonRange(comparison: AnalyticsComparison | null | undefined) {
  if (!comparison) return null;
  const span = comparison.available ? { from: comparison.from, to: comparison.to } : comparison.requested;
  return {
    from: span.from,
    to: span.to,
    requestedFrom: comparison.requested.from,
    requestedTo: comparison.requested.to,
    label: formatRangeLabel(span.from, span.to),
    available: comparison.available,
    complete: comparison.complete,
    reason: comparison.reason,
  };
}

export function defaultGranularity(from: UtcDay, to: UtcDay): AnalyticsGranularity {
  const days = daysInRange(from, to).length;
  if (days <= 45) return "day";
  if (days <= 180) return "week";
  return "month";
}

export function resolveAnalyticsPreset(
  preset: AnalyticsPreset,
  now = new Date(),
  timeZone = ANALYTICS_DEFAULT_TZ,
  custom?: { from: string; toInclusive: string },
): { from: UtcDay; to: UtcDay; preset: AnalyticsPreset } {
  const today = zonedCalendarDay(now, timeZone);
  if (preset === "today") return { from: today, to: addUtcDays(today, 1), preset };
  if (preset === "yesterday") return { from: addUtcDays(today, -1), to: today, preset };
  if (preset === "this_week") {
    const range = weekRange(today, timeZone);
    return { ...range, preset };
  }
  if (preset === "last_week") {
    const current = weekRange(today, timeZone);
    return { from: addUtcDays(current.from, -7), to: current.from, preset };
  }
  if (preset === "last_7") return { from: addUtcDays(today, -6), to: addUtcDays(today, 1), preset };
  if (preset === "last_14") return { from: addUtcDays(today, -13), to: addUtcDays(today, 1), preset };
  if (preset === "last_30") return { from: addUtcDays(today, -29), to: addUtcDays(today, 1), preset };
  if (preset === "last_90") return { from: addUtcDays(today, -89), to: addUtcDays(today, 1), preset };
  if (preset === "this_month") return { ...monthRange(today), preset };
  if (preset === "last_month") {
    const thisMonth = monthRange(today);
    const prev = addUtcDays(thisMonth.from, -1);
    return { ...monthRange(prev), preset };
  }
  if (preset === "ytd") return { from: `${today.slice(0, 4)}-01-01`, to: addUtcDays(today, 1), preset };
  if (preset === "all_time") return { from: ANALYTICS_FIRST_DAY, to: addUtcDays(today, 1), preset };
  if (!custom) throw new Error("Custom range requires from and to.");
  return { ...inclusiveUtcRange(custom.from, custom.toInclusive), preset: "custom" };
}

export function formatRangeLabel(from: UtcDay, to: UtcDay): string {
  const days = daysInRange(from, to);
  const last = days[days.length - 1] ?? from;
  const start = formatShortDay(from);
  const end = formatShortDay(last);
  if (days.length === 1) return formatLongDay(from);
  return `${start}–${end}`;
}

export function formatShortDay(day: UtcDay): string {
  const date = utcDayStart(day);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function formatLongDay(day: UtcDay): string {
  const date = utcDayStart(day);
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function percentChange(current: number | null, previous: number | null): number | "new" | null {
  if (current == null || previous == null) return null;
  if (previous === 0 && current === 0) return null;
  if (previous === 0) return "new";
  return (current - previous) / previous;
}

export function bucketKey(day: UtcDay, granularity: AnalyticsGranularity, timeZone = ANALYTICS_DEFAULT_TZ): UtcDay {
  if (granularity === "week") return zonedWeekStart(day, timeZone);
  if (granularity === "month") return utcMonthStart(day);
  return day;
}

