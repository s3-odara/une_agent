import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { test } from "node:test";
import { McpServers, serversFromConfig } from "../src/mcp.ts";
import { fromServer } from "../src/untrusted.ts";
import { agentEnv, listen, testConfig, tempDir } from "./env.ts";
import { call, message, noting, type ToolResult } from "./fakes.ts";

const ROOM = "!main:example.org";

type Call = { readonly name: string; readonly args: unknown; readonly headers: IncomingMessage["headers"] };

/** An MCP server over Streamable HTTP with the two tools Keenable has. */
class FakeMcpServer {
	readonly calls: Call[] = [];
	readonly sessions = new Set<string>();
	stream = false;
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
					const query = (message.params?.arguments as { query?: string } | undefined)?.query;
					const failed = query === "失敗";
					return this.#reply(response, message.id, { content: [{ type: "text", text: failed ? "検索に失敗しました" : `「${query}」の検索結果` }], isError: failed });
				}
				return this.#reply(response, message.id, undefined, {}, { code: -32601, message: "no such method" });
			});
		});
	}

	#reply(response: import("node:http").ServerResponse, id: number | undefined, result: unknown, headers: Record<string, string> = {}, error?: unknown): void {
		const payload = JSON.stringify({ jsonrpc: "2.0", id, ...(error === undefined ? { result } : { error }) });
		if (this.stream) {
			response.writeHead(200, { "content-type": "text/event-stream", ...headers });
			// Something else first, as a server may send progress before the answer.
			response.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n`);
			response.end(`event: message\ndata: ${payload}\n\n`);
		} else {
			response.writeHead(200, { "content-type": "application/json", ...headers }).end(payload);
		}
	}

	async start(): Promise<string> {
		return `http://127.0.0.1:${await listen(this.#server)}/mcp`;
	}

	close(): void {
		this.#server.closeAllConnections();
		this.#server.close();
	}
}

async function setup(options: { down?: boolean; headers?: Record<string, string> } = {}) {
	const server = new FakeMcpServer();
	server.down = options.down === true;
	const url = await server.start();
	const env = await agentEnv();
	const installed = Promise.withResolvers<void>();
	const servers = new McpServers({
		registry: env.registry,
		servers: { keenable: { url, headers: options.headers ?? {}, tools: ["search_web_pages"], replay: "safe" } },
		retryDelaysMs: [10],
		log: (line) => {
			if (line.includes("installed")) installed.resolve();
		},
	});
	await servers.start();
	const bridge = env.bridge();
	const results: ToolResult[] = [];
	let n = 0;
	return {
		env,
		server,
		installed: installed.promise,
		results,
		noting: noting(results),
		say: async (body: string) => {
			env.link.emit(message(ROOM, `$${++n}`, body));
			await bridge.idle();
		},
		async [Symbol.asyncDispose]() {
			await servers.close();
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

test("an answer sent as an event stream is read", async () => {
	await using t = await setup();
	t.server.stream = true;
	t.env.faux.setResponses([search("緑茶"), t.noting]);
	await t.say("緑茶を調べて");
	assert.ok(t.results[0]?.text.includes("「緑茶」の検索結果"));
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
