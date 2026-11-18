import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { PlaywrightBrowsers } from "./browser.ts";
import { createBrowserExtension } from "./browser-tools.ts";
import { connectCalDav } from "./caldav.ts";
import { Calendars } from "./calendar.ts";
import { createCalendarExtension } from "./calendar-tools.ts";
import { Calls } from "./call.ts";
import { Approvals } from "./approval.ts";
import { loadConfig, persona, personaFor } from "./config.ts";
import { CodeRequests } from "./codes.ts";
import { CredentialCommands } from "./credential-commands.ts";
import { Credentials } from "./credentials.ts";
import { EgressProxy } from "./egress.ts";
import { errorMessage } from "./errors.ts";
import { PlaywrightReader } from "./extract.ts";
import { spawnGateway } from "./gateway.ts";
import { createAgentModels, openAgentHarness } from "./harness.ts";
import { HostDb } from "./hostdb.ts";
import { McpServers, serversFromConfig } from "./mcp.ts";
import { createMemoryExtension, MemoryStore } from "./memory.ts";
import { Bridge } from "./rooms.ts";
import { Scheduler } from "./scheduler.ts";
import { WhisperServer } from "./stt.ts";
import { memoryFingerprint, tidyMemory } from "./tidy.ts";
import { Voicevox } from "./tts.ts";
import { jmaForecast } from "./weather.ts";
import { createWeatherExtension } from "./weather-tools.ts";
import { createWebExtension } from "./web-tools.ts";

const context = BACKGROUND_CONTEXT;
const configPath = process.argv[2] ?? "config.json";
const config = loadConfig(configPath);
mkdirSync(config.dataDir, { recursive: true });

const db = new HostDb(join(config.dataDir, "host.sqlite"));
const personas = Object.entries(config.personas).map(([name, item]) => ({ name, privateMemory: item.privateMemory }));
const store = new MemoryStore(join(config.dataDir, "memory"), { shared: config.memory.sharedLimit, private: config.memory.privateLimit });
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
const web = config.web === undefined ? undefined : await startWeb(config.web.maxChars);
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
const extensions = [
	memory,
	...(calendars === undefined ? [] : [createCalendarExtension({ calendars, db, approvals })]),
	...(weather === undefined ? [] : [createWeatherExtension(weather)]),
	...(browsers === undefined
		? []
		: [
				createBrowserExtension({
					browsers,
					credentials,
					db,
					profileOf: (conversationId) => personaOfConversation(conversationId)?.browserProfile,
					codes,
					screenshots: { send: (roomId, txnId, image) => viaBridge().sendImage(roomId, txnId, image), dir: join(config.dataDir, "browser-shots") },
				}),
			]),
	...(web === undefined ? [] : [web.extension]),
];

const registry = createRegistry();
const harness = await openAgentHarness(await openNodeSqliteStorage(join(config.dataDir, "session.sqlite")), createAgentModels(), context, { extensions, registry });
// Their tools are installed when each server answers; the agent does not wait for them.
const mcp = new McpServers({
	registry,
	servers: serversFromConfig(config.mcp, process.env),
});
void mcp.start();
// Continue the runs the last process left unfinished before any new message arrives.
harness.resume();

const transcriber =
	config.voice === undefined
		? undefined
		: new WhisperServer({ ...config.voice.stt, socketPath: join(config.dataDir, "stt.sock"), idleMs: config.voice.stt.idleMinutes * 60_000 });
const synthesizer = config.voice?.tts === undefined ? undefined : new Voicevox({ url: config.voice.tts.url });
const voice =
	transcriber === undefined
		? undefined
		: { transcriber, ...(synthesizer === undefined ? {} : { synthesizer }), outDir: join(config.dataDir, "voice", "out") };

const gateway = spawnGateway(config.gatewayBin, ["run", "--config", configPath]);
bridge = new Bridge({ harness, db, link: gateway, config, context, voice, handlers: [new CredentialCommands(credentials), codes, approvals] });
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
	await web?.close();
	await mcp.close();
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
		console.error(`gateway could not be started (${config.gatewayBin}): ${errorMessage(error)}`);
		console.error("build it with: just gateway (or run the packaged agent: nix run)");
		void shutdown(1);
	},
);

/** Pages are read in a browser of its own whose connections reach only public addresses. */
async function startWeb(maxChars: number) {
	const egress = await EgressProxy.start();
	const reader = new PlaywrightReader({ egress, timezone: config.timezone, executablePath: config.browser?.executablePath, idleMs: (config.browser?.idleMinutes ?? 10) * 60_000 });
	return {
		extension: createWebExtension({ reader, maxChars }),
		close: async () => {
			await reader.close();
			await egress.close();
		},
	};
}

function fail(message: string): never {
	throw new Error(message);
}
