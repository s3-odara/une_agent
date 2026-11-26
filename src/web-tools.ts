import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { bool, int, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { ReadError, type PageReader, type ReadPage } from "./extract.ts";
import { readPdfImage, readPdfText } from "./pdf.ts";
import type { BinarySource, Crop, Image } from "./web-assets.ts";
import { UNTRUSTED } from "./untrusted.ts";
import { httpUrl } from "./urls.ts";
import { onCharacter, textOutput } from "./text.ts";

export type WebToolsOptions = {
	readonly reader: PageReader;
	readonly maxChars: number;
	readonly now?: () => number;
};

const KEEP_MS = 60 * 60_000;
const KEEP_PAGES = 20;
const MAX_STORED = 500_000;
const ASSET_CACHE_BYTES = 40 * 1024 * 1024;
const ASSET_CACHE_ENTRIES = 20;
const fraction = num({ minimum: 0, maximum: 1 });
const REFETCHED = "（キャッシュになかったため URL から取得しました。以前と同じ版とは限りません。）\n\n";

export const cropParameter = opt(
	obj({ x: fraction, y: fraction, width: fraction, height: fraction }, { description: "画像 URL または PDF の image モードのみ。元画像全体を基準に左上原点の 0〜1 の割合で切り出す" }),
);

export const pdfParameters = {
	page: opt(int({ description: "PDF の先頭を 1 とするページ番号。省略時は複数ページのテキストを読む", minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
	pdfMode: opt(oneOf(["text", "layout", "image"], { description: "PDF のみ。text は既定、layout は配置を保つ。layout / image は page 必須" })),
	crop: cropParameter,
};

export function validateCrop(crop: Crop | undefined): void {
	if (crop !== undefined && (crop.width <= 0 || crop.height <= 0 || crop.x + crop.width > 1 || crop.y + crop.height > 1)) {
		throw new ReadError("crop は元画像の範囲内で、幅と高さが 0 より大きい必要があります。");
	}
}

export function slicePart(text: string, offset: number, maxChars: number, again: (offset: number) => string): { readonly body: string; readonly foot?: string } | { readonly error: string } {
	if (offset >= text.length && text.length > 0) return { error: `このページは全 ${text.length} 文字で、offset=${offset} から先はありません。` };
	const start = onCharacter(text, offset);
	let end = onCharacter(text, Math.min(text.length, start + maxChars));
	if (end === start && start < text.length) end = start + (text.codePointAt(start)! > 0xffff ? 2 : 1);
	if (end < text.length) {
		const newline = text.lastIndexOf("\n", end - 1);
		if (newline > start + maxChars / 2) end = newline + 1;
	}
	const foot =
		end < text.length
			? `（全 ${text.length} 文字のうち ${start}〜${end} 文字目。続きは ${again(end)}）`
			: start > 0
				? `（全 ${text.length} 文字のうち ${start}〜${end} 文字目。ここで終わり）`
				: undefined;
	return { body: text.slice(start, end), ...(foot === undefined ? {} : { foot }) };
}

function imageOutput(source: BinarySource, image: Image, notice: string, crop: Crop | undefined, page?: number) {
	const status = source.status === undefined ? "" : `\nHTTP ステータス: ${source.status}`;
	const label = page === undefined ? "" : `\nPDF ${page} ページ目`;
	const region = crop === undefined
		? `\n細部が読めなければ、同じ url${page === undefined ? "" : `、page=${page}、pdfMode=image`} に crop を指定して、元画像から必要な範囲を切り出せます。`
		: `\n切り出し範囲: x=${crop.x}, y=${crop.y}, width=${crop.width}, height=${crop.height}（元画像全体に対する割合）`;
	return { output: [
		{ type: "text" as const, text: `${notice}URL: ${source.url}${status}${label}${region}\n\n${UNTRUSTED}` },
		{ type: "image" as const, ...image },
	] };
}

type Kept = ReadPage & { readonly at: number };

export const readParameters = {
	offset: opt(int({ description: "続きを読むとき、前の結果が示した文字位置", minimum: 0 })),
	whole: opt(bool({ description: "本文と判定した部分ではなく、ページ全体を読む" })),
};

export function renderPart(page: ReadPage, whole: boolean, offset: number, maxChars: number, again: (offset: number) => string): string {
	const sliced = slicePart(page.markdown, offset, maxChars, again);
	if ("error" in sliced) return sliced.error;
	const scope = page.scope === "article" ? "本文と判定した部分（ページ全体は whole=true で読める）" : whole ? "ページ全体" : "ページ全体（本文を判定できなかった）";
	const head = [
		`URL: ${page.url}`,
		...(page.title === "" ? [] : [`タイトル: ${page.title}`]),
		...(page.status === undefined ? [] : [`HTTP ステータス: ${page.status}（エラーのページの可能性があります）`]),
		page.mediaType === undefined ? `範囲: ${scope}` : `形式: ${page.mediaType}`,
	];
	return [...head, "", UNTRUSTED, "", sliced.body === "" ? "（本文がありません）" : sliced.body, ...(sliced.foot === undefined ? [] : ["", sliced.foot])].join("\n");
}

/** It only reads, so it is rerun after a crash, and works in runs the scheduler started too. */
export function createWebExtension(options: WebToolsOptions) {
	const { reader, maxChars } = options;
	const now = options.now ?? Date.now;
	const kept = new Map<string, Kept>();
	const assets = new Map<string, { readonly file: BinarySource; readonly at: number; readonly expiry: NodeJS.Timeout }>();
	let assetBytes = 0;
	const dropAsset = (url: string) => {
		const entry = assets.get(url);
		if (entry === undefined) return;
		clearTimeout(entry.expiry);
		assetBytes -= entry.file.body.length;
		assets.delete(url);
	};
	const cachedAsset = (url: string) => {
		const entry = assets.get(url);
		if (entry === undefined || now() - entry.at < KEEP_MS) return entry;
		dropAsset(url);
		return undefined;
	};
	const keepAsset = (url: string, file: BinarySource) => {
		const cached = cachedAsset(url);
		if (cached !== undefined) return cached.file;
		while (assets.size >= ASSET_CACHE_ENTRIES || assetBytes + file.body.length > ASSET_CACHE_BYTES) {
			const oldest = assets.keys().next();
			if (oldest.done) break;
			dropAsset(oldest.value);
		}
		const entry = { file, at: now(), expiry: setTimeout(() => dropAsset(url), KEEP_MS).unref() };
		assetBytes += file.body.length;
		assets.set(url, entry);
		kept.delete(`main ${url}`);
		kept.delete(`whole ${url}`);
		return file;
	};

	const recentText = (key: string) => {
		const entry = kept.get(key);
		return entry !== undefined && now() - entry.at < KEEP_MS ? entry : undefined;
	};
	const keep = (key: string, page: ReadPage): Kept => {
		const at = now();
		for (const [key, old] of kept) if (at - old.at >= KEEP_MS) kept.delete(key);
		kept.delete(key);
		if (kept.size >= KEEP_PAGES) kept.delete(kept.keys().next().value!);
		const cut = onCharacter(page.markdown, MAX_STORED);
		const markdown = cut >= page.markdown.length ? page.markdown : `${page.markdown.slice(0, cut)}\n\n（ここまでで ${cut} 文字。残りは保存していません）`;
		const entry = { ...page, markdown, at };
		kept.set(key, entry);
		return entry;
	};

	return defineExtension({
		name: "web",
		tools: [
			defineTool({
				name: "web_extract",
				description:
					"ログインせずに公開 URL を読む。HTML は本文を Markdown で返す（whole=true でページ全体）。JSON、CSV、XML/RSS は整形せず、画像 URL は画像で返す。PDF はページ番号つきテキスト。表は page と pdfMode=layout、数式・図・スキャンは page と pdfMode=image で確認できる。長いテキストの続きは offset で読む。",
				parameters: obj({
					url: str({ description: "http または https の URL", minLength: 1 }),
					...readParameters,
					...pdfParameters,
				}),
				replay: "safe",
				execute: async (args, _api, context) => {
					const url = httpUrl(args.url).href;
					const offset = args.offset ?? 0;
					const whole = args.whole === true;
					const { page, pdfMode, crop } = args;
					const mode = pdfMode ?? "text";
					validateCrop(crop);
					if (crop !== undefined && offset > 0) throw new ReadError("crop に offset は使えません。");
					if (mode !== "text" && page === undefined) throw new ReadError(`pdfMode=${mode} には page が必要です。`);
					if (mode === "image" && offset > 0) throw new ReadError("pdfMode=image に offset は使えません。");
					const pdfRequested = page !== undefined || pdfMode !== undefined;
					const key = `${whole ? "whole" : "main"} ${url}`;
					const showText = (text: ReadPage, notice: string, whole: boolean, flags: string) => textOutput(
						notice + renderPart(text, whole, offset, maxChars, (next) => `web_extract を同じ url${flags}、offset=${next} で呼ぶ`),
					);
					const wholeFlag = whole ? "、whole=true" : "";
					const cached = cachedAsset(url);
					if (cached === undefined && offset > 0 && !pdfRequested && crop === undefined) {
						const text = recentText(key);
						if (text !== undefined) return showText(text, "", whole, wholeFlag);
					}
					const signal = context.abortSignal;
					const fetched = cached?.file ?? await reader.read(url, whole, signal);
					const notice = cached === undefined && (crop !== undefined || offset > 0 || pdfRequested) ? REFETCHED : "";
					if ("markdown" in fetched) {
						if (pdfRequested) throw new ReadError("page と pdfMode は PDF にだけ使えます。");
						if (crop !== undefined) throw new ReadError("crop は画像 URL または PDF の画像モードにだけ使えます。");
						return showText(keep(key, fetched), notice, whole, wholeFlag);
					}

					const file = cached?.file ?? keepAsset(url, fetched);
					if (file.kind === "image") {
						if (pdfRequested) throw new ReadError("page と pdfMode は PDF にだけ使えます。");
						if (offset > 0) throw new ReadError("画像に offset は使えません。");
						return imageOutput(file, await reader.renderImage(file, crop, signal), notice, crop);
					}

					if (crop !== undefined && mode !== "image") throw new ReadError("PDF の crop には page と pdfMode=image が必要です。");
					if (mode === "image") return imageOutput(file, await readPdfImage(file.body, page!, signal, crop), notice, crop, page);
					const { markdown } = await readPdfText(file.body, mode, page, signal);
					const pageResult: ReadPage = { url: file.url, ...(file.status === undefined ? {} : { status: file.status }), title: "", scope: "page", mediaType: "application/pdf", markdown };
					const flags = `${page === undefined ? "" : `、page=${page}`}${mode === "text" ? "" : `、pdfMode=${mode}`}`;
					return showText(pageResult, notice, false, flags);
				},
			}),
		],
	});
}
