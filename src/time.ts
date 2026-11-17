/** Calendar arithmetic in one named time zone. Dates are `YYYY-MM-DD`, instants are epoch milliseconds. */

const WEEKDAYS = ["月", "火", "水", "木", "金", "土", "日"];

function zoned(ms: number, tz: string): Temporal.ZonedDateTime {
	return Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(tz);
}

export function isTimeZone(tz: string): boolean {
	try {
		new Intl.DateTimeFormat("en", { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

/** The date an instant falls on. */
export function dateOf(ms: number, tz: string): string {
	return zoned(ms, tz).toPlainDate().toString();
}

export function addDays(date: string, days: number): string {
	return Temporal.PlainDate.from(date).add({ days }).toString();
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
	return Temporal.PlainDate.from(from).until(Temporal.PlainDate.from(to), { largestUnit: "days" }).days;
}

/** The first instant of a date. */
export function startOfDay(date: string, tz: string): number {
	return Temporal.PlainDate.from(date).toZonedDateTime(tz).epochMilliseconds;
}

/** A wall-clock time (`YYYY-MM-DDTHH:MM`, seconds optional) as an instant. Throws a `RangeError` for anything else. */
export function localToEpoch(local: string, tz: string): number {
	return Temporal.PlainDateTime.from(local).toZonedDateTime(tz).epochMilliseconds;
}

/** Minutes since midnight of an instant's wall-clock time. */
export function minutesOfDay(ms: number, tz: string): number {
	const time = zoned(ms, tz);
	return time.hour * 60 + time.minute;
}

/** `HH:MM` as minutes since midnight. */
export function parseClock(clock: string): number | undefined {
	const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(clock);
	return match === null ? undefined : Number(match[1]) * 60 + Number(match[2]);
}

/** `11/17(火)` */
export function formatDay(date: string): string {
	const day = Temporal.PlainDate.from(date);
	return `${day.month}/${day.day}(${WEEKDAYS[day.dayOfWeek - 1]})`;
}

/** `15:30` */
export function formatClock(ms: number, tz: string): string {
	const time = zoned(ms, tz);
	return `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
}

/** `2026-11-17(火) 15:30` */
export function formatStamp(ms: number, tz: string): string {
	const date = dateOf(ms, tz);
	return `${date}(${WEEKDAYS[Temporal.PlainDate.from(date).dayOfWeek - 1]}) ${formatClock(ms, tz)}`;
}
