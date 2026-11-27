import type { Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool, type Extension, type Registry } from "@earendil-works/pi-durable";
import type { CodemodeSandboxBase } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { type ExecutionEnv, getOrThrow } from "@earendil-works/pi-durable/env";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import {
	type CallToolResult,
	createMcpToolName,
	limitMcpContent,
	mcpNamespace,
	McpClient,
	type McpOutputSaver,
	McpSessionExpiredError,
	normalizeMcpInputSchema,
	StreamableHttpTransport,
	type Tool,
	toLlmContent,
} from "@earendil-works/pi-mcp";
import type { McpServerConfig } from "./config.ts";
import { errorMessage } from "./errors.ts";
import { fromServer } from "./untrusted.ts";

export type McpServer = Omit<McpServerConfig, "headersFromEnv">;

export function serversFromConfig(
	servers: Readonly<Record<string, McpServerConfig>>,
	env: NodeJS.ProcessEnv,
): Record<string, McpServer> {
	return Object.fromEntries(
		Object.entries(servers).map(([name, server]) => {
			const fromEnv = Object.entries(server.headersFromEnv).flatMap(([header, variable]) => {
				const value = env[variable];
				return value === undefined || value === "" ? [] : [[header, value] as const];
			});
			const { headersFromEnv: _, ...rest } = server;
			return [name, { ...rest, headers: { ...server.headers, ...Object.fromEntries(fromEnv) } }];
		}),
	);
}

/**
 * pi-mcp reports a session the server forgot but keeps the client, so a new client starts a new session and the request
 * is sent once more.
 */
class McpSession {
	readonly #url: string;
	readonly #headers: Readonly<Record<string, string>>;
	#client: Promise<McpClient> | undefined;

	constructor(url: string, headers: Readonly<Record<string, string>>) {
		this.#url = url;
		this.#headers = headers;
	}

	listTools(): Promise<Tool[]> {
		return this.#use((client) => client.listTools());
	}

	callTool(name: string, args: Record<string, unknown>, signal: AbortSignal | undefined): Promise<CallToolResult> {
		return this.#use((client) => client.callTool(name, args, signal === undefined ? {} : { signal }));
	}

	async close(): Promise<void> {
		const client = await this.#client?.catch(() => undefined);
		this.#client = undefined;
		await client?.close();
	}

	async #use<T>(request: (client: McpClient) => Promise<T>): Promise<T> {
		for (let attempt = 0; ; attempt++) {
			const opening = this.#open();
			const client = await opening;
			try {
				return await request(client);
			} catch (error) {
				if (!(error instanceof McpSessionExpiredError) || attempt > 0) throw error;
				if (this.#client === opening) this.#client = undefined;
				void client.close().catch(() => {});
			}
		}
	}

	#open(): Promise<McpClient> {
		if (this.#client === undefined) {
			const client = new McpClient({ name: "agent", version: "1.0.0" });
			// Without the server-to-client stream: nothing the server could send there is acted on.
			const transport = new StreamableHttpTransport({
				url: this.#url,
				headers: { ...this.#headers },
				openGetStream: false,
			});
			const opening = client.connect(transport).then(
				() => client,
				async (error: unknown) => {
					await client.close().catch(() => {});
					throw error;
				},
			);
			this.#client = opening;
			opening.catch(() => {
				if (this.#client === opening) this.#client = undefined;
			});
		}
		return this.#client;
	}
}

/** Where `bash` and `codemode` keep the whole of their output too, for the model to `read`. */
function saveIn(env: ExecutionEnv | undefined, context: Context): McpOutputSaver | undefined {
	if (env === undefined) return undefined;
	return async (data, extension) => {
		const path = getOrThrow(await env.createTempFile({ prefix: "pi-mcp-", suffix: extension }, context));
		getOrThrow(await env.writeFile(path, data, context));
		return path;
	};
}

const prefixOf = (server: string) => `${mcpNamespace(server)}__`;

/** Whether a tool is one of a server the config says only reads (`replay: "safe"`). */
export function mcpReads(servers: Readonly<Record<string, McpServer>>): (tool: string) => boolean {
	const prefixes = Object.entries(servers).flatMap(([name, server]) =>
		server.replay === "safe" ? [prefixOf(name)] : [],
	);
	return (tool) => prefixes.some((prefix) => tool.startsWith(prefix));
}

export function createToolAccessExtensions(
	sandbox: CodemodeSandboxBase,
	servers: Readonly<Record<string, McpServer>>,
): Extension[] {
	return [
		createCodemodeExtension({ sandbox }),
		createToolSearchExtension(),
		// Keep the cached prompt stable when deferred tools arrive.
		...Object.entries(servers).map(([name, server]) => createMcpExtension(name, server)),
	];
}

function createMcpExtension(name: string, server: McpServer, tools: Extension["tools"] = []): Extension {
	return defineExtension({
		name: `mcp-${name}`,
		namespace: { name: mcpNamespace(name), description: server.description ?? `MCP: ${name}` },
		tools,
	});
}

function createMcpTools(server: string, session: McpSession, tools: readonly Tool[], options: McpServer) {
	const names = new Set<string>();
	return tools.map((tool) => {
		const name = createMcpToolName(server, tool.name, (taken) => names.has(taken));
		names.add(name);
		return defineTool({
			name,
			description: tool.description ?? tool.name,
			parameters: normalizeMcpInputSchema(tool.inputSchema) as { type: "object" },
			replay: options.replay,
			...(options.exposure === "codemode" ? { deferred: true as const } : {}),
			execute: async (args, api, context) => {
				const result = await session.callTool(tool.name, args as Record<string, unknown>, context.abortSignal);
				const { content } = await limitMcpContent(toLlmContent(result), saveIn(api.env, context));
				if (result.isError === true) {
					throw new Error(
						content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n") ||
							`${tool.name} が失敗しました。`,
					);
				}
				return { output: [{ type: "text" as const, text: fromServer(server) }, ...content] };
			},
		});
	});
}

export type McpServersOptions = {
	readonly servers: Readonly<Record<string, McpServer>>;
	readonly registry: Pick<Registry, "install">;
	readonly retryDelaysMs?: readonly number[];
	readonly log?: (message: string) => void;
};

/** The agent does not wait for them: a server that is down is tried again in the background, and its tools appear when it answers. */
export class McpServers {
	readonly #options: McpServersOptions;
	readonly #sessions = new Map<string, McpSession>();
	readonly #timers = new Set<NodeJS.Timeout>();
	readonly #log: (message: string) => void;
	#stopped = false;

	constructor(options: McpServersOptions) {
		this.#options = options;
		this.#log = options.log ?? ((message) => console.error(message));
	}

	start(): Promise<void> {
		return Promise.all(Object.keys(this.#options.servers).map((name) => this.#connect(name, 0))).then(() => {});
	}

	async #connect(name: string, attempt: number): Promise<void> {
		if (this.#stopped) return;
		const server = this.#options.servers[name] as McpServer;
		const session = new McpSession(server.url, server.headers);
		try {
			const listed = await session.listTools();
			if (this.#stopped) return void (await session.close());
			const offered = server.tools === undefined ? listed : listed.filter((tool) => server.tools?.includes(tool.name));
			for (const missing of (server.tools ?? []).filter((wanted) => !listed.some((tool) => tool.name === wanted))) {
				this.#log(`mcp ${name}: the server has no tool ${missing}`);
			}
			this.#sessions.set(name, session);
			const tools = createMcpTools(name, session, offered, server);
			this.#options.registry.install(createMcpExtension(name, server, tools));
			this.#log(`mcp ${name}: ${offered.length} tools installed`);
		} catch (error) {
			await session.close().catch(() => {});
			const delays = this.#options.retryDelaysMs ?? [10_000, 60_000, 300_000];
			const delay = delays[Math.min(attempt, delays.length - 1)] as number;
			this.#log(`mcp ${name}: could not list its tools (${errorMessage(error)}); trying again in ${delay / 1000} s`);
			const timer = setTimeout(() => {
				this.#timers.delete(timer);
				void this.#connect(name, attempt + 1);
			}, delay);
			timer.unref();
			this.#timers.add(timer);
		}
	}

	async close(): Promise<void> {
		this.#stopped = true;
		for (const timer of this.#timers) clearTimeout(timer);
		this.#timers.clear();
		await Promise.all([...this.#sessions.values()].map((session) => session.close()));
		this.#sessions.clear();
	}
}
