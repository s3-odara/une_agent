import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { loadConfig, persona, personaFor } from "./config.ts";
import { spawnGateway } from "./gateway.ts";
import { createAgentModels, openAgentHarness } from "./harness.ts";
import { HostDb } from "./hostdb.ts";
import { createMemoryExtension, MemoryStore } from "./memory.ts";
import { Bridge } from "./rooms.ts";

const context = BACKGROUND_CONTEXT;
const configPath = process.argv[2] ?? "config.json";
const config = loadConfig(configPath);
mkdirSync(config.dataDir, { recursive: true });

const db = new HostDb(join(config.dataDir, "host.sqlite"));
const memory = createMemoryExtension({
	store: new MemoryStore(join(config.dataDir, "memory"), { shared: config.memory.sharedLimit, private: config.memory.privateLimit }),
	// A conversation speaks as the persona of its room, looked up at each use so a config change applies at once.
	personaOf: (conversationId) => {
		const roomId = db.roomOf(conversationId);
		if (roomId === undefined) return undefined;
		const name = personaFor(config, roomId);
		return { name, privateMemory: persona(config, name).privateMemory };
	},
});
const harness = await openAgentHarness(await openNodeSqliteStorage(join(config.dataDir, "session.sqlite")), createAgentModels(), context, [memory]);
// Continue the runs the last process left unfinished before any new message arrives.
harness.resume();

const gateway = spawnGateway(config.gatewayBin, ["run", "--config", configPath]);
new Bridge({ harness, db, link: gateway, config, context }).start();

let stopping = false;
async function shutdown(exitCode: number): Promise<void> {
	if (stopping) return;
	stopping = true;
	gateway.stop();
	await harness.close(context);
	db.close();
	process.exit(exitCode);
}

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));

// Without the gateway nothing arrives and nothing can be sent. Everything is stored, so the simplest recovery is to
// exit and let the supervisor start both again.
gateway.exited.then(
	(code) => {
		if (!stopping) console.error(`gateway exited with code ${code}; stopping`);
		void shutdown(stopping ? 0 : 1);
	},
	(error) => {
		console.error(`gateway could not be started (${config.gatewayBin}): ${error instanceof Error ? error.message : error}`);
		console.error("build it with: npm run build:gateway");
		void shutdown(1);
	},
);
