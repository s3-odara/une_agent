import ICAL from "ical.js";
import { addDays, dateOf, formatClock, formatDay, isTimeZone, localToEpoch, startOfDay } from "./time.ts";

/** One stored calendar object: an `.ics` resource with the ETag the server gave it. */
export type RawObject = { readonly url: string; readonly etag?: string; readonly data: string };

type ItemBase = {
	/** `<calendar name>/<file name>`: what the tools take to name an item. */
	readonly id: string;
	readonly calendar: string;
	readonly uid: string;
	readonly summary: string;
	readonly description?: string;
	readonly etag?: string;
	/** When the object was last written, as far as it says (LAST-MODIFIED, DTSTAMP, CREATED), epoch ms. */
	readonly modified?: number;
};

/** One occurrence of an event. A recurring event gives one item per occurrence, all with the same `id`. */
export type EventItem = ItemBase & {
	readonly kind: "event";
	readonly allDay: boolean;
	/** Epoch ms. An all-day event runs from the start of its first day to the start of the day after its last. */
	readonly start: number;
	readonly end: number;
	readonly location?: string;
	readonly recurring: boolean;
};

export type TodoItem = ItemBase & {
	readonly kind: "todo";
	readonly done: boolean;
	/** The due date, and the due instant when the task has a time of day. */
	readonly due?: { readonly date: string; readonly at?: number };
};

export type CalItem = EventItem | TodoItem;

/** Times as the tools take them: `YYYY-MM-DD` for a whole day, `YYYY-MM-DDTHH:MM` for a time in the agent's zone. */
export type EventFields = {
	readonly summary: string;
	readonly start: string;
	/** Timed: the end time, default one hour after the start. All-day: the last day, default the first. */
	readonly end?: string;
	readonly location?: string;
	readonly description?: string;
};

export type TodoFields = { readonly summary: string; readonly due?: string; readonly description?: string };

/** A refused request. Its message is written for the model. */
export class CalendarError extends Error {}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

/** An ETag without its quotes and weakness marker, so one read from a header equals one read from a report. */
export function normalizeEtag(etag: string | undefined): string {
	return (etag ?? "").replace(/^W\//, "").replace(/^"|"$/g, "");
}

function idOf(calendar: string, url: string): string {
	const file = url.replace(/\/+$/, "").split("/").pop() ?? "";
	return `${calendar}/${decodeURIComponent(file)}`;
}

export function splitId(id: string): { calendar: string; file: string } {
	const slash = id.indexOf("/");
	if (slash <= 0 || slash === id.length - 1) throw new CalendarError(`id「${id}」の形が違います。calendar_list が返した id をそのまま使ってください。`);
	return { calendar: id.slice(0, slash), file: id.slice(slash + 1) };
}

function tzidOf(component: ICAL.Component, name: string): string | undefined {
	const tzid = component.getFirstProperty(name)?.getParameter("tzid");
	return typeof tzid === "string" ? tzid : undefined;
}

function plainDate(time: ICAL.Time): string {
	return `${String(time.year).padStart(4, "0")}-${String(time.month).padStart(2, "0")}-${String(time.day).padStart(2, "0")}`;
}

/**
 * An iCalendar time as an instant. The TZID is taken as an IANA zone name, which is what current clients write; the
 * VTIMEZONE definitions in the file are not consulted. A floating time, or one whose TZID is not a zone this runtime
 * knows, is read in the agent's own zone.
 */
function toEpoch(time: ICAL.Time, tzid: string | undefined, tz: string): number {
	if (time.isDate) return startOfDay(plainDate(time), tz);
	if (time.zone?.tzid === "UTC") return Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
	const zone = tzid !== undefined && isTimeZone(tzid) ? tzid : tz;
	return Temporal.PlainDateTime.from({
		year: time.year,
		month: time.month,
		day: time.day,
		hour: time.hour,
		minute: time.minute,
		second: time.second,
	}).toZonedDateTime(zone).epochMilliseconds;
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

function parse(raw: RawObject): ICAL.Component | undefined {
	try {
		return new ICAL.Component(ICAL.parse(raw.data));
	} catch {
		// One unreadable object must not hide the rest of the calendar.
		return undefined;
	}
}

/** Occurrences a recurring event is expanded to at most, counted from its first: about 27 years of a daily event. */
const MAX_OCCURRENCES = 10_000;

/** The occurrences of the object's event that overlap `[from, to)`. */
export function parseEvents(raw: RawObject, calendar: string, range: { from: number; to: number }, tz: string): EventItem[] {
	const root = parse(raw);
	if (root === undefined) return [];
	const components = root.getAllSubcomponents("vevent");
	const main = components.find((component) => !component.hasProperty("recurrence-id"));
	if (main === undefined) return [];

	const event = new ICAL.Event(main, { exceptions: components.filter((component) => component !== main), strictExceptions: false });
	const base = { id: idOf(calendar, raw.url), calendar, etag: raw.etag, modified: modifiedOf(main, tz) };
	const items: EventItem[] = [];

	const add = (item: ICAL.Event, startDate: ICAL.Time, endDate: ICAL.Time) => {
		const component = item.component;
		if (text(component, "status")?.toUpperCase() === "CANCELLED") return;
		const start = toEpoch(startDate, tzidOf(component, "dtstart"), tz);
		const end = Math.max(toEpoch(endDate, tzidOf(component, "dtend") ?? tzidOf(component, "dtstart"), tz), start);
		// An event without length still counts at its start.
		if (start >= range.to || Math.max(end, start + 1) <= range.from) return;
		items.push({
			...base,
			kind: "event",
			uid: item.uid ?? event.uid ?? "",
			summary: text(component, "summary") ?? "（無題）",
			description: text(component, "description"),
			location: text(component, "location"),
			allDay: startDate.isDate,
			start,
			end,
			recurring: event.isRecurring(),
		});
	};

	if (!event.isRecurring()) {
		add(event, event.startDate, event.endDate);
		return items;
	}
	const iterator = event.iterator();
	for (let count = 0; count < MAX_OCCURRENCES; count++) {
		const next = iterator.next();
		if (!next) break;
		const occurrence = event.getOccurrenceDetails(next);
		if (toEpoch(occurrence.startDate, tzidOf(occurrence.item.component, "dtstart"), tz) >= range.to) break;
		add(occurrence.item, occurrence.startDate, occurrence.endDate);
	}
	return items;
}

/** The object's task, if it holds one. A recurring task is read as its first occurrence only. */
export function parseTodo(raw: RawObject, calendar: string, tz: string): TodoItem | undefined {
	const todo = parse(raw)?.getAllSubcomponents("vtodo").find((component) => !component.hasProperty("recurrence-id"));
	if (todo === undefined) return undefined;
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

function setProperty(component: ICAL.Component, name: string, value: ICAL.Time | string | number | undefined): void {
	// Removed first: an old property may carry parameters, such as a TZID, that no longer fit the new value.
	component.removeAllProperties(name);
	if (value !== undefined && value !== "") component.addPropertyWithValue(name, value);
}

/** Start and end of an event as iCalendar values. Timed values are written in UTC, which every client reads the same. */
function eventTimes(start: string, end: string | undefined, tz: string): { start: ICAL.Time; end: ICAL.Time } {
	if (DATE.test(start)) {
		if (end !== undefined && !DATE.test(end)) throw new CalendarError("終日の予定の end は YYYY-MM-DD で指定してください。");
		const last = end ?? start;
		if (last < start) throw new CalendarError("end が start より前です。");
		// DTEND of an all-day event is the day after its last.
		return { start: ICAL.Time.fromDateString(start), end: ICAL.Time.fromDateString(addDays(last, 1)) };
	}
	if (!DATE_TIME.test(start)) throw new CalendarError("start は YYYY-MM-DD（終日）か YYYY-MM-DDTHH:MM で指定してください。");
	if (end !== undefined && !DATE_TIME.test(end)) throw new CalendarError("時刻つきの予定の end は YYYY-MM-DDTHH:MM で指定してください。");
	const from = localToEpoch(start, tz);
	const to = end === undefined ? from + 3_600_000 : localToEpoch(end, tz);
	if (to <= from) throw new CalendarError("end が start より後になっていません。");
	return { start: utc(from), end: utc(to) };
}

function dueTime(due: string, tz: string): ICAL.Time {
	if (DATE.test(due)) return ICAL.Time.fromDateString(due);
	if (DATE_TIME.test(due)) return utc(localToEpoch(due, tz));
	throw new CalendarError("due は YYYY-MM-DD か YYYY-MM-DDTHH:MM で指定してください。");
}

function calendarWith(component: ICAL.Component): string {
	const root = new ICAL.Component("vcalendar");
	root.addPropertyWithValue("version", "2.0");
	root.addPropertyWithValue("prodid", "-//agent//personal agent//JA");
	root.addSubcomponent(component);
	return root.toString();
}

function summaryOf(value: string): string {
	const summary = value.replace(/\s+/g, " ").trim();
	if (summary === "") throw new CalendarError("summary が空です。");
	return summary;
}

export function buildEvent(uid: string, fields: EventFields, tz: string, now: number): string {
	const times = eventTimes(fields.start, fields.end, tz);
	const event = new ICAL.Component("vevent");
	event.addPropertyWithValue("uid", uid);
	event.addPropertyWithValue("dtstamp", utc(now));
	event.addPropertyWithValue("created", utc(now));
	event.addPropertyWithValue("dtstart", times.start);
	event.addPropertyWithValue("dtend", times.end);
	event.addPropertyWithValue("summary", summaryOf(fields.summary));
	setProperty(event, "location", fields.location?.trim());
	setProperty(event, "description", fields.description?.trim());
	return calendarWith(event);
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
	return calendarWith(todo);
}

/** Fields to change; an absent one stays, and an empty `location`, `description` or `due` removes it. */
export type ItemChanges = {
	readonly summary?: string;
	readonly start?: string;
	readonly end?: string;
	readonly due?: string;
	readonly location?: string;
	readonly description?: string;
};

function mainComponent(data: string): { root: ICAL.Component; main: ICAL.Component; kind: "event" | "todo" } {
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

function touch(component: ICAL.Component, now: number): void {
	setProperty(component, "last-modified", utc(now));
	setProperty(component, "dtstamp", utc(now));
	const sequence = component.getFirstPropertyValue("sequence");
	setProperty(component, "sequence", (typeof sequence === "number" ? sequence : 0) + 1);
}

/** The object with the changes applied to its event or task; everything else in it, such as alarms, is kept. */
export function applyChanges(data: string, changes: ItemChanges, tz: string, now: number): string {
	const { root, main, kind } = mainComponent(data);
	if (changes.summary !== undefined) setProperty(main, "summary", summaryOf(changes.summary));
	if (changes.location !== undefined) setProperty(main, "location", changes.location.trim());
	if (changes.description !== undefined) setProperty(main, "description", changes.description.trim());

	if (kind === "todo") {
		if (changes.start !== undefined || changes.end !== undefined) throw new CalendarError("タスクに start / end はありません。期日は due で指定してください。");
		if (changes.due !== undefined) setProperty(main, "due", changes.due === "" ? undefined : dueTime(changes.due, tz));
	} else {
		if (changes.due !== undefined) throw new CalendarError("予定に due はありません。日時は start / end で指定してください。");
		if (changes.start !== undefined || changes.end !== undefined) {
			const event = new ICAL.Event(main);
			const allDay = event.startDate.isDate;
			const oldStart = toEpoch(event.startDate, tzidOf(main, "dtstart"), tz);
			const oldEnd = toEpoch(event.endDate, tzidOf(main, "dtend") ?? tzidOf(main, "dtstart"), tz);
			const local = (ms: number) => Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(tz).toPlainDateTime().toString({ smallestUnit: "minute" });
			const start = changes.start ?? (allDay ? dateOf(oldStart, tz) : local(oldStart));
			let end = changes.end;
			// A new start without a new end moves the event: it keeps its length, when it stays timed or stays all-day.
			if (end === undefined && DATE.test(start) === allDay) {
				const startMs = DATE.test(start) ? startOfDay(start, tz) : localToEpoch(start, tz);
				const endMs = startMs + (oldEnd - oldStart);
				end = allDay ? dateOf(endMs - 1, tz) : local(endMs);
			}
			const times = eventTimes(start, end, tz);
			setProperty(main, "dtstart", times.start);
			setProperty(main, "dtend", times.end);
			main.removeAllProperties("duration");
		}
	}
	touch(main, now);
	return root.toString();
}

/** The object with its task marked completed. `undefined` when it already is. */
export function completeTodo(data: string, now: number): string | undefined {
	const { root, main, kind } = mainComponent(data);
	if (kind !== "todo") throw new CalendarError("これは予定です。完了にできるのはタスクだけです。");
	if (text(main, "status")?.toUpperCase() === "COMPLETED") return undefined;
	setProperty(main, "status", "COMPLETED");
	setProperty(main, "completed", utc(now));
	setProperty(main, "percent-complete", 100);
	touch(main, now);
	return root.toString();
}

/** `11/17(火) 15:30–16:00 歯医者 @駅前` */
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
	return `${when} ${item.summary}${place}${item.recurring ? "（繰り返し）" : ""}`;
}

/** `レポート提出 期日 11/20(金) 15:00` */
export function formatTodo(item: TodoItem, tz: string): string {
	if (item.due === undefined) return `${item.summary} 期日なし`;
	const time = item.due.at === undefined ? "" : ` ${formatClock(item.due.at, tz)}`;
	return `${item.summary} 期日 ${formatDay(item.due.date)}${time}`;
}

/** What the agent needs from a CalDAV server. `src/caldav.ts` implements it; tests use one in memory. */
export interface CalDavBackend {
	/** The objects of a calendar holding events that overlap `[from, to)`. */
	events(calendar: string, from: number, to: number): Promise<RawObject[]>;
	/** The objects of a calendar holding tasks. */
	todos(calendar: string): Promise<RawObject[]>;
	get(calendar: string, file: string): Promise<RawObject | undefined>;
	/** Stores a new object. `exists` when one of that name is already there. */
	create(calendar: string, file: string, data: string): Promise<"created" | "exists">;
	/** Replaces an object, if it still has `object.etag`. */
	update(object: RawObject): Promise<"updated" | "conflict">;
	/** Deletes an object, if it still has `object.etag`. */
	remove(object: RawObject): Promise<"deleted" | "gone" | "conflict">;
}

type CalendarKind = "events" | "todos";
export type CalendarConfig = Readonly<Record<string, { readonly kind: CalendarKind; readonly description: string }>>;

/** The configured calendars as the agent uses them: typed items in, field changes out. */
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

	/** Event occurrences overlapping `[from, to)`, earliest first. */
	async events(from: number, to: number): Promise<EventItem[]> {
		const lists = await Promise.all(
			this.#names("events").map(async (calendar) =>
				(await this.#backend.events(calendar, from, to)).flatMap((raw) => parseEvents(raw, calendar, { from, to }, this.tz)),
			),
		);
		return lists.flat().sort((a, b) => a.start - b.start || a.summary.localeCompare(b.summary));
	}

	/** Every task, done or not, by due date; tasks without one come last. */
	async todos(): Promise<TodoItem[]> {
		const lists = await Promise.all(
			this.#names("todos").map(async (calendar) =>
				(await this.#backend.todos(calendar)).flatMap((raw) => parseTodo(raw, calendar, this.tz) ?? []),
			),
		);
		return lists.flat().sort((a, b) => (a.due?.date ?? "9999").localeCompare(b.due?.date ?? "9999") || a.summary.localeCompare(b.summary));
	}

	/** The stored object, or `undefined` when it does not exist; the id is checked either way. */
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

	/** The item's current ETag, normalized; `undefined` when it does not exist. */
	async etag(id: string): Promise<string | undefined> {
		const object = await this.#find(id);
		return object === undefined ? undefined : normalizeEtag(object.etag);
	}

	/** The item as it is now, for showing what a change would touch. */
	async describe(id: string): Promise<string> {
		const object = await this.#object(id);
		const { calendar } = splitId(id);
		if (this.#kindOf(calendar) === "todos") {
			const todo = parseTodo(object, calendar, this.tz);
			if (todo !== undefined) return formatTodo(todo, this.tz);
		}
		const { main, kind } = mainComponent(object.data);
		if (kind === "todo") return text(main, "summary") ?? "（無題）";
		const event = new ICAL.Event(main);
		const start = toEpoch(event.startDate, tzidOf(main, "dtstart"), this.tz);
		const end = toEpoch(event.endDate, tzidOf(main, "dtend") ?? tzidOf(main, "dtstart"), this.tz);
		const item: EventItem = {
			kind: "event",
			id,
			calendar,
			uid: event.uid ?? "",
			summary: text(main, "summary") ?? "（無題）",
			location: text(main, "location"),
			allDay: event.startDate.isDate,
			start,
			end,
			recurring: event.isRecurring(),
		};
		return formatEvent(item, this.tz);
	}

	/**
	 * Creates an event or a task under a caller-chosen UID. Repeating the call with the same UID stores nothing new, so
	 * a caller that remembers its UID may retry.
	 */
	async create(calendar: string, uid: string, fields: EventFields | TodoFields, now: number): Promise<string> {
		const kind = this.#kindOf(calendar);
		const data = kind === "todos" ? buildTodo(uid, fields as TodoFields, this.tz, now) : buildEvent(uid, fields as EventFields, this.tz, now);
		const file = `${uid}.ics`;
		await this.#backend.create(calendar, file, data);
		return `${calendar}/${file}`;
	}

	/** Applies changes to the item as it is now. A write that loses a race with another client is retried once. */
	async update(id: string, changes: ItemChanges, now: number): Promise<void> {
		await this.#retryOnConflict(async () => {
			const object = await this.#object(id);
			return this.#backend.update({ ...object, data: applyChanges(object.data, changes, this.tz, now) });
		});
	}

	/** Deletes the item. Succeeds when it is already gone. */
	async remove(id: string): Promise<void> {
		await this.#retryOnConflict(async () => {
			const object = await this.#find(id);
			return object === undefined ? "done" : this.#backend.remove(object);
		});
	}

	/** Marks a task completed. Succeeds when it already is. */
	async complete(id: string, now: number): Promise<void> {
		await this.#retryOnConflict(async () => {
			const object = await this.#object(id);
			const data = completeTodo(object.data, now);
			return data === undefined ? "done" : this.#backend.update({ ...object, data });
		});
	}

	/** Reads and writes again when the write lost a race with another client; a second loss is the model's to sort out. */
	async #retryOnConflict(attempt: () => Promise<string>): Promise<void> {
		if ((await attempt()) !== "conflict") return;
		if ((await attempt()) !== "conflict") return;
		throw new CalendarError("別の端末が同時にこの項目を変更しました。calendar_list で確かめてからやり直してください。");
	}
}
