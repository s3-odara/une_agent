import type { Context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { createRegistry, Harness } from "@earendil-works/pi-durable";

type HarnessOptions = Parameters<typeof Harness.open>[1];
type Storage = Parameters<typeof Harness.open>[0];

/** Model access for the agent. The Anthropic provider reads `ANTHROPIC_API_KEY`. */
export function createAgentModels(): HarnessOptions["models"] {
	const models = createModels();
	models.setProvider(anthropicProvider());
	return models;
}

/**
 * Opens the agent's Harness. The registry is empty on purpose: a chat bot gets no tools until each one has been sorted
 * into "safe to rerun after a crash" or not.
 */
export function openAgentHarness(storage: Storage, models: HarnessOptions["models"], context: Context): Promise<Harness> {
	return Harness.open(
		storage,
		{
			models,
			registry: createRegistry(),
			identity: { attribution: null },
			onReport: (report) => console.error(`harness report: ${report.kind}`, report.error),
		},
		context,
	);
}
