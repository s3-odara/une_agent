import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { HIDDEN } from "./credentials.ts";
import type { EgressProxy } from "./egress.ts";
import type { ReadPage } from "./extract.ts";
import { extractFrom, settle } from "./page.ts";
import { IdleChromium, launchPersistentSandboxed } from "./sandbox.ts";

export type FieldInfo = {
	readonly kind: string;
	/** For an element inside an `<iframe>`, this is the frame's origin. */
	readonly origin: string;
};

export type PageSnapshot = { readonly url: string; readonly title: string; readonly tree: string };

/** Elements are named by the `ref` the latest snapshot gave them, so every action is followed by a new snapshot. */
export interface BrowserPage {
	goto(url: string): Promise<void>;
	back(): Promise<void>;
	snapshot(): Promise<PageSnapshot>;
	/** `whole` reads the whole page instead of what looks like its main text. */
	read(whole: boolean): Promise<ReadPage>;
	click(ref: string): Promise<void>;
	fill(ref: string, text: string): Promise<void>;
	press(key: string, ref?: string): Promise<void>;
	field(ref: string): Promise<FieldInfo>;
	/** Password fields are blacked out. */
	screenshot(fullPage: boolean): Promise<Buffer>;
}

export interface Browsers {
	/** Conversations sharing a profile share its cookies. */
	page(profile: string, conversationId: number): Promise<BrowserPage>;
	close(): Promise<void>;
}

export type BrowserOptions = {
	readonly dir: string;
	/** Pages reach only public addresses, as the pages `web_extract` reads do. */
	readonly egress: EgressProxy;
	readonly executablePath?: string;
	readonly timezone: string;
	readonly idleMs: number;
};

type Profile = { readonly chromium: IdleChromium<BrowserContext>; readonly pages: Map<number, Page> };

const VALUED_TEXTBOX = /^(\s*- textbox\b.*\[ref=(\w+)\](?: \[[^\]]*\])*): .+$/;

/** Runs in the page. The project is compiled without DOM types, so the element is described here. */
function describeField(node: unknown): FieldInfo {
	const element = node as { tagName: string; type?: string; ownerDocument: { location: { origin: string } } };
	const isInput = element.tagName === "INPUT" && typeof element.type === "string";
	return { kind: (isInput ? (element.type as string) : element.tagName).toLowerCase(), origin: element.ownerDocument.location.origin };
}

/**
 * The accessibility tree shows what is typed into a text box, and a password field is one: whatever is in it, typed by the agent, filled in by the site or by the browser, would
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

export class PlaywrightBrowsers implements Browsers {
	readonly #options: BrowserOptions;
	readonly #profiles = new Map<string, Profile>();

	constructor(options: BrowserOptions) {
		this.#options = options;
	}

	#profile(name: string): Profile {
		let profile = this.#profiles.get(name);
		if (profile === undefined) {
			const { dir, egress, executablePath, timezone, idleMs } = this.#options;
			const chromium = new IdleChromium(async (onClosed) => {
				mkdirSync(join(dir, name), { recursive: true });
				const context = await launchPersistentSandboxed(
					join(dir, name),
					{ proxy: egress.url, executablePath },
					{ viewport: { width: 1280, height: 800 }, locale: "ja-JP", timezoneId: timezone },
					onClosed,
				);
				context.setDefaultTimeout(15_000);
				context.setDefaultNavigationTimeout(30_000);
				return context;
			}, idleMs);
			profile = { chromium, pages: new Map() };
			this.#profiles.set(name, profile);
		}
		return profile;
	}

	async page(profileName: string, conversationId: number): Promise<BrowserPage> {
		const profile = this.#profile(profileName);
		const current = async (): Promise<Page> => {
			const context = await profile.chromium.get();
			let page = profile.pages.get(conversationId);
			if (page === undefined || page.isClosed()) {
				page = await context.newPage();
				this.#follow(profile, conversationId, page);
			}
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
			read: async (whole) => {
				const page = await current();
				await settle(page);
				return { url: page.url(), ...(await extractFrom(page, whole)) };
			},
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

	#follow(profile: Profile, conversationId: number, page: Page): void {
		profile.pages.set(conversationId, page);
		page.on("popup", (popup) => this.#follow(profile, conversationId, popup));
	}

	async close(): Promise<void> {
		const profiles = [...this.#profiles.values()];
		this.#profiles.clear();
		await Promise.all(profiles.map((profile) => profile.chromium.close()));
	}
}
