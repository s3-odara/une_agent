import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { persona, personaFor } from "../src/config.ts";
import { createMemoryExtension, MemoryError, type MemoryPersona, MemoryStore } from "../src/memory.ts";
import { agentEnv, tempDir } from "./env.ts";
import { answer, everything, message, noting, type Request, type ToolResult } from "./fakes.ts";

const calm: MemoryPersona = { name: "calm", privateMemory: true };
const blunt: MemoryPersona = { name: "blunt", privateMemory: true };
const plain: MemoryPersona = { name: "plain", privateMemory: false };

function storeSetup(limits = { shared: 2000, private: 1000 }) {
	const dir = tempDir();
	return { dir: dir.path, store: new MemoryStore(dir.path, limits), [Symbol.dispose]: () => dir[Symbol.dispose]() };
}

test("entries are kept as a Markdown list a person can read and edit, each with the day it was written", () => {
	using t = storeSetup();
	t.store.add("shared", calm, "ユーザーは緑茶を好む", "2026-11-17");
	assert.equal(readFileSync(join(t.dir, "shared.md"), "utf8"), "- ユーザーは緑茶を好む (2026-11-17)\n");
});

test("a file edited by hand is read as it is", () => {
	using t = storeSetup();
	writeFileSync(join(t.dir, "shared.md"), "# メモ\n\n- 手で書いた項目\n* 別の記号の項目\n");
	assert.deepEqual(t.store.entries("shared", calm), ["# メモ", "手で書いた項目", "別の記号の項目"]);
});

test("adding an entry that is there already changes nothing, even from another persona on another day", () => {
	using t = storeSetup();
	t.store.add("shared", calm, "ユーザーは緑茶を好む", "2026-11-17");
	t.store.add("shared", blunt, "ユーザーは緑茶を好む", "2026-11-18");
	assert.deepEqual(t.store.entries("shared", calm), ["ユーザーは緑茶を好む (2026-11-17)"]);
});

test("replacing changes the one entry that matches, and dates it anew", () => {
	using t = storeSetup();
	t.store.add("shared", calm, "ユーザーは緑茶を好む", "2026-11-17");
	t.store.add("shared", calm, "ユーザーは朝6時のブリーフを希望", "2026-11-17");
	t.store.replace("shared", blunt, "緑茶", "ユーザーはほうじ茶を好む", "2026-11-18");
	assert.deepEqual(t.store.entries("shared", calm), [
		"ユーザーはほうじ茶を好む (2026-11-18)",
		"ユーザーは朝6時のブリーフを希望 (2026-11-17)",
	]);
});

test("replacing again, as a rerun after a crash does, changes nothing more", () => {
	using t = storeSetup();
	t.store.add("shared", calm, "ユーザーは緑茶を好む", "2026-11-17");
	t.store.replace("shared", calm, "緑茶", "ユーザーはほうじ茶を好む", "2026-11-18");
	t.store.replace("shared", calm, "緑茶", "ユーザーはほうじ茶を好む", "2026-11-18");
	assert.deepEqual(t.store.entries("shared", calm), ["ユーザーはほうじ茶を好む (2026-11-18)"]);
});

test("a match that fits several entries, or none, is refused", () => {
	using t = storeSetup();
	t.store.add("shared", calm, "ユーザーは緑茶を好む", "2026-11-17");
	t.store.add("shared", calm, "ユーザーは朝6時のブリーフを希望", "2026-11-17");
	assert.throws(() => t.store.replace("shared", calm, "ユーザーは", "x", "2026-11-18"), MemoryError);
	assert.throws(() => t.store.replace("shared", calm, "紅茶", "x", "2026-11-18"), MemoryError);
	assert.throws(() => t.store.remove("shared", calm, "ユーザーは"), MemoryError);
});

test("removing deletes the one entry that matches, and removing it again changes nothing", () => {
	using t = storeSetup();
	t.store.add("shared", calm, "ユーザーは緑茶を好む", "2026-11-17");
	t.store.add("shared", calm, "ユーザーは朝6時のブリーフを希望", "2026-11-17");
	t.store.remove("shared", calm, "ブリーフ");
	t.store.remove("shared", calm, "ブリーフ");
	assert.deepEqual(t.store.entries("shared", calm), ["ユーザーは緑茶を好む (2026-11-17)"]);
});

test("a change that would pass the limit is refused and leaves the file as it was", () => {
	using t = storeSetup({ shared: 40, private: 1000 });
	t.store.add("shared", calm, "短い項目", "2026-11-17");
	const before = readFileSync(join(t.dir, "shared.md"), "utf8");
	assert.throws(() => t.store.add("shared", calm, "これは上限を超えるほど長い項目です", "2026-11-17"), MemoryError);
	assert.equal(readFileSync(join(t.dir, "shared.md"), "utf8"), before);
});

test("a private memo is shown to its own persona only", () => {
	using t = storeSetup();
	t.store.add("shared", calm, "共有の話", "2026-11-17");
	t.store.add("private", calm, "calm だけの話", "2026-11-17");
	assert.match(t.store.prompt(calm), /calm だけの話/);
	assert.match(t.store.prompt(blunt), /共有の話/);
	assert.doesNotMatch(t.store.prompt(blunt), /calm だけの話/);
	assert.deepEqual(t.store.entries("private", blunt), []);
});

test("a persona without a private memo cannot write one", () => {
	using t = storeSetup();
	assert.throws(() => t.store.add("private", plain, "x", "2026-11-17"), MemoryError);
});

async function toolSetup(options: { timezone?: string; now?: () => number } = {}) {
	const env = await agentEnv({
		souls: { "calm.md": "SOUL-CALM", "blunt.md": "SOUL-BLUNT" },
		config: {
			personas: { calm: { soul: "calm.md", privateMemory: true }, blunt: "blunt.md" },
			defaultPersona: "calm",
			rooms: { "!blunt:example.org": "blunt" },
			...(options.timezone === undefined ? {} : { timezone: options.timezone }),
		},
		now: options.now,
		extensions: ({ config, db }) => [
			createMemoryExtension({
				store: new MemoryStore(join(config.dataDir, "memory"), {
					shared: config.memory.sharedLimit,
					private: config.memory.privateLimit,
				}),
				personaOf: (conversationId) => {
					const roomId = db.roomOf(conversationId);
					if (roomId === undefined) return undefined;
					const name = personaFor(config, roomId);
					return { name, privateMemory: persona(config, name).privateMemory };
				},
				tz: config.timezone,
			}),
		],
	});
	const bridge = env.bridge();
	let n = 0;
	return {
		env,
		store: () =>
			new MemoryStore(join(env.config.dataDir, "memory"), {
				shared: env.config.memory.sharedLimit,
				private: env.config.memory.privateLimit,
			}),
		say: async (roomId: string, body: string) => {
			env.link.emit(message(roomId, `$${++n}`, body));
			await bridge.idle();
		},
		[Symbol.asyncDispose]: () => env[Symbol.asyncDispose](),
	};
}

const remember = (scope: "shared" | "private", text: string) =>
	fauxAssistantMessage([fauxToolCall("memory_add", { scope, text })], { stopReason: "toolUse" });

test("what one persona remembers is in what every persona is given", async () => {
	await using t = await toolSetup();
	const requests: Request[] = [];
	t.env.faux.setResponses([remember("shared", "ユーザーは緑茶を好む"), answer("覚えました"), answer("はい", requests)]);
	await t.say("!calm:example.org", "緑茶が好き");
	await t.say("!blunt:example.org", "何を知ってる?");
	assert.match(everything(requests[0]!), /ユーザーは緑茶を好む/);
});

test("a private memo written through the tool is not given to the other personas", async () => {
	await using t = await toolSetup();
	const requests: Request[] = [];
	t.env.faux.setResponses([remember("private", "calm との合言葉は山"), answer("覚えました"), answer("はい", requests)]);
	await t.say("!calm:example.org", "合言葉を覚えて");
	await t.say("!blunt:example.org", "何を知ってる?");
	assert.deepEqual(t.store().entries("private", calm).length, 1);
	assert.doesNotMatch(everything(requests[0]!), /合言葉/);
});

test("the tool dates an entry by the user's calendar, not the server's", async () => {
	// Far enough east that its date is ahead of the server's, wherever that is: 12:00 UTC on 11/17 is already 11/18.
	await using t = await toolSetup({ timezone: "Pacific/Kiritimati", now: () => Date.parse("2026-11-17T12:00:00Z") });
	t.env.faux.setResponses([remember("shared", "ユーザーは緑茶を好む"), answer("覚えました")]);
	await t.say("!calm:example.org", "緑茶が好き");
	assert.deepEqual(t.store().entries("shared", calm), ["ユーザーは緑茶を好む (2026-11-18)"]);
});
