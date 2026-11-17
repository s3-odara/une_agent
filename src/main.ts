import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { PlaywrightBrowsers } from "./browser.ts";
import { createBrowserExtension } from "./browser-tools.ts";
import { connectCalDav } from "./caldav.ts";
import { Calendars } from "./calendar.ts";
import { createCalendarExtension } from "./calendar-tools.ts";
import { loadConfig, persona, personaFor } from "./config.ts";
import { Credentials } from "./credentials.ts";
import { spawnGateway } from "./gateway.ts";
import { createAgentModels, openAgentHarness } from "./harness.ts";
import { HostDb } from "./hostdb.ts";
import { createMemoryExtension, MemoryStore } from "./memory.ts";
import { Bridge } from "./rooms.ts";
import { Scheduler } from "./scheduler.ts";
import { WhisperServer } from "./stt.ts";
import { memoryFingerprint, tidyMemory } from "./tidy.ts";
import { Voicevox } from "./tts.ts";
import { jmaForecast } from "./weather.ts";

const context = BACKGROUND_CONTEXT;
const configPath = process.argv[2] ?? "config.json";
const config = loadConfig(configPath);
mkdirSync(config.dataDir, { recursive: true });

const db = new HostDb(join(config.dataDir, "host.sqlite"));
const personas = Object.entries(config.personas).map(([name, item]) => ({ name, privateMemory: item.privateMemory }));
const store = new MemoryStore(join(config.dataDir, "memory"), { shared: config.memory.sharedLimit, private: config.memory.privateLimit });
const memory = createMemoryExtension({
	store,
	// A conversation speaks as the persona of its room, looked up at each use so a config change applies at once.
	personaOf: (conversationId) => {
		const roomId = db.roomOf(conversationId);
		if (roomId === undefined) return undefined;
		const name = personaFor(config, roomId);
		return { name, privateMemory: persona(config, name).privateMemory };
	},
});

const weather = config.weather === undefined ? undefined : jmaForecast(config.weather.jmaOfficeCode, config.timezone, config.weather.areaIndex);
let calendars: Calendars | undefined;
if (config.caldav !== undefined) {
	const password = process.env.CALDAV_PASSWORD;
	if (password === undefined || password === "") throw new Error("config.json has a caldav section, but CALDAV_PASSWORD is not set");
	const backend = connectCalDav({ url: config.caldav.url, username: config.caldav.username, password, calendars: Object.keys(config.caldav.calendars) });
	calendars = new Calendars(backend, config.caldav.calendars, config.timezone);
}
const browsers =
	config.browser === undefined
		? undefined
		: new PlaywrightBrowsers({
				dir: join(config.dataDir, "browser"),
				headless: config.browser.headless,
				executablePath: config.browser.executablePath,
				timezone: config.timezone,
				idleMs: config.browser.idleMinutes * 60_000,
			});
const extensions = [
	memory,
	...(calendars === undefined ? [] : [createCalendarExtension({ calendars, db, weather })]),
	...(browsers === undefined
		? []
		: [
				createBrowserExtension({
					browsers,
					credentials: new Credentials(join(config.dataDir, "credentials.json")),
					db,
					profileOf: (conversationId) => {
						const roomId = db.roomOf(conversationId);
						return roomId === undefined ? undefined : persona(config, personaFor(config, roomId)).browserProfile;
					},
				}),
			]),
];

const harness = await openAgentHarness(await openNodeSqliteStorage(join(config.dataDir, "session.sqlite")), createAgentModels(), context, extensions);
// Continue the runs the last process left unfinished before any new message arrives.
harness.resume();

const transcriber =
	config.voice === undefined
		? undefined
		: new WhisperServer({ ...config.voice.stt, socketPath: join(config.dataDir, "stt.sock"), idleMs: config.voice.stt.idleMinutes * 60_000 });
const voice =
	config.voice === undefined || transcriber === undefined
		? undefined
		: {
				transcriber,
				...(config.voice.tts === undefined ? {} : { synthesizer: new Voicevox({ url: config.voice.tts.url }) }),
				outDir: join(config.dataDir, "voice", "out"),
			};

const gateway = spawnGateway(config.gatewayBin, ["run", "--config", configPath]);
const bridge = new Bridge({ harness, db, link: gateway, config, context, voice });
bridge.start();

const scheduler = new Scheduler({
	config,
	db,
	calendars,
	weather,
	submit: (roomId, key, content) => bridge.submitScheduled(roomId, key, content),
	notice: (roomId, key, body) => bridge.notice(roomId, key, body),
	tidy: {
		fingerprint: () => memoryFingerprint(store, personas),
		run: (date) => tidyMemory({ harness, store, personas, model: config.model, context }, date),
	},
});
scheduler.start();

let stopping = false;
async function shutdown(exitCode: number): Promise<void> {
	if (stopping) return;
	stopping = true;
	scheduler.stop();
	gateway.stop();
	transcriber?.close();
	await browsers?.close();
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
