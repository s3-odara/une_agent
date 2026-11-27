import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Approvals } from "../src/approval.ts";
import { Calls } from "../src/call.ts";
import { HostDb } from "../src/hostdb.ts";
import type { Transcriber } from "../src/stt.ts";
import type { Synthesizer } from "../src/tts.ts";
import { agentEnv, tempDir } from "./env.ts";
import { answer } from "./fakes.ts";

const ROOM = "!call:example.org";

class SimpleTranscriber implements Transcriber {
	async transcribe(): Promise<string> {
		return "こんにちは";
	}
}

test("leaving the call while speech audio is being written to disk does not hang playback", async () => {
	await using env = await agentEnv({
		config: { voice: { stt: {}, tts: { speaker: 3 }, call: { chime: false } } },
	});
	const bridge = env.bridge();
	env.faux.setResponses([answer("了解しました")]);

	let onWavCalled!: () => void;
	const wavCalled = new Promise<void>((resolve) => (onWavCalled = resolve));
	const synthesizer: Synthesizer = {
		synthesize: async () => {
			throw new Error("unused");
		},
		wav: async () => {
			onWavCalled();
			return Buffer.from("RIFF");
		},
	};

	const calls = new Calls({
		link: env.link,
		config: env.config,
		transcriber: new SimpleTranscriber(),
		synthesizer,
		ask: (roomId, key, content) => bridge.ask(roomId, key, content),
		notice: (roomId, key, body) => bridge.notice(roomId, key, body),
		outDir: join(env.dir, "out"),
		log: () => {},
	});
	calls.start();

	env.link.speak = (command) => ({ type: "callSpoken", roomId: command.roomId, id: command.id });

	const uttPath = join(env.dir, "u1.wav");
	writeFileSync(uttPath, "RIFF");
	env.link.emit({ type: "callUtterance", roomId: ROOM, path: uttPath, startedAt: Date.now() });

	await wavCalled;
	await Promise.resolve();
	env.link.emit({ type: "callLeft", roomId: ROOM, reason: "" });

	const settled = await Promise.race([
		calls.idle().then(() => "settled"),
		new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 500)),
	]);
	assert.equal(settled, "settled");
});

test("a failed approval prompt does not hijack !approve meant for a later visible prompt", async () => {
	using dir = tempDir();
	const db = new HostDb(join(dir.path, "host.sqlite"));
	try {
		let failPost = true;
		let eventSeq = 0;
		const approvals = new Approvals({
			db,
			notice: async () => {
				if (failPost) throw new Error("homeserver down");
				return `$prompt-${++eventSeq}`;
			},
			react: async () => {},
			log: () => {},
		});

		await assert.rejects(
			approvals.ask({ id: "a1", roomId: ROOM, runKey: "1:1", tool: "calendar_delete", summary: "古い予定を削除" }),
			/homeserver down/,
		);

		failPost = false;
		const second = approvals.ask({ id: "a2", roomId: ROOM, runKey: "1:2", tool: "calendar_update", summary: "新しい予定を変更" });
		await new Promise((resolve) => setTimeout(resolve, 20));

		const handled = approvals.onMessage({ roomId: ROOM, body: "!approve" });
		assert.equal(handled.handled, true);
		assert.match(handled.reply ?? "", /新しい予定を変更/);

		const outcome = await second;
		assert.deepEqual(outcome, { approved: true, by: "approve" });
	} finally {
		db.close();
	}
});
