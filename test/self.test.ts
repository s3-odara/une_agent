import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createSelfExtension } from "../src/self.ts";
import { openConfig } from "../src/harness.ts";
import { agentEnv, BASE_CONFIG } from "./env.ts";
import { answer, call, instructionsOf, message, noting, type Request, type ToolResult } from "./fakes.ts";

const ROOM = "!main:example.org";

async function setup(options: { readonly config: unknown }) {
	let restarts = 0;
	const env = await agentEnv({
		extensions: ({ config, db, models }) => [
			createSelfExtension({
				configPath: join(config.baseDir, "config.json"),
				workDir: config.baseDir,
				roomOf: (conversationId) => db.roomOf(conversationId),
				check: () => openConfig(join(config.baseDir, "config.json"), models),
				restart: () => restarts++,
			}),
		],
	});
	writeFileSync(join(env.dir, "config.json"), typeof options.config === "string" ? options.config : JSON.stringify(options.config));
	const bridge = env.bridge();
	const results: ToolResult[] = [];
	return {
		env,
		results,
		restartCount: () => restarts,
		say: async (body: string) => {
			env.link.emit(message(ROOM, "$2", body));
			await bridge.idle();
		},
		askRestart: async () => {
			env.faux.setResponses([call("agent_restart", {}), noting(results)]);
			env.link.emit(message(ROOM, "$1", "再起動して"));
			await bridge.idle();
		},
		[Symbol.asyncDispose]: () => env[Symbol.asyncDispose](),
	};
}

test("a restart with a config that loads goes ahead", async () => {
	await using t = await setup({ config: BASE_CONFIG });
	await t.askRestart();
	assert.equal(t.results[0]?.isError, false);
	assert.equal(t.restartCount(), 1);
});

const BROKEN: [string, unknown][] = [
	["JSON that does not parse", "{ \"model\": "],
	["a room given a persona that is not defined", { ...BASE_CONFIG, rooms: { [ROOM]: "nobody" } }],
	["a persona whose SOUL file is missing", { ...BASE_CONFIG, personas: { default: "missing.md" } }],
];
for (const [what, config] of BROKEN) {
	test(`a restart with ${what} is refused with the reason, and does not happen`, async () => {
		await using t = await setup({ config });
		await t.askRestart();
		assert.equal(t.results[0]?.isError, true);
		assert.equal(t.restartCount(), 0);
	});
}

test("a restart onto a model that is not in the catalog is refused with the reason, and does not happen", async () => {
	await using t = await setup({ config: { ...BASE_CONFIG, model: "faux/nope" } });
	await t.askRestart();
	assert.match(t.results[0]?.text ?? "", /nope/);
	assert.equal(t.restartCount(), 0);
});

test("the model is told the ID of the room it is talking in", async () => {
	await using t = await setup({ config: BASE_CONFIG });
	const requests: Request[] = [];
	t.env.faux.setResponses([answer("ok", requests)]);
	await t.say("このルームの ID は？");
	assert.ok(instructionsOf(requests[0]!).includes(ROOM));
});

function writeSkill(dir: string, name: string, text: string): string {
	mkdirSync(join(dir, "skills", name), { recursive: true });
	writeFileSync(join(dir, "skills", name, "SKILL.md"), text);
	return join(dir, "skills", name, "SKILL.md");
}

test("the model is told of each skill, a person's own included, by its description and where to read it", async () => {
	await using t = await setup({ config: BASE_CONFIG });
	const path = writeSkill(t.env.dir, "shopping", "---\nname: shopping\ndescription: 日用品の買い物を頼まれたとき。\n---\n\n# 買い物\n");
	const requests: Request[] = [];
	t.env.faux.setResponses([answer("ok", requests)]);
	await t.say("こんにちは");
	const instructions = instructionsOf(requests[0]!);
	assert.match(instructions, /shopping: 日用品の買い物を頼まれたとき。/);
	assert.ok(instructions.includes(path));
	assert.ok(!instructions.includes("# 買い物"));
});

test("a skill without a description is not listed", async () => {
	await using t = await setup({ config: BASE_CONFIG });
	writeSkill(t.env.dir, "draft", "# 書きかけ\n");
	const requests: Request[] = [];
	t.env.faux.setResponses([answer("ok", requests)]);
	await t.say("こんにちは");
	assert.ok(!instructionsOf(requests[0]!).includes("draft"));
});
