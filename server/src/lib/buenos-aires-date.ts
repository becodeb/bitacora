/**
 * Buenos-Aires-local calendar-date helpers for T08's nightly jobs. Kept
 * separate from `agent/prompt.ts`'s own `TIMEZONE` constant (same value,
 * different module) because that one only ever needs to *display* a
 * timestamp via `Intl.DateTimeFormat`, while this module needs to
 * compute a day's UTC boundaries for a SQL range query — a different
 * enough job to not share an implementation.
 */

export const BUENOS_AIRES_TIMEZONE = "America/Argentina/Buenos_Aires";

/**
 * Argentina abolished daylight-saving time in 2009 and has not
 * reinstated it since, so Buenos Aires has stayed at a fixed UTC-3
 * offset for every date this app will ever see. `buenosAiresDayRangeUtc`
 * below depends on that fixed offset holding; if it ever changes, this
 * module (not `prompt.ts`'s own display formatting, which already goes
 * through `Intl`'s `timeZone` and needs no change) must be revisited.
 */
const BUENOS_AIRES_UTC_OFFSET = "-03:00";

const DATE_LABEL_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUENOS_AIRES_TIMEZONE,
  dateStyle: "short",
});

/** `YYYY-MM-DD` (en-CA locale formats dates this way) for `date`'s calendar day in Buenos Aires. */
export function formatBuenosAiresDateLabel(date: Date): string {
  return DATE_LABEL_FORMATTER.format(date);
}

const DATE_LABEL_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDateLabel(label: string): boolean {
  if (!DATE_LABEL_PATTERN.test(label)) return false;
  // Reject a syntactically well-formed but calendrically impossible date
  // (e.g. "2026-02-30") rather than silently rolling it over to March.
  return (
    formatBuenosAiresDateLabel(new Date(`${label}T12:00:00${BUENOS_AIRES_UTC_OFFSET}`)) === label
  );
}

/** `label`'s calendar day before it, as its own `YYYY-MM-DD` label. Pure string/date-part arithmetic — never touches a time zone, since `label` is already a calendar date with no time component. */
export function previousDateLabel(label: string): string {
  const [year, month, day] = label.split("-").map(Number) as [number, number, number];
  const utcMidnight = new Date(Date.UTC(year, month - 1, day));
  utcMidnight.setUTCDate(utcMidnight.getUTCDate() - 1);
  return utcMidnight.toISOString().slice(0, 10);
}

/** Yesterday's Buenos Aires date label, relative to `now` (defaults to the real current time). */
export function yesterdayDateLabel(now: Date = new Date()): string {
  return previousDateLabel(formatBuenosAiresDateLabel(now));
}

/**
 * The `[start, end)` UTC instant range covering `dateLabel`'s full
 * calendar day in Buenos Aires (00:00:00 to 24:00:00 local). Relies on
 * the fixed UTC-3 offset documented above.
 */
export function buenosAiresDayRangeUtc(dateLabel: string): { start: Date; end: Date } {
  const start = new Date(`${dateLabel}T00:00:00${BUENOS_AIRES_UTC_OFFSET}`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}
