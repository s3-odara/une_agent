import { readFileSync } from "node:fs";
import { MODEL_THINKING_LEVELS, type ModelThinkingLevel } from "@earendil-works/pi-ai/providers/model-schema";
import { dirname, join, resolve } from "node:path";
import type { CalendarConfig } from "./calendar.ts";
import type { CallVad } from "./gateway.ts";
import { isTimeZone, parseClock } from "./time.ts";

export type Config = {
	readonly baseDir: string;
	readonly dataDir: string;
	readonly gatewayBin: string;
	readonly matrix: {
		readonly homeserver: string;
		readonly userId: string;
		readonly deviceName: string;
		readonly allowedUsers: readonly string[];
	};
	readonly model: ModelRef;
	readonly thinking: ModelThinkingLevel;
	readonly personas: Readonly<Record<string, Persona>>;
	readonly defaultPersona: string;
	readonly rooms: Readonly<Record<string, string>>;
	readonly memory: {
		/** Memory is always shown in full, so it has to stay small. */
		readonly sharedLimit: number;
		readonly privateLimit: number;
		readonly tidyAt?: number;
		readonly tidyEveryDays: number;
	};
	readonly timezone: string;
	readonly caldav?: {
		readonly url: string;
		readonly username: string;
		/** By display name on the server. */
		readonly calendars: CalendarConfig;
	};
	readonly weather?: {
		/** Office code of the Japan Meteorological Agency forecast, e.g. `130000` for Tokyo. */
		readonly jmaOfficeCode: string;
		readonly areaIndex: number;
	};
	readonly browser?: {
		readonly executablePath?: string;
		readonly idleMinutes: number;
	};
	/** `web_extract` reads pages in a browser of its own with no logins. */
	readonly web?: {
		readonly maxChars: number;
	};
	readonly mcp: Readonly<Record<string, McpServerConfig>>;
	readonly voice?: {
		readonly stt: {
			readonly server: string;
			readonly model: string;
			readonly vadModel: string;
			readonly threads: number;
			readonly beamSize: number;
			readonly language: string;
			/** Padding VAD adds around speech. 0: the default 30 ms made the model invent words in trailing silence. */
			readonly vadSpeechPadMs: number;
			/** The recognizer holds about a gigabyte of memory; one unused for this long is stopped. */
			readonly idleMinutes: number;
		};
		readonly tts?: {
			/** VOICEVOX Engine. */
			readonly url: string;
			readonly speaker: number;
			readonly maxChars: number;
		};
		readonly call?: {
			readonly maxChars: number;
			readonly chime: boolean;
			readonly transcript: boolean;
			readonly vad: CallVad;
		};
	};
	readonly proactive?: {
		readonly roomId: string;
		readonly briefAt: number;
		readonly windowStart: number;
		readonly windowEnd: number;
		readonly tickMinutes: number;
		readonly eventLeadMinutes: number;
		readonly dueLeadDays: readonly number[];
	};
};

export type McpServerConfig = {
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly headersFromEnv: Readonly<Record<string, string>>;
	readonly tools?: readonly string[];
	/** `safe` when its tools only read, so a call a crash cut off may be made again; otherwise it is not. */
	readonly replay: "safe" | "unsafe";
};

export type ModelRef = { readonly provider: string; readonly modelId: string };

/**
 * A persona is three separate choices, so changing one never forks the others: how it talks (`soul`), what it
 * remembers (shared memory always, plus a memo of its own with `privateMemory`), and what it runs with (`model` and
 * `browserProfile`, inherited from the base config unless set).
 */
export type Persona = {
	readonly soul: string;
	readonly privateMemory: boolean;
	readonly model?: ModelRef;
	readonly thinking?: ModelThinkingLevel;
	/** Decides whose cookies and logins the persona has. */
	readonly browserProfile: string;
	readonly voice?: number;
};

function fail(message: string): never {
	throw new Error(`config: ${message}`);
}

function str(value: unknown, name: string): string {
	if (typeof value !== "string" || value === "") fail(`${name} must be a non-empty string`);
	return value;
}

function stringMap(value: unknown, name: string): Record<string, string> {
	if (value === undefined) return {};
	if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${name} must be an object`);
	const out: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) out[key] = str(item, `${name}.${key}`);
	return out;
}

/** `"provider/model"`. Only the first slash splits, since OpenRouter's model IDs have one of their own. */
function modelRef(value: unknown, name: string): ModelRef {
	const slash = typeof value === "string" ? value.indexOf("/") : -1;
	const text = value as string;
	if (slash <= 0 || slash === text.length - 1) fail(`${name} must be "provider/model", such as "anthropic/claude-fable-5-2"`);
	return { provider: text.slice(0, slash), modelId: text.slice(slash + 1) };
}

function thinking(value: unknown, name: string): ModelThinkingLevel {
	if (!(MODEL_THINKING_LEVELS as readonly unknown[]).includes(value)) fail(`${name} must be one of ${MODEL_THINKING_LEVELS.join(", ")}`);
	return value as ModelThinkingLevel;
}

function limit(value: unknown, fallback: number, name: string): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) fail(`${name} must be a positive integer`);
	return value;
}

function flag(value: unknown, fallback: boolean, name: string): boolean {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") fail(`${name} must be true or false`);
	return value;
}

function clock(value: unknown, fallback: string, name: string): number {
	const minutes = parseClock(str(value ?? fallback, name));
	return minutes ?? fail(`${name} must be a time of day such as "06:00"`);
}

function object(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${name} must be an object`);
	return value as Record<string, unknown>;
}

/** A profile name becomes a directory name under `data/browser/`. */
function profileName(value: unknown, name: string): string {
	const profile = str(value, name);
	if (!/^[A-Za-z0-9_-]+$/.test(profile)) fail(`${name} may only contain letters, digits, "_" and "-"`);
	return profile;
}

function browser(value: unknown): Config["browser"] {
	if (value === undefined) return undefined;
	const root = object(value, "browser");
	return {
		...(root.executablePath === undefined ? {} : { executablePath: str(root.executablePath, "browser.executablePath") }),
		idleMinutes: limit(root.idleMinutes, 10, "browser.idleMinutes"),
	};
}

function web(value: unknown): Config["web"] {
	if (value === undefined) return undefined;
	const root = object(value, "web");
	return { maxChars: limit(root.maxChars, 15_000, "web.maxChars") };
}

function mcp(value: unknown): Config["mcp"] {
	if (value === undefined) return {};
	const out: Record<string, McpServerConfig> = {};
	for (const [name, item] of Object.entries(object(value, "mcp"))) {
		// The name becomes part of tool names, which allow only these.
		if (!/^[A-Za-z0-9_-]+$/.test(name)) fail(`mcp server name "${name}" may only contain letters, digits, "_" and "-"`);
		const server = object(item, `mcp.${name}`);
		const url = str(server.url, `mcp.${name}.url`);
		if (!/^https?:\/\//.test(url)) fail(`mcp.${name}.url must be an http or https URL`);
		const tools = server.tools;
		if (tools !== undefined && (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string" || tool === ""))) {
			fail(`mcp.${name}.tools must be a list of tool names`);
		}
		const replay = server.replay ?? "unsafe";
		if (replay !== "safe" && replay !== "unsafe") fail(`mcp.${name}.replay must be "safe" or "unsafe"`);
		out[name] = {
			url,
			headers: stringMap(server.headers, `mcp.${name}.headers`),
			headersFromEnv: stringMap(server.headersFromEnv, `mcp.${name}.headersFromEnv`),
			...(tools === undefined ? {} : { tools: tools as string[] }),
			replay,
		};
	}
	return out;
}

function nonNegativeInteger(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) fail(`${name} must be an integer of 0 or more`);
	return value;
}

function voice(value: unknown, baseDir: string): Config["voice"] {
	if (value === undefined) return undefined;
	const root = object(value, "voice");
	const stt = object(root.stt ?? {}, "voice.stt");
	return {
		stt: {
			server: resolve(baseDir, str(stt.server ?? PARTS.whisperServer, "voice.stt.server")),
			model: resolve(baseDir, str(stt.model ?? join(PARTS.sttModels, "ggml-large-v3-turbo-q8_0.bin"), "voice.stt.model")),
			vadModel: resolve(baseDir, str(stt.vadModel ?? join(PARTS.sttModels, "ggml-silero-v5.1.2.bin"), "voice.stt.vadModel")),
			threads: limit(stt.threads, 6, "voice.stt.threads"),
			beamSize: limit(stt.beamSize, 5, "voice.stt.beamSize"),
			language: str(stt.language ?? "ja", "voice.stt.language"),
			vadSpeechPadMs: nonNegativeInteger(stt.vadSpeechPadMs ?? 0, "voice.stt.vadSpeechPadMs"),
			idleMinutes: limit(stt.idleMinutes, 10, "voice.stt.idleMinutes"),
		},
		...(root.tts === undefined
			? {}
			: (() => {
					const tts = object(root.tts, "voice.tts");
					return {
						tts: {
							url: str(tts.url ?? "http://127.0.0.1:50021", "voice.tts.url"),
							speaker: nonNegativeInteger(tts.speaker ?? 2, "voice.tts.speaker"),
							maxChars: limit(tts.maxChars, 400, "voice.tts.maxChars"),
						},
					};
				})()),
		...(root.call === undefined ? {} : { call: call(root.call, root.tts !== undefined) }),
	};
}

function call(value: unknown, hasTts: boolean): NonNullable<NonNullable<Config["voice"]>["call"]> {
	if (!hasTts) fail("voice.call needs voice.tts: the bot speaks in calls");
	const root = object(value, "voice.call");
	const vad = object(root.vad ?? {}, "voice.call.vad");
	const threshold = vad.threshold ?? 0.5;
	if (typeof threshold !== "number" || !(threshold > 0 && threshold < 1)) fail("voice.call.vad.threshold must be between 0 and 1");
	return {
		maxChars: limit(root.maxChars, 300, "voice.call.maxChars"),
		chime: flag(root.chime, true, "voice.call.chime"),
		transcript: flag(root.transcript, true, "voice.call.transcript"),
		vad: {
			threshold,
			startMs: limit(vad.startMs, 208, "voice.call.vad.startMs"),
			endSilenceMs: limit(vad.endSilenceMs, 800, "voice.call.vad.endSilenceMs"),
			minSpeechMs: limit(vad.minSpeechMs, 300, "voice.call.vad.minSpeechMs"),
			maxMs: limit(vad.maxMs, 30_000, "voice.call.vad.maxMs"),
			preRollMs: nonNegativeInteger(vad.preRollMs ?? 300, "voice.call.vad.preRollMs"),
		},
	};
}

function caldav(value: unknown): Config["caldav"] {
	if (value === undefined) return undefined;
	const root = object(value, "caldav");
	const calendars: Record<string, { kind: "events" | "todos"; description: string }> = {};
	for (const [name, item] of Object.entries(object(root.calendars, "caldav.calendars"))) {
		// The name is part of the IDs the tools hand out, as `<calendar>/<file>`.
		if (name === "" || name.includes("/")) fail(`caldav.calendars: "${name}" is not usable as a calendar name`);
		const calendar = object(item, `caldav.calendars.${name}`);
		if (calendar.kind !== "events" && calendar.kind !== "todos") fail(`caldav.calendars.${name}.kind must be "events" or "todos"`);
		calendars[name] = { kind: calendar.kind, description: str(calendar.description ?? name, `caldav.calendars.${name}.description`) };
	}
	if (Object.keys(calendars).length === 0) fail("caldav.calendars must name at least one calendar");
	return { url: str(root.url, "caldav.url"), username: str(root.username, "caldav.username"), calendars };
}

function weather(value: unknown): Config["weather"] {
	if (value === undefined) return undefined;
	const root = object(value, "weather");
	const index = root.areaIndex ?? 0;
	if (typeof index !== "number" || !Number.isInteger(index) || index < 0) fail("weather.areaIndex must be 0 or more");
	const code = str(root.jmaOfficeCode, "weather.jmaOfficeCode");
	if (!/^\d{6}$/.test(code)) fail("weather.jmaOfficeCode must be a 6-digit office code such as 130000");
	return { jmaOfficeCode: code, areaIndex: index };
}

function proactive(value: unknown): Config["proactive"] {
	if (value === undefined) return undefined;
	const root = object(value, "proactive");
	const leads = root.dueLeadDays ?? [3, 1];
	if (!Array.isArray(leads) || leads.some((lead) => typeof lead !== "number" || !Number.isInteger(lead) || lead < 0)) {
		fail("proactive.dueLeadDays must be a list of whole days");
	}
	const result = {
		roomId: str(root.roomId, "proactive.roomId"),
		briefAt: clock(root.briefTime, "06:00", "proactive.briefTime"),
		windowStart: clock(root.windowStart, "06:00", "proactive.windowStart"),
		windowEnd: clock(root.windowEnd, "21:00", "proactive.windowEnd"),
		tickMinutes: limit(root.tickMinutes, 15, "proactive.tickMinutes"),
		eventLeadMinutes: limit(root.eventLeadMinutes, 120, "proactive.eventLeadMinutes"),
		dueLeadDays: leads as number[],
	};
	if (result.windowEnd <= result.windowStart) fail("proactive.windowEnd must be later than proactive.windowStart");
	return result;
}

function personas(value: unknown): Record<string, Persona> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) fail("personas must be an object");
	const out: Record<string, Persona> = {};
	for (const [name, item] of Object.entries(value)) {
		// The name becomes a file name (`memory/persona/<name>.md`).
		if (!/^[A-Za-z0-9_-]+$/.test(name)) fail(`persona name "${name}" may only contain letters, digits, "_" and "-"`);
		if (typeof item === "string") {
			out[name] = { soul: str(item, `personas.${name}`), privateMemory: false, browserProfile: "default" };
			continue;
		}
		if (typeof item !== "object" || item === null) fail(`personas.${name} must be a path or an object`);
		const persona = item as Record<string, unknown>;
		out[name] = {
			soul: str(persona.soul, `personas.${name}.soul`),
			privateMemory: flag(persona.privateMemory, false, `personas.${name}.privateMemory`),
			browserProfile: profileName(persona.browserProfile ?? "default", `personas.${name}.browserProfile`),
			...(persona.voice === undefined ? {} : { voice: nonNegativeInteger(persona.voice, `personas.${name}.voice`) }),
			...(persona.model === undefined ? {} : { model: modelRef(persona.model, `personas.${name}.model`) }),
			...(persona.thinking === undefined ? {} : { thinking: thinking(persona.thinking, `personas.${name}.thinking`) }),
		};
	}
	return out;
}

/**
 * The packaged agent (`nix build`) sets these to its own parts; in a source checkout they are the build outputs under
 * the repository, relative to the config file.
 */
const PARTS = {
	gatewayBin: process.env.AGENT_GATEWAY_BIN ?? "gateway/target/release/matrix-gateway",
	whisperServer: process.env.AGENT_WHISPER_SERVER ?? "stt/whisper.cpp/build/bin/whisper-server",
	sttModels: process.env.AGENT_STT_MODELS ?? "stt/models",
};

export function parseConfig(raw: unknown, baseDir: string): Config {
	if (typeof raw !== "object" || raw === null) fail("must be a JSON object");
	const root = raw as Record<string, unknown>;
	const matrix = (root.matrix ?? fail("matrix is required")) as Record<string, unknown>;
	const allowed = matrix.allowedUsers;
	if (!Array.isArray(allowed) || allowed.length === 0) fail("matrix.allowedUsers must list at least one user ID");

	const definedPersonas = personas(root.personas ?? fail("personas is required"));
	const memory = (root.memory ?? {}) as Record<string, unknown>;
	const timezone = str(root.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, "timezone");
	if (!isTimeZone(timezone)) fail(`timezone "${timezone}" is not a known time zone`);
	const rooms = stringMap(root.rooms, "rooms");
	const defaultPersona = str(root.defaultPersona ?? "default", "defaultPersona");
	for (const name of [defaultPersona, ...Object.values(rooms)]) {
		if (!(name in definedPersonas)) fail(`persona "${name}" is used but not defined in personas`);
	}

	return {
		baseDir,
		dataDir: resolve(baseDir, str(root.dataDir ?? "data", "dataDir")),
		gatewayBin: resolve(baseDir, str(root.gatewayBin ?? PARTS.gatewayBin, "gatewayBin")),
		matrix: {
			homeserver: str(matrix.homeserver, "matrix.homeserver"),
			userId: str(matrix.userId, "matrix.userId"),
			deviceName: str(matrix.deviceName ?? "agent", "matrix.deviceName"),
			allowedUsers: allowed.map((user, i) => str(user, `matrix.allowedUsers[${i}]`)),
		},
		model: modelRef(root.model ?? fail("model is required"), "model"),
		thinking: thinking(root.thinking ?? "off", "thinking"),
		personas: definedPersonas,
		defaultPersona,
		rooms,
		memory: {
			sharedLimit: limit(memory.sharedLimit, 2000, "memory.sharedLimit"),
			privateLimit: limit(memory.privateLimit, 1000, "memory.privateLimit"),
			// `null` turns the tidy off; leaving it out keeps the default.
			...(memory.tidyTime === null ? {} : { tidyAt: clock(memory.tidyTime, "02:00", "memory.tidyTime") }),
			tidyEveryDays: limit(memory.tidyEveryDays, 1, "memory.tidyEveryDays"),
		},
		timezone,
		caldav: caldav(root.caldav),
		weather: weather(root.weather),
		proactive: proactive(root.proactive),
		browser: browser(root.browser),
		web: web(root.web),
		mcp: mcp(root.mcp),
		voice: voice(root.voice, baseDir),
	};
}

export function loadConfig(path: string): Config {
	const file = resolve(path);
	return parseConfig(JSON.parse(readFileSync(file, "utf8")), dirname(file));
}

export function personaFor(config: Config, roomId: string): string {
	return config.rooms[roomId] ?? config.defaultPersona;
}

export function modelFor(config: Config, name: string): ModelRef {
	return persona(config, name).model ?? config.model;
}

export function thinkingFor(config: Config, name: string): ModelThinkingLevel {
	return persona(config, name).thinking ?? config.thinking;
}

export function persona(config: Config, name: string): Persona {
	return config.personas[name] ?? fail(`persona "${name}" is not defined`);
}

/** Read at each use so an edit applies without a restart. */
export function readSoul(config: Config, name: string): string {
	return readFileSync(resolve(config.baseDir, persona(config, name).soul), "utf8").trim();
}

/** Every model the config names: the default and each persona's own. */
export function usedModels(config: Config): ModelRef[] {
	return [config.model, ...Object.values(config.personas).flatMap((persona) => (persona.model === undefined ? [] : [persona.model]))];
}
