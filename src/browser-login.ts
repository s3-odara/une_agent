/**
 * For the logins the agent cannot do itself: two-factor codes, image puzzles, consent screens. Log in by hand, close
 * the window, and the agent has the session.
 *
 * It needs a display, and the agent must not be using the same profile at that moment: a profile is opened by one
 * browser at a time.
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { loadConfig } from "./config.ts";
import { EgressProxy } from "./egress.ts";
import { chromiumHome, sandboxedChromium } from "./sandbox.ts";

const [url, profile = "default"] = process.argv.slice(2);
if (url === undefined || !/^https?:\/\//.test(url) || !/^[A-Za-z0-9_-]+$/.test(profile)) {
	console.error("usage: just browser-login <http(s) URL> [profile]");
	process.exit(2);
}

const config = loadConfig(process.env.AGENT_CONFIG ?? "config.json");
const dir = join(config.dataDir, "browser", profile);
mkdirSync(dir, { recursive: true });

// Confined as the agent's browser is: the pages are as untrusted, and the profile is the same.
const egress = await EgressProxy.start();
const home = chromiumHome();
const context = await chromium.launchPersistentContext(dir, {
	headless: false,
	...sandboxedChromium({ headless: false, home, proxy: egress.url, executablePath: config.browser?.executablePath, write: [dir] }),
	locale: "ja-JP",
	timezoneId: config.timezone,
	viewport: null,
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(url);
console.error(`profile "${profile}" is open at ${url}. Close the window when you are done.`);
await new Promise((resolve) => context.on("close", resolve));
await egress.close();
rmSync(home, { recursive: true, force: true });
