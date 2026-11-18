import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type BrowserContext, chromium, type Page } from "playwright-core";
import { HIDDEN } from "./credentials.ts";

/** What an element is, as far as typing a secret into it is concerned. */
export type FieldInfo = {
	/** `password`, `text`, `email`, ... for an `<input>`; otherwise the tag name in lower case. */
	readonly kind: string;
	/** Origin of the document the element is in, which for an element inside an `<iframe>` is the frame's. */
	readonly origin: string;
};

export type PageSnapshot = { readonly url: string; readonly title: string; readonly tree: string };

/**
 * One tab, as the browser tools drive it. Elements are named by the `ref` the latest snapshot gave them, so every
 * action is followed by a new snapshot.
 */
export interface BrowserPage {
	goto(url: string): Promise<void>;
	back(): Promise<void>;
	/** The page as an accessibility tree with `[ref=...]` on what can be acted on. */
	snapshot(): Promise<PageSnapshot>;
	/** The visible text of the page. */
	text(): Promise<string>;
	click(ref: string): Promise<void>;
	fill(ref: string, text: string): Promise<void>;
	press(key: string, ref?: string): Promise<void>;
	field(ref: string): Promise<FieldInfo>;
	/** The page as a PNG image, password fields blacked out. */
	screenshot(fullPage: boolean): Promise<Buffer>;
}

export interface Browsers {
	/** The tab of a conversation in a profile, opened on first use. Conversations sharing a profile share its cookies. */
	page(profile: string, conversationId: number): Promise<BrowserPage>;
	close(): Promise<void>;
}

export type BrowserOptions = {
	/** Profiles are kept under this directory, one subdirectory each. */
	readonly dir: string;
	readonly headless: boolean;
	/** A browser binary to use instead of the Chromium that Playwright installs. */
	readonly executablePath?: string;
	readonly timezone: string;
	/** A profile nobody used for this long is closed; its cookies stay on disk. */
	readonly idleMs: number;
};

type Profile = { readonly context: BrowserContext; readonly pages: Map<number, Page>; lastUsed: number };


/** A snapshot line of a text box that has a value: everything up to the value, and the ref. */
const VALUED_TEXTBOX = /^(\s*- textbox\b.*\[ref=(\w+)\](?: \[[^\]]*\])*): .+$/;

/** What an element is; runs in the page. The project is compiled without DOM types, so the element is described here. */
function describeField(node: unknown): FieldInfo {
	const element = node as { tagName: string; type?: string; ownerDocument: { location: { origin: string } } };
	const isInput = element.tagName === "INPUT" && typeof element.type === "string";
	return { kind: (isInput ? (element.type as string) : element.tagName).toLowerCase(), origin: element.ownerDocument.location.origin };
}

/**
 * The snapshot without the contents of password fields. The accessibility tree shows what is typed into a text box,
 * and a password field is one: whatever is in it, typed by the agent, filled in by the site or by the browser, would
 * otherwise be handed to the model. Fields are told apart by asking the page about each ref, not by matching values.
 */
async function hidePasswords(page: Page, tree: string): Promise<string> {
	const lines = await Promise.all(
		tree.split("\n").map(async (line) => {
			const match = VALUED_TEXTBOX.exec(line);
			if (match === null) return line;
			const [, head, ref] = match as unknown as [string, string, string];
			// A field that cannot be asked about is hidden too: showing a text value is not worth risking a password.
			const kind = await page.getByRef(ref).evaluate(describeField, undefined, { timeout: 2_000 }).then(
				(field) => field.kind,
				() => "password",
			);
			return kind === "password" ? `${head}: ${HIDDEN}` : line;
		}),
	);
	return lines.join("\n");
}

/** Lets a page settle after something that may have navigated it, without waiting on pages that never go quiet. */
export async function settle(page: Page): Promise<void> {
	await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
	await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
}

/**
 * Chromium through Playwright, with one persistent profile directory per profile name. A profile is launched at first
 * use and closed again when idle, so the agent does not keep a browser running around the clock.
 */
export class PlaywrightBrowsers implements Browsers {
	readonly #options: BrowserOptions;
	readonly #profiles = new Map<string, Promise<Profile>>();
	readonly #reaper: NodeJS.Timeout;

	constructor(options: BrowserOptions) {
		this.#options = options;
		this.#reaper = setInterval(() => void this.#closeIdle(), 60_000);
		this.#reaper.unref();
	}

	async #launch(name: string): Promise<Profile> {
		const dir = join(this.#options.dir, name);
		mkdirSync(dir, { recursive: true });
		const context = await chromium.launchPersistentContext(dir, {
			headless: this.#options.headless,
			executablePath: this.#options.executablePath,
			viewport: { width: 1280, height: 800 },
			locale: "ja-JP",
			timezoneId: this.#options.timezone,
		});
		context.setDefaultTimeout(15_000);
		context.setDefaultNavigationTimeout(30_000);
		return { context, pages: new Map(), lastUsed: Date.now() };
	}

	#profile(name: string): Promise<Profile> {
		let profile = this.#profiles.get(name);
		if (profile === undefined) {
			const launching = this.#launch(name);
			profile = launching;
			this.#profiles.set(name, launching);
			const forget = () => {
				if (this.#profiles.get(name) === launching) this.#profiles.delete(name);
			};
			// A launch that failed, or a browser that died or was closed by hand: the next use launches it again.
			launching.then((launched) => launched.context.on("close", forget), forget);
		}
		return profile;
	}

	async #closeIdle(): Promise<void> {
		for (const [name, pending] of this.#profiles) {
			const profile = await pending.catch(() => undefined);
			if (profile !== undefined && Date.now() - profile.lastUsed > this.#options.idleMs) {
				this.#profiles.delete(name);
				await profile.context.close().catch(() => {});
			}
		}
	}

	async page(profileName: string, conversationId: number): Promise<BrowserPage> {
		const profile = await this.#profile(profileName);
		profile.lastUsed = Date.now();
		const current = async (): Promise<Page> => {
			let page = profile.pages.get(conversationId);
			if (page === undefined || page.isClosed()) {
				page = await profile.context.newPage();
				this.#follow(profile, conversationId, page);
			}
			profile.lastUsed = Date.now();
			return page;
		};

		return {
			goto: async (url) => {
				const page = await current();
				await page.goto(url, { waitUntil: "domcontentloaded" });
				await settle(page);
			},
			back: async () => {
				const page = await current();
				await page.goBack({ waitUntil: "domcontentloaded" });
				await settle(page);
			},
			snapshot: async () => {
				const page = await current();
				return { url: page.url(), title: await page.title(), tree: await hidePasswords(page, await page.ariaSnapshot({ mode: "ai" })) };
			},
			text: async () => (await current()).locator("body").innerText(),
			click: async (ref) => {
				const page = await current();
				await page.getByRef(ref).click();
				// A click may open a new tab, which then becomes the conversation's page.
				await settle(profile.pages.get(conversationId) ?? page);
			},
			fill: async (ref, text) => (await current()).getByRef(ref).fill(text),
			press: async (key, ref) => {
				const page = await current();
				if (ref === undefined) await page.keyboard.press(key);
				else await page.getByRef(ref).press(key);
				await settle(profile.pages.get(conversationId) ?? page);
			},
			field: async (ref) =>
				(await current()).getByRef(ref).evaluate(describeField),
			screenshot: async (fullPage) => {
				const page = await current();
				// A field whose password is shown in clear (a "show password" button) is covered too: it keeps its name.
				return page.screenshot({ type: "png", fullPage, animations: "disabled", mask: [page.locator('input[type="password"], input[name*="pass" i]')] });
			},
		};
	}

	/** Makes `page` the conversation's page, and any tab it opens the page after it. */
	#follow(profile: Profile, conversationId: number, page: Page): void {
		profile.pages.set(conversationId, page);
		page.on("popup", (popup) => this.#follow(profile, conversationId, popup));
	}

	async close(): Promise<void> {
		clearInterval(this.#reaper);
		const profiles = [...this.#profiles.values()];
		this.#profiles.clear();
		await Promise.all(profiles.map(async (pending) => (await pending.catch(() => undefined))?.context.close().catch(() => {})));
	}
}
