import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { parseConfig } from "../src/config.ts";
import type { GatewayEvent } from "../src/gateway.ts";
import { openAgentHarness } from "../src/harness.ts";
import { HostDb } from "../src/hostdb.ts";
import { Bridge, type VoiceOptions } from "../src/rooms.ts";
import type { Transcriber } from "../src/stt.ts";
import { readWav, type Synthesizer, toSpeech, waveform } from "../src/tts.ts";
import { FakeLink } from "./fakes.ts";

test("an answer is read aloud without Markdown, links, or table rules, and a long one stops at a sentence end", () => {
	const markdown = [
		"## 明日の予定",
		"",
		"- **10:00** 歯医者（[地図](https://maps.example.com/x)）",
		"- 15:00 打ち合わせ",
		"",
		"| 時刻 | 天気 |",
		"|---|---|",
		"| 午前 | 晴れ |",
		"",
		"```",
		"rm -rf /",
		"```",
		"詳しくは https://example.com を見てください。",
	].join("\n");
	assert.equal(
		toSpeech(markdown, 400),
		"明日の予定。10:00 歯医者（地図）。15:00 打ち合わせ。時刻、天気。午前、晴れ。（コードは文字で送りました）。詳しくは （リンク） を見てください。",
	);
	assert.equal(toSpeech("一つ目です。二つ目です。三つ目です。", 12), "一つ目です。二つ目です。続きは文字で送りました。");
});

function wav(samples: number[], rate = 24000): Buffer {
	const data = Buffer.alloc(samples.length * 2);
	samples.forEach((sample, i) => data.writeInt16LE(Math.round(sample * 32767), i * 2));
	const header = Buffer.alloc(44);
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(36 + data.length, 4);
	header.write("WAVEfmt ", 8, "ascii");
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(rate, 24);
	header.writeUInt32LE(rate * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36, "ascii");
	header.writeUInt32LE(data.length, 40);
	return Buffer.concat([header, data]);
}

test("the WAV VOICEVOX returns gives the duration and a waveform scaled to the loudest part", () => {
	const pcm = readWav(wav([0, 0.25, -0.5, 0.1, 0, 0, 0, 0], 4));
	assert.equal(pcm.sampleRate, 4);
	assert.equal(pcm.samples.length, 8);
	assert.deepEqual(waveform(pcm.samples, 2), [1, 0]);
	assert.deepEqual(waveform(new Float32Array(0)), []);
	assert.throws(() => readWav(Buffer.from("not a wav file at all, really")), /not a WAV/);
});

function setup(options: { tts?: boolean } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "agent-voice-"));
	writeFileSync(join(dir, "soul.md"), "SOUL");
	const faux = fauxProvider();
	const model = faux.getModel();
	const config = parseConfig(
		{
			matrix: { homeserver: "https://example.org", userId: "@agent:example.org", allowedUsers: ["@me:example.org"] },
			model: { provider: model.provider, modelId: model.id },
			personas: { calm: { soul: "soul.md", voice: 8 }, plain: "soul.md" },
			defaultPersona: "calm",
			rooms: { "!plain:example.org": "plain" },
			timezone: "Asia/Tokyo",
			voice: { stt: {}, ...(options.tts === false ? {} : { tts: { speaker: 3 } }) },
		},
		dir,
	);
	const models = createModels();
	models.setProvider(faux.provider);
	const open = async () => ({
		harness: await openAgentHarness(await openNodeSqliteStorage(join(dir, "session.sqlite")), models, context),
		db: new HostDb(join(dir, "host.sqlite")),
	});
	const recording = (name: string) => {
		const path = join(dir, `${name}.ogg`);
		writeFileSync(path, "fake recording");
		return path;
	};
	return { dir, faux, config, open, recording, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function voiceMessage(roomId: string, eventId: string, path: string): GatewayEvent {
	return { type: "message", roomId, eventId, sender: "@me:example.org", body: "Voice message.ogg", ts: Date.UTC(2026, 10, 17, 0, 0), audio: { path, voice: true } };
}

class FakeTranscriber implements Transcriber {
	readonly heard: string[] = [];
	readonly answer: (path: string) => string;
	constructor(answer: (path: string) => string) {
		this.answer = answer;
	}
	async transcribe(path: string): Promise<string> {
		this.heard.push(path);
		return this.answer(path);
	}
}

class FakeSynthesizer implements Synthesizer {
	readonly said: { text: string; speaker: number }[] = [];
	fail = false;
	async synthesize(text: string, speaker: number) {
		if (this.fail) throw new Error("engine down");
		this.said.push({ text, speaker });
		return { ogg: Buffer.from("OggS"), durationMs: 1500, waveform: [0.5, 1] };
	}
	async wav(): Promise<Buffer> {
		throw new Error("voice messages do not use it");
	}
}

test("a voice message is transcribed, marked as heard, and answered in text and then in the room persona's voice", async () => {
	const { dir, faux, config, open, recording, cleanup } = setup();
	const { harness, db } = await open();
	try {
		let seen = "";
		faux.setResponses([
			(request) => {
				seen = JSON.stringify(request.messages);
				return fauxAssistantMessage("**明日**は晴れです。");
			},
		]);
		const link = new FakeLink();
		const transcriber = new FakeTranscriber(() => " 明日の天気は？ ");
		const synthesizer = new FakeSynthesizer();
		const voice: VoiceOptions = { transcriber, synthesizer, outDir: join(dir, "out") };
		const bridge = new Bridge({ harness, db, link, config, context, voice });
		bridge.start();

		const path = recording("v1");
		link.emit(voiceMessage("!a:example.org", "$v1", path));
		await bridge.idle();

		assert.match(seen, /\[2026-11-17\(火\) 09:00 音声\] 明日の天気は？/);
		assert.deepEqual(
			link.commands.filter((c) => c.type === "send" || c.type === "sendVoice").map((c) => c.type),
			["send", "sendVoice"],
		);
		assert.equal(link.of("send")[0]?.body, "**明日**は晴れです。");
		const sent = link.of("sendVoice")[0];
		assert.equal(sent?.txnId, "voice:$v1");
		assert.equal(sent?.durationMs, 1500);
		// The persona of the room sets the voice; the text read is what a listener should hear.
		assert.deepEqual(synthesizer.said, [{ text: "明日は晴れです。", speaker: 8 }]);
		assert.equal(db.isDelivered("$v1"), true);
		assert.equal(existsSync(path), false, "the recording is deleted once admitted");
		assert.equal(existsSync(sent?.path ?? ""), false, "the spoken answer is deleted once sent");

		// Resent after a lost ack: not transcribed or answered again.
		const again = recording("v1-again");
		link.emit(voiceMessage("!a:example.org", "$v1", again));
		await bridge.idle();
		assert.equal(transcriber.heard.length, 1);
		assert.equal(link.of("send").length, 1);
		assert.equal(existsSync(again), false);

		// A room whose persona has no voice of its own speaks with the default speaker.
		faux.setResponses([fauxAssistantMessage("はい。")]);
		link.emit(voiceMessage("!plain:example.org", "$v2", recording("v2")));
		await bridge.idle();
		assert.equal(synthesizer.said[1]?.speaker, 3);
	} finally {
		await harness.close(context);
		db.close();
		cleanup();
	}
});

test("a recording that cannot be understood is answered with a notice and acked, without asking the model", async () => {
	const { dir, faux, config, open, recording, cleanup } = setup();
	const { harness, db } = await open();
	try {
		const link = new FakeLink();
		const transcriber = new FakeTranscriber((path) => {
			if (path.endsWith("broken.ogg")) throw new Error("ffmpeg could not decode the audio");
			return "";
		});
		const bridge = new Bridge({ harness, db, link, config, context, voice: { transcriber, outDir: join(dir, "out") }, log: () => {} });
		bridge.start();

		link.emit(voiceMessage("!a:example.org", "$broken", recording("broken")));
		link.emit(voiceMessage("!a:example.org", "$silent", recording("silent")));
		await bridge.idle();

		assert.deepEqual(
			link.of("send").map((send) => [send.txnId, send.notice, send.body]),
			[
				["stt:$broken", true, "音声を文字にできませんでした（ffmpeg could not decode the audio）。"],
				["stt:$silent", true, "音声を聞き取れませんでした。"],
			],
		);
		assert.deepEqual(
			link.of("ack").map((ack) => ack.eventId),
			["$broken", "$silent"],
		);
		assert.equal(faux.state.callCount, 0);
	} finally {
		await harness.close(context);
		db.close();
		cleanup();
	}
});

test("without voice settings a voice message gets a notice; without speech synthesis it gets a text answer only", async () => {
	const { dir, faux, config, open, recording, cleanup } = setup({ tts: false });
	const { harness, db } = await open();
	try {
		const link = new FakeLink();
		const bridge = new Bridge({ harness, db, link, config, context });
		bridge.start();
		link.emit(voiceMessage("!a:example.org", "$a", recording("a")));
		await bridge.idle();
		assert.equal(link.of("send")[0]?.body, "音声メッセージには対応していません（設定に voice がありません）。");

		faux.setResponses([fauxAssistantMessage("文字だけです。")]);
		const voicedLink = new FakeLink();
		const voiced = new Bridge({ harness, db, link: voicedLink, config, context, voice: { transcriber: new FakeTranscriber(() => "こんにちは"), outDir: join(dir, "out") } });
		voiced.start();
		voicedLink.emit(voiceMessage("!a:example.org", "$b", recording("b")));
		await voiced.idle();
		assert.equal(voicedLink.of("send")[0]?.body, "文字だけです。");
		assert.equal(voicedLink.of("sendVoice").length, 0);
		assert.equal(db.isDelivered("$b"), true);
	} finally {
		await harness.close(context);
		db.close();
		cleanup();
	}
});

test("when speech cannot be made, the text answer stands and the room is told why the voice is missing", async () => {
	const { dir, faux, config, open, recording, cleanup } = setup();
	const { harness, db } = await open();
	try {
		faux.setResponses([fauxAssistantMessage("答えです。")]);
		const link = new FakeLink();
		const synthesizer = new FakeSynthesizer();
		synthesizer.fail = true;
		const voice = { transcriber: new FakeTranscriber(() => "質問"), synthesizer, outDir: join(dir, "out") };
		const bridge = new Bridge({ harness, db, link, config, context, voice, sendRetryDelaysMs: [1], log: () => {} });
		bridge.start();
		link.emit(voiceMessage("!a:example.org", "$q", recording("q")));
		await bridge.idle();

		assert.deepEqual(
			link.of("send").map((send) => [send.txnId, send.body]),
			[
				["reply:$q", "答えです。"],
				["voicefail:$q", "音声の返答を作れませんでした（engine down）。"],
			],
		);
		assert.equal(db.isDelivered("$q"), true);
	} finally {
		await harness.close(context);
		db.close();
		cleanup();
	}
});

test("a ledger made before voice messages gains the column and keeps its pending answers", () => {
	const dir = mkdtempSync(join(tmpdir(), "agent-ledger-"));
	try {
		const path = join(dir, "host.sqlite");
		const old = new DatabaseSync(path);
		old.exec(`CREATE TABLE deliveries (event_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, submission_id INTEGER NOT NULL,
			delivered INTEGER NOT NULL DEFAULT 0, reply_event_id TEXT);
			INSERT INTO deliveries (event_id, room_id, submission_id) VALUES ('$old', '!r:example.org', 4);`);
		old.close();

		const db = new HostDb(path);
		assert.deepEqual(db.pendingDeliveries(), [{ eventId: "$old", roomId: "!r:example.org", submissionId: 4, voice: false }]);
		db.addDelivery({ eventId: "$new", roomId: "!r:example.org", submissionId: 5, voice: true });
		assert.equal(db.pendingDeliveries()[1]?.voice, true);
		db.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
