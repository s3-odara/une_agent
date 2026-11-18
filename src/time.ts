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

export function dateOf(ms: number, tz: string): string {
	return zoned(ms, tz).toPlainDate().toString();
}

export function addDays(date: string, days: number): string {
	return Temporal.PlainDate.from(date).add({ days }).toString();
}

export function daysBetween(from: string, to: string): number {
	return Temporal.PlainDate.from(from).until(Temporal.PlainDate.from(to), { largestUnit: "days" }).days;
}

export function startOfDay(date: string, tz: string): number {
	return Temporal.PlainDate.from(date).toZonedDateTime(tz).epochMilliseconds;
}

export function localToEpoch(local: string, tz: string): number {
	return Temporal.PlainDateTime.from(local).toZonedDateTime(tz).epochMilliseconds;
}

export function minutesOfDay(ms: number, tz: string): number {
	const time = zoned(ms, tz);
	return time.hour * 60 + time.minute;
}

export function parseClock(clock: string): number | undefined {
	const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(clock);
	return match === null ? undefined : Number(match[1]) * 60 + Number(match[2]);
}

export function formatDay(date: string): string {
	const day = Temporal.PlainDate.from(date);
	return `${day.month}/${day.day}(${WEEKDAYS[day.dayOfWeek - 1]})`;
}

export function formatClock(ms: number, tz: string): string {
	const time = zoned(ms, tz);
	return `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
}

export function formatStamp(ms: number, tz: string): string {
	const date = dateOf(ms, tz);
	return `${date}(${WEEKDAYS[Temporal.PlainDate.from(date).dayOfWeek - 1]}) ${formatClock(ms, tz)}`;
}
