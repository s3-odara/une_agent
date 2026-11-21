import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, type BrowserContext, chromium, type LaunchOptions } from "playwright-core";
import { errorMessage, fail } from "./errors.ts";

export type ChromiumSandbox = {
	/** The egress proxy (`EgressProxy.url`): every connection goes through it, and none elsewhere. */
	readonly proxy: string;
	/** Chromium itself; nixpkgs' when not given. */
	readonly executablePath?: string;
};

export const SANDBOX_BIN = process.env.AGENT_SANDBOX_BIN ?? fileURLToPath(new URL("../sandbox/target/release/agent-sandbox", import.meta.url));

const READ = ["/nix/store", "/nix/var/nix/profiles", "/etc", "/usr", "/var/cache/fontconfig", "/run/systemd/resolve", "/sys"];
// /proc: Chromium's own sandbox writes the uid_map of the processes it starts. Landlock keeps it from the /proc files
// of processes outside, as it keeps it from tracing them.
const WRITE = ["/proc", "/dev/null", "/dev/zero", "/dev/random", "/dev/urandom", "/dev/shm"];
/** The agent's environment holds its secrets (API keys, the CalDAV password); the browser gets only these. */
const PASSED = new Set(["PATH", "LANG", "LANGUAGE", "TZ", "SSL_CERT_FILE", "NIX_SSL_CERT_FILE", "FONTCONFIG_FILE"]);

/**
 * Playwright's launch options for a Chromium run under `sandbox/` (Landlock). It reads the system's files but not the
 * user's, writes only in `home` and the profile Playwright gives it, connects by TCP only to the egress proxy's port
 * (on any address: Landlock knows ports only), uses no UDP, and reaches no UNIX socket made outside it (the user's
 * D-Bus), nor signals anything outside. This holds Chromium as a whole once a renderer has broken out of Chromium's own
 * sandbox, which holds only the renderers.
 *
 * `home` is Chromium's own: Chromiums sharing one wait on each other's locks in it. Its temporary directory is in there
 * too, rather than the agent's, where SQLite keeps the conversations' temporary files.
 */
export function sandboxedChromium(sandbox: ChromiumSandbox & { readonly home: string }) {
	const program = sandbox.executablePath ?? process.env.AGENT_CHROMIUM ?? fail("AGENT_CHROMIUM is not set (the dev shell and the package set it)");
	const temp = join(sandbox.home, "tmp");
	mkdirSync(temp, { recursive: true, mode: 0o700 });
	const env: Record<string, string> = { HOME: sandbox.home, TMPDIR: temp };
	for (const [name, value] of Object.entries(process.env)) {
		if (value !== undefined && (PASSED.has(name) || name.startsWith("LC_"))) env[name] = value;
	}
	if (process.env.AGENT_CHROMIUM_FONTCONFIG) env.FONTCONFIG_FILE = process.env.AGENT_CHROMIUM_FONTCONFIG;
	env.AGENT_SANDBOX_EXEC = program;
	env.AGENT_SANDBOX_READ = [...READ, dirname(realpathSync(program))].join("\n");
	env.AGENT_SANDBOX_WRITE = [sandbox.home, ...WRITE].join("\n");
	env.AGENT_SANDBOX_TCP = new URL(sandbox.proxy).port;
	return {
		headless: true,
		executablePath: SANDBOX_BIN,
		env,
		// Playwright also sends this host's own addresses through the proxy (`<-loopback>`), so they are refused too.
		proxy: { server: sandbox.proxy },
		args: [
			// The proxy has no UDP, and the sandbox none either: no QUIC, and WebRTC only through the proxy.
			"--disable-quic",
			"--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
			"--disable-background-networking",
		],
		// Playwright turns Chromium's own sandbox off unless asked, which would leave a compromised renderer with the
		// agent's files.
		chromiumSandbox: true,
	} satisfies LaunchOptions;
}

/**
 * Short and near the root: Chromium puts a UNIX socket in its temporary directory, inside the home, and such a path
 * may be at most 107 bytes long.
 */
function chromiumHome(): { readonly path: string; remove(): void } {
	const path = mkdtempSync(join(tmpdir(), "chromium-"));
	return {
		path,
		// Called from Playwright's events, where a throw would take the agent down; Chromium's children may still be
		// writing in it as it closes.
		remove: () => void rm(path, { recursive: true, force: true, maxRetries: 3 }).catch((error) => console.error(`removing ${path}: ${errorMessage(error)}`)),
	};
}

/** A sandboxed Chromium whose contexts start empty each time, with no profile on disk. */
export async function launchSandboxed(sandbox: ChromiumSandbox, onClosed: () => void = () => {}): Promise<Browser> {
	const home = chromiumHome();
	try {
		const browser = await chromium.launch(sandboxedChromium({ ...sandbox, home: home.path }));
		browser.on("disconnected", () => {
			home.remove();
			onClosed();
		});
		return browser;
	} catch (error) {
		home.remove();
		throw error;
	}
}

type ContextOptions = Pick<NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>, "viewport" | "locale" | "timezoneId">;

/** A sandboxed Chromium on the profile in `dir`, which it may write. */
export async function launchPersistentSandboxed(dir: string, sandbox: ChromiumSandbox, options: ContextOptions, onClosed: () => void = () => {}): Promise<BrowserContext> {
	const home = chromiumHome();
	try {
		const context = await chromium.launchPersistentContext(dir, { ...sandboxedChromium({ ...sandbox, home: home.path }), ...options });
		context.on("close", () => {
			home.remove();
			onClosed();
		});
		return context;
	} catch (error) {
		home.remove();
		throw error;
	}
}

/**
 * A Chromium launched at its first use and closed once unused for `idleMs`, so the agent does not keep one running
 * around the clock. One that failed to launch, died or was closed by hand is launched again at the next use.
 */
export class IdleChromium<T extends { close(): Promise<void> }> {
	readonly #launch: (onClosed: () => void) => Promise<T>;
	readonly #reaper: NodeJS.Timeout;
	#pending: Promise<T> | undefined;
	#lastUsed = 0;

	constructor(launch: (onClosed: () => void) => Promise<T>, idleMs: number) {
		this.#launch = launch;
		this.#reaper = setInterval(() => {
			if (Date.now() - this.#lastUsed > idleMs) void this.#closePending();
		}, 60_000).unref();
	}

	get(): Promise<T> {
		this.#lastUsed = Date.now();
		if (this.#pending === undefined) {
			const forget = () => {
				if (this.#pending === launching) this.#pending = undefined;
			};
			const launching = this.#launch(forget);
			this.#pending = launching;
			launching.catch(forget);
		}
		return this.#pending;
	}

	async #closePending(): Promise<void> {
		const pending = this.#pending;
		this.#pending = undefined;
		await (await pending?.catch(() => undefined))?.close().catch(() => {});
	}

	close(): Promise<void> {
		clearInterval(this.#reaper);
		return this.#closePending();
	}
}
