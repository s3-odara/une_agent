import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
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
	removeFrom,
} from "../src/calendar.ts";
import { addDays, localMinute, localToEpoch, startOfDay } from "../src/time.ts";
import { ics, MemoryCalDav } from "./fakes.ts";

const tz = "Asia/Tokyo";
const at = (local: string) => localToEpoch(local, tz);
const raw = (data: string, file = "x.ics"): RawObject => ({
	url: `https://dav.example.org/cal/Home/${file}`,
	etag: '"1"',
	data,
});
const week = { from: at("2026-11-16T00:00"), to: at("2026-11-23T00:00") };
const NOW = at("2026-11-17T09:00");

const eventOf = (...lines: string[]) =>
	parseEvents(raw(ics("BEGIN:VEVENT", "UID:1", "SUMMARY:歯医者", ...lines, "END:VEVENT")), "Home", week, tz)[0];
const taskOf = (...lines: string[]) =>
	parseTodo(raw(ics("BEGIN:VTODO", "UID:t", "SUMMARY:レポート提出", ...lines, "END:VTODO")), "ToDo", tz);

for (const [form, when] of [
	["in UTC", "DTSTART:20261117T063000Z"],
	["in a zone of its own", "DTSTART;TZID=America/New_York:20261117T013000"],
	["with no zone (floating), in the user's zone", "DTSTART:20261117T153000"],
	[
		"with a zone name that is not one (as Outlook writes), in the user's zone",
		"DTSTART;TZID=Tokyo Standard Time:20261117T153000",
	],
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
	[
		"a range that starts as the event ends leaves it out",
		{ from: at("2026-11-17T16:00"), to: at("2026-11-18T00:00") },
		0,
	],
	[
		"a range that starts a minute before the end has it",
		{ from: at("2026-11-17T15:59"), to: at("2026-11-18T00:00") },
		1,
	],
	[
		"a range that ends as the event starts leaves it out",
		{ from: at("2026-11-17T00:00"), to: at("2026-11-17T15:30") },
		0,
	],
] as const) {
	test(`only what overlaps the range is returned: ${what}`, () => {
		const data = ics(
			"BEGIN:VEVENT",
			"UID:1",
			"SUMMARY:x",
			"DTSTART:20261117T063000Z",
			"DTEND:20261117T070000Z",
			"END:VEVENT",
		);
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
	return parseEvents(raw(data), "Home", { from: at("2026-11-16T00:00"), to: at("2026-11-21T00:00") }, tz).map(
		(item) => [item.summary, item.start] as const,
	);
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
		[
			"BEGIN:VEVENT",
			"UID:r",
			"RECURRENCE-ID;TZID=Asia/Tokyo:20261118T080000",
			"SUMMARY:ゴミ捨て（夜）",
			"DTSTART;TZID=Asia/Tokyo:20261118T200000",
			"DTEND;TZID=Asia/Tokyo:20261118T201500",
			"END:VEVENT",
		],
	);
	assert.ok(occurrences.some(([summary, start]) => summary === "ゴミ捨て（夜）" && start === at("2026-11-18T20:00")));
	assert.ok(!occurrences.some(([, start]) => start === at("2026-11-18T08:00")));
});

test("an occurrence cancelled on its own is left out", () => {
	const occurrences = daily(
		[],
		[
			"BEGIN:VEVENT",
			"UID:r",
			"RECURRENCE-ID;TZID=Asia/Tokyo:20261119T080000",
			"STATUS:CANCELLED",
			"SUMMARY:ゴミ捨て",
			"DTSTART;TZID=Asia/Tokyo:20261119T080000",
			"DTEND;TZID=Asia/Tokyo:20261119T081500",
			"END:VEVENT",
		],
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
	assert.equal(
		taskOf("DTSTAMP:20261116T010000Z", "LAST-MODIFIED:20261117T010000Z")?.modified,
		Date.UTC(2026, 10, 17, 1),
	);
});

test("an event is shown with its day, times, title and place", () => {
	const item: EventItem = {
		kind: "event",
		id: "",
		calendar: "",
		uid: "",
		summary: "歯医者",
		location: "駅前",
		allDay: false,
		start: at("2026-11-17T15:30"),
		end: at("2026-11-17T16:30"),
	};
	assert.equal(formatEvent(item, tz), "11/17(火) 15:30–16:30 歯医者 @駅前");
});

test("an all-day event over several days is shown as the range of its days", () => {
	const item: EventItem = {
		kind: "event",
		id: "",
		calendar: "",
		uid: "",
		summary: "旅行",
		allDay: true,
		start: at("2026-11-20T00:00"),
		end: at("2026-11-23T00:00"),
	};
	assert.equal(formatEvent(item, tz), "11/20(金)〜11/22(日) 終日 旅行");
});

test("a recurring event is shown as one, with its rule", () => {
	const item: EventItem = {
		kind: "event",
		id: "",
		calendar: "",
		uid: "",
		summary: "ゴミ捨て",
		allDay: false,
		rule: "FREQ=DAILY",
		start: at("2026-11-17T08:00"),
		end: at("2026-11-17T08:15"),
	};
	assert.match(formatEvent(item, tz), /繰り返し.*FREQ=DAILY/);
});

test("a task is shown with its due date, and its time when it has one", () => {
	assert.equal(formatTodo(taskOf("DUE;VALUE=DATE:20261120")!, tz), "レポート提出 期日 11/20(金)");
	assert.equal(formatTodo(taskOf("DUE;TZID=Asia/Tokyo:20261120T170000")!, tz), "レポート提出 期日 11/20(金) 17:00");
});

test("a built event reads back as asked, an hour long when no end is given, without the spaces around its title", () => {
	const event = parseEvents(
		raw(buildEvent("u1", { summary: " 歯医者 ", start: "2026-11-17T15:30", location: "駅前" }, tz, NOW)),
		"Home",
		week,
		tz,
	)[0];
	assert.deepEqual(
		[event?.uid, event?.summary, event?.location, event?.start, event?.end],
		["u1", "歯医者", "駅前", at("2026-11-17T15:30"), at("2026-11-17T16:30")],
	);
});

test("a built all-day event covers its last day", () => {
	const event = parseEvents(
		raw(buildEvent("u2", { summary: "旅行", start: "2026-11-20", end: "2026-11-22" }, tz, NOW)),
		"Home",
		week,
		tz,
	)[0];
	assert.deepEqual([event?.allDay, event?.start, event?.end], [true, at("2026-11-20T00:00"), at("2026-11-23T00:00")]);
});

test("a built task reads back with its due date and time", () => {
	const todo = parseTodo(
		raw(buildTodo("u3", { summary: "レポート提出", due: "2026-11-20T17:00" }, tz, NOW)),
		"ToDo",
		tz,
	);
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
	const moved = readBack(applyChanges(DENTIST, { start: "2026-11-18T10:00" }, tz, NOW).data);
	assert.deepEqual([moved.start, moved.end], [at("2026-11-18T10:00"), at("2026-11-18T10:45")]);
});

test("a change keeps what it does not touch, the alarm too", () => {
	const changed = applyChanges(DENTIST, { summary: "歯科検診" }, tz, NOW).data;
	assert.deepEqual(
		[readBack(changed).summary, readBack(changed).location, readBack(changed).start],
		["歯科検診", "駅前", at("2026-11-17T15:30")],
	);
	assert.match(changed, /BEGIN:VALARM/);
});

test("a change is marked as a new version, so other clients take it", () => {
	assert.match(applyChanges(DENTIST, { summary: "歯科検診" }, tz, NOW).data, /^SEQUENCE:1\r?$/m);
});

test("a field changed to nothing is removed", () => {
	assert.equal(readBack(applyChanges(DENTIST, { location: "" }, tz, NOW).data).location, undefined);
});

test("a due date for an event is refused", () => {
	assert.throws(() => applyChanges(DENTIST, { due: "2026-11-20" }, tz, NOW), CalendarError);
});

function store() {
	const backend = new MemoryCalDav();
	return {
		backend,
		calendars: new Calendars(
			backend,
			{ Home: { kind: "events", description: "" }, ToDo: { kind: "todos", description: "" } },
			tz,
		),
	};
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
	await calendars.remove(id, NOW);
	await calendars.remove(id, NOW);
	assert.deepEqual(backend.files("Home"), []);
});

test("an item that does not exist, or a calendar that is not configured, is refused", async () => {
	const { calendars } = store();
	await assert.rejects(calendars.update("Home/nope.ics", { summary: "x" }, NOW), CalendarError);
	await assert.rejects(calendars.create("Work", "u3", { summary: "x", start: "2026-11-17" }, NOW), CalendarError);
});

/** Mondays at 08:00, four of them in `month`. */
const WEEKLY = buildEvent(
	"w",
	{ summary: "朝会", start: "2026-11-16T08:00", end: "2026-11-16T08:30", rrule: "FREQ=WEEKLY;BYDAY=MO" },
	tz,
	NOW,
);
const month = { from: at("2026-11-16T00:00"), to: at("2026-12-14T00:00") };
const occurrences = (data: string) =>
	parseEvents(raw(data), "Home", month, tz).map((event) => `${localMinute(event.start, tz)} ${event.summary}`);
const thisOne = (occurrence: string) => ({ scope: "this" as const, occurrence });
const all = { scope: "all" as const };

test("a weekly event made at an early hour falls on the weekday asked for, not on the day before as in UTC", () => {
	assert.deepEqual(occurrences(WEEKLY), [
		"2026-11-16T08:00 朝会",
		"2026-11-23T08:00 朝会",
		"2026-11-30T08:00 朝会",
		"2026-12-07T08:00 朝会",
	]);
});

test("each occurrence is listed under when it falls, and an all-day one under its day", () => {
	assert.deepEqual(
		parseEvents(raw(WEEKLY), "Home", month, tz).map((event) => event.occurrence),
		["2026-11-16T08:00", "2026-11-23T08:00", "2026-11-30T08:00", "2026-12-07T08:00"],
	);
	const yearly = buildEvent("y", { summary: "記念日", start: "2026-11-20", rrule: "FREQ=YEARLY" }, tz, NOW);
	assert.equal(parseEvents(raw(yearly), "Home", month, tz)[0]?.occurrence, "2026-11-20");
});

test("a repeat given a last day keeps that day's occurrence, even late at night", () => {
	const nightly = buildEvent(
		"n",
		{ summary: "日記", start: "2026-11-16T23:30", rrule: "FREQ=DAILY;UNTIL=20261118" },
		tz,
		NOW,
	);
	assert.deepEqual(occurrences(nightly), ["2026-11-16T23:30 日記", "2026-11-17T23:30 日記", "2026-11-18T23:30 日記"]);
});

test("a rule another client ended with a UNTIL in UTC keeps its last occurrence late in the day", () => {
	const data = ics(
		"BEGIN:VEVENT",
		"UID:n",
		"SUMMARY:日記",
		"DTSTART;TZID=Asia/Tokyo:20261116T233000",
		"DURATION:PT15M",
		"RRULE:FREQ=DAILY;UNTIL=20261118T145959Z",
		"END:VEVENT",
	);
	assert.equal(occurrences(data).at(-1), "2026-11-18T23:30 日記");
});

for (const [what, rrule] of [
	["no FREQ", "BYDAY=MO"],
	["both an end and a count", "FREQ=DAILY;COUNT=3;UNTIL=20261130"],
] as const) {
	test(`a rule with ${what} is refused`, () => {
		assert.throws(() => buildEvent("u", { summary: "x", start: "2026-11-16T08:00", rrule }, tz, NOW), CalendarError);
	});
}

test("a recurring event is changed or removed only when told whether one occurrence or all are meant", () => {
	assert.throws(() => applyChanges(WEEKLY, { summary: "定例" }, tz, NOW), CalendarError);
	assert.throws(() => removeFrom(WEEKLY, tz, NOW), CalendarError);
});

test("changing one occurrence leaves the others as they were", () => {
	const changed = applyChanges(
		WEEKLY,
		{ start: "2026-11-24T10:00", summary: "朝会（火曜）" },
		tz,
		NOW,
		thisOne("2026-11-23T08:00"),
	).data;
	assert.deepEqual(occurrences(changed), [
		"2026-11-16T08:00 朝会",
		"2026-11-24T10:00 朝会（火曜）",
		"2026-11-30T08:00 朝会",
		"2026-12-07T08:00 朝会",
	]);
});

test("a moved occurrence is still listed as the occurrence it was, so it can be changed again", () => {
	const moved = applyChanges(WEEKLY, { start: "2026-11-24T10:00" }, tz, NOW, thisOne("2026-11-23T08:00")).data;
	assert.equal(parseEvents(raw(moved), "Home", month, tz)[1]?.occurrence, "2026-11-23T08:00");
	const again = applyChanges(moved, { start: "2026-11-25T10:00" }, tz, NOW, thisOne("2026-11-23T08:00")).data;
	assert.deepEqual(occurrences(again), [
		"2026-11-16T08:00 朝会",
		"2026-11-25T10:00 朝会",
		"2026-11-30T08:00 朝会",
		"2026-12-07T08:00 朝会",
	]);
});

test("the same change to one occurrence applied twice ends as it did once", () => {
	const once = applyChanges(WEEKLY, { summary: "休み明け" }, tz, NOW, thisOne("2026-11-23T08:00")).data;
	const twice = applyChanges(once, { summary: "休み明け" }, tz, NOW, thisOne("2026-11-23T08:00")).data;
	assert.deepEqual(occurrences(twice), occurrences(once));
});

for (const [what, target, changes] of [
	["an occurrence the series does not have", thisOne("2026-11-24T08:00"), { summary: "x" }],
	["one occurrence without saying which", { scope: "this" as const }, { summary: "x" }],
	["the rule of one occurrence", thisOne("2026-11-23T08:00"), { rrule: "FREQ=DAILY" }],
] as const) {
	test(`changing ${what} is refused`, () => {
		assert.throws(() => applyChanges(WEEKLY, changes, tz, NOW, target), CalendarError);
	});
}

test("removing one occurrence leaves the rest, and removing it again changes nothing", () => {
	const removed = removeFrom(WEEKLY, tz, NOW, thisOne("2026-11-23T08:00"));
	assert.ok(typeof removed === "object");
	assert.deepEqual(occurrences(removed.data), [
		"2026-11-16T08:00 朝会",
		"2026-11-30T08:00 朝会",
		"2026-12-07T08:00 朝会",
	]);
	assert.equal(removeFrom(removed.data, tz, NOW, thisOne("2026-11-23T08:00")), "unchanged");
});

/** 11/23 moved to the Tuesday, 11/30 renamed only, 12/7 removed. */
function edited(): string {
	let data = applyChanges(WEEKLY, { start: "2026-11-24T10:00" }, tz, NOW, thisOne("2026-11-23T08:00")).data;
	data = applyChanges(data, { summary: "朝会（オンライン）" }, tz, NOW, thisOne("2026-11-30T08:00")).data;
	const removed = removeFrom(data, tz, NOW, thisOne("2026-12-07T08:00"));
	assert.ok(typeof removed === "object");
	return removed.data;
}

test("moving every occurrence moves the ones changed on their own only in what they did not change", () => {
	const moved = applyChanges(edited(), { start: "2026-11-16T09:00" }, tz, NOW, all);
	assert.deepEqual(occurrences(moved.data), [
		"2026-11-16T09:00 朝会",
		"2026-11-24T10:00 朝会",
		"2026-11-30T09:00 朝会（オンライン）",
	]);
	assert.equal(moved.dropped, 0);
});

test("renaming every occurrence renames the ones that kept the old name", () => {
	const renamed = applyChanges(edited(), { summary: "定例" }, tz, NOW, all).data;
	assert.deepEqual(occurrences(renamed), [
		"2026-11-16T08:00 定例",
		"2026-11-24T10:00 定例",
		"2026-11-30T08:00 朝会（オンライン）",
	]);
});

test("a new rule keeps what was changed or removed in the occurrences it still has, and counts what it drops", () => {
	const shorter = applyChanges(edited(), { rrule: "FREQ=WEEKLY;BYDAY=MO;UNTIL=20261130" }, tz, NOW, all);
	assert.deepEqual(occurrences(shorter.data), [
		"2026-11-16T08:00 朝会",
		"2026-11-24T10:00 朝会",
		"2026-11-30T08:00 朝会（オンライン）",
	]);
	assert.equal(shorter.dropped, 1);
});

test("ending the repeating leaves the first occurrence as a single event, dropping the rest's changes", () => {
	const single = applyChanges(edited(), { rrule: "" }, tz, NOW, all);
	assert.deepEqual(occurrences(single.data), ["2026-11-16T08:00 朝会"]);
	assert.equal(single.dropped, 3);
});

test("a single event given a rule repeats on its weekday, even one written in UTC", () => {
	const monday = buildEvent("m", { summary: "ジム", start: "2026-11-16T07:00" }, tz, NOW);
	const weekly = applyChanges(monday, { rrule: "FREQ=WEEKLY;BYDAY=MO" }, tz, NOW).data;
	assert.deepEqual(occurrences(weekly), [
		"2026-11-16T07:00 ジム",
		"2026-11-23T07:00 ジム",
		"2026-11-30T07:00 ジム",
		"2026-12-07T07:00 ジム",
	]);
});

test("removing every occurrence removes the whole event", async () => {
	const { backend, calendars } = store();
	const id = await calendars.create(
		"Home",
		"w",
		{ summary: "朝会", start: "2026-11-16T08:00", rrule: "FREQ=WEEKLY;BYDAY=MO" },
		NOW,
	);
	await calendars.remove(`${id}@2026-11-23T08:00`, NOW, "all");
	assert.deepEqual(backend.files("Home"), []);
});

const tzArb = fc.constantFrom("Asia/Tokyo", "America/New_York", "UTC");
const labelArb = fc.stringMatching(/^[A-Za-z0-9_-]{1,16}$/);
const dateArb = fc.integer({ min: 0, max: 720 }).map((offset) => addDays("2026-01-01", offset));
const minuteOfDayArb = fc
	.integer({ min: 0, max: 23 * 60 + 59 })
	.map((m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);

test("property: built single events round-trip across time zones including DST", () => {
	fc.assert(
		fc.property(
			tzArb,
			fc.boolean(),
			dateArb,
			minuteOfDayArb,
			fc.integer({ min: 0, max: 5 }),
			fc.integer({ min: 15, max: 180 }),
			labelArb,
			fc.option(labelArb, { nil: undefined }),
			fc.option(labelArb, { nil: undefined }),
			(zone, allDay, date, clock, extraDays, durationMin, summary, location, description) => {
				if (allDay) {
					const endDate = addDays(date, extraDays);
					const data = buildEvent("u-allday", { summary, start: date, end: endDate, location, description }, zone, NOW);
					const from = startOfDay(addDays(date, -1), zone);
					const to = startOfDay(addDays(endDate, 2), zone);
					const items = parseEvents(raw(data), "Home", { from, to }, zone);
					assert.equal(items.length, 1);
					const item = items[0]!;
					assert.equal(item.allDay, true);
					assert.equal(item.summary, summary);
					assert.equal(item.location, location);
					assert.equal(item.description, description);
					assert.equal(item.start, startOfDay(date, zone));
					assert.equal(item.end, startOfDay(addDays(endDate, 1), zone));
					return;
				}
				const startStr = `${date}T${clock}`;
				const startMs = localToEpoch(startStr, zone);
				const endStr = localMinute(startMs + durationMin * 60_000, zone);
				const endMs = localToEpoch(endStr, zone);
				fc.pre(endMs > startMs);
				const data = buildEvent("u-timed", { summary, start: startStr, end: endStr, location, description }, zone, NOW);
				const items = parseEvents(raw(data), "Home", { from: startMs - 86_400_000, to: endMs + 86_400_000 }, zone);
				assert.equal(items.length, 1);
				const item = items[0]!;
				assert.equal(item.allDay, false);
				assert.equal(item.summary, summary);
				assert.equal(item.location, location);
				assert.equal(item.description, description);
				assert.equal(item.start, startMs);
				assert.equal(item.end, endMs);
			},
		),
		{ numRuns: 100 },
	);
});

test("property: changing or removing one occurrence leaves all other occurrences intact", () => {
	fc.assert(
		fc.property(
			tzArb,
			fc.constantFrom("FREQ=DAILY", "FREQ=WEEKLY"),
			dateArb,
			fc.integer({ min: 1, max: 20 }).map((h) => `${String(h).padStart(2, "0")}:00`),
			fc.integer({ min: 0, max: 4 }),
			fc.integer({ min: 1, max: 3 }),
			labelArb,
			labelArb,
			(zone, rrule, date, clock, pick, shiftHours, baseSummary, newSummary) => {
				const startStr = `${date}T${clock}`;
				const startMs = localToEpoch(startStr, zone);
				const data = buildEvent("u-rec", { summary: baseSummary, start: startStr, rrule }, zone, NOW);
				const stepDays = rrule === "FREQ=DAILY" ? 1 : 7;
				const range = { from: startMs - 86_400_000, to: startMs + stepDays * 6 * 86_400_000 };
				const before = parseEvents(raw(data), "Home", range, zone);
				fc.pre(before.length >= 5);
				const target = before[pick]!;
				const occ = target.occurrence!;
				const others = (items: EventItem[]) =>
					items
						.filter((item) => item.occurrence !== occ)
						.map((item) => [item.occurrence, item.start, item.end, item.summary]);

				const movedStart = localMinute(target.start + shiftHours * 3_600_000, zone);
				const movedMs = localToEpoch(movedStart, zone);
				fc.pre(movedMs > target.start);
				const changed = applyChanges(data, { start: movedStart, summary: newSummary }, zone, NOW, {
					scope: "this",
					occurrence: occ,
				}).data;
				const afterEdit = parseEvents(raw(changed), "Home", range, zone);
				assert.deepEqual(others(afterEdit), others(before));
				const edited = afterEdit.find((item) => item.occurrence === occ);
				assert.ok(edited !== undefined);
				assert.equal(edited.summary, newSummary);
				assert.equal(edited.start, movedMs);

				const removed = removeFrom(changed, zone, NOW, { scope: "this", occurrence: occ });
				assert.ok(typeof removed === "object");
				const afterRemove = parseEvents(raw(removed.data), "Home", range, zone);
				assert.deepEqual(others(afterRemove), others(before));
				assert.equal(
					afterRemove.some((item) => item.occurrence === occ),
					false,
				);
				assert.equal(removeFrom(removed.data, zone, NOW, { scope: "this", occurrence: occ }), "unchanged");
			},
		),
		{ numRuns: 60 },
	);
});

type RecOp =
	| { readonly kind: "editThis"; readonly index: number; readonly shiftHours: number; readonly summary: string }
	| { readonly kind: "removeThis"; readonly index: number }
	| { readonly kind: "editAllSummary"; readonly summary: string }
	| { readonly kind: "editAllShift"; readonly shiftHours: number }
	| { readonly kind: "stopRepeat" };

const recOpArb: fc.Arbitrary<RecOp> = fc.oneof(
	fc.record({
		kind: fc.constant("editThis" as const),
		index: fc.integer({ min: 0, max: 5 }),
		shiftHours: fc.integer({ min: -2, max: 2 }),
		summary: labelArb,
	}),
	fc.record({ kind: fc.constant("removeThis" as const), index: fc.integer({ min: 0, max: 5 }) }),
	fc.record({ kind: fc.constant("editAllSummary" as const), summary: labelArb }),
	fc.record({ kind: fc.constant("editAllShift" as const), shiftHours: fc.integer({ min: -3, max: 3 }) }),
	fc.record({ kind: fc.constant("stopRepeat" as const) }),
);

test("property: arbitrary sequences of this/all edits and removals keep a recurring event consistent", () => {
	fc.assert(
		fc.property(tzArb, dateArb, fc.array(recOpArb, { minLength: 1, maxLength: 6 }), (zone, date, ops) => {
			let data = buildEvent(
				"u-seq",
				{ summary: "base", start: `${date}T09:00`, end: `${date}T10:00`, rrule: "FREQ=DAILY;COUNT=8" },
				zone,
				NOW,
			);
			const baseMs = localToEpoch(`${date}T09:00`, zone);
			const range = { from: baseMs - 14 * 86_400_000, to: baseMs + 30 * 86_400_000 };
			let recurring = true;

			for (const op of ops) {
				const current = parseEvents(raw(data), "Home", range, zone);
				if (!recurring) break;

				if (op.kind === "editThis") {
					if (current.length === 0) continue;
					const target = current[op.index % current.length]!;
					const nextStart = localMinute(target.start + op.shiftHours * 3_600_000, zone);
					data = applyChanges(data, { start: nextStart, summary: op.summary }, zone, NOW, {
						scope: "this",
						occurrence: target.occurrence,
					}).data;
				} else if (op.kind === "removeThis") {
					if (current.length === 0) continue;
					const target = current[op.index % current.length]!;
					const res = removeFrom(data, zone, NOW, { scope: "this", occurrence: target.occurrence });
					assert.ok(typeof res === "object");
					data = res.data;
					const after = parseEvents(raw(data), "Home", range, zone);
					assert.equal(
						after.some((item) => item.occurrence === target.occurrence),
						false,
					);
				} else if (op.kind === "editAllSummary") {
					data = applyChanges(data, { summary: op.summary }, zone, NOW, { scope: "all" }).data;
				} else if (op.kind === "editAllShift") {
					const first = current[0];
					if (first === undefined) continue;
					const nextStart = localMinute(first.start + op.shiftHours * 3_600_000, zone);
					data = applyChanges(data, { start: nextStart }, zone, NOW, { scope: "all" }).data;
				} else if (op.kind === "stopRepeat") {
					data = applyChanges(data, { rrule: "" }, zone, NOW, { scope: "all" }).data;
					recurring = false;
				}

				const after = parseEvents(raw(data), "Home", range, zone);
				for (const item of after) assert.ok(item.start <= item.end);
				if (recurring) {
					const keys = after.map((item) => item.occurrence);
					assert.equal(new Set(keys).size, keys.length);
				} else {
					assert.ok(after.length <= 1);
					assert.equal(after[0]?.rule, undefined);
				}
			}
		}),
		{ numRuns: 60 },
	);
});
