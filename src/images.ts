import type { Message } from "@earendil-works/pi-ai";
import { defineExtension, GenerationTask, hook } from "@earendil-works/pi-durable";

/** What an image that is no longer sent is replaced by. */
export const OMITTED = "（古い画面の画像。省略）";

export type ImageWindowOptions = {
	/** The newest images sent as they are. */
	readonly keep?: number;
	/** Older images are left out this many at a time. */
	readonly batch?: number;
};

/**
 * Every image a tool returned is sent again with every later request until a compaction, though only the newest few are
 * looked at: a puzzle solved in ten clicks would cost ten images at each message after it. The conversation keeps them;
 * only what is sent leaves them out. They are left out a batch at a time, oldest first, so what is sent before the newest
 * images stays the same between batches and the provider's prompt cache holds.
 */
export function createImageWindowExtension(options: ImageWindowOptions = {}) {
	const keep = options.keep ?? 3;
	const batch = options.batch ?? 3;
	return defineExtension({
		name: "image-window",
		hooks: [
			hook(GenerationTask, {
				beforeRequest: ({ messages }) => {
					const total = messages.reduce((count, message) => count + (typeof message.content === "string" ? 0 : message.content.filter((block) => block.type === "image").length), 0);
					const over = total - keep;
					let drop = over - (over % batch);
					if (drop <= 0) return undefined;
					const sent = messages.map((message): Message => {
						if (drop === 0 || typeof message.content === "string" || !message.content.some((block) => block.type === "image")) return message;
						const content = message.content.map((block) => (block.type === "image" && drop > 0 ? (drop--, { type: "text" as const, text: OMITTED }) : block));
						return { ...message, content } as Message;
					});
					return { messages: sent };
				},
			}),
		],
	});
}
