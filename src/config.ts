import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { CalendarConfig } from "./calendar.ts";
import { isTimeZone, parseClock } from "./time.ts";

export type Config = {
	/** Directory of the config file; relative paths in it resolve against this. */
	readonly baseDir: string;
	readonly dataDir: string;
	readonly gatewayBin: string;
	readonly matrix: {
		readonly homeserver: string;
		readonly userId: string;
		readonly deviceName: string;
		/** Only these users can invite the bot and talk to it. */
		readonly allowedUsers: readonly string[];
	};
	/** The model of every persona that does not name its own. */
	readonly model: ModelRef;
	readonly personas: Readonly<Record<string, Persona>>;
	readonly defaultPersona: string;
	/** Room ID → persona name. Rooms not listed use `defaultPersona`. */
	readonly rooms: Readonly<Record<string, string>>;
	readonly memory: {
		/** Upper bounds of the memory files, in characters. Memory is always shown in full, so it has to stay small. */
		readonly sharedLimit: number;
		readonly privateLimit: number;
		/** When the daily tidy of memory runs, minutes since midnight; `undefined` turns it off. */
		readonly tidyAt?: number;
		/** Days between tidies. */
		readonly tidyEveryDays: number;
	};
	/** The zone the user lives in: what "today" and "06:00" mean. */
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
		/** Which of the office's areas to read, counted from 0. */
		readonly areaIndex: number;
	};
	/** Messages the agent sends on its own. Without it the agent only answers. */
	readonly proactive?: {
		/** The room they go to; they are written by that room's persona, in that room's conversation. */
		readonly roomId: string;
		/** Minutes since midnight. */
		readonly briefAt: number;
		/** Reminders are only sent between these, minutes since midnight. */
		readonly windowStart: number;
		readonly windowEnd: number;
		readonly tickMinutes: number;
		/** How long before a timed event its reminder is sent. */
		readonly eventLeadMinutes: number;
		/** How many days before a task's due date its reminders are sent. */
		readonly dueLeadDays: readonly number[];
	};
};

export type ModelRef = { readonly provider: string; readonly modelId: string };

/**
 * A persona is three separate choices, so changing one never forks the others: how it talks (`soul`), what it
 * remembers (shared memory always, plus a memo of its own with `privateMemory`), and what it runs with (`model`,
 * inherited from the base config unless set).
 */
export type Persona = {
	/** Path of the SOUL file: the persona's tone. */
	readonly soul: string;
	readonly privateMemory: boolean;
	readonly model?: ModelRef;
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

function modelRef(value: unknown, name: string): ModelRef {
	if (typeof value !== "object" || value === null) fail(`${name} must be an object`);
	const model = value as Record<string, unknown>;
	return { provider: str(model.provider, `${name}.provider`), modelId: str(model.modelId, `${name}.modelId`) };
}

function limit(value: unknown, fallback: number, name: string): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) fail(`${name} must be a positive integer`);
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

/** A persona is its SOUL path alone, or an object that also sets `privateMemory` or `model`. */
function personas(value: unknown): Record<string, Persona> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) fail("personas must be an object");
	const out: Record<string, Persona> = {};
	for (const [name, item] of Object.entries(value)) {
		// The name becomes a file name (`memory/persona/<name>.md`).
		if (!/^[A-Za-z0-9_-]+$/.test(name)) fail(`persona name "${name}" may only contain letters, digits, "_" and "-"`);
		if (typeof item === "string") {
			out[name] = { soul: str(item, `personas.${name}`), privateMemory: false };
			continue;
		}
		if (typeof item !== "object" || item === null) fail(`personas.${name} must be a path or an object`);
		const persona = item as Record<string, unknown>;
		if (persona.privateMemory !== undefined && typeof persona.privateMemory !== "boolean") {
			fail(`personas.${name}.privateMemory must be true or false`);
		}
		out[name] = {
			soul: str(persona.soul, `personas.${name}.soul`),
			privateMemory: persona.privateMemory === true,
			...(persona.model === undefined ? {} : { model: modelRef(persona.model, `personas.${name}.model`) }),
		};
	}
	return out;
}

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
		gatewayBin: resolve(baseDir, str(root.gatewayBin ?? "gateway/target/release/matrix-gateway", "gatewayBin")),
		matrix: {
			homeserver: str(matrix.homeserver, "matrix.homeserver"),
			userId: str(matrix.userId, "matrix.userId"),
			deviceName: str(matrix.deviceName ?? "agent", "matrix.deviceName"),
			allowedUsers: allowed.map((user, i) => str(user, `matrix.allowedUsers[${i}]`)),
		},
		model: modelRef(root.model ?? fail("model is required"), "model"),
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
	};
}

export function loadConfig(path: string): Config {
	const file = resolve(path);
	return parseConfig(JSON.parse(readFileSync(file, "utf8")), dirname(file));
}

export function personaFor(config: Config, roomId: string): string {
	return config.rooms[roomId] ?? config.defaultPersona;
}

export function persona(config: Config, name: string): Persona {
	return config.personas[name] ?? fail(`persona "${name}" is not defined`);
}

/** The SOUL text of a persona, read at each use so an edit applies without a restart. */
export function readSoul(config: Config, name: string): string {
	return readFileSync(resolve(config.baseDir, persona(config, name).soul), "utf8").trim();
}
