import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Page } from "playwright-core";

export type Extracted = { readonly title: string; readonly markdown: string; readonly scope: "article" | "page" };

/** Short timeouts, with failures ignored, because some pages never go quiet. */
export async function settle(page: Page): Promise<void> {
	await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
	await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
}

const require = createRequire(import.meta.url);
const source = (module: string) => readFileSync(require.resolve(module), "utf8");

/**
 * Runs in the page. Both libraries are loaded inside a function of their own, so the page's globals are left alone and the
 * page's `module` or `exports`, if it has any, are not used. The page's scripts can still change what this reads, as
 * they can change the page itself; they cannot reach anything outside the page.
 */
let extractFunction: string | undefined;
const extractScript = (whole: boolean) =>
	`(${(extractFunction ??= `(whole) => {
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
// Fails where the page requires Trusted Types, unless the browser bypasses its CSP; the whole page is read instead.
if (!whole) {
	try {
		article = new Readability(document.cloneNode(true)).parse();
	} catch (_) {}
}
if (article !== null && typeof article.content === "string" && (article.textContent || "").trim().length >= 200) {
	return { title: article.title || title, markdown: turndown.turndown(article.content), scope: "article" };
}
const body = document.body === null ? document.createElement("body") : document.body.cloneNode(true);
// Readability makes links absolute; the whole page has to be done here.
for (const link of body.querySelectorAll("a[href]")) link.setAttribute("href", link.href);
return { title, markdown: turndown.turndown(body), scope: "page" };
}`)})(${whole})`;

/** Blank lines run together and trailing spaces dropped: the shape of the text, without what costs only tokens. */
export function tidy(markdown: string): string {
	return markdown
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** `whole` reads the whole page instead of what looks like its main text. */
export async function extractFrom(page: Page, whole: boolean): Promise<Extracted> {
	const extracted = (await page.evaluate(extractScript(whole))) as Extracted;
	return { title: extracted.title.trim(), markdown: tidy(extracted.markdown), scope: extracted.scope };
}
