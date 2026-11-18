import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CredentialCommands } from "../src/credential-commands.ts";
import { Credentials } from "../src/credentials.ts";
import { agentEnv } from "./env.ts";
import { answer, everything, message, type Request } from "./fakes.ts";

const ROOM = "!main:example.org";

/** The agent with `!cred` taken before the model, on a credentials file in its data directory. */
async function setup() {
	const env = await agentEnv();
	const path = join(env.config.dataDir, "credentials.json");
	const credentials = new Credentials(path);
	const bridge = env.bridge({ handlers: [new CredentialCommands(credentials)] });
	const requests: Request[] = [];
	let n = 0;
	return {
		env,
		path,
		credentials,
		requests,
		/** Says `body`; the model, if asked, answers "ok" and keeps its request. */
		say: async (body: string) => {
			env.faux.setResponses([answer("ok", requests)]);
			env.link.emit(message(ROOM, `$${++n}`, body));
			await bridge.idle();
		},
		/** The notices the bot replied with. */
		replies: () => env.link.of("send").map((command) => command.body),
		[Symbol.asyncDispose]: () => env[Symbol.asyncDispose](),
	};
}

test("a password added with !cred is stored for the site's origin, with any spaces in it", async () => {
	await using t = await setup();
	await t.say("!cred add https://shop.example.com/login me@example.org correct horse");
	assert.deepEqual(t.credentials.forOrigin("https://shop.example.com"), { username: "me@example.org", password: "correct horse" });
});

test("a site name without a dot is refused, not stored", async () => {
	await using t = await setup();
	await t.say("!cred add not/a/site me secret");
	assert.deepEqual(t.credentials.origins(), []);
});

test("a site written without a scheme is taken as https", async () => {
	await using t = await setup();
	await t.say("!cred add shop.example.com me secret");
	assert.equal(t.credentials.forOrigin("https://shop.example.com")?.password, "secret");
});

for (const body of ["!cred add https://shop.example.com me secret-1", "!cred add https://shop.example.com", "!cred add not/a/site me secret-1", "!cred frobnicate secret-1", "!cred"]) {
	test(`"${body}" never reaches the model, and the reply does not repeat a password`, async () => {
		await using t = await setup();
		await t.say(body);
		assert.deepEqual(t.requests, []);
		assert.equal(t.env.link.of("ack").length, 1);
		assert.equal(t.replies().length, 1);
		assert.ok(t.replies().every((reply) => !reply.includes("secret-1")));
	});
}

test("the model never sees a password added earlier, even in what was said after it", async () => {
	await using t = await setup();
	await t.say("!cred add https://shop.example.com me secret-1");
	await t.say("こんにちは");
	assert.equal(t.requests.length, 1);
	assert.ok(!everything(t.requests[0] as Request).includes("secret-1"));
});

test("adding a site again replaces its password, also one written under a longer URL by hand", async () => {
	await using t = await setup();
	writeFileSync(t.path, JSON.stringify({ "https://shop.example.com/login": { username: "old", password: "old-secret" }, "https://other.example.com": { username: "x", password: "y" } }));
	await t.say("!cred add https://shop.example.com new new-secret");
	assert.deepEqual(t.credentials.forOrigin("https://shop.example.com"), { username: "new", password: "new-secret" });
	assert.deepEqual(t.credentials.forOrigin("https://other.example.com"), { username: "x", password: "y" });
	assert.ok(!readFileSync(t.path, "utf8").includes("old-secret"));
});

test("the file is written readable by its owner only", async () => {
	await using t = await setup();
	await t.say("!cred add https://shop.example.com me secret");
	assert.equal(statSync(t.path).mode & 0o777, 0o600);
});

test("a credentials file that cannot be read is not overwritten", async () => {
	await using t = await setup();
	writeFileSync(t.path, "{ not json");
	await t.say("!cred add https://shop.example.com me secret");
	assert.equal(readFileSync(t.path, "utf8"), "{ not json");
	assert.equal(t.replies().length, 1);
});

test("!cred list shows the sites and user names, not the passwords", async () => {
	await using t = await setup();
	await t.say("!cred add https://shop.example.com me secret-1");
	await t.say("!cred list");
	const list = t.replies().at(-1) ?? "";
	assert.ok(list.includes("https://shop.example.com") && list.includes("me"));
	assert.ok(!list.includes("secret-1"));
});

test("!cred remove deletes the site's password", async () => {
	await using t = await setup();
	await t.say("!cred add https://shop.example.com me secret-1");
	await t.say("!cred remove shop.example.com");
	assert.equal(t.credentials.forOrigin("https://shop.example.com"), undefined);
});

test("a message that only starts like the command goes to the model", async () => {
	await using t = await setup();
	await t.say("!credentials って何？");
	assert.equal(t.requests.length, 1);
});
