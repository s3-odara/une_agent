import ICAL from "ical.js";
import { errorMessage } from "./errors.ts";
import { addDays, dateOf, formatClock, formatDay, isTimeZone, localDateTime, localMinute, localToEpoch, startOfDay } from "./time.ts";
import { vtimezone } from "./zones.ts";

export type RawObject = { readonly url: string; readonly etag?: string; readonly data: string };

type ItemBase = {
	readonly id: string;
	readonly calendar: string;
	readonly uid: string;
	readonly summary: string;
	readonly description?: string;
	readonly etag?: string;
	readonly modified?: number;
};

export type EventItem = ItemBase & {
	readonly kind: "event";
	readonly allDay: boolean;
	readonly start: number;
	readonly end: number;
	readonly location?: string;
	readonly rule?: string;
	/** Where the occurrence was due before any change of its own, so that it keeps one name when moved. */
	readonly occurrence?: string;
};

export type TodoItem = ItemBase & {
	readonly kind: "todo";
	readonly done: boolean;
	readonly due?: { readonly date: string; readonly at?: number };
};

export type CalItem = EventItem | TodoItem;

export type EventFields = {
	readonly summary: string;
	readonly start: string;
	readonly end?: string;
	readonly location?: string;
	readonly description?: string;
	readonly rrule?: string;
};

export type TodoFields = { readonly summary: string; readonly due?: string; readonly description?: string };

export type Scope = "this" | "all";
export type Target = { readonly occurrence?: string; readonly scope?: Scope };

/** A refused request. Its message is written for the model. */
export class CalendarError extends Error {}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
const OCCURRENCE = /^(.*)@(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?)$/;
const MINUTE = 60_000;
const SCOPE_NEEDED = "繰り返しの予定です。scope に this（この回だけ）か all（全ての回）を指定してください。";

/** So an ETag read from a header equals one read from a report. */
export function normalizeEtag(etag: string | undefined): string {
	return (etag ?? "").replace(/^W\//, "").replace(/^"|"$/g, "");
}

function idOf(calendar: string, url: string): string {
	const file = url.replace(/\/+$/, "").split("/").pop() ?? "";
	return `${calendar}/${decodeURIComponent(file)}`;
}

/** The id the tools take: the item's, and for a recurring event the occurrence too. */
export function occurrenceId(event: EventItem): string {
	return event.occurrence === undefined ? event.id : `${event.id}@${event.occurrence}`;
}

export function splitId(id: string): { item: string; calendar: string; file: string; occurrence?: string } {
	const match = OCCURRENCE.exec(id);
	const item = match?.[1] ?? id;
	const slash = item.indexOf("/");
	if (slash <= 0 || slash === item.length - 1) throw new CalendarError(`id「${id}」の形が違います。calendar_list が返した id をそのまま使ってください。`);
	return { item, calendar: item.slice(0, slash), file: item.slice(slash + 1), ...(match === null ? {} : { occurrence: match[2] }) };
}

function tzidParam(property: ICAL.Property | null): string | undefined {
	const tzid = property?.getParameter("tzid");
	return typeof tzid === "string" ? tzid : undefined;
}

function tzidOf(component: ICAL.Component, name: string): string | undefined {
	return tzidParam(component.getFirstProperty(name));
}

function plainDate(time: ICAL.Time): string {
	return `${String(time.year).padStart(4, "0")}-${String(time.month).padStart(2, "0")}-${String(time.day).padStart(2, "0")}`;
}

function zoneFor(tzid: string | undefined, tz: string): string {
	return tzid !== undefined && isTimeZone(tzid) ? tzid : tz;
}

/**
 * The TZID is taken as an IANA zone name, which is what current clients write; the VTIMEZONE definitions in the file
 * are not consulted. A floating time, or one whose TZID is not a zone this runtime knows, is read in the agent's own
 * zone.
 */
function toEpoch(time: ICAL.Time, tzid: string | undefined, tz: string): number {
	if (time.isDate) return startOfDay(plainDate(time), tz);
	if (time.zone?.tzid === "UTC") return Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
	return Temporal.PlainDateTime.from({
		year: time.year,
		month: time.month,
		day: time.day,
		hour: time.hour,
		minute: time.minute,
		second: time.second,
	}).toZonedDateTime(zoneFor(tzid, tz)).epochMilliseconds;
}

function timeOf(component: ICAL.Component, name: string, tz: string): number | undefined {
	const value = component.getFirstPropertyValue(name);
	return value instanceof ICAL.Time ? toEpoch(value, tzidOf(component, name), tz) : undefined;
}

function occurrenceKey(ms: number, allDay: boolean, tz: string): string {
	return allDay ? dateOf(ms, tz) : localMinute(ms, tz);
}

function keyToEpoch(key: string, tz: string): number {
	return DATE.test(key) ? startOfDay(key, tz) : localToEpoch(key, tz);
}

function modifiedOf(component: ICAL.Component, tz: string): number | undefined {
	const stamps = ["last-modified", "dtstamp", "created"].flatMap((name) => {
		const value = component.getFirstPropertyValue(name);
		return value instanceof ICAL.Time ? [toEpoch(value, undefined, tz)] : [];
	});
	return stamps.length === 0 ? undefined : Math.max(...stamps);
}

function text(component: ICAL.Component, name: string): string | undefined {
	const value = component.getFirstPropertyValue(name);
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

type Read = { readonly root: ICAL.Component; readonly main: ICAL.Component; readonly kind: "event" | "todo" };

function readCalendar(data: string): Read {
	let root: ICAL.Component;
	try {
		root = new ICAL.Component(ICAL.parse(data));
	} catch {
		throw new CalendarError("この項目のデータを読めませんでした。");
	}
	for (const [name, kind] of [["vevent", "event"], ["vtodo", "todo"]] as const) {
		const main = root.getAllSubcomponents(name).find((component) => !component.hasProperty("recurrence-id"));
		if (main !== undefined) return { root, main, kind };
	}
	throw new CalendarError("この項目には予定もタスクもありません。");
}

/** One unreadable object must not hide the rest of the calendar. */
function tryRead(raw: RawObject): Read | undefined {
	try {
		return readCalendar(raw.data);
	} catch {
		return undefined;
	}
}

/** About 27 years of a daily event. */
const MAX_OCCURRENCES = 10_000;

function isRecurring(main: ICAL.Component): boolean {
	return main.hasProperty("rrule") || main.hasProperty("rdate");
}

function ruleOf(main: ICAL.Component): string | undefined {
	if (!isRecurring(main)) return undefined;
	return main.getFirstPropertyValue("rrule")?.toString() ?? "RDATE";
}

function overridesOf(root: ICAL.Component, main: ICAL.Component): ICAL.Component[] {
	return root.getAllSubcomponents("vevent").filter((component) => component !== main && component.hasProperty("recurrence-id"));
}

/** `rid` is where the occurrence was due before any change of its own; `start` and `end` are where it is now. */
type Occurrence = { readonly component: ICAL.Component; readonly start: ICAL.Time; readonly end: ICAL.Time; readonly rid: number; readonly ridIsDate: boolean };

/** Without `overrides`, the occurrences as the rule gives them. A single event is its one occurrence. */
function* occurrencesOf(main: ICAL.Component, tz: string, overrides: ICAL.Component[] = []): Generator<Occurrence> {
	const event = new ICAL.Event(main, { exceptions: overrides, strictExceptions: false });
	const tzid = tzidOf(main, "dtstart");
	if (!event.isRecurring()) {
		yield { component: main, start: event.startDate, end: event.endDate, rid: toEpoch(event.startDate, tzid, tz), ridIsDate: event.startDate.isDate };
		return;
	}
	const iterator = event.iterator();
	for (let count = 0; count < MAX_OCCURRENCES; count++) {
		const next = iterator.next();
		if (!next) return;
		const details = event.getOccurrenceDetails(next);
		yield { component: details.item.component, start: details.startDate, end: details.endDate, rid: toEpoch(next, tzid, tz), ridIsDate: next.isDate };
	}
}

function occurrenceAt(main: ICAL.Component, key: string, tz: string, overrides: ICAL.Component[] = []): Occurrence | undefined {
	const wanted = keyToEpoch(key, tz);
	for (const occurrence of occurrencesOf(main, tz, overrides)) {
		if (occurrenceKey(occurrence.rid, occurrence.ridIsDate, tz) === key) return occurrence;
		if (occurrence.rid > wanted + MINUTE) return undefined;
	}
	return undefined;
}

function findOccurrence(main: ICAL.Component, key: string | undefined, tz: string): number {
	if (key === undefined) throw new CalendarError("この回だけなら、calendar_list が返した回つきの id（…@日時）を使ってください。");
	const found = occurrenceAt(main, key, tz);
	if (found === undefined) throw new CalendarError(`この予定に ${key} の回はありません。calendar_list で id を確かめてください。`);
	return found.rid;
}

function spanOf(component: ICAL.Component, start: ICAL.Time, end: ICAL.Time, tz: string): { start: number; end: number } {
	const tzid = tzidOf(component, "dtstart");
	const from = toEpoch(start, tzid, tz);
	return { start: from, end: Math.max(toEpoch(end, tzidOf(component, "dtend") ?? tzid, tz), from) };
}

type Base = Pick<EventItem, "id" | "calendar" | "uid" | "etag" | "modified" | "rule">;

function eventItem(occurrence: Occurrence, span: { start: number; end: number }, base: Base, recurring: boolean, tz: string): EventItem {
	const component = occurrence.component;
	return {
		...base,
		kind: "event",
		uid: text(component, "uid") ?? base.uid,
		summary: text(component, "summary") ?? "（無題）",
		description: text(component, "description"),
		location: text(component, "location"),
		allDay: occurrence.start.isDate,
		...span,
		...(recurring ? { occurrence: occurrenceKey(occurrence.rid, occurrence.ridIsDate, tz) } : {}),
	};
}

function cancelled(component: ICAL.Component): boolean {
	return text(component, "status")?.toUpperCase() === "CANCELLED";
}

function baseOf(main: ICAL.Component, id: string, calendar: string): Base {
	return { id, calendar, uid: text(main, "uid") ?? "", rule: ruleOf(main) };
}

export function parseEvents(raw: RawObject, calendar: string, range: { from: number; to: number }, tz: string): EventItem[] {
	const read = tryRead(raw);
	if (read?.kind !== "event") return [];
	const { root, main } = read;
	const base: Base = { ...baseOf(main, idOf(calendar, raw.url), calendar), etag: raw.etag, modified: modifiedOf(main, tz) };
	const recurring = isRecurring(main);
	const items: EventItem[] = [];
	for (const occurrence of occurrencesOf(main, tz, overridesOf(root, main))) {
		if (occurrence.rid >= range.to) break;
		if (cancelled(occurrence.component)) continue;
		const span = spanOf(occurrence.component, occurrence.start, occurrence.end, tz);
		// An event without length still counts at its start.
		if (span.start >= range.to || Math.max(span.end, span.start + 1) <= range.from) continue;
		items.push(eventItem(occurrence, span, base, recurring, tz));
	}
	return items;
}

/** A recurring task is read as its first occurrence only. */
export function parseTodo(raw: RawObject, calendar: string, tz: string): TodoItem | undefined {
	const read = tryRead(raw);
	if (read?.kind !== "todo") return undefined;
	const todo = read.main;
	const status = text(todo, "status")?.toUpperCase();
	const due = todo.getFirstPropertyValue("due");
	const at = due instanceof ICAL.Time ? toEpoch(due, tzidOf(todo, "due"), tz) : undefined;
	return {
		kind: "todo",
		id: idOf(calendar, raw.url),
		calendar,
		etag: raw.etag,
		modified: modifiedOf(todo, tz),
		uid: text(todo, "uid") ?? "",
		summary: text(todo, "summary") ?? "（無題）",
		description: text(todo, "description"),
		// A cancelled task needs no reminder either.
		done: status === "COMPLETED" || status === "CANCELLED" || todo.hasProperty("completed"),
		due: due instanceof ICAL.Time && at !== undefined ? { date: due.isDate ? plainDate(due) : dateOf(at, tz), ...(due.isDate ? {} : { at }) } : undefined,
	};
}

function utc(ms: number): ICAL.Time {
	return ICAL.Time.fromJSDate(new Date(ms), true);
}

function setProperty(component: ICAL.Component, name: string, value: ICAL.Time | ICAL.Recur | string | number | undefined): void {
	// Removed first: an old property may carry parameters, such as a TZID, that no longer fit the new value.
	component.removeAllProperties(name);
	if (value !== undefined && value !== "") component.addPropertyWithValue(name, value);
}

type When = { readonly time: ICAL.Time; readonly tzid?: string };

function wallTime(ms: number, zone: string, tzid: string | undefined): ICAL.Time {
	const local = localDateTime(ms, zone);
	const data = { year: local.year, month: local.month, day: local.day, hour: local.hour, minute: local.minute, second: local.second, isDate: false };
	return ICAL.Time.fromData(data, tzid === undefined ? undefined : ICAL.TimezoneService.get(tzid));
}

function zoned(ms: number, tz: string): When {
	return { time: wallTime(ms, tz, tz), tzid: tz };
}

function addTime(component: ICAL.Component, name: string, when: When): void {
	const property = component.addPropertyWithValue(name, when.time);
	if (when.tzid !== undefined) property.setParameter("tzid", when.tzid);
}

function setTime(component: ICAL.Component, name: string, when: When): void {
	component.removeAllProperties(name);
	addTime(component, name, when);
}

/** In the form of the event's DTSTART, as RECURRENCE-ID and EXDATE must be. */
function timeAs(main: ICAL.Component, ms: number, tz: string): When {
	const start = main.getFirstPropertyValue("dtstart");
	if (!(start instanceof ICAL.Time)) throw new CalendarError("この予定には開始日時がありません。");
	if (start.isDate) return { time: ICAL.Time.fromDateString(dateOf(ms, tz)) };
	if (start.zone?.tzid === "UTC") return { time: utc(ms) };
	const tzid = tzidOf(main, "dtstart");
	return { time: wallTime(ms, zoneFor(tzid, tz), tzid), ...(tzid === undefined ? {} : { tzid }) };
}

/**
 * Timed values are written in UTC, which every client reads the same, except in a recurring event: its rule repeats
 * the wall-clock time and weekday of its start, and 08:00 on a Monday in Tokyo is 23:00 on a Sunday in UTC.
 */
function eventTimes(start: string, end: string | undefined, tz: string, recurring: boolean): { start: When; end: When } {
	if (DATE.test(start)) {
		if (end !== undefined && !DATE.test(end)) throw new CalendarError("終日の予定の end は YYYY-MM-DD で指定してください。");
		const last = end ?? start;
		if (last < start) throw new CalendarError("end が start より前です。");
		// DTEND of an all-day event is the day after its last.
		return { start: { time: ICAL.Time.fromDateString(start) }, end: { time: ICAL.Time.fromDateString(addDays(last, 1)) } };
	}
	if (!DATE_TIME.test(start)) throw new CalendarError("start は YYYY-MM-DD（終日）か YYYY-MM-DDTHH:MM で指定してください。");
	if (end !== undefined && !DATE_TIME.test(end)) throw new CalendarError("時刻つきの予定の end は YYYY-MM-DDTHH:MM で指定してください。");
	const from = localToEpoch(start, tz);
	const to = end === undefined ? from + 3_600_000 : localToEpoch(end, tz);
	if (to <= from) throw new CalendarError("end が start より後になっていません。");
	const as = (ms: number) => (recurring ? zoned(ms, tz) : { time: utc(ms) });
	return { start: as(from), end: as(to) };
}

function dueTime(due: string, tz: string): ICAL.Time {
	if (DATE.test(due)) return ICAL.Time.fromDateString(due);
	if (DATE_TIME.test(due)) return utc(localToEpoch(due, tz));
	throw new CalendarError("due は YYYY-MM-DD か YYYY-MM-DDTHH:MM で指定してください。");
}

function parseRule(value: string): ICAL.Recur {
	let rule: ICAL.Recur;
	try {
		rule = ICAL.Recur.fromString(value.trim().replace(/^RRULE:/i, ""));
	} catch (error) {
		throw new CalendarError(`rrule を読めませんでした（${errorMessage(error)}）。例: FREQ=WEEKLY;BYDAY=MO`);
	}
	if (!rule.freq) throw new CalendarError("rrule に FREQ がありません。例: FREQ=WEEKLY;BYDAY=MO");
	if (rule.until && rule.count) throw new CalendarError("rrule の UNTIL と COUNT はどちらか一方だけにしてください。");
	return rule;
}

/**
 * UNTIL must be a date when the start is, and in UTC when the start has a zone. A day given for a timed event means up
 * to the end of that day. With a floating start it stays floating, as it must.
 */
function fitUntil(main: ICAL.Component, tz: string): void {
	const property = main.getFirstProperty("rrule");
	const rule = property?.getFirstValue();
	const start = main.getFirstPropertyValue("dtstart");
	if (property === null || !(rule instanceof ICAL.Recur) || !rule.until || !(start instanceof ICAL.Time)) return;
	const until = rule.until;
	if (start.isDate) rule.until = ICAL.Time.fromDateString(until.isDate ? plainDate(until) : dateOf(toEpoch(until, undefined, tz), tz));
	else if (start.zone?.tzid !== "UTC" && tzidOf(main, "dtstart") === undefined) return;
	else if (until.isDate) rule.until = utc(startOfDay(addDays(plainDate(until), 1), tz) - 1000);
	else rule.until = utc(toEpoch(until, undefined, tz));
	property.setValue(rule);
}

function calendarWith(component: ICAL.Component): ICAL.Component {
	const root = new ICAL.Component("vcalendar");
	root.addPropertyWithValue("version", "2.0");
	root.addPropertyWithValue("prodid", "-//agent//personal agent//JA");
	root.addSubcomponent(component);
	return root;
}

const TEN_YEARS = 10 * 366 * 86_400_000;

/** RFC 5545 asks for a VTIMEZONE for each TZID used. */
function addZone(root: ICAL.Component, main: ICAL.Component, tz: string): void {
	const uses = root
		.getAllSubcomponents("vevent")
		.some((component) => ["dtstart", "dtend", "recurrence-id", "exdate"].some((name) => component.getAllProperties(name).some((property) => tzidParam(property) === tz)));
	if (!uses || root.getAllSubcomponents("vtimezone").some((zone) => zone.getFirstPropertyValue("tzid") === tz)) return;
	const from = timeOf(main, "dtstart", tz) ?? 0;
	root.addSubcomponent(vtimezone(tz, from, from + TEN_YEARS));
}

/** What every write of an event ends with, so that the object stays valid whatever was changed. */
function finish(root: ICAL.Component, main: ICAL.Component, tz: string): string {
	fitUntil(main, tz);
	addZone(root, main, tz);
	return root.toString();
}

function summaryOf(value: string): string {
	const summary = value.replace(/\s+/g, " ").trim();
	if (summary === "") throw new CalendarError("summary が空です。");
	return summary;
}

export function buildEvent(uid: string, fields: EventFields, tz: string, now: number): string {
	const recurring = fields.rrule !== undefined && fields.rrule.trim() !== "";
	const times = eventTimes(fields.start, fields.end, tz, recurring);
	const event = new ICAL.Component("vevent");
	event.addPropertyWithValue("uid", uid);
	event.addPropertyWithValue("dtstamp", utc(now));
	event.addPropertyWithValue("created", utc(now));
	addTime(event, "dtstart", times.start);
	addTime(event, "dtend", times.end);
	if (recurring) event.addPropertyWithValue("rrule", parseRule(fields.rrule!));
	event.addPropertyWithValue("summary", summaryOf(fields.summary));
	setProperty(event, "location", fields.location?.trim());
	setProperty(event, "description", fields.description?.trim());
	return finish(calendarWith(event), event, tz);
}

export function buildTodo(uid: string, fields: TodoFields, tz: string, now: number): string {
	const todo = new ICAL.Component("vtodo");
	todo.addPropertyWithValue("uid", uid);
	todo.addPropertyWithValue("dtstamp", utc(now));
	todo.addPropertyWithValue("created", utc(now));
	todo.addPropertyWithValue("summary", summaryOf(fields.summary));
	todo.addPropertyWithValue("status", "NEEDS-ACTION");
	if (fields.due !== undefined) todo.addPropertyWithValue("due", dueTime(fields.due, tz));
	setProperty(todo, "description", fields.description?.trim());
	return calendarWith(todo).toString();
}

export type ItemChanges = {
	readonly summary?: string;
	readonly start?: string;
	readonly end?: string;
	readonly due?: string;
	readonly location?: string;
	readonly description?: string;
	/** An empty string ends the repeating. */
	readonly rrule?: string;
};

function touch(component: ICAL.Component, now: number): void {
	setProperty(component, "last-modified", utc(now));
	setProperty(component, "dtstamp", utc(now));
	const sequence = component.getFirstPropertyValue("sequence");
	setProperty(component, "sequence", (typeof sequence === "number" ? sequence : 0) + 1);
}

const FIELDS = ["summary", "location", "description"] as const;

function setField(component: ICAL.Component, name: (typeof FIELDS)[number], value: string): void {
	setProperty(component, name, name === "summary" ? summaryOf(value) : value.trim());
}

function setFields(component: ICAL.Component, changes: ItemChanges): void {
	for (const name of FIELDS) {
		const value = changes[name];
		if (value !== undefined) setField(component, name, value);
	}
}

function startAndLength(component: ICAL.Component, tz: string): { start: number; length: number; allDay: boolean } {
	const event = new ICAL.Event(component);
	const { start, end } = spanOf(component, event.startDate, event.endDate, tz);
	return { start, length: end - start, allDay: event.startDate.isDate };
}

function setTimes(component: ICAL.Component, changes: ItemChanges, tz: string, recurring: boolean): void {
	if (changes.start === undefined && changes.end === undefined) return;
	const old = startAndLength(component, tz);
	const start = changes.start ?? occurrenceKey(old.start, old.allDay, tz);
	let end = changes.end;
	// A new start without a new end moves the event: it keeps its length, when it stays timed or stays all-day.
	if (end === undefined && DATE.test(start) === old.allDay) {
		const endMs = keyToEpoch(start, tz) + old.length;
		end = occurrenceKey(old.allDay ? endMs - 1 : endMs, old.allDay, tz);
	}
	const times = eventTimes(start, end, tz, recurring);
	setTime(component, "dtstart", times.start);
	setTime(component, "dtend", times.end);
	component.removeAllProperties("duration");
}

/** A UTC start would make the rule repeat the UTC wall clock (see `eventTimes`). */
function rezone(main: ICAL.Component, tz: string): void {
	for (const name of ["dtstart", "dtend"]) {
		const value = main.getFirstPropertyValue(name);
		if (value instanceof ICAL.Time && !value.isDate && value.zone?.tzid === "UTC") setTime(main, name, zoned(toEpoch(value, undefined, tz), tz));
	}
}

function overrideAt(root: ICAL.Component, main: ICAL.Component, rid: number, tz: string): ICAL.Component | undefined {
	return overridesOf(root, main).find((component) => timeOf(component, "recurrence-id", tz) === rid);
}

function placeAt(component: ICAL.Component, main: ICAL.Component, rid: number, length: number, tz: string): void {
	setTime(component, "dtstart", timeAs(main, rid, tz));
	setTime(component, "dtend", timeAs(main, rid + length, tz));
	component.removeAllProperties("duration");
}

function overrideFor(root: ICAL.Component, main: ICAL.Component, rid: number, tz: string): ICAL.Component {
	const found = overrideAt(root, main, rid, tz);
	if (found !== undefined) return found;
	const override = new ICAL.Component(structuredClone(main.toJSON()));
	for (const name of ["rrule", "rdate", "exdate", "exrule"]) override.removeAllProperties(name);
	setTime(override, "recurrence-id", timeAs(main, rid, tz));
	placeAt(override, main, rid, startAndLength(main, tz).length, tz);
	root.addSubcomponent(override);
	return override;
}

function exdatesOf(main: ICAL.Component, tz: string): number[] {
	return main.getAllProperties("exdate").flatMap((property) => {
		const tzid = tzidParam(property);
		return property.getValues().flatMap((value) => (value instanceof ICAL.Time ? [toEpoch(value, tzid, tz)] : []));
	});
}

export type Applied = {
	readonly data: string;
	/** Occurrences changed or removed on their own that are no longer in the series after the change, and so are gone. */
	readonly dropped: number;
};

/** Edited in place so that everything else in the object, such as alarms, is kept. */
export function applyChanges(data: string, changes: ItemChanges, tz: string, now: number, target: Target = {}): Applied {
	const { root, main, kind } = readCalendar(data);
	if (kind === "todo") {
		if (changes.start !== undefined || changes.end !== undefined) throw new CalendarError("タスクに start / end はありません。期日は due で指定してください。");
		if (changes.rrule !== undefined) throw new CalendarError("タスクは繰り返せません。");
		setFields(main, changes);
		if (changes.due !== undefined) setProperty(main, "due", changes.due === "" ? undefined : dueTime(changes.due, tz));
		touch(main, now);
		return { data: root.toString(), dropped: 0 };
	}
	if (changes.due !== undefined) throw new CalendarError("予定に due はありません。日時は start / end で指定してください。");
	if (isRecurring(main)) {
		if (target.scope === undefined) throw new CalendarError(SCOPE_NEEDED);
		if (target.scope === "this") return { data: changeOne(root, main, changes, target.occurrence, tz, now), dropped: 0 };
	}
	return changeSeries(root, main, changes, tz, now);
}

function changeOne(root: ICAL.Component, main: ICAL.Component, changes: ItemChanges, occurrence: string | undefined, tz: string, now: number): string {
	if (changes.rrule !== undefined) throw new CalendarError("繰り返しの規則は scope: all で変えてください。");
	const override = overrideFor(root, main, findOccurrence(main, occurrence, tz), tz);
	setFields(override, changes);
	setTimes(override, changes, tz, true);
	touch(override, now);
	return finish(root, main, tz);
}

/**
 * An occurrence changed on its own follows the series in what it did not change on its own, and which occurrences were
 * changed or removed moves with the series' start. What then no longer falls on an occurrence is dropped.
 */
function changeSeries(root: ICAL.Component, main: ICAL.Component, changes: ItemChanges, tz: string, now: number): Applied {
	const overrides = overridesOf(root, main).map((component) => ({ component, rid: timeOf(component, "recurrence-id", tz) ?? Number.NaN, ...startAndLength(component, tz) }));
	const before = startAndLength(main, tz);
	const oldFields = Object.fromEntries(FIELDS.map((name) => [name, text(main, name)]));
	const exdates = exdatesOf(main, tz);

	setFields(main, changes);
	if (changes.rrule !== undefined) {
		main.removeAllProperties("rrule");
		if (changes.rrule.trim() === "") main.removeAllProperties("rdate");
		else main.addPropertyWithValue("rrule", parseRule(changes.rrule));
	}
	const recurring = isRecurring(main);
	setTimes(main, changes, tz, recurring);
	if (recurring) rezone(main, tz);
	const after = startAndLength(main, tz);

	const delta = localDateTime(before.start, tz).until(localDateTime(after.start, tz), { largestUnit: "days" });
	const shift = (ms: number) => localDateTime(ms, tz).add(delta).toZonedDateTime(tz).epochMilliseconds;

	main.removeAllProperties("exdate");
	const candidates = [...overrides.map((override) => shift(override.rid)), ...exdates.map(shift)];
	const valid = new Set<number>();
	if (recurring && before.allDay === after.allDay && candidates.length > 0) {
		const last = Math.max(...candidates);
		for (const { rid } of occurrencesOf(main, tz)) {
			if (rid > last) break;
			valid.add(rid);
		}
	}

	let dropped = 0;
	for (const override of overrides) {
		const rid = shift(override.rid);
		const { component } = override;
		if (!valid.has(rid)) {
			root.removeSubcomponent(component);
			dropped++;
			continue;
		}
		for (const name of FIELDS) {
			const value = changes[name];
			if (value !== undefined && text(component, name) === oldFields[name]) setField(component, name, value);
		}
		setTime(component, "recurrence-id", timeAs(main, rid, tz));
		if (override.start === override.rid) placeAt(component, main, rid, override.length === before.length ? after.length : override.length, tz);
		touch(component, now);
	}
	for (const exdate of exdates) {
		const rid = shift(exdate);
		if (valid.has(rid)) addTime(main, "exdate", timeAs(main, rid, tz));
		else dropped++;
	}
	touch(main, now);
	return { data: finish(root, main, tz), dropped };
}

/** What removing comes to: the whole item, nothing as it is gone already, or the item with one occurrence fewer. */
export type Removal = "whole" | "unchanged" | { readonly data: string };

export function removeFrom(data: string, tz: string, now: number, target: Target = {}): Removal {
	const { root, main, kind } = readCalendar(data);
	if (kind === "todo" || !isRecurring(main)) return "whole";
	if (target.scope === undefined) throw new CalendarError(SCOPE_NEEDED);
	if (target.scope === "all") return "whole";
	const allDay = startAndLength(main, tz).allDay;
	if (exdatesOf(main, tz).some((exdate) => occurrenceKey(exdate, allDay, tz) === target.occurrence)) return "unchanged";
	const rid = findOccurrence(main, target.occurrence, tz);
	const override = overrideAt(root, main, rid, tz);
	if (override !== undefined) root.removeSubcomponent(override);
	addTime(main, "exdate", timeAs(main, rid, tz));
	touch(main, now);
	return { data: finish(root, main, tz) };
}

export function completeTodo(data: string, now: number): string | undefined {
	const { root, main, kind } = readCalendar(data);
	if (kind !== "todo") throw new CalendarError("これは予定です。完了にできるのはタスクだけです。");
	if (text(main, "status")?.toUpperCase() === "COMPLETED") return undefined;
	setProperty(main, "status", "COMPLETED");
	setProperty(main, "completed", utc(now));
	setProperty(main, "percent-complete", 100);
	touch(main, now);
	return root.toString();
}

export function formatEvent(item: EventItem, tz: string): string {
	const first = dateOf(item.start, tz);
	let when: string;
	if (item.allDay) {
		const last = dateOf(Math.max(item.end - 1, item.start), tz);
		when = last === first ? `${formatDay(first)} 終日` : `${formatDay(first)}〜${formatDay(last)} 終日`;
	} else {
		const lastDay = dateOf(item.end, tz);
		const end = lastDay === first ? formatClock(item.end, tz) : `${formatDay(lastDay)} ${formatClock(item.end, tz)}`;
		when = item.end === item.start ? `${formatDay(first)} ${formatClock(item.start, tz)}` : `${formatDay(first)} ${formatClock(item.start, tz)}–${end}`;
	}
	const place = item.location === undefined ? "" : ` @${item.location}`;
	return `${when} ${item.summary}${place}${item.rule === undefined ? "" : `（繰り返し: ${item.rule}）`}`;
}

export function formatTodo(item: TodoItem, tz: string): string {
	if (item.due === undefined) return `${item.summary} 期日なし`;
	const time = item.due.at === undefined ? "" : ` ${formatClock(item.due.at, tz)}`;
	return `${item.summary} 期日 ${formatDay(item.due.date)}${time}`;
}

/** `src/caldav.ts` implements it; tests use one in memory. */
export interface CalDavBackend {
	events(calendar: string, from: number, to: number): Promise<RawObject[]>;
	todos(calendar: string): Promise<RawObject[]>;
	get(calendar: string, file: string): Promise<RawObject | undefined>;
	create(calendar: string, file: string, data: string): Promise<"created" | "exists">;
	/** Only if it still has `object.etag`. */
	update(object: RawObject): Promise<"updated" | "conflict">;
	/** Only if it still has `object.etag`. */
	remove(object: RawObject): Promise<"deleted" | "gone" | "conflict">;
}

type CalendarKind = "events" | "todos";
export type CalendarConfig = Readonly<Record<string, { readonly kind: CalendarKind; readonly description?: string }>>;

export class Calendars {
	readonly #backend: CalDavBackend;
	readonly calendars: CalendarConfig;
	readonly tz: string;

	constructor(backend: CalDavBackend, calendars: CalendarConfig, tz: string) {
		this.#backend = backend;
		this.calendars = calendars;
		this.tz = tz;
	}

	#names(kind: CalendarKind): string[] {
		return Object.entries(this.calendars).flatMap(([name, calendar]) => (calendar.kind === kind ? [name] : []));
	}

	#kindOf(calendar: string): CalendarKind {
		const found = this.calendars[calendar];
		if (found === undefined) throw new CalendarError(`カレンダー「${calendar}」はありません。使えるのは ${Object.keys(this.calendars).join("、")} です。`);
		return found.kind;
	}

	async events(from: number, to: number): Promise<EventItem[]> {
		const lists = await Promise.all(
			this.#names("events").map(async (calendar) =>
				(await this.#backend.events(calendar, from, to)).flatMap((raw) => parseEvents(raw, calendar, { from, to }, this.tz)),
			),
		);
		return lists.flat().sort((a, b) => a.start - b.start || a.summary.localeCompare(b.summary));
	}

	async todos(): Promise<TodoItem[]> {
		const lists = await Promise.all(
			this.#names("todos").map(async (calendar) =>
				(await this.#backend.todos(calendar)).flatMap((raw) => parseTodo(raw, calendar, this.tz) ?? []),
			),
		);
		return lists.flat().sort((a, b) => (a.due?.date ?? "9999").localeCompare(b.due?.date ?? "9999") || a.summary.localeCompare(b.summary));
	}

	/** The id is checked even when the object does not exist. */
	async #find(id: string): Promise<RawObject | undefined> {
		const { calendar, file } = splitId(id);
		this.#kindOf(calendar);
		return this.#backend.get(calendar, file);
	}

	async #object(id: string): Promise<RawObject> {
		const object = await this.#find(id);
		if (object === undefined) throw new CalendarError(`「${id}」が見つかりません。calendar_list で id を確かめてください。`);
		return object;
	}

	#target(id: string, scope: Scope | undefined): Target {
		return { occurrence: splitId(id).occurrence, scope };
	}

	async etag(id: string): Promise<string | undefined> {
		const object = await this.#find(id);
		return object === undefined ? undefined : normalizeEtag(object.etag);
	}

	/** For showing what a change would touch: with `scope: "this"`, the occurrence the id names. */
	async describe(id: string, scope?: Scope): Promise<string> {
		return this.#describe(await this.#object(id), id, scope);
	}

	#describe(object: RawObject, id: string, scope: Scope | undefined): string {
		const { item: itemId, calendar, occurrence } = splitId(id);
		if (this.#kindOf(calendar) === "todos") {
			const todo = parseTodo(object, calendar, this.tz);
			if (todo !== undefined) return formatTodo(todo, this.tz);
		}
		const { root, main, kind } = readCalendar(object.data);
		const summary = text(main, "summary") ?? "（無題）";
		if (kind === "todo") return summary;
		const base = baseOf(main, itemId, calendar);
		const format = (found: Occurrence, as: Base) => formatEvent(eventItem(found, spanOf(found.component, found.start, found.end, this.tz), as, false, this.tz), this.tz);
		const whole = format(occurrencesOf(main, this.tz).next().value!, base);
		if (!isRecurring(main) || scope === undefined) return whole;
		if (scope === "all" || occurrence === undefined) return `${whole}（全ての回）`;
		const found = occurrenceAt(main, occurrence, this.tz, overridesOf(root, main));
		return found === undefined ? `${summary} ${occurrence}（この回だけ。もう無い回）` : `${format(found, { ...base, rule: undefined })}（この回だけ）`;
	}

	/** Checked against the item as it is now, so that a change the model got wrong is refused before the user is asked. */
	async preview(id: string, changes: ItemChanges, scope?: Scope): Promise<{ readonly what: string; readonly dropped: number }> {
		const object = await this.#object(id);
		const { dropped } = applyChanges(object.data, changes, this.tz, 0, this.#target(id, scope));
		return { what: this.#describe(object, id, scope), dropped };
	}

	/** As `preview`, for a removal. */
	async removal(id: string, scope?: Scope): Promise<string> {
		const object = await this.#object(id);
		removeFrom(object.data, this.tz, 0, this.#target(id, scope));
		return this.#describe(object, id, scope);
	}

	/** Repeating the call with the same UID stores nothing new, so a caller that remembers its UID may retry. */
	async create(calendar: string, uid: string, fields: EventFields | TodoFields, now: number): Promise<string> {
		const kind = this.#kindOf(calendar);
		const data = kind === "todos" ? buildTodo(uid, fields as TodoFields, this.tz, now) : buildEvent(uid, fields as EventFields, this.tz, now);
		const file = `${uid}.ics`;
		await this.#backend.create(calendar, file, data);
		return `${calendar}/${file}`;
	}

	async update(id: string, changes: ItemChanges, now: number, scope?: Scope): Promise<void> {
		await this.#retryOnConflict(async () => {
			const object = await this.#object(id);
			return this.#backend.update({ ...object, data: applyChanges(object.data, changes, this.tz, now, this.#target(id, scope)).data });
		});
	}

	/** Says whether the whole item is gone, or only an occurrence of it. */
	async remove(id: string, now: number, scope?: Scope): Promise<"gone" | "kept"> {
		let left: "gone" | "kept" = "gone";
		await this.#retryOnConflict(async () => {
			const object = await this.#find(id);
			if (object === undefined) return "done";
			const removal = removeFrom(object.data, this.tz, now, this.#target(id, scope));
			if (removal === "whole") return this.#backend.remove(object);
			left = "kept";
			return removal === "unchanged" ? "done" : this.#backend.update({ ...object, data: removal.data });
		});
		return left;
	}

	async complete(id: string, now: number): Promise<void> {
		await this.#retryOnConflict(async () => {
			const object = await this.#object(id);
			const data = completeTodo(object.data, now);
			return data === undefined ? "done" : this.#backend.update({ ...object, data });
		});
	}

	/** A second lost race is the model's to sort out. */
	async #retryOnConflict(attempt: () => Promise<string>): Promise<void> {
		if ((await attempt()) !== "conflict") return;
		if ((await attempt()) !== "conflict") return;
		throw new CalendarError("別の端末が同時にこの項目を変更しました。calendar_list で確かめてからやり直してください。");
	}
}
