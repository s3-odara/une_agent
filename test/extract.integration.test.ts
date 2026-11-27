import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { type TestContext, test } from "node:test";
import { PlaywrightReader, ReadError } from "../src/extract.ts";
import { beacon, egressTo, noChromium } from "./chromium.ts";
import { listen } from "./env.ts";
import { samplePdf } from "./pdf-fixture.ts";

/**
 * Reads pages of a small site served from this process in a real Chromium through `src/extract.ts`. The egress proxy
 * lets the browser reach that site and nothing else on this host, as it lets the deployed one reach only public
 * addresses. Skipped outside the dev shell (see `chromium.ts`).
 */

const JSON_TEXT = '{\r\n  "お茶": "緑茶"  \r\n\r\n\r\n}\n';
const CSV_TEXT = 'name,description\r\n"tea","green, steamed"  \r\n';
const XML_TEXT = '<?xml version="1.0"?>\n<rss><channel><title>緑茶</title></channel></rss>\n';

const PARAGRAPH =
	"緑茶は茶葉を摘んだ直後に加熱して発酵を止めた茶で、蒸し製と釜炒り製がある。日本では蒸し製が主流で、煎茶、玉露、かぶせ茶などに分かれる。";

const html = (title: string, body: string, head = "") =>
	`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;

function site(beacon: string): Server {
	return createServer((request, response) => {
		const page = (status: number, text: string) =>
			response.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(text);
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
				return page(
					200,
					html(
						"動的なページ",
						'<div id="app"></div><script>document.getElementById("app").innerHTML = "<p>スクリプトが書いた本文</p>";</script>',
					),
				);
			case "/strict":
				// A page whose policy forbids every script, which must not stop the extraction.
				response.writeHead(200, {
					"content-type": "text/html; charset=utf-8",
					"content-security-policy": "script-src 'none'",
				});
				return response.end(
					html("厳しいページ", `<article><h1>見出し</h1>${`<p>${PARAGRAPH}</p>`.repeat(3)}</article>`),
				);
			case "/leak":
				// The page tries to reach another server on this host, which the proxy must refuse.
				return page(
					200,
					html(
						"外へ出るページ",
						`<p>表の本文</p><img src="${beacon}/img"><script>fetch("${beacon}/fetch").catch(() => {});</script>`,
					),
				);
			case "/plain":
				return void response
					.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
					.end("ただのテキスト\n二行目");
			case "/data":
				return void response.writeHead(200, { "content-type": "application/problem+json" }).end(JSON_TEXT);
			case "/csv":
				return void response
					.writeHead(200, { "content-type": "text/csv", "content-disposition": "attachment; filename=tea.csv" })
					.end(CSV_TEXT);
			case "/feed":
				return void response.writeHead(200, { "content-type": "application/rss+xml" }).end(XML_TEXT);
			case "/diagram":
				return void response.writeHead(302, { location: "/asset", "content-type": "text/plain" }).end("redirect");
			case "/asset":
				return void response
					.writeHead(200, { "content-type": "image/svg+xml" })
					.end(
						'<svg xmlns="http://www.w3.org/2000/svg" width="6000" height="4000"><rect width="6000" height="4000" fill="red"/></svg>',
					);
			case "/wide":
				return void response
					.writeHead(200, { "content-type": "image/svg+xml" })
					.end('<svg xmlns="http://www.w3.org/2000/svg" width="12001" height="20"/>');
			case "/large":
				response.writeHead(200, { "content-type": "application/json" });
				response.write('"');
				return void response.end("x".repeat(5 * 1024 * 1024) + '"');
			case "/document":
				return void response
					.writeHead(200, {
						"content-type": "application/pdf",
						"content-disposition": "attachment; filename=document.pdf",
					})
					.end(samplePdf());
			case "/file":
				return void response
					.writeHead(200, { "content-type": "application/zip", "content-disposition": "attachment; filename=a.zip" })
					.end("PK");
			case "/missing":
				return page(404, html("見つかりません", "<p>ページがありません</p>"));
			default:
				return page(200, html("トップ", "<p>トップ</p>"));
		}
	});
}

async function realReader(t: TestContext) {
	if (noChromium) {
		t.skip(noChromium);
		return undefined;
	}
	const inside = await beacon();
	const server = site(inside.url);
	const port = await listen(server);
	const egress = await egressTo(port);
	const reader = new PlaywrightReader({ egress, timezone: "Asia/Tokyo", idleMs: 600_000, timeoutMs: 20_000 });
	const dispose = async () => {
		await reader.close();
		await egress.close();
		server.close();
		await inside.close();
	};
	const readText = async (url: string, whole = false) => {
		const result = await reader.read(url, whole);
		assert.ok("markdown" in result);
		return result;
	};
	return {
		base: `http://127.0.0.1:${port}`,
		inside: inside.url,
		reader,
		readText,
		hits: inside.hits,
		[Symbol.asyncDispose]: dispose,
	};
}

test("an article is read as its main content in Markdown, without the site's navigation", async (t) => {
	await using r = await realReader(t);
	if (r === undefined) return;
	const page = await r.readText(`${r.base}/article`);
	assert.equal(page.scope, "article");
	assert.ok(page.markdown.includes(PARAGRAPH));
	assert.ok(!page.markdown.includes("このサイトについて"));
	assert.ok(!page.markdown.includes("©"));
});

test("asked for the whole page, what the article leaves out is read too", async (t) => {
	await using r = await realReader(t);
	if (r === undefined) return;
	const page = await r.readText(`${r.base}/article`, true);
	assert.equal(page.scope, "page");
	assert.ok(page.markdown.includes(PARAGRAPH));
	assert.ok(page.markdown.includes("このサイトについて"));
});

test("links in what is read point to absolute addresses", async (t) => {
	await using r = await realReader(t);
	if (r === undefined) return;
	const page = await r.readText(`${r.base}/article`);
	assert.ok(page.markdown.includes(`[続きの記事](${r.base}/more)`), page.markdown);
});

test("an image is read as its description, not its data", async (t) => {
	await using r = await realReader(t);
	if (r === undefined) return;
	const page = await r.readText(`${r.base}/article`);
	assert.ok(page.markdown.includes("茶畑"));
	assert.ok(!page.markdown.includes("base64"));
});

test("what a page's script writes is read", async (t) => {
	await using r = await realReader(t);
	if (r === undefined) return;
	const page = await r.readText(`${r.base}/rendered`);
	assert.equal(page.scope, "page");
	assert.ok(page.markdown.includes("スクリプトが書いた本文"));
});

test("a page that forbids scripts is still read", async (t) => {
	await using r = await realReader(t);
	if (r === undefined) return;
	const page = await r.readText(`${r.base}/strict`);
	assert.ok(page.markdown.includes(PARAGRAPH));
});

test("a page cannot make the browser reach another server on this host", async (t) => {
	await using r = await realReader(t);
	if (r === undefined) return;
	const page = await r.readText(`${r.base}/leak`);
	assert.ok(page.markdown.includes("表の本文"));
	assert.deepEqual(r.hits, []);
});

test("an address on this host is refused before opening, with a reason", async (t) => {
	await using r = await realReader(t);
	if (r === undefined) return;
	await assert.rejects(r.reader.read(`${r.inside}/`, false), ReadError);
	assert.deepEqual(r.hits, []);
});

test("a plain text page is read as it is", async (t) => {
	await using r = await realReader(t);
	if (r === undefined) return;
	const page = await r.readText(`${r.base}/plain`);
	assert.equal(page.markdown, "ただのテキスト\n二行目");
});

test("JSON, CSV attachments, and RSS are read without changing whitespace or markup", async (t) => {
	await using r = await realReader(t);
	if (r === undefined) return;
	for (const [path, body] of [
		["/data", JSON_TEXT],
		["/csv", CSV_TEXT],
		["/feed", XML_TEXT],
	] as const) {
		assert.equal((await r.readText(`${r.base}${path}`)).markdown, body);
	}
});

test("a large image is cropped at source resolution", async (t) => {
	if (spawnSync("ffprobe", ["-version"]).status !== 0) return t.skip("ffprobe is not installed");
	await using r = await realReader(t);
	if (r === undefined) return;
	const result = await r.reader.read(`${r.base}/diagram`, false);
	assert.ok("kind" in result && result.kind === "image");

	const full = await r.reader.renderImage(result);
	const crop = await r.reader.renderImage(result, { x: 0.5, y: 0.5, width: 0.125, height: 0.125 });

	for (const [image, dimensions] of [
		[full, [1280, 853]],
		[crop, [750, 500]],
	] as const) {
		const decoded = spawnSync(
			"ffprobe",
			["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", "pipe:0"],
			{
				input: Buffer.from(image.data, "base64"),
				encoding: "utf8",
			},
		);
		assert.equal(decoded.status, 0, decoded.stderr);
		assert.deepEqual(decoded.stdout.trim().split(",").map(Number), dimensions);
	}
});

test("large assets and images with excessive dimensions are refused", async (t) => {
	await using r = await realReader(t);
	if (r === undefined) return;
	await assert.rejects(r.reader.read(`${r.base}/large`, false), /上限 5 MiB/);
	const wide = await r.reader.read(`${r.base}/wide`, false);
	assert.ok("kind" in wide && wide.kind === "image");
	await assert.rejects(r.reader.renderImage(wide), /画像の寸法/);
});

test("an attached PDF is fetched intact without a browser download", async (t) => {
	await using r = await realReader(t);
	if (r === undefined) return;
	const result = await r.reader.read(`${r.base}/document`, false);
	assert.ok("kind" in result && result.kind === "pdf");
	assert.deepEqual(result.body, samplePdf());
});

test("a download is refused", async (t) => {
	await using r = await realReader(t);
	if (r === undefined) return;
	await assert.rejects(r.reader.read(`${r.base}/file`, false), ReadError);
});

test("an error page is read with its status", async (t) => {
	await using r = await realReader(t);
	if (r === undefined) return;
	const page = await r.readText(`${r.base}/missing`);
	assert.equal(page.status, 404);
	assert.ok(page.markdown.includes("ページがありません"));
});
