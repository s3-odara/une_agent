import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Calls } from "../src/call.ts";
import { parseConfig } from "../src/config.ts";
import type { GatewayEvent } from "../src/gateway.ts";
import { openAgentHarness } from "../src/harness.ts";
import { HostDb } from "../src/hostdb.ts";
import { Bridge } from "../src/rooms.ts";
import type { Synthesizer } from "../src/tts.ts";
import { FakeLink } from "./fakes.ts";

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
	const dir = mkdtempSync(join(tmpdir(), "agent-call-"));
	writeFileSync(join(dir, "soul.md"), "SOUL");
	const faux = fauxProvider();
	const model = faux.getModel();
	const config = parseConfig(
		{
			matrix: { homeserver: "https://example.org", userId: "@agent:example.org", allowedUsers: ["@me:example.org"] },
			model: { provider: model.provider, modelId: model.id },
			personas: { calm: { soul: "soul.md", voice: 8 } },
			defaultPersona: "calm",
			timezone: "Asia/Tokyo",
			voice: { stt: {}, tts: { speaker: 3 }, call: { vad: { endSilenceMs: 700 } } },
		},
		dir,
	);
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await openAgentHarness(await openNodeSqliteStorage(join(dir, "session.sqlite")), models, context);
	const db = new HostDb(join(dir, "host.sqlite"));
	const link = new FakeLink();
	const bridge = new Bridge({ harness, db, link, config, context });
	bridge.start();
	const heard: string[] = [];
	const transcripts = new Map<string, string>();
	const synthesizer = new FakeSynthesizer();
	const calls = new Calls({
		link,
		config,
		transcriber: {
			transcribe: async (path) => {
				heard.push(path);
				return transcripts.get(path) ?? "";
			},
		},
		synthesizer,
		ask: (roomId, key, content) => bridge.ask(roomId, key, content),
		notice: (roomId, key, body) => bridge.notice(roomId, key, body),
		outDir: join(dir, "out"),
		log: () => {},
	});
	calls.start();
	let n = 0;
	/** An utterance the gateway would pass on, transcribed as `text`. */
	const say = (text: string): GatewayEvent => {
		const path = join(dir, `call-${++n}.wav`);
		writeFileSync(path, "RIFF");
		transcripts.set(path, text);
		return { type: "callUtterance", roomId: ROOM, userId: "@me:example.org", path, startedAt: Date.UTC(2026, 10, 18, 3, 0), durationMs: 1200 };
	};
	const settle = async () => {
		await calls.idle();
		await bridge.idle();
	};
	return {
		dir,
		faux,
		link,
		calls,
		synthesizer,
		heard,
		say,
		settle,
		cleanup: async () => {
			await harness.close(context);
			db.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("the bot joins a room's call once an allowed user is in it, and leaves when they all have", async () => {
	const { link, cleanup } = await setup();
	try {
		link.emit({ type: "callMembers", roomId: ROOM, userIds: ["@me:example.org"] });
		link.emit({ type: "callMembers", roomId: ROOM, userIds: ["@me:example.org", "@you:example.org"] });
		assert.deepEqual(link.of("joinCall"), [
			{ type: "joinCall", roomId: ROOM, vad: { threshold: 0.5, startMs: 208, endSilenceMs: 700, minSpeechMs: 300, maxMs: 30_000, preRollMs: 300 } },
		]);
		link.emit({ type: "callJoined", roomId: ROOM });
		link.emit({ type: "callMembers", roomId: ROOM, userIds: [] });
		assert.deepEqual(link.of("leaveCall"), [{ type: "leaveCall", roomId: ROOM }]);
	} finally {
		await cleanup();
	}
});

test("what is said in a call goes to the room's conversation and the answer is spoken a sentence at a time", async () => {
	const { link, faux, synthesizer, say, settle, heard, cleanup } = await setup();
	try {
		let seen = "";
		faux.setResponses([
			(request) => {
				seen = JSON.stringify(request.messages);
				return fauxAssistantMessage("**明日**は晴れです。傘はいりません。");
			},
		]);
		link.speak = (command) => ({ type: "callSpoken", roomId: command.roomId, id: command.id, playedMs: 900, interrupted: false });
		link.emit({ type: "callMembers", roomId: ROOM, userIds: ["@me:example.org"] });
		link.emit({ type: "callJoined", roomId: ROOM });
		const utterance = say("明日の天気は？");
		link.emit(utterance);
		await settle();

		assert.match(seen, /\[2026-11-18\(水\) 12:00 通話\] 明日の天気は？/);
		assert.deepEqual(synthesizer.made, [
			{ text: "明日は晴れです。", speaker: 8, sampleRate: 48_000 },
			{ text: "傘はいりません。", speaker: 8, sampleRate: 48_000 },
		]);
		const spoken = link.of("callSpeak");
		assert.equal(spoken.length, 2);
		assert.ok(spoken.every((command) => command.roomId === ROOM && !existsSync(command.path)), "speech files are deleted once played");
		assert.equal(heard.length, 1);
		assert.equal(existsSync(utterance.type === "callUtterance" ? utterance.path : ""), false, "the utterance is deleted once heard");
		// Nothing is written to the room.
		assert.deepEqual(link.of("send"), []);
	} finally {
		await cleanup();
	}
});

test("talking over the bot stops it, and the persona hears how far it got", async () => {
	const { link, faux, synthesizer, say, settle, cleanup } = await setup();
	try {
		let second = "";
		faux.setResponses([
			() => fauxAssistantMessage("一つ目です。二つ目です。三つ目です。"),
			(request) => {
				second = JSON.stringify(request.messages);
				return fauxAssistantMessage("はい。");
			},
		]);
		let speaks = 0;
		link.speak = (command) => ({ type: "callSpoken", roomId: command.roomId, id: command.id, playedMs: 400, interrupted: ++speaks === 2 });
		link.emit({ type: "callMembers", roomId: ROOM, userIds: ["@me:example.org"] });
		link.emit(say("三つ言って"));
		await settle();
		assert.equal(link.of("callSpeak").length, 2, "the third sentence is not played");

		link.emit(say("ちょっと待って"));
		await settle();
		assert.match(second, /\[2026-11-18\(水\) 12:00 通話\] （直前の返答は「一つ目です。二つ目です。（の途中）」まで話したところで遮られました）ちょっと待って/);
		assert.ok(synthesizer.made.length <= 4);
	} finally {
		await cleanup();
	}
});

test("an answer overtaken by the user speaking again is not spoken", async () => {
	const { link, faux, synthesizer, say, settle, cleanup } = await setup();
	try {
		let second = "";
		faux.setResponses([
			() => {
				// The user starts speaking again while the model writes.
				link.emit({ type: "callSpeech", roomId: ROOM, userId: "@me:example.org" });
				return fauxAssistantMessage("古い答えです。");
			},
			(request) => {
				second = JSON.stringify(request.messages);
				return fauxAssistantMessage("新しい答えです。");
			},
		]);
		link.speak = (command) => ({ type: "callSpoken", roomId: command.roomId, id: command.id, playedMs: 900, interrupted: false });
		link.emit({ type: "callMembers", roomId: ROOM, userIds: ["@me:example.org"] });
		link.emit(say("最初の話"));
		link.emit(say("続きの話"));
		await settle();
		assert.deepEqual(
			synthesizer.made.map((made) => made.text),
			["新しい答えです。"],
		);
		assert.match(second, /（直前の返答は、読み上げる前にユーザーが話し始めたので伝わっていません）続きの話/);
	} finally {
		await cleanup();
	}
});

test("silence is not put to the model, and failures are told in the room", async () => {
	const { link, faux, synthesizer, say, settle, cleanup } = await setup();
	try {
		let asked = 0;
		faux.setResponses([
			() => {
				asked++;
				return fauxAssistantMessage("答えです。");
			},
		]);
		link.emit({ type: "callMembers", roomId: ROOM, userIds: ["@me:example.org"] });
		link.emit(say(""));
		await settle();
		assert.equal(asked, 0);

		synthesizer.fail = true;
		link.emit(say("聞こえる？"));
		await settle();
		assert.match(link.bodyIn(ROOM), /音声を作れなかったので文字で送ります（engine down）。\n\n答えです。/);

		link.emit({ type: "callLeft", roomId: ROOM, reason: "joining the call: no LiveKit focus" });
		await settle();
		assert.match(link.bodyIn(ROOM), /通話から抜けました（joining the call: no LiveKit focus）。/);
	} finally {
		await cleanup();
	}
});

test("calls need speech synthesis", () => {
	assert.throws(
		() =>
			parseConfig(
				{
					matrix: { homeserver: "https://example.org", userId: "@agent:example.org", allowedUsers: ["@me:example.org"] },
					model: { provider: "x", modelId: "y" },
					personas: { calm: "soul.md" },
					defaultPersona: "calm",
					voice: { stt: {}, call: {} },
				},
				"/tmp",
			),
		/voice\.call needs voice\.tts/,
	);
});
