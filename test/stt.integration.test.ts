// Runs the real whisper-server, built by nix, on recordings named by the environment:
//
//   just test-stt ~/a.ogg:~/b.ogg ~/a.txt:~/b.txt
//
// Without them only the tests that need no recording run.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { sttModelPaths } from "../src/stt-paths.ts";
import { WhisperServer, type WhisperServerOptions } from "../src/stt.ts";
import { tempDir } from "./env.ts";

const root = resolve(import.meta.dirname, "..");
const built: Omit<WhisperServerOptions, "socketPath"> = {
	server: process.env.AGENT_WHISPER_SERVER ?? join(root, "stt/whisper.cpp/build/bin/whisper-server"),
	...sttModelPaths(join(root, "stt/models")),
	threads: 6,
	beamSize: 5,
	language: process.env.STT_TEST_LANGUAGE ?? "ja",
	vadSpeechPadMs: 0,
	idleMs: 60_000,
};
const haveServer = [built.server, built.model, built.vadModel].every((path) => existsSync(path));
const audio = process.env.STT_TEST_AUDIO?.split(":").filter((path) => path !== "") ?? [];
const texts = process.env.STT_TEST_TEXT?.split(":").filter((path) => path !== "") ?? [];
if (audio.length > 0 && !haveServer) throw new Error("STT_TEST_AUDIO is set but the server or a model is missing");
const needsRecordings = { skip: audio.length === 0 ? "STT_TEST_AUDIO is not set" : false };

function overlap(script: string, transcript: string): number {
	const normalize = (text: string) => [...text.normalize("NFKC").replace(/[\s\p{P}\p{S}]/gu, "")];
	const [expected, got] = [normalize(script), normalize(transcript)];
	let same = 0;
	for (const char of new Set(expected)) same += Math.min(expected.filter((c) => c === char).length, got.filter((c) => c === char).length);
	return same / expected.length;
}

test("recordings sent side by side to one server are each transcribed close to their scripts", needsRecordings, async () => {
	using dir = tempDir();
	const stt = new WhisperServer({ ...built, socketPath: join(dir.path, "stt.sock") });
	try {
		const results = await Promise.all(audio.map((path) => stt.transcribe(path)));
		for (const [i, text] of results.entries()) {
			const script = texts[i];
			// Not exact: the measured error rate was about 2%, mostly spelling such as 言う for いう.
			if (script !== undefined) assert.ok(overlap(readFileSync(script, "utf8"), text) > 0.9, `${audio[i]}: ${text}`);
			else assert.notEqual(text, "", audio[i] ?? "");
		}
	} finally {
		stt.close();
	}
});

test("a file that is not audio is an error, and the server keeps serving", needsRecordings, async () => {
	using dir = tempDir();
	const stt = new WhisperServer({ ...built, socketPath: join(dir.path, "stt.sock") });
	try {
		const junk = join(dir.path, "junk.ogg");
		writeFileSync(junk, "not audio");
		await assert.rejects(stt.transcribe(junk));
		assert.notEqual(await stt.transcribe(audio[0]!), "");
	} finally {
		stt.close();
	}
});

/** Skips the conversion: these tests are about the server process, not the audio. */
const noAudio = async () => Buffer.alloc(0);

test("a server that cannot be started is an error naming it, not a hang", async () => {
	using dir = tempDir();
	const missing = new WhisperServer({ ...built, server: join(dir.path, "no-such-server"), socketPath: join(dir.path, "a.sock"), toWav: noAudio });
	await assert.rejects(missing.transcribe("x"), /no-such-server/);
});

test("a server that dies at start is an error with its exit code and what it said, not a hang", async () => {
	using dir = tempDir();
	const script = join(dir.path, "dies.sh");
	writeFileSync(script, "#!/bin/sh\necho 'failed to load model' >&2\nexit 3\n", { mode: 0o755 });
	const dies = new WhisperServer({ ...built, server: script, socketPath: join(dir.path, "b.sock"), toWav: noAudio });
	await assert.rejects(dies.transcribe("x"), (error: unknown) => error instanceof Error && /\b3\b/.test(error.message) && error.message.includes("failed to load model"));
});
