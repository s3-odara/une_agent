import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import { arr, bool, compile, int, map, nullable, num, obj, oneOf, opt, type Schema, type Static, str, type ValidationError } from "@earendil-works/pi-schema";
import { sttModelPaths } from "./stt-paths.ts";
import { isTimeZone } from "./time.ts";
import { forecastArea, type ForecastArea } from "./weather-areas.ts";

/**
 * The packaged agent (`nix build`) sets these to its own parts; in a source checkout they are the build outputs under
 * the repository, relative to the config file.
 */
const PARTS = {
	gatewayBin: process.env.AGENT_GATEWAY_BIN ?? "gateway/target/release/matrix-gateway",
	whisperServer: process.env.AGENT_WHISPER_SERVER ?? "stt/whisper.cpp/build/bin/whisper-server",
	...sttModelPaths(),
};

const text = (options: { default?: string; pattern?: string; description?: string } = {}) => str({ minLength: 1, ...options });
const count = (fallback: number) => int({ minimum: 1, default: fallback });
const amount = (fallback: number) => int({ minimum: 0, default: fallback });
const flag = (fallback: boolean) => bool({ default: fallback });
const clock = (fallback: string) => str({ pattern: "^([01]\\d|2[0-3]):[0-5]\\d$", default: fallback, description: 'a time of day such as "06:00"' });
const model = text({ pattern: "^[^/]+/.+$", description: '"provider/model", such as "anthropic/claude-fable-5-2"' });
const thinking = oneOf(MODEL_THINKING_LEVELS);
const NAME = "^[A-Za-z0-9_-]+$";

/** A section that may be left out, as each of its properties has a default. */
function section<T>(schema: Schema<T>): Schema<T> {
	return { ...schema, default: {} };
}

function named<T>(value: Schema<T>, pattern: string, extra: object = {}): Schema<Record<string, T>> {
	return { ...map(value), propertyNames: { pattern }, ...extra };
}

const Persona = obj({
	soul: text(),
	privateMemory: flag(false),
	model: opt(model),
	thinking: opt(thinking),
	// Decides whose cookies and logins the persona has; it becomes a directory name under `data/browser/`.
	browserProfile: text({ pattern: NAME, default: "default" }),
	voice: opt(int({ minimum: 0 })),
});

const McpServer = obj({
	url: text({ pattern: "^https?://" }),
	headers: map(text(), { default: {} }),
	headersFromEnv: map(text(), { default: {} }),
	tools: opt(arr(text())),
	// `safe` only when its tools only read, so a call a crash cut off may be made again.
	replay: oneOf(["safe", "unsafe"], { default: "unsafe" }),
	// `codemode` keeps the tools out of every request until a script or `tool_search` needs them; `direct` suits a few tools used often.
	exposure: oneOf(["codemode", "direct"], { default: "codemode" }),
	description: opt(text()),
});

const ConfigSchema = obj({
	dataDir: text({ default: "data" }),
	gatewayBin: text({ default: PARTS.gatewayBin }),
	matrix: obj({
		homeserver: text(),
		userId: text(),
		deviceName: text({ default: "agent" }),
		allowedUsers: arr(text(), { minItems: 1 }),
	}),
	model,
	thinking: oneOf(MODEL_THINKING_LEVELS, { default: "off" }),
	// The name becomes a file name (`memory/persona/<name>.md`).
	personas: named(Persona, NAME),
	defaultPersona: text({ default: "default" }),
	rooms: map(text(), { default: {} }),
	memory: section(
		obj({
			// Memory is always shown in full, so it has to stay small.
			sharedLimit: count(2000),
			privateLimit: count(1000),
			tidyTime: nullable(clock("02:00"), { default: "02:00", description: 'a time of day such as "02:00", or null for no tidy' }),
			tidyEveryDays: count(1),
		}),
	),
	compaction: section(
		obj({
			// The share of the model's context window at which older messages start to be summarized.
			at: num({ exclusiveMinimum: 0, exclusiveMaximum: 1, default: 0.5 }),
		}),
	),
	timezone: text({ default: Intl.DateTimeFormat().resolvedOptions().timeZone }),
	caldav: opt(
		obj({
			url: text(),
			username: text(),
			// By display name on the server. The name is part of the IDs the tools hand out, as `<calendar>/<file>`.
			calendars: named(obj({ kind: oneOf(["events", "todos"]), description: opt(text()) }), "^[^/]+$", { minProperties: 1 }),
		}),
	),
	weather: opt(obj({ areaCode: str({ pattern: "^\\d{6}$", description: "the JMA forecast-area code, such as 130010 for Tokyo Region" }) })),
	browser: opt(obj({ executablePath: opt(text()), idleMinutes: count(10) })),
	web: opt(obj({ maxChars: count(15_000) })),
	// The name becomes part of tool names, which allow only these characters.
	mcp: named(McpServer, NAME, { default: {} }),
	voice: opt(
		obj({
			stt: section(
				obj({
					server: text({ default: PARTS.whisperServer }),
					model: text({ default: PARTS.model }),
					vadModel: text({ default: PARTS.vadModel }),
					threads: count(6),
					beamSize: count(5),
					language: text({ default: "ja" }),
					// The default 30 ms made the model invent words in trailing silence.
					vadSpeechPadMs: amount(0),
					// The recognizer holds about a gigabyte of memory.
					idleMinutes: count(10),
				}),
			),
			tts: opt(obj({ url: text({ default: "http://127.0.0.1:50021" }), speaker: amount(2), maxChars: count(400) })),
			call: opt(
				obj({
					maxChars: count(300),
					chime: flag(true),
					// Defaults live in `VadConfig::default` in `gateway/src/audio.rs`; TS validates ranges only.
					vad: opt(
						obj({
							threshold: opt(num({ exclusiveMinimum: 0, exclusiveMaximum: 1 })),
							startMs: opt(int({ minimum: 1 })),
							endSilenceMs: opt(int({ minimum: 1 })),
							maxMs: opt(int({ minimum: 1 })),
							preRollMs: opt(int({ minimum: 0 })),
						}),
					),
				}),
			),
		}),
	),
	proactive: opt(
		obj({
			roomId: text(),
			briefTime: clock("06:00"),
			// Each one reads the whole conversation, so each costs about as much as a message.
			checkTimes: arr(clock("12:00"), { default: ["12:00", "18:00"] }),
			windowStart: clock("06:00"),
			windowEnd: clock("21:00"),
			tickMinutes: count(15),
			eventLeadMinutes: count(120),
			dueLeadDays: arr(int({ minimum: 0 }), { default: [3, 1] }),
		}),
	),
});

export type Config = Omit<Static<typeof ConfigSchema>, "weather"> & { readonly baseDir: string; readonly weather?: ForecastArea };
export type Persona = Static<typeof Persona>;
export type McpServerConfig = Static<typeof McpServer>;
export type ModelRef = { readonly provider: string; readonly modelId: string };

const validator = compile(ConfigSchema);

function fail(message: string): never {
	throw new Error(`config: ${message}`);
}

type SchemaNode = { readonly [keyword: string]: unknown };

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** pi-schema leaves `default` as an annotation, so the defaults are filled in here before the value is checked. */
function withDefaults(schema: SchemaNode, value: unknown): unknown {
	if (!isRecord(value)) return value;
	const properties = (schema.properties ?? {}) as Record<string, SchemaNode>;
	const rest = isRecord(schema.additionalProperties) ? schema.additionalProperties : undefined;
	const out: Record<string, unknown> = { ...value };
	for (const [key, property] of Object.entries(properties)) if (out[key] === undefined && "default" in property) out[key] = property.default;
	for (const [key, item] of Object.entries(out)) {
		const inner = properties[key] ?? rest;
		if (inner !== undefined) out[key] = withDefaults(inner, item);
	}
	return out;
}

function explain(error: ValidationError): string {
	const keys = error.path.split("/").slice(1).map((key) => key.replaceAll("~1", "/").replaceAll("~0", "~"));
	let node: SchemaNode | undefined = ConfigSchema;
	for (const key of keys) {
		const properties = node?.properties as Record<string, SchemaNode> | undefined;
		node = properties?.[key] ?? (isRecord(node?.additionalProperties) ? node.additionalProperties : undefined) ?? (node?.items as SchemaNode | undefined);
	}
	const hint = typeof node?.description === "string" ? ` (${node.description})` : "";
	return `${keys.join(".") || "the config"}: ${error.message}${hint}`;
}

export function parseConfig(raw: unknown, baseDir: string): Config {
	// A persona given as a string is the path of its soul.
	const personas = isRecord(raw) && isRecord(raw.personas) ? Object.fromEntries(Object.entries(raw.personas).map(([name, item]) => [name, typeof item === "string" ? { soul: item } : item])) : undefined;
	const result = validator.validate(withDefaults(ConfigSchema, isRecord(raw) && personas !== undefined ? { ...raw, personas } : raw));
	if (!result.ok) fail(result.errors.map(explain).join("; "));
	const config = result.value;

	if (!isTimeZone(config.timezone)) fail(`timezone "${config.timezone}" is not a known time zone`);
	for (const name of [config.defaultPersona, ...Object.values(config.rooms)]) {
		if (!(name in config.personas)) fail(`persona "${name}" is used but not defined in personas`);
	}
	if (config.voice?.call !== undefined && config.voice.tts === undefined) fail("voice.call needs voice.tts: the bot speaks in calls");
	if (config.proactive !== undefined && config.proactive.windowEnd <= config.proactive.windowStart) fail("proactive.windowEnd must be later than proactive.windowStart");

	const { weather, ...rest } = config;
	const defaultArea = weather === undefined ? undefined : forecastArea(weather.areaCode) ?? fail(`weather.areaCode: unknown forecast area "${weather.areaCode}"`);
	const stt = config.voice?.stt;
	return {
		...rest,
		...(defaultArea === undefined ? {} : { weather: defaultArea }),
		baseDir,
		dataDir: resolve(baseDir, config.dataDir),
		gatewayBin: resolve(baseDir, config.gatewayBin),
		...(config.voice === undefined || stt === undefined
			? {}
			: { voice: { ...config.voice, stt: { ...stt, server: resolve(baseDir, stt.server), model: resolve(baseDir, stt.model), vadModel: resolve(baseDir, stt.vadModel) } } }),
	};
}

export function loadConfig(path: string): Config {
	const file = resolve(path);
	return parseConfig(JSON.parse(readFileSync(file, "utf8")), dirname(file));
}

/** Only the first slash splits, since OpenRouter's model IDs have one of their own. */
export function modelRef(model: string): ModelRef {
	const slash = model.indexOf("/");
	return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
}

export function personaFor(config: Config, roomId: string): string {
	return config.rooms[roomId] ?? config.defaultPersona;
}

export function modelFor(config: Config, name: string): ModelRef {
	return modelRef(persona(config, name).model ?? config.model);
}

export function thinkingFor(config: Config, name: string): Config["thinking"] {
	return persona(config, name).thinking ?? config.thinking;
}

export function persona(config: Config, name: string): Persona {
	return config.personas[name] ?? fail(`persona "${name}" is not defined`);
}

/** Read at each use so an edit applies without a restart. */
export function readSoul(config: Config, name: string): string {
	return readFileSync(resolve(config.baseDir, persona(config, name).soul), "utf8").trim();
}

export function usedModels(config: Config): ModelRef[] {
	return [config.model, ...Object.values(config.personas).flatMap((persona) => (persona.model === undefined ? [] : [persona.model]))].map(modelRef);
}
