import assert from "node:assert/strict";
import { test } from "node:test";
import { modelFor } from "../src/config.ts";
import { testConfig } from "./env.ts";

test("a removed call transcript opt-out is rejected instead of silently publishing transcripts", () => {
	assert.throws(
		() => testConfig("/nowhere", { voice: { stt: {}, tts: {}, call: { transcript: false } } }),
		/voice\.call\.transcript/,
	);
});

test("a persona that a room uses but nobody defined is rejected when the config is read", () => {
	assert.throws(() => testConfig("/nowhere", { rooms: { "!a:example.org": "missing" } }), /missing/);
});

test("a persona name that could not be a file name is rejected", () => {
	assert.throws(
		() => testConfig("/nowhere", { personas: { "../escape": "personas/default.md" }, defaultPersona: "../escape" }),
		/\.\.\/escape/,
	);
});

test("a weather default must select a forecast area, not just a forecast office", () => {
	assert.throws(() => testConfig("/nowhere", { weather: { areaCode: "130000" } }), /weather\.areaCode.*130000/);
});

test("calls cannot be set up without speech synthesis", () => {
	assert.throws(() => testConfig("/nowhere", { voice: { stt: {}, call: {} } }), /voice\.tts/);
});

test("a call's VAD setting accepts partial overrides and rejects out-of-range values", () => {
	assert.deepEqual(
		testConfig("/nowhere", { voice: { stt: {}, tts: {}, call: { vad: { endSilenceMs: 700 } } } }).voice?.call?.vad,
		{ endSilenceMs: 700 },
	);
	assert.throws(
		() => testConfig("/nowhere", { voice: { stt: {}, tts: {}, call: { vad: { threshold: 1.5 } } } }),
		/threshold/,
	);
});

test("a model is written as provider/model, and only the first slash splits it", () => {
	assert.deepEqual(modelFor(testConfig("/nowhere", { model: "openrouter/anthropic/claude-fable-5.2" }), "default"), {
		provider: "openrouter",
		modelId: "anthropic/claude-fable-5.2",
	});
	for (const model of ["claude-fable-5-2", "/x", "anthropic/", { provider: "anthropic", modelId: "x" }]) {
		assert.throws(() => testConfig("/nowhere", { model }), /provider\/model/, JSON.stringify(model));
	}
});
