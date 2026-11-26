import assert from "node:assert/strict";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildEvent, buildTodo, Calendars } from "../src/calendar.ts";
import { HostDb, type Wake } from "../src/hostdb.ts";
import { NEAR, Scheduler } from "../src/scheduler.ts";
import { localToEpoch } from "../src/time.ts";
import type { WeatherSource } from "../src/weather.ts";
import { tempDir, testConfig } from "./env.ts";
import { ics, MemoryCalDav } from "./fakes.ts";

const tz = "Asia/Tokyo";
const ROOM = "!main:example.org";
const at = (local: string) => localToEpoch(local, tz);
/** Written well before the tests' days, so nothing counts as news unless a test says so. */
const LONG_AGO = at("2026-10-01T09:00");

function setup(proactive: Record<string, unknown> = {}, extra: Record<string, unknown> = {}, weather?: WeatherSource) {
	const dir = tempDir();
	const config = testConfig(dir.path, {
		caldav: { url: "https://dav.example.org", username: "me", calendars: { Work: { kind: "events" }, Home: { kind: "events" }, ToDo: { kind: "todos" } } },
		proactive: { roomId: ROOM, checkTimes: [], ...proactive },
		...extra,
	});
	const db = new HostDb(join(dir.path, "host.sqlite"));
	const backend = new MemoryCalDav();
	/** Wakes asked for before this many are not looked at any more. */
	let seen = 0;
	const notices: string[] = [];
	let now = at("2026-11-17T05:00");
	const scheduler = new Scheduler({
		config,
		db,
		...(config.caldav === undefined ? {} : { calendars: new Calendars(backend, config.caldav.calendars, tz) }),
		weather: weather ?? (async () => ({ area: "東京地方", reportedAt: "2026-11-17T05:00:00+09:00", days: [{ date: "2026-11-17", weather: "くもり昼過ぎから雨", rain: ["12-18時 70%"], maxTemp: "15" }] })),

		notice: async (_room, _key, body) => void notices.push(body),
		now: () => now,
		log: () => {},
	});
	return {
		config,
		db,
		backend,
		/** The wakes asked for since the last `forget()`, in order. */
		get woken(): Wake[] {
			return db.openWakes().slice(seen);
		},
		forget: () => void (seen = db.openWakes().length),
		/** What the model was woken with, in order. */
		get submitted() {
			return db.openWakes().slice(seen).map((wake) => wake.content);
		},
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

test("the model is woken for the brief at its time, once that day", async () => {
	using t = setup();
	await t.tickAt("2026-11-17T05:45");
	assert.equal(t.submitted.length, 0);
	await t.ticksFrom("2026-11-17T06:00", "2026-11-17T20:45");
	assert.equal(t.submitted.length, 1);
});

test("a brief missed while the agent was down is woken for at the next tick that day, and the next day's comes as usual", async () => {
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

test("the brief picks today and tomorrow for weather in Japan even when the configured date is still yesterday", async () => {
	using t = setup({}, { timezone: "America/Los_Angeles" }, async () => ({
		area: "東京地方",
		reportedAt: "2026-11-16T17:00:00+09:00",
		days: [
			{ date: "2026-11-16", weather: "前日の霧", rain: [] },
			{ date: "2026-11-17", weather: "当日の晴れ", rain: [] },
			{ date: "2026-11-18", weather: "翌日の雨", rain: [] },
		],
	}));
	await t.tickAt("2026-11-17T06:00");
	const brief = t.submitted[0] ?? "";
	assert.match(brief, /当日の晴れ/);
	assert.match(brief, /翌日の雨/);
	assert.doesNotMatch(brief, /前日の霧/);
});

test("a task past its due date is in the brief with how long ago that was", async () => {
	using t = setup();
	t.task("late", "払込", "2026-11-15");
	await t.tickAt("2026-11-17T06:00");
	assert.match(t.submitted[0] ?? "", /払込[^\n]*2日/);
});

test("the model is woken for an event once, from two hours before it starts", async () => {
	using t = setup();
	t.event("dentist", "歯医者", "2026-11-17T15:30");
	await t.tickAt("2026-11-17T06:00");
	t.forget();

	await t.tickAt("2026-11-17T13:15");
	assert.equal(t.submitted.length, 0);
	await t.tickAt("2026-11-17T13:30");
	await t.tickAt("2026-11-17T13:45");
	assert.equal(t.submitted.length, 1);
	assert.match(t.submitted[0]!, /歯医者/);
});

test("the model woken for an event the brief already named is told that the reminder is news", async () => {
	using t = setup();
	t.event("dinner", "夕食", "2026-11-17T19:00");
	await t.tickAt("2026-11-17T06:00");
	t.forget();
	await t.tickAt("2026-11-17T17:00");
	assert.ok(t.submitted[0]!.includes(NEAR));
});

test("what falls due when the brief goes out is in the brief and not woken for again", async () => {
	using t = setup();
	t.event("dentist", "歯医者", "2026-11-17T07:30");
	await t.ticksFrom("2026-11-17T06:00", "2026-11-17T07:30");
	assert.equal(t.submitted.length, 1);
	assert.match(t.submitted[0]!, /歯医者/);
});

test("an all-day event does not wake the model", async () => {
	using t = setup();
	t.event("birthday", "誕生日", "2026-11-17");
	await t.tickAt("2026-11-17T06:00");
	t.forget();
	await t.ticksFrom("2026-11-17T06:15", "2026-11-17T20:45");
	assert.equal(t.submitted.length, 0);
});

test("the model is woken for a task three days and one day before its due date, and on the day itself at its due hour", async () => {
	// The brief comes after the first check, so the reminders wake the model on their own.
	using t = setup({ briefTime: "20:00", windowStart: "07:00" });
	t.task("report", "レポート提出", "2026-11-21");
	const remindedOn = async (day: string) => {
		const before = t.submitted.length;
		await t.ticksFrom(`${day}T07:00`, `${day}T12:00`);
		return t.submitted.slice(before).some((content) => content.includes("レポート提出"));
	};
	assert.deepEqual(
		[await remindedOn("2026-11-17"), await remindedOn("2026-11-18"), await remindedOn("2026-11-19"), await remindedOn("2026-11-20"), await remindedOn("2026-11-21")],
		[false, true, false, true, true],
	);
});

test("a task without a time of day falls due at the due hour that day, outside the window too, once", async () => {
	using t = setup({ briefTime: "08:00", windowStart: "08:00" });
	t.task("report", "レポート提出", "2026-11-17");
	await t.tickAt("2026-11-17T06:45");
	assert.equal(t.woken.length, 0);
	await t.tickAt("2026-11-17T07:00");
	assert.equal(t.woken.length, 1);
	assert.equal(t.woken[0]!.kind, "check");
	assert.match(t.submitted[0]!, /期日当日です/);
	assert.match(t.submitted[0]!, /レポート提出/);
	await t.tickAt("2026-11-17T07:15");
	await t.tickAt("2026-11-18T07:00");
	assert.equal(t.woken.length, 1);
});

test("a task with a time of day falls due at that time, not at the configured hour", async () => {
	using t = setup({ briefTime: "20:00", windowStart: "07:00" });
	t.task("report", "レポート提出", "2026-11-17T10:30");
	await t.ticksFrom("2026-11-17T07:00", "2026-11-17T10:15");
	assert.equal(t.woken.length, 0);
	await t.tickAt("2026-11-17T10:30");
	assert.equal(t.woken.length, 1);
	assert.match(t.submitted[0]!, /期日の時刻です/);
});

test("a due hour missed while the agent was down is woken for later that day, and not after the day", async () => {
	using t = setup({ briefTime: "08:00", windowStart: "08:00" });
	t.task("report", "レポート提出", "2026-11-17");
	await t.tickAt("2026-11-17T09:00");
	assert.equal(t.woken.length, 1);
	assert.match(t.submitted[0]!, /レポート提出/);
	await t.tickAt("2026-11-18T07:00");
	assert.equal(t.woken.length, 1);
});

test("a completed task falls due no more", async () => {
	using t = setup({ briefTime: "08:00", windowStart: "08:00" });
	t.task("report", "レポート提出", "2026-11-17");
	t.backend.put("ToDo", "report.ics", ics("BEGIN:VTODO", "UID:report", "SUMMARY:レポート提出", "STATUS:COMPLETED", "DUE;VALUE=DATE:20261117", "DTSTAMP:20261116T090000Z", "END:VTODO"));
	await t.tickAt("2026-11-17T07:00");
	assert.equal(t.woken.length, 0);
});

test("a task added after the day's brief still wakes the model that day", async () => {
	using t = setup();
	await t.tickAt("2026-11-20T06:00");
	t.forget();
	t.task("ticket", "切符を買う", "2026-11-21");
	await t.tickAt("2026-11-20T12:00");
	assert.equal(t.submitted.length, 1);
	assert.match(t.submitted[0]!, /切符を買う/);
});

test("an item someone else just added wakes the model once, and again when it is changed", async () => {
	using t = setup();
	await t.tickAt("2026-11-17T10:00");
	t.forget();

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
	t.forget();
	// Its date is past the window the scheduler looks at until the next day.
	t.event("entering", "ずっと前に入れた予定", "2027-01-16T10:00");
	await t.tickAt("2026-11-17T10:15");
	await t.tickAt("2026-11-18T10:00");
	assert.ok(t.submitted.every((content) => !content.includes("ずっと前に入れた予定")));
});

test("a task completed elsewhere is not news", async () => {
	using t = setup();
	await t.tickAt("2026-11-17T10:00");
	t.forget();
	t.backend.put("ToDo", "done.ics", ics("BEGIN:VTODO", "UID:done", "SUMMARY:済んだこと", "STATUS:COMPLETED", "DTSTAMP:20261117T010600Z", "END:VTODO"));
	await t.tickAt("2026-11-17T10:15");
	assert.equal(t.submitted.length, 0);
});

test("the first check only takes note of what is there: none of it is news", async () => {
	using t = setup();
	t.event("salon", "美容院", "2026-11-22T14:00", at("2026-11-17T09:55"));
	await t.tickAt("2026-11-17T10:00");
	t.forget();
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

test("the model is woken for the brief once the calendar can be reached again", async () => {
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

test("the model is woken at each check time once that day, with the day's events to weigh", async () => {
	using t = setup({ briefTime: "06:00", checkTimes: ["12:00", "18:00"] });
	t.event("meeting", "定例", "2026-11-18T10:00");
	await t.tickAt("2026-11-17T06:00");
	t.forget();
	await t.ticksFrom("2026-11-17T11:30", "2026-11-17T18:30");
	assert.deepEqual(
		t.woken.map((wake) => wake.kind),
		["check", "check"],
	);
	assert.match(t.submitted[0]!, /定例/);
});

test("a check time the agent was down for is skipped once an hour has gone by", async () => {
	using t = setup({ checkTimes: ["12:00"] });
	await t.tickAt("2026-11-17T06:00");
	t.forget();
	await t.tickAt("2026-11-17T13:15");
	assert.equal(t.woken.length, 0);
});

test("a timer wakes the model in the room it was set in, at any hour, once, with what was asked", async () => {
	using t = setup();
	t.db.addTimer({ id: "t1", roomId: "!other:example.org", dueAt: at("2026-11-17T23:30"), note: "面接の結果を聞く", createdAt: at("2026-11-16T21:00") });
	await t.tickAt("2026-11-17T23:15");
	assert.equal(t.woken.length, 0);
	await t.tickAt("2026-11-17T23:30");
	await t.tickAt("2026-11-17T23:45");
	assert.deepEqual(
		t.woken.map((wake) => [wake.roomId, wake.kind]),
		[["!other:example.org", "timer"]],
	);
	assert.match(t.submitted[0]!, /面接の結果を聞く/);
});

test("without a calendar the model is still woken for the brief and the checks", async () => {
	using t = setup({ checkTimes: ["12:00"] }, { caldav: undefined });
	await t.ticksFrom("2026-11-17T06:00", "2026-11-17T12:00");
	assert.deepEqual(
		t.woken.map((wake) => wake.kind),
		["brief", "check"],
	);
});

test("an item added while the calendar is not watched, at night, wakes the model once the window opens", async () => {
	using t = setup({ checkTimes: ["23:00"] });
	await t.tickAt("2026-11-17T20:00");
	t.event("salon", "美容院", "2026-11-22T14:00", at("2026-11-17T22:30"));
	await t.tickAt("2026-11-17T23:00");
	await t.tickAt("2026-11-18T06:00");
	assert.ok(t.submitted.at(-1)?.includes("美容院"));
});

test("at a check time another room is checked if something was said in it since its last check, and not otherwise", async () => {
	using t = setup({ checkTimes: ["12:00"] });
	const OTHER = "!butler:example.org";
	t.db.noteActivity(OTHER);
	await t.tickAt("2026-11-17T06:00");
	await t.tickAt("2026-11-17T12:00");
	await t.tickAt("2026-11-18T06:00");
	await t.tickAt("2026-11-18T12:00");
	t.db.noteActivity(OTHER);
	await t.tickAt("2026-11-19T06:00");
	await t.tickAt("2026-11-19T12:00");
	assert.deepEqual(
		t.woken.filter((wake) => wake.roomId === OTHER).map((wake) => wake.key),
		["check:2026-11-17:12:00:!butler:example.org", "check:2026-11-19:12:00:!butler:example.org"],
	);
});

test("another room's check leaves the calendar to the calendar's room", async () => {
	using t = setup({ checkTimes: ["12:00"] });
	t.event("meeting", "定例", "2026-11-17T15:00");
	t.db.noteActivity("!butler:example.org");
	await t.tickAt("2026-11-17T06:00");
	await t.tickAt("2026-11-17T12:00");
	const other = t.woken.find((wake) => wake.roomId === "!butler:example.org");
	assert.ok(other !== undefined);
	assert.ok(!other.content.includes("定例"));
});

test("old received files are cleaned up on tick while recent ones stay", async () => {
	using dir = tempDir();
	const filesDir = join(dir.path, "files");
	mkdirSync(filesDir, { recursive: true });
	const now = at("2026-11-17T10:00");
	const oldFile = join(filesDir, "old.pdf");
	const recentFile = join(filesDir, "recent.pdf");
	writeFileSync(oldFile, "old");
	writeFileSync(recentFile, "recent");
	utimesSync(oldFile, (now - 8 * 86_400_000) / 1000, (now - 8 * 86_400_000) / 1000);
	utimesSync(recentFile, (now - 2 * 86_400_000) / 1000, (now - 2 * 86_400_000) / 1000);

	const db = new HostDb(join(dir.path, "host.sqlite"));
	try {
		const scheduler = new Scheduler({ config: testConfig(dir.path), db, filesDir, notice: async () => {}, now: () => now, log: () => {} });
		await scheduler.tick();
		assert.equal(existsSync(oldFile), false);
		assert.equal(existsSync(recentFile), true);
	} finally {
		db.close();
	}
});
