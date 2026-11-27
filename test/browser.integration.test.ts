import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type TestContext, test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { type BrowserPage, PlaywrightBrowsers } from "../src/browser.ts";
import { createBrowserExtension, pngSize } from "../src/browser-tools.ts";
import { Credentials } from "../src/credentials.ts";
import { beacon, egressTo, noChromium, rendererRoots } from "./chromium.ts";
import { agentEnv, listen, tempDir } from "./env.ts";
import { call, everything, lastToolResult, message, type Request } from "./fakes.ts";

/**
 * Drives a real Chromium through `src/browser.ts` against a small site served from this process, under the sandbox
 * built by `just test`. Skipped outside the dev shell (see `chromium.ts`).
 */

const page = (body: string) =>
	`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>テストサイト</title></head><body>${body}</body></html>`;

function body(request: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		let data = "";
		request.on("data", (chunk) => (data += chunk));
		request.on("end", () => resolve(data));
	});
}

function site(beacon: string, fontRequested: () => void): Server {
	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		const html = (text: string) =>
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(text));
		if (url.pathname === "/") {
			html(
				'<h1>トップ</h1><a href="/article">記事へ</a><form action="/search"><input name="q" aria-label="検索"><button>検索する</button></form>',
			);
		} else if (url.pathname === "/leak") {
			html(`<p>表の本文</p><img src="${beacon}/img">`);
		} else if (url.pathname === "/article") {
			html("<h1>記事</h1><p>緑茶は発酵させない茶である。</p>");
		} else if (url.pathname === "/strict") {
			// A long article on a page whose policy forbids every script: the extraction must still run.
			response.writeHead(200, {
				"content-type": "text/html; charset=utf-8",
				"content-security-policy": "script-src 'none'",
			});
			response.end(
				page(
					`<nav><a href="/">ホーム</a></nav><article><h1>記事</h1>${"<p>緑茶は発酵させない茶で、蒸し製と釜炒り製がある。日本では蒸し製が主流である。</p>".repeat(8)}</article>`,
				),
			);
		} else if (url.pathname === "/search") {
			html(`<p>「${url.searchParams.get("q")}」の検索結果</p>`);
		} else if (url.pathname === "/login" && request.method === "POST") {
			const form = new URLSearchParams(await body(request));
			const ok = form.get("username") === "me" && form.get("password") === "correct-horse";
			// Max-Age makes it a persistent cookie; a session cookie would not outlive the browser.
			response
				.writeHead(303, { location: "/account", ...(ok ? { "set-cookie": "session=ok; Max-Age=3600; Path=/" } : {}) })
				.end();
		} else if (url.pathname === "/login") {
			html(
				'<form method="post" action="/login"><input name="username" aria-label="ユーザー名"><input type="password" name="password" aria-label="パスワード"><button>ログイン</button></form>',
			);
		} else if (url.pathname === "/slow-font") {
			html(
				`<style>@font-face { font-family: Stalled; src: url('/slow.woff2'); font-display: swap } p { font-family: Stalled, sans-serif }</style><p>画面の本文</p>`,
			);
		} else if (url.pathname === "/slow.woff2") {
			fontRequested();
		} else if (url.pathname === "/canvas") {
			// Drawn, not built of elements: nothing in it has a ref.
			html(
				'<canvas width="1280" height="800" style="position:fixed;left:0;top:0"></canvas><p id="hit">まだ</p><script>document.querySelector("canvas").addEventListener("click", (e) => { document.getElementById("hit").textContent = "押された位置 " + e.clientX + "," + e.clientY; });</script>',
			);
		} else if (url.pathname === "/account") {
			html(
				(request.headers.cookie ?? "").includes("session=ok")
					? "<p>ようこそ、me さん</p>"
					: "<p>ログインしていません</p>",
			);
		} else {
			response.writeHead(404).end();
		}
	});
	return server;
}

const textOf = async (tab: BrowserPage) => (await tab.read(true)).markdown;

const refOf = (tree: string, role: string, name: string): string => {
	const ref = new RegExp(`${role} "${name}"[^\\n]*\\[ref=(\\w+)\\]`).exec(tree)?.[1];
	assert.ok(ref, `no ${role} "${name}" in:\n${tree}`);
	return ref;
};

async function realBrowser(t: TestContext) {
	if (noChromium) {
		t.skip(noChromium);
		return undefined;
	}
	const dir = tempDir();
	const inside = await beacon();
	let fontRequests = 0;
	const server = site(inside.url, () => {
		fontRequests++;
	});
	const port = await listen(server);
	const base = `http://127.0.0.1:${port}`;
	const egress = await egressTo(port);
	const options = { dir: join(dir.path, "browser"), egress, timezone: "Asia/Tokyo", idleMs: 600_000 };
	let browsers = new PlaywrightBrowsers(options);
	const dispose = async () => {
		await browsers.close();
		await egress.close();
		await new Promise((resolve) => server.close(resolve));
		await inside.close();
		dir[Symbol.dispose]();
	};
	return {
		dir: dir.path,
		base,
		beacon: inside.url,
		hits: inside.hits,
		get fontRequests() {
			return fontRequests;
		},
		get browsers() {
			return browsers;
		},
		open: async (path: string, profile = "default", room = "!a:example.org") => {
			const tab = await browsers.page(profile, room);
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
	assert.match(await textOf(tab), /緑茶は発酵させない茶である。/);
});

test("the pages are rendered where the files of this machine cannot be seen", async (t) => {
	await using b = await realBrowser(t);
	if (b === undefined) return;
	await b.open("/");
	const roots = rendererRoots();
	assert.ok(roots.length > 0);
	assert.ok(!roots.includes("/"), `roots of the renderers: ${roots}`);
});

test("the browser cannot open the user's files, though a page asks it to", async (t) => {
	await using b = await realBrowser(t);
	if (b === undefined) return;
	using files = tempDir();
	const userFile = join(files.path, "secret.txt");
	writeFileSync(userFile, "ユーザーの秘密");
	const tab = await b.browsers.page("default", "!a:example.org");
	await tab.goto(pathToFileURL(userFile).href).catch(() => {});
	assert.doesNotMatch(await textOf(tab), /ユーザーの秘密/);
});

test("neither a page nor the browser itself reaches another server on this host", async (t) => {
	await using b = await realBrowser(t);
	if (b === undefined) return;
	const tab = await b.open("/leak");
	assert.match(await textOf(tab), /表の本文/);
	await tab.goto(`${b.beacon}/open`).catch(() => {});
	assert.deepEqual(b.hits, []);
});

test("a page is read as its main text, or whole when asked, also where the page forbids scripts", async (t) => {
	await using b = await realBrowser(t);
	if (b === undefined) return;
	const tab = await b.open("/strict");
	const main = await tab.read(false);
	assert.equal(main.scope, "article");
	assert.match(main.markdown, /蒸し製が主流/);
	assert.doesNotMatch(main.markdown, /ホーム/);
	assert.match((await tab.read(true)).markdown, /ホーム/);
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
	assert.match(await textOf(tab), /「緑茶」の検索結果/);
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

async function logIn(tab: BrowserPage) {
	const tree = (await tab.snapshot()).tree;
	await tab.fill(refOf(tree, "textbox", "ユーザー名"), "me");
	await tab.fill(refOf(tree, "textbox", "パスワード"), "correct-horse");
	await tab.press("Enter", refOf(tree, "textbox", "パスワード"));
}

test("rooms of one profile have tabs of their own and share its login; another profile does not", async (t) => {
	await using b = await realBrowser(t);
	if (b === undefined) return;
	const tab = await b.open("/login", "default", "!a:example.org");
	await logIn(tab);
	assert.match(await textOf(tab), /ようこそ、me さん/);

	const other = await b.open("/account", "default", "!b:example.org");
	assert.match(await textOf(other), /ようこそ/);
	assert.equal((await tab.snapshot()).url, `${b.base}/account`, "the first tab stays where it was");
	assert.match(await textOf(await b.open("/account", "stranger", "!a:example.org")), /ログインしていません/);
});

test("a login is kept in the profile on disk, for the next browser process", async (t) => {
	await using b = await realBrowser(t);
	if (b === undefined) return;
	await logIn(await b.open("/login"));
	await b.restart();
	assert.match(await textOf(await b.open("/account")), /ようこそ、me さん/);
});

test("a screenshot is returned while a web font request is still pending", async (t) => {
	await using b = await realBrowser(t);
	if (b === undefined) return;
	const tab = await b.open("/slow-font");
	assert.ok(b.fontRequests > 0);
	assert.ok((await tab.screenshot({ format: "png" })).length > 0);
});

test("a screenshot is of the window at the size of its CSS pixels, or of the whole page when asked", async (t) => {
	await using b = await realBrowser(t);
	if (b === undefined) return;
	const tab = await b.open("/login");
	const shot = await tab.screenshot({ format: "png" });
	assert.deepEqual(pngSize(shot), { width: 1280, height: 800 });
	assert.ok(pngSize(await tab.screenshot({ format: "png", fullPage: true })).height >= 1);
});

test("a click at a point of the window reaches what is drawn there, though it has no ref", async (t) => {
	await using b = await realBrowser(t);
	if (b === undefined) return;
	const tab = await b.open("/canvas");
	await tab.screenshot({ format: "jpeg", mark: { x: 1100, y: 780 } });
	await tab.clickAt(1100, 780);
	assert.match(await textOf(tab), /押された位置 1100,780/);
});
