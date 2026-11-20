import ICAL from "ical.js";
import { isTimeZone } from "./time.ts";

const pad = (value: number) => String(value).padStart(2, "0");

function offsetOf(nanoseconds: number): string {
	const seconds = Math.round(nanoseconds / 1e9);
	const abs = Math.abs(seconds);
	const rest = abs % 60;
	return `${seconds < 0 ? "-" : "+"}${pad(Math.floor(abs / 3600))}${pad(Math.floor((abs % 3600) / 60))}${rest === 0 ? "" : pad(rest)}`;
}

function wallClock(ms: number, offsetNanoseconds: number): string {
	const date = new Date(ms + offsetNanoseconds / 1e6);
	return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

/** Built from the runtime's zone database, with every transition from `from` to `to` written out on its own. */
export function vtimezone(tzid: string, from: number, to: number): ICAL.Component {
	let at = Temporal.Instant.fromEpochMilliseconds(from).toZonedDateTimeISO(tzid);
	const observance = (kind: string, start: string, before: number, after: number) =>
		[`BEGIN:${kind}`, `DTSTART:${start}`, `TZOFFSETFROM:${offsetOf(before)}`, `TZOFFSETTO:${offsetOf(after)}`, `END:${kind}`];
	const lines = ["BEGIN:VTIMEZONE", `TZID:${tzid}`, ...observance("STANDARD", "19700101T000000", at.offsetNanoseconds, at.offsetNanoseconds)];
	for (;;) {
		const next = at.getTimeZoneTransition("next");
		if (next === null || next.epochMilliseconds > to) break;
		lines.push(...observance(next.offsetNanoseconds > at.offsetNanoseconds ? "DAYLIGHT" : "STANDARD", wallClock(next.epochMilliseconds, at.offsetNanoseconds), at.offsetNanoseconds, next.offsetNanoseconds));
		at = next;
	}
	lines.push("END:VTIMEZONE");
	return new ICAL.Component(ICAL.parse(lines.join("\r\n")));
}

/**
 * Without the zone, ical.js takes a time with a TZID as UTC when it compares it with one in UTC, and so ended a rule
 * with a UTC UNTIL early by the zone's offset. ical.js finds a TZID's zone only through this lookup, so a zone missing
 * from it is made from the runtime's database on first use rather than from the file's VTIMEZONE, as the times
 * themselves are read (see `toEpoch` in `src/calendar.ts`).
 */
const lookup = ICAL.TimezoneService.get.bind(ICAL.TimezoneService);
ICAL.TimezoneService.get = (tzid: string) => {
	const found = lookup(tzid);
	if (found !== undefined || !isTimeZone(tzid)) return found;
	ICAL.TimezoneService.register(vtimezone(tzid, Date.UTC(1970, 0, 1), Date.UTC(2100, 0, 1)));
	return lookup(tzid);
};
