import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { GatewayEvent } from "../src/gateway.ts";
import { HostDb } from "../src/hostdb.ts";
import type { VoiceOptions } from "../src/rooms.ts";
import type { Transcriber } from "../src/stt.ts";
import { readWav, type Synthesizer, sentences, toSpeech, waveform } from "../src/tts.ts";
import { agentEnv, tempDir } from "./env.ts";
import { answer, lastInput, type Request, wav } from "./fakes.ts";

for (const [rule, markdown, speech] of [
	["a heading is read as a sentence", "## 明日の予定", "明日の予定。"],
	["a list item is read as a sentence, without its marks or emphasis", "- **10:00** 歯医者", "10:00 歯医者。"],
	["a link is read as its text", "[地図](https://maps.example.com/x)を見て", "地図を見て。"],
	["a bare URL is not spelled out", "詳しくは https://example.com を見てください。", "詳しくは （リンク） を見てください。"],
	["a table is read row by row, without its rule", "| 時刻 | 天気 |\n|---|---|\n| 午前 | 晴れ |", "時刻、天気。午前、晴れ。"],
	["code is not read out", "```\nrm -rf /\n```", "（コードは文字で送りました）。"],
	["inline marks are dropped", "*強調*と`コード`", "強調とコード。"],
] as const) {
	test(`for speech, ${rule}`, () => {
		assert.equal(toSpeech(markdown, 400), speech);
	});
}

test("a long answer is read up to the end of the sentence that fits, and says the rest is in the text", () => {
	const spoken = toSpeech("一つ目です。二つ目です。三つ目です。", 12);
	assert.ok(spoken.startsWith("一つ目です。二つ目です。"), spoken);
	assert.ok(!spoken.includes("三つ目"), spoken);
});

test("speech is cut into sentences at their ends, whatever the mark", () => {
	assert.deepEqual(sentences("明日は晴れです。傘はいりません！本当？"), ["明日は晴れです。", "傘はいりません！", "本当？"]);
});

test("a WAV file is read as its rate and samples", () => {
	const pcm = readWav(wav([0, 0.5, -0.5], 4));
	assert.equal(pcm.sampleRate, 4);
	assert.deepEqual([...pcm.samples].map((sample) => Math.round(sample * 100) / 100), [0, 0.5, -0.5]);
});

test("a file that is not a WAV file is refused", () => {
	assert.throws(() => readWav(Buffer.from("not a wav file at all, really")));
});

test("the waveform is the peak of each slice, scaled so the loudest is 1", () => {
	assert.deepEqual(waveform(Float32Array.from([0, 0.25, -0.5, 0.1, 0, 0.05, 0, 0]), 2), [1, 0.1]);
	assert.deepEqual(waveform(new Float32Array(0)), []);
});

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

async function setup(options: { tts?: boolean; voice?: boolean; transcript?: (path: string) => string } = {}) {
	const env = await agentEnv({
		config: {
			personas: { calm: { soul: "soul.md", voice: 8 }, plain: "soul.md" },
			defaultPersona: "calm",
			rooms: { "!plain:example.org": "plain" },
			voice: { stt: {}, ...(options.tts === false ? {} : { tts: { speaker: 3 } }) },
		},
	});
	const transcriber = new FakeTranscriber(options.transcript ?? (() => " 明日の天気は？ "));
	const synthesizer = new FakeSynthesizer();
	const voice: VoiceOptions | undefined =
		options.voice === false ? undefined : { transcriber, ...(options.tts === false ? {} : { synthesizer }), outDir: join(env.dir, "out") };
	const bridge = env.bridge({ voice, sendRetryDelaysMs: [] });
	let n = 0;
	return {
		env,
		transcriber,
		synthesizer,
		recording: (name: string) => {
			const path = join(env.dir, `${name}.ogg`);
			writeFileSync(path, "fake recording");
			return path;
		},
		send: async (path: string, roomId = "!a:example.org", eventId = `$v${++n}`) => {
			const event: GatewayEvent = { type: "message", roomId, eventId, body: "Voice message.ogg", ts: 0, audio: { path, voice: true } };
			env.link.emit(event);
			await bridge.idle();
		},
		[Symbol.asyncDispose]: () => env[Symbol.asyncDispose](),
	};
}

test("a voice message is put to the model as its transcript, marked as heard rather than typed", async () => {
	await using t = await setup();
	const requests: Request[] = [];
	t.env.faux.setResponses([answer("晴れです。", requests)]);
	await t.send(t.recording("v"));
	assert.match(lastInput(requests[0]!), /音声\] 明日の天気は？$/);
});

test("a voice message is answered in text first, then by voice", async () => {
	await using t = await setup();
	t.env.faux.setResponses([fauxAssistantMessage("晴れです。")]);
	await t.send(t.recording("v"));
	assert.deepEqual(
		t.env.link.commands.flatMap((command) => (command.type === "send" ? [`text: ${command.body}`] : command.type === "sendVoice" ? ["voice"] : [])),
		["text: 晴れです。", "voice"],
	);
});

test("the voice reads the answer as it should be heard, not its Markdown", async () => {
	await using t = await setup();
	t.env.faux.setResponses([fauxAssistantMessage("**明日**は[晴れ](https://example.com)です。")]);
	await t.send(t.recording("v"));
	assert.deepEqual(
		t.synthesizer.said.map((said) => said.text),
		[toSpeech("**明日**は[晴れ](https://example.com)です。", t.env.config.voice!.tts!.maxChars)],
	);
});

test("the voice is the room persona's, or the default speaker for a persona without one", async () => {
	await using t = await setup();
	t.env.faux.setResponses([fauxAssistantMessage("はい。"), fauxAssistantMessage("はい。")]);
	await t.send(t.recording("a"), "!a:example.org");
	await t.send(t.recording("b"), "!plain:example.org");
	assert.deepEqual(
		t.synthesizer.said.map((said) => said.speaker),
		[8, 3],
	);
});

test("the recording and the spoken answer are deleted once they are done with", async () => {
	await using t = await setup();
	t.env.faux.setResponses([fauxAssistantMessage("はい。")]);
	const path = t.recording("v");
	await t.send(path);
	assert.equal(existsSync(path), false);
	assert.equal(existsSync(t.env.link.of("sendVoice")[0]!.path), false);
});

test("a voice message offered again after a lost ack is not transcribed or answered again, and its new copy is deleted", async () => {
	await using t = await setup();
	t.env.faux.setResponses([fauxAssistantMessage("はい。")]);
	await t.send(t.recording("v"), "!a:example.org", "$v");
	const again = t.recording("v-again");
	await t.send(again, "!a:example.org", "$v");

	assert.equal(t.transcriber.heard.length, 1);
	assert.equal(t.env.link.of("send").length, 1);
	assert.equal(t.env.link.of("ack").length, 2);
	assert.equal(existsSync(again), false);
});

test("a recording that cannot be transcribed is acked and answered with a notice saying why, without the model", async () => {
	await using t = await setup({
		transcript: () => {
			throw new Error("ffmpeg could not decode the audio");
		},
	});
	await t.send(t.recording("broken"), "!a:example.org", "$broken");

	const [notice] = t.env.link.of("send");
	assert.equal(notice?.notice, true);
	assert.match(notice?.body ?? "", /ffmpeg could not decode the audio/);
	assert.deepEqual(t.env.link.of("ack"), [{ type: "ack", eventId: "$broken" }]);
	assert.equal(t.env.faux.state.callCount, 0);
});

test("a recording in which nothing could be heard is acked and answered with a notice, without the model", async () => {
	await using t = await setup({ transcript: () => "  " });
	await t.send(t.recording("silent"), "!a:example.org", "$silent");

	assert.deepEqual(
		t.env.link.of("send").map((send) => send.notice),
		[true],
	);
	assert.deepEqual(t.env.link.of("ack"), [{ type: "ack", eventId: "$silent" }]);
	assert.equal(t.env.faux.state.callCount, 0);
});

test("without voice set up, a voice message is answered with a notice, without the model", async () => {
	await using t = await setup({ voice: false });
	await t.send(t.recording("v"));
	assert.deepEqual(
		t.env.link.of("send").map((send) => send.notice),
		[true],
	);
	assert.equal(t.env.faux.state.callCount, 0);
});

test("without speech synthesis, a voice message is answered in text only", async () => {
	await using t = await setup({ tts: false });
	t.env.faux.setResponses([fauxAssistantMessage("文字だけです。")]);
	await t.send(t.recording("v"));
	assert.deepEqual(
		t.env.link.of("send").map((send) => send.body),
		["文字だけです。"],
	);
	assert.equal(t.env.link.of("sendVoice").length, 0);
});

test("when speech cannot be made, the text answer stands, a notice says why, and nothing is sent again later", async () => {
	await using t = await setup();
	t.synthesizer.fail = true;
	t.env.faux.setResponses([fauxAssistantMessage("答えです。")]);
	await t.send(t.recording("q"));

	const sent = t.env.link.of("send");
	assert.deepEqual(
		sent.map((send) => send.notice),
		[false, true],
	);
	assert.equal(sent[0]?.body, "答えです。");
	assert.match(sent[1]?.body ?? "", /engine down/);

	await t.env.restart();
	await t.env.bridge().idle();
	assert.equal(t.env.link.of("send").length, 0);
});

test("a ledger made before voice messages keeps its pending answers, as text answers", () => {
	using dir = tempDir();
	const path = join(dir.path, "host.sqlite");
	const old = new DatabaseSync(path);
	old.exec(`CREATE TABLE deliveries (event_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, submission_id INTEGER NOT NULL,
		delivered INTEGER NOT NULL DEFAULT 0, reply_event_id TEXT);
		INSERT INTO deliveries (event_id, room_id, submission_id) VALUES ('$old', '!r:example.org', 4);`);
	old.close();

	const db = new HostDb(path);
	try {
		assert.deepEqual(db.pendingDeliveries(), [{ eventId: "$old", roomId: "!r:example.org", submissionId: 4, voice: false }]);
	} finally {
		db.close();
	}
});
