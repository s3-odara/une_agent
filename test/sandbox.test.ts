import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createSocket } from "node:dgram";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type ChromiumSandbox, sandboxedChromium } from "../src/sandbox.ts";

/**
 * Node stands in for Chromium: it runs under the same policy, and tries what a browser broken into would. The sandbox
 * is the one `just test` builds.
 */

type Sandbox = Partial<Omit<ChromiumSandbox, "executablePath" | "home">>;

/**
 * Runs `body` (which may await) as the browser would be run, and tells whether it got through. `args` are the
 * browser's, as Playwright would give them.
 */
function asBrowser(sandbox: Sandbox, body: string, args: readonly string[] = []): Promise<"allowed" | "refused"> {
	const home = mkdtempSync(join(tmpdir(), "agent-sandbox-home-"));
	const { executablePath, env } = sandboxedChromium({ headless: true, proxy: "http://127.0.0.1:1", ...sandbox, home, executablePath: process.execPath });
	const code = `(async () => { try { ${body}; console.log("allowed"); } catch { console.log("refused"); } })();`;
	return new Promise<"allowed" | "refused">((resolve, reject) =>
		execFile(executablePath, ["-e", code, "--", ...args], { env }, (error, stdout, stderr) => (error ? reject(new Error(stderr || String(error))) : resolve(stdout.trim() as "allowed" | "refused"))),
	).finally(() => rmSync(home, { recursive: true, force: true }));
}

const connect = (to: string | number) =>
	`await new Promise((resolve, reject) => { const socket = require("node:net").connect(${JSON.stringify(to)}).on("connect", () => resolve(socket.destroy())).on("error", reject); })`;

function listen(server: Server, on: string | number): Promise<Server> {
	return new Promise((resolve) => (typeof on === "number" ? server.listen(on, "127.0.0.1", () => resolve(server)) : server.listen(on, () => resolve(server))));
}

const port = (server: Server) => (server.address() as { port: number }).port;

function withTemp(): { readonly path: string; [Symbol.dispose](): void } {
	const path = mkdtempSync(join(tmpdir(), "agent-sandbox-test-"));
	return { path, [Symbol.dispose]: () => rmSync(path, { recursive: true, force: true }) };
}

test("the browser cannot read the user's files", async () => {
	const userFile = fileURLToPath(new URL("../package.json", import.meta.url));
	assert.equal(await asBrowser({}, `require("node:fs").readFileSync(${JSON.stringify(userFile)})`), "refused");
});

const writeIn = (dir: string) => `require("node:fs").writeFileSync(require("node:path").join(${dir}, "f"), "x")`;

test("the browser writes in its own temporary directory, its profile and the directories it is given, and nowhere else", async () => {
	using temp = withTemp();
	const profile = join(temp.path, "profile");
	const given = join(temp.path, "given");
	const other = join(temp.path, "other");
	for (const dir of [profile, given, other]) mkdirSync(dir);
	const write = (dir: string) => asBrowser({ write: [given] }, writeIn(dir), [`--user-data-dir=${profile}`]);
	assert.equal(await write("process.env.TMPDIR"), "allowed");
	assert.equal(await write(JSON.stringify(profile)), "allowed");
	assert.equal(await write(JSON.stringify(given)), "allowed");
	assert.equal(await write(JSON.stringify(other)), "refused");
});

test("the browser can neither read nor write the agent's temporary directory", async (t) => {
	using temp = withTemp();
	writeFileSync(join(temp.path, "agent-file"), "the agent's");
	const previous = process.env.TMPDIR;
	process.env.TMPDIR = temp.path;
	t.after(() => (previous === undefined ? delete process.env.TMPDIR : (process.env.TMPDIR = previous)));
	assert.equal(await asBrowser({}, `require("node:fs").readFileSync(${JSON.stringify(join(temp.path, "agent-file"))})`), "refused");
	assert.equal(await asBrowser({}, writeIn(JSON.stringify(temp.path))), "refused");
});

test("the browser does not get the agent's environment, nor read it from the agent's process", async (t) => {
	process.env.AGENT_TEST_SECRET = "s3cret";
	t.after(() => delete process.env.AGENT_TEST_SECRET);
	assert.equal(await asBrowser({}, `if (process.env.AGENT_TEST_SECRET === undefined) throw 0`), "refused");
	assert.equal(await asBrowser({}, `require("node:fs").readFileSync("/proc/" + process.ppid + "/environ")`), "refused");
});

test("the browser cannot signal the agent", async () => {
	assert.equal(await asBrowser({}, "process.kill(process.ppid, 0)"), "refused");
});

test("the browser connects only to its proxy", async (t) => {
	const proxy = await listen(createServer(), 0);
	const other = await listen(createServer(), 0);
	t.after(() => {
		proxy.close();
		other.close();
	});
	const sandbox = { proxy: `http://127.0.0.1:${port(proxy)}` };
	assert.equal(await asBrowser(sandbox, connect(port(proxy))), "allowed");
	assert.equal(await asBrowser(sandbox, connect(port(other))), "refused");
});

test("the browser sends no UDP", async (t) => {
	const server = createSocket("udp4");
	await new Promise<void>((resolve) => server.bind(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	const send = `await new Promise((resolve, reject) => { const socket = require("node:dgram").createSocket("udp4").on("error", reject); socket.send("x", ${server.address().port}, "127.0.0.1", (error) => { socket.close(); error ? reject(error) : resolve(); }); })`;
	assert.equal(await asBrowser({}, send), "refused");
});

test("a headless browser cannot reach a UNIX socket outside, such as the user's D-Bus", async (t) => {
	using temp = withTemp();
	const path = join(temp.path, "bus");
	const server = await listen(createServer(), path);
	t.after(() => server.close());
	assert.equal(await asBrowser({}, connect(path)), "refused");
});

test("a browser with a window reaches its display's socket, and no other UNIX socket outside", async (t) => {
	using temp = withTemp();
	const display = join(temp.path, "wayland-0");
	const bus = join(temp.path, "bus");
	const servers = [await listen(createServer(), display), await listen(createServer(), bus)];
	const previous = process.env.WAYLAND_DISPLAY;
	process.env.WAYLAND_DISPLAY = display;
	t.after(() => {
		for (const server of servers) server.close();
		if (previous === undefined) delete process.env.WAYLAND_DISPLAY;
		else process.env.WAYLAND_DISPLAY = previous;
	});
	assert.equal(await asBrowser({ headless: false }, connect(display)), "allowed");
	assert.equal(await asBrowser({ headless: false }, connect(bus)), "refused");
});
