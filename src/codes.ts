import type { Handled, MessageHandler } from "./rooms.ts";

/** What came of asking for a code. */
export type CodeOutcome =
	| { readonly ok: true; readonly code: string }
	/** `message`: the user said something else instead; `timeout`: nothing came in time; `aborted`: the run was stopped. */
	| { readonly ok: false; readonly reason: "message" | "timeout" | "aborted" };

export type CodeRequestsOptions = {
	/** Sends a notice under a transaction ID and resolves with its event ID. */
	readonly notice: (roomId: string, txnId: string, body: string) => Promise<string>;
	/** A request with no code for this long ends. */
	readonly timeoutMs?: number;
};

/** What counts as a code without being a reply to the request: one word of letters, digits and hyphens. */
const CODE = /^[A-Za-z0-9-]{4,12}$/;

type Pending = { promptEventId?: string; readonly settle: (outcome: CodeOutcome) => void };

/**
 * One-time codes from the user, for a login that asks for one (an authenticator app, a mail, a text message). A tool
 * asks with a notice in the room and waits; the user's next message is the code when it replies to the notice, or
 * when it is one word of letters, digits and hyphens. The code goes to whoever asked and not into the conversation.
 * Any other message ends the request, and goes to the model as usual.
 *
 * Kept in memory only: a request does not outlive the process, and neither does the browser page it is for.
 */
export class CodeRequests implements MessageHandler {
	readonly #options: CodeRequestsOptions;
	readonly #timeoutMs: number;
	readonly #pending = new Map<string, Pending>();

	constructor(options: CodeRequestsOptions) {
		this.#options = options;
		this.#timeoutMs = options.timeoutMs ?? 5 * 60_000;
	}

	/** Asks the room for a code and resolves with it, or with why there is none. `key` names the request. */
	ask(roomId: string, key: string, what: string, signal?: AbortSignal): Promise<CodeOutcome> {
		// Only one request per room: the newest is what the user is looking at.
		this.#pending.get(roomId)?.settle({ ok: false, reason: "message" });
		const { promise, resolve } = Promise.withResolvers<CodeOutcome>();
		const pending: Pending = { settle: resolve };
		this.#pending.set(roomId, pending);
		const ended = AbortSignal.any([AbortSignal.timeout(this.#timeoutMs), ...(signal === undefined ? [] : [signal])]);
		const end = () => resolve({ ok: false, reason: signal?.aborted === true ? "aborted" : "timeout" });
		if (ended.aborted) end();
		else ended.addEventListener("abort", end, { once: true });
		const body = `${what}\nこの発言に返信してコードを送ってください（英数字とハイフンだけの発言でも受け付けます）。ほかの発言を送ると中止します。`;
		this.#options.notice(roomId, `code:${key}`, body).then(
			(eventId) => (pending.promptEventId = eventId),
			// Without the notice the user does not know to send anything.
			() => resolve({ ok: false, reason: "aborted" }),
		);
		return promise.finally(() => {
			ended.removeEventListener("abort", end);
			if (this.#pending.get(roomId) === pending) this.#pending.delete(roomId);
		});
	}

	onMessage(message: { readonly roomId: string; readonly body: string; readonly replyTo?: string }): Handled {
		const pending = this.#pending.get(message.roomId);
		if (pending === undefined) return { handled: false };
		const text = message.body.trim();
		const reply = message.replyTo !== undefined && message.replyTo === pending.promptEventId;
		if ((reply && text !== "") || CODE.test(text)) {
			// Codes shown in groups ("123 456") are typed without the spaces.
			pending.settle({ ok: true, code: text.replace(/\s+/g, "") });
			return { handled: true };
		}
		pending.settle({ ok: false, reason: "message" });
		return { handled: false };
	}

	/** The user sent a voice message instead: what waits in the room ends. */
	interrupt(roomId: string): void {
		this.#pending.get(roomId)?.settle({ ok: false, reason: "message" });
	}
}

/** What the model is told when no code came. */
export function noCode(reason: Extract<CodeOutcome, { ok: false }>["reason"]): string {
	switch (reason) {
		case "message":
			return "ユーザーはコードを送らず、別の発言を送りました。コードは入力していません。この件はここで短く締めてください。その発言はこの後に届きます。";
		case "timeout":
			return "コードが届かないまま期限が過ぎました。コードは入力していません。";
		case "aborted":
			return "コードを待つのを中止しました。コードは入力していません。";
	}
}
