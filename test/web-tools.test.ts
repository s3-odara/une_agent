import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { UNTRUSTED } from "../src/untrusted.ts";
import { type PageReader, type ReadPage, type ReadResource, ReadError } from "../src/extract.ts";
import type { BinarySource } from "../src/web-assets.ts";
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
	async renderImage(source: BinarySource) {
		return { data: source.body.toString("base64"), mimeType: source.mediaType };
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
	const source: BinarySource = { kind: "image", url, body: Buffer.from(image.data, "base64"), mediaType: image.mimeType };
	const files = { [url]: source };
	let now = 0;
	await using t = await setup(files, () => now);
	t.env.faux.setResponses([call("web_extract", { url }), t.noting]);
	await t.say("図を見て");
	assert.deepEqual(imagesIn(t.requests[0]!), [{ type: "image", ...image }]);
	assert.ok(t.results[0]?.text.includes(url));
	assert.ok(t.results[0]?.text.includes(UNTRUSTED));
	assert.match(t.results[0]!.text, /\bcrop\b/);
	const updated = { ...image, data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC" };
	files[url] = { ...source, body: Buffer.from(updated.data, "base64") };
	const crop = { x: 0, y: 0.5, width: 1, height: 0.5 };
	const zoom = async () => {
		t.env.faux.setResponses([call("web_extract", { url, crop }), t.noting]);
		await t.say("下半分も見て");
	};
	await zoom();
	assert.doesNotMatch(t.results.at(-1)!.text, /\bcrop\b/);
	assert.deepEqual(t.reader.opened, [url]);
	assert.deepEqual(imagesIn(t.requests.at(-1)!), [{ type: "image", ...image }]);
	now += 60 * 60_000;
	await zoom();
	assert.deepEqual(t.reader.opened, [url, url]);
	assert.deepEqual(imagesIn(t.requests.at(-1)!), [{ type: "image", ...updated }]);
	assert.match(t.results.at(-1)!.text, /以前と同じ版とは限りません/);
});

const pdf = (url: string, body: Buffer): BinarySource => ({ kind: "pdf", url, body, mediaType: "application/pdf" });

const noPoppler = process.env.AGENT_POPPLER_BIN ? noLandlock() : "AGENT_POPPLER_BIN is not set (the dev shell sets it)";

test("PDF text, layout and images use the same PDF until its cache expires", { skip: noPoppler ?? false }, async () => {
	const url = "https://example.com/document";
	const files = { [url]: pdf(url, samplePdf()) };
	let now = 0;
	await using t = await setup(files, () => now, 110);
	const read = async (args: Parameters<typeof call>[1] = {}) => {
		t.env.faux.setResponses([call("web_extract", { url, ...args }), t.noting]);
		await t.say("PDF を読んで");
		return t.results.at(-1)!;
	};
	const first = await read();
	assert.match(first.text, /PDF 1 ページ目 \/ 全 2 ページ/);
	assert.match(first.text, /Original left column\n+Original right column/);
	const offset = Number(/offset=(\d+)/.exec(first.text)?.[1]);
	assert.ok(offset > 0);
	files[url] = pdf(url, samplePdf("Updated"));
	assert.match((await read({ offset })).text, /文字を抽出できませんでした/);
	const layout = await read({ page: 1, pdfMode: "layout" });
	assert.match(layout.text, /Original left column[ \t]+Original right column/);
	const fullImage = await read({ page: 2, pdfMode: "image" });
	assert.match(fullImage.text, /\bcrop\b/);
	assert.match(fullImage.text, /\bpage=2\b/);
	assert.match(fullImage.text, /\bpdfMode=image\b/);
	const image = await read({ page: 2, pdfMode: "image", crop: { x: 0.5, y: 0, width: 0.5, height: 1 } });
	assert.match(image.text, /PDF 2 ページ目/);
	assert.ok(imagesIn(t.requests.at(-1)!)[0]);
	assert.deepEqual(t.reader.opened, [url]);
	assert.match((await read({ page: 3 })).text, /全 2 ページ/);

	now += 60 * 60_000;
	const reloaded = await read({ page: 1, pdfMode: "layout", offset: 1 });
	assert.match(reloaded.text, /以前と同じ版とは限りません/);
	assert.match(reloaded.text, /Updated left column[ \t]+Updated right column/);
	assert.deepEqual(t.reader.opened, [url, url]);
});

test("PDF crop uses the visible sides of a rotated page", { skip: noPoppler ?? (spawnSync("ffmpeg", ["-version"]).status === 0 ? false : "ffmpeg is not installed") }, async () => {
	const url = "https://example.com/rotated";
	await using t = await setup({ [url]: pdf(url, samplePdf()) });
	for (const [x, color] of [[0, "red"], [0.5, "blue"]] as const) {
		t.env.faux.setResponses([call("web_extract", { url, page: 2, pdfMode: "image", crop: { x, y: 0, width: 0.5, height: 1 } }), t.noting]);
		await t.say("回転したページを拡大して");
		const image = imagesIn(t.requests.at(-1)!)[0];
		assert.ok(image);
		const decoded = spawnSync("ffmpeg", ["-v", "error", "-i", "pipe:0", "-vf", "scale=1:1", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { input: Buffer.from(image.data, "base64") });
		assert.equal(decoded.status, 0, decoded.stderr.toString());
		const [red, green, blue] = decoded.stdout;
		assert.ok(red !== undefined && green !== undefined && blue !== undefined);
		assert.ok(color === "red" ? red > Math.max(green, blue) : blue > Math.max(red, green));
	}
});

test("crop rejects an out-of-bounds rectangle without fetching the URL", async () => {
	await using t = await setup({});
	t.env.faux.setResponses([call("web_extract", { url: "https://example.com/image", crop: { x: 0.9, y: 0, width: 0.2, height: 1 } }), t.noting]);
	await t.say("拡大して");
	assert.match(t.results[0]?.text ?? "", /元画像の範囲内/);
	assert.deepEqual(t.reader.opened, []);
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

test("continuing expired text warns that it was fetched again", async () => {
	const url = "https://example.com/a";
	const pages = { [url]: page(LINES.join("\n")) };
	let now = 0;
	await using t = await setup(pages, () => now, 20);
	t.env.faux.setResponses([call("web_extract", { url }), t.noting]);
	await t.say("読んで");
	const offset = Number(/offset=(\d+)/.exec(t.results.at(-1)!.text)?.[1]);
	assert.ok(offset > 0);

	now += 60 * 60_000;
	pages[url] = page(" ".repeat(offset) + "更新された本文");
	t.env.faux.setResponses([call("web_extract", { url, offset }), t.noting]);
	await t.say("続き");
	assert.match(t.results.at(-1)!.text, /以前と同じ版とは限りません/);
	assert.match(t.results.at(-1)!.text, /更新された本文/);
});

test("pagination makes progress when one character exceeds the part size", async () => {
	const url = "https://example.com/a";
	await using t = await setup({ [url]: page("🍵茶") }, undefined, 1);
	t.env.faux.setResponses([call("web_extract", { url }), t.noting]);
	await t.say("読んで");
	const first = t.results.at(-1)!.text;
	assert.match(first, /🍵/);
	assert.match(first, /offset=2/);
	t.env.faux.setResponses([call("web_extract", { url, offset: 2 }), t.noting]);
	await t.say("続き");
	assert.match(t.results.at(-1)!.text, /\n茶\n/);
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
