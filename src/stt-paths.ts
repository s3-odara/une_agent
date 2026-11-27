import { join } from "node:path";

export function sttModelPaths(sourceModels = "stt/models") {
	const packaged = process.env.AGENT_STT_MODELS;
	return packaged === undefined
		? {
				model: join(sourceModels, "ggml-large-v3-turbo-q8_0.bin"),
				vadModel: join(sourceModels, "ggml-silero-v5.1.2.bin"),
			}
		: { model: join(packaged, "whisper.bin"), vadModel: join(packaged, "vad.bin") };
}
