import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "./config.ts";
import { writeFileAtomic } from "./files.ts";
import { createAgentModels } from "./harness.ts";

const provider = process.argv[2] ?? "openai-codex";
const configPath = process.env.AGENT_CONFIG;
if (!configPath) throw new Error("use `just model-login` or set AGENT_CONFIG to the configuration file");
const config = loadConfig(configPath);
mkdirSync(config.dataDir, { recursive: true });
const models = createAgentModels(config.dataDir);
if (models.getProvider(provider)?.auth.oauth === undefined) {
	console.error(
		`usage: just model-login [provider]; providers with OAuth: ${models
			.getProviders()
			.filter((item) => item.auth.oauth !== undefined)
			.map((item) => item.id)
			.join(", ")}. Set API keys in ~/.config/agent/env.`,
	);
	process.exit(2);
}

// OpenAI is told which installation logs in; a new ID on every login would look like a new machine each time.
const deviceIdPath = join(config.dataDir, "device-id");
const getDeviceId = () => {
	if (!existsSync(deviceIdPath)) writeFileAtomic(deviceIdPath, randomUUID(), 0o600);
	return readFileSync(deviceIdPath, "utf8").trim();
};

const rl = createInterface({ input: process.stdin, output: process.stdout });
const abort = new AbortController();
rl.once("close", () => abort.abort(new Error("login cancelled")));
try {
	await models.login(
		provider,
		"oauth",
		{
			signal: abort.signal,
			prompt: async (prompt) => {
				if (prompt.type === "secret") throw new Error("secret input is not supported by this login command");
				if (prompt.type !== "select")
					return rl.question(`${prompt.message}${prompt.placeholder ? ` (${prompt.placeholder})` : ""}: `);
				console.log(prompt.message);
				prompt.options.forEach((option, index) => console.log(`  ${index + 1}. ${option.label}`));
				const chosen = prompt.options[Number(await rl.question("number: ")) - 1];
				if (chosen === undefined) throw new Error("no such option");
				return chosen.id;
			},
			notify: (event) => {
				if (event.type === "auth_url")
					console.log(`\nOpen in a browser:\n${event.url}${event.instructions ? `\n${event.instructions}` : ""}`);
				else if (event.type === "device_code")
					console.log(`\nOpen ${event.verificationUri} and enter ${event.userCode}`);
				else console.log(event.message);
			},
		},
		{ getDeviceId },
	);
	console.log(`logged in to ${provider}; stored in ${join(config.dataDir, "auth.json")}`);
} catch (error) {
	console.error(error instanceof Error ? error.message : "login failed");
	process.exitCode = 1;
} finally {
	rl.close();
}
