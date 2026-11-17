// Runs the real whisper-server when `sh stt/install.sh` has built it, on recordings named by the environment:
//
//   STT_TEST_AUDIO=~/a.ogg:~/b.ogg STT_TEST_TEXT=~/a.txt:~/b.txt node --test test/stt.integration.test.ts
//
// Without them only the tests that need no recording run.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { WhisperServer, type WhisperServerOptions } from "../src/stt.ts";

const root = resolve(import.meta.dirname, "..");
const built: Omit<WhisperServerOptions, "socketPath"> = {
	server: join(root, "stt/whisper.cpp/build/bin/whisper-server"),
	model: join(root, "stt/models/ggml-large-v3-turbo-q8_0.bin"),
	vadModel: join(root, "stt/models/ggml-silero-v5.1.2.bin"),
	threads: 6,
	beamSize: 5,
	language: "ja",
	vadSpeechPadMs: 0,
	idleMs: 60_000,
};
const haveServer = [built.server, built.model, built.vadModel].every((path) => existsSync(path));
const audio = process.env.STT_TEST_AUDIO?.split(":").filter((path) => path !== "") ?? [];
const texts = process.env.STT_TEST_TEXT?.split(":").filter((path) => path !== "") ?? [];

function withDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "agent-stt-"));
	return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const normalize = (text: string) => text.normalize("NFKC").replace(/[\s\p{P}\p{S}]/gu, "");

test("recordings are transcribed by one server, side by side, close to their scripts", { skip: !haveServer || audio.length === 0 }, () =>
	withDir(async (dir) => {
		const stt = new WhisperServer({ ...built, socketPath: join(dir, "stt.sock") });
		try {
			const results = await Promise.all(audio.map((path) => stt.transcribe(path)));
			results.forEach((text, i) => {
				const script = texts[i];
				console.log(`${audio[i]}: ${text}`);
				if (script === undefined) return;
				const expected = normalize(readFileSync(script, "utf8"));
				const got = normalize(text);
				// Not exact: the measured error rate was about 2%, mostly spelling such as 言う for いう.
				let same = 0;
				for (const char of new Set(expected)) same += Math.min([...expected].filter((c) => c === char).length, [...got].filter((c) => c === char).length);
				assert.ok(same / expected.length > 0.9, `${audio[i]}: ${text}`);
			});
		} finally {
			stt.close();
		}
	}),
);

test("a file that is not audio is an error, and the server keeps serving", { skip: !haveServer || audio.length === 0 }, () =>
	withDir(async (dir) => {
		const stt = new WhisperServer({ ...built, socketPath: join(dir, "stt.sock") });
		try {
			const junk = join(dir, "junk.ogg");
			writeFileSync(junk, "not audio");
			await assert.rejects(stt.transcribe(junk), /ffmpeg could not decode/);
			assert.notEqual(await stt.transcribe(audio[0] as string), "");
		} finally {
			stt.close();
		}
	}),
);

test("a server that cannot start is an error with its reason, not a hang", () =>
	withDir(async (dir) => {
		const wav = async () => Buffer.alloc(0);
		const missing = new WhisperServer({ ...built, server: join(dir, "no-such-server"), socketPath: join(dir, "a.sock"), toWav: wav });
		await assert.rejects(missing.transcribe("x"), /could not be started/);

		const script = join(dir, "dies.sh");
		writeFileSync(script, "#!/bin/sh\necho 'failed to load model' >&2\nexit 3\n", { mode: 0o755 });
		const dies = new WhisperServer({ ...built, server: script, socketPath: join(dir, "b.sock"), toWav: wav });
		await assert.rejects(dies.transcribe("x"), /exited \(3\): failed to load model/);
	}),
);
