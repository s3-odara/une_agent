import type { Decision, HostDb } from "./hostdb.ts";

/** The answers, as a reaction to the request and as a command. */
export const CHOICES: readonly { readonly decision: Decision; readonly emoji: string; readonly command: string; readonly label: string }[] = [
	{ decision: "approve", emoji: "✅", command: "!approve", label: "今回だけ許可" },
	{ decision: "approve_session", emoji: "🔁", command: "!approve_session", label: "この依頼の間は許可" },
	{ decision: "approve_always", emoji: "♾️", command: "!approve_always", label: "今後は確認しない" },
	{ decision: "reject", emoji: "❌", command: "!reject", label: "拒否" },
];

/** What came of asking. `approved` is false for a reject, a message instead of an answer, and no answer in time. */
export type Outcome =
	| { readonly approved: true; readonly by: Decision | "rule" | "run" }
	| { readonly approved: false; readonly reason: "rejected" | "message" | "timeout" };

export type ApprovalRequest = {
	/** Stable across reruns of the same tool call, so a crash does not ask twice. */
	readonly id: string;
	readonly roomId: string;
	/** The run the call is in; `approve_session` covers the same tool for the rest of it. */
	readonly runKey: string;
	readonly tool: string;
	/** What the user is asked to allow, in their words. */
	readonly summary: string;
};

export type ApprovalsOptions = {
	readonly db: HostDb;
	/** Sends a notice under a transaction ID (the same ID sends nothing new) and resolves with its event ID. */
	readonly notice: (roomId: string, txnId: string, body: string) => Promise<string>;
	readonly react: (roomId: string, txnId: string, eventId: string, key: string) => Promise<void>;
	readonly now?: () => number;
	/** An unanswered request is rejected after this long. */
	readonly timeoutMs?: number;
	readonly log?: (message: string) => void;
};

/**
 * Tool calls that need the user's yes. The call posts a request to the room and waits for a decision: a reaction to the
 * request, a `!approve`-style command, or, as a no, any other message from the user, which then goes to the model as
 * usual. The decision is the user's, read by code; the model is only told what came of it.
 *
 * Requests and decisions are in the host database, so a call rerun after a crash finds its decision, or waits again for
 * the same request.
 */
export class Approvals {
	readonly #options: ApprovalsOptions;
	readonly #now: () => number;
	readonly #timeoutMs: number;
	readonly #log: (message: string) => void;
	readonly #waiting = new Map<string, Set<() => void>>();

	constructor(options: ApprovalsOptions) {
		this.#options = options;
		this.#now = options.now ?? Date.now;
		this.#timeoutMs = options.timeoutMs ?? 86_400_000;
		this.#log = options.log ?? ((message) => console.error(message));
	}

	async ask(request: ApprovalRequest): Promise<Outcome> {
		const { db } = this.#options;
		if (db.alwaysApproved().includes(request.tool)) return { approved: true, by: "rule" };
		if (db.approvedForRun(request.runKey, request.tool)) return { approved: true, by: "run" };
		db.addApproval({ ...request, createdAt: this.#now() });
		const row = db.approval(request.id);
		if (row === undefined) throw new Error(`approval ${request.id} was not stored`);
		if (row.decision === undefined) {
			const decided = this.#decided(request.id);
			try {
				await this.#post(request);
				const left = row.createdAt + this.#timeoutMs - this.#now();
				let timer: NodeJS.Timeout | undefined;
				const timeout = new Promise<void>((resolve) => {
					timer = setTimeout(() => {
						this.#decide(request.id, "reject", "timeout");
						resolve();
					}, Math.max(0, left));
				});
				await Promise.race([decided.promise, timeout]);
				clearTimeout(timer);
			} finally {
				decided.cancel();
			}
		}
		return outcome(db.approval(request.id));
	}

	/** Resolves once the request is decided; registered before anything can decide it. */
	#decided(id: string): { promise: Promise<void>; cancel: () => void } {
		let wake: () => void = () => {};
		const promise = new Promise<void>((resolve) => {
			wake = resolve;
		});
		const set = this.#waiting.get(id) ?? new Set();
		set.add(wake);
		this.#waiting.set(id, set);
		// Decided between the read and the registration.
		if (this.#options.db.approval(id)?.decision !== undefined) wake();
		return {
			promise,
			cancel: () => {
				set.delete(wake);
				if (set.size === 0) this.#waiting.delete(id);
			},
		};
	}

	/** Posts the request and the four reactions to press. Repeats send nothing new (transaction IDs). */
	async #post(request: ApprovalRequest): Promise<void> {
		const { db, notice, react } = this.#options;
		const body = [
			`承認が必要です: ${request.summary}`,
			CHOICES.map((choice) => `${choice.emoji} ${choice.label}`).join(" / "),
			`（${CHOICES.map((choice) => choice.command).join(" / ")} でも答えられます。ほかの発言を送ると拒否になります）`,
		].join("\n");
		const eventId = await notice(request.roomId, `approval:${request.id}`, body);
		db.setApprovalPrompt(request.id, eventId);
		for (const [i, choice] of CHOICES.entries()) {
			await react(request.roomId, `approval:${request.id}:${i}`, eventId, choice.emoji).catch((error) =>
				this.#log(`reacting to approval ${request.id} failed: ${error instanceof Error ? error.message : error}`),
			);
		}
	}

	#decide(id: string, decision: Decision, reason?: string): boolean {
		const { db } = this.#options;
		if (!db.decideApproval(id, decision, reason)) return false;
		const row = db.approval(id);
		if (decision === "approve_always" && row !== undefined) db.setAlwaysApproved(row.tool, true, this.#now());
		for (const wake of this.#waiting.get(id) ?? []) wake();
		return true;
	}

	/** A reaction from an allowed user. Only one to a request, with one of its four emoji, counts. */
	onReaction(roomId: string, relatesTo: string, key: string): void {
		const row = this.#options.db.approvalByPrompt(roomId, relatesTo);
		const choice = CHOICES.find((choice) => normalizeEmoji(choice.emoji) === normalizeEmoji(key));
		if (row !== undefined && choice !== undefined) this.#decide(row.id, choice.decision);
	}

	/**
	 * A text message from the user, before it goes to the model. A command is answered here and not passed on (the
	 * returned text is the reply); any other message rejects what is waiting in the room and is passed on.
	 */
	onMessage(roomId: string, body: string): { readonly handled: false } | { readonly handled: true; readonly reply: string } {
		const { db } = this.#options;
		const text = body.trim();
		const [command, ...args] = text.split(/\s+/);
		const choice = CHOICES.find((choice) => choice.command === command);
		if (choice !== undefined) {
			// The oldest is what the user is looking at first.
			const row = db.undecidedApprovals(roomId)[0];
			if (row === undefined) return { handled: true, reply: "承認待ちはありません。" };
			this.#decide(row.id, choice.decision);
			return { handled: true, reply: `${choice.label}: ${row.summary}` };
		}
		if (command === "!approvals") {
			const tools = db.alwaysApproved();
			const waiting = db.undecidedApprovals(roomId).map((row) => `- ${row.summary}`);
			return {
				handled: true,
				reply: [
					`確認しないツール: ${tools.length === 0 ? "なし" : tools.join(", ")}`,
					...(waiting.length === 0 ? [] : ["承認待ち:", ...waiting]),
					"（!revoke ツール名 で確認するように戻せます）",
				].join("\n"),
			};
		}
		if (command === "!revoke") {
			const tool = args[0];
			if (tool === undefined) return { handled: true, reply: "!revoke の後にツール名を書いてください（!approvals で一覧）。" };
			return { handled: true, reply: db.setAlwaysApproved(tool, false, this.#now()) ? `${tool} は今後また確認します。` : `${tool} は確認しない設定になっていません。` };
		}
		this.interrupt(roomId);
		return { handled: false };
	}

	/** The user said something else instead of answering: what waits in the room is a no. */
	interrupt(roomId: string): void {
		for (const row of this.#options.db.undecidedApprovals(roomId)) this.#decide(row.id, "reject", "message");
	}
}

/** Clients differ in whether they send the emoji variation selector. */
function normalizeEmoji(key: string): string {
	return key.replace(/️/g, "");
}

function outcome(row: ReturnType<HostDb["approval"]>): Outcome {
	const decision = row?.decision;
	if (decision === undefined || decision === "reject") {
		return { approved: false, reason: row?.reason === "message" ? "message" : row?.reason === "timeout" ? "timeout" : "rejected" };
	}
	return { approved: true, by: decision };
}

/** What the model is told when a call was not allowed. */
export function refusal(outcome: Extract<Outcome, { approved: false }>): string {
	switch (outcome.reason) {
		case "rejected":
			return "ユーザーが拒否しました。実行していません。";
		case "message":
			return "ユーザーは承認せず、別の発言を送りました。実行していません。この依頼はここで短く締めてください。その発言はこの後に届きます。";
		case "timeout":
			return "承認の返事が無いまま期限が過ぎました。実行していません。";
	}
}
