import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createAttachExtension } from "./attach.ts";
import { PlaywrightBrowsers } from "./browser.ts";
import { createBrowserExtension } from "./browser-tools.ts";
import { connectCalDav } from "./caldav.ts";
import { createCompactionExtension } from "./compaction.ts";
import { Calendars } from "./calendar.ts";
import { createCalendarExtension } from "./calendar-tools.ts";
import { Calls } from "./call.ts";
import { Approvals } from "./approval.ts";
import { loadConfig, modelRef, persona, personaFor, usedModels } from "./config.ts";
import { CodeRequests } from "./codes.ts";
import { CredentialCommands } from "./credential-commands.ts";
import { Credentials } from "./credentials.ts";
import { EgressProxy } from "./egress.ts";
import { errorMessage, fail } from "./errors.ts";
import { PlaywrightReader } from "./extract.ts";
import { spawnGateway } from "./gateway.ts";
import { createGeocodeExtension } from "./geocode.ts";
import { compactionSettings, createAgentModels, openAgentHarness, openConfig } from "./harness.ts";
import { HostDb } from "./hostdb.ts";
import { createImageWindowExtension } from "./images.ts";
import { createToolAccessExtensions, McpServers, mcpReads, serversFromConfig } from "./mcp.ts";
import { createMemoryExtension, MemoryStore } from "./memory.ts";
import { createProactiveExtension, Proactive } from "./proactive.ts";
import { Bridge } from "./rooms.ts";
import { Scheduler } from "./scheduler.ts";
import { createSelfExtension } from "./self.ts";
import { WhisperServer } from "./stt.ts";
import { memoryFingerprint, tidyMemory } from "./tidy.ts";
import { Voicevox } from "./tts.ts";
import { jmaForecast } from "./weather.ts";
import { createRainExtension, createSnowExtension, createWeatherExtension } from "./weather-tools.ts";
import { createOutsideExtension } from "./untrusted.ts";
import { createWebExtension } from "./web-tools.ts";

const context = BACKGROUND_CONTEXT;
const RESTART_EXIT_CODE = 75;
const configPath = process.argv[2];
if (!configPath) throw new Error("usage: agent <config.json>");
const config = loadConfig(configPath);
mkdirSync(config.dataDir, { recursive: true });
const models = createAgentModels(config.dataDir);
await openConfig(configPath, models);

const db = new HostDb(join(config.dataDir, "host.sqlite"));
const personas = Object.entries(config.personas).map(([name, item]) => ({ name, privateMemory: item.privateMemory }));
const store = new MemoryStore(join(config.dataDir, "memory"), {
	shared: config.memory.sharedLimit,
	private: config.memory.privateLimit,
});
/** Looked up at each use so a config change applies at once. */
function personaOfConversation(conversationId: number) {
	const roomId = db.roomOf(conversationId);
	if (roomId === undefined) return undefined;
	const name = personaFor(config, roomId);
	return { name, ...persona(config, name) };
}
const memory = createMemoryExtension({
	store,
	personaOf: personaOfConversation,
	tz: config.timezone,
});

const weather = jmaForecast(config.weather);
let calendars: Calendars | undefined;
if (config.caldav !== undefined) {
	const password = process.env.CALDAV_PASSWORD;
	if (password === undefined || password === "")
		throw new Error("config.json has a caldav section, but CALDAV_PASSWORD is not set");
	const backend = connectCalDav({
		url: config.caldav.url,
		username: config.caldav.username,
		password,
		calendars: Object.keys(config.caldav.calendars),
	});
	calendars = new Calendars(backend, config.caldav.calendars, config.timezone);
}
// Both browsers reach only public addresses, through this.
const egress = config.browser !== undefined || config.web !== undefined ? await EgressProxy.start() : undefined;
const browsers =
	config.browser === undefined || egress === undefined
		? undefined
		: new PlaywrightBrowsers({
				dir: join(config.dataDir, "browser"),
				egress,
				executablePath: config.browser.executablePath,
				timezone: config.timezone,
				idleMs: config.browser.idleMinutes * 60_000,
			});
const web = config.web === undefined || egress === undefined ? undefined : startWeb(egress, config.web.maxChars);
// The bridge is made after the harness, which needs the tools; approvals reach it once it exists.
let bridge: Bridge | undefined;
const viaBridge = () => bridge ?? fail("the bridge is not running yet");
const approvals = new Approvals({
	db,
	notice: (roomId, txnId, body) => viaBridge().post(roomId, txnId, body),
	react: (roomId, txnId, eventId, key) => viaBridge().react(roomId, txnId, eventId, key),
});
// Taken before the model sees anything: `!cred` commands, which may hold a password, and one-time codes.
const credentials = new Credentials(join(config.dataDir, "credentials.json"));
const codes = new CodeRequests({ notice: (roomId, txnId, body) => viaBridge().post(roomId, txnId, body) });
// The scheduler is made last; timers reach it once it exists.
let scheduler: Scheduler | undefined;
const mcpServers = serversFromConfig(config.mcp, process.env);
const codemodeSandbox = new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 });
const extensions = [
	CodingTools,
	createCompactionExtension({ db }),
	createImageWindowExtension(),
	createSelfExtension({
		configPath: resolve(configPath),
		workDir: config.baseDir,
		roomOf: (conversationId) => db.roomOf(conversationId),
		...(config.voice === undefined
			? {}
			: { voice: { spoken: config.voice.tts !== undefined, calls: config.voice.call !== undefined } }),
		check: () => openConfig(configPath, models),
		restart: () => void restartWhenIdle(),
	}),
	...(calendars === undefined ? [] : [createCalendarExtension({ calendars, db, approvals })]),
	createWeatherExtension(weather),
	createRainExtension(),
	createSnowExtension(),
	createGeocodeExtension(join(config.dataDir, "geocode.sqlite")),
	createProactiveExtension({
		db,
		tz: config.timezone,
		onTimers: () => scheduler?.timersChanged(),
		reads: mcpReads(mcpServers),
	}),
	createAttachExtension({
		db,
		send: (roomId, txnId, file) => viaBridge().sendAttachment(roomId, txnId, file),
		uploadLimit: () => bridge?.uploadLimit(),
		...(config.web === undefined ? {} : { maxChars: config.web.maxChars }),
	}),
	...(browsers === undefined
		? []
		: [
				createBrowserExtension({
					browsers,
					credentials,
					db,
					profileOf: (conversationId) => personaOfConversation(conversationId)?.browserProfile,
					codes,
					screenshots: {
						send: (roomId, txnId, image) =>
							viaBridge().sendAttachment(roomId, txnId, { ...image, mimeType: "image/png" }),
						dir: join(config.dataDir, "browser-shots"),
					},
				}),
			]),
	...(web === undefined ? [] : [web.extension]),
	...(browsers === undefined && web === undefined && Object.keys(config.mcp).length === 0
		? []
		: [createOutsideExtension({ extract: web !== undefined, browser: browsers !== undefined })]),
	...createToolAccessExtensions(codemodeSandbox, mcpServers),
	// Last: it is the one section that changes within a conversation, and a change re-reads all that follows it.
	memory,
];

const registry = createRegistry();
const harness = await openAgentHarness(
	await openNodeSqliteStorage(join(config.dataDir, "session.sqlite")),
	models,
	context,
	{
		extensions,
		registry,
		env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? config.baseDir }),
		compaction: compactionSettings(models, usedModels(config), config.compaction.at),
	},
);
// Their tools are installed when each server answers; the agent does not wait for them.
const mcp = new McpServers({
	registry,
	servers: mcpServers,
});
void mcp.start();
// Continue the runs the last process left unfinished before any new message arrives.
harness.resume();

const transcriber =
	config.voice === undefined
		? undefined
		: new WhisperServer({
				...config.voice.stt,
				socketPath: join(config.dataDir, "stt.sock"),
				idleMs: config.voice.stt.idleMinutes * 60_000,
			});
const synthesizer = config.voice?.tts === undefined ? undefined : new Voicevox({ url: config.voice.tts.url });
const voice =
	transcriber === undefined
		? undefined
		: {
				transcriber,
				...(synthesizer === undefined ? {} : { synthesizer }),
				outDir: join(config.dataDir, "voice", "out"),
			};

const gateway = spawnGateway(config.gatewayBin, ["run", "--config", configPath]);
bridge = new Bridge({
	harness,
	db,
	link: gateway,
	config,
	context,
	voice,
	handlers: [new CredentialCommands(credentials), codes, approvals],
});
bridge.start();
if (config.voice?.call !== undefined && transcriber !== undefined && synthesizer !== undefined) {
	new Calls({
		link: gateway,
		config,
		transcriber,
		synthesizer,
		ask: (roomId, key, content) => bridge.ask(roomId, key, content),
		notice: (roomId, key, body) => bridge.notice(roomId, key, body),
		outDir: join(config.dataDir, "voice", "call-out"),
	}).start();
}

// Wakes left open by the last process are weighed again at the first tick, once the gateway can send.
const proactive = new Proactive({ harness, db, rooms: bridge, context });
scheduler = new Scheduler({
	config,
	db,
	calendars,
	weather: config.weather === undefined ? undefined : () => weather(),
	// Weighing takes a model request or more for each wake; the tick does not wait for it.
	weigh: () => void proactive.run(),
	runTimer: (roomId, id, content) => bridge.runTimer(roomId, id, content),
	notice: (roomId, key, body) => bridge.notice(roomId, key, body),
	filesDir: join(config.dataDir, "files", "in"),
	tidy: {
		fingerprint: () => memoryFingerprint(store, personas),
		run: (date) => tidyMemory({ harness, store, personas, model: modelRef(config.model), context }, date),
	},
});
scheduler.start();

let stopping = false;
async function shutdown(exitCode: number): Promise<void> {
	if (stopping) return;
	stopping = true;
	scheduler?.stop();
	gateway.stop();
	transcriber?.close();
	await browsers?.close();
	await web?.close();
	await egress?.close();
	await mcp.close();
	await harness.close(context);
	await codemodeSandbox.close();
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
		console.error(`gateway could not be started (${config.gatewayBin}): ${errorMessage(error)}`);
		void shutdown(1);
	},
);

/** Once the answer that asked for it is sent. The unit starts the agent again on this exit code. */
async function restartWhenIdle(): Promise<void> {
	await bridge?.idle();
	console.error("restarting on the agent's own request");
	await shutdown(RESTART_EXIT_CODE);
}

/** Pages are read in a browser of its own, without the logins of the agent's browser. */
function startWeb(egress: EgressProxy, maxChars: number) {
	const reader = new PlaywrightReader({
		egress,
		timezone: config.timezone,
		executablePath: config.browser?.executablePath,
		idleMs: (config.browser?.idleMinutes ?? 10) * 60_000,
	});
	return {
		extension: createWebExtension({ reader, maxChars }),
		close: () => reader.close(),
	};
}
