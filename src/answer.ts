import type { Context } from "@earendil-works/chord/context";
import { AssistantEntry, type Harness } from "@earendil-works/pi-durable";

export type Submission = NonNullable<Awaited<ReturnType<Harness["submission"]>>>;
export type Settled = Awaited<ReturnType<Submission["wait"]>>;

/** `empty` is a run that ended without a word: an answer of no text, or a tool that ended the run. */
export type Answer = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string; readonly stopped: boolean; readonly empty: boolean };

export async function answerOf(harness: Harness, settled: Settled, context: Context): Promise<Answer> {
	if (settled.status !== "done" || settled.type !== "input") {
		const reason = settled.status === "unanswered" ? settled.reason : "no answer";
		const detail = settled.status === "unanswered" && typeof settled.detail === "string" ? `: ${settled.detail}` : "";
		return { ok: false, reason: `${reason}${detail}`, stopped: reason === "aborted" || reason === "reset", empty: false };
	}
	const entry = await harness.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
	const text = (entry?.model ?? [])
		.flatMap((message) => (message.role === "assistant" ? message.content : []))
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("\n\n")
		.trim();
	return text === "" ? { ok: false, reason: "empty answer", stopped: false, empty: true } : { ok: true, text };
}
