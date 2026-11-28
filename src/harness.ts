import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { createModels, type Models, type Provider } from "@earendil-works/pi-ai/models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { type CompactionSettings, createRegistry, Harness, type Registry } from "@earendil-works/pi-durable";
import { type Config, loadConfig, type ModelRef, readSoul, usedModels } from "./config.ts";
import { FileCredentialStore } from "./model-auth.ts";
import { FileModelsStore, withRemoteCatalog } from "./model-catalog.ts";
import { sakuraProvider } from "./sakura.ts";

type HarnessOptions = Parameters<typeof Harness.open>[1];
type Storage = Parameters<typeof Harness.open>[0];
type Extension = Parameters<ReturnType<typeof createRegistry>["install"]>[0];

function withVibeModel(provider: Provider): Provider {
	const id = "mistral-vibe-cli-latest";
	const chat = provider.getModels();
	const medium = chat.find((model) => model.id === "mistral-medium-3.5");
	if (medium === undefined || chat.some((model) => model.id === id)) return provider;
	// Vibe uses a different request ID for Medium 3.5. Prefer the catalog's entry once it has one.
	const vibe = { ...medium, id, name: "Mistral Vibe (latest)" };
	return {
		...provider,
		getModels: () => [...chat, vibe],
		getAllModels: () => [...(provider.getAllModels?.() ?? chat), vibe],
	};
}
export function createAgentModels(dataDir: string): Models {
	const models = createModels({
		credentials: new FileCredentialStore(join(dataDir, "auth.json")),
		modelsStore: new FileModelsStore(join(dataDir, "model-catalog.json")),
	});
	for (const provider of builtinProviders()) {
		models.setProvider(withRemoteCatalog(provider.id === "mistral" ? withVibeModel(provider) : provider));
	}
	models.setProvider(sakuraProvider());
	return models;
}

/**
 * At start, rather than as an error on the first message hours later. The start waits on pi.dev only when a configured
 * model is not in the saved catalog; otherwise the catalog is updated in the background for the next start.
 */
export async function prepareModels(models: Models, refs: readonly ModelRef[], timeoutMs = 15_000): Promise<void> {
	const providers = [...new Set(refs.map((ref) => ref.provider))];
	for (const provider of providers) {
		const registration = models.getProvider(provider);
		if (registration === undefined)
			throw new Error(
				`unknown model provider "${provider}" (known: ${models
					.getProviders()
					.map((item) => item.id)
					.join(", ")})`,
			);
		if ((await models.checkAuth(provider)) === undefined) {
			const hint =
				registration.auth.oauth === undefined
					? "configure its credentials in ~/.config/agent/env"
					: `run \`just model-login ${provider}\` or configure its credentials in ~/.config/agent/env`;
			throw new Error(`model provider "${provider}" has no login or API key (${hint})`);
		}
	}
	await models.refresh({ allowNetwork: false, providers });
	const fetch = (signal?: AbortSignal) =>
		models.refresh({ providers, signal }).then(({ errors }) => {
			for (const [provider, error] of errors)
				console.error(`model catalog of ${provider} not updated: ${error.message}`);
		});
	const missing = () => refs.filter(({ provider, modelId }) => models.getModel(provider, modelId) === undefined);
	if (missing().length === 0) return void fetch();
	await fetch(AbortSignal.timeout(timeoutMs));
	const [first] = missing();
	if (first !== undefined) {
		throw new Error(
			`model "${first.modelId}" is not in the catalog of "${first.provider}" (known: ${models
				.getModels(first.provider)
				.map((model) => model.id)
				.join(", ")})`,
		);
	}
}

/** What the agent needs to start, checked up front: every persona's SOUL file and every model the config names. */
export async function openConfig(path: string, models: Models): Promise<Config> {
	const config = loadConfig(path);
	for (const name of Object.keys(config.personas)) readSoul(config, name);
	await prepareModels(models, usedModels(config));
	return config;
}

/**
 * A tool belongs in an extension only once it has been sorted into "safe to rerun after a crash" (`replay: "safe"`)
 * or not: the bot runs unattended.
 */
export function openAgentHarness(
	storage: Storage,
	models: HarnessOptions["models"],
	context: Context,
	options: {
		readonly extensions?: readonly Extension[];
		/** Tests pass a fixed clock. */
		readonly now?: () => number;
		/** For extensions installed later, such as an MCP server's once it answers. */
		readonly registry?: Registry;
		readonly env?: HarnessOptions["env"];
		readonly compaction?: CompactionSettings;
	} = {},
): Promise<Harness> {
	const registry = options.registry ?? createRegistry();
	for (const extension of options.extensions ?? []) registry.install(extension);
	return Harness.open(
		storage,
		{
			models,
			registry,
			now: options.now,
			env: options.env,
			identity: { attribution: null },
			// Messages sent while the agent works join that work, and those sent during one tool round join together.
			settings: {
				steeringMode: "all",
				...(options.compaction === undefined ? {} : { compaction: options.compaction }),
			},
			onReport: (report) => console.error(`harness report: ${report.kind}`, report.error),
		},
		context,
	);
}
