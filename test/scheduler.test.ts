import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { buildEvent, buildTodo, Calendars } from "../src/calendar.ts";
import { HostDb } from "../src/hostdb.ts";
import { Scheduler } from "../src/scheduler.ts";
import { localToEpoch } from "../src/time.ts";
import { tempDir, testConfig } from "./env.ts";
import { ics, MemoryCalDav } from "./fakes.ts";

const tz = "Asia/Tokyo";
const ROOM = "!main:example.org";
const at = (local: string) => localToEpoch(local, tz);
/** Written well before the tests' days, so nothing counts as news unless a test says so. */
const LONG_AGO = at("2026-10-01T09:00");

function setup(proactive: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
	const dir = tempDir();
	const config = testConfig(dir.path, {
		caldav: { url: "https://dav.example.org", username: "me", calendars: { Work: { kind: "events" }, Home: { kind: "events" }, ToDo: { kind: "todos" } } },
		proactive: { roomId: ROOM, ...proactive },
		...extra,
	});
	const db = new HostDb(join(dir.path, "host.sqlite"));
	const backend = new MemoryCalDav();
	const submitted: string[] = [];
	const notices: string[] = [];
	let now = at("2026-11-17T05:00");
	const scheduler = new Scheduler({
		config,
		db,
		calendars: new Calendars(backend, config.caldav!.calendars, tz),
		weather: async () => ({ area: "東京地方", reportedAt: "2026-11-17T05:00:00+09:00", days: [{ date: "2026-11-17", weather: "くもり昼過ぎから雨", rain: ["12-18時 70%"], maxTemp: "15" }] }),
		submit: async (_room, _key, content) => void submitted.push(content),
		notice: async (_room, _key, body) => void notices.push(body),
		now: () => now,
		log: () => {},
	});
	return {
		config,
		db,
		backend,
		submitted,
		notices,
		event: (file: string, summary: string, start: string, written = LONG_AGO) => backend.put(file === "meeting" ? "Work" : "Home", `${file}.ics`, buildEvent(file, { summary, start }, tz, written)),
		task: (file: string, summary: string, due?: string, written = LONG_AGO) => backend.put("ToDo", `${file}.ics`, buildTodo(file, { summary, ...(due === undefined ? {} : { due }) }, tz, written)),
		tickAt: async (local: string) => {
			now = at(local);
			await scheduler.tick();
		},
		ticksFrom: async (from: string, to: string) => {
			for (let time = at(from); time <= at(to); time += 15 * 60_000) {
				now = time;
				await scheduler.tick();
			}
		},
		[Symbol.dispose]() {
			db.close();
			dir[Symbol.dispose]();
		},
	};
}

test("the brief is sent at its time, once that day", async () => {
	using t = setup();
	await t.tickAt("2026-11-17T05:45");
	assert.equal(t.submitted.length, 0);
	await t.ticksFrom("2026-11-17T06:00", "2026-11-17T20:45");
	assert.equal(t.submitted.length, 1);
});

test("a brief missed while the agent was down is sent at the next check that day, and the next day's comes as usual", async () => {
	using t = setup();
	await t.tickAt("2026-11-17T09:20");
	await t.tickAt("2026-11-17T20:30");
	assert.equal(t.submitted.length, 1);
	await t.tickAt("2026-11-18T06:05");
	assert.equal(t.submitted.length, 2);
});

test("the brief has today's and tomorrow's events, the open tasks, and the forecast, and leaves out later events", async () => {
	using t = setup();
	t.event("dentist", "歯医者", "2026-11-17T15:30");
	t.event("meeting", "定例", "2026-11-18T10:00");
	t.event("far", "来週の予定", "2026-11-25T10:00");
	t.task("report", "レポート提出", "2026-11-20");
	await t.tickAt("2026-11-17T06:00");

	const brief = t.submitted[0] ?? "";
	for (const expected of ["歯医者", "定例", "レポート提出", "くもり昼過ぎから雨"]) assert.ok(brief.includes(expected), expected);
	assert.ok(!brief.includes("来週の予定"));
});

test("a task past its due date is in the brief with how long ago that was", async () => {
	using t = setup();
	t.task("late", "払込", "2026-11-15");
	await t.tickAt("2026-11-17T06:00");
	assert.match(t.submitted[0] ?? "", /払込[^\n]*2日/);
});

test("an event is reminded once, from two hours before it starts", async () => {
	using t = setup();
	t.event("dentist", "歯医者", "2026-11-17T15:30");
	await t.tickAt("2026-11-17T06:00");
	t.submitted.length = 0;

	await t.tickAt("2026-11-17T13:15");
	assert.equal(t.submitted.length, 0);
	await t.tickAt("2026-11-17T13:30");
	await t.tickAt("2026-11-17T13:45");
	assert.equal(t.submitted.length, 1);
	assert.match(t.submitted[0]!, /歯医者/);
});

test("what falls due when the brief goes out is in the brief and not sent again", async () => {
	using t = setup();
	t.event("dentist", "歯医者", "2026-11-17T07:30");
	await t.ticksFrom("2026-11-17T06:00", "2026-11-17T07:30");
	assert.equal(t.submitted.length, 1);
	assert.match(t.submitted[0]!, /歯医者/);
});

test("an all-day event is not reminded", async () => {
	using t = setup();
	t.event("birthday", "誕生日", "2026-11-17");
	await t.tickAt("2026-11-17T06:00");
	t.submitted.length = 0;
	await t.ticksFrom("2026-11-17T06:15", "2026-11-17T20:45");
	assert.equal(t.submitted.length, 0);
});

test("a task is reminded three days and one day before its due date", async () => {
	// The brief comes after the first check, so the reminders are sent on their own.
	using t = setup({ briefTime: "20:00", windowStart: "07:00" });
	t.task("report", "レポート提出", "2026-11-21");
	const remindedOn = async (day: string) => {
		const before = t.submitted.length;
		await t.ticksFrom(`${day}T07:00`, `${day}T12:00`);
		return t.submitted.slice(before).some((content) => content.includes("レポート提出"));
	};
	assert.deepEqual(
		[await remindedOn("2026-11-17"), await remindedOn("2026-11-18"), await remindedOn("2026-11-19"), await remindedOn("2026-11-20"), await remindedOn("2026-11-21")],
		[false, true, false, true, false],
	);
});

test("a task added after the day's brief is still reminded that day", async () => {
	using t = setup();
	await t.tickAt("2026-11-20T06:00");
	t.submitted.length = 0;
	t.task("ticket", "切符を買う", "2026-11-21");
	await t.tickAt("2026-11-20T12:00");
	assert.equal(t.submitted.length, 1);
	assert.match(t.submitted[0]!, /切符を買う/);
});

test("an item someone else just added is reported once, and again when it is changed", async () => {
	using t = setup();
	await t.tickAt("2026-11-17T10:00");
	t.submitted.length = 0;

	t.event("salon", "美容院", "2026-11-22T14:00", at("2026-11-17T10:05"));
	await t.tickAt("2026-11-17T10:15");
	await t.tickAt("2026-11-17T10:30");
	assert.equal(t.submitted.length, 1);
	assert.match(t.submitted[0]!, /美容院/);

	t.event("salon", "美容院", "2026-11-22T16:00", at("2026-11-17T10:35"));
	await t.tickAt("2026-11-17T10:45");
	assert.equal(t.submitted.length, 2);
	assert.match(t.submitted[1]!, /16:00/);
});

test("an item made long ago that only now comes into view is not news", async () => {
	using t = setup();
	await t.tickAt("2026-11-17T10:00");
	t.submitted.length = 0;
	// Its date is past the window the scheduler looks at until the next day.
	t.event("entering", "ずっと前に入れた予定", "2027-01-16T10:00");
	await t.tickAt("2026-11-17T10:15");
	await t.tickAt("2026-11-18T10:00");
	assert.ok(t.submitted.every((content) => !content.includes("ずっと前に入れた予定")));
});

test("a task completed elsewhere is not news", async () => {
	using t = setup();
	await t.tickAt("2026-11-17T10:00");
	t.submitted.length = 0;
	t.backend.put("ToDo", "done.ics", ics("BEGIN:VTODO", "UID:done", "SUMMARY:済んだこと", "STATUS:COMPLETED", "DTSTAMP:20261117T010600Z", "END:VTODO"));
	await t.tickAt("2026-11-17T10:15");
	assert.equal(t.submitted.length, 0);
});

test("the first check only takes note of what is there: none of it is news", async () => {
	using t = setup();
	t.event("salon", "美容院", "2026-11-22T14:00", at("2026-11-17T09:55"));
	await t.tickAt("2026-11-17T10:00");
	t.submitted.length = 0;
	await t.tickAt("2026-11-17T10:15");
	assert.equal(t.submitted.length, 0);
});

test("an unreachable calendar is told to the room once a day, with the reason", async () => {
	using t = setup();
	t.backend.down = true;
	await t.ticksFrom("2026-11-17T06:00", "2026-11-17T08:00");
	assert.equal(t.submitted.length, 0);
	assert.equal(t.notices.length, 1);
	assert.match(t.notices[0]!, /ECONNREFUSED/);

	await t.tickAt("2026-11-18T06:00");
	assert.equal(t.notices.length, 2);
});

test("the brief goes out once the calendar can be reached again", async () => {
	using t = setup();
	t.backend.down = true;
	await t.tickAt("2026-11-17T06:00");
	t.backend.down = false;
	await t.tickAt("2026-11-17T06:15");
	assert.equal(t.submitted.length, 1);
});

function tidySetup() {
	const t = setup({}, { memory: { tidyTime: "02:00", tidyEveryDays: 1 } });
	let fingerprint = "a";
	const runs: string[] = [];
	let clock = 0;
	const scheduler = new Scheduler({
		config: t.config,
		db: t.db,
		submit: async () => {},
		notice: async (_room, _key, body) => void t.notices.push(body),
		tidy: {
			fingerprint: () => fingerprint,
			run: async (date) => {
				runs.push(date);
				fingerprint = `${fingerprint}'`;
				return [{ label: "shared", removed: ["古い項目 (2026-11-01)"], added: [] }];
			},
		},
		now: () => clock,
		log: () => {},
	});
	return {
		...t,
		runs,
		write: () => void (fingerprint = `${fingerprint}+`),
		tickAt: async (local: string) => {
			clock = at(local);
			await scheduler.tick();
		},
	};
}

test("the memory tidy runs at its hour, once, and tells the room what it removed", async () => {
	using t = tidySetup();
	await t.tickAt("2026-11-17T01:45");
	assert.deepEqual(t.runs, []);
	await t.tickAt("2026-11-17T02:00");
	await t.tickAt("2026-11-17T02:15");
	assert.deepEqual(t.runs, ["2026-11-17"]);
	assert.match(t.notices[0]!, /古い項目 \(2026-11-01\)/);
});

test("the memory tidy is skipped when nothing was written since the last one", async () => {
	using t = tidySetup();
	await t.tickAt("2026-11-17T02:00");
	await t.tickAt("2026-11-18T02:00");
	assert.deepEqual(t.runs, ["2026-11-17"]);
	t.write();
	await t.tickAt("2026-11-19T02:00");
	assert.deepEqual(t.runs, ["2026-11-17", "2026-11-19"]);
});
