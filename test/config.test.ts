import assert from "node:assert/strict";
import { test } from "node:test";
import { modelFor } from "../src/config.ts";
import { testConfig } from "./env.ts";

test("a removed call transcript opt-out is rejected instead of silently publishing transcripts", () => {
	assert.throws(() => testConfig("/nowhere", { voice: { stt: {}, tts: {}, call: { transcript: false } } }), /voice\.call\.transcript/);
});

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

test("a model is written as provider/model, and only the first slash splits it", () => {
	assert.deepEqual(modelFor(testConfig("/nowhere", { model: "openrouter/anthropic/claude-fable-5.2" }), "default"), { provider: "openrouter", modelId: "anthropic/claude-fable-5.2" });
	for (const model of ["claude-fable-5-2", "/x", "anthropic/", { provider: "anthropic", modelId: "x" }]) {
		assert.throws(() => testConfig("/nowhere", { model }), /provider\/model/, JSON.stringify(model));
	}
});
