import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { BrowserPage, Browsers, FieldInfo } from "../src/browser.ts";
import { createBrowserExtension, UNTRUSTED } from "../src/browser-tools.ts";
import { persona, personaFor } from "../src/config.ts";
import { CredentialError, Credentials } from "../src/credentials.ts";
import { agentEnv, tempDir } from "./env.ts";
import { call, everything, instructionsOf, message, noting, type Request, type ToolResult } from "./fakes.ts";

const ROOM = "!main:example.org";
const SECRET = "correct-horse-battery";

/**
 * A browser that only records. Its one page shows whatever was typed into it, as a real page may, and names three
 * elements: `user` and `pass` of the login form, and `search`, a plain text box.
 */
class FakeBrowsers implements Browsers {
	readonly log: string[] = [];
	readonly values = new Map<string, string>();
	url = "about:blank";
	/** Origin of the document the login form is in; differs from the page's when the form is in a frame. */
	formOrigin: string | undefined;
	tree: string | undefined;

	async page(profile: string, conversationId: number): Promise<BrowserPage> {
		const fields: Record<string, string> = { user: "text", pass: "password", search: "text" };
		return {
			goto: async (url) => {
				this.log.push(`goto ${profile} ${url}`);
				this.url = url;
			},
			back: async () => void this.log.push("back"),
			snapshot: async () => ({
				url: this.url,
				title: "テストページ",
				tree: this.tree ?? ['- textbox "ユーザー名" [ref=user]', '- textbox "パスワード" [ref=pass]', ...[...this.values].map(([ref, value]) => `- text: ${ref} に入力済み: ${value}`)].join("\n"),
			}),
			text: async () => `本文 ${[...this.values.values()].join(" ")}`,
			click: async (ref) => void this.log.push(`click ${ref}`),
			fill: async (ref, text) => {
				this.log.push(`fill ${ref}`);
				this.values.set(ref, text);
			},
			press: async (key, ref) => void this.log.push(`press ${key} ${ref ?? ""}`.trim()),
			field: async (ref): Promise<FieldInfo> => {
				const kind = fields[ref];
				if (kind === undefined) throw new Error(`no element with ref ${ref}`);
				return { kind, origin: this.formOrigin ?? new URL(this.url).origin };
			},
		};
	}
	async close(): Promise<void> {}
}

/**
 * The agent with the browser tools on the recording browser, with a password stored for https://shop.example.com.
 * Room `!work` speaks as a persona with a browser profile of its own.
 */
async function setup() {
	const browsers = new FakeBrowsers();
	const env = await agentEnv({
		config: { personas: { default: "soul.md", work: { soul: "soul.md", browserProfile: "work" } }, rooms: { "!work:example.org": "work" }, browser: {} },
		extensions: ({ config, db }) => {
			const path = join(config.dataDir, "credentials.json");
			writeFileSync(path, JSON.stringify({ "https://shop.example.com/login": { username: "me@example.org", password: SECRET } }));
			return [
				createBrowserExtension({
					browsers,
					credentials: new Credentials(path),
					db,
					profileOf: (conversationId) => {
						const roomId = db.roomOf(conversationId);
						return roomId === undefined ? undefined : persona(config, personaFor(config, roomId)).browserProfile;
					},
					maxChars: 400,
				}),
			];
		},
	});
	const bridge = env.bridge();
	/** Every request the model got, and the tool results in them. */
	const requests: Request[] = [];
	const results: ToolResult[] = [];
	let n = 0;
	return {
		env,
		bridge,
		browsers,
		requests,
		results,
		/** A model turn that takes note of the tool result it was given. */
		noting: noting(results, requests),
		say: async (body: string, roomId = ROOM) => {
			env.link.emit(message(roomId, `$${++n}`, body));
			await bridge.idle();
		},
		[Symbol.asyncDispose]: () => env[Symbol.asyncDispose](),
	};
}

test("a page is opened in the browser profile of the room's persona", async () => {
	await using t = await setup();
	t.env.faux.setResponses([call("browser_open", { url: "https://example.com/news" }), t.noting, call("browser_open", { url: "https://example.com/" }), t.noting]);
	await t.say("ニュースを見て");
	await t.say("こちらも", "!work:example.org");
	assert.deepEqual(t.browsers.log, ["goto default https://example.com/news", "goto work https://example.com/"]);
});

test("what a page says comes to the model marked as content, not as instructions", async () => {
	await using t = await setup();
	t.env.faux.setResponses([call("browser_open", { url: "https://example.com/news" }), t.noting]);
	await t.say("ニュースを見て");
	const page = t.results[0]?.text ?? "";
	assert.ok(page.includes(UNTRUSTED));
	assert.ok(page.indexOf(UNTRUSTED) < page.indexOf('textbox "ユーザー名"'));
});

for (const url of ["file:///etc/passwd", "not a url"]) {
	test(`only a web address is opened, not "${url}"`, async () => {
		await using t = await setup();
		t.env.faux.setResponses([call("browser_open", { url }), t.noting]);
		await t.say("開いて");
		assert.equal(t.results[0]?.isError, true);
		assert.deepEqual(t.browsers.log, []);
	});
}

test("clicking, typing and pressing act on the refs given, in order", async () => {
	await using t = await setup();
	t.env.faux.setResponses([
		call("browser_open", { url: "https://example.com/" }),
		call("browser_type", { ref: "search", text: "緑茶", submit: true }),
		call("browser_click", { ref: "user" }),
		call("browser_press", { key: "PageDown" }),
		call("browser_back", {}),
		t.noting,
	]);
	await t.say("緑茶を検索して");
	assert.deepEqual(t.browsers.log, ["goto default https://example.com/", "fill search", "press Enter search", "click user", "press PageDown", "back"]);
});

test("after an action the model is given the page as it is then", async () => {
	await using t = await setup();
	t.env.faux.setResponses([call("browser_open", { url: "https://example.com/" }), call("browser_type", { ref: "search", text: "緑茶" }), t.noting]);
	await t.say("緑茶と入れて");
	assert.match(t.results[0]?.text ?? "", /search に入力済み: 緑茶/);
});

test("a long page is cut to what one tool result may carry, saying how much was left out", async () => {
	await using t = await setup();
	t.browsers.tree = "あ".repeat(1000);
	t.env.faux.setResponses([call("browser_open", { url: "https://example.com/" }), t.noting]);
	await t.say("長いページ");
	const tree = (t.results[0]?.text ?? "").split(UNTRUSTED)[1] ?? "";
	assert.equal(tree.match(/あ/g)?.length, 400);
	assert.match(tree, /600/);
});

/** Opens the shop's account page, fills the stored login into it, and reads the page, which now shows what was typed. */
async function logIn(t: Awaited<ReturnType<typeof setup>>) {
	t.env.faux.setResponses([
		call("browser_open", { url: "https://shop.example.com/account" }),
		call("browser_fill_credential", { usernameRef: "user", passwordRef: "pass", submit: true }),
		call("browser_read", {}),
		t.noting,
	]);
	await t.say("ログインして");
}

test("a stored login is typed into the page and submitted", async () => {
	await using t = await setup();
	await logIn(t);
	assert.equal(t.browsers.values.get("user"), "me@example.org");
	assert.equal(t.browsers.values.get("pass"), SECRET);
	assert.deepEqual(t.browsers.log.slice(1), ["fill user", "fill pass", "press Enter pass"]);
});

test("a stored password never reaches the model, even where the page shows it", async () => {
	await using t = await setup();
	await logIn(t);
	// The last request holds everything the model was given in the run: each tool result, the page included.
	assert.ok(everything(t.requests[0]!).includes("pass に入力済み"));
	assert.ok(!everything(t.requests[0]!).includes(SECRET));
});

test("the model is told on which sites it can log in, but not with what", async () => {
	await using t = await setup();
	await logIn(t);
	assert.match(instructionsOf(t.requests[0]!), /https:\/\/shop\.example\.com/);
	assert.ok(!instructionsOf(t.requests[0]!).includes("me@example.org"));
});

for (const [where, url, frame] of [
	["another site, however much it looks like the shop", "https://shop.example.com.evil.test/login", undefined],
	["the shop over plain http", "http://shop.example.com/login", undefined],
	["a form in a frame from another site", "https://shop.example.com/login", "https://ads.evil.test"],
] as const) {
	test(`a password is not filled into ${where}`, async () => {
		await using t = await setup();
		t.browsers.formOrigin = frame;
		t.env.faux.setResponses([call("browser_open", { url }), call("browser_fill_credential", { usernameRef: "user", passwordRef: "pass" }), t.noting]);
		await t.say("ログインして");
		assert.equal(t.results[0]?.isError, true);
		assert.equal(t.browsers.values.size, 0);
	});
}

test("a password is filled only into a password field, not a text box that would show or send it", async () => {
	await using t = await setup();
	t.env.faux.setResponses([call("browser_open", { url: "https://shop.example.com/forum" }), call("browser_fill_credential", { passwordRef: "search" }), t.noting]);
	await t.say("ここに入れて");
	assert.equal(t.results[0]?.isError, true);
	assert.equal(t.browsers.values.size, 0);
});

test("filling a login that names no field is refused", async () => {
	await using t = await setup();
	t.env.faux.setResponses([call("browser_open", { url: "https://shop.example.com/login" }), call("browser_fill_credential", {}), t.noting]);
	await t.say("何も指定しない");
	assert.equal(t.results[0]?.isError, true);
});

test("a run the scheduler started cannot use the browser", async () => {
	await using t = await setup();
	t.env.faux.setResponses([call("browser_open", { url: "https://example.com/" }), t.noting]);
	await t.bridge.submitScheduled(ROOM, "check:1", "[定時チェック] ...");
	await t.bridge.idle();
	assert.equal(t.results[0]?.isError, true);
	assert.deepEqual(t.browsers.log, []);
});

/** A credentials file in a directory of its own, written by the test. */
function credentialsFile() {
	const dir = tempDir();
	const path = join(dir.path, "credentials.json");
	return { credentials: new Credentials(path), write: (content: unknown) => writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content)), [Symbol.dispose]: () => dir[Symbol.dispose]() };
}

test("without a credentials file, no site has a login and nothing is hidden", () => {
	using t = credentialsFile();
	assert.deepEqual(t.credentials.origins(), []);
	assert.equal(t.credentials.scrub("nothing stored"), "nothing stored");
});

test("a login is stored for the origin of its URL, whatever the path, and a site on another port is another site", () => {
	using t = credentialsFile();
	t.write({ "https://a.example.com/login?x=1": { username: "a", password: "pw-a" }, "https://b.example.com:8443": { username: "b", password: "pw-b" } });
	assert.deepEqual(t.credentials.origins(), ["https://a.example.com", "https://b.example.com:8443"]);
	assert.equal(t.credentials.forOrigin("https://a.example.com")?.username, "a");
	assert.equal(t.credentials.forOrigin("https://b.example.com"), undefined);
});

test("the file is read again at each use, so an edit applies at once", () => {
	using t = credentialsFile();
	t.write({ "https://a.example.com": { username: "a", password: "pw-a" } });
	assert.deepEqual(t.credentials.origins(), ["https://a.example.com"]);
	t.write({});
	assert.deepEqual(t.credentials.origins(), []);
});

test("every stored password is hidden, and one inside another leaves no fragment behind", () => {
	using t = credentialsFile();
	t.write({ "https://a.example.com": { username: "a", password: "pw-long-one" }, "https://b.example.com": { username: "b", password: "pw-long" } });
	const hidden = t.credentials.scrub("x pw-long-one y pw-long z");
	assert.ok(!hidden.includes("pw-long"), hidden);
	assert.ok(hidden.startsWith("x ") && hidden.endsWith(" z") && hidden.includes(" y "), hidden);
});

test("a file that cannot be read is an error that does not quote it", () => {
	using t = credentialsFile();
	t.write('{ "https://a.example.com": { "username": "a", "password": "s3cret-value" ');
	assert.throws(
		() => t.credentials.origins(),
		(error: unknown) => error instanceof CredentialError && !error.message.includes("s3cret-value"),
	);
});

for (const [what, content] of [
	["a key that is not a URL", { "a.example.com": { username: "a", password: "x" } }],
	["a login without a password", { "https://a.example.com": { username: "a" } }],
] as const) {
	test(`a credentials file with ${what} is refused`, () => {
		using t = credentialsFile();
		t.write(content);
		assert.throws(() => t.credentials.origins(), CredentialError);
	});
}
