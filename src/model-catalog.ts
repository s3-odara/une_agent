import type { AnyModel, ModelsStore, ModelsStoreEntry, Provider } from "@earendil-works/pi-ai";
import { getModelType } from "@earendil-works/pi-ai/models";
import { formatUserAgent, getClientVersion } from "@earendil-works/pi-ai/utils/identity";
import { readJsonObject, writeFileAtomic } from "./files.ts";

export const CATALOG_URL = "https://pi.dev/api/models/providers/";

function byTypeAndId(baseline: readonly AnyModel[], newer: readonly AnyModel[]): AnyModel[] {
	const merged = new Map<string, AnyModel>();
	for (const model of [...baseline, ...newer]) merged.set(`${getModelType(model)}\0${model.id}`, model);
	return [...merged.values()];
}

/**
 * The catalog built into pi-ai is fixed at its release; pi itself overlays the one pi.dev keeps current, and this does
 * the same. pi.dev filters the catalog by the client version in the User-Agent, so pi-ai's own is sent: a model whose API
 * this pi-ai cannot speak is not offered.
 */
export function withRemoteCatalog(provider: Provider): Provider {
	// Prefer a provider's own model discovery over the public catalog.
	if (provider.refreshModels !== undefined) return provider;
	const builtin = provider.getAllModels?.() ?? provider.getModels();
	let all: readonly AnyModel[] = builtin;
	let chat = provider.getModels();
	const use = (newer: readonly AnyModel[]) => {
		all = byTypeAndId(builtin, newer);
		chat = all.filter((model) => getModelType(model) === "chat") as typeof chat;
	};
	return {
		...provider,
		getModels: () => chat,
		getAllModels: () => all,
		// The catalog is public: no token is refreshed just to read it.
		refreshModelsAuth: "configured",
		refreshModels: async (context) => {
			if (!(await context.publish({ update: () => use(context.stored?.models ?? []) })) || !context.allowNetwork) return;
			const response = await fetch(`${CATALOG_URL}${encodeURIComponent(provider.id)}?types=chat,image,classifier`, {
				headers: { accept: "application/json", "user-agent": formatUserAgent({ userAgent: "detailed" }) },
				signal: context.signal,
			});
			if (!response.ok) throw new Error(`model catalog of ${provider.id}: HTTP ${response.status}`);
			const body: unknown = await response.json();
			if (!Array.isArray(body)) throw new Error(`the model catalog of ${provider.id} is not a list`);
			const models = body.filter((entry) => typeof entry?.id === "string").map((model) => ({ ...model, provider: provider.id }) as AnyModel);
			await context.publish({ persist: { models, checkedAt: Date.now() }, update: () => use(models) });
		},
	};
}

/**
 * Keeps the last catalog, so a start without network still knows the newer models. A catalog saved under another pi-ai
 * version is dropped: pi.dev chose it for that version, and the built-in catalog of a newer pi-ai is the better one.
 */
export class FileModelsStore implements ModelsStore {
	readonly #path: string;

	constructor(path: string) {
		this.#path = path;
	}

	#read(): Record<string, ModelsStoreEntry> {
		const file = readJsonObject(this.#path);
		return file.piAi === getClientVersion() ? (file.providers as Record<string, ModelsStoreEntry>) : {};
	}

	#write(providers: Record<string, ModelsStoreEntry>): void {
		writeFileAtomic(this.#path, JSON.stringify({ piAi: getClientVersion(), providers }));
	}

	async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
		return this.#read()[providerId];
	}

	// Synchronous between read and write, so two providers saving at once do not lose either.
	async write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
		this.#write({ ...this.#read(), [providerId]: entry });
	}

	async delete(providerId: string): Promise<void> {
		const { [providerId]: _gone, ...rest } = this.#read();
		this.#write(rest);
	}
}
