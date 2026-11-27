import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type BrowserPage, type Browsers, type FieldInfo, VIEWPORT } from "../src/browser.ts";
import { createBrowserExtension, pngSize } from "../src/browser-tools.ts";
import { UNTRUSTED } from "../src/untrusted.ts";
import { CodeRequests, noCode } from "../src/codes.ts";
import { persona, personaFor } from "../src/config.ts";
import type { Bridge } from "../src/rooms.ts";
import { Credentials } from "../src/credentials.ts";
import { Proactive, createProactiveExtension } from "../src/proactive.ts";
import { agentEnv, context } from "./env.ts";
import {
	call,
	everything,
	imagesIn,
	lastInput,
	lastToolResult,
	message,
	noting,
	type Request,
	type ToolResult,
} from "./fakes.ts";

/** The header of a PNG image of 640 x 480: all a reader of its size looks at. */
const PNG = Buffer.concat([
	Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
	Buffer.from([0, 0, 2, 128, 0, 0, 1, 224]),
]);

/** Only its first bytes: what the model is given is not looked into. */
const JPEG = Buffer.from("ffd8ffe000104a464946", "hex");

const ROOM = "!main:example.org";

const SECRET = "correct-horse-battery";

/** Its one page shows whatever was typed into it, as a real page may. */
class FakeBrowsers implements Browsers {
	readonly log: string[] = [];
	readonly values = new Map<string, string>();
	url = "about:blank";
	/** Differs from the page's origin when the login form is in a frame. */
	formOrigin: string | undefined;
	tree: string | undefined;
	text: string | undefined;

	async page(profile: string, _roomId: string): Promise<BrowserPage> {
		const fields: Record<string, string> = { user: "text", pass: "password", search: "text" };
		return {
			goto: async (url) => {
				this.log.push(`goto ${profile} ${url}`);
				this.url = url;
			},
			back: async () => void this.log.push("back"),
			location: async () => ({ url: this.url, title: "テストページ" }),
			snapshot: async () => ({
				url: this.url,
				title: "テストページ",
				tree:
					this.tree ??
					[
						'- textbox "ユーザー名" [ref=user]',
						'- textbox "パスワード" [ref=pass]',
						...[...this.values].map(([ref, value]) => `- text: ${ref} に入力済み: ${value}`),
					].join("\n"),
			}),
			read: async (whole) => ({
				url: this.url,
				title: "テストページ",
				markdown: this.text ?? `本文 ${[...this.values.values()].join(" ")}`,
				scope: whole ? "page" : "article",
			}),
			click: async (ref) => void this.log.push(`click ${ref}`),
			clickAt: async (x, y) => void this.log.push(`click at ${x},${y}`),
			fill: async (ref, text) => {
				this.log.push(`fill ${ref}`);
				this.values.set(ref, text);
			},
			press: async (key, ref) => void this.log.push(`press ${key} ${ref ?? ""}`.trim()),
			screenshot: async ({ fullPage, format, mark }) => {
				this.log.push(
					`screenshot ${format}${fullPage === true ? " full" : ""}${mark === undefined ? "" : ` marked ${mark.x},${mark.y}`}`,
				);
				return format === "png" ? PNG : JPEG;
			},
			field: async (ref): Promise<FieldInfo> => {
				const kind = fields[ref];
				if (kind === undefined) throw new Error(`no element with ref ${ref}`);
				return { kind, origin: this.formOrigin ?? new URL(this.url).origin };
			},
		};
	}
	async close(): Promise<void> {}
}

async function setup() {
	const browsers = new FakeBrowsers();
	// The bridge posts the code requests; it is made once the agent is.
	let bridge: Bridge | undefined;
	const viaBridge = () => bridge as Bridge;
	const codes = new CodeRequests({
		notice: (roomId, txnId, body) => viaBridge().post(roomId, txnId, body),
		timeoutMs: 60_000,
	});
	let credentials!: Credentials;
	const env = await agentEnv({
		config: {
			personas: { default: "soul.md", work: { soul: "soul.md", browserProfile: "work" } },
			rooms: { "!work:example.org": "work" },
			browser: {},
		},
		codemode: {},
		extensions: ({ config, db }) => {
			const path = join(config.dataDir, "credentials.json");
			writeFileSync(
				path,
				JSON.stringify({ "https://shop.example.com/login": { username: "me@example.org", password: SECRET } }),
			);
			credentials = new Credentials(path);
			return [
				// The weighing of a check refuses the browser's writing tools.
				createProactiveExtension({ db, tz: "Asia/Tokyo" }),
				createBrowserExtension({
					browsers,
					credentials,
					db,
					profileOf: (conversationId) => {
						const roomId = db.roomOf(conversationId);
						return roomId === undefined ? undefined : persona(config, personaFor(config, roomId)).browserProfile;
					},
					maxChars: 400,
					codes,
					screenshots: {
						send: (roomId, txnId, image) =>
							viaBridge().sendAttachment(roomId, txnId, { ...image, mimeType: "image/png" }),
						dir: join(config.dataDir, "shots"),
					},
				}),
			];
		},
	});
	bridge = env.bridge({ handlers: [codes] });
	const requests: Request[] = [];
	const results: ToolResult[] = [];
	let n = 0;
	return {
		env,
		bridge: bridge as Bridge,
		browsers,
		credentials,
		requests,
		results,
		noting: noting(results, requests),
		say: async (body: string, roomId = ROOM) => {
			env.link.emit(message(roomId, `$${++n}`, body));
			await viaBridge().idle();
		},
		sayThenAnswer: async (body: string, answer: string, asReply: boolean) => {
			env.link.emit(message(ROOM, `$${++n}`, body));
			const request = await env.link.waitFor("send", (command) => command.txnId.startsWith("code:"));
			// A person can only reply once the request is in the room: let the gateway's answer to the send arrive.
			await new Promise((resolve) => setImmediate(resolve));
			env.link.emit(message(ROOM, `$${++n}`, answer, 0, asReply ? `$sent-${request.txnId}` : undefined));
			await viaBridge().idle();
		},
		[Symbol.asyncDispose]: () => env[Symbol.asyncDispose](),
	};
}

test("a page is opened in the browser profile of the room's persona", async () => {
	await using t = await setup();
	t.env.faux.setResponses([
		call("browser_open", { url: "https://example.com/news" }),
		t.noting,
		call("browser_open", { url: "https://example.com/" }),
		t.noting,
	]);
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
	assert.deepEqual(t.browsers.log, [
		"goto default https://example.com/",
		"fill search",
		"press Enter search",
		"click user",
		"press PageDown",
		"back",
	]);
});

test("after an action the model is given the page as it is then", async () => {
	await using t = await setup();
	t.env.faux.setResponses([
		call("browser_open", { url: "https://example.com/" }),
		call("browser_type", { ref: "search", text: "緑茶" }),
		t.noting,
	]);
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

test("a script in a run the user started uses the browser, and a stored password the page shows never reaches it", async () => {
	await using t = await setup();
	const script = [
		'await tools.browser_open({ url: "https://shop.example.com/account" });',
		'await tools.browser_fill_credential({ usernameRef: "user", passwordRef: "pass" });',
		"return await tools.browser_read({});",
	].join("\n");
	t.env.faux.setResponses([call("codemode", { code: script }), t.noting]);
	await t.say("ログインして");
	assert.equal(t.results[0]?.isError, false);
	assert.equal(t.browsers.values.get("pass"), SECRET);
	assert.ok(t.results[0]?.text.includes("本文"));
	assert.ok(!everything(t.requests[0]!).includes(SECRET));
});

for (const [where, url, frame] of [
	["another site, however much it looks like the shop", "https://shop.example.com.evil.test/login", undefined],
	["the shop over plain http", "http://shop.example.com/login", undefined],
	["a form in a frame from another site", "https://shop.example.com/login", "https://ads.evil.test"],
] as const) {
	test(`a password is not filled into ${where}`, async () => {
		await using t = await setup();
		t.browsers.formOrigin = frame;
		t.env.faux.setResponses([
			call("browser_open", { url }),
			call("browser_fill_credential", { usernameRef: "user", passwordRef: "pass" }),
			t.noting,
		]);
		await t.say("ログインして");
		assert.equal(t.results[0]?.isError, true);
		assert.equal(t.browsers.values.size, 0);
	});
}

test("a password is filled only into a password field, not a text box that would show or send it", async () => {
	await using t = await setup();
	t.env.faux.setResponses([
		call("browser_open", { url: "https://shop.example.com/forum" }),
		call("browser_fill_credential", { passwordRef: "search" }),
		t.noting,
	]);
	await t.say("ここに入れて");
	assert.equal(t.results[0]?.isError, true);
	assert.equal(t.browsers.values.size, 0);
});

test("a page of a site with a password stored says so but not with what, also when the password was added after the conversation began", async () => {
	await using t = await setup();
	t.env.faux.setResponses([
		call("browser_open", { url: "https://accounts.example.org/login" }),
		t.noting,
		call("browser_open", { url: "https://accounts.example.org/login" }),
		t.noting,
	]);
	await t.say("ログイン画面を開いて");
	t.credentials.set("https://accounts.example.org", { username: "someone@example.org", password: "pw-2" });
	await t.say("もう一度開いて");
	assert.ok(!(t.results[0]?.text ?? "").includes("browser_fill_credential"));
	assert.match(t.results[1]?.text ?? "", /https:\/\/accounts\.example\.org.*browser_fill_credential/);
	assert.ok(!(t.results[1]?.text ?? "").includes("someone@example.org"));
});

test("filling a login that names no field is refused", async () => {
	await using t = await setup();
	t.env.faux.setResponses([
		call("browser_open", { url: "https://shop.example.com/login" }),
		call("browser_fill_credential", {}),
		t.noting,
	]);
	await t.say("何も指定しない");
	assert.equal(t.results[0]?.isError, true);
});

test("a check the bot makes of its own accord may read pages, but not share a screenshot to the room", async () => {
	await using t = await setup();
	t.env.faux.setResponses([
		call("browser_open", { url: "https://example.com/" }),
		call("browser_screenshot", { share: true }),
		t.noting,
	]);
	const proactive = new Proactive({ harness: t.env.harness, db: t.env.db, rooms: t.bridge, context, log: () => {} });
	t.env.db.addWake({
		key: "check:1",
		roomId: ROOM,
		kind: "check",
		content: "[定時チェック] ...",
		createdAt: Date.now(),
	});
	await proactive.run();
	await t.bridge.idle();
	assert.deepEqual(t.browsers.log, ["goto default https://example.com/"]);
	assert.equal(t.results[0]?.isError, true);
	assert.match(t.results[0]?.text ?? "", /ルームに画像を送れません/);
	assert.deepEqual(t.env.link.of("sendAttachment"), []);
});

test("a check cannot use a browser tool that writes, the refusal is what the model gets", async () => {
	await using t = await setup();
	t.env.faux.setResponses([call("browser_click", { ref: "e1" }), t.noting]);
	const proactive = new Proactive({ harness: t.env.harness, db: t.env.db, rooms: t.bridge, context, log: () => {} });
	t.env.db.addWake({
		key: "check:2",
		roomId: ROOM,
		kind: "check",
		content: "[定時チェック] ...",
		createdAt: Date.now(),
	});
	await proactive.run();
	await t.bridge.idle();
	assert.equal(t.results[0]?.isError, true);
	assert.match(t.results[0]?.text ?? "", /書き込むツールは使えません/);
	assert.deepEqual(t.browsers.log, []);
});

for (const [how, code, asReply] of [
	["as a reply to the request", "AB 12-cd", true],
	["as a message of one word", "Q7X-29K", false],
] as const) {
	test(`a code the user sends ${how} is typed into the field, and the model never sees it`, async () => {
		await using t = await setup();
		t.env.faux.setResponses([
			call("browser_open", { url: "https://example.com/" }),
			call("browser_request_code", { ref: "search", submit: true }),
			t.noting,
			t.noting,
		]);
		await t.sayThenAnswer("ログインして", code, asReply);
		const typed = code.replace(/\s+/g, "");
		assert.equal(t.browsers.values.get("search"), typed);
		assert.ok(t.browsers.log.includes("press Enter search"));
		assert.ok(t.requests.every((request) => !everything(request).includes(typed)));
	});
}

test("a message that is not a code ends the request, and reaches the model as said", async () => {
	await using t = await setup();
	t.env.faux.setResponses([
		call("browser_open", { url: "https://example.com/" }),
		call("browser_request_code", { ref: "search" }),
		t.noting,
		t.noting,
	]);
	await t.sayThenAnswer("ログインして", "やっぱりやめて", false);
	assert.equal(t.results[0]?.text, noCode("message"));
	assert.equal(t.browsers.values.get("search"), undefined);
	assert.ok(lastInput(t.requests.at(-1) as Request).includes("やっぱりやめて"));
});

test("a screenshot is shown to the model as an image of the window, with the size its points are given in", async () => {
	await using t = await setup();
	t.env.faux.setResponses([
		call("browser_open", { url: "https://example.com/" }),
		call("browser_screenshot", {}),
		t.noting,
	]);
	await t.say("画面を見て");
	assert.deepEqual(imagesIn(t.requests[0]!), [
		{ type: "image", data: JPEG.toString("base64"), mimeType: "image/jpeg" },
	]);
	assert.match(t.results[0]?.text ?? "", new RegExp(`${VIEWPORT.width}×${VIEWPORT.height}`));
	assert.deepEqual(t.env.link.of("sendAttachment"), []);
});

test("a screenshot shared with the user goes to the room of the conversation as an image of its size, and the model sees it too", async () => {
	await using t = await setup();
	t.env.faux.setResponses([
		call("browser_open", { url: "https://example.com/" }),
		call("browser_screenshot", { share: true, fullPage: true }),
		t.noting,
	]);
	await t.say("画面を見せて");
	assert.ok(t.browsers.log.includes("screenshot png full"));
	const [sent] = t.env.link.of("sendAttachment");
	assert.equal(sent?.roomId, ROOM);
	assert.deepEqual({ width: sent?.width, height: sent?.height }, pngSize(PNG));
	assert.equal(imagesIn(t.requests[0]!).length, 1);
});

test("a click at a point clicks there, and the model sees the window after it with the point marked", async () => {
	await using t = await setup();
	t.env.faux.setResponses([
		call("browser_open", { url: "https://example.com/" }),
		call("browser_click_at", { x: 300, y: 200 }),
		t.noting,
	]);
	await t.say("画像認証を解いて");
	assert.deepEqual(t.browsers.log.slice(1), ["click at 300,200", "screenshot jpeg marked 300,200"]);
	assert.equal(imagesIn(t.requests[0]!).length, 1);
});

test("a click outside the window is refused without clicking", async () => {
	await using t = await setup();
	t.env.faux.setResponses([
		call("browser_open", { url: "https://example.com/" }),
		call("browser_click_at", { x: VIEWPORT.width, y: 10 }),
		t.noting,
	]);
	await t.say("押して");
	assert.equal(t.results[0]?.isError, true);
	assert.ok(!t.browsers.log.some((line) => line.startsWith("click")));
});
