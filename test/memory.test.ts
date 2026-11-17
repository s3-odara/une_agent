import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { parseConfig, persona, personaFor } from "../src/config.ts";
import type { GatewayCommand, GatewayEvent, GatewayLink } from "../src/gateway.ts";
import { openAgentHarness } from "../src/harness.ts";
import { HostDb } from "../src/hostdb.ts";
import { createMemoryExtension, MemoryError, type MemoryPersona, MemoryStore } from "../src/memory.ts";
import { Bridge } from "../src/rooms.ts";

const calm: MemoryPersona = { name: "calm", privateMemory: true };
const blunt: MemoryPersona = { name: "blunt", privateMemory: true };
const plain: MemoryPersona = { name: "plain", privateMemory: false };

function tempDir(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "agent-memory-test-"));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("an added entry is tagged with its date, and adding it again changes nothing", () => {
	const { dir, cleanup } = tempDir();
	try {
		const store = new MemoryStore(dir, { shared: 2000, private: 1000 });
		assert.equal(store.add("shared", calm, "ユーザーは緑茶を好む", "2026-11-17"), "記憶しました。");
		assert.equal(readFileSync(join(dir, "shared.md"), "utf8"), "- ユーザーは緑茶を好む (2026-11-17)\n");

		// The same text again, as a rerun after a crash would send it, even from another persona on another day.
		assert.equal(store.add("shared", blunt, "ユーザーは緑茶を好む", "2026-11-18"), "同じ項目が既にあります。");
		assert.deepEqual(store.entries("shared", calm), ["ユーザーは緑茶を好む (2026-11-17)"]);
	} finally {
		cleanup();
	}
});

test("replace and remove act on the one entry that matches, and are safe to repeat", () => {
	const { dir, cleanup } = tempDir();
	try {
		const store = new MemoryStore(dir, { shared: 2000, private: 1000 });
		store.add("shared", calm, "ユーザーは緑茶を好む", "2026-11-17");
		store.add("shared", calm, "ユーザーは朝6時のブリーフを希望", "2026-11-17");

		assert.throws(() => store.replace("shared", calm, "ユーザーは", "x", "2026-11-18"), /複数の項目に当てはまります/);
		assert.throws(() => store.replace("shared", calm, "紅茶", "x", "2026-11-18"), MemoryError);

		assert.equal(store.replace("shared", blunt, "緑茶", "ユーザーはほうじ茶を好む", "2026-11-18"), "書き換えました。");
		assert.equal(store.replace("shared", blunt, "緑茶", "ユーザーはほうじ茶を好む", "2026-11-18"), "既に書き換え済みです。");
		assert.deepEqual(store.entries("shared", calm), [
			"ユーザーはほうじ茶を好む (2026-11-18)",
			"ユーザーは朝6時のブリーフを希望 (2026-11-17)",
		]);

		assert.equal(store.remove("shared", calm, "ブリーフ"), "削除しました。");
		assert.match(store.remove("shared", calm, "ブリーフ"), /該当する項目はありません/);
		assert.deepEqual(store.entries("shared", calm), ["ユーザーはほうじ茶を好む (2026-11-18)"]);
	} finally {
		cleanup();
	}
});

test("a change that would pass the limit is refused and leaves the file as it was", () => {
	const { dir, cleanup } = tempDir();
	try {
		const store = new MemoryStore(dir, { shared: 40, private: 1000 });
		store.add("shared", calm, "短い項目", "2026-11-17");
		const before = readFileSync(join(dir, "shared.md"), "utf8");
		assert.throws(() => store.add("shared", calm, "これは上限を超えるほど長い項目です", "2026-11-17"), /上限 40 文字を \d+ 文字超えます/);
		assert.equal(readFileSync(join(dir, "shared.md"), "utf8"), before);
	} finally {
		cleanup();
	}
});

test("a private memo is its persona's alone, and a persona without one is told to use shared", () => {
	const { dir, cleanup } = tempDir();
	try {
		const store = new MemoryStore(dir, { shared: 2000, private: 1000 });
		store.add("shared", calm, "共有の話", "2026-11-17");
		store.add("private", calm, "calm だけの話", "2026-11-17");

		assert.deepEqual(store.entries("private", blunt), []);
		assert.match(store.prompt(calm), /calm だけの話/);
		assert.match(store.prompt(blunt), /共有の話/);
		assert.doesNotMatch(store.prompt(blunt), /calm だけの話/);

		assert.doesNotMatch(store.prompt(plain), /## private/);
		assert.throws(() => store.add("private", plain, "x", "2026-11-17"), /private の記憶を持っていません/);
	} finally {
		cleanup();
	}
});

test("a file edited by hand is read as it is", () => {
	const { dir, cleanup } = tempDir();
	try {
		writeFileSync(join(dir, "shared.md"), "# メモ\n\n- 手で書いた項目\n* 別の記号の項目\n");
		const store = new MemoryStore(dir, { shared: 2000, private: 1000 });
		assert.deepEqual(store.entries("shared", calm), ["# メモ", "手で書いた項目", "別の記号の項目"]);
	} finally {
		cleanup();
	}
});

class FakeLink implements GatewayLink {
	readonly commands: GatewayCommand[] = [];
	#listener: (event: GatewayEvent) => void = () => {};
	send(command: GatewayCommand): void {
		this.commands.push(command);
		if (command.type === "send") {
			queueMicrotask(() => this.#listener({ type: "sent", requestId: command.requestId, eventId: `$sent-${command.txnId}` }));
		}
	}
	onEvent(listener: (event: GatewayEvent) => void): void {
		this.#listener = listener;
	}
	emit(event: GatewayEvent): void {
		this.#listener(event);
	}
	bodyIn(roomId: string): string {
		return this.commands.flatMap((command) => (command.type === "send" && command.roomId === roomId ? [command.body] : [])).join("\n");
	}
}

test("what one persona remembers through the tool, another persona sees, except its private memo", async () => {
	const { dir, cleanup } = tempDir();
	writeFileSync(join(dir, "calm.md"), "SOUL-CALM");
	writeFileSync(join(dir, "blunt.md"), "SOUL-BLUNT");
	const faux = fauxProvider();
	const model = faux.getModel();
	const config = parseConfig(
		{
			matrix: { homeserver: "https://example.org", userId: "@agent:example.org", allowedUsers: ["@me:example.org"] },
			model: { provider: model.provider, modelId: model.id },
			personas: { calm: { soul: "calm.md", privateMemory: true }, blunt: "blunt.md" },
			defaultPersona: "calm",
			rooms: { "!blunt:example.org": "blunt" },
		},
		dir,
	);
	const models = createModels();
	models.setProvider(faux.provider);
	const db = new HostDb(join(dir, "host.sqlite"));
	const store = new MemoryStore(join(dir, "memory"), { shared: config.memory.sharedLimit, private: config.memory.privateLimit });
	const memory = createMemoryExtension({
		store,
		personaOf: (conversationId) => {
			const roomId = db.roomOf(conversationId);
			if (roomId === undefined) return undefined;
			const name = personaFor(config, roomId);
			return { name, privateMemory: persona(config, name).privateMemory };
		},
	});
	const harness = await openAgentHarness(new MemoryStorage(), models, context, [memory]);
	try {
		const seen = (request: { messages: unknown }) => fauxAssistantMessage(JSON.stringify(request.messages));
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("memory_add", { scope: "shared", text: "ユーザーは緑茶を好む" }),
					fauxToolCall("memory_add", { scope: "private", text: "calm との合言葉は山" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("覚えました"),
			seen,
			// blunt has no private memo: the tool refuses, and the model hears why.
			fauxAssistantMessage([fauxToolCall("memory_add", { scope: "private", text: "blunt の内緒" })], { stopReason: "toolUse" }),
			seen,
		]);
		const link = new FakeLink();
		const bridge = new Bridge({ harness, db, link, config, context });
		bridge.start();

		link.emit({ type: "message", roomId: "!calm:example.org", eventId: "$1", sender: "@me:example.org", body: "緑茶が好き", ts: 0 });
		await bridge.idle();
		assert.equal(link.bodyIn("!calm:example.org"), "覚えました");
		assert.match(store.entries("shared", calm)[0] ?? "", /^ユーザーは緑茶を好む \(\d{4}-\d{2}-\d{2}\)$/);
		assert.equal(store.entries("private", calm).length, 1);

		link.emit({ type: "message", roomId: "!blunt:example.org", eventId: "$2", sender: "@me:example.org", body: "何を知ってる?", ts: 0 });
		await bridge.idle();
		const bluntSaw = link.bodyIn("!blunt:example.org");
		assert.match(bluntSaw, /SOUL-BLUNT/);
		assert.match(bluntSaw, /ユーザーは緑茶を好む/);
		assert.doesNotMatch(bluntSaw, /合言葉/);

		link.emit({ type: "message", roomId: "!blunt:example.org", eventId: "$3", sender: "@me:example.org", body: "内緒にして", ts: 0 });
		await bridge.idle();
		assert.match(link.bodyIn("!blunt:example.org"), /private の記憶を持っていません/);
	} finally {
		await harness.close(context);
		db.close();
		cleanup();
	}
});

test("a persona name that could not be a file name is rejected", () => {
	assert.throws(
		() =>
			parseConfig(
				{
					matrix: { homeserver: "https://example.org", userId: "@agent:example.org", allowedUsers: ["@me:example.org"] },
					model: { provider: "anthropic", modelId: "claude-fable-5-2" },
					personas: { "../escape": "personas/default.md" },
					defaultPersona: "../escape",
				},
				"/nowhere",
			),
		/persona name/,
	);
});
