import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

/** Runs `body` (which may await) as the browser would be run, and tells whether it got through. */
function asBrowser(sandbox: Omit<ChromiumSandbox, "executablePath" | "home">, body: string): Promise<"allowed" | "refused"> {
	const home = mkdtempSync(join(tmpdir(), "agent-sandbox-home-"));
	const { executablePath, env } = sandboxedChromium({ ...sandbox, home, executablePath: process.execPath });
	const code = `(async () => { try { ${body}; console.log("allowed"); } catch { console.log("refused"); } })();`;
	return new Promise<"allowed" | "refused">((resolve, reject) =>
		execFile(executablePath, ["-e", code], { env }, (error, stdout, stderr) => (error ? reject(new Error(stderr || String(error))) : resolve(stdout.trim() as "allowed" | "refused"))),
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
	assert.equal(await asBrowser({ headless: true }, `require("node:fs").readFileSync(${JSON.stringify(userFile)})`), "refused");
});

test("the browser writes in its temporary directory and the directories it is given, and nowhere else", async (t) => {
	using temp = withTemp();
	const own = join(temp.path, "tmp");
	const given = join(temp.path, "profile");
	const other = join(temp.path, "other");
	for (const dir of [own, given, other]) mkdirSync(dir);
	const previous = process.env.TMPDIR;
	process.env.TMPDIR = own;
	t.after(() => (previous === undefined ? delete process.env.TMPDIR : (process.env.TMPDIR = previous)));
	const write = (dir: string) => asBrowser({ headless: true, write: [given] }, `require("node:fs").writeFileSync(${JSON.stringify(join(dir, "f"))}, "x")`);
	assert.equal(await write(own), "allowed");
	assert.equal(await write(given), "allowed");
	assert.equal(await write(other), "refused");
});

test("the browser does not get the agent's environment, nor read it from the agent's process", async (t) => {
	process.env.AGENT_TEST_SECRET = "s3cret";
	t.after(() => delete process.env.AGENT_TEST_SECRET);
	assert.equal(await asBrowser({ headless: true }, `if (process.env.AGENT_TEST_SECRET === undefined) throw 0`), "refused");
	assert.equal(await asBrowser({ headless: true }, `require("node:fs").readFileSync("/proc/" + process.ppid + "/environ")`), "refused");
});

test("the browser cannot signal the agent", async () => {
	assert.equal(await asBrowser({ headless: true }, "process.kill(process.ppid, 0)"), "refused");
});

test("the browser connects only to the TCP ports it is given", async (t) => {
	const given = await listen(createServer(), 0);
	const other = await listen(createServer(), 0);
	t.after(() => {
		given.close();
		other.close();
	});
	assert.equal(await asBrowser({ headless: true, tcpPorts: [port(given)] }, connect(port(given))), "allowed");
	assert.equal(await asBrowser({ headless: true, tcpPorts: [port(given)] }, connect(port(other))), "refused");
});

test("a headless browser cannot reach a UNIX socket outside, such as the user's D-Bus", async (t) => {
	using temp = withTemp();
	const path = join(temp.path, "bus");
	const server = await listen(createServer(), path);
	t.after(() => server.close());
	assert.equal(await asBrowser({ headless: true }, connect(path)), "refused");
});

test("a browser with a window reaches UNIX sockets outside, as its display needs", async (t) => {
	using temp = withTemp();
	const path = join(temp.path, "display");
	const server = await listen(createServer(), path);
	t.after(() => server.close());
	assert.equal(await asBrowser({ headless: false }, connect(path)), "allowed");
});
