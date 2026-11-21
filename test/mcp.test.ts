import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { dirname } from "node:path";
import { test } from "node:test";
import { type McpServer, McpServers, serversFromConfig } from "../src/mcp.ts";
import { fromServer } from "../src/untrusted.ts";
import { agentEnv, listen, testConfig, tempDir } from "./env.ts";
import { call, instructionsOf, message, noting, offered, type Request, type ToolResult } from "./fakes.ts";

const ROOM = "!main:example.org";
const LONG = Array.from({ length: 2000 }, (_, i) => `${i + 1} 行目の検索結果`).join("\n");

type Call = { readonly name: string; readonly args: unknown; readonly headers: IncomingMessage["headers"] };

/** An MCP server over Streamable HTTP with the two tools Keenable has. */
class FakeMcpServer {
	readonly calls: Call[] = [];
	readonly cancelled = Promise.withResolvers<void>();
	readonly sessions = new Set<string>();
	readonly called = Promise.withResolvers<void>();
	down = false;
	#server: Server;
	#n = 0;

	constructor() {
		this.#server = createServer((request, response) => {
			let body = "";
			request.on("data", (chunk) => (body += chunk));
			request.on("end", () => {
				if (this.down) return void response.writeHead(503).end();
				if (request.method === "DELETE") return void response.writeHead(204).end();
				const message = JSON.parse(body) as { id?: number; method: string; params?: { name?: string; arguments?: unknown } };
				const session = request.headers["mcp-session-id"];
				if (message.method === "initialize") {
					const id = `s${++this.#n}`;
					this.sessions.add(id);
					return this.#reply(response, message.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } }, { "mcp-session-id": id });
				}
				if (typeof session !== "string" || !this.sessions.has(session)) return void response.writeHead(404).end();
				if (message.method === "notifications/cancelled") this.cancelled.resolve();
				if (message.id === undefined) return void response.writeHead(202).end();
				if (message.method === "tools/list") {
					return this.#reply(response, message.id, {
						tools: [
							{ name: "search_web_pages", description: "Web を検索する", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
							{ name: "fetch_page_content", description: "ページを取得する", inputSchema: { type: "object", properties: { url: { type: "string" } } } },
						],
					});
				}
				if (message.method === "tools/call") {
					this.calls.push({ name: message.params?.name ?? "", args: message.params?.arguments, headers: request.headers });
					this.called.resolve();
					const query = (message.params?.arguments as { query?: string } | undefined)?.query;
					if (query === "終わらない") return;
					const failed = query === "失敗";
					const text = failed ? "検索に失敗しました" : query === "長い" ? LONG : `「${query}」の検索結果`;
					return this.#reply(response, message.id, { content: [{ type: "text", text }], isError: failed });
				}
				return this.#reply(response, message.id, undefined, {}, { code: -32601, message: "no such method" });
			});
		});
	}

	#reply(response: import("node:http").ServerResponse, id: number | undefined, result: unknown, headers: Record<string, string> = {}, error?: unknown): void {
		const payload = JSON.stringify({ jsonrpc: "2.0", id, ...(error === undefined ? { result } : { error }) });
		response.writeHead(200, { "content-type": "application/json", ...headers }).end(payload);
	}

	async start(): Promise<string> {
		return `http://127.0.0.1:${await listen(this.#server)}/mcp`;
	}

	close(): void {
		this.#server.closeAllConnections();
		this.#server.close();
	}
}

async function setup(options: { down?: boolean; headers?: Record<string, string>; exposure?: "codemode" | "direct" } = {}) {
	const server = new FakeMcpServer();
	server.down = options.down === true;
	const url = await server.start();
	const servers: Record<string, McpServer> = {
		keenable: { url, headers: options.headers ?? {}, tools: ["search_web_pages"], replay: "safe", exposure: options.exposure ?? "direct", description: "Web を検索する" },
	};
	const env = await agentEnv({ codemode: { servers } });
	const installed = Promise.withResolvers<void>();
	const mcp = new McpServers({
		registry: env.registry,
		servers,
		retryDelaysMs: [10],
		log: (line) => {
			if (line.includes("installed")) installed.resolve();
		},
	});
	await mcp.start();
	const bridge = env.bridge();
	const results: ToolResult[] = [];
	let n = 0;
	return {
		env,
		server,
		bridge,
		installed: installed.promise,
		results,
		noting: noting(results),
		say: async (body: string) => {
			env.link.emit(message(ROOM, `$${++n}`, body));
			await bridge.idle();
		},
		async [Symbol.asyncDispose]() {
			await mcp.close();
			server.close();
			await env[Symbol.asyncDispose]();
		},
	};
}

const search = (query: string) => call("mcp__keenable__search_web_pages", { query });

test("a search the model makes reaches the server's tool, and its result comes back marked as from outside", async () => {
	await using t = await setup();
	t.env.faux.setResponses([search("緑茶"), t.noting]);
	await t.say("緑茶を調べて");
	assert.deepEqual(
		t.server.calls.map(({ name, args }) => ({ name, args })),
		[{ name: "search_web_pages", args: { query: "緑茶" } }],
	);
	const text = t.results[0]?.text ?? "";
	assert.ok(text.includes("「緑茶」の検索結果"));
	assert.ok(text.indexOf(fromServer("keenable")) < text.indexOf("「緑茶」の検索結果"));
});

test("a result too long for the model is cut, and the whole of it is in the file the result names", async () => {
	await using t = await setup();
	t.env.faux.setResponses([search("長い"), t.noting]);
	await t.say("たくさん調べて");
	const text = t.results[0]?.text ?? "";
	assert.ok(text.length < LONG.length);
	assert.ok(text.includes("1 行目の検索結果") && text.includes("2000 行目の検索結果"));
	const path = text.match(/\/\S+\.txt/)?.[0];
	assert.ok(path !== undefined, "the result names a file");
	try {
		assert.equal(readFileSync(path, "utf8"), LONG);
	} finally {
		rmSync(dirname(path), { recursive: true, force: true });
	}
});

test("a call stopped by !new is called off on the server", async () => {
	await using t = await setup();
	t.env.faux.setResponses([search("終わらない")]);
	t.env.link.emit(message(ROOM, "$a", "調べて"));
	await t.server.called.promise;
	t.env.link.emit(message(ROOM, "$b", "!new"));
	await t.bridge.idle();
	await t.server.cancelled.promise;
});

test("a server left to codemode is announced before connecting without changing the prompt on connection", async () => {
	await using t = await setup({ down: true, exposure: "codemode" });
	const requests: Request[] = [];
	t.env.faux.setResponses([noting([], requests)]);
	await t.say("調べて");
	const before = instructionsOf(requests[0]!);
	assert.ok(before.includes("mcp__keenable"));
	assert.ok(before.includes("Web を検索する"));

	t.server.down = false;
	await t.installed;
	t.env.faux.setResponses([noting([], requests)]);
	await t.say("もう一度調べて");
	assert.equal(instructionsOf(requests[1]!), before);
	assert.ok(!offered(requests[1]!).includes("mcp__keenable__search_web_pages"));
	assert.ok(offered(requests[1]!).includes("codemode"));
});

test("a script calls a tool of a server left to codemode, and gets its result marked as from outside", async () => {
	await using t = await setup({ exposure: "codemode" });
	t.env.faux.setResponses([call("codemode", { code: 'return await tools.mcp__keenable__search_web_pages({ query: "緑茶" });' }), t.noting]);
	await t.say("緑茶を調べて");
	assert.deepEqual(
		t.server.calls.map(({ args }) => args),
		[{ query: "緑茶" }],
	);
	const text = t.results[0]?.text ?? "";
	assert.ok(text.indexOf(fromServer("keenable")) < text.indexOf("「緑茶」の検索結果"));
});

test("a tool of a server left to codemode that tool_search finds is offered, and the model calls it itself", async () => {
	await using t = await setup({ exposure: "codemode" });
	t.env.faux.setResponses([call("tool_search", { query: "search web pages" }), search("緑茶"), t.noting]);
	await t.say("緑茶を調べて");
	assert.equal(t.results[0]?.isError, false);
	assert.equal(t.server.calls.length, 1);
});

test("the tools of a server given directly are offered to the model", async () => {
	await using t = await setup({ exposure: "direct" });
	const requests: Request[] = [];
	t.env.faux.setResponses([noting([], requests)]);
	await t.say("調べて");
	assert.ok(offered(requests[0]!).includes("mcp__keenable__search_web_pages"));
});

test("a tool of the server that the config does not list cannot be called", async () => {
	await using t = await setup();
	t.env.faux.setResponses([call("mcp__keenable__fetch_page_content", { url: "https://example.com/" }), t.noting]);
	await t.say("読んで");
	assert.equal(t.results[0]?.isError, true);
	assert.deepEqual(t.server.calls, []);
});

test("a call the server's tool reports as failed reaches the model as an error, with the server's words", async () => {
	await using t = await setup();
	t.env.faux.setResponses([search("失敗"), t.noting]);
	await t.say("調べて");
	assert.equal(t.results[0]?.isError, true);
	assert.ok(t.results[0]?.text.includes("検索に失敗しました"));
});

test("a session the server has forgotten is started again, and the call goes through", async () => {
	await using t = await setup();
	t.server.sessions.clear();
	t.env.faux.setResponses([search("緑茶"), t.noting]);
	await t.say("緑茶を調べて");
	assert.equal(t.results[0]?.isError, false);
	assert.equal(t.server.calls.length, 1);
});

test("a server that is down at start has its tools once it answers", async () => {
	await using t = await setup({ down: true });
	t.server.down = false;
	await t.installed;
	t.env.faux.setResponses([search("緑茶"), t.noting]);
	await t.say("緑茶を調べて");
	assert.equal(t.results[0]?.isError, false);
	assert.equal(t.server.calls.length, 1);
});

test("the API key goes to the server in the header the config names", async () => {
	await using t = await setup({ headers: { "X-API-Key": "key-1" } });
	t.env.faux.setResponses([search("緑茶"), t.noting]);
	await t.say("緑茶を調べて");
	assert.equal(t.server.calls[0]?.headers["x-api-key"], "key-1");
});

for (const [value, sent] of [
	["key-1", { "X-API-Key": "key-1" }],
	["", {}],
	[undefined, {}],
] as const) {
	test(`a header from the environment is ${value ? "sent when the variable is set" : `left out when the variable is ${value === "" ? "empty" : "unset"}`}`, () => {
		using dir = tempDir();
		const config = testConfig(dir.path, { mcp: { keenable: { url: "https://api.keenable.ai/mcp", headersFromEnv: { "X-API-Key": "KEENABLE_API_KEY" } } } });
		const servers = serversFromConfig(config.mcp, value === undefined ? {} : { KEENABLE_API_KEY: value });
		assert.deepEqual(servers.keenable?.headers, sent);
	});
}
