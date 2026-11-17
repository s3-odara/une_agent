import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { buildEvent, buildTodo, Calendars } from "../src/calendar.ts";
import { parseConfig } from "../src/config.ts";
import { openAgentHarness } from "../src/harness.ts";
import { HostDb } from "../src/hostdb.ts";
import { MemoryStore } from "../src/memory.ts";
import { Scheduler } from "../src/scheduler.ts";
import { memoryFingerprint, tidyMemory } from "../src/tidy.ts";
import { localToEpoch } from "../src/time.ts";
import { parseJmaForecast } from "../src/weather.ts";
import { ics, MemoryCalDav } from "./fakes.ts";

const tz = "Asia/Tokyo";
const room = "!main:example.org";
const at = (local: string) => localToEpoch(local, tz);

function setup(extra: Record<string, unknown> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "agent-scheduler-test-"));
	const config = parseConfig(
		{
			matrix: { homeserver: "https://example.org", userId: "@agent:example.org", allowedUsers: ["@me:example.org"] },
			model: { provider: "faux", modelId: "faux-1" },
			personas: { default: "soul.md" },
			timezone: tz,
			caldav: {
				url: "https://dav.example.org",
				username: "me",
				calendars: { Work: { kind: "events" }, Home: { kind: "events" }, ToDo: { kind: "todos" } },
			},
			proactive: { roomId: room },
			...extra,
		},
		dir,
	);
	const db = new HostDb(join(dir, "host.sqlite"));
	const backend = new MemoryCalDav();
	const calendars = new Calendars(backend, config.caldav!.calendars, tz);
	const submitted: { key: string; content: string }[] = [];
	const notices: { key: string; body: string }[] = [];
	let now = at("2026-11-17T05:00");
	const scheduler = new Scheduler({
		config,
		db,
		calendars,
		weather: async () => ({ area: "東京地方", reportedAt: "2026-11-17T05:00:00+09:00", days: [{ date: "2026-11-17", weather: "くもり昼過ぎから雨", rain: ["12-18時 70%"], maxTemp: "15" }] }),
		submit: async (_room, key, content) => void submitted.push({ key, content }),
		notice: async (_room, key, body) => void notices.push({ key, body }),
		now: () => now,
		log: () => {},
	});
	return {
		dir,
		config,
		db,
		backend,
		calendars,
		scheduler,
		submitted,
		notices,
		/** Moves the clock and runs one check. */
		tickAt: async (local: string) => {
			now = at(local);
			await scheduler.tick();
		},
		cleanup: () => {
			db.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("the morning brief goes out once, with the day's data, and covers the reminders due at that moment", async () => {
	const t = setup();
	try {
		const made = at("2026-11-10T09:00");
		t.backend.put("Home", "dentist.ics", buildEvent("dentist", { summary: "歯医者", start: "2026-11-17T07:30", location: "駅前" }, tz, made));
		t.backend.put("Work", "meeting.ics", buildEvent("meeting", { summary: "定例", start: "2026-11-18T10:00" }, tz, made));
		t.backend.put("Home", "far.ics", buildEvent("far", { summary: "来週の予定", start: "2026-11-25T10:00" }, tz, made));
		t.backend.put("ToDo", "report.ics", buildTodo("report", { summary: "レポート提出", due: "2026-11-20" }, tz, made));
		t.backend.put("ToDo", "late.ics", buildTodo("late", { summary: "払込", due: "2026-11-15" }, tz, made));
		t.backend.put("ToDo", "someday.ics", buildTodo("someday", { summary: "本棚の整理" }, tz, made));

		await t.tickAt("2026-11-17T05:45");
		assert.equal(t.submitted.length, 0);

		await t.tickAt("2026-11-17T06:00");
		assert.equal(t.submitted.length, 1);
		const brief = t.submitted[0]!;
		assert.equal(brief.key, "brief:2026-11-17");
		assert.match(brief.content, /## 今日 11\/17\(火\) の予定\n- 11\/17\(火\) 07:30–08:30 歯医者 @駅前\n/);
		assert.match(brief.content, /## 明日 11\/18\(水\) の予定\n- 11\/18\(水\) 10:00–11:00 定例\n/);
		assert.doesNotMatch(brief.content, /来週の予定/);
		assert.match(brief.content, /- レポート提出 期日 11\/20\(金\)\n/);
		assert.match(brief.content, /- 払込 期日 11\/15\(日\)（期日を2日過ぎている）/);
		assert.match(brief.content, /期日なしの未完了タスクが 1 件/);
		assert.match(brief.content, /くもり昼過ぎから雨 最高15℃ 降水確率 12-18時 70%/);

		// The dentist is within two hours and the report is three days out: both were due, and the brief said them.
		await t.tickAt("2026-11-17T06:15");
		await t.tickAt("2026-11-17T06:30");
		assert.equal(t.submitted.length, 1);
	} finally {
		t.cleanup();
	}
});

test("a brief missed while the agent was down is sent at the next check that day, not the next day's twice", async () => {
	const t = setup();
	try {
		await t.tickAt("2026-11-17T09:20");
		assert.deepEqual(t.submitted.map((item) => item.key), ["brief:2026-11-17"]);
		await t.tickAt("2026-11-17T21:30");
		await t.tickAt("2026-11-18T06:05");
		assert.deepEqual(t.submitted.map((item) => item.key), ["brief:2026-11-17", "brief:2026-11-18"]);
		assert.match(t.submitted[1]!.content, /## 今日 11\/18\(水\) の予定\n- なし/);
	} finally {
		t.cleanup();
	}
});

test("reminders are sent once: two hours before an event, three days and one day before a due date", async () => {
	const t = setup();
	try {
		const made = at("2026-11-10T09:00");
		t.backend.put("Home", "dentist.ics", buildEvent("dentist", { summary: "歯医者", start: "2026-11-17T15:30" }, tz, made));
		t.backend.put("Home", "late.ics", buildEvent("late", { summary: "夜の予定", start: "2026-11-17T22:30" }, tz, made));
		t.backend.put("Home", "allday.ics", buildEvent("allday", { summary: "誕生日", start: "2026-11-17" }, tz, made));
		t.backend.put("ToDo", "report.ics", buildTodo("report", { summary: "レポート提出", due: "2026-11-21" }, tz, made));
		await t.tickAt("2026-11-17T06:00");
		t.submitted.length = 0;

		await t.tickAt("2026-11-17T13:15");
		assert.equal(t.submitted.length, 0);

		await t.tickAt("2026-11-17T13:30");
		assert.equal(t.submitted.length, 1);
		assert.match(t.submitted[0]!.content, /^\[定時チェック 2026-11-17\(火\) 13:30\]/);
		assert.match(t.submitted[0]!.content, /- まもなく開始（約120分後）: 11\/17\(火\) 15:30–16:30 歯医者/);
		assert.doesNotMatch(t.submitted[0]!.content, /誕生日|レポート/);
		await t.tickAt("2026-11-17T13:45");
		assert.equal(t.submitted.length, 1);

		// 20:30 is inside the window, so the 22:30 event is still announced; at 21:15 nothing would be.
		await t.tickAt("2026-11-17T20:30");
		assert.match(t.submitted[1]!.content, /夜の予定/);

		// A due-date reminder falls due with the first check of its day, which is the brief: the brief carries it.
		await t.tickAt("2026-11-18T06:00");
		assert.match(t.submitted.at(-1)!.content, /## いま知らせること\n- 3日後が期日: レポート提出 期日 11\/21\(土\)/);
		await t.tickAt("2026-11-18T12:00");
		await t.tickAt("2026-11-19T06:00");
		assert.doesNotMatch(t.submitted.at(-1)!.content, /いま知らせること/);
		await t.tickAt("2026-11-20T06:00");
		assert.match(t.submitted.at(-1)!.content, /- 明日が期日: レポート提出/);
		assert.deepEqual(t.submitted.slice(2).map((item) => item.key), ["brief:2026-11-18", "brief:2026-11-19", "brief:2026-11-20"]);

		// A task added after the day's brief still gets its reminder that day.
		t.backend.put("ToDo", "new.ics", buildTodo("new", { summary: "切符を買う", due: "2026-11-21" }, tz, made));
		await t.tickAt("2026-11-20T12:00");
		assert.match(t.submitted.at(-1)!.content, /^\[定時チェック[^\n]*\]\n[^\n]*\n\n- 明日が期日: 切符を買う/);
	} finally {
		t.cleanup();
	}
});

test("only what someone else just added or changed is reported as news", async () => {
	const t = setup();
	try {
		const old = at("2026-10-01T09:00");
		t.backend.put("Home", "known.ics", buildEvent("known", { summary: "前からある予定", start: "2026-11-30T10:00" }, tz, old));
		// The first check has nothing to compare against: it only takes the snapshot.
		await t.tickAt("2026-11-17T06:00");
		await t.tickAt("2026-11-17T10:00");
		t.submitted.length = 0;

		// Added from a phone a few minutes ago.
		t.backend.put("Home", "new.ics", buildEvent("new", { summary: "美容院", start: "2026-11-22T14:00" }, tz, at("2026-11-17T10:05")));
		// Written by the agent itself: its tool records the new ETag at once.
		await t.calendars.create("Work", "own", { summary: "自分で登録した予定", start: "2026-11-21T09:00" }, at("2026-11-17T10:06"));
		t.db.setSeenItem("Work/own.ics", await t.calendars.etag("Work/own.ics"));
		// Made long ago for a date that only now comes into view: new to the snapshot, but not news.
		t.backend.put("Home", "entering.ics", buildEvent("entering", { summary: "ずっと前に入れた予定", start: "2027-01-15T10:00" }, tz, old));
		// Completed elsewhere: nothing to act on.
		t.backend.put("ToDo", "done.ics", ics("BEGIN:VTODO", "UID:done", "SUMMARY:済んだこと", "STATUS:COMPLETED", "DTSTAMP:20261117T010600Z", "END:VTODO"));

		await t.tickAt("2026-11-17T10:15");
		assert.equal(t.submitted.length, 1);
		assert.match(t.submitted[0]!.content, /- 追加された予定: 11\/22\(日\) 14:00–15:00 美容院/);
		assert.doesNotMatch(t.submitted[0]!.content, /自分で登録|ずっと前|済んだこと|前からある/);

		t.backend.put("Home", "new.ics", buildEvent("new", { summary: "美容院", start: "2026-11-22T16:00" }, tz, at("2026-11-17T10:20")));
		await t.tickAt("2026-11-17T10:30");
		assert.match(t.submitted[1]!.content, /- 変更された予定: 11\/22\(日\) 16:00–17:00 美容院/);
		await t.tickAt("2026-11-17T10:45");
		assert.equal(t.submitted.length, 2);
	} finally {
		t.cleanup();
	}
});

test("an unreachable calendar is said once a day instead of a brief that silently never comes", async () => {
	const t = setup();
	try {
		t.backend.down = true;
		await t.tickAt("2026-11-17T06:00");
		await t.tickAt("2026-11-17T06:15");
		assert.equal(t.submitted.length, 0);
		assert.deepEqual(t.notices.map((notice) => notice.key), ["caldav-down:2026-11-17"]);
		assert.match(t.notices[0]!.body, /接続できません: connect ECONNREFUSED/);

		t.backend.down = false;
		await t.tickAt("2026-11-17T06:30");
		assert.deepEqual(t.submitted.map((item) => item.key), ["brief:2026-11-17"]);
	} finally {
		t.cleanup();
	}
});

test("the memory tidy takes a second look at what was written, and trusts the answer only so far", async () => {
	const dir = mkdtempSync(join(tmpdir(), "agent-tidy-test-"));
	const faux = fauxProvider();
	const model = faux.getModel();
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await openAgentHarness(new MemoryStorage(), models, context);
	try {
		const store = new MemoryStore(dir, { shared: 2000, private: 1000 });
		const personas = [{ name: "calm", privateMemory: true }];
		const calm = personas[0]!;
		store.add("shared", calm, "ユーザーは緑茶を好む", "2026-11-10");
		store.add("shared", calm, "ユーザーは緑茶がとても好きで、コーヒーよりも緑茶をよく飲むとのこと", "2026-11-16");
		store.add("shared", calm, "ユーザーは今日は眠いと言っていた", "2026-11-16");
		store.add("private", calm, "calm との合言葉は山", "2026-11-12");
		const options = { harness, store, personas, model: { provider: model.provider, modelId: model.id }, context, log: () => {} };
		const sharedBefore = store.entries("shared", calm);

		// Not a list, then a list longer than the original: both leave memory untouched.
		faux.setResponses([fauxAssistantMessage("整理しました！"), fauxAssistantMessage("- calm との合言葉は山\n- それに加えて、ユーザーについての長い長い説明をここに書き足します")]);
		assert.deepEqual(await tidyMemory(options, "2026-11-17"), []);
		assert.deepEqual(store.entries("shared", calm), sharedBefore);
		assert.deepEqual(store.entries("private", calm), ["calm との合言葉は山 (2026-11-12)"]);

		// A real tidy of the shared list; the private memo comes back as it was, without its date.
		const before = memoryFingerprint(store, personas);
		faux.setResponses([fauxAssistantMessage("- ユーザーは緑茶を好む\n- ユーザーはコーヒーより緑茶をよく飲む"), fauxAssistantMessage("- calm との合言葉は山")]);
		const changes = await tidyMemory(options, "2026-11-17");
		assert.deepEqual(store.entries("shared", calm), ["ユーザーは緑茶を好む (2026-11-10)", "ユーザーはコーヒーより緑茶をよく飲む (2026-11-17)"]);
		assert.deepEqual(store.entries("private", calm), ["calm との合言葉は山 (2026-11-12)"]);
		assert.deepEqual(changes.map((change) => change.label), ["shared"]);
		assert.equal(changes[0]?.removed.length, 2);
		assert.deepEqual(changes[0]?.added, ["ユーザーはコーヒーより緑茶をよく飲む (2026-11-17)"]);
		assert.notEqual(memoryFingerprint(store, personas), before);
		assert.deepEqual(readdirSync(join(dir, "history")), ["shared-2026-11-17.md"]);
	} finally {
		await harness.close(context);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the tidy runs at its hour, at most once per interval, and only when memory was written since", async () => {
	const t = setup({ memory: { tidyTime: "02:00", tidyEveryDays: 1 } });
	try {
		let fingerprint = "a";
		const runs: string[] = [];
		const scheduler = new Scheduler({
			config: t.config,
			db: t.db,
			submit: async () => {},
			notice: async (_room, key, body) => void t.notices.push({ key, body }),
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
		let clock = at("2026-11-17T01:45");
		const tickAt = async (local: string) => {
			clock = at(local);
			await scheduler.tick();
		};

		await tickAt("2026-11-17T01:45");
		assert.deepEqual(runs, []);
		await tickAt("2026-11-17T02:00");
		await tickAt("2026-11-17T02:15");
		assert.deepEqual(runs, ["2026-11-17"]);
		assert.match(t.notices[0]!.body, /記憶（shared）を整理しました。\n− 古い項目 \(2026-11-01\)/);

		// Nothing written during the 17th: no second look on the 18th.
		await tickAt("2026-11-18T02:00");
		assert.deepEqual(runs, ["2026-11-17"]);
		fingerprint = "b";
		await tickAt("2026-11-19T02:00");
		assert.deepEqual(runs, ["2026-11-17", "2026-11-19"]);
	} finally {
		t.cleanup();
	}
});

test("the forecast file is read into days, and a file of another shape yields none instead of failing", () => {
	const json = [
		{
			publishingOffice: "気象庁",
			reportDatetime: "2026-11-17T05:00:00+09:00",
			timeSeries: [
				{ timeDefines: ["2026-11-17T05:00:00+09:00", "2026-11-18T00:00:00+09:00"], areas: [{ area: { name: "東京地方" }, weathers: ["くもり　昼過ぎ　から　雨", "晴れ"] }] },
				{ timeDefines: ["2026-11-17T06:00:00+09:00", "2026-11-17T12:00:00+09:00", "2026-11-18T00:00:00+09:00"], areas: [{ pops: ["30", "70", "10"] }] },
				{ timeDefines: ["2026-11-17T09:00:00+09:00", "2026-11-17T00:00:00+09:00", "2026-11-18T00:00:00+09:00", "2026-11-18T09:00:00+09:00"], areas: [{ temps: ["15", "15", "9", "21"] }] },
			],
		},
	];
	const forecast = parseJmaForecast(json, tz);
	assert.equal(forecast.area, "東京地方");
	assert.deepEqual(forecast.days, [
		{ date: "2026-11-17", weather: "くもり昼過ぎから雨", rain: ["06-12時 30%", "12-18時 70%"], maxTemp: "15" },
		{ date: "2026-11-18", weather: "晴れ", rain: ["00-06時 10%"], minTemp: "9", maxTemp: "21" },
	]);
	assert.deepEqual(parseJmaForecast({ unexpected: true }, tz).days, []);
	assert.deepEqual(parseJmaForecast([{ timeSeries: "nope" }], tz).days, []);
});
