import type { Browser, Page } from "playwright-core";
import { EgressError, type EgressProxy } from "./egress.ts";
import { errorMessage } from "./errors.ts";
import { IdleChromium, launchSandboxed } from "./sandbox.ts";
import { extractFrom, settle } from "./page.ts";
import { httpUrl } from "./urls.ts";
import {
	decodeText,
	interceptAsset,
	ReadError,
	readImage,
	type BinarySource,
	type Crop,
	type Image,
} from "./web-assets.ts";

export { ReadError };

export type ReadPage = {
	readonly url: string;
	readonly title: string;
	readonly markdown: string;
	readonly scope: "article" | "page";
	readonly status?: number;
	readonly mediaType?: string;
};

export type ReadResource = ReadPage | BinarySource;

export interface PageReader {
	read(url: string, whole: boolean, signal?: AbortSignal): Promise<ReadResource>;
	renderImage(source: BinarySource, crop?: Crop, signal?: AbortSignal): Promise<Image>;
	close(): Promise<void>;
}

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
		this.#chromium = new IdleChromium(
			(onClosed) => launchSandboxed({ proxy: options.egress.url, executablePath: options.executablePath }, onClosed),
			options.idleMs,
		);
	}

	async read(url: string, whole: boolean, signal?: AbortSignal): Promise<ReadResource> {
		let target: URL;
		try {
			target = httpUrl(url);
		} catch (error) {
			throw new ReadError(errorMessage(error));
		}
		// The proxy refuses it anyway; asking first gives the reason instead of a browser error.
		try {
			await this.#options.egress.resolve(
				target.hostname,
				Number(target.port || (target.protocol === "https:" ? 443 : 80)),
			);
		} catch (error) {
			if (error instanceof EgressError) throw new ReadError(error.message);
			throw error;
		}

		return this.#withPage(signal, async (page) => {
			const cdp = await page.context().newCDPSession(page);
			const asset = await interceptAsset(cdp);
			let response: Awaited<ReturnType<typeof page.goto>>;
			try {
				response = await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: this.#timeoutMs });
			} catch (error) {
				throw new ReadError(openFailure(errorMessage(error)));
			}
			const intercepted = await asset();
			await cdp.detach();
			if (intercepted !== undefined) {
				const { body, url, status, mediaType, contentType } = intercepted;
				const meta = { url, ...(status >= 200 && status < 300 ? {} : { status }) };
				if (mediaType === "application/pdf" || mediaType.startsWith("image/")) {
					return { ...meta, kind: mediaType === "application/pdf" ? "pdf" : "image", body, mediaType };
				}
				return { ...meta, title: "", markdown: decodeText(body, contentType), scope: "page", mediaType };
			}
			await settle(page);
			const status = response === null || response.ok() ? {} : { status: response.status() };
			return { url: page.url(), ...(await extractFrom(page, whole)), ...status };
		});
	}

	renderImage(source: BinarySource, crop?: Crop, signal?: AbortSignal): Promise<Image> {
		return this.#withPage(signal, (page) => readImage(page, source, crop));
	}

	async #withPage<T>(signal: AbortSignal | undefined, use: (page: Page) => Promise<T>): Promise<T> {
		const context = await (await this.#chromium.get()).newContext({
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
			if (signal?.aborted) throw new ReadError("読み込みを中止しました。");
			return await use(await context.newPage());
		} catch (error) {
			if (signal?.aborted === true) throw new ReadError("読み込みを中止しました。");
			if (error instanceof ReadError) throw error;
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
	if (message.includes("Download is starting"))
		return "この URL はページではなくファイルのダウンロードなので読めません。";
	if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED/.test(message)) {
		return "接続できませんでした（このホストか内部のネットワークへの転送か、相手のサーバーに届かなかった可能性があります）。";
	}
	if (/ERR_NAME_NOT_RESOLVED/.test(message)) return "サイトの名前を解決できませんでした。";
	if (/Timeout|timeout/.test(message)) return "ページの読み込みが時間内に終わりませんでした。";
	return `ページを開けませんでした: ${message.split("\n")[0]}`;
}
