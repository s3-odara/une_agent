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

export const VIEWPORT = { width: 1280, height: 800 } as const;

export type ScreenshotOptions = {
	readonly fullPage?: boolean;
	readonly format: "png" | "jpeg";
	/** A point to circle, so the model can see where a click landed. */
	readonly mark?: { readonly x: number; readonly y: number };
};

/** Elements are named by the `ref` the latest snapshot gave them, so every action is followed by a new snapshot. */
export interface BrowserPage {
	goto(url: string): Promise<void>;
	back(): Promise<void>;
	snapshot(): Promise<PageSnapshot>;
	/** Where the page is, without reading it. */
	location(): Promise<{ readonly url: string; readonly title: string }>;
	/** `whole` reads the whole page instead of what looks like its main text. */
	read(whole: boolean): Promise<ReadPage>;
	click(ref: string): Promise<void>;
	/** At a point of the viewport, in CSS pixels: for what has no ref, such as an image puzzle or a canvas. */
	clickAt(x: number, y: number): Promise<void>;
	fill(ref: string, text: string): Promise<void>;
	press(key: string, ref?: string): Promise<void>;
	field(ref: string): Promise<FieldInfo>;
	/** Password fields are blacked out. */
	screenshot(options: ScreenshotOptions): Promise<Buffer>;
}

export interface Browsers {
	/**
	 * Rooms sharing a profile share its cookies. A tab belongs to a room rather than to a conversation, so it survives
	 * the room moving on to another conversation.
	 */
	page(profile: string, roomId: string): Promise<BrowserPage>;
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

type Profile = { readonly chromium: IdleChromium<BrowserContext>; readonly pages: Map<string, Page> };

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

/** Runs in the page. It does not take clicks, so it cannot change what the next click hits. */
function addMark(point: { x: number; y: number }): void {
	const doc = (globalThis as unknown as { document: { createElement(tag: string): { id: string; style: { cssText: string } }; documentElement: { append(node: unknown): void } } }).document;
	const mark = doc.createElement("div");
	mark.id = "__agent_click_mark";
	mark.style.cssText = `position:fixed;left:${point.x - 10}px;top:${point.y - 10}px;width:20px;height:20px;border:3px solid #ff0040;border-radius:50%;box-sizing:border-box;pointer-events:none;z-index:2147483647`;
	doc.documentElement.append(mark);
}

function removeMark(): void {
	(globalThis as unknown as { document: { getElementById(id: string): { remove(): void } | null } }).document.getElementById("__agent_click_mark")?.remove();
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
					{ viewport: VIEWPORT, locale: "ja-JP", timezoneId: timezone },
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

	async page(profileName: string, roomId: string): Promise<BrowserPage> {
		const profile = this.#profile(profileName);
		const current = async (): Promise<Page> => {
			const context = await profile.chromium.get();
			let page = profile.pages.get(roomId);
			if (page === undefined || page.isClosed()) {
				page = await context.newPage();
				this.#follow(profile, roomId, page);
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
			location: async () => {
				const page = await current();
				return { url: page.url(), title: await page.title() };
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
				await settle(profile.pages.get(roomId) ?? page);
			},
			clickAt: async (x, y) => {
				const page = await current();
				await page.mouse.click(x, y);
				await settle(profile.pages.get(roomId) ?? page);
			},
			fill: async (ref, text) => (await current()).getByRef(ref).fill(text),
			press: async (key, ref) => {
				const page = await current();
				if (ref === undefined) await page.keyboard.press(key);
				else await page.getByRef(ref).press(key);
				await settle(profile.pages.get(roomId) ?? page);
			},
			field: async (ref) =>
				(await current()).getByRef(ref).evaluate(describeField),
			screenshot: async ({ fullPage = false, format, mark }) => {
				const page = await current();
				if (mark !== undefined) await page.evaluate(addMark, mark).catch(() => {});
				try {
					// A field whose password is shown in clear (a "show password" button) is covered too: it keeps its name.
					return await page.screenshot({
						type: format,
						...(format === "jpeg" ? { quality: 80 } : {}),
						fullPage,
						scale: "css",
						animations: "disabled",
						mask: [page.locator('input[type="password"], input[name*="pass" i]')],
					});
				} finally {
					if (mark !== undefined) await page.evaluate(removeMark).catch(() => {});
				}
			},
		};
	}

	#follow(profile: Profile, roomId: string, page: Page): void {
		profile.pages.set(roomId, page);
		page.on("popup", (popup) => this.#follow(profile, roomId, popup));
	}

	async close(): Promise<void> {
		const profiles = [...this.#profiles.values()];
		this.#profiles.clear();
		await Promise.all(profiles.map((profile) => profile.chromium.close()));
	}
}
