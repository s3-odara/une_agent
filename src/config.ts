import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

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
	readonly model: { readonly provider: string; readonly modelId: string };
	/** Persona name → path of its SOUL file. */
	readonly personas: Readonly<Record<string, string>>;
	readonly defaultPersona: string;
	/** Room ID → persona name. Rooms not listed use `defaultPersona`. */
	readonly rooms: Readonly<Record<string, string>>;
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

export function parseConfig(raw: unknown, baseDir: string): Config {
	if (typeof raw !== "object" || raw === null) fail("must be a JSON object");
	const root = raw as Record<string, unknown>;
	const matrix = (root.matrix ?? fail("matrix is required")) as Record<string, unknown>;
	const model = (root.model ?? fail("model is required")) as Record<string, unknown>;
	const allowed = matrix.allowedUsers;
	if (!Array.isArray(allowed) || allowed.length === 0) fail("matrix.allowedUsers must list at least one user ID");

	const personas = stringMap(root.personas, "personas");
	const rooms = stringMap(root.rooms, "rooms");
	const defaultPersona = str(root.defaultPersona ?? "default", "defaultPersona");
	for (const name of [defaultPersona, ...Object.values(rooms)]) {
		if (!(name in personas)) fail(`persona "${name}" is used but not defined in personas`);
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
		model: { provider: str(model.provider, "model.provider"), modelId: str(model.modelId, "model.modelId") },
		personas,
		defaultPersona,
		rooms,
	};
}

export function loadConfig(path: string): Config {
	const file = resolve(path);
	return parseConfig(JSON.parse(readFileSync(file, "utf8")), dirname(file));
}

export function personaFor(config: Config, roomId: string): string {
	return config.rooms[roomId] ?? config.defaultPersona;
}

/** The SOUL text of a persona, read at each use so an edit applies without a restart. */
export function readPersona(config: Config, name: string): string {
	const path = config.personas[name];
	if (path === undefined) fail(`persona "${name}" is not defined`);
	return readFileSync(resolve(config.baseDir, path), "utf8").trim();
}
