import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createSocket } from "node:dgram";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type ChromiumSandbox, sandboxedChromium } from "../src/sandbox.ts";
import { listen, tempDir } from "./env.ts";

/**
 * Node stands in for Chromium: it runs under the same policy, and tries what a browser broken into would. The sandbox
 * is the one `just test` builds.
 */

/**
 * Runs `body` (which may await) as the browser would be run, and tells whether it got through. `args` are the
 * browser's, as Playwright would give them.
 */
async function asBrowser(sandbox: Partial<ChromiumSandbox>, body: string, args: readonly string[] = []): Promise<"allowed" | "refused"> {
	using home = tempDir();
	const { executablePath, env } = sandboxedChromium({ headless: true, proxy: "http://127.0.0.1:1", ...sandbox, home: home.path, executablePath: process.execPath });
	const code = `(async () => { try { ${body}; console.log("allowed"); } catch { console.log("refused"); } })();`;
	return await new Promise((resolve, reject) =>
		execFile(executablePath, ["-e", code, "--", ...args], { env }, (error, stdout, stderr) => (error ? reject(new Error(stderr || String(error))) : resolve(stdout.trim() as "allowed" | "refused"))),
	);
}

const connect = (to: string | number) =>
	`await new Promise((resolve, reject) => { const socket = require("node:net").connect(${JSON.stringify(to)}).on("connect", () => resolve(socket.destroy())).on("error", reject); })`;

test("the browser cannot read the user's files", async () => {
	const userFile = fileURLToPath(new URL("../package.json", import.meta.url));
	assert.equal(await asBrowser({}, `require("node:fs").readFileSync(${JSON.stringify(userFile)})`), "refused");
});

const writeIn = (dir: string) => `require("node:fs").writeFileSync(require("node:path").join(${dir}, "f"), "x")`;

test("the browser writes in its own temporary directory and its profile, and nowhere else", async () => {
	using temp = tempDir();
	const profile = join(temp.path, "profile");
	const other = join(temp.path, "other");
	for (const dir of [profile, other]) mkdirSync(dir);
	const write = (dir: string) => asBrowser({}, writeIn(dir), [`--user-data-dir=${profile}`]);
	assert.deepEqual(await Promise.all([write("process.env.TMPDIR"), write(JSON.stringify(profile)), write(JSON.stringify(other))]), [
		"allowed",
		"allowed",
		"refused",
	]);
});

test("the browser can neither read nor write the agent's temporary directory", async () => {
	using agents = tempDir();
	writeFileSync(join(agents.path, "agent-file"), "the agent's");
	const read = asBrowser({}, `require("node:fs").readFileSync(${JSON.stringify(join(agents.path, "agent-file"))})`);
	const write = asBrowser({}, writeIn(JSON.stringify(agents.path)));
	assert.deepEqual(await Promise.all([read, write]), ["refused", "refused"]);
});

test("the browser does not get the agent's environment, nor read it from the agent's process", async (t) => {
	process.env.AGENT_TEST_SECRET = "s3cret";
	t.after(() => delete process.env.AGENT_TEST_SECRET);
	const inEnvironment = asBrowser({}, `if (process.env.AGENT_TEST_SECRET === undefined) throw 0`);
	const fromProcess = asBrowser({}, `require("node:fs").readFileSync("/proc/" + process.ppid + "/environ")`);
	assert.deepEqual(await Promise.all([inEnvironment, fromProcess]), ["refused", "refused"]);
});

test("the browser cannot signal the agent", async () => {
	assert.equal(await asBrowser({}, "process.kill(process.ppid, 0)"), "refused");
});

test("the browser connects only to its proxy", async (t) => {
	const proxyServer = createServer();
	const otherServer = createServer();
	t.after(() => {
		proxyServer.close();
		otherServer.close();
	});
	const [proxy, other] = await Promise.all([listen(proxyServer), listen(otherServer)]);
	const sandbox = { proxy: `http://127.0.0.1:${proxy}` };
	assert.deepEqual(await Promise.all([asBrowser(sandbox, connect(proxy)), asBrowser(sandbox, connect(other))]), ["allowed", "refused"]);
});

test("the browser sends no UDP", async (t) => {
	const server = createSocket("udp4");
	await new Promise<void>((resolve) => server.bind(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	const send = `await new Promise((resolve, reject) => { const socket = require("node:dgram").createSocket("udp4").on("error", reject); socket.send("x", ${server.address().port}, "127.0.0.1", (error) => { socket.close(); error ? reject(error) : resolve(); }); })`;
	assert.equal(await asBrowser({}, send), "refused");
});

test("a headless browser cannot reach a UNIX socket outside, such as the user's D-Bus", async (t) => {
	using temp = tempDir();
	const path = join(temp.path, "bus");
	const server = createServer();
	t.after(() => server.close());
	await listen(server, path);
	assert.equal(await asBrowser({}, connect(path)), "refused");
});

test("a browser with a window reaches its display's socket, and no other UNIX socket outside", async (t) => {
	using temp = tempDir();
	const display = join(temp.path, "wayland-0");
	const bus = join(temp.path, "bus");
	const displayServer = createServer();
	const busServer = createServer();
	const previous = process.env.WAYLAND_DISPLAY;
	process.env.WAYLAND_DISPLAY = display;
	t.after(() => {
		displayServer.close();
		busServer.close();
		if (previous === undefined) delete process.env.WAYLAND_DISPLAY;
		else process.env.WAYLAND_DISPLAY = previous;
	});
	await Promise.all([listen(displayServer, display), listen(busServer, bus)]);
	const reach = (path: string) => asBrowser({ headless: false }, connect(path));
	assert.deepEqual(await Promise.all([reach(display), reach(bus)]), ["allowed", "refused"]);
});
