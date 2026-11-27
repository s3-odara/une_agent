import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import { contentText } from "@earendil-works/pi-ai/utils/text";
import {
	AgentDoc,
	CompactionTask,
	defineExtension,
	GenerationTask,
	type HookApi,
	hook,
	ProviderDoc,
} from "@earendil-works/pi-durable";
import { isRecord } from "./config.ts";
import { errorMessage } from "./errors.ts";
import type { HostDb } from "./hostdb.ts";

/**
 * The APIs whose server compacts a conversation into an opaque item of its own (OpenAI's Responses compaction), which
 * keeps more of the conversation than a summary in words.
 */
const NATIVE_APIS: ReadonlySet<string> = new Set(["openai-codex-responses", "openai-responses"]);

/**
 * How pi-durable puts a summary before the model. The summary is found by it, and its stored item by a hash of it, so
 * nothing is added to the summary that a model would read or copy into the next one. Should pi-durable change it, the
 * summary in words is sent as it is.
 */
const SUMMARY = /<summary>\n([\s\S]*)\n<\/summary>/;

const hashOf = (summary: string) => createHash("sha256").update(summary).digest("hex");

const SUMMARY_SYSTEM = "あなたは会話の要約係です。会話を続けずに、指示された形の要約だけを書いてください。";

export const SUMMARY_PROMPT = [
	"上の会話を、この会話の続きを担当するアシスタントのために要約する。次の見出しで、それぞれ箇条書きにする。",
	"",
	"## ユーザーについて分かったこと",
	"## 続いている事柄（決めたこと、進めている作業。途中の作業は、どこまで済んで次に何をするか）",
	"## あとで聞くとよさそうなこと（会話に出た用事の予定や結果、ユーザーが気にしていたこと。日時が分かれば書く）",
	"## 直近のやり取り",
	"",
	"- 会話に無いことは書かない。各発言の先頭の [日時] を手がかりに、いつのことかを書く。",
	"- 前の要約があれば、その内容を引き継いでまとめ直す。",
	"- パスワード、確認コード、API キーなどの秘密は書かない。",
].join("\n");

const TOOL_RESULT_CHARS = 2_000;

function textOf(content: Message["content"]): string {
	const calls =
		typeof content === "string"
			? []
			: content.flatMap((block) =>
					block.type === "toolCall" ? [`（ツール ${block.name} を呼んだ: ${JSON.stringify(block.arguments)}）`] : [],
				);
	return [contentText(content), ...calls].filter((part) => part !== "").join("\n");
}

/** As a transcript to read, so the summarizer does not take it for a conversation to continue. */
function transcript(messages: readonly Message[]): string {
	return messages
		.flatMap((message) => {
			if (message.role === "user") return [`[ユーザー]\n${textOf(message.content)}`];
			if (message.role === "assistant") return [`[アシスタント]\n${textOf(message.content)}`];
			if (message.role === "toolResult")
				return [`[ツールの結果 ${message.toolName}]\n${textOf(message.content).slice(0, TOOL_RESULT_CHARS)}`];
			return [];
		})
		.join("\n\n");
}

const modelKey = (model: Model<Api>) => `${model.provider}/${model.id}`;

export type CompactionOptions = {
	readonly db: HostDb;
	readonly log?: (message: string) => void;
};

/**
 * Compaction writes the summary itself, so it keeps what this agent needs: what the user said they would do and how it
 * went is what a check follows up later. With a model whose server compacts natively, the opaque item it makes is kept
 * too and sent in the summary's place while the conversation stays on that model; on any other model the summary in
 * words stands.
 */
export function createCompactionExtension(options: CompactionOptions) {
	const { db } = options;
	const log = options.log ?? ((message: string) => console.error(message));

	/** Parsed once: an item never changes once stored, and every request of a compacted conversation looks it up. */
	const items = new Map<string, { readonly model: string; readonly item: unknown } | undefined>();
	const stored = (hash: string) => {
		if (!items.has(hash)) items.set(hash, db.nativeCompaction(hash));
		return items.get(hash);
	};

	/** The summary messages that have a native item for this model, swapped for it. */
	const withNativeItems = (model: Model<Api>, input: readonly unknown[]): unknown[] | undefined => {
		let changed = false;
		const swapped = input.map((item) => {
			if (!isRecord(item) || item.role !== "user" || !Array.isArray(item.content)) return item;
			const summary = item.content
				.flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [SUMMARY.exec(part.text)?.[1]] : []))
				.find((found) => found !== undefined);
			const native = summary === undefined ? undefined : stored(hashOf(summary));
			if (native === undefined || native.model !== modelKey(model)) return item;
			changed = true;
			return native.item;
		});
		return changed ? swapped : undefined;
	};

	const summarize = async (
		model: Model<Api>,
		messages: readonly Message[],
		api: HookApi,
		context: Context,
	): Promise<string> => {
		const answer = await api.models.completeSimple(
			model,
			{
				systemPrompt: SUMMARY_SYSTEM,
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: `<conversation>\n${transcript(messages)}\n</conversation>\n\n${SUMMARY_PROMPT}` },
						],
						timestamp: Date.now(),
					},
				],
			},
			{ signal: context.abortSignal },
		);
		const text = answer.content
			.flatMap((block) => (block.type === "text" ? [block.text] : []))
			.join("\n")
			.trim();
		if (answer.stopReason !== "stop" || text === "")
			throw new Error(answer.errorMessage ?? `the summary ended with ${answer.stopReason}`);
		return text;
	};

	/** The conversation as the model is given it, with a request to compact it at the end; the server answers with one item. */
	const compactNatively = async (
		model: Model<Api>,
		messages: readonly Message[],
		api: HookApi,
		context: Context,
	): Promise<unknown> => {
		const sessionId = (await api.snapshot(ProviderDoc, api.conversationId, context))?.sessionId;
		let compaction: unknown;
		await api.models.completeSimple(
			model,
			{ messages: [...messages] },
			{
				signal: context.abortSignal,
				...(sessionId === undefined ? {} : { sessionId }),
				onPayload: (payload) => {
					if (!isRecord(payload) || !Array.isArray(payload.input)) return undefined;
					// An earlier compaction is in the messages as its summary; the server is given its own item for it.
					return {
						...payload,
						input: [...(withNativeItems(model, payload.input) ?? payload.input), { type: "compaction_trigger" }],
					};
				},
				onProviderStreamEvent: (event) => {
					if (
						isRecord(event) &&
						event.type === "response.output_item.done" &&
						isRecord(event.item) &&
						event.item.type === "compaction"
					)
						compaction = event.item;
				},
			},
		);
		if (compaction === undefined) throw new Error("the server returned no compaction item");
		return compaction;
	};

	return defineExtension({
		name: "compaction",
		hooks: [
			hook(CompactionTask, {
				beforeCompact: async (compaction, api, context) => {
					// A rerun after a crash places what the first run made, rather than asking the model again.
					const made = await api.memo<string>("summary", context);
					if (made !== undefined) return { summary: made };
					const ref = (await api.snapshot(AgentDoc, api.conversationId, context))?.model;
					const model = ref === undefined ? undefined : api.models.getModel(ref.provider, ref.modelId);
					if (model === undefined) return undefined;

					const [summary, native] = await Promise.all([
						summarize(model, compaction.messages, api, context).catch((error) => {
							log(`compaction summary failed, using the default one: ${errorMessage(error)}`);
							return undefined;
						}),
						NATIVE_APIS.has(model.api)
							? compactNatively(model, compaction.messages, api, context).catch((error) => {
									log(`native compaction failed, using the summary alone: ${errorMessage(error)}`);
									return undefined;
								})
							: undefined,
					]);
					if (summary === undefined) return undefined;
					if (native !== undefined) db.addNativeCompaction(hashOf(summary), modelKey(model), native);
					return { summary: await api.memo("summary", summary, context) };
				},
			}),
			hook(GenerationTask, {
				beforeProviderRequest: ({ model, payload }) => {
					if (!NATIVE_APIS.has(model.api) || !isRecord(payload) || !Array.isArray(payload.input)) return undefined;
					const input = withNativeItems(model, payload.input);
					return input === undefined ? undefined : { payload: { ...payload, input } };
				},
			}),
		],
	});
}
