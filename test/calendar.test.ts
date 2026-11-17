import assert from "node:assert/strict";
import { test } from "node:test";
import {
	applyChanges,
	buildEvent,
	buildTodo,
	CalendarError,
	Calendars,
	completeTodo,
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
const lines = (items: { start: number; end: number; summary: string }[]) =>
	items.map((item) => formatEvent({ kind: "event", id: "", calendar: "", uid: "", allDay: false, recurring: false, ...item }, tz));

test("event times are read as instants whatever form they are written in", () => {
	const event = (when: string[]) => parseEvents(raw(ics("BEGIN:VEVENT", "UID:1", "SUMMARY:歯医者", ...when, "END:VEVENT")), "Home", week, tz)[0];

	const zoned = event(["DTSTART;TZID=Asia/Tokyo:20261117T153000", "DTEND;TZID=Asia/Tokyo:20261117T160000"]);
	assert.equal(zoned?.start, at("2026-11-17T15:30"));
	assert.equal(zoned?.end, at("2026-11-17T16:00"));
	assert.equal(zoned?.id, "Home/x.ics");

	// 06:30 UTC is 15:30 in Tokyo; 10:00 in New York (EST, UTC-5) is midnight the next day in Tokyo.
	assert.equal(event(["DTSTART:20261117T063000Z", "DTEND:20261117T070000Z"])?.start, at("2026-11-17T15:30"));
	assert.equal(event(["DTSTART;TZID=America/New_York:20261117T100000", "DURATION:PT1H"])?.start, at("2026-11-18T00:00"));
	// A floating time, and a TZID that is not a zone name, are read in the agent's zone.
	assert.equal(event(["DTSTART:20261117T153000"])?.start, at("2026-11-17T15:30"));
	assert.equal(event(["DTSTART;TZID=Tokyo Standard Time:20261117T153000"])?.start, at("2026-11-17T15:30"));

	const allDay = event(["DTSTART;VALUE=DATE:20261117", "DTEND;VALUE=DATE:20261119"]);
	assert.equal(allDay?.allDay, true);
	assert.equal(allDay?.start, at("2026-11-17T00:00"));
	assert.equal(allDay?.end, at("2026-11-19T00:00"));
	assert.equal(formatEvent(allDay!, tz), "11/17(火)〜11/18(水) 終日 歯医者");
});

test("only what overlaps the range is returned", () => {
	const data = ics("BEGIN:VEVENT", "UID:1", "SUMMARY:x", "DTSTART:20261117T063000Z", "DTEND:20261117T070000Z", "END:VEVENT");
	assert.equal(parseEvents(raw(data), "Home", { from: at("2026-11-17T16:00"), to: at("2026-11-18T00:00") }, tz).length, 0);
	assert.equal(parseEvents(raw(data), "Home", { from: at("2026-11-17T15:59"), to: at("2026-11-18T00:00") }, tz).length, 1);
	assert.equal(parseEvents(raw(data), "Home", { from: at("2026-11-17T00:00"), to: at("2026-11-17T15:30") }, tz).length, 0);
	assert.deepEqual(parseEvents(raw("not a calendar"), "Home", week, tz), []);
});

test("a recurring event is expanded with its removed, moved and cancelled occurrences", () => {
	const data = ics(
		"BEGIN:VEVENT",
		"UID:r",
		"SUMMARY:缶のゴミ捨て",
		"DTSTART;TZID=Asia/Tokyo:20261101T080000",
		"DTEND;TZID=Asia/Tokyo:20261101T081500",
		"RRULE:FREQ=DAILY",
		"EXDATE;TZID=Asia/Tokyo:20261117T080000",
		"END:VEVENT",
		// The 18th is moved to the evening, the 19th is cancelled.
		"BEGIN:VEVENT",
		"UID:r",
		"RECURRENCE-ID;TZID=Asia/Tokyo:20261118T080000",
		"SUMMARY:缶のゴミ捨て（夜）",
		"DTSTART;TZID=Asia/Tokyo:20261118T200000",
		"DTEND;TZID=Asia/Tokyo:20261118T201500",
		"END:VEVENT",
		"BEGIN:VEVENT",
		"UID:r",
		"RECURRENCE-ID;TZID=Asia/Tokyo:20261119T080000",
		"STATUS:CANCELLED",
		"SUMMARY:缶のゴミ捨て",
		"DTSTART;TZID=Asia/Tokyo:20261119T080000",
		"DTEND;TZID=Asia/Tokyo:20261119T081500",
		"END:VEVENT",
	);
	const items = parseEvents(raw(data), "Home", { from: at("2026-11-16T00:00"), to: at("2026-11-21T00:00") }, tz);
	assert.deepEqual(lines(items), [
		"11/16(月) 08:00–08:15 缶のゴミ捨て（繰り返し）",
		"11/18(水) 20:00–20:15 缶のゴミ捨て（夜）（繰り返し）",
		"11/20(金) 08:00–08:15 缶のゴミ捨て（繰り返し）",
	]);
});

test("a task is read with its due date and whether it is done", () => {
	const todo = (...extra: string[]) => parseTodo(raw(ics("BEGIN:VTODO", "UID:t", "SUMMARY:レポート提出", ...extra, "END:VTODO")), "ToDo", tz);

	const dated = todo("DUE;VALUE=DATE:20261120", "LAST-MODIFIED:20261117T010000Z");
	assert.deepEqual(dated?.due, { date: "2026-11-20" });
	assert.equal(dated?.done, false);
	assert.equal(dated?.modified, Date.UTC(2026, 10, 17, 1));
	assert.equal(formatTodo(dated!, tz), "レポート提出 期日 11/20(金)");

	// 15:00 UTC on the 19th is already the 20th in Tokyo.
	const timed = todo("DUE:20261119T150000Z");
	assert.deepEqual(timed?.due, { date: "2026-11-20", at: at("2026-11-20T00:00") });

	assert.equal(todo()?.due, undefined);
	assert.equal(todo("STATUS:COMPLETED")?.done, true);
	assert.equal(todo("COMPLETED:20261117T010000Z")?.done, true);
});

test("a built event or task reads back as what was asked for", () => {
	const now = at("2026-11-17T09:00");
	const timed = parseEvents(raw(buildEvent("u1", { summary: " 歯医者 ", start: "2026-11-17T15:30", location: "駅前" }, tz, now)), "Home", week, tz)[0];
	assert.equal(formatEvent(timed!, tz), "11/17(火) 15:30–16:30 歯医者 @駅前");
	assert.equal(timed?.uid, "u1");

	const days = parseEvents(raw(buildEvent("u2", { summary: "旅行", start: "2026-11-20", end: "2026-11-22" }, tz, now)), "Home", week, tz)[0];
	assert.equal(formatEvent(days!, tz), "11/20(金)〜11/22(日) 終日 旅行");

	const todo = parseTodo(raw(buildTodo("u3", { summary: "レポート提出", due: "2026-11-20T17:00" }, tz, now)), "ToDo", tz);
	assert.equal(formatTodo(todo!, tz), "レポート提出 期日 11/20(金) 17:00");

	assert.throws(() => buildEvent("u4", { summary: "x", start: "2026-11-17T15:30", end: "2026-11-17T15:00" }, tz, now), CalendarError);
	assert.throws(() => buildEvent("u5", { summary: "x", start: "tomorrow" }, tz, now), CalendarError);
	assert.throws(() => buildEvent("u6", { summary: " ", start: "2026-11-17" }, tz, now), CalendarError);
});

test("a change keeps what it does not touch, and moving a start keeps the length", () => {
	const data = ics(
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
	const moved = applyChanges(data, { start: "2026-11-18T10:00" }, tz, at("2026-11-17T09:00"));
	assert.equal(formatEvent(parseEvents(raw(moved), "Home", week, tz)[0]!, tz), "11/18(水) 10:00–10:45 歯医者 @駅前");
	assert.match(moved, /BEGIN:VALARM/);
	assert.match(moved, /SEQUENCE:1/);
	// The old zone parameter does not fit the new UTC value.
	assert.doesNotMatch(moved, /TZID/);

	const cleared = applyChanges(data, { summary: "歯科検診", location: "" }, tz, at("2026-11-17T09:00"));
	assert.equal(formatEvent(parseEvents(raw(cleared), "Home", week, tz)[0]!, tz), "11/17(火) 15:30–16:15 歯科検診");

	assert.throws(() => applyChanges(data, { due: "2026-11-20" }, tz, 0), /予定に due はありません/);
});

test("completing a task is recorded once", () => {
	const data = ics("BEGIN:VTODO", "UID:t", "SUMMARY:レポート提出", "STATUS:NEEDS-ACTION", "END:VTODO");
	const done = completeTodo(data, at("2026-11-17T09:00"));
	assert.equal(parseTodo(raw(done!), "ToDo", tz)?.done, true);
	assert.equal(completeTodo(done!, at("2026-11-17T10:00")), undefined);
});

test("writes through the store are safe to repeat", async () => {
	const backend = new MemoryCalDav();
	const calendars = new Calendars(backend, { Home: { kind: "events", description: "" }, ToDo: { kind: "todos", description: "" } }, tz);
	const now = at("2026-11-17T09:00");

	const id = await calendars.create("Home", "u1", { summary: "歯医者", start: "2026-11-17T15:30" }, now);
	assert.equal(id, "Home/u1.ics");
	// The same UID again, as a rerun after a crash sends it: still one object.
	await calendars.create("Home", "u1", { summary: "歯医者", start: "2026-11-17T15:30" }, now);
	assert.deepEqual(backend.files("Home"), ["u1.ics"]);

	await calendars.update(id, { start: "2026-11-17T16:00" }, now);
	await calendars.update(id, { start: "2026-11-17T16:00" }, now);
	assert.deepEqual(lines(await calendars.events(week.from, week.to)), ["11/17(火) 16:00–17:00 歯医者"]);
	assert.equal(await calendars.describe(id), "11/17(火) 16:00–17:00 歯医者");

	const task = await calendars.create("ToDo", "u2", { summary: "レポート提出", due: "2026-11-20" }, now);
	await calendars.complete(task, now);
	await calendars.complete(task, now);
	assert.equal((await calendars.todos())[0]?.done, true);

	await calendars.remove(id);
	await calendars.remove(id);
	assert.deepEqual(backend.files("Home"), []);

	await assert.rejects(calendars.update("Home/nope.ics", { summary: "x" }, now), /見つかりません/);
	await assert.rejects(calendars.create("Work", "u3", { summary: "x", start: "2026-11-17" }, now), /カレンダー「Work」はありません/);
});
