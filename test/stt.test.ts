import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { toWav16k } from "../src/stt.ts";
import { readWav } from "../src/tts.ts";
import { tempDir } from "./env.ts";
import { wav } from "./fakes.ts";

const tone = (rate: number) =>
	wav(
		Array.from({ length: rate }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / rate) / 4),
		rate,
	);

let haveFfmpeg = true;
try {
	execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
} catch {
	haveFfmpeg = false;
}

test("a recording already at 16 kHz mono, as a call's utterances are, is passed on as it is", async () => {
	using dir = tempDir();
	const path = join(dir.path, "u.wav");
	writeFileSync(path, tone(16_000));
	assert.deepEqual(await toWav16k(path), readFileSync(path));
});

test("a recording in another form is converted to 16 kHz mono", {
	skip: haveFfmpeg ? false : "ffmpeg is not installed",
}, async () => {
	using dir = tempDir();
	const path = join(dir.path, "v.wav");
	writeFileSync(path, tone(48_000));
	const converted = readWav(await toWav16k(path));
	assert.equal(converted.sampleRate, 16_000);
	assert.ok(Math.abs(converted.samples.length - 16_000) < 100, `${converted.samples.length} samples`);
});
