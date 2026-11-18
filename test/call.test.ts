import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { Calls, OVERTAKEN } from "../src/call.ts";
import type { GatewayEvent } from "../src/gateway.ts";
import { type Synthesizer, sentences, toSpeech } from "../src/tts.ts";
import { agentEnv, ME } from "./env.ts";
import { answer, lastInput, message, type Request } from "./fakes.ts";

const ROOM = "!call:example.org";

class FakeSynthesizer implements Synthesizer {
	readonly made: { text: string; speaker: number; sampleRate: number }[] = [];
	fail = false;
	async synthesize(): Promise<never> {
		throw new Error("calls do not send voice messages");
	}
	async wav(text: string, speaker: number, sampleRate: number): Promise<Buffer> {
		if (this.fail) throw new Error("engine down");
		this.made.push({ text, speaker, sampleRate });
		return Buffer.from(`RIFF ${text}`);
	}
}

async function setup() {
	const env = await agentEnv({
		config: { personas: { calm: { soul: "soul.md", voice: 8 } }, defaultPersona: "calm", voice: { stt: {}, tts: { speaker: 3 }, call: { vad: { endSilenceMs: 700 } } } },
	});
	const bridge = env.bridge();
	const transcripts = new Map<string, string>();
	const synthesizer = new FakeSynthesizer();
	const calls = new Calls({
		link: env.link,
		config: env.config,
		transcriber: { transcribe: async (path) => transcripts.get(path) ?? "" },
		synthesizer,
		ask: (roomId, key, content) => bridge.ask(roomId, key, content),
		notice: (roomId, key, body) => bridge.notice(roomId, key, body),
		outDir: join(env.dir, "out"),
		log: () => {},
	});
	calls.start();
	env.link.speak = (command) => ({ type: "callSpoken", roomId: command.roomId, id: command.id, playedMs: 900, interrupted: false });
	let n = 0;
	const utterance = (text: string): Extract<GatewayEvent, { type: "callUtterance" }> => {
		const path = join(env.dir, `call-${++n}.wav`);
		writeFileSync(path, "RIFF");
		transcripts.set(path, text);
		return { type: "callUtterance", roomId: ROOM, userId: ME, path, startedAt: Date.UTC(2026, 10, 18, 3, 0), durationMs: 1200 };
	};
	const settle = async () => {
		await calls.idle();
		await bridge.idle();
	};
	return {
		env,
		link: env.link,
		synthesizer,
		utterance,
		settle,
		inCall: () => {
			env.link.emit({ type: "callMembers", roomId: ROOM, userIds: [ME] });
			env.link.emit({ type: "callJoined", roomId: ROOM });
		},
		say: async (text: string) => {
			env.link.emit(utterance(text));
			await settle();
		},
		[Symbol.asyncDispose]: () => env[Symbol.asyncDispose](),
	};
}

test("the bot joins a room's call once an allowed user is in it, cutting speech as configured", async () => {
	await using t = await setup();
	t.link.emit({ type: "callMembers", roomId: ROOM, userIds: [ME] });
	t.link.emit({ type: "callMembers", roomId: ROOM, userIds: [ME, "@you:example.org"] });
	assert.deepEqual(t.link.of("joinCall"), [{ type: "joinCall", roomId: ROOM, vad: t.env.config.voice!.call!.vad }]);
});

test("the bot leaves the call once everyone has left it", async () => {
	await using t = await setup();
	t.inCall();
	t.link.emit({ type: "callMembers", roomId: ROOM, userIds: [] });
	assert.deepEqual(t.link.of("leaveCall"), [{ type: "leaveCall", roomId: ROOM }]);
});

test("what is said in a call goes to the room's conversation, marked as said in a call", async () => {
	await using t = await setup();
	const requests: Request[] = [];
	t.env.faux.setResponses([answer("晴れです。", requests)]);
	t.inCall();
	await t.say("明日の天気は？");
	assert.match(lastInput(requests[0]!), /通話\] 明日の天気は？$/);
});

test("the answer is spoken a sentence at a time, in the persona's voice, and nothing is written to the room", async () => {
	await using t = await setup();
	const text = "**明日**は晴れです。傘はいりません。";
	t.env.faux.setResponses([fauxAssistantMessage(text)]);
	t.inCall();
	await t.say("明日の天気は？");

	assert.deepEqual(
		t.synthesizer.made,
		sentences(toSpeech(text, t.env.config.voice!.call!.maxChars)).map((sentence) => ({ text: sentence, speaker: 8, sampleRate: 48_000 })),
	);
	assert.equal(t.link.of("callSpeak").length, 2);
	assert.deepEqual(t.link.of("send"), []);
});

test("the utterance and the speech files are deleted once done with", async () => {
	await using t = await setup();
	t.env.faux.setResponses([fauxAssistantMessage("晴れです。")]);
	t.inCall();
	const utterance = t.utterance("明日の天気は？");
	t.link.emit(utterance);
	await t.settle();
	assert.equal(existsSync(utterance.path), false);
	assert.ok(t.link.of("callSpeak").every((command) => !existsSync(command.path)));
});

async function talkedOver(t: Awaited<ReturnType<typeof setup>>, requests: Request[]) {
	t.env.faux.setResponses([fauxAssistantMessage("一つ目です。二つ目です。三つ目です。"), answer("はい。", requests)]);
	let played = 0;
	t.link.speak = (command) => ({ type: "callSpoken", roomId: command.roomId, id: command.id, playedMs: 400, interrupted: ++played === 2 });
	t.inCall();
	await t.say("三つ言って");
}

test("talking over the bot stops it: the rest of its answer is not played", async () => {
	await using t = await setup();
	await talkedOver(t, []);
	assert.equal(t.link.of("callSpeak").length, 2);
});

test("after being talked over, the persona is told with the next utterance how far its answer got", async () => {
	await using t = await setup();
	const requests: Request[] = [];
	await talkedOver(t, requests);
	await t.say("ちょっと待って");

	const next = lastInput(requests[0]!);
	assert.match(next, /一つ目です。二つ目です。/);
	assert.doesNotMatch(next, /三つ目/);
	assert.match(next, /ちょっと待って$/);
});

test("an answer overtaken by the user speaking again is not spoken, and the persona is told it did not get across", async () => {
	await using t = await setup();
	const requests: Request[] = [];
	t.env.faux.setResponses([
		() => {
			// The user starts speaking again while the model writes.
			t.link.emit({ type: "callSpeech", roomId: ROOM, userId: ME });
			return fauxAssistantMessage("古い答えです。");
		},
		answer("新しい答えです。", requests),
	]);
	t.inCall();
	t.link.emit(t.utterance("最初の話"));
	t.link.emit(t.utterance("続きの話"));
	await t.settle();

	assert.deepEqual(
		t.synthesizer.made.map((made) => made.text),
		["新しい答えです。"],
	);
	assert.ok(lastInput(requests[0]!).includes(OVERTAKEN));
});

test("silence is not put to the model", async () => {
	await using t = await setup();
	t.inCall();
	await t.say("");
	assert.equal(t.env.faux.state.callCount, 0);
});

test("when speech cannot be made, the room gets the answer in text, with why", async () => {
	await using t = await setup();
	t.synthesizer.fail = true;
	t.env.faux.setResponses([fauxAssistantMessage("答えです。")]);
	t.inCall();
	await t.say("聞こえる？");

	const [notice] = t.link.of("send");
	assert.equal(notice?.notice, true);
	assert.match(notice?.body ?? "", /engine down/);
	assert.match(notice?.body ?? "", /答えです。/);
});

test("an answer stopped by !new is not told to the room as a failure; only !new is answered", async () => {
	await using t = await setup();
	const { promise: writing, resolve: started } = Promise.withResolvers<void>();
	t.env.faux.setResponses([
		(_context, options) =>
			new Promise((_resolve, reject) => {
				started();
				options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
			}),
	]);
	t.inCall();
	t.link.emit(t.utterance("長い質問"));
	await writing;
	t.link.emit(message(ROOM, "$1", "!new"));
	await t.settle();

	assert.deepEqual(
		t.link.of("send").map((send) => send.txnId),
		["cmd:$1"],
	);
	assert.deepEqual(t.link.of("callSpeak"), []);
});

test("being put out of a call is told to the room, with why", async () => {
	await using t = await setup();
	t.inCall();
	t.link.emit({ type: "callLeft", roomId: ROOM, reason: "joining the call: no LiveKit focus" });
	await t.settle();
	assert.match(t.link.bodyIn(ROOM), /no LiveKit focus/);
});
