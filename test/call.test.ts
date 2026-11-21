import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { Calls, OVERTAKEN } from "../src/call.ts";
import type { GatewayEvent } from "../src/gateway.ts";
import type { Transcriber } from "../src/stt.ts";
import { readWav, type Synthesizer, toSpeech } from "../src/tts.ts";
import { agentEnv, ME } from "./env.ts";
import { answer, lastInput, message, type Request } from "./fakes.ts";

const ROOM = "!call:example.org";

class FakeTranscriber implements Transcriber {
	readonly texts = new Map<string, string>();
	transcribing = () => {};
	async transcribe(path: string): Promise<string> {
		this.transcribing();
		return this.texts.get(path) ?? "";
	}
}

class FakeSynthesizer implements Synthesizer {
	readonly made: { text: string; speaker: number; sampleRate: number }[] = [];
	fail = false;
	making = () => {};
	async synthesize(): Promise<never> {
		throw new Error("calls do not send voice messages");
	}
	async wav(text: string, speaker: number, sampleRate: number): Promise<Buffer> {
		if (this.fail) throw new Error("engine down");
		this.making();
		this.made.push({ text, speaker, sampleRate });
		return Buffer.from(`RIFF ${text}`);
	}
}

async function setup(call: { chime?: boolean } = {}) {
	const env = await agentEnv({
		config: {
			personas: { calm: { soul: "soul.md", voice: 8 } },
			defaultPersona: "calm",
			voice: { stt: {}, tts: { speaker: 3 }, call: { chime: false, ...call, vad: { endSilenceMs: 700 } } },
		},
	});
	const bridge = env.bridge();
	const transcriber = new FakeTranscriber();
	const synthesizer = new FakeSynthesizer();
	const calls = new Calls({
		link: env.link,
		config: env.config,
		transcriber,
		synthesizer,
		ask: (roomId, key, content) => bridge.ask(roomId, key, content),
		notice: (roomId, key, body) => bridge.notice(roomId, key, body),
		outDir: join(env.dir, "out"),
		log: () => {},
	});
	calls.start();
	const played: Buffer[] = [];
	env.link.speak = (command) => {
		played.push(readFileSync(command.path));
		return { type: "callSpoken", roomId: command.roomId, id: command.id };
	};
	let n = 0;
	const utterance = (text: string): Extract<GatewayEvent, { type: "callUtterance" }> => {
		const path = join(env.dir, `call-${++n}.wav`);
		writeFileSync(path, "RIFF");
		transcriber.texts.set(path, text);
		return { type: "callUtterance", roomId: ROOM, path, startedAt: Date.UTC(2026, 10, 18, 3, 0) };
	};
	const settle = async () => {
		await calls.idle();
		await bridge.idle();
	};
	return {
		env,
		link: env.link,
		transcriber,
		synthesizer,
		played,
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

test("the answer is spoken whole, in the persona's voice", async () => {
	await using t = await setup();
	const text = "**明日**は晴れです。傘はいりません。";
	t.env.faux.setResponses([fauxAssistantMessage(text)]);
	t.inCall();
	await t.say("明日の天気は？");

	assert.deepEqual(
		t.synthesizer.made,
		[{ text: toSpeech(text, t.env.config.voice!.call!.maxChars), speaker: 8, sampleRate: 48_000 }],
	);
	assert.equal(t.link.of("callSpeak").length, 1);
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

test("an answer overtaken by the user speaking again is not spoken, and the persona is told it did not get across", async () => {
	await using t = await setup();
	const requests: Request[] = [];
	t.env.faux.setResponses([
		() => {
			// The user starts speaking again while the model writes.
			t.link.emit({ type: "callSpeech", roomId: ROOM });
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

test("an answer overtaken while its voice is being made is not spoken, and the persona is told it did not get across", async () => {
	await using t = await setup();
	const requests: Request[] = [];
	t.env.faux.setResponses([fauxAssistantMessage("古い答えです。"), answer("新しい答えです。", requests)]);
	t.synthesizer.making = () => {
		t.synthesizer.making = () => {};
		t.link.emit({ type: "callSpeech", roomId: ROOM });
	};
	t.inCall();
	await t.say("最初の話");
	assert.deepEqual(t.link.of("callSpeak"), []);

	await t.say("続きの話");
	assert.ok(lastInput(requests[0]!).includes(OVERTAKEN));
});

test("silence is not put to the model", async () => {
	await using t = await setup();
	t.inCall();
	await t.say("");
	assert.equal(t.env.faux.state.callCount, 0);
});

test("an answer stopped by !new produces no answer or failure notice", async () => {
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
		["notice:callheard:call-1.wav", "cmd:$1"],
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

test("once an utterance is recognized, a chime plays in the call before the answer", async () => {
	await using t = await setup({ chime: true });
	t.env.faux.setResponses([fauxAssistantMessage("晴れです。")]);
	t.inCall();
	await t.say("明日の天気は？");

	const [chime, ...speech] = t.played;
	assert.equal(readWav(chime!).sampleRate, 48_000);
	assert.deepEqual(
		speech.map(String),
		["RIFF 晴れです。"],
	);
});

test("no chime plays once the user has started speaking again", async () => {
	await using t = await setup({ chime: true });
	t.env.faux.setResponses([fauxAssistantMessage("晴れです。")]);
	t.transcriber.transcribing = () => t.link.emit({ type: "callSpeech", roomId: ROOM });
	t.inCall();
	await t.say("明日の天気は？");
	assert.deepEqual(t.link.of("callSpeak"), []);
});

test("silence plays no chime", async () => {
	await using t = await setup({ chime: true });
	t.inCall();
	await t.say("");
	assert.deepEqual(t.link.of("callSpeak"), []);
});

test("what was heard and the answer are written to the room as notices, in that order", async () => {
	await using t = await setup();
	t.env.faux.setResponses([fauxAssistantMessage("**明日**は晴れです。")]);
	t.inCall();
	await t.say("明日の天気は？");

	const sends = t.link.of("send");
	assert.ok(sends.every((send) => send.notice === true));
	assert.deepEqual(sends.map((send) => send.body), ["🎤 明日の天気は？", "**明日**は晴れです。"]);
});

test("an answer overtaken by the user speaking again is still written to the room", async () => {
	await using t = await setup();
	t.env.faux.setResponses([
		() => {
			t.link.emit({ type: "callSpeech", roomId: ROOM });
			return fauxAssistantMessage("古い答えです。");
		},
	]);
	t.inCall();
	await t.say("最初の話");

	assert.deepEqual(t.synthesizer.made, []);
	assert.match(t.link.bodyIn(ROOM), /古い答えです。/);
});

test("when speech cannot be made, the room gets the answer once and is told why", async () => {
	await using t = await setup();
	t.synthesizer.fail = true;
	t.env.faux.setResponses([fauxAssistantMessage("答えです。")]);
	t.inCall();
	await t.say("聞こえる？");

	const bodies = t.link.of("send").map((send) => send.body);
	assert.equal(bodies.filter((body) => body.includes("答えです。")).length, 1);
	assert.ok(bodies.some((body) => body.includes("engine down")));
});
