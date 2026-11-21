import assert from "node:assert/strict";
import { test } from "node:test";
import { UNTRUSTED } from "../src/untrusted.ts";
import { type PageReader, type ReadPage, type ReadResource, ReadError } from "../src/extract.ts";
import { createWebExtension } from "../src/web-tools.ts";
import { agentEnv } from "./env.ts";
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

async function setup(pages: Record<string, ReadResource | Error>) {
	const reader = new FakeReader(pages);
	const env = await agentEnv({
		extensions: () => [createWebExtension({ reader, maxChars: 200 })],
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
