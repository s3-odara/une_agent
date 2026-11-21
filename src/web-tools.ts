import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { bool, int, obj, opt, str } from "@earendil-works/pi-schema";
import type { PageReader, ReadPage } from "./extract.ts";
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
					"ログインせずに公開 URL を読む。HTML は本文を Markdown で返す（whole=true でページ全体）。JSON、CSV、XML/RSS などは整形せずテキストで返す。画像 URL は画像で返す。長いテキストの続きは offset を付けて呼ぶ。PDF、ログイン、ページ操作には非対応。",
				parameters: obj({ url: str({ description: "http または https の URL", minLength: 1 }), ...readParameters }),
				replay: "safe",
				execute: async (args, _api, context) => {
					const url = httpUrl(args.url).href;
					const offset = args.offset ?? 0;
					const whole = args.whole === true;
					const key = `${whole ? "whole" : "main"} ${url}`;
					const fresh = kept.get(key);
					const resource = offset > 0 && fresh !== undefined && now() - fresh.at < KEEP_MS ? fresh : await reader.read(url, whole, context.abortSignal);
					if ("image" in resource) {
						kept.delete(key);
						const status = resource.status === undefined ? "" : `\nHTTP ステータス: ${resource.status}`;
						return { output: [
							{ type: "text" as const, text: `URL: ${resource.url}${status}\n\n${UNTRUSTED}` },
							{ type: "image" as const, ...resource.image },
						] };
					}
					const page = resource === fresh ? resource : keep(key, resource);
					const again = (next: number) => `web_extract を同じ url${whole ? "、whole=true" : ""}、offset=${next} で呼ぶ`;
					return { output: [{ type: "text" as const, text: renderPart(page, whole, offset, maxChars, again) }] };
				},
			}),
		],
	});
}
