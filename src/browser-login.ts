/**
 * Opens a browser window on the agent's profile, for the logins the agent cannot do itself: two-factor codes, image
 * puzzles, consent screens. Log in by hand, close the window, and the agent has the session.
 *
 *     npm run browser-login -- https://example.com [profile]
 *
 * It needs a display, and the agent must not be using the same profile at that moment: a profile is opened by one
 * browser at a time.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { loadConfig } from "./config.ts";

const [url, profile = "default"] = process.argv.slice(2);
if (url === undefined || !/^https?:\/\//.test(url) || !/^[A-Za-z0-9_-]+$/.test(profile)) {
	console.error("usage: npm run browser-login -- <http(s) URL> [profile]");
	process.exit(2);
}

const config = loadConfig(process.env.AGENT_CONFIG ?? "config.json");
const dir = join(config.dataDir, "browser", profile);
mkdirSync(dir, { recursive: true });

const context = await chromium.launchPersistentContext(dir, {
	headless: false,
	executablePath: config.browser?.executablePath,
	locale: "ja-JP",
	timezoneId: config.timezone,
	viewport: null,
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(url);
console.error(`profile "${profile}" is open at ${url}. Close the window when you are done.`);
await new Promise((resolve) => context.on("close", resolve));
