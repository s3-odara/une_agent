import assert from "node:assert/strict";
import { test } from "node:test";
import { Approvals, refusal } from "../src/approval.ts";
import { buildEvent, buildTodo, Calendars } from "../src/calendar.ts";
import { createCalendarExtension } from "../src/calendar-tools.ts";
import type { Bridge } from "../src/rooms.ts";
import { Scheduler } from "../src/scheduler.ts";
import { localToEpoch } from "../src/time.ts";
import { agentEnv, ME } from "./env.ts";
import { answer, call, instructionsOf, lastInput, MemoryCalDav, message, noting, type Request, type ToolResult } from "./fakes.ts";

const tz = "Asia/Tokyo";
const ROOM = "!main:example.org";
const at = (local: string) => localToEpoch(local, tz);
const DENTIST = "Home/dentist.ics";

async function setup() {
	const backend = new MemoryCalDav();
	backend.put("Home", "dentist.ics", buildEvent("dentist", { summary: "歯医者", start: "2026-11-18T15:30" }, tz, 0));
	let clock = at("2026-11-17T09:00");
	let bridge: Bridge | undefined;
	let calendars!: Calendars;
	let approvals!: Approvals;
	const env = await agentEnv({
		config: {
			timezone: tz,
			caldav: { url: "https://dav.example.org", username: "me", calendars: { Home: { kind: "events", description: "個人的な予定" }, ToDo: { kind: "todos", description: "タスク" } } },
			proactive: { roomId: ROOM },
		},
		now: () => clock,
		extensions: ({ config, db }) => {
			calendars = new Calendars(backend, config.caldav!.calendars, tz);
			approvals = new Approvals({
				db,
				notice: (roomId, txnId, body) => bridge!.post(roomId, txnId, body),
				react: (roomId, txnId, eventId, key) => bridge!.react(roomId, txnId, eventId, key),
				log: () => {},
			});
			return [createCalendarExtension({ calendars, db, approvals })];
		},
	});
	bridge = env.bridge({ handlers: [approvals] });
	let n = 0;
	const results: ToolResult[] = [];
	return {
		env,
		backend,
		calendars,
		results,
		noting: noting(results),
		bridge,
		now: () => clock,
		setClock: (local: string) => void (clock = at(local)),
		write: (body: string) => env.link.emit(message(ROOM, `$m${++n}`, body, clock)),
		request: async (count = 1) => {
			const seen = new Set<string>();
			const reaction = await env.link.waitFor("react", (command) => {
				seen.add(command.eventId);
				return seen.size === count;
			});
			return { eventId: reaction.eventId, body: env.link.of("send").find((send) => `$sent-${send.txnId}` === reaction.eventId)?.body ?? "" };
		},
		react: (eventId: string, key: string) => env.link.emit({ type: "reaction", roomId: ROOM, eventId: `$r${++n}`, relatesTo: eventId, key, sender: ME }),
		settled: () => bridge!.idle(),
		async [Symbol.asyncDispose]() {
			await env[Symbol.asyncDispose]();
		},
	};
}

test("the model is told which calendars it can use, and what each is for", async () => {
	await using t = await setup();
	const requests: Request[] = [];
	t.env.faux.setResponses([answer("ok", requests)]);
	t.write("明日の予定は?");
	await t.settled();

	assert.match(instructionsOf(requests[0]!), /Home[^\n]*個人的な予定/);
	assert.match(instructionsOf(requests[0]!), /ToDo[^\n]*タスク/);
});

test("listing gives the coming events and open tasks with the ids to act on them, and leaves out done tasks", async () => {
	await using t = await setup();
	t.backend.put("ToDo", "report.ics", buildTodo("report", { summary: "レポート提出", due: "2026-11-20" }, tz, 0));
	t.backend.put("ToDo", "done.ics", buildTodo("done", { summary: "済んだこと" }, tz, 0).replace("NEEDS-ACTION", "COMPLETED"));
	t.env.faux.setResponses([call("calendar_list", {}), t.noting]);
	t.write("一覧");
	await t.settled();

	const listed = t.results[0]?.text ?? "";
	assert.match(listed, /歯医者.*Home\/dentist\.ics/);
	assert.match(listed, /レポート提出.*ToDo\/report\.ics/);
	assert.doesNotMatch(listed, /済んだこと/);
});

test("creating stores the item at once, under the id the model is given", async () => {
	await using t = await setup();
	t.env.faux.setResponses([call("calendar_create", { calendar: "ToDo", summary: "レポート提出", due: "2026-11-20" }), t.noting]);
	t.write("レポートを金曜までに");
	await t.settled();

	const todos = await t.calendars.todos();
	assert.deepEqual(
		todos.map((todo) => [todo.summary, todo.due?.date]),
		[["レポート提出", "2026-11-20"]],
	);
	assert.ok(t.results[0]?.text.includes(todos[0]!.id));
	assert.equal(t.env.link.of("react").length, 0, "nothing to approve");
});

test("a create the model got wrong is refused as an error, and nothing is stored", async () => {
	await using t = await setup();
	t.env.faux.setResponses([call("calendar_create", { calendar: "Home", summary: "期日つきの予定", due: "2026-11-20" }), t.noting]);
	t.write("変な依頼");
	await t.settled();

	assert.equal(t.results[0]?.isError, true);
	assert.deepEqual(t.backend.files("Home"), ["dentist.ics"]);
});

test("what the agent itself wrote is not reported back to the user as news, while a change from elsewhere is", async () => {
	await using t = await setup();
	const submitted: string[] = [];
	const scheduler = new Scheduler({
		config: t.env.config,
		db: t.env.db,
		calendars: t.calendars,
		submit: async (_room, _key, content) => void submitted.push(content),
		notice: async () => {},
		now: t.now,
		log: () => {},
	});
	t.setClock("2026-11-17T10:00");
	await scheduler.tick();
	submitted.length = 0;

	t.setClock("2026-11-17T10:05");
	t.env.faux.setResponses([call("calendar_create", { calendar: "Home", summary: "自分で登録した予定", start: "2026-11-21T09:00" }), t.noting]);
	t.write("21日の9時に予定を入れて");
	await t.settled();
	t.backend.put("Home", "phone.ics", buildEvent("phone", { summary: "スマホで入れた予定", start: "2026-11-22T14:00" }, tz, at("2026-11-17T10:06")));
	t.setClock("2026-11-17T10:15");
	await scheduler.tick();

	assert.equal(submitted.length, 1);
	assert.match(submitted[0]!, /スマホで入れた予定/);
	assert.doesNotMatch(submitted[0]!, /自分で登録した予定/);
});

test("a change is made only once the user approves it, and the request shows the item and the change", async () => {
	await using t = await setup();
	t.env.faux.setResponses([call("calendar_update", { id: DENTIST, start: "2026-11-18T16:00" }), t.noting]);
	t.write("歯医者を16時に");
	const request = await t.request();

	assert.match(request.body, /歯医者/);
	assert.match(request.body, /2026-11-18T16:00/);
	assert.equal((await t.calendars.events(at("2026-11-18T00:00"), at("2026-11-19T00:00")))[0]?.start, at("2026-11-18T15:30"));

	t.react(request.eventId, "✅");
	await t.settled();
	assert.equal((await t.calendars.events(at("2026-11-18T00:00"), at("2026-11-19T00:00")))[0]?.start, at("2026-11-18T16:00"));
});

test("a rejected delete leaves the item, and the model is told it was rejected", async () => {
	await using t = await setup();
	t.env.faux.setResponses([call("calendar_delete", { id: DENTIST }), t.noting]);
	t.write("歯医者を消して");
	t.react((await t.request()).eventId, "❌");
	await t.settled();

	assert.deepEqual(t.backend.files("Home"), ["dentist.ics"]);
	assert.equal(t.results[0]?.text, refusal({ approved: false, reason: "rejected" }));
});

test("an approval can be given by command, which does not reach the model", async () => {
	await using t = await setup();
	const requests: Request[] = [];
	t.env.faux.setResponses([call("calendar_delete", { id: DENTIST }), answer("ok", requests)]);
	t.write("歯医者を消して");
	await t.request();
	t.write("!approve");
	await t.settled();

	assert.deepEqual(t.backend.files("Home"), []);
	assert.equal(t.env.faux.state.callCount, 2);
	assert.doesNotMatch(lastInput(requests[0]!), /!approve/);
});

test("writing something else instead of answering is a no, and what was written reaches the model with the refusal", async () => {
	await using t = await setup();
	const requests: Request[] = [];
	t.env.faux.setResponses([call("calendar_update", { id: DENTIST, start: "2026-11-18T16:00" }), noting(t.results, requests)]);
	t.write("歯医者を16時に");
	await t.request();
	t.write("いや、17時にして");
	await t.settled();

	assert.equal(t.results[0]?.text, refusal({ approved: false, reason: "message" }));
	assert.match(lastInput(requests[0]!), /いや、17時にして/);
	assert.equal((await t.calendars.events(at("2026-11-18T00:00"), at("2026-11-19T00:00")))[0]?.start, at("2026-11-18T15:30"));
});

test("an id that does not exist, or is not an id, is refused as an error and changes nothing", async () => {
	await using t = await setup();
	t.env.faux.setResponses([call("calendar_update", { id: "Home/nope.ics", summary: "x" }), t.noting, call("calendar_update", { id: "bad-id", summary: "x" }), t.noting]);
	t.write("無いもの");
	await t.settled();
	t.write("変な id");
	await t.settled();

	assert.deepEqual(
		t.results.map((result) => result.isError),
		[true, true],
	);
	assert.equal(t.env.link.of("react").length, 0, "nothing to approve");
});

test("completing a task needs no approval", async () => {
	await using t = await setup();
	t.backend.put("ToDo", "report.ics", buildTodo("report", { summary: "レポート提出", due: "2026-11-20" }, tz, 0));
	t.env.faux.setResponses([call("calendar_complete", { id: "ToDo/report.ics" }), t.noting]);
	t.write("レポート出した");
	await t.settled();

	assert.equal((await t.calendars.todos())[0]?.done, true);
	assert.equal(t.env.link.of("react").length, 0);
});
