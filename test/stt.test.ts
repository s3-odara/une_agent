import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { toWav16k } from "../src/stt.ts";
import { readWav } from "../src/tts.ts";
import { tempDir } from "./env.ts";

/** A mono 16-bit WAV file of a second of a 440 Hz tone at `rate`. */
function tone(rate: number): Buffer {
	const data = Buffer.alloc(rate * 2);
	for (let i = 0; i < rate; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), i * 2);
	const header = Buffer.alloc(44);
	header.write("RIFFxxxxWAVEfmt ", 0, "latin1");
	header.writeUInt32LE(36 + data.length, 4);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(rate, 24);
	header.writeUInt32LE(rate * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36, "latin1");
	header.writeUInt32LE(data.length, 40);
	return Buffer.concat([header, data]);
}

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

test("a recording in another form is converted to 16 kHz mono", { skip: haveFfmpeg ? false : "ffmpeg is not installed" }, async () => {
	using dir = tempDir();
	const path = join(dir.path, "v.wav");
	writeFileSync(path, tone(48_000));
	const converted = readWav(await toWav16k(path));
	assert.equal(converted.sampleRate, 16_000);
	assert.ok(Math.abs(converted.samples.length - 16_000) < 100, `${converted.samples.length} samples`);
});

test("a file that is not audio is an error", { skip: haveFfmpeg ? false : "ffmpeg is not installed" }, async () => {
	using dir = tempDir();
	const path = join(dir.path, "junk.ogg");
	writeFileSync(path, "not audio");
	await assert.rejects(toWav16k(path));
});
