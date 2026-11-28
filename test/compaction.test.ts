import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { SUMMARY_PROMPT, createCompactionExtension, createIdleCompactor } from "../src/compaction.ts";
import { Scheduler } from "../src/scheduler.ts";
import { agentEnv, context } from "./env.ts";
import { answer, everything, message, type Request } from "./fakes.ts";

const ROOM = "!main:example.org";
/** Opaque to the agent: only the server reads it. */
const ITEM = { type: "compaction", id: "cmp_1", encrypted_content: "opaque" };

type Options = Parameters<FauxResponseFactory>[1];

/** The provider's request body as an OpenAI Responses server gets it: the messages as input items. */
function responsesPayload(request: Request): { input: unknown[] } {
	return {
		input: request.messages
			.filter((item) => item.role !== "system")
			.map((item) => ({ role: item.role, content: [{ type: "input_text", text: everything({ messages: [item] }) }] })),
	};
}

async function setup(api?: string) {
	const env = await agentEnv({
		...(api === undefined ? {} : { api }),
		extensions: ({ db }) => [createCompactionExtension({ db, log: () => {} })],
	});
	const bridge = env.bridge();
	let n = 0;
	const say = async (body: string) => {
		env.link.emit(message(ROOM, `$${++n}`, body));
		await bridge.idle();
	};
	return {
		env,
		say,
		/** Compacts all but the newest of the room's conversation, as a long conversation would be. */
		compact: async () => {
			const conversation = (await env.harness.conversation(env.db.conversationOf(ROOM) as never, context))!;
			await conversation.configure({ compaction: { keepRecentTokens: 1 } }, context);
			await env.harness.waitForTask(await conversation.compact(undefined, context), context);
		},
		[Symbol.asyncDispose]: () => env[Symbol.asyncDispose](),
	};
}

/**
 * Answers the two requests a compaction makes: the summary in words, and (when asked with a compaction trigger at the
 * end, as an OpenAI server is) the native item.
 */
function compactionResponses(
	summary: string,
	requests: Request[],
	native: "item" | "none" = "item",
): FauxResponseFactory {
	return async (request, options: Options) => {
		const trigger = options?.onProviderStreamEvent !== undefined;
		if (!trigger) {
			requests.push(request as unknown as Request);
			return fauxAssistantMessage(summary);
		}
		const payload = (await options?.onPayload?.(
			responsesPayload(request as unknown as Request),
			undefined as never,
		)) as { input: { type?: string }[] };
		if (native === "item" && payload.input.at(-1)?.type === "compaction_trigger")
			await options?.onProviderStreamEvent?.({ type: "response.output_item.done", item: ITEM }, undefined as never);
		return fauxAssistantMessage([], { stopReason: "stop" });
	};
}

/** What the provider would send, once the hooks have had their say. */
function sending(bodies: unknown[]): FauxResponseFactory {
	return async (request, options: Options) => {
		bodies.push(
			(await options?.onPayload?.(responsesPayload(request as unknown as Request), undefined as never)) ??
				responsesPayload(request as unknown as Request),
		);
		return fauxAssistantMessage("ミケです");
	};
}

test("a compaction keeps the summary the model wrote of the conversation, asked for in the agent's own terms", async () => {
	await using t = await setup();
	const summaries: Request[] = [];
	const requests: Request[] = [];
	t.env.faux.setResponses([
		answer("覚えました"),
		answer("はい"),
		compactionResponses("猫はミケ。", summaries),
		answer("ミケです", requests),
	]);
	await t.say("猫の名前はミケ");
	await t.say("覚えた？");
	await t.compact();
	await t.say("猫の名前は？");
	assert.ok(everything(summaries[0]!).includes(SUMMARY_PROMPT));
	assert.match(everything(summaries[0]!), /猫の名前はミケ/);
	assert.match(everything(requests[0]!), /猫はミケ。/);
});

test("on a model whose server compacts natively, the provider is given its item in place of the summary from then on", async () => {
	await using t = await setup("openai-responses");
	const bodies: unknown[] = [];
	t.env.faux.setResponses([
		answer("覚えました"),
		answer("はい"),
		compactionResponses("猫はミケ。", []),
		compactionResponses("猫はミケ。", []),
		sending(bodies),
	]);
	await t.say("猫の名前はミケ");
	await t.say("覚えた？");
	await t.compact();
	await t.say("猫の名前は？");
	const input = (bodies[0] as { input: unknown[] }).input;
	assert.deepEqual(input[0], ITEM);
	assert.ok(!JSON.stringify(input).includes("猫はミケ。"));
});

test("on a model whose server does not compact natively, the summary in words stands and the server is not asked", async () => {
	await using t = await setup();
	const bodies: unknown[] = [];
	let triggers = 0;
	const summary = compactionResponses("猫はミケ。", []);
	t.env.faux.setResponses([
		answer("覚えました"),
		answer("はい"),
		async (request, options) => {
			if (options?.onProviderStreamEvent !== undefined) triggers++;
			return summary(request, options, undefined as never, undefined as never);
		},
		sending(bodies),
	]);
	await t.say("猫の名前はミケ");
	await t.say("覚えた？");
	await t.compact();
	await t.say("猫の名前は？");
	assert.equal(triggers, 0);
	assert.ok(JSON.stringify(bodies[0]).includes("猫はミケ。"));
});

test("when the server returns no item, the summary in words stands", async () => {
	await using t = await setup("openai-responses");
	const bodies: unknown[] = [];
	t.env.faux.setResponses([
		answer("覚えました"),
		answer("はい"),
		compactionResponses("猫はミケ。", [], "none"),
		compactionResponses("猫はミケ。", [], "none"),
		sending(bodies),
	]);
	await t.say("猫の名前はミケ");
	await t.say("覚えた？");
	await t.compact();
	await t.say("猫の名前は？");
	assert.ok(JSON.stringify(bodies[0]).includes("猫はミケ。"));
	assert.ok(!JSON.stringify(bodies[0]).includes("opaque"));
});

for (const [maxTokens, compacted] of [
	[50_000, true],
	[90_000, false],
] as const) {
	test(`a conversation of about 60k tokens is ${compacted ? "" : "not "}compacted in the background when maxTokens is ${maxTokens}`, async () => {
		// Two messages of about 30k tokens each; the recent part kept verbatim leaves the older one to summarize.
		await using env = await agentEnv({
			contextWindow: 200_000,
			compactMaxTokens: maxTokens,
			extensions: ({ db }) => [createCompactionExtension({ db, log: () => {} })],
		});
		const bridge = env.bridge();
		const summaries: Request[] = [];
		env.faux.setResponses([
			answer("読みました"),
			answer("はい"),
			compactionResponses("長い話。", summaries),
			answer("はい"),
		]);
		env.link.emit(message(ROOM, "$1", "あ".repeat(4 * 30_000)));
		await bridge.idle();
		env.link.emit(message(ROOM, "$2", "い".repeat(4 * 30_000)));
		await bridge.idle();
		await env.harness.waitForIdle(context);
		assert.equal(summaries.length > 0, compacted);
	});
}

test("background compaction still runs at pi-durable's default threshold when maxTokens exceeds the model's window", async () => {
	await using env = await agentEnv({
		contextWindow: 100_000,
		compactMaxTokens: 200_000,
		extensions: ({ db }) => [createCompactionExtension({ db, log: () => {} })],
	});
	const bridge = env.bridge();
	const summaries: Request[] = [];
	env.faux.setResponses([
		answer("読みました"),
		answer("はい"),
		compactionResponses("長い話。", summaries),
		answer("はい"),
	]);
	env.link.emit(message(ROOM, "$1", "あ".repeat(4 * 30_000)));
	await bridge.idle();
	env.link.emit(message(ROOM, "$2", "い".repeat(4 * 30_000)));
	await bridge.idle();
	await env.harness.waitForIdle(context);
	assert.equal(summaries.length, 1);
});

test("idle compaction waits until the room has been quiet long enough and is large enough, then summarizes once", async () => {
	let now = Date.now();
	await using env = await agentEnv({
		contextWindow: 200_000,
		compactMaxTokens: 180_000,
		now: () => now,
		extensions: ({ db }) => [createCompactionExtension({ db, log: () => {} })],
	});
	const bridge = env.bridge();
	const summaries: Request[] = [];
	const requests: Request[] = [];
	env.faux.setResponses([
		answer("読みました"),
		answer("はい"),
		compactionResponses("長い話の要約。", summaries),
		answer("覚えています", requests),
	]);
	env.link.emit(message(ROOM, "$1", "あ".repeat(4 * 30_000)));
	await bridge.idle();
	env.link.emit(message(ROOM, "$2", "い".repeat(4 * 30_000)));
	await bridge.idle();

	const compactIdle = createIdleCompactor({
		harness: env.harness,
		db: env.db,
		context,
		idleMinutes: 60,
		idleTokens: 50_000,
		now: () => now,
		log: () => {},
	});

	now += 30 * 60_000;
	await compactIdle();
	assert.equal(summaries.length, 0);

	now += 31 * 60_000;
	await compactIdle();
	assert.equal(summaries.length, 1);

	await compactIdle();
	assert.equal(summaries.length, 1);

	env.link.emit(message(ROOM, "$3", "さっきの話は？"));
	await bridge.idle();
	assert.match(everything(requests[0]!), /長い話の要約。/);
});

test("idle compaction retries on the next tick when a compaction fails", async () => {
	let now = Date.now();
	await using env = await agentEnv({
		contextWindow: 200_000,
		compactMaxTokens: 180_000,
		now: () => now,
		extensions: ({ db }) => [createCompactionExtension({ db, log: () => {} })],
	});
	const bridge = env.bridge();
	const summaries: Request[] = [];
	const logs: string[] = [];
	const fail = () => fauxAssistantMessage([], { stopReason: "error", errorMessage: "temporary failure" });
	env.faux.setResponses([
		answer("読みました"),
		answer("はい"),
		fail,
		fail,
		compactionResponses("再試行で成功。", summaries),
	]);
	env.link.emit(message(ROOM, "$1", "あ".repeat(4 * 30_000)));
	await bridge.idle();
	env.link.emit(message(ROOM, "$2", "い".repeat(4 * 30_000)));
	await bridge.idle();

	const compactIdle = createIdleCompactor({
		harness: env.harness,
		db: env.db,
		context,
		idleMinutes: 60,
		idleTokens: 50_000,
		now: () => now,
		log: (msg) => void logs.push(msg),
	});

	now += 61 * 60_000;
	await compactIdle();
	assert.equal(summaries.length, 0);
	assert.ok(logs.some((line) => line.includes("temporary failure")));

	await compactIdle();
	assert.equal(summaries.length, 1);
});

test("idle compaction skips a conversation with an open proactive aside", async () => {
	let now = Date.now();
	await using env = await agentEnv({
		contextWindow: 200_000,
		compactMaxTokens: 180_000,
		now: () => now,
		extensions: ({ db }) => [createCompactionExtension({ db, log: () => {} })],
	});
	const bridge = env.bridge();
	const summaries: Request[] = [];
	env.faux.setResponses([answer("読みました"), answer("はい"), compactionResponses("要約。", summaries)]);
	env.link.emit(message(ROOM, "$1", "あ".repeat(4 * 30_000)));
	await bridge.idle();
	env.link.emit(message(ROOM, "$2", "い".repeat(4 * 30_000)));
	await bridge.idle();

	const mainId = env.db.conversationOf(ROOM)!;
	env.db.addWake({ key: "check:1", roomId: ROOM, kind: "check", content: "確認", createdAt: now });
	env.db.setAside("check:1", { conversationId: mainId + 1, from: { conversationId: mainId, entryId: 1 } });

	const compactIdle = createIdleCompactor({
		harness: env.harness,
		db: env.db,
		context,
		idleMinutes: 60,
		idleTokens: 50_000,
		now: () => now,
		log: () => {},
	});

	now += 61 * 60_000;
	await compactIdle();
	assert.equal(summaries.length, 0);

	env.db.endWake("check:1", "silent");
	await compactIdle();
	assert.equal(summaries.length, 1);
});

test("scheduler tick finishes idle compaction before weighing proactive wakes", async () => {
	const order: string[] = [];
	await using env = await agentEnv();
	const scheduler = new Scheduler({
		config: env.config,
		db: env.db,
		notice: async () => {},
		compactIdle: async () => {
			order.push("compactIdle");
		},
		weigh: () => {
			order.push("weigh");
		},
		log: () => {},
	});
	await scheduler.tick();
	assert.deepEqual(order, ["compactIdle", "weigh"]);
});
