import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type TestContext, test } from "node:test";
import { EgressProxy } from "../src/egress.ts";
import { errorMessage } from "../src/errors.ts";
import { PlaywrightReader, ReadError } from "../src/extract.ts";
import { rendererRoots } from "./chromium.ts";

/**
 * Reads pages of a small site served from this process in a real Chromium through `src/extract.ts`. The egress proxy
 * lets the browser reach that site and nothing else on this host, as it lets the deployed one reach only public
 * addresses. Skipped where Chromium cannot be launched (see `browser.integration.test.ts`).
 */

const PARAGRAPH = "緑茶は茶葉を摘んだ直後に加熱して発酵を止めた茶で、蒸し製と釜炒り製がある。日本では蒸し製が主流で、煎茶、玉露、かぶせ茶などに分かれる。";

const html = (title: string, body: string, head = "") => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;

function site(beacon: string): Server {
	return createServer((request, response) => {
		const page = (status: number, text: string) => response.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(text);
		switch (new URL(request.url ?? "/", "http://localhost").pathname) {
			case "/article":
				return page(
					200,
					html(
						"緑茶の話 | お茶のサイト",
						`<nav><a href="/">ホーム</a> <a href="/shop">ショップ</a> <a href="/about">このサイトについて</a></nav>
						<article><h1>緑茶の話</h1>${`<p>${PARAGRAPH}</p>`.repeat(4)}<p>詳しくは<a href="/more">続きの記事</a>を読む。</p><img src="data:image/png;base64,${"A".repeat(5000)}" alt="茶畑"></article>
						<footer>© お茶のサイト</footer>`,
					),
				);
			case "/rendered":
				// The content exists only once the page's script has run.
				return page(200, html("動的なページ", '<div id="app"></div><script>document.getElementById("app").innerHTML = "<p>スクリプトが書いた本文</p>";</script>'));
			case "/strict":
				// A page whose policy forbids every script, which must not stop the extraction.
				response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "script-src 'none'" });
				return response.end(html("厳しいページ", `<article><h1>見出し</h1>${`<p>${PARAGRAPH}</p>`.repeat(3)}</article>`));
			case "/leak":
				// The page tries to reach another server on this host, which the proxy must refuse.
				return page(200, html("外へ出るページ", `<p>表の本文</p><img src="${beacon}/img"><script>fetch("${beacon}/fetch").catch(() => {});</script>`));
			case "/to-inside":
				return void response.writeHead(302, { location: `${beacon}/redirect` }).end();
			case "/plain":
				return void response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("ただのテキスト\n二行目");
			case "/file":
				return void response.writeHead(200, { "content-type": "application/zip", "content-disposition": "attachment; filename=a.zip" }).end("PK");
			case "/missing":
				return page(404, html("見つかりません", "<p>ページがありません</p>"));
			default:
				return page(200, html("トップ", "<p>トップ</p>"));
		}
	});
}

async function listen(server: Server): Promise<number> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	return (server.address() as AddressInfo).port;
}

async function realReader(t: TestContext) {
	const hits: string[] = [];
	const inside = createServer((request, response) => {
		hits.push(request.url ?? "");
		response.end("inside");
	});
	const insidePort = await listen(inside);
	const server = site(`http://127.0.0.1:${insidePort}`);
	const port = await listen(server);
	const egress = await EgressProxy.start({ allow: (address, to) => to === port && (address === "127.0.0.1" || address === "::1") });
	const reader = new PlaywrightReader({ egress, timezone: "Asia/Tokyo", idleMs: 600_000, timeoutMs: 20_000 });
	const dispose = async () => {
		await reader.close();
		await egress.close();
		server.close();
		inside.close();
	};
	try {
		await reader.read(`http://127.0.0.1:${port}/`);
	} catch (error) {
		await dispose();
		t.skip(`Chromium cannot be launched here: ${errorMessage(error).split("\n")[0]}`);
		return undefined;
	}
	return { base: `http://127.0.0.1:${port}`, inside: `http://127.0.0.1:${insidePort}`, reader, hits, [Symbol.asyncDispose]: dispose };
}

test("an article is read as its main content in Markdown, without the site's navigation", async (t) => {
	await using r = await realReader(t);
	if (r === undefined) return;
	const page = await r.reader.read(`${r.base}/article`);
	assert.equal(page.scope, "article");
	assert.ok(page.markdown.includes(PARAGRAPH));
	assert.ok(!page.markdown.includes("このサイトについて"));
	assert.ok(!page.markdown.includes("©"));
});

test("the pages are rendered where the files of this machine cannot be seen", async (t) => {
	await using r = await realReader(t);
	if (r === undefined) return;
	await r.reader.read(`${r.base}/article`);
	const roots = rendererRoots();
	assert.ok(roots.length > 0);
	assert.ok(!roots.includes("/"), `roots of the renderers: ${roots}`);
});

test("links in what is read point to absolute addresses", async (t) => {
	await using r = await realReader(t);
	if (r === undefined) return;
	const page = await r.reader.read(`${r.base}/article`);
	assert.ok(page.markdown.includes(`[続きの記事](${r.base}/more)`), page.markdown);
});

test("an image is read as its description, not its data", async (t) => {
	await using r = await realReader(t);
	if (r === undefined) return;
	const page = await r.reader.read(`${r.base}/article`);
	assert.ok(page.markdown.includes("茶畑"));
	assert.ok(!page.markdown.includes("base64"));
});

test("what a page's script writes is read", async (t) => {
	await using r = await realReader(t);
	if (r === undefined) return;
	const page = await r.reader.read(`${r.base}/rendered`);
	assert.equal(page.scope, "page");
	assert.ok(page.markdown.includes("スクリプトが書いた本文"));
});

test("a page that forbids scripts is still read", async (t) => {
	await using r = await realReader(t);
	if (r === undefined) return;
	const page = await r.reader.read(`${r.base}/strict`);
	assert.ok(page.markdown.includes(PARAGRAPH));
});

test("a page cannot make the browser reach another server on this host", async (t) => {
	await using r = await realReader(t);
	if (r === undefined) return;
	const page = await r.reader.read(`${r.base}/leak`);
	assert.ok(page.markdown.includes("表の本文"));
	assert.deepEqual(r.hits, []);
});

test("a redirect into this host is not followed", async (t) => {
	await using r = await realReader(t);
	if (r === undefined) return;
	const page = await r.reader.read(`${r.base}/to-inside`).catch((error: unknown) => error);
	assert.ok(page instanceof ReadError || !JSON.stringify(page).includes("inside"));
	assert.deepEqual(r.hits, []);
});

test("an address on this host is refused before opening, with a reason", async (t) => {
	await using r = await realReader(t);
	if (r === undefined) return;
	await assert.rejects(r.reader.read(`${r.inside}/`), ReadError);
	assert.deepEqual(r.hits, []);
});

test("a plain text page is read as it is", async (t) => {
	await using r = await realReader(t);
	if (r === undefined) return;
	const page = await r.reader.read(`${r.base}/plain`);
	assert.equal(page.markdown, "ただのテキスト\n二行目");
});

test("a download is refused", async (t) => {
	await using r = await realReader(t);
	if (r === undefined) return;
	await assert.rejects(r.reader.read(`${r.base}/file`), ReadError);
});

test("an error page is read with its status", async (t) => {
	await using r = await realReader(t);
	if (r === undefined) return;
	const page = await r.reader.read(`${r.base}/missing`);
	assert.equal(page.status, 404);
	assert.ok(page.markdown.includes("ページがありません"));
});
