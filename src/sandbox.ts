import { mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export type ChromiumSandbox = {
	readonly headless: boolean;
	/** Chromium's home directory, its own: Chromiums sharing one wait on each other's locks in it. */
	readonly home: string;
	/** The egress proxy (`EgressProxy.url`): every connection goes through it, and none elsewhere. */
	readonly proxy: string;
	/** Chromium itself; nixpkgs' when not given. */
	readonly executablePath?: string;
	/** Directories Chromium may write to, besides the temporary directory (where Playwright puts its own). */
	readonly write?: readonly string[];
};

export type ChromiumLaunch = {
	readonly executablePath: string;
	readonly env: Record<string, string>;
	readonly proxy: { readonly server: string };
	readonly args: string[];
	readonly chromiumSandbox: true;
};

const SANDBOX_BIN = process.env.AGENT_SANDBOX_BIN ?? fileURLToPath(new URL("../sandbox/target/release/agent-sandbox", import.meta.url));

const READ = ["/nix/store", "/nix/var/nix/profiles", "/etc", "/usr", "/var/cache/fontconfig", "/run/systemd/resolve", "/sys"];
// /proc: Chromium's own sandbox writes the uid_map of the processes it starts. Landlock keeps it from the /proc files
// of processes outside, as it keeps it from tracing them.
const WRITE = ["/proc", "/dev/null", "/dev/zero", "/dev/random", "/dev/urandom", "/dev/shm"];
/** The agent's environment holds its secrets (API keys, the CalDAV password); the browser gets only these. */
const PASSED = ["PATH", "LANG", "LANGUAGE", "TZ", "SSL_CERT_FILE", "NIX_SSL_CERT_FILE", "FONTCONFIG_FILE"];
const DISPLAY = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE"];

/** X's socket for `DISPLAY=:n`. */
function xSocket(): string | undefined {
	const x = /^:(\d+)/.exec(process.env.DISPLAY ?? "")?.[1];
	return x === undefined ? undefined : `/tmp/.X11-unix/X${x}`;
}

/** The sockets of the display a window is shown on: X's, and Wayland's for `WAYLAND_DISPLAY`. */
function displaySockets(): string[] {
	const sockets: string[] = [];
	const x = xSocket();
	if (x !== undefined) sockets.push(x);
	const wayland = process.env.WAYLAND_DISPLAY;
	if (wayland !== undefined && wayland !== "") {
		if (isAbsolute(wayland)) sockets.push(wayland);
		else if (process.env.XDG_RUNTIME_DIR !== undefined) sockets.push(join(process.env.XDG_RUNTIME_DIR, wayland));
	}
	return sockets;
}

/**
 * Playwright's launch options for a Chromium run under `sandbox/` (Landlock). It reads the system's files but not the
 * user's, writes only where it is told to, connects only to the egress proxy, uses no UDP, and reaches no UNIX socket
 * made outside it (the user's D-Bus) but its display's, nor signals anything outside. This holds Chromium as a whole
 * once a renderer has broken out of Chromium's own sandbox, which holds only the renderers.
 */
export function sandboxedChromium(sandbox: ChromiumSandbox): ChromiumLaunch {
	const program = sandbox.executablePath ?? process.env.AGENT_CHROMIUM ?? fail("AGENT_CHROMIUM is not set (the dev shell and the package set it)");
	const temp = tmpdir();
	mkdirSync(sandbox.home, { recursive: true, mode: 0o700 });
	const env: Record<string, string> = { HOME: sandbox.home, TMPDIR: temp };
	for (const name of [...PASSED, ...(sandbox.headless ? [] : DISPLAY)]) {
		const value = process.env[name];
		if (value !== undefined) env[name] = value;
	}
	for (const [name, value] of Object.entries(process.env)) if (name.startsWith("LC_") && value !== undefined) env[name] = value;
	const read = [...READ, dirname(realpathSync(program))];
	const write = [temp, sandbox.home, ...WRITE, ...(sandbox.write ?? [])];
	if (!sandbox.headless) {
		read.push(process.env.XAUTHORITY ?? join(process.env.HOME ?? "/", ".Xauthority"));
		write.push("/dev/dri");
		env.AGENT_SANDBOX_UNIX = displaySockets().join("\n");
		// X's library tries the abstract socket first, and gives up on the refusal from the sandbox rather than trying
		// the one with a path; given the path as the display, it goes there directly.
		const x = xSocket();
		if (x !== undefined) env.DISPLAY = x;
	}
	env.AGENT_SANDBOX_EXEC = program;
	env.AGENT_SANDBOX_READ = read.join("\n");
	env.AGENT_SANDBOX_WRITE = write.join("\n");
	env.AGENT_SANDBOX_TCP = new URL(sandbox.proxy).port;
	return {
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
	};
}

function fail(message: string): never {
	throw new Error(message);
}
