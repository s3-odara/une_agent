import assert from "node:assert/strict";
import { test } from "node:test";
import { testConfig } from "./env.ts";

test("a persona that a room uses but nobody defined is rejected when the config is read", () => {
	assert.throws(() => testConfig("/nowhere", { rooms: { "!a:example.org": "missing" } }), /missing/);
});

test("a persona name that could not be a file name is rejected", () => {
	assert.throws(() => testConfig("/nowhere", { personas: { "../escape": "personas/default.md" }, defaultPersona: "../escape" }), /\.\.\/escape/);
});

test("calls cannot be set up without speech synthesis", () => {
	assert.throws(() => testConfig("/nowhere", { voice: { stt: {}, call: {} } }), /voice\.tts/);
});

test("a call's VAD setting that is given replaces only that setting", () => {
	const vadOf = (vad: Record<string, unknown>) => testConfig("/nowhere", { voice: { stt: {}, tts: {}, call: { vad } } }).voice?.call?.vad;
	assert.deepEqual(vadOf({ endSilenceMs: 700 }), { ...vadOf({}), endSilenceMs: 700 });
});
