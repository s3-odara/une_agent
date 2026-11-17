import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { answerOf } from "./answer.ts";
import type { ModelRef } from "./config.ts";
import { type MemoryPersona, type MemoryScope, type MemoryStore, withoutTag } from "./memory.ts";

export type TidyOptions = {
	readonly harness: Harness;
	readonly store: MemoryStore;
	/** Every persona; those with a memo of their own get it tidied too. */
	readonly personas: readonly MemoryPersona[];
	readonly model: ModelRef;
	readonly context: Context;
	readonly log?: (message: string) => void;
};

/** What a tidy did to one list. */
export type TidyChange = { readonly label: string; readonly removed: readonly string[]; readonly added: readonly string[] };

const INSTRUCTIONS = [
	"あなたは長期記憶の整理係です。入力は、アシスタントが会話中に書きためた箇条書きの記憶です。次の規則で整理した箇条書きだけを返してください。",
	"",
	"- 重複や言い換えは1項目にまとめる。",
	"- 冗長な項目は、意味を変えずに短くする。",
	"- その場限りの話、既に終わったこと、今後の会話で役に立たないことは消す。",
	"- 問題のない項目は、末尾の日付も含めて一字一句そのまま残す。迷ったら残す。",
	"- 新しい情報を足さない。推測で補わない。",
	"- 予定やタスクそのものは記憶ではなくカレンダーで管理するので消す。",
	"- 各行は「- 」で始める。それ以外の文は書かない。残す項目が無ければ「（なし）」とだけ書く。",
].join("\n");

/** The targets of a tidy: the shared list, then each private memo. */
function targets(personas: readonly MemoryPersona[]): { label: string; scope: MemoryScope; persona: MemoryPersona }[] {
	const first = personas[0] ?? { name: "shared", privateMemory: false };
	return [
		{ label: "shared", scope: "shared", persona: first },
		...personas.flatMap((persona) => (persona.privateMemory ? [{ label: `persona-${persona.name}`, scope: "private" as const, persona }] : [])),
	];
}

/** Changes whenever any memory list changes: lets the scheduler skip a tidy when nothing was written since the last. */
export function memoryFingerprint(store: MemoryStore, personas: readonly MemoryPersona[]): string {
	const hash = createHash("sha256");
	for (const target of targets(personas)) hash.update(JSON.stringify([target.label, store.entries(target.scope, target.persona)]));
	return hash.digest("hex");
}

function size(entries: readonly string[]): number {
	return [...entries.join("\n")].length;
}

/** The entries of a model's answer, or `undefined` when it is not the list that was asked for. */
function parseList(text: string): string[] | undefined {
	const lines = text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
	if (lines.length === 1 && /^（なし）$|^\(なし\)$/.test(lines[0] ?? "")) return [];
	const entries = lines.flatMap((line) => (/^[-*]\s+/.test(line) ? [line.replace(/^[-*]\s+/, "").trim()] : []));
	return entries.length === lines.length && entries.length > 0 ? entries : undefined;
}

/**
 * Has the model go over each memory list once and replaces the list with the result, keeping the old file under
 * `history/`. Memory written during conversations tends to be wordy and to keep what did not need keeping; this is the
 * second look.
 *
 * The model's answer is not trusted further than it has to be: it must be a plain list, it must not be longer than
 * what it replaces, and an entry it returned unchanged keeps its original date. Anything else leaves the list as it
 * was. Each list is its own conversation, with no tools and no memory section.
 */
export async function tidyMemory(options: TidyOptions, date: string): Promise<TidyChange[]> {
	const { harness, store, context } = options;
	const log = options.log ?? ((message) => console.error(message));
	const changes: TidyChange[] = [];

	for (const target of targets(options.personas)) {
		const before = store.entries(target.scope, target.persona);
		if (before.length === 0) continue;
		try {
			const conversation = await harness.createConversation(
				{ ownership: { kind: "ownerless" }, agent: { model: options.model, extensions: [], instructions: INSTRUCTIONS } },
				context,
			);
			const submission = await conversation.submit({ type: "input", content: before.map((entry) => `- ${entry}`).join("\n") }, context);
			const answer = await answerOf(harness, await submission.wait(context), context);
			if (!answer.ok) {
				log(`memory tidy of ${target.label}: no answer (${answer.reason})`);
				continue;
			}
			const listed = parseList(answer.text);
			if (listed === undefined) {
				log(`memory tidy of ${target.label}: the answer was not a list; left as it was`);
				continue;
			}
			// An entry returned as it was, with or without its date, is the old entry.
			const kept = new Map(before.map((entry) => [withoutTag(entry), entry]));
			const after = [...new Set(listed.map((entry) => kept.get(withoutTag(entry)) ?? withoutTag(entry)))];
			if (size(after) > size(before)) {
				log(`memory tidy of ${target.label}: the answer was longer than the list; left as it was`);
				continue;
			}
			if (after.length === before.length && after.every((entry, index) => entry === before[index])) continue;

			store.rewrite(target.scope, target.persona, after, date, `${target.label}-${date}`);
			// Read back: the store dated the entries that are new.
			const stored = store.entries(target.scope, target.persona);
			changes.push({
				label: target.label,
				removed: before.filter((entry) => !stored.includes(entry)),
				added: stored.filter((entry) => !before.includes(entry)),
			});
		} catch (error) {
			log(`memory tidy of ${target.label} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return changes;
}

/** A report of a tidy a person can check at a glance. */
export function formatTidy(changes: readonly TidyChange[]): string {
	const blocks = changes.map((change) =>
		[
			`記憶（${change.label}）を整理しました。`,
			...change.removed.map((entry) => `− ${entry}`),
			...change.added.map((entry) => `＋ ${entry}`),
		].join("\n"),
	);
	return `${blocks.join("\n\n")}\n\n元のファイルは data/memory/history/ に残してあります。`;
}
