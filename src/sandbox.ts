import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, type BrowserContext, chromium, type LaunchOptions } from "playwright-core";
import { fail } from "./errors.ts";

export type ChromiumSandbox = {
	readonly headless: boolean;
	/** The egress proxy (`EgressProxy.url`): every connection goes through it, and none elsewhere. */
	readonly proxy: string;
	/** Chromium itself; nixpkgs' when not given. */
	readonly executablePath?: string;
};

const SANDBOX_BIN = process.env.AGENT_SANDBOX_BIN ?? fileURLToPath(new URL("../sandbox/target/release/agent-sandbox", import.meta.url));

const READ = ["/nix/store", "/nix/var/nix/profiles", "/etc", "/usr", "/var/cache/fontconfig", "/run/systemd/resolve", "/sys"];
// /proc: Chromium's own sandbox writes the uid_map of the processes it starts. Landlock keeps it from the /proc files
// of processes outside, as it keeps it from tracing them.
const WRITE = ["/proc", "/dev/null", "/dev/zero", "/dev/random", "/dev/urandom", "/dev/shm"];
/** The agent's environment holds its secrets (API keys, the CalDAV password); the browser gets only these. */
const PASSED = new Set(["PATH", "LANG", "LANGUAGE", "TZ", "SSL_CERT_FILE", "NIX_SSL_CERT_FILE", "FONTCONFIG_FILE"]);
const DISPLAY = new Set(["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE"]);

/** The sockets of the display a window is shown on: X's (`xSocket`), and Wayland's. */
function displaySockets(xSocket: string | undefined): string[] {
	const sockets = xSocket === undefined ? [] : [xSocket];
	const wayland = process.env.WAYLAND_DISPLAY;
	if (wayland !== undefined && wayland !== "") {
		if (isAbsolute(wayland)) sockets.push(wayland);
		else if (process.env.XDG_RUNTIME_DIR !== undefined) sockets.push(join(process.env.XDG_RUNTIME_DIR, wayland));
	}
	return sockets;
}

/**
 * Playwright's launch options for a Chromium run under `sandbox/` (Landlock). It reads the system's files but not the
 * user's, writes only in `home` and the profile Playwright gives it, connects only to the egress proxy, uses no UDP,
 * and reaches no UNIX socket made outside it (the user's D-Bus) but its display's, nor signals anything outside. This
 * holds Chromium as a whole once a renderer has broken out of Chromium's own sandbox, which holds only the renderers.
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
		if (value !== undefined && (PASSED.has(name) || name.startsWith("LC_") || (!sandbox.headless && DISPLAY.has(name)))) env[name] = value;
	}
	const read = [...READ, dirname(realpathSync(program))];
	const write = [sandbox.home, ...WRITE];
	if (!sandbox.headless) {
		const x = /^:(\d+)/.exec(process.env.DISPLAY ?? "")?.[1];
		const xSocket = x === undefined ? undefined : `/tmp/.X11-unix/X${x}`;
		read.push(process.env.XAUTHORITY ?? join(process.env.HOME ?? "/", ".Xauthority"));
		write.push("/dev/dri");
		env.AGENT_SANDBOX_UNIX = displaySockets(xSocket).join("\n");
		// X's library tries the abstract socket first, and gives up on the refusal from the sandbox rather than trying
		// the one with a path; given the path as the display, it goes there directly.
		if (xSocket !== undefined) env.DISPLAY = xSocket;
	}
	env.AGENT_SANDBOX_EXEC = program;
	env.AGENT_SANDBOX_READ = read.join("\n");
	env.AGENT_SANDBOX_WRITE = write.join("\n");
	env.AGENT_SANDBOX_TCP = new URL(sandbox.proxy).port;
	return {
		headless: sandbox.headless,
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
	return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}

/** A sandboxed Chromium whose contexts start empty each time, with no profile on disk. */
export async function launchSandboxed(sandbox: ChromiumSandbox): Promise<Browser> {
	const home = chromiumHome();
	try {
		const browser = await chromium.launch(sandboxedChromium({ ...sandbox, home: home.path }));
		browser.on("disconnected", home.remove);
		return browser;
	} catch (error) {
		home.remove();
		throw error;
	}
}

type ContextOptions = Pick<NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>, "viewport" | "locale" | "timezoneId">;

/** A sandboxed Chromium on the profile in `dir`, which it may write. */
export async function launchPersistentSandboxed(dir: string, sandbox: ChromiumSandbox, options: ContextOptions): Promise<BrowserContext> {
	const home = chromiumHome();
	try {
		const context = await chromium.launchPersistentContext(dir, { ...sandboxedChromium({ ...sandbox, home: home.path }), ...options });
		context.on("close", home.remove);
		return context;
	} catch (error) {
		home.remove();
		throw error;
	}
}
