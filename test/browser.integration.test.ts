import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { type BrowserPage, PlaywrightBrowsers } from "../src/browser.ts";
import { createBrowserExtension, pngSize } from "../src/browser-tools.ts";
import { Credentials } from "../src/credentials.ts";
import { errorMessage } from "../src/errors.ts";
import { agentEnv, tempDir } from "./env.ts";
import { call, everything, lastToolResult, message, type Request } from "./fakes.ts";

/**
 * Drives a real Chromium through `src/browser.ts` against a small site served from this process. Skipped where
 * Chromium cannot be launched (not installed, or system libraries missing): install it with
 * `npx playwright-core install chromium`, and its libraries with `npx playwright-core install-deps chromium` or the
 * distribution's packages.
 */

const page = (body: string) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>テストサイト</title></head><body>${body}</body></html>`;

function body(request: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		let data = "";
		request.on("data", (chunk) => (data += chunk));
		request.on("end", () => resolve(data));
	});
}

function site(): Promise<Server> {
	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		const html = (text: string) => response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(text));
		if (url.pathname === "/") {
			html('<h1>トップ</h1><a href="/article">記事へ</a><form action="/search"><input name="q" aria-label="検索"><button>検索する</button></form>');
		} else if (url.pathname === "/article") {
			html("<h1>記事</h1><p>緑茶は発酵させない茶である。</p>");
		} else if (url.pathname === "/search") {
			html(`<p>「${url.searchParams.get("q")}」の検索結果</p>`);
		} else if (url.pathname === "/login" && request.method === "POST") {
			const form = new URLSearchParams(await body(request));
			const ok = form.get("username") === "me" && form.get("password") === "correct-horse";
			// Max-Age makes it a persistent cookie; a session cookie would not outlive the browser.
			response.writeHead(303, { location: "/account", ...(ok ? { "set-cookie": "session=ok; Max-Age=3600; Path=/" } : {}) }).end();
		} else if (url.pathname === "/login") {
			html('<form method="post" action="/login"><input name="username" aria-label="ユーザー名"><input type="password" name="password" aria-label="パスワード"><button>ログイン</button></form>');
		} else if (url.pathname === "/account") {
			html((request.headers.cookie ?? "").includes("session=ok") ? "<p>ようこそ、me さん</p>" : "<p>ログインしていません</p>");
		} else {
			response.writeHead(404).end();
		}
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const refOf = (tree: string, role: string, name: string): string => {
	const ref = new RegExp(`${role} "${name}"[^\\n]*\\[ref=(\\w+)\\]`).exec(tree)?.[1];
	assert.ok(ref, `no ${role} "${name}" in:\n${tree}`);
	return ref;
};

/**
 * The small site and a real browser with its profiles in a temporary directory, or `undefined` (the test skipped) where
 * Chromium cannot be launched. `restart` closes the browser and starts a new one on the same profiles.
 */
async function realBrowser(t: TestContext) {
	const dir = tempDir();
	const server = await site();
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const options = { dir: join(dir.path, "browser"), headless: true, timezone: "Asia/Tokyo", idleMs: 600_000 };
	let browsers = new PlaywrightBrowsers(options);
	const dispose = async () => {
		await browsers.close();
		await new Promise((resolve) => server.close(resolve));
		dir[Symbol.dispose]();
	};
	try {
		await (await browsers.page("default", 0)).goto(`${base}/`);
	} catch (error) {
		await dispose();
		t.skip(`Chromium cannot be launched here: ${errorMessage(error).split("\n")[0]}`);
		return undefined;
	}
	return {
		dir: dir.path,
		base,
		get browsers() {
			return browsers;
		},
		/** A page of `profile` for conversation `conversation`, at `path` of the site. */
		open: async (path: string, profile = "default", conversation = 1) => {
			const tab = await browsers.page(profile, conversation);
			await tab.goto(`${base}${path}`);
			return tab;
		},
		restart: async () => {
			await browsers.close();
			browsers = new PlaywrightBrowsers(options);
		},
		[Symbol.asyncDispose]: dispose,
	};
}

test("a link is followed by the ref the snapshot gave it", async (t) => {
	await using b = await realBrowser(t);
	if (b === undefined) return;
	const tab = await b.open("/");
	assert.equal((await tab.snapshot()).title, "テストサイト");
	await tab.click(refOf((await tab.snapshot()).tree, "link", "記事へ"));
	assert.equal((await tab.snapshot()).url, `${b.base}/article`);
	assert.match(await tab.text(), /緑茶は発酵させない茶である。/);
});

test("going back returns to the page before", async (t) => {
	await using b = await realBrowser(t);
	if (b === undefined) return;
	const tab = await b.open("/");
	await tab.goto(`${b.base}/article`);
	await tab.back();
	assert.equal((await tab.snapshot()).url, `${b.base}/`);
});

test("a text box is typed into by its ref, and Enter submits its form", async (t) => {
	await using b = await realBrowser(t);
	if (b === undefined) return;
	const tab = await b.open("/");
	const search = refOf((await tab.snapshot()).tree, "textbox", "検索");
	await tab.fill(search, "緑茶");
	await tab.press("Enter", search);
	assert.match((await tab.snapshot()).url, /\/search\?q=/);
	assert.match(await tab.text(), /「緑茶」の検索結果/);
});

test("a field is told apart as a text box or a password field, with the origin of its document", async (t) => {
	await using b = await realBrowser(t);
	if (b === undefined) return;
	const tab = await b.open("/login");
	const tree = (await tab.snapshot()).tree;
	assert.deepEqual(await tab.field(refOf(tree, "textbox", "ユーザー名")), { kind: "text", origin: b.base });
	assert.deepEqual(await tab.field(refOf(tree, "textbox", "パスワード")), { kind: "password", origin: b.base });
});

test("the snapshot shows what a text box holds, but never what a password field holds", async (t) => {
	await using b = await realBrowser(t);
	if (b === undefined) return;
	const tab = await b.open("/login");
	const tree = (await tab.snapshot()).tree;
	await tab.fill(refOf(tree, "textbox", "ユーザー名"), "me");
	await tab.fill(refOf(tree, "textbox", "パスワード"), "correct-horse");
	const after = (await tab.snapshot()).tree;
	assert.match(after, /textbox "ユーザー名"[^\n]*: me\n/);
	assert.doesNotMatch(after, /correct-horse/);
});

/** Logs in on the site's form in `tab`. */
async function logIn(tab: BrowserPage) {
	const tree = (await tab.snapshot()).tree;
	await tab.fill(refOf(tree, "textbox", "ユーザー名"), "me");
	await tab.fill(refOf(tree, "textbox", "パスワード"), "correct-horse");
	await tab.press("Enter", refOf(tree, "textbox", "パスワード"));
}

test("conversations of one profile have tabs of their own and share its login; another profile does not", async (t) => {
	await using b = await realBrowser(t);
	if (b === undefined) return;
	const tab = await b.open("/login", "default", 1);
	await logIn(tab);
	assert.match(await tab.text(), /ようこそ、me さん/);

	const other = await b.open("/account", "default", 2);
	assert.match(await other.text(), /ようこそ/);
	assert.equal((await tab.snapshot()).url, `${b.base}/account`, "the first tab stays where it was");
	assert.match(await (await b.open("/account", "stranger", 1)).text(), /ログインしていません/);
});

test("a login is kept in the profile on disk, for the next browser process", async (t) => {
	await using b = await realBrowser(t);
	if (b === undefined) return;
	await logIn(await b.open("/login"));
	await b.restart();
	assert.match(await (await b.open("/account")).text(), /ようこそ、me さん/);
});

test("the tools log in on a real page with a stored password the model never sees", async (t) => {
	await using b = await realBrowser(t);
	if (b === undefined) return;
	const credentials = join(b.dir, "credentials.json");
	writeFileSync(credentials, JSON.stringify({ [b.base]: { username: "me", password: "correct-horse" } }));
	await using env = await agentEnv({
		config: { browser: {} },
		extensions: ({ db }) => [createBrowserExtension({ browsers: b.browsers, credentials: new Credentials(credentials), db, profileOf: () => "default" })],
	});
	const requests: Request[] = [];
	env.faux.setResponses([
		call("browser_open", { url: `${b.base}/login` }),
		// The model reads the refs off the snapshot it was just given, as it would.
		(request: Request) => {
			const page = lastToolResult(request).text;
			return call("browser_fill_credential", { usernameRef: refOf(page, "textbox", "ユーザー名"), passwordRef: refOf(page, "textbox", "パスワード"), submit: true });
		},
		call("browser_read", {}),
		(request: Request) => {
			requests.push(request);
			return fauxAssistantMessage("ok");
		},
	]);
	const bridge = env.bridge();
	env.link.emit(message("!main:example.org", "$1", "ログインして"));
	await bridge.idle();

	assert.match(lastToolResult(requests[0]!).text, /ようこそ、me さん/);
	assert.doesNotMatch(everything(requests[0]!), /correct-horse/);
});

test("a screenshot is a PNG of the window, or of the whole page when asked", async (t) => {
	await using b = await realBrowser(t);
	if (b === undefined) return;
	const tab = await b.open("/login");
	const shot = await tab.screenshot(false);
	assert.equal(shot.subarray(1, 4).toString(), "PNG");
	assert.deepEqual(pngSize(shot), { width: 1280, height: 800 });
	assert.ok(pngSize(await tab.screenshot(true)).height >= 1);
});
