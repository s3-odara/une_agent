import assert from "node:assert/strict";
import { test } from "node:test";
import { createProactiveExtension, Proactive } from "../src/proactive.ts";
import { Scheduler } from "../src/scheduler.ts";
import { localToEpoch } from "../src/time.ts";
import { agentEnv, context } from "./env.ts";
import { answer, call, everything, lastToolResult, message, type Request } from "./fakes.ts";

const ROOM = "!main:example.org";
const at = (local: string) => localToEpoch(local, "Asia/Tokyo");

test("a user message arriving after a wake is adopted but before its message finishes sending can still use write tools", async () => {
	let now = at("2026-11-17T10:00");
	await using env = await agentEnv({
		extensions: ({ db }) => [createProactiveExtension({ db, tz: "Asia/Tokyo" })],
		now: () => now,
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

	let releaseSay!: () => void;
	const sayHeld = new Promise<void>((resolve) => (releaseSay = resolve));
	let sayStarted!: () => void;
	const sayArrived = new Promise<void>((resolve) => (sayStarted = resolve));

	env.link.beforeSent = (command) => {
		if (command.type === "send" && command.txnId === "reply:wake:check:1") {
			sayStarted();
			return sayHeld;
		}
		return undefined;
	};

	const requests: Request[] = [];
	env.faux.setResponses([
		answer("おはよう、今日の予定だよ"),
		call("timer_add", { at: "2026-11-17T20:00", note: "夜の確認" }),
		answer("登録しました", requests),
	]);

	env.db.addWake({ key: "check:1", roomId: ROOM, kind: "check", content: "[定時チェック] 話す？", createdAt: now });
	const weighing = proactive.run();
	await sayArrived;

	env.link.emit(message(ROOM, "$u1", "20時に夜の確認を登録して"));
	await bridge.idle();

	releaseSay();
	await weighing;

	const toolResult = lastToolResult(requests[0]!);
	assert.equal(toolResult.isError, false, `user tool was blocked: ${toolResult.text}`);
	assert.equal(env.db.timers().length, 1);
});

test("a replayed !new whose reply failed before a restart does not wipe a later conversation", async () => {
	await using env = await agentEnv();
	const bridge1 = env.bridge();

	env.link.failSends = true;
	env.link.emit(message(ROOM, "$cmd1", "!new"));
	await bridge1.idle();
	assert.equal(
		env.link.of("ack").some((a) => a.eventId === "$cmd1"),
		false,
	);

	env.link.failSends = false;
	env.faux.setResponses([answer("覚えました")]);
	env.link.emit(message(ROOM, "$m1", "秘密の合言葉は 42 です"));
	await bridge1.idle();
	assert.equal(
		env.link.of("ack").some((a) => a.eventId === "$m1"),
		true,
	);

	await env.restart();
	const bridge2 = env.bridge();
	env.link.emit(message(ROOM, "$cmd1", "!new"));
	await bridge2.idle();

	const requests: Request[] = [];
	env.faux.setResponses([answer("回答", requests)]);
	env.link.emit(message(ROOM, "$m2", "合言葉は何でしたか？"));
	await bridge2.idle();

	assert.match(everything(requests[0]!), /秘密の合言葉は 42 です/);
});

test("a timer run that crashed before markTimerFired is not executed again after adopt switches conversations", async () => {
	let now = at("2026-11-17T10:00");
	await using env = await agentEnv({
		extensions: ({ db }) => [createProactiveExtension({ db, tz: "Asia/Tokyo" })],
		now: () => now,
	});
	env.db.addTimer({
		id: "t1",
		roomId: ROOM,
		dueAt: at("2026-11-17T10:00"),
		note: "デプロイして",
		createdAt: at("2026-11-17T09:00"),
	});

	let timerExecutions = 0;
	const countTimer = (request: Request) => {
		if (everything(request).includes("デプロイして")) timerExecutions++;
		return answer("デプロイ完了")(request);
	};

	const bridge1 = env.bridge();
	env.faux.setResponses([countTimer]);
	await bridge1.runTimer(ROOM, "t1", "[約束の時刻] デプロイして");
	await bridge1.idle();
	assert.equal(timerExecutions, 1);

	await env.restart();
	const bridge2 = env.bridge();
	const proactive = new Proactive({
		harness: env.harness,
		db: env.db,
		rooms: bridge2,
		context,
		now: () => now,
		log: () => {},
	});
	env.faux.setResponses([answer("進捗どうですか？"), countTimer]);
	env.db.addWake({ key: "check:1", roomId: ROOM, kind: "check", content: "[定時チェック] 話す？", createdAt: now });
	await proactive.run();

	const scheduler = new Scheduler({
		config: env.config,
		db: env.db,
		runTimer: (roomId, id, content) => bridge2.runTimer(roomId, id, content),
		notice: (roomId, key, body) => bridge2.notice(roomId, key, body),
		now: () => now,
		log: () => {},
	});
	await scheduler.tick();
	const convId = env.db.conversationOf(ROOM)!;
	await (await env.harness.conversation(convId as never, context))!.waitForIdle(context);
	await bridge2.idle();

	assert.equal(timerExecutions, 1);
});

test("an unacked message that crashed between submit and addDelivery is not executed again after adopt switches conversations", async () => {
	let now = at("2026-11-17T10:00");
	await using env = await agentEnv({
		extensions: ({ db }) => [createProactiveExtension({ db, tz: "Asia/Tokyo" })],
		now: () => now,
	});

	let msgExecutions = 0;
	const countMsg = (request: Request) => {
		if (everything(request).includes("振り込んで")) msgExecutions++;
		return answer("完了しました")(request);
	};

	const bridge1 = env.bridge();
	env.faux.setResponses([answer("こんにちは"), countMsg]);
	env.link.emit(message(ROOM, "$m0", "こんにちは"));
	await bridge1.idle();

	const origAddDelivery = env.db.addDelivery.bind(env.db);
	let crashed = false;
	env.db.addDelivery = (delivery) => {
		if (!crashed && delivery.eventId === "$m1") {
			crashed = true;
			throw new Error("simulated crash before addDelivery");
		}
		origAddDelivery(delivery);
	};
	env.link.emit(message(ROOM, "$m1", "振り込んで"));
	await bridge1.idle();
	const conv1Id = env.db.conversationOf(ROOM)!;
	await (await env.harness.conversation(conv1Id as never, context))!.waitForIdle(context);
	assert.equal(msgExecutions, 1);
	assert.equal(
		env.link.of("ack").some((a) => a.eventId === "$m1"),
		false,
	);

	await env.restart();
	const bridge2 = env.bridge();
	const proactive = new Proactive({
		harness: env.harness,
		db: env.db,
		rooms: bridge2,
		context,
		now: () => now,
		log: () => {},
	});
	env.faux.setResponses([answer("進捗どうですか？"), countMsg]);
	env.db.addWake({ key: "check:1", roomId: ROOM, kind: "check", content: "[定時チェック] 話す？", createdAt: now });
	await proactive.run();

	env.link.emit(message(ROOM, "$m1", "振り込んで"));
	await bridge2.idle();

	assert.equal(msgExecutions, 1);
});
