import type { Context } from "@earendil-works/chord/context";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, type Conversation, type EntryId, type EntryRecord, type LiveState, ToolResultEntry, UserEntry } from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME, type CodemodeToolDetails } from "@earendil-works/pi-durable/codemode";
import type { Settled, Submission } from "./answer.ts";
import { errorMessage } from "./errors.ts";
import { oneLine, onCharacter } from "./text.ts";

export const TOOL_RUNNING = "⏳";
export const TOOL_DONE = "✅";
export const TOOL_FAILED = "❌";
const TOOL_STOPPED = "⏹";

/** An edit carries the body twice (fallback and new content) and Matrix caps an event at 64 KiB. */
const MAX_CHARS = 3000;
const MAX_ARGS_CHARS = 80;
const MAX_ERROR_CHARS = 100;

/** A call a script made; `error` only when it failed. */
type Nested = { readonly name: string; readonly args: string; readonly status: string; readonly error?: string };
type Result = { readonly isError: boolean; readonly text: string; readonly nested: readonly Nested[] };
type Results = ReadonlyMap<string, Result>;

function resultsOf(entries: readonly EntryRecord[]): Results {
	const results = new Map<string, Result>();
	for (const entry of entries) {
		const message = ToolResultEntry.is(entry) ? (entry.model?.[0] as ToolResultMessage | undefined) : undefined;
		if (message === undefined) continue;
		const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
		const calls = message.toolName === CODEMODE_TOOL_NAME ? ((message.details as CodemodeToolDetails | undefined)?.calls ?? []) : [];
		const nested = calls.map(
			(call): Nested =>
				call.status === "error"
					? { name: call.name, args: call.args, status: TOOL_FAILED, error: call.error ?? "" }
					: { name: call.name, args: call.args, status: call.status === "ok" ? TOOL_DONE : TOOL_STOPPED },
		);
		results.set(message.toolCallId, { isError: message.isError, text, nested });
	}
	return results;
}

function clipped(text: string, max: number): string {
	const line = oneLine(text);
	return line.length > max ? `${line.slice(0, onCharacter(line, max))}…` : line;
}

function thinkingBlock(thinking: string, redacted: boolean): string {
	const text = redacted ? "（非公開）" : thinking.trim();
	if (text === "") return "";
	return text
		.split("\n")
		.map((line, i) => `> ${i === 0 ? "💭 " : ""}${line}`)
		.join("\n");
}

function line(indent: string, status: string, name: string, args: string, error: string | undefined): string {
	return `${indent}- ${status} ${name} \`${clipped(args, MAX_ARGS_CHARS).replaceAll("`", "'")}\`${error === undefined ? "" : ` ${clipped(error, MAX_ERROR_CHARS)}`}`;
}

/** What a script's calls are doing while it runs, from the live state; once it settles, its result lists them. */
function liveNested(callId: string, live: LiveState | undefined): Nested[] {
	return (live?.nestedTools ?? [])
		.filter((slot) => slot.parentCallId === callId)
		.map((slot): Nested => {
			const args = JSON.stringify(slot.arguments);
			if (slot.summary === undefined) return { name: slot.name, args, status: TOOL_RUNNING };
			return slot.summary.isError ? { name: slot.name, args, status: TOOL_FAILED, error: slot.summary.error ?? "" } : { name: slot.name, args, status: TOOL_DONE };
		});
}

function toolLine(call: ToolCall, results: Results, live: LiveState | undefined): string {
	const running = live?.run !== undefined;
	const result = results.get(call.id);
	const status = result === undefined ? (running ? TOOL_RUNNING : TOOL_STOPPED) : result.isError ? TOOL_FAILED : TOOL_DONE;
	const nested = result?.nested ?? liveNested(call.id, live);
	return [
		line("", status, call.name, JSON.stringify(call.arguments), result?.isError === true ? result.text : undefined),
		...nested.map((inner) => line("  ", inner.status, inner.name, inner.args, inner.error)),
	].join("\n");
}

/** What a stream has written so far, up to its last full line or sentence, so a half-written word or Markdown is not shown. */
function settledPart(text: string): string {
	return text.match(/^[\s\S]*(?:[\n。．！？]|[.!?] )/)?.[0] ?? "";
}

/**
 * The steps of one run so far: thinking, what the model said before calling tools, and each tool call with how it
 * went. The final answer's text is left out, since it is sent as a message of its own.
 */
export function renderProgress(entries: readonly EntryRecord[], live: LiveState | undefined): string {
	const results = resultsOf(entries);
	const blocks: string[] = [];

	for (const entry of entries) {
		const message = AssistantEntry.is(entry) ? (entry.model?.[0] as AssistantMessage | undefined) : undefined;
		if (message === undefined) continue;
		const calls = message.content.filter((block) => block.type === "toolCall");
		for (const block of message.content) {
			if (block.type === "thinking") blocks.push(thinkingBlock(block.thinking, block.redacted === true));
			else if (block.type === "text" && calls.length > 0) blocks.push(block.text.trim());
		}
		blocks.push(calls.map((call) => toolLine(call, results, live)).join("\n"));
	}
	// Tool calls show once their answer is an entry; until then their arguments may be half written.
	for (const block of (live?.generation?.message as AssistantMessage | undefined)?.content ?? []) {
		if (block.type === "thinking") blocks.push(thinkingBlock(settledPart(block.thinking), block.redacted === true));
		else if (block.type === "text") blocks.push(settledPart(block.text).trim());
	}
	const retry = live?.generation?.retry;
	if (retry !== undefined) blocks.push(`⚠️ モデルの呼び出しに失敗しました。再試行します（${clipped(retry.error, MAX_ERROR_CHARS)}）`);
	if ((live?.compactions ?? []).length > 0) blocks.push("🗜 これまでの会話を要約しています");

	const body = blocks.filter((block) => block !== "").join("\n\n");
	if (body.length <= MAX_CHARS) return body;
	const tail = body.slice(onCharacter(body, body.length - MAX_CHARS));
	const cut = tail.indexOf("\n\n");
	return `…\n\n${cut < 0 ? tail : tail.slice(cut + 2)}`;
}

export type ProgressOptions = {
	readonly conversation: Conversation;
	readonly submission: Submission;
	readonly send: (body: string, replaces: string | undefined) => Promise<string>;
	readonly intervalMs: number;
	readonly context: Context;
	readonly log: (message: string) => void;
};

/**
 * Shows a run's steps as one notice, which is edited as the run goes on. Notices do not notify, so the user is only
 * notified of the answer. Best effort: a notice that cannot be sent is logged and the answer goes ahead.
 */
export class ProgressReport {
	readonly #options: ProgressOptions;
	#watch: Awaited<ReturnType<Conversation["watch"]>> | undefined;
	#live: LiveState | undefined;
	#entry: EntryId | undefined;
	/** Read once each, since entries never change. */
	readonly #entries: EntryRecord[] = [];
	/** Another input's run took ours in; that input's report shows it. */
	#shared = false;
	#eventId: string | undefined;
	#shown = "";
	#lastSentAt = Number.NEGATIVE_INFINITY;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#flight: Promise<void> | undefined;
	#dirty = false;
	#finished = false;

	constructor(options: ProgressOptions) {
		this.#options = options;
	}

	async start(): Promise<void> {
		this.#watch = await this.#options.conversation.watch(this.#options.context, { min: 1 });
		this.#observe(this.#watch.value.docs);
		this.#watch.start(async (call) => {
			if (call.kind === "value") this.#observe(call.value.docs);
		});
	}

	#observe(docs: Readonly<Record<string, unknown>>): void {
		if (this.#finished) return;
		const live = docs["pi.live"] as LiveState | undefined;
		const id = Number(this.#options.submission.id);
		const inputs = (live?.run?.inputs ?? []).map(Number);
		if (!inputs.includes(id)) return;
		if (inputs[0] !== id) this.#shared = true;
		this.#live = live;
		this.#dirty = true;
		this.#kick();
	}

	#kick(): void {
		if (this.#flight !== undefined || this.#timer !== undefined || !this.#dirty || this.#finished) return;
		const wait = this.#lastSentAt + this.#options.intervalMs - Date.now();
		if (wait > 0) {
			this.#timer = setTimeout(() => {
				this.#timer = undefined;
				this.#kick();
			}, wait);
			return;
		}
		this.#dirty = false;
		this.#flight = this.#update(this.#live).finally(() => {
			this.#flight = undefined;
			this.#kick();
		});
	}

	/** Shows the run as it ended. Waits for a notice being sent, so the progress never lands after the answer. */
	async finish(settled: Settled): Promise<void> {
		this.#finished = true;
		clearTimeout(this.#timer);
		await this.#watch?.stop();
		await this.#flight;
		await this.#update(undefined, settled);
	}

	async #update(live: LiveState | undefined, settled?: Settled): Promise<void> {
		try {
			await this.#show(await this.#render(live, settled));
		} catch (error) {
			this.#options.log(`showing the progress failed: ${errorMessage(error)}`);
		}
	}

	async #render(live: LiveState | undefined, settled: Settled | undefined): Promise<string> {
		if (this.#shared) return "";
		const { conversation, submission, context } = this.#options;
		if (this.#entry === undefined) {
			const record = settled ?? (await submission.status(context));
			if (record.type !== "input" || record.entry === undefined) return "";
			this.#entry = record.entry;
		}
		const from = this.#entries.at(-1)?.id ?? this.#entry;
		const page = await conversation.entries({ minEntryId: from, order: "ascending" }, 1000, undefined, context);
		this.#entries.push(...page.items.filter((entry) => entry.id > from));

		const answer = settled?.type === "input" && settled.status === "done" ? settled.answer : undefined;
		let entries = answer === undefined ? this.#entries : this.#entries.filter((entry) => entry.id <= answer);
		if (settled !== undefined && answer === undefined) {
			// A run that ended without an answer has no bound; the next input's entry is where it stopped.
			const next = entries.findIndex((entry) => UserEntry.is(entry));
			if (next >= 0) entries = entries.slice(0, next);
		}
		return renderProgress(entries, live);
	}

	async #show(body: string): Promise<void> {
		if (body === "" || body === this.#shown) return;
		const eventId = await this.#options.send(body, this.#eventId);
		this.#eventId ??= eventId;
		this.#shown = body;
		this.#lastSentAt = Date.now();
	}
}
