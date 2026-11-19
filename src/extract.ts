import type { Browser } from "playwright-core";
import { EgressError, type EgressProxy } from "./egress.ts";
import { errorMessage } from "./errors.ts";
import { IdleChromium, launchSandboxed } from "./sandbox.ts";
import { extractFrom, settle, tidy } from "./page.ts";
import { httpUrl } from "./urls.ts";

export type ReadPage = {
	readonly url: string;
	readonly title: string;
	readonly markdown: string;
	readonly scope: "article" | "page";
	readonly status?: number;
};

export interface PageReader {
	/** `whole` reads the whole page instead of what looks like its main text. */
	read(url: string, whole: boolean, signal?: AbortSignal): Promise<ReadPage>;
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

/**
 * Apart from the browser the browser tools drive: every page opens in a new context, with no cookies, no logins and
 * nothing kept, and every connection goes through the egress proxy.
 */
export class PlaywrightReader implements PageReader {
	readonly #options: PlaywrightReaderOptions;
	readonly #timeoutMs: number;
	readonly #chromium: IdleChromium<Browser>;

	constructor(options: PlaywrightReaderOptions) {
		this.#options = options;
		this.#timeoutMs = options.timeoutMs ?? 45_000;
		this.#chromium = new IdleChromium((onClosed) => launchSandboxed({ proxy: options.egress.url, executablePath: options.executablePath }, onClosed), options.idleMs);
	}

	async read(url: string, whole: boolean, signal?: AbortSignal): Promise<ReadPage> {
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

		// Not kept from closing for idleness while it reads: a read ends within its timeout, well under the shortest idle time.
		const browser = await this.#chromium.get();
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
			return { url: page.url(), ...(await extractFrom(page, whole)), ...status };
		} catch (error) {
			if (error instanceof ReadError) throw error;
			if (signal?.aborted === true) throw new ReadError("読み込みを中止しました。");
			throw new ReadError(`ページを読めませんでした: ${errorMessage(error).split("\n")[0]}`);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", stop);
			stop();
		}
	}

	close(): Promise<void> {
		return this.#chromium.close();
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
