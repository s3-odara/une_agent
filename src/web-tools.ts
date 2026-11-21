import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { bool, int, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { ReadError, type PageReader, type ReadPage } from "./extract.ts";
import { readPdf } from "./pdf.ts";
import type { ImageSource, ReadPdf } from "./web-assets.ts";
import { UNTRUSTED } from "./untrusted.ts";
import { httpUrl } from "./urls.ts";
import { onCharacter } from "./text.ts";

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

type Kept = ReadPage & { readonly at: number };

export const readParameters = {
	offset: opt(int({ description: "続きを読むとき、前の結果が示した文字位置", minimum: 0 })),
	whole: opt(bool({ description: "本文と判定した部分ではなく、ページ全体を読む" })),
};

/** One part of a page, up to `maxChars`, with how to ask for the next: `again` gives the call for an offset. */
export function renderPart(page: ReadPage, whole: boolean, offset: number, maxChars: number, again: (offset: number) => string): string {
	const text = page.markdown;
	if (offset >= text.length && text.length > 0) return `このページは全 ${text.length} 文字で、offset=${offset} から先はありません。`;
	const start = onCharacter(text, offset);
	let end = onCharacter(text, Math.min(text.length, start + maxChars));
	// A part that ends at a line end does not stop mid-sentence.
	if (end < text.length) {
		const newline = text.lastIndexOf("\n", end);
		if (newline > start + maxChars / 2) end = newline + 1;
	}
	const scope = page.scope === "article" ? "本文と判定した部分（ページ全体は whole=true で読める）" : whole ? "ページ全体" : "ページ全体（本文を判定できなかった）";
	const head = [
		`URL: ${page.url}`,
		...(page.title === "" ? [] : [`タイトル: ${page.title}`]),
		...(page.status === undefined ? [] : [`HTTP ステータス: ${page.status}（エラーのページの可能性があります）`]),
		page.mediaType === undefined ? `範囲: ${scope}` : `形式: ${page.mediaType}`,
	];
	const part = text.slice(start, end);
	const foot =
		end < text.length
			? `（全 ${text.length} 文字のうち ${start}〜${end} 文字目。続きは ${again(end)}）`
			: start > 0
				? `（全 ${text.length} 文字のうち ${start}〜${end} 文字目。ここで終わり）`
				: undefined;
	return [...head, "", UNTRUSTED, "", part === "" ? "（本文がありません）" : part, ...(foot === undefined ? [] : ["", foot])].join("\n");
}

/** It only reads, so it is rerun after a crash, and works in runs the scheduler started too. */
export function createWebExtension(options: WebToolsOptions) {
	const { reader, maxChars } = options;
	const now = options.now ?? Date.now;
	const kept = new Map<string, Kept>();
	const assets = new Map<string, { readonly file: ReadPdf | ImageSource; readonly size: number; readonly at: number; readonly id: number; readonly expiry: NodeJS.Timeout }>();
	let assetBytes = 0;
	let assetId = 0;
	const dropAsset = (url: string) => {
		const entry = assets.get(url);
		if (entry === undefined) return;
		clearTimeout(entry.expiry);
		assetBytes -= entry.size;
		assets.delete(url);
	};
	const cachedAsset = (url: string) => {
		const entry = assets.get(url);
		if (entry === undefined || now() - entry.at < KEEP_MS) return entry;
		dropAsset(url);
		return undefined;
	};
	const keepAsset = (url: string, file: ReadPdf | ImageSource) => {
		const cached = cachedAsset(url);
		if (cached !== undefined) return cached;
		const size = ("pdf" in file ? file.pdf : file.imageSource).length;
		for (const key of assets.keys()) cachedAsset(key);
		while (assets.size >= ASSET_CACHE_ENTRIES || assetBytes + size > ASSET_CACHE_BYTES) {
			const oldest = assets.keys().next();
			if (oldest.done) break;
			dropAsset(oldest.value);
		}
		const entry = { file, size, at: now(), id: ++assetId, expiry: setTimeout(() => dropAsset(url), KEEP_MS).unref() };
		assetBytes += size;
		assets.set(url, entry);
		return entry;
	};

	const keep = (key: string, page: ReadPage): Kept => {
		for (const [key, old] of kept) if (now() - old.at >= KEEP_MS) kept.delete(key);
		while (kept.size >= KEEP_PAGES) kept.delete(kept.keys().next().value as string);
		const cut = onCharacter(page.markdown, MAX_STORED);
		const markdown = cut >= page.markdown.length ? page.markdown : `${page.markdown.slice(0, cut)}\n\n（ここまでで ${cut} 文字。残りは保存していません）`;
		const entry = { ...page, markdown, at: now() };
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
					page: opt(int({ description: "PDF の先頭を 1 とするページ番号。省略時は複数ページのテキストを読む", minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
					pdfMode: opt(oneOf(["text", "layout", "image"], { description: "PDF のみ。text は既定、layout は配置を保つ。layout / image は page 必須" })),
					crop: opt(obj({ x: fraction, y: fraction, width: fraction, height: fraction }, { description: "画像 URL または PDF の image モードのみ。元画像全体を基準に左上原点の 0〜1 の割合で切り出す" })),
				}),
				replay: "safe",
				execute: async (args, _api, context) => {
					const url = httpUrl(args.url).href;
					const offset = args.offset ?? 0;
					const whole = args.whole === true;
					const { page, pdfMode, crop } = args;
					const mode = pdfMode ?? "text";
					if (crop !== undefined && (crop.width <= 0 || crop.height <= 0 || crop.x + crop.width > 1 || crop.y + crop.height > 1)) {
						throw new ReadError("crop は元画像の範囲内で、幅と高さが 0 より大きい必要があります。");
					}
					if (crop !== undefined && offset > 0) throw new ReadError("crop に offset は使えません。");
					if (mode !== "text" && page === undefined) throw new ReadError(`pdfMode=${mode} には page が必要です。`);
					if (mode === "image" && offset > 0) throw new ReadError("pdfMode=image に offset は使えません。");
					const pdfRequested = page !== undefined || pdfMode !== undefined;
					const key = `${whole ? "whole" : "main"} ${url}`;
					const freshText = (key: string) => {
						const value = kept.get(key);
						return offset > 0 && value !== undefined && now() - value.at < KEEP_MS ? value : undefined;
					};
					const cached = cachedAsset(url);
					const previousText = cached === undefined && !pdfRequested && crop === undefined ? freshText(key) : undefined;
					const fetched = cached?.file ?? previousText ?? await reader.read(url, whole, context.abortSignal);
					const entry = "pdf" in fetched || "imageSource" in fetched ? cached ?? keepAsset(url, fetched) : undefined;
					const resource = entry?.file ?? fetched;
					const notice = cached === undefined && (crop !== undefined || offset > 0 || pdfRequested)
						? "（キャッシュになかったため URL から取得しました。以前と同じ版とは限りません。）\n\n" : "";
					const region = crop === undefined ? "" : `\n切り出し範囲: x=${crop.x}, y=${crop.y}, width=${crop.width}, height=${crop.height}（元画像全体に対する割合）`;
					if ("pdf" in resource) {
						kept.delete(`main ${url}`);
						kept.delete(`whole ${url}`);
						if (crop !== undefined && mode !== "image") throw new ReadError("PDF の crop には page と pdfMode=image が必要です。");
						const pdfKey = `pdf ${entry?.id} ${mode} ${page ?? "all"}`;
						const fresh = freshText(pdfKey);
						const result = fresh ?? await readPdf(resource, mode, page, context.abortSignal, crop);
						if ("image" in result) return { output: [
							{ type: "text" as const, text: `${notice}URL: ${result.url}${result.status === undefined ? "" : `\nHTTP ステータス: ${result.status}`}\nPDF ${page} ページ目${region}\n\n${UNTRUSTED}` },
							{ type: "image" as const, ...result.image },
						] };
						const again = (next: number) => `web_extract を同じ url${page === undefined ? "" : `、page=${page}`}${mode === "text" ? "" : `、pdfMode=${mode}`}、offset=${next} で呼ぶ`;
						return { output: [{ type: "text" as const, text: notice + renderPart(fresh ?? keep(pdfKey, result), false, offset, maxChars, again) }] };
					}
					if (pdfRequested) throw new ReadError("page と pdfMode は PDF にだけ使えます。");
					if ("imageSource" in resource) {
						kept.delete(`main ${url}`);
						kept.delete(`whole ${url}`);
						if (offset > 0) throw new ReadError("画像に offset は使えません。");
						const image = await reader.renderImage(resource, crop, context.abortSignal);
						const status = resource.status === undefined ? "" : `\nHTTP ステータス: ${resource.status}`;
						return { output: [
							{ type: "text" as const, text: `${notice}URL: ${resource.url}${status}${region}\n\n${UNTRUSTED}` },
							{ type: "image" as const, ...image },
						] };
					}
					if (crop !== undefined) throw new ReadError("crop は画像 URL または PDF の画像モードにだけ使えます。");
					const again = (next: number) => `web_extract を同じ url${whole ? "、whole=true" : ""}、offset=${next} で呼ぶ`;
					return { output: [{ type: "text" as const, text: renderPart(previousText ?? keep(key, resource), whole, offset, maxChars, again) }] };
				},
			}),
		],
	});
}
