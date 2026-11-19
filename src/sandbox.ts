import { mkdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type ChromiumSandbox = {
	readonly headless: boolean;
	/** Chromium's home directory, its own: Chromiums sharing one wait on each other's locks in it. */
	readonly home: string;
	/** Chromium itself; when not given, the build Playwright would launch. */
	readonly executablePath?: string;
	/** Directories Chromium may write to, besides the temporary directory (where Playwright puts its own). */
	readonly write?: readonly string[];
	/** The only TCP ports Chromium may connect to; any when not given. */
	readonly tcpPorts?: readonly number[];
};

const SANDBOX_BIN = process.env.AGENT_SANDBOX_BIN ?? fileURLToPath(new URL("../sandbox/target/release/agent-sandbox", import.meta.url));

const READ = ["/nix/store", "/nix/var/nix/profiles", "/etc", "/usr", "/var/cache/fontconfig", "/run/systemd/resolve", "/sys"];
// /proc: Chromium's own sandbox writes the uid_map of the processes it starts. Landlock keeps it from the /proc files
// of processes outside, as it keeps it from tracing them.
const WRITE = ["/proc", "/dev/null", "/dev/zero", "/dev/random", "/dev/urandom", "/dev/shm"];
/** The agent's environment holds its secrets (API keys, the CalDAV password); the browser gets only these. */
const PASSED = ["PATH", "LANG", "LANGUAGE", "TZ", "SSL_CERT_FILE", "NIX_SSL_CERT_FILE", "FONTCONFIG_FILE"];
const DISPLAY = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE"];

type Registry = { findExecutable(name: string): { executablePath(): string | undefined } | undefined };

/**
 * As Playwright chooses when given no executable: given one, it no longer tells the headless shell from Chromium.
 * The headless shell matters beyond its size: Chromium makes a UNIX socket to keep to one process per profile, which
 * the sandbox refuses a headless browser.
 */
function playwrightChromium(headless: boolean): string {
	const { registry } = createRequire(import.meta.url)("playwright-core/lib/coreBundle").registry as { registry: Registry };
	const name = headless ? "chromium-headless-shell" : "chromium";
	return registry.findExecutable(name)?.executablePath() ?? fail(`Playwright has no ${name}`);
}

function fail(message: string): never {
	throw new Error(message);
}

/**
 * Launch options that run Chromium under `sandbox/` (Landlock): it reads the system's files but not the user's, writes
 * only where it is told to, and cannot reach the user's D-Bus or signal anything outside. This holds Chromium as a
 * whole once a renderer has broken out of Chromium's own sandbox, which holds only the renderers.
 *
 * A browser with a window reaches its display through UNIX sockets, so those are left open to it.
 */
export function sandboxedChromium(sandbox: ChromiumSandbox): { executablePath: string; env: Record<string, string> } {
	const program = sandbox.executablePath ?? playwrightChromium(sandbox.headless);
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
		env.AGENT_SANDBOX_UNIX = "allow";
	}
	env.AGENT_SANDBOX_EXEC = program;
	env.AGENT_SANDBOX_READ = read.join("\n");
	env.AGENT_SANDBOX_WRITE = write.join("\n");
	if (sandbox.tcpPorts !== undefined) env.AGENT_SANDBOX_TCP = sandbox.tcpPorts.join("\n");
	return { executablePath: SANDBOX_BIN, env };
}
