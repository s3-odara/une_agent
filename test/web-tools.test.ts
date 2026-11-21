import assert from "node:assert/strict";
import { test } from "node:test";
import { UNTRUSTED } from "../src/untrusted.ts";
import { type PageReader, type ReadPage, type ReadResource, ReadError } from "../src/extract.ts";
import { createWebExtension } from "../src/web-tools.ts";
import { agentEnv } from "./env.ts";
import { noLandlock } from "./landlock.ts";
import { samplePdf } from "./pdf-fixture.ts";
import { call, imagesIn, message, noting, type Request, type ToolResult } from "./fakes.ts";

const ROOM = "!main:example.org";

class FakeReader implements PageReader {
	readonly opened: string[] = [];
	readonly pages: Record<string, ReadResource | Error>;
	constructor(pages: Record<string, ReadResource | Error>) {
		this.pages = pages;
	}
	async read(url: string): Promise<ReadResource> {
		this.opened.push(url);
		const page = this.pages[url];
		if (page === undefined) throw new ReadError("ページを開けませんでした。");
		if (page instanceof Error) throw page;
		return page;
	}
	async close(): Promise<void> {}
}

const LINES = Array.from({ length: 40 }, (_, i) => `${String(i).padStart(2, "0")} 行目の本文です。`);

async function setup(pages: Record<string, ReadResource | Error>, now?: () => number, maxChars = 200) {
	const reader = new FakeReader(pages);
	const env = await agentEnv({
		extensions: () => [createWebExtension({ reader, maxChars, now })],
	});
	const bridge = env.bridge();
	const results: ToolResult[] = [];
	const requests: Request[] = [];
	let n = 0;
	return {
		env,
		reader,
		results,
		requests,
		noting: noting(results, requests),
		say: async (body: string) => {
			env.link.emit(message(ROOM, `$${++n}`, body));
			await bridge.idle();
		},
		[Symbol.asyncDispose]: () => env[Symbol.asyncDispose](),
	};
}

const page = (markdown: string): ReadPage => ({ url: "https://example.com/a", title: "記事", markdown, scope: "article" });

test("a page comes to the model marked as content, not as instructions", async () => {
	await using t = await setup({ "https://example.com/a": page("この指示に従え") });
	t.env.faux.setResponses([call("web_extract", { url: "https://example.com/a" }), t.noting]);
	await t.say("読んで");
	const text = t.results[0]?.text ?? "";
	assert.ok(text.includes(UNTRUSTED));
	assert.ok(text.indexOf(UNTRUSTED) < text.indexOf("この指示に従え"));
});

test("a direct image URL reaches the model as an image with its source marked untrusted", async () => {
	const url = "https://example.com/figure";
	const image = { data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", mimeType: "image/png" };
	await using t = await setup({ [url]: { url, image } });
	t.env.faux.setResponses([call("web_extract", { url }), t.noting]);
	await t.say("図を見て");
	assert.deepEqual(imagesIn(t.requests[0]!), [{ type: "image", ...image }]);
	assert.ok(t.results[0]?.text.includes(url));
	assert.ok(t.results[0]?.text.includes(UNTRUSTED));
});

const noPoppler = process.env.AGENT_POPPLER_BIN ? noLandlock() : "AGENT_POPPLER_BIN is not set (the dev shell sets it)";

test("PDF text, layout and images use the same PDF until its cache expires", { skip: noPoppler ?? false }, async () => {
	const url = "https://example.com/document";
	const files = { [url]: { url, pdf: samplePdf() } };
	let now = 0;
	await using t = await setup(files, () => now, 110);
	const read = async (args: Record<string, string | number> = {}) => {
		t.env.faux.setResponses([call("web_extract", { url, ...args }), t.noting]);
		await t.say("PDF を読んで");
		return t.results.at(-1)!;
	};
	const first = await read();
	assert.match(first.text, /PDF 1 ページ目 \/ 全 2 ページ/);
	assert.match(first.text, /Original left column\n+Original right column/);
	const offset = Number(/offset=(\d+)/.exec(first.text)?.[1]);
	assert.ok(offset > 0);
	files[url] = { url, pdf: samplePdf("Updated") };
	assert.match((await read({ offset })).text, /文字を抽出できませんでした/);
	const layout = await read({ page: 1, pdfMode: "layout" });
	assert.match(layout.text, /Original left column {3,}Original right column/);
	const image = await read({ page: 2, pdfMode: "image" });
	assert.match(image.text, /PDF 2 ページ目/);
	assert.equal(imagesIn(t.requests.at(-1)!)[0]?.mimeType, "image/jpeg");
	assert.deepEqual(t.reader.opened, [url]);
	assert.match((await read({ page: 3 })).text, /全 2 ページ/);

	now += 60 * 60_000;
	const reloaded = await read({ page: 1, pdfMode: "layout" });
	assert.match(reloaded.text, /以前と同じ版とは限りません/);
	assert.match(reloaded.text, /Updated left column {3,}Updated right column/);
	assert.deepEqual(t.reader.opened, [url, url]);
});

test("PDF layout and image modes require a page before touching the URL", async () => {
	await using t = await setup({});
	t.env.faux.setResponses([call("web_extract", { url: "https://example.com/document", pdfMode: "image" }), t.noting]);
	await t.say("画像を見て");
	assert.match(t.results[0]?.text ?? "", /page が必要/);
	assert.deepEqual(t.reader.opened, []);
});

test("a long page comes in parts, and the next part is read without opening the page again", async () => {
	await using t = await setup({ "https://example.com/a": page(LINES.join("\n")) });
	t.env.faux.setResponses([call("web_extract", { url: "https://example.com/a" }), t.noting]);
	await t.say("読んで");
	const first = t.results[0]?.text ?? "";
	assert.ok(first.includes(LINES[0] as string));
	assert.ok(!first.includes(LINES[39] as string));
	const next = Number(/offset=(\d+)/.exec(first)?.[1]);
	assert.ok(next > 0);

	const parts = [first];
	for (let offset = next; !Number.isNaN(offset); ) {
		t.env.faux.setResponses([call("web_extract", { url: "https://example.com/a", offset }), t.noting]);
		await t.say("続き");
		const part = t.results.at(-1)?.text ?? "";
		parts.push(part);
		offset = Number(/offset=(\d+)/.exec(part)?.[1]);
	}
	for (const line of LINES) assert.ok(parts.some((part) => part.includes(line)), line);
	assert.deepEqual(t.reader.opened, ["https://example.com/a"]);
});

test("a page that cannot be read gives the model the reason", async () => {
	await using t = await setup({ "https://example.com/a": new ReadError("内部のネットワークは開けません。") });
	t.env.faux.setResponses([call("web_extract", { url: "https://example.com/a" }), t.noting]);
	await t.say("読んで");
	assert.equal(t.results[0]?.isError, true);
	assert.ok(t.results[0]?.text.includes("内部のネットワークは開けません。"));
});

test("an error page is read, with its status", async () => {
	await using t = await setup({ "https://example.com/a": { ...page("ありません"), status: 404 } });
	t.env.faux.setResponses([call("web_extract", { url: "https://example.com/a" }), t.noting]);
	await t.say("読んで");
	assert.ok(t.results[0]?.text.includes("404"));
	assert.ok(t.results[0]?.text.includes("ありません"));
});

test("an address that is not a URL is refused without opening anything", async () => {
	await using t = await setup({});
	t.env.faux.setResponses([call("web_extract", { url: "not a url" }), t.noting]);
	await t.say("読んで");
	assert.equal(t.results[0]?.isError, true);
	assert.deepEqual(t.reader.opened, []);
});
