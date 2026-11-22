import { createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export function sakuraProvider() {
	const id = "sakura";
	const baseUrl = "https://api.ai.sakura.ad.jp/v1";
	return createProvider({
		id,
		name: "さくらのAI Engine",
		baseUrl,
		auth: { apiKey: envApiKeyAuth("Sakura AI Engine account token", ["SAKURA_AI_ENGINE_API_KEY"]) },
		api: openAICompletionsApi(),
		models: [{
			id: "preview/GLM-5.3-Flash",
			name: "GLM-5.3-Flash (Sakura preview)",
			api: "openai-completions",
			provider: id,
			baseUrl,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_048_575,
			maxTokens: 32_000,
			compat: { maxTokensField: "max_tokens", supportsStore: false, supportsReasoningEffort: false },
		}],
	});
}
