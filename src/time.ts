const WEEKDAYS = ["月", "火", "水", "木", "金", "土", "日"];

function zoned(ms: number, tz: string): Temporal.ZonedDateTime {
	return Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(tz);
}

const knownZones = new Map<string, boolean>();

/** Asked for the TZID of every occurrence read, so remembered. */
export function isTimeZone(tz: string): boolean {
	let known = knownZones.get(tz);
	if (known === undefined) {
		try {
			new Intl.DateTimeFormat("en", { timeZone: tz });
			known = true;
		} catch {
			known = false;
		}
		knownZones.set(tz, known);
	}
	return known;
}

export function localDateTime(ms: number, tz: string): Temporal.PlainDateTime {
	return zoned(ms, tz).toPlainDateTime();
}

/** YYYY-MM-DDTHH:MM, as the tools take a time. */
export function localMinute(ms: number, tz: string): string {
	return localDateTime(ms, tz).toString({ smallestUnit: "minute" });
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
