import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStore } from "../src/memory.ts";
import { memoryFingerprint, tidyMemory } from "../src/tidy.ts";
import { agentEnv, context } from "./env.ts";
import { answer, lastInput, type Request } from "./fakes.ts";

const calm = { name: "calm", privateMemory: true };
const personas = [calm];

/**
 * Memory with two entries that say much the same and one that does not last, and a private memo. The model's answers
 * are set per test: one for the shared list, then one for calm's private memo.
 */
async function setup(answers: { shared: string; private: string }) {
	const env = await agentEnv();
	const store = new MemoryStore(join(env.dir, "memory"), { shared: 2000, private: 1000 });
	store.add("shared", calm, "ユーザーは緑茶を好む", "2026-11-10");
	store.add("shared", calm, "ユーザーは緑茶がとても好きで、コーヒーよりも緑茶をよく飲むとのこと", "2026-11-16");
	store.add("shared", calm, "ユーザーは今日は眠いと言っていた", "2026-11-16");
	store.add("private", calm, "calm との合言葉は山", "2026-11-12");
	env.faux.setResponses([fauxAssistantMessage(answers.shared), fauxAssistantMessage(answers.private)]);
	const model = env.faux.getModel();
	return {
		store,
		faux: env.faux,
		dir: join(env.dir, "memory"),
		tidy: () => tidyMemory({ harness: env.harness, store, personas, model: { provider: model.provider, modelId: model.id }, context, log: () => {} }, "2026-11-17"),
		[Symbol.asyncDispose]: () => env[Symbol.asyncDispose](),
	};
}

const KEPT_PRIVATE = "- calm との合言葉は山";

test("an answer that is not a list leaves memory as it was", async () => {
	await using t = await setup({ shared: "整理しました！", private: KEPT_PRIVATE });
	const before = t.store.entries("shared", calm);
	assert.deepEqual(await t.tidy(), []);
	assert.deepEqual(t.store.entries("shared", calm), before);
});

test("the model tidying memory is told the day, so it can tell what is over", async () => {
	await using t = await setup({ shared: "", private: "" });
	const requests: Request[] = [];
	t.faux.setResponses([answer("- ユーザーは緑茶を好む", requests), answer(KEPT_PRIVATE)]);
	await t.tidy();
	assert.match(lastInput(requests[0]!), /2026-11-17/);
});

test("a list longer than the one it was asked to tidy is not trusted", async () => {
	await using t = await setup({ shared: "- ユーザーは緑茶を好む", private: `${KEPT_PRIVATE}\n- それに加えて、ユーザーについての長い長い説明をここに書き足します` });
	await t.tidy();
	assert.deepEqual(t.store.entries("private", calm), ["calm との合言葉は山 (2026-11-12)"]);
});

test("a tidy keeps the date of each entry it kept, and dates what it wrote anew with the day of the tidy", async () => {
	await using t = await setup({ shared: "- ユーザーは緑茶を好む\n- ユーザーはコーヒーより緑茶をよく飲む", private: KEPT_PRIVATE });
	await t.tidy();
	assert.deepEqual(t.store.entries("shared", calm), ["ユーザーは緑茶を好む (2026-11-10)", "ユーザーはコーヒーより緑茶をよく飲む (2026-11-17)"]);
	assert.deepEqual(t.store.entries("private", calm), ["calm との合言葉は山 (2026-11-12)"]);
});

test("a tidy says what it removed and added, for the lists it changed only", async () => {
	await using t = await setup({ shared: "- ユーザーは緑茶を好む\n- ユーザーはコーヒーより緑茶をよく飲む", private: KEPT_PRIVATE });
	const changes = await t.tidy();
	assert.deepEqual(
		changes.map((change) => [change.label, change.removed.length, change.added]),
		[["shared", 2, ["ユーザーはコーヒーより緑茶をよく飲む (2026-11-17)"]]],
	);
});

test("a tidy changes the fingerprint, and keeps the list from before it where a person can find it", async () => {
	await using t = await setup({ shared: "- ユーザーは緑茶を好む", private: KEPT_PRIVATE });
	const before = memoryFingerprint(t.store, personas);
	await t.tidy();
	assert.notEqual(memoryFingerprint(t.store, personas), before);
	assert.deepEqual(readdirSync(join(t.dir, "history")), ["shared-2026-11-17.md"]);
});
