import type { Context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { createRegistry, Harness, type Registry } from "@earendil-works/pi-durable";

type HarnessOptions = Parameters<typeof Harness.open>[1];
type Storage = Parameters<typeof Harness.open>[0];
type Extension = Parameters<ReturnType<typeof createRegistry>["install"]>[0];

/** The Anthropic provider reads `ANTHROPIC_API_KEY`. */
export function createAgentModels(): HarnessOptions["models"] {
	const models = createModels();
	models.setProvider(anthropicProvider());
	return models;
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
			identity: { attribution: null },
			onReport: (report) => console.error(`harness report: ${report.kind}`, report.error),
		},
		context,
	);
}
