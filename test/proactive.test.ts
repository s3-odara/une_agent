import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createAttachExtension } from "../src/attach.ts";
import { createProactiveExtension, Proactive, WEIGHING_REFUSAL } from "../src/proactive.ts";
import { Scheduler } from "../src/scheduler.ts";
import { localToEpoch } from "../src/time.ts";
import { agentEnv, context } from "./env.ts";
import { answer, call, everything, lastToolResult, message, type Request } from "./fakes.ts";

const ROOM = "!main:example.org";
const CHECK = "[定時チェック 2026-11-17(火) 12:00] 伝えることがあれば書く。";
const at = (local: string) => localToEpoch(local, "Asia/Tokyo");

async function setup(config: Record<string, unknown> = {}) {
	let now = at("2026-11-17T10:00");
	const env = await agentEnv({
		config,
		souls: { "butler.md": "執事" },
		extensions: ({ db }) => [
			createProactiveExtension({ db, tz: "Asia/Tokyo" }),
			createAttachExtension({ db, send: async () => "$attached", uploadLimit: () => undefined }),
		],
		now: () => now,
		codemode: {},
	});
	const bridge = env.bridge();
	const proactive = new Proactive({
		harness: env.harness,
		db: env.db,
		rooms: bridge,
		context,
		now: () => now,
		log: () => {},
	});
	let n = 0;
	return {
		env,
		bridge,
		proactive,
		setClock: (local: string) => void (now = at(local)),
		say: async (body: string, roomId = ROOM) => {
			env.link.emit(message(roomId, `$${++n}`, body));
			await bridge.idle();
		},
		check: (key = "check:1", content = CHECK) => {
			env.db.addWake({ key, roomId: ROOM, kind: "check", content, createdAt: now });
			return proactive.run();
		},
		/** What reached the room, and whether as a notice. */
		sent: () => env.link.of("send").map((send) => [send.body, send.notice] as const),
		[Symbol.asyncDispose]: () => env[Symbol.asyncDispose](),
	};
}

test("what the model writes at a check reaches the room as a message that notifies, and nothing else does", async () => {
	await using t = await setup();
	t.env.faux.setResponses([answer("面接はどうだった？")]);
	await t.check();
	assert.deepEqual(t.sent(), [["面接はどうだった？", false]]);
});

test("the model weighs a check with the room's conversation so far before it", async () => {
	await using t = await setup();
	const requests: Request[] = [];
	t.env.faux.setResponses([answer("頑張って"), answer("面接はどうだった？", requests)]);
	await t.say("明日は面接なんだ");
	await t.check();
	assert.match(everything(requests[0]!), /明日は面接なんだ[\s\S]*頑張って[\s\S]*定時チェック/);
});

test("once the model has spoken at a check, the room's conversation goes on from what it said", async () => {
	await using t = await setup();
	const requests: Request[] = [];
	t.env.faux.setResponses([answer("面接はどうだった？"), answer("よかったね", requests)]);
	await t.check();
	await t.say("受かった！");
	assert.match(everything(requests[0]!), /面接はどうだった？[\s\S]*受かった！/);
});

test("a check the model stays silent at sends nothing, and the room's conversation goes on as if there had been none", async () => {
	await using t = await setup();
	const requests: Request[] = [];
	t.env.faux.setResponses([answer("こんにちは"), call("stay_silent", {}), answer("はい", requests)]);
	await t.say("やあ");
	await t.check();
	await t.say("元気？");
	assert.deepEqual(t.sent(), [
		["こんにちは", false],
		["はい", false],
	]);
	assert.doesNotMatch(everything(requests[0]!), /定時チェック/);
});

test("a tool that writes is refused while a check is weighed, and does nothing", async () => {
	await using t = await setup();
	const requests: Request[] = [];
	t.env.faux.setResponses([
		call("timer_add", { at: "2026-11-17T20:00", note: "夜に聞く" }),
		(request) => {
			requests.push(request);
			return call("stay_silent", {});
		},
	]);
	await t.check();
	const result = lastToolResult(requests[0]!);
	assert.equal(result.isError, true);
	assert.ok(result.text.includes(WEIGHING_REFUSAL));
	assert.deepEqual(t.env.db.timers(), []);
});

test("read_pdf is allowed while a check is weighed, while send_file is refused", async () => {
	await using t = await setup();
	const requests: Request[] = [];
	t.env.faux.setResponses([
		call("read_pdf", { path: "doc.pdf", pdfMode: "image" }),
		(request) => {
			requests.push(request);
			return call("send_file", { path: "doc.pdf" });
		},
		(request) => {
			requests.push(request);
			return call("stay_silent", {});
		},
	]);
	await t.check();
	// read_pdf reached its own parameter check instead of being blocked by the weighing hook.
	assert.doesNotMatch(lastToolResult(requests[0]!).text, /書き込むツールは使えません/);
	assert.ok(lastToolResult(requests[1]!).text.includes(WEIGHING_REFUSAL));
});

test("a script that writes is refused while a check is weighed, and does nothing", async () => {
	await using t = await setup();
	const requests: Request[] = [];
	t.env.faux.setResponses([
		call("codemode", { code: 'await tools.timer_add({ at: "2026-11-17T20:00", note: "夜に聞く" });' }),
		(request) => {
			requests.push(request);
			return call("stay_silent", {});
		},
	]);
	await t.check();
	const result = lastToolResult(requests[0]!);
	assert.equal(result.isError, true);
	assert.ok(result.text.includes(WEIGHING_REFUSAL));
	assert.deepEqual(t.env.db.timers(), []);
});

test("staying silent outside a check is refused", async () => {
	await using t = await setup();
	const requests: Request[] = [];
	t.env.faux.setResponses([call("stay_silent", {}), answer("はい", requests)]);
	await t.say("黙って");
	assert.equal(lastToolResult(requests[0]!).isError, true);
});

test("a check that comes while the room's conversation is at work is weighed once the work is done, knowing of it", async () => {
	await using t = await setup();
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	let started!: () => void;
	const working = new Promise<void>((resolve) => (started = resolve));
	const requests: Request[] = [];
	t.env.faux.setResponses([
		async () => {
			started();
			await held;
			return fauxAssistantMessage("調べました");
		},
		answer("ところで、面接はどうだった？", requests),
	]);
	t.env.link.emit(message(ROOM, "$1", "調べて"));
	await working;
	await t.check();
	assert.deepEqual(t.sent(), []);

	release();
	await t.bridge.idle();
	await t.proactive.run();
	assert.deepEqual(
		t.sent().map(([body]) => body),
		["調べました", "ところで、面接はどうだった？"],
	);
	assert.match(everything(requests[0]!), /調べました/);
});

test("a message that comes while a check is weighed is answered, and the check is weighed again knowing of it", async () => {
	await using t = await setup();
	const requests: Request[] = [];
	t.env.faux.setResponses([
		async () => {
			t.env.link.emit(message(ROOM, "$1", "今日は雨？"));
			await t.env.link.waitFor("send", (send) => send.body === "雨です");
			return fauxAssistantMessage("古い文面");
		},
		answer("雨です"),
		answer("傘を忘れずに", requests),
	]);
	await t.check();
	await t.bridge.idle();
	assert.deepEqual(
		t.sent().map(([body]) => body),
		["雨です", "傘を忘れずに"],
	);
	assert.match(everything(requests[0]!), /今日は雨？/);
});

test("a check is weighed and its message sent once, however often the wakes are gone through again", async () => {
	await using t = await setup();
	t.env.faux.setResponses([answer("面接はどうだった？"), answer("二度目")]);
	await t.check();
	await t.check();
	await t.proactive.run();
	assert.deepEqual(t.sent(), [["面接はどうだった？", false]]);
});

test("a check the room's conversation never became free for is given up once it is stale", async () => {
	await using t = await setup();
	t.env.faux.setResponses([answer("今さら")]);
	t.env.db.addWake({
		key: "check:old",
		roomId: ROOM,
		kind: "check",
		content: CHECK,
		createdAt: at("2026-11-17T05:00"),
	});
	await t.proactive.run();
	assert.deepEqual(t.sent(), []);
});

test("a time the model sets with the user runs directly in that room with full tools", async () => {
	await using t = await setup();
	const requests: Request[] = [];
	t.env.faux.setResponses([
		call("timer_add", { at: "2026-11-17T20:00", note: "面接の結果を聞いて、必要なら次のタイマーを入れる" }),
		answer("20時に聞きますね"),
		call("timer_add", { at: "2026-11-17T21:00", note: "さらに確認する" }),
		answer("面接の結果はどうだった？", requests),
	]);
	await t.say("20時に面接の結果を聞いて");

	const scheduler = new Scheduler({
		config: t.env.config,
		db: t.env.db,
		weigh: () => void t.proactive.run(),
		runTimer: (roomId, id, content) => t.bridge.runTimer(roomId, id, content),
		notice: async () => {},
		now: () => at("2026-11-17T20:00"),
		log: () => {},
	});
	t.setClock("2026-11-17T20:00");
	await scheduler.tick();
	await t.bridge.idle();
	assert.deepEqual(t.sent().at(-1), ["面接の結果はどうだった？", false]);
	assert.match(everything(requests[0]!), /面接の結果を聞いて/);
	// A writing tool succeeded during the timer run because timers run directly rather than in an aside.
	assert.deepEqual(
		t.env.db.timers().map((timer) => timer.note),
		["さらに確認する"],
	);
});

test("a time already past is refused", async () => {
	await using t = await setup();
	const requests: Request[] = [];
	t.env.faux.setResponses([
		call("timer_add", { at: "2026-11-17T09:00", note: "朝に聞く" }),
		answer("過ぎていました", requests),
	]);
	await t.say("9時に聞いて");
	assert.equal(lastToolResult(requests[0]!).isError, true);
	assert.deepEqual(t.env.db.timers(), []);
});

test("a cancelled time does not bring the model back", async () => {
	await using t = await setup();
	t.env.faux.setResponses([
		call("timer_add", { at: "2026-11-17T20:00", note: "聞く" }),
		answer("登録しました"),
		call("timer_list", {}),
		(request) => call("timer_cancel", { id: /\[(\w+)\]/.exec(lastToolResult(request).text)?.[1] ?? "" }),
		answer("取り消しました"),
	]);
	await t.say("20時に聞いて");
	await t.say("やっぱりやめて");
	assert.deepEqual(t.env.db.timers(), []);
});

test("a matter told in another room is followed up at a check in that room, by that room's persona", async () => {
	const BUTLER = "!butler:example.org";
	await using t = await setup({
		personas: { default: "soul.md", butler: "butler.md" },
		rooms: { [BUTLER]: "butler" },
		proactive: { roomId: ROOM, checkTimes: ["12:00"] },
	});
	const requests: Request[] = [];
	t.env.faux.setResponses([answer("承知いたしました")]);
	await t.say("明日は面接なんだ", BUTLER);
	// The checks of the two rooms are weighed in either order: only the butler's conversation has the matter in it.
	const weigh = (request: Request) =>
		everything(request).includes("明日は面接なんだ")
			? answer("面接はいかがでしたか", requests)(request)
			: call("stay_silent", {});
	t.env.faux.setResponses([weigh, weigh]);

	const scheduler = new Scheduler({
		config: t.env.config,
		db: t.env.db,
		weigh: () => void t.proactive.run(),
		notice: async () => {},
		now: () => at("2026-11-18T12:00"),
		log: () => {},
	});
	t.setClock("2026-11-18T12:00");
	await scheduler.tick();
	await t.proactive.run();
	const last = t.env.link.of("send").at(-1);
	assert.deepEqual([last?.roomId, last?.body], [BUTLER, "面接はいかがでしたか"]);
	assert.match(everything(requests[0]!), /執事[\s\S]*明日は面接なんだ/);
});
