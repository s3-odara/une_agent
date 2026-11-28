import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { calculateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { contentText } from "@earendil-works/pi-ai/utils/text";
import {
	AgentDoc,
	type CompactionSettings,
	CompactionTask,
	type ContextView,
	type Conversation,
	DEFAULT_COMPACTION_POLICY,
	defineExtension,
	GenerationTask,
	type Harness,
	type HookApi,
	hook,
	LiveDoc,
	ProviderDoc,
} from "@earendil-works/pi-durable";
import { isRecord, type ModelRef } from "./config.ts";
import { errorMessage } from "./errors.ts";
import type { HostDb } from "./hostdb.ts";

/**
 * The APIs whose server compacts a conversation into an opaque item of its own (OpenAI's Responses compaction), which
 * keeps more of the conversation than a summary in words.
 */
const NATIVE_APIS: ReadonlySet<string> = new Set(["openai-codex-responses", "openai-responses"]);

/** Matches pi-durable's `<summary>` wrapper around a native compaction placeholder to extract its DB key. */
const NATIVE_SUMMARY = /<summary>\n[\s\S]*?\[native:([0-9a-f-]+)\]\n<\/summary>/;

const nativePlaceholder = (id: string) =>
	`（この時点より前の会話はネイティブ圧縮されており、モデル変更後は参照できません）\n[native:${id}]`;

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
	readonly prepare?: (messages: readonly Message[]) => readonly Message[];
	readonly log?: (message: string) => void;
};

/**
 * Compaction writes the summary itself so it keeps what this agent needs (such as upcoming matters for later checks).
 * On APIs that support native server compaction, only native compaction runs to avoid paying for a duplicate uncached
 * summary; the text summary is used only as a fallback when native compaction fails.
 */
export function createCompactionExtension(options: CompactionOptions) {
	const { db } = options;
	const log = options.log ?? ((message: string) => console.error(message));

	/** Parsed once: an item never changes once stored, and every request of a compacted conversation looks it up. */
	const items = new Map<string, { readonly model: string; readonly item: unknown } | undefined>();
	const stored = (id: string) => {
		if (!items.has(id)) items.set(id, db.nativeCompaction(id));
		return items.get(id);
	};

	const withNativeItems = (model: Model<Api>, input: readonly unknown[]): unknown[] | undefined => {
		let changed = false;
		const swapped = input.map((item) => {
			if (!isRecord(item) || item.role !== "user" || !Array.isArray(item.content)) return item;
			const id = item.content
				.flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [NATIVE_SUMMARY.exec(part.text)?.[1]] : []))
				.find((found) => found !== undefined);
			const native = id === undefined ? undefined : stored(id);
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
			{ messages: [...(options.prepare?.(messages) ?? messages)] },
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

	const storeNative = (model: Model<Api>, item: unknown): string => {
		const id = randomUUID();
		const entry = { model: modelKey(model), item };
		db.addNativeCompaction(id, entry.model, entry.item);
		items.set(id, entry);
		return nativePlaceholder(id);
	};

	const compact = async (
		model: Model<Api>,
		messages: readonly Message[],
		api: HookApi,
		context: Context,
	): Promise<string | undefined> => {
		if (NATIVE_APIS.has(model.api)) {
			const native = await compactNatively(model, messages, api, context).catch((error) => {
				log(`native compaction failed, falling back to summary: ${errorMessage(error)}`);
				return undefined;
			});
			if (native !== undefined) return storeNative(model, native);
		}
		return summarize(model, messages, api, context).catch((error) => {
			log(`compaction summary failed, using the default one: ${errorMessage(error)}`);
			return undefined;
		});
	};

	return defineExtension({
		name: "compaction",
		hooks: [
			hook(CompactionTask, {
				beforeCompact: async (compaction, api, context) => {
					// A rerun after a crash places what the first run made, rather than asking the model again.
					const made = await api.memo<string>("summary", context);
					if (made !== undefined) return { kind: "summary", summary: made };
					const ref = (await api.snapshot(AgentDoc, api.conversationId, context))?.model;
					const model = ref === undefined ? undefined : api.models.getModel(ref.provider, ref.modelId);
					if (model === undefined) return undefined;
					const summary = await compact(model, compaction.messages, api, context);
					if (summary === undefined) return undefined;
					return { kind: "summary", summary: await api.memo("summary", summary, context) };
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

type ConversationId = Conversation["id"];

export function compactionSettings(models: Models, refs: readonly ModelRef[], maxTokens: number): CompactionSettings {
	const { reserveTokens, backgroundTokens } = DEFAULT_COMPACTION_POLICY;
	const overrides = refs.flatMap(({ provider, modelId }) => {
		const window = models.getModel(provider, modelId)?.contextWindow;
		if (window === undefined) return [];
		// pi-durable treats backgroundTokens: 0 as disabled, so only override when starting earlier than its default.
		const desired = window - reserveTokens - maxTokens;
		return desired > backgroundTokens ? [[`${provider}/${modelId}`, { backgroundTokens: desired }] as const] : [];
	});
	return { modelOverrides: Object.fromEntries(overrides) };
}

function estimateContextTokens(view: ContextView): number {
	let measured: Extract<Message, { role: "assistant" }> | undefined;
	const after = view.head?.id ?? Number.NEGATIVE_INFINITY;
	for (let index = view.entries.length - 1; index >= 0 && measured === undefined; index--) {
		if (Number(view.entries[index]!.id) <= Number(after)) continue;
		measured = view.contributions[index]!.findLast(
			(message): message is Extract<Message, { role: "assistant" }> =>
				message.role === "assistant" && calculateContextTokens(message.usage) > 0,
		);
	}
	const from = measured === undefined ? 0 : view.messages.lastIndexOf(measured) + 1;
	let tokens = measured === undefined ? 0 : calculateContextTokens(measured.usage);
	for (const message of view.messages.slice(from)) tokens += estimateMessageTokens(message);
	return tokens;
}

export type IdleCompactorOptions = {
	readonly harness: Harness;
	readonly db: HostDb;
	readonly context: Context;
	readonly idleMinutes: number;
	readonly idleTokens: number;
	readonly now?: () => number;
	readonly log?: (message: string) => void;
};

export function createIdleCompactor(options: IdleCompactorOptions): () => Promise<void> {
	const { harness, db, context, idleMinutes, idleTokens } = options;
	const now = options.now ?? Date.now;
	const log = options.log ?? ((message: string) => console.error(message));
	// Avoid retrying every tick when the newest messages alone exceed `idleTokens` and nothing can be cut.
	const tried = new Map<number, number>();

	return async () => {
		const idleMs = idleMinutes * 60_000;
		await Promise.all(
			db.roomConversations().map(async (conversationId) => {
				if (db.hasOpenWakeFrom(conversationId)) return;
				const id = conversationId as unknown as ConversationId;
				const live = await harness.snapshot(LiveDoc, id, context);
				if (live?.run !== undefined || (live?.compactions ?? []).length > 0) return;
				const conversation = await harness.conversation(id, context);
				if (conversation === undefined) return;
				const view = await conversation.context(context);
				const latest = view.entries.at(-1);
				const last = view.messages.at(-1);
				if (latest === undefined || last === undefined) return;
				const latestId = Number(latest.id);
				if (tried.get(conversationId) === latestId) return;
				if (now() - last.timestamp < idleMs) return;
				if (estimateContextTokens(view) < idleTokens) return;
				try {
					const settled = await harness.waitForTask(await conversation.compact(undefined, context), context);
					const outcome = settled.state.outcome;
					if (outcome?.status === "completed") tried.set(conversationId, latestId);
					else if (outcome?.status === "failed")
						log(`idle compaction of conversation ${conversationId} failed: ${outcome.error.message}`);
				} catch (error) {
					log(`idle compaction of conversation ${conversationId} failed: ${errorMessage(error)}`);
				}
			}),
		);
	};
}
