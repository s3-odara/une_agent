import assert from "node:assert/strict";
import { test } from "node:test";
import {
	applyChanges,
	buildEvent,
	buildTodo,
	CalendarError,
	Calendars,
	type EventItem,
	formatEvent,
	formatTodo,
	parseEvents,
	parseTodo,
	type RawObject,
} from "../src/calendar.ts";
import { localToEpoch } from "../src/time.ts";
import { ics, MemoryCalDav } from "./fakes.ts";

const tz = "Asia/Tokyo";
const at = (local: string) => localToEpoch(local, tz);
const raw = (data: string, file = "x.ics"): RawObject => ({ url: `https://dav.example.org/cal/Home/${file}`, etag: '"1"', data });
const week = { from: at("2026-11-16T00:00"), to: at("2026-11-23T00:00") };
const NOW = at("2026-11-17T09:00");

const eventOf = (...lines: string[]) => parseEvents(raw(ics("BEGIN:VEVENT", "UID:1", "SUMMARY:歯医者", ...lines, "END:VEVENT")), "Home", week, tz)[0];
const taskOf = (...lines: string[]) => parseTodo(raw(ics("BEGIN:VTODO", "UID:t", "SUMMARY:レポート提出", ...lines, "END:VTODO")), "ToDo", tz);

for (const [form, when] of [
	["in UTC", "DTSTART:20261117T063000Z"],
	["in a zone of its own", "DTSTART;TZID=America/New_York:20261117T013000"],
	["with no zone (floating), in the user's zone", "DTSTART:20261117T153000"],
	["with a zone name that is not one (as Outlook writes), in the user's zone", "DTSTART;TZID=Tokyo Standard Time:20261117T153000"],
] as const) {
	test(`a start time ${form} is read as the instant it means`, () => {
		assert.equal(eventOf(when, "DURATION:PT30M")?.start, at("2026-11-17T15:30"));
	});
}

test("an all-day event spans whole days in the user's zone", () => {
	const allDay = eventOf("DTSTART;VALUE=DATE:20261117", "DTEND;VALUE=DATE:20261119");
	assert.equal(allDay?.allDay, true);
	assert.equal(allDay?.start, at("2026-11-17T00:00"));
	assert.equal(allDay?.end, at("2026-11-19T00:00"));
});

test("an event's id is its calendar and file", () => {
	assert.equal(eventOf("DTSTART:20261117T063000Z")?.id, "Home/x.ics");
});

for (const [what, range, count] of [
	["a range that starts as the event ends leaves it out", { from: at("2026-11-17T16:00"), to: at("2026-11-18T00:00") }, 0],
	["a range that starts a minute before the end has it", { from: at("2026-11-17T15:59"), to: at("2026-11-18T00:00") }, 1],
	["a range that ends as the event starts leaves it out", { from: at("2026-11-17T00:00"), to: at("2026-11-17T15:30") }, 0],
] as const) {
	test(`only what overlaps the range is returned: ${what}`, () => {
		const data = ics("BEGIN:VEVENT", "UID:1", "SUMMARY:x", "DTSTART:20261117T063000Z", "DTEND:20261117T070000Z", "END:VEVENT");
		assert.equal(parseEvents(raw(data), "Home", range, tz).length, count);
	});
}

test("a file that is not a calendar gives no events instead of failing", () => {
	assert.deepEqual(parseEvents(raw("not a calendar"), "Home", week, tz), []);
});

/** `exception` is an occurrence changed on its own. */
const daily = (rule: string[] = [], exception: string[] = []) => {
	const data = ics(
		"BEGIN:VEVENT",
		"UID:r",
		"SUMMARY:ゴミ捨て",
		"DTSTART;TZID=Asia/Tokyo:20261101T080000",
		"DTEND;TZID=Asia/Tokyo:20261101T081500",
		"RRULE:FREQ=DAILY",
		...rule,
		"END:VEVENT",
		...exception,
	);
	return parseEvents(raw(data), "Home", { from: at("2026-11-16T00:00"), to: at("2026-11-21T00:00") }, tz).map((item) => [item.summary, item.start] as const);
};

test("a recurring event is expanded into its occurrences in the range", () => {
	assert.deepEqual(
		daily(),
		["16", "17", "18", "19", "20"].map((day) => ["ゴミ捨て", at(`2026-11-${day}T08:00`)]),
	);
});

test("an occurrence moved on its own is read where it was moved to, as it was changed", () => {
	const occurrences = daily(
		[],
		["BEGIN:VEVENT", "UID:r", "RECURRENCE-ID;TZID=Asia/Tokyo:20261118T080000", "SUMMARY:ゴミ捨て（夜）", "DTSTART;TZID=Asia/Tokyo:20261118T200000", "DTEND;TZID=Asia/Tokyo:20261118T201500", "END:VEVENT"],
	);
	assert.ok(occurrences.some(([summary, start]) => summary === "ゴミ捨て（夜）" && start === at("2026-11-18T20:00")));
	assert.ok(!occurrences.some(([, start]) => start === at("2026-11-18T08:00")));
});

test("an occurrence cancelled on its own is left out", () => {
	const occurrences = daily(
		[],
		["BEGIN:VEVENT", "UID:r", "RECURRENCE-ID;TZID=Asia/Tokyo:20261119T080000", "STATUS:CANCELLED", "SUMMARY:ゴミ捨て", "DTSTART;TZID=Asia/Tokyo:20261119T080000", "DTEND;TZID=Asia/Tokyo:20261119T081500", "END:VEVENT"],
	);
	assert.ok(!occurrences.some(([, start]) => start === at("2026-11-19T08:00")));
});

test("a task's due date is read as a date", () => {
	assert.deepEqual(taskOf("DUE;VALUE=DATE:20261120")?.due, { date: "2026-11-20" });
	assert.equal(taskOf()?.due, undefined);
});

test("a task due at a time is due on the user's date of that time", () => {
	// 15:00 UTC on the 19th is already the 20th in Tokyo.
	assert.deepEqual(taskOf("DUE:20261119T150000Z")?.due, { date: "2026-11-20", at: at("2026-11-20T00:00") });
});

for (const [how, line] of [
	["a COMPLETED status", "STATUS:COMPLETED"],
	["a completion time", "COMPLETED:20261117T010000Z"],
] as const) {
	test(`a task with ${how} is done`, () => {
		assert.equal(taskOf(line)?.done, true);
	});
}

test("a task without either is open", () => {
	assert.equal(taskOf("STATUS:NEEDS-ACTION")?.done, false);
});

test("when an item was last written is read from its stamps", () => {
	assert.equal(taskOf("DTSTAMP:20261116T010000Z", "LAST-MODIFIED:20261117T010000Z")?.modified, Date.UTC(2026, 10, 17, 1));
});

test("an event is shown with its day, times, title and place", () => {
	const item: EventItem = { kind: "event", id: "", calendar: "", uid: "", summary: "歯医者", location: "駅前", allDay: false, recurring: false, start: at("2026-11-17T15:30"), end: at("2026-11-17T16:30") };
	assert.equal(formatEvent(item, tz), "11/17(火) 15:30–16:30 歯医者 @駅前");
});

test("an all-day event over several days is shown as the range of its days", () => {
	const item: EventItem = { kind: "event", id: "", calendar: "", uid: "", summary: "旅行", allDay: true, recurring: false, start: at("2026-11-20T00:00"), end: at("2026-11-23T00:00") };
	assert.equal(formatEvent(item, tz), "11/20(金)〜11/22(日) 終日 旅行");
});

test("a recurring event is shown as one", () => {
	const item: EventItem = { kind: "event", id: "", calendar: "", uid: "", summary: "ゴミ捨て", allDay: false, recurring: true, start: at("2026-11-17T08:00"), end: at("2026-11-17T08:15") };
	assert.match(formatEvent(item, tz), /繰り返し/);
});

test("a task is shown with its due date, and its time when it has one", () => {
	assert.equal(formatTodo(taskOf("DUE;VALUE=DATE:20261120")!, tz), "レポート提出 期日 11/20(金)");
	assert.equal(formatTodo(taskOf("DUE;TZID=Asia/Tokyo:20261120T170000")!, tz), "レポート提出 期日 11/20(金) 17:00");
});

test("a built event reads back as asked, an hour long when no end is given, without the spaces around its title", () => {
	const event = parseEvents(raw(buildEvent("u1", { summary: " 歯医者 ", start: "2026-11-17T15:30", location: "駅前" }, tz, NOW)), "Home", week, tz)[0];
	assert.deepEqual(
		[event?.uid, event?.summary, event?.location, event?.start, event?.end],
		["u1", "歯医者", "駅前", at("2026-11-17T15:30"), at("2026-11-17T16:30")],
	);
});

test("a built all-day event covers its last day", () => {
	const event = parseEvents(raw(buildEvent("u2", { summary: "旅行", start: "2026-11-20", end: "2026-11-22" }, tz, NOW)), "Home", week, tz)[0];
	assert.deepEqual([event?.allDay, event?.start, event?.end], [true, at("2026-11-20T00:00"), at("2026-11-23T00:00")]);
});

test("a built task reads back with its due date and time", () => {
	const todo = parseTodo(raw(buildTodo("u3", { summary: "レポート提出", due: "2026-11-20T17:00" }, tz, NOW)), "ToDo", tz);
	assert.deepEqual(todo?.due, { date: "2026-11-20", at: at("2026-11-20T17:00") });
});

for (const [what, fields] of [
	["an end before the start", { summary: "x", start: "2026-11-17T15:30", end: "2026-11-17T15:00" }],
	["a start that is not a date", { summary: "x", start: "tomorrow" }],
	["an empty title", { summary: " ", start: "2026-11-17" }],
] as const) {
	test(`an event with ${what} is refused`, () => {
		assert.throws(() => buildEvent("u", fields, tz, NOW), CalendarError);
	});
}

const DENTIST = ics(
	"BEGIN:VEVENT",
	"UID:1",
	"SUMMARY:歯医者",
	"LOCATION:駅前",
	"DTSTART;TZID=Asia/Tokyo:20261117T153000",
	"DTEND;TZID=Asia/Tokyo:20261117T161500",
	"BEGIN:VALARM",
	"ACTION:DISPLAY",
	"TRIGGER:-PT30M",
	"END:VALARM",
	"END:VEVENT",
);
const readBack = (data: string) => parseEvents(raw(data), "Home", week, tz)[0]!;

test("moving an event's start keeps its length", () => {
	const moved = readBack(applyChanges(DENTIST, { start: "2026-11-18T10:00" }, tz, NOW));
	assert.deepEqual([moved.start, moved.end], [at("2026-11-18T10:00"), at("2026-11-18T10:45")]);
});

test("a change keeps what it does not touch, the alarm too", () => {
	const changed = applyChanges(DENTIST, { summary: "歯科検診" }, tz, NOW);
	assert.deepEqual([readBack(changed).summary, readBack(changed).location, readBack(changed).start], ["歯科検診", "駅前", at("2026-11-17T15:30")]);
	assert.match(changed, /BEGIN:VALARM/);
});

test("a change is marked as a new version, so other clients take it", () => {
	assert.match(applyChanges(DENTIST, { summary: "歯科検診" }, tz, NOW), /^SEQUENCE:1\r?$/m);
});

test("a field changed to nothing is removed", () => {
	assert.equal(readBack(applyChanges(DENTIST, { location: "" }, tz, NOW)).location, undefined);
});

test("a due date for an event is refused", () => {
	assert.throws(() => applyChanges(DENTIST, { due: "2026-11-20" }, tz, NOW), CalendarError);
});

function store() {
	const backend = new MemoryCalDav();
	return { backend, calendars: new Calendars(backend, { Home: { kind: "events", description: "" }, ToDo: { kind: "todos", description: "" } }, tz) };
}

test("creating again under the same UID, as a rerun after a crash does, stores nothing new", async () => {
	const { backend, calendars } = store();
	await calendars.create("Home", "u1", { summary: "歯医者", start: "2026-11-17T15:30" }, NOW);
	await calendars.create("Home", "u1", { summary: "歯医者", start: "2026-11-17T15:30" }, NOW);
	assert.equal(backend.files("Home").length, 1);
});

test("the same change applied twice ends as it did once", async () => {
	const { calendars } = store();
	const id = await calendars.create("Home", "u1", { summary: "歯医者", start: "2026-11-17T15:30" }, NOW);
	await calendars.update(id, { start: "2026-11-17T16:00" }, NOW);
	await calendars.update(id, { start: "2026-11-17T16:00" }, NOW);
	assert.deepEqual(
		(await calendars.events(week.from, week.to)).map((event) => [event.start, event.end]),
		[[at("2026-11-17T16:00"), at("2026-11-17T17:00")]],
	);
});

test("completing and removing succeed when they were done already", async () => {
	const { backend, calendars } = store();
	const task = await calendars.create("ToDo", "u2", { summary: "レポート提出", due: "2026-11-20" }, NOW);
	await calendars.complete(task, NOW);
	await calendars.complete(task, NOW);
	assert.equal((await calendars.todos())[0]?.done, true);

	const id = await calendars.create("Home", "u1", { summary: "歯医者", start: "2026-11-17T15:30" }, NOW);
	await calendars.remove(id);
	await calendars.remove(id);
	assert.deepEqual(backend.files("Home"), []);
});

test("an item that does not exist, or a calendar that is not configured, is refused", async () => {
	const { calendars } = store();
	await assert.rejects(calendars.update("Home/nope.ics", { summary: "x" }, NOW), CalendarError);
	await assert.rejects(calendars.create("Work", "u3", { summary: "x", start: "2026-11-17" }, NOW), CalendarError);
});
