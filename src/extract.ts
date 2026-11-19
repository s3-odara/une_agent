import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Browser } from "playwright-core";
import { settle } from "./browser.ts";
import { EgressError, type EgressProxy } from "./egress.ts";
import { errorMessage } from "./errors.ts";
import { launchSandboxed } from "./sandbox.ts";
import { httpUrl } from "./urls.ts";

export type ReadPage = {
	readonly url: string;
	readonly title: string;
	readonly markdown: string;
	readonly scope: "article" | "page";
	readonly status?: number;
};

export interface PageReader {
	read(url: string, signal?: AbortSignal): Promise<ReadPage>;
	close(): Promise<void>;
}

/** Its message is written for the model. */
export class ReadError extends Error {}

export type PlaywrightReaderOptions = {
	readonly egress: EgressProxy;
	readonly timezone: string;
	readonly executablePath?: string;
	readonly idleMs: number;
	readonly timeoutMs?: number;
};

const require = createRequire(import.meta.url);
const source = (module: string) => readFileSync(require.resolve(module), "utf8");

/**
 * Runs in the page. Both libraries are loaded inside a function of their own, so the page's globals are left alone and the
 * page's `module` or `exports`, if it has any, are not used. The page's scripts can still change what this reads, as
 * they can change the page itself; they cannot reach anything outside the page.
 */
let extractScript: string | undefined;
const extract = () => (extractScript ??= `(() => {
const Readability = (() => { const module = { exports: {} }; ${source("@mozilla/readability/Readability.js")}
; return module.exports; })();
const TurndownService = (() => { const module = { exports: {} }; const exports = module.exports; ${source("turndown/lib/turndown.browser.umd.js")}
; return module.exports; })();

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "*" });
turndown.remove(["script", "style", "noscript", "template", "iframe", "object", "embed", "svg", "canvas", "select", "button"]);
// An image is its description: its address is no use to read, and a data: URL can be megabytes.
turndown.addRule("image", { filter: "img", replacement: (_content, node) => { const alt = (node.getAttribute("alt") || "").trim(); return alt === "" ? "" : "[画像: " + alt + "]"; } });
// A link that runs script, or has no address, is its text.
turndown.addRule("link", {
	filter: (node) => node.nodeName === "A",
	replacement: (content, node) => {
		const href = node.getAttribute("href") || "";
		const text = content.trim();
		if (text === "") return "";
		if (!/^https?:/i.test(href)) return content;
		// Percent-encoded Japanese is three times as long and unreadable; spaces and parentheses stay encoded.
		let shown = href;
		try { shown = decodeURI(href).replace(/[\s()]/g, encodeURIComponent); } catch (_) {}
		return "[" + text + "](" + shown + ")";
	},
});

const title = document.title || "";
let article = null;
try {
	article = new Readability(document.cloneNode(true)).parse();
} catch (_) {}
if (article !== null && typeof article.content === "string" && (article.textContent || "").trim().length >= 200) {
	return { title: article.title || title, markdown: turndown.turndown(article.content), scope: "article" };
}
const body = document.body === null ? document.createElement("body") : document.body.cloneNode(true);
// Readability makes links absolute; the whole page has to be done here.
for (const link of body.querySelectorAll("a[href]")) link.setAttribute("href", link.href);
return { title, markdown: turndown.turndown(body), scope: "page" };
})()`);

/** Blank lines run together and trailing spaces dropped: the shape of the text, without what costs only tokens. */
function tidy(markdown: string): string {
	return markdown
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * Apart from the browser the browser tools drive: every page opens in a new context, with no cookies, no logins and
 * nothing kept, and every connection goes through the egress proxy.
 */
export class PlaywrightReader implements PageReader {
	readonly #options: PlaywrightReaderOptions;
	readonly #timeoutMs: number;
	#browser: Promise<Browser> | undefined;
	#lastUsed = 0;
	#busy = 0;
	readonly #reaper: NodeJS.Timeout;

	constructor(options: PlaywrightReaderOptions) {
		this.#options = options;
		this.#timeoutMs = options.timeoutMs ?? 45_000;
		this.#reaper = setInterval(() => void this.#closeIdle(), 60_000);
		this.#reaper.unref();
	}

	#launch(): Promise<Browser> {
		if (this.#browser === undefined) {
			const launching = launchSandboxed({ headless: true, proxy: this.#options.egress.url, executablePath: this.#options.executablePath });
			this.#browser = launching;
			const forget = () => {
				if (this.#browser === launching) this.#browser = undefined;
			};
			launching.then((browser) => browser.on("disconnected", forget), forget);
		}
		return this.#browser;
	}

	async #closeIdle(): Promise<void> {
		const pending = this.#browser;
		if (pending === undefined || this.#busy > 0 || Date.now() - this.#lastUsed <= this.#options.idleMs) return;
		this.#browser = undefined;
		await (await pending.catch(() => undefined))?.close().catch(() => {});
	}

	async read(url: string, signal?: AbortSignal): Promise<ReadPage> {
		let target: URL;
		try {
			target = httpUrl(url);
		} catch (error) {
			throw new ReadError(errorMessage(error));
		}
		// The proxy refuses it anyway; asking first gives the reason instead of a browser error.
		try {
			await this.#options.egress.resolve(target.hostname, Number(target.port || (target.protocol === "https:" ? 443 : 80)));
		} catch (error) {
			if (error instanceof EgressError) throw new ReadError(error.message);
			throw error;
		}

		this.#busy++;
		this.#lastUsed = Date.now();
		const browser = await this.#launch();
		const context = await browser.newContext({
			locale: "ja-JP",
			timezoneId: this.#options.timezone,
			viewport: { width: 1280, height: 800 },
			serviceWorkers: "block",
			acceptDownloads: false,
			// The extraction runs in the page; a page's Content-Security-Policy must not stop it.
			bypassCSP: true,
		});
		const stop = () => void context.close().catch(() => {});
		const timer = setTimeout(stop, this.#timeoutMs);
		signal?.addEventListener("abort", stop, { once: true });
		try {
			const page = await context.newPage();
			let response: Awaited<ReturnType<typeof page.goto>>;
			try {
				response = await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: this.#timeoutMs });
			} catch (error) {
				throw new ReadError(openFailure(errorMessage(error)));
			}
			await settle(page);
			const type = (response?.headers()["content-type"] ?? "text/html").toLowerCase();
			const status = response === null || response.ok() ? {} : { status: response.status() };
			if (type.startsWith("text/plain")) {
				return { url: page.url(), title: "", markdown: tidy(await page.locator("body").innerText()), scope: "page", ...status };
			}
			if (!type.includes("html")) throw new ReadError(`HTML とテキスト以外は読めません（${type.split(";")[0]}）。`);
			const extracted = (await page.evaluate(extract())) as { title: string; markdown: string; scope: "article" | "page" };
			return { url: page.url(), title: extracted.title.trim(), markdown: tidy(extracted.markdown), scope: extracted.scope, ...status };
		} catch (error) {
			if (error instanceof ReadError) throw error;
			if (signal?.aborted === true) throw new ReadError("読み込みを中止しました。");
			throw new ReadError(`ページを読めませんでした: ${errorMessage(error).split("\n")[0]}`);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", stop);
			stop();
			this.#busy--;
			this.#lastUsed = Date.now();
		}
	}

	async close(): Promise<void> {
		clearInterval(this.#reaper);
		const pending = this.#browser;
		this.#browser = undefined;
		await (await pending?.catch(() => undefined))?.close().catch(() => {});
	}
}

function openFailure(message: string): string {
	if (message.includes("Download is starting")) return "この URL はページではなくファイルのダウンロードなので読めません。";
	if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED/.test(message)) {
		return "接続できませんでした（このホストか内部のネットワークへの転送か、相手のサーバーに届かなかった可能性があります）。";
	}
	if (/ERR_NAME_NOT_RESOLVED/.test(message)) return "サイトの名前を解決できませんでした。";
	if (/Timeout|timeout/.test(message)) return "ページの読み込みが時間内に終わりませんでした。";
	return `ページを開けませんでした: ${message.split("\n")[0]}`;
}
