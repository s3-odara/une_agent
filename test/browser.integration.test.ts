import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { PlaywrightBrowsers } from "../src/browser.ts";
import { createBrowserExtension } from "../src/browser-tools.ts";
import { parseConfig } from "../src/config.ts";
import { Credentials } from "../src/credentials.ts";
import { openAgentHarness } from "../src/harness.ts";
import { HostDb } from "../src/hostdb.ts";
import { Bridge } from "../src/rooms.ts";
import { FakeLink, message } from "./fakes.ts";

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

test("a real browser can be driven by ref, logs in, and keeps its login in the profile", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "agent-browser-it-"));
	const server = await site();
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const options = { dir, headless: true, timezone: "Asia/Tokyo", idleMs: 600_000 };
	let browsers = new PlaywrightBrowsers(options);
	try {
		let tab;
		try {
			tab = await browsers.page("default", 1);
			await tab.goto(`${base}/`);
		} catch (error) {
			t.skip(`Chromium cannot be launched here: ${String(error instanceof Error ? error.message : error).split("\n")[0]}`);
			return;
		}

		// Read the page, follow a link by its ref.
		let view = await tab.snapshot();
		assert.equal(view.title, "テストサイト");
		await tab.click(refOf(view.tree, "link", "記事へ"));
		view = await tab.snapshot();
		assert.equal(view.url, `${base}/article`);
		assert.match(await tab.text(), /緑茶は発酵させない茶である。/);

		// Back, type into a field, submit with Enter.
		await tab.back();
		view = await tab.snapshot();
		const search = refOf(view.tree, "textbox", "検索");
		assert.deepEqual(await tab.field(search), { kind: "text", origin: base });
		await tab.fill(search, "緑茶");
		await tab.press("Enter", search);
		assert.match((await tab.snapshot()).url, /\/search\?q=/);
		assert.match(await tab.text(), /「緑茶」の検索結果/);

		// Log in. The password field is recognised as one, in the document of this origin.
		await tab.goto(`${base}/login`);
		view = await tab.snapshot();
		const [user, pass] = [refOf(view.tree, "textbox", "ユーザー名"), refOf(view.tree, "textbox", "パスワード")];
		assert.deepEqual(await tab.field(pass), { kind: "password", origin: base });
		await tab.fill(user, "me");
		await tab.fill(pass, "correct-horse");
		// The tree shows what a text box holds, but never what a password field holds.
		view = await tab.snapshot();
		assert.match(view.tree, /textbox "ユーザー名"[^\n]*: me\n/);
		assert.match(view.tree, /textbox "パスワード"[^\n]*: ［伏せ字］/);
		assert.doesNotMatch(view.tree, /correct-horse/);
		// Taking the snapshot gave the fields new refs; the old ones are still the same elements.
		await tab.press("Enter", refOf(view.tree, "textbox", "パスワード"));
		assert.equal((await tab.snapshot()).url, `${base}/account`);
		assert.match(await tab.text(), /ようこそ、me さん/);

		// Another conversation has its own tab and the same cookies; another profile has neither.
		const other = await browsers.page("default", 2);
		await other.goto(`${base}/account`);
		assert.match(await other.text(), /ようこそ/);
		assert.equal((await tab.snapshot()).url, `${base}/account`);
		const stranger = await browsers.page("other", 1);
		await stranger.goto(`${base}/account`);
		assert.match(await stranger.text(), /ログインしていません/);

		// The login is in the profile on disk: a new browser process still has it.
		await browsers.close();
		browsers = new PlaywrightBrowsers(options);
		const again = await browsers.page("default", 1);
		await again.goto(`${base}/account`);
		assert.match(await again.text(), /ようこそ、me さん/);
	} finally {
		await browsers.close();
		await new Promise((resolve) => server.close(resolve));
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the tools log in on a real page with a stored password the model never sees", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "agent-browser-it-"));
	const server = await site();
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const browsers = new PlaywrightBrowsers({ dir: join(dir, "browser"), headless: true, timezone: "Asia/Tokyo", idleMs: 600_000 });
	try {
		await (await browsers.page("default", 0)).goto(`${base}/`);
	} catch (error) {
		await browsers.close();
		await new Promise((resolve) => server.close(resolve));
		rmSync(dir, { recursive: true, force: true });
		t.skip(`Chromium cannot be launched here: ${String(error instanceof Error ? error.message : error).split("\n")[0]}`);
		return;
	}

	writeFileSync(join(dir, "soul.md"), "SOUL");
	writeFileSync(join(dir, "credentials.json"), JSON.stringify({ [base]: { username: "me", password: "correct-horse" } }));
	const faux = fauxProvider();
	const model = faux.getModel();
	const config = parseConfig(
		{
			matrix: { homeserver: "https://example.org", userId: "@agent:example.org", allowedUsers: ["@me:example.org"] },
			model: { provider: model.provider, modelId: model.id },
			personas: { default: "soul.md" },
			browser: {},
		},
		dir,
	);
	const models = createModels();
	models.setProvider(faux.provider);
	const db = new HostDb(join(dir, "host.sqlite"));
	const extension = createBrowserExtension({ browsers, credentials: new Credentials(join(dir, "credentials.json")), db, profileOf: () => "default" });
	const harness = await openAgentHarness(new MemoryStorage(), models, context, [extension]);
	try {
		type Request = { messages: { role: string; content: unknown }[] };
		const lastResult = (request: Request) =>
			((request.messages.findLast((item) => item.role === "toolResult")?.content as { text?: string }[] | undefined) ?? []).map((block) => block.text ?? "").join("");
		const call = (name: string, args: Record<string, string | boolean>) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

		faux.setResponses([
			call("browser_open", { url: `${base}/login` }),
			// The model reads the refs off the snapshot it was just given, as it would.
			(request: Request) =>
				call("browser_fill_credential", { usernameRef: refOf(lastResult(request), "textbox", "ユーザー名"), passwordRef: refOf(lastResult(request), "textbox", "パスワード"), submit: true }),
			call("browser_read", {}),
			(request: Request) => fauxAssistantMessage(JSON.stringify(request.messages)),
		]);
		const link = new FakeLink();
		const bridge = new Bridge({ harness, db, link, config, context });
		bridge.start();
		link.emit(message("!main:example.org", "$1", "ログインして"));
		await bridge.idle();

		const transcript = link.bodyIn("!main:example.org");
		assert.match(transcript, /の認証情報を入力しました。/);
		assert.match(transcript, /ようこそ、me さん/);
		assert.doesNotMatch(transcript, /correct-horse/);
	} finally {
		await harness.close(context);
		db.close();
		await browsers.close();
		await new Promise((resolve) => server.close(resolve));
		rmSync(dir, { recursive: true, force: true });
	}
});
