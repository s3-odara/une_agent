import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createRegistry, type Extension, type Harness, type Registry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { compactionSettings } from "../src/compaction.ts";
import { type Config, parseConfig } from "../src/config.ts";
import { openAgentHarness } from "../src/harness.ts";
import { HostDb } from "../src/hostdb.ts";
import { createToolAccessExtensions, type McpServer } from "../src/mcp.ts";
import { Bridge, type BridgeOptions } from "../src/rooms.ts";
import { FakeLink } from "./fakes.ts";

export { context };

export const ME = "@me:example.org";

export function tempDir(): { readonly path: string; [Symbol.dispose](): void } {
	const path = mkdtempSync(join(tmpdir(), "agent-test-"));
	return { path, [Symbol.dispose]: () => rmSync(path, { recursive: true, force: true }) };
}

/** Listens on a free port of this host, or on the UNIX socket at `path`; resolves to the port (0 for a socket). */
export async function listen(server: Server, path?: string): Promise<number> {
	await new Promise<void>((resolve) =>
		path === undefined ? server.listen(0, "127.0.0.1", resolve) : server.listen(path, resolve),
	);
	const address = server.address();
	return typeof address === "object" && address !== null ? address.port : 0;
}

/** As written in config.json. */
export const BASE_CONFIG = {
	matrix: { homeserver: "https://example.org", userId: "@agent:example.org", allowedUsers: [ME] },
	model: "faux/faux-1",
	personas: { default: "soul.md" },
	timezone: "Asia/Tokyo",
};

export function testConfig(dir: string, overrides: Record<string, unknown> = {}): Config {
	return parseConfig({ ...BASE_CONFIG, ...overrides }, dir);
}

export type EnvOptions = {
	readonly config?: Record<string, unknown>;
	readonly souls?: Readonly<Record<string, string>>;
	/** Built again at each (re)start, with that start's database. */
	readonly extensions?: (env: { readonly config: Config; readonly db: HostDb; readonly models: Models }) => Extension[];
	readonly now?: () => number;
	/** The API the fake model speaks, for code that acts only on some providers' APIs. */
	readonly api?: string;
	/** The fake model's context window. */
	readonly contextWindow?: number;
	/** Context tokens at which background compaction starts (`compaction.maxTokens`); none gives pi-durable's defaults. */
	readonly compactMaxTokens?: number;
	/** Gives the model `codemode` and `tool_search` as the agent does, knowing of these MCP servers. */
	readonly codemode?: { readonly servers?: Readonly<Record<string, McpServer>> };
};

export async function agentEnv(options: EnvOptions = {}) {
	const dir = tempDir();
	for (const [name, soul] of Object.entries({ "soul.md": "SOUL", ...options.souls }))
		writeFileSync(join(dir.path, name), soul);
	const faux = fauxProvider({
		...(options.api === undefined ? {} : { api: options.api }),
		...(options.contextWindow === undefined
			? {}
			: { models: [{ id: "faux-1", contextWindow: options.contextWindow }] }),
	});
	const model = faux.getModel();
	const config = testConfig(dir.path, { model: `${model.provider}/${model.id}`, ...options.config });
	mkdirSync(config.dataDir, { recursive: true });
	const models = createModels();
	models.setProvider(faux.provider);

	const sandbox = options.codemode === undefined ? undefined : new CodemodeSandbox();
	const codemode = sandbox === undefined ? [] : createToolAccessExtensions(sandbox, options.codemode?.servers ?? {});

	let db!: HostDb;
	let harness!: Harness;
	let link!: FakeLink;
	let registry!: Registry;
	const open = async () => {
		db = new HostDb(join(dir.path, "host.sqlite"));
		registry = createRegistry();
		harness = await openAgentHarness(await openNodeSqliteStorage(join(dir.path, "session.sqlite")), models, context, {
			extensions: [...(options.extensions?.({ config, db, models }) ?? []), ...codemode],
			env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? dir.path }),
			now: options.now,
			registry,
			...(options.compactMaxTokens === undefined
				? {}
				: {
						compaction: compactionSettings(
							models,
							[{ provider: model.provider, modelId: model.id }],
							options.compactMaxTokens,
						),
					}),
		});
		link = new FakeLink();
	};
	const close = async () => {
		await harness.close(context);
		db.close();
	};
	await open();
	return {
		dir: dir.path,
		faux,
		config,
		get db() {
			return db;
		},
		get harness() {
			return harness;
		},
		get registry() {
			return registry;
		},
		get link() {
			return link;
		},
		bridge(overrides: Partial<BridgeOptions> = {}): Bridge {
			const bridge = new Bridge({ harness, db, link, config, context, log: () => {}, ...overrides });
			bridge.start();
			return bridge;
		},
		async restart() {
			await close();
			await open();
		},
		async [Symbol.asyncDispose]() {
			await close();
			await sandbox?.close();
			dir[Symbol.dispose]();
		},
	};
}
