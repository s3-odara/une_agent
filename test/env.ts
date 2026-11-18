import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, type Extension, type Harness, type Registry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type Config, parseConfig } from "../src/config.ts";
import { openAgentHarness } from "../src/harness.ts";
import { HostDb } from "../src/hostdb.ts";
import { Bridge, type BridgeOptions } from "../src/rooms.ts";
import { FakeLink } from "./fakes.ts";

export { context };

export const ME = "@me:example.org";

export function tempDir(): { readonly path: string; [Symbol.dispose](): void } {
	const path = mkdtempSync(join(tmpdir(), "agent-test-"));
	return { path, [Symbol.dispose]: () => rmSync(path, { recursive: true, force: true }) };
}

export function testConfig(dir: string, overrides: Record<string, unknown> = {}): Config {
	return parseConfig(
		{
			matrix: { homeserver: "https://example.org", userId: "@agent:example.org", allowedUsers: [ME] },
			model: { provider: "faux", modelId: "faux-1" },
			personas: { default: "soul.md" },
			timezone: "Asia/Tokyo",
			...overrides,
		},
		dir,
	);
}

export type EnvOptions = {
	readonly config?: Record<string, unknown>;
	readonly souls?: Readonly<Record<string, string>>;
	/** Built again at each (re)start, with that start's database. */
	readonly extensions?: (env: { readonly config: Config; readonly db: HostDb }) => Extension[];
	readonly now?: () => number;
};

export async function agentEnv(options: EnvOptions = {}) {
	const dir = tempDir();
	for (const [name, soul] of Object.entries({ "soul.md": "SOUL", ...options.souls })) writeFileSync(join(dir.path, name), soul);
	const faux = fauxProvider();
	const model = faux.getModel();
	const config = testConfig(dir.path, { model: { provider: model.provider, modelId: model.id }, ...options.config });
	mkdirSync(config.dataDir, { recursive: true });
	const models = createModels();
	models.setProvider(faux.provider);

	let db!: HostDb;
	let harness!: Harness;
	let link!: FakeLink;
	let registry!: Registry;
	const open = async () => {
		db = new HostDb(join(dir.path, "host.sqlite"));
		registry = createRegistry();
		harness = await openAgentHarness(await openNodeSqliteStorage(join(dir.path, "session.sqlite")), models, context, {
			extensions: options.extensions?.({ config, db }) ?? [],
			now: options.now,
			registry,
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
			dir[Symbol.dispose]();
		},
	};
}
