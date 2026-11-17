import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { obj, oneOf, str } from "@earendil-works/pi-schema";

export type MemoryScope = "shared" | "private";

/** Who a conversation speaks as, as far as memory is concerned. */
export type MemoryPersona = { readonly name: string; readonly privateMemory: boolean };

export type MemoryLimits = { readonly shared: number; readonly private: number };

/** A refused change. Its message is written for the model, which is expected to act on it. */
export class MemoryError extends Error {}

/** `(2026-11-17)` at the end of an entry: when it was written, so a reader can tell how stale it may be. */
const TAG = / \(\d{4}-\d{2}-\d{2}\)$/;

export function withoutTag(entry: string): string {
	return entry.replace(TAG, "");
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function render(entries: readonly string[]): string {
	return entries.map((entry) => `- ${entry}`).join("\n");
}

function size(entries: readonly string[]): number {
	return [...render(entries)].length;
}

/**
 * Long-term memory as plain Markdown lists a person can read and edit: `shared.md`, which every persona reads, and
 * `persona/<name>.md` for the personas that keep a memo of their own.
 *
 * Every change is safe to repeat (adding what is there, replacing what is already replaced, and removing what is gone
 * all succeed without changing anything), so the tools over it may rerun after a crash. File access is synchronous:
 * a read-modify-write cannot interleave with another one in the same process.
 */
export class MemoryStore {
	readonly #dir: string;
	readonly #limits: MemoryLimits;

	constructor(dir: string, limits: MemoryLimits) {
		this.#dir = dir;
		this.#limits = limits;
	}

	#path(scope: MemoryScope, persona: MemoryPersona): string {
		if (scope === "shared") return join(this.#dir, "shared.md");
		if (!persona.privateMemory) {
			throw new MemoryError(`人格「${persona.name}」は private の記憶を持っていません。scope は shared を使ってください。`);
		}
		return join(this.#dir, "persona", `${persona.name}.md`);
	}

	entries(scope: MemoryScope, persona: MemoryPersona): string[] {
		let text: string;
		try {
			text = readFileSync(this.#path(scope, persona), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		// Lenient on purpose: a person may have edited the file by hand.
		return text
			.split("\n")
			.map((line) => line.replace(/^\s*[-*]\s+/, "").trim())
			.filter((line) => line !== "");
	}

	#write(scope: MemoryScope, persona: MemoryPersona, entries: readonly string[]): void {
		const limit = this.#limits[scope];
		const over = size(entries) - limit;
		if (over > 0) {
			throw new MemoryError(
				`${scope} の記憶の上限 ${limit} 文字を ${over} 文字超えます。memory_replace で既存の項目をまとめるか、memory_remove で不要な項目を消してからやり直してください。`,
			);
		}
		const path = this.#path(scope, persona);
		mkdirSync(dirname(path), { recursive: true });
		// Renamed into place, so a crash leaves the old file or the new one.
		writeFileSync(`${path}.tmp`, entries.length === 0 ? "" : `${render(entries)}\n`);
		renameSync(`${path}.tmp`, path);
	}

	/** The one entry containing `match`. */
	#find(entries: readonly string[], match: string): number | "none" {
		const needle = oneLine(match);
		if (needle === "") throw new MemoryError("match が空です。");
		const hits = entries.flatMap((entry, index) => (entry.includes(needle) ? [index] : []));
		if (hits.length > 1) {
			const listed = hits.map((index) => `- ${entries[index]}`).join("\n");
			throw new MemoryError(`「${needle}」は複数の項目に当てはまります。1つに絞れる文言にしてください。\n${listed}`);
		}
		return hits[0] ?? "none";
	}

	add(scope: MemoryScope, persona: MemoryPersona, text: string, date: string): string {
		const entry = oneLine(text);
		if (entry === "") throw new MemoryError("text が空です。");
		const entries = this.entries(scope, persona);
		if (entries.some((existing) => withoutTag(existing) === entry)) return "同じ項目が既にあります。";
		this.#write(scope, persona, [...entries, `${entry} (${date})`]);
		return "記憶しました。";
	}

	replace(scope: MemoryScope, persona: MemoryPersona, match: string, text: string, date: string): string {
		const entry = oneLine(text);
		if (entry === "") throw new MemoryError("text が空です。");
		const entries = this.entries(scope, persona);
		const index = this.#find(entries, match);
		if (index === "none") {
			if (entries.some((existing) => withoutTag(existing) === entry)) return "既に書き換え済みです。";
			throw new MemoryError(`「${oneLine(match)}」を含む項目が ${scope} にありません。`);
		}
		entries[index] = `${entry} (${date})`;
		this.#write(scope, persona, entries);
		return "書き換えました。";
	}

	remove(scope: MemoryScope, persona: MemoryPersona, match: string): string {
		const entries = this.entries(scope, persona);
		const index = this.#find(entries, match);
		if (index === "none") return "該当する項目はありません（削除済みか、文言が違います）。";
		entries.splice(index, 1);
		this.#write(scope, persona, entries);
		return "削除しました。";
	}

	/**
	 * Replaces a whole list, as the tidy does, after copying the file it replaces to `history/<label>.md`. Entries that
	 * carry no date get `date`.
	 */
	rewrite(scope: MemoryScope, persona: MemoryPersona, entries: readonly string[], date: string, label: string): void {
		const path = this.#path(scope, persona);
		if (existsSync(path)) {
			const backup = join(this.#dir, "history", `${label}.md`);
			mkdirSync(dirname(backup), { recursive: true });
			copyFileSync(path, backup);
		}
		this.#write(
			scope,
			persona,
			entries.map(oneLine).filter((entry) => entry !== "").map((entry) => (TAG.test(entry) ? entry : `${entry} (${date})`)),
		);
	}

	/** What a persona sees of memory, with how to use it. Changes only when memory changes, which keeps prompt caches warm. */
	prompt(persona: MemoryPersona): string {
		const block = (scope: MemoryScope, title: string) => {
			const entries = this.entries(scope, persona);
			const body = entries.length === 0 ? "（まだ何もない）" : render(entries);
			return `## ${scope}（${title}、${size(entries)}/${this.#limits[scope]}文字）\n${body}`;
		};
		const lines = [
			"会話をまたいで残る長期記憶。下の内容は常に見えている。memory_add / memory_replace / memory_remove で書き換える。",
			"",
			"- 今後の会話でも役に立つことだけ書く（好み、決めたこと、続いている事柄、繰り返し出る人や物）。その場限りの話は書かない。",
			"- 「ユーザーは〜を希望」のように、どの人格が読んでも分かる中立な文で、1項目1文にする。末尾の（日付）は自動で付く。",
			"- ユーザーが明言したことと自分の推測を区別し、推測には「（推測）」と書く。",
			"- パスワードや API キーなどの秘密は書かない。",
			"- 古くなった項目は書き換えるか消す。同じ内容を重ねて書かない。上限が近づいたら項目をまとめる。",
			persona.privateMemory
				? "- shared は全人格が読む。private はこの人格だけが読む。他の人格にも知っていてほしいことは shared、迷ったら shared。"
				: "- 記憶は全人格で共有される（scope は shared のみ）。",
			"",
			block("shared", "全人格で共有"),
		];
		if (persona.privateMemory) lines.push("", block("private", "この人格だけ"));
		return lines.join("\n");
	}
}

export type MemoryExtensionOptions = {
	readonly store: MemoryStore;
	/** The persona a conversation speaks as; `undefined` for a conversation without one, which then has no memory. */
	readonly personaOf: (conversationId: number) => MemoryPersona | undefined;
};

function localDate(epochMs: number): string {
	// The Swedish locale formats a date as YYYY-MM-DD, in the process's time zone.
	return new Date(epochMs).toLocaleDateString("sv-SE");
}

const scope = oneOf(["shared", "private"], { description: "shared: 全人格が読む。private: この人格だけが読む（持たない人格もある）。" });

/** Memory as a prompt section plus the three tools that change it. All three are safe to rerun after a crash. */
export function createMemoryExtension(options: MemoryExtensionOptions) {
	const { store, personaOf } = options;
	const persona = (conversationId: unknown): MemoryPersona => {
		const found = personaOf(Number(conversationId));
		if (found === undefined) throw new MemoryError("この会話には記憶がありません。");
		return found;
	};
	const done = (text: string) => ({ output: [{ type: "text" as const, text }] });

	return defineExtension({
		name: "memory",
		sections: [
			section("memory", (input) => {
				const found = personaOf(Number(input.conversationId));
				return found === undefined ? undefined : store.prompt(found);
			}),
		],
		tools: [
			defineTool({
				name: "memory_add",
				description: "長期記憶に1項目追加する。今後の会話でも役に立つことだけを、中立な1文で書く。",
				parameters: obj({ scope, text: str({ description: "記憶する内容。1文。", minLength: 1 }) }),
				replay: "safe",
				execute: async (args, api) => done(store.add(args.scope, persona(api.conversationId), args.text, localDate(api.now()))),
			}),
			defineTool({
				name: "memory_replace",
				description: "長期記憶の1項目を書き換える。内容が変わったときや、複数の項目を1つにまとめるときに使う。",
				parameters: obj({
					scope,
					match: str({ description: "書き換える項目に含まれる文言。1項目だけに当てはまること。", minLength: 1 }),
					text: str({ description: "新しい内容。1文。", minLength: 1 }),
				}),
				replay: "safe",
				execute: async (args, api) =>
					done(store.replace(args.scope, persona(api.conversationId), args.match, args.text, localDate(api.now()))),
			}),
			defineTool({
				name: "memory_remove",
				description: "長期記憶から1項目を消す。古くなった、または誤っていた項目に使う。",
				parameters: obj({
					scope,
					match: str({ description: "消す項目に含まれる文言。1項目だけに当てはまること。", minLength: 1 }),
				}),
				replay: "safe",
				execute: async (args, api) => done(store.remove(args.scope, persona(api.conversationId), args.match)),
			}),
		],
	});
}
