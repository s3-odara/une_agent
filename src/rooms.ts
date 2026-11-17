import type { Context } from "@earendil-works/chord/context";
import { AssistantEntry, type Conversation, type Harness } from "@earendil-works/pi-durable";
import { type Config, persona, personaFor, readSoul } from "./config.ts";
import type { GatewayEvent, GatewayLink } from "./gateway.ts";
import type { Delivery, HostDb } from "./hostdb.ts";

type ConversationId = Conversation["id"];
type SubmissionId = Parameters<Harness["submission"]>[0];
type MessageEvent = Extract<GatewayEvent, { type: "message" }>;

/** pi-durable IDs are branded numbers; the ledger stores the number. */
function idFromNumber<I extends ConversationId | SubmissionId>(value: number): I {
	return value as unknown as I;
}

export type BridgeOptions = {
	readonly harness: Harness;
	readonly db: HostDb;
	readonly link: GatewayLink;
	readonly config: Config;
	readonly context: Context;
	/** Waits between attempts to send one answer; after the last, the answer waits for the next start. */
	readonly sendRetryDelaysMs?: readonly number[];
	/** How long one send waits for the gateway's result before it counts as failed. */
	readonly sendTimeoutMs?: number;
	readonly log?: (message: string) => void;
};

/**
 * Connects Matrix rooms to conversations: one conversation per room, with the room's persona as its instructions.
 *
 * A message is answered exactly once across crashes because every step can be repeated: the gateway resends a message
 * until it is acked, `submit()` with the event ID as `requestId` returns the submission it already made, the ledger row
 * is `INSERT OR IGNORE`, and the answer is sent under a transaction ID derived from the event ID, which the homeserver
 * deduplicates.
 */
export class Bridge {
	readonly #options: BridgeOptions;
	readonly #retryDelays: readonly number[];
	readonly #sendTimeoutMs: number;
	readonly #log: (message: string) => void;
	/** Per room, the tail of its admissions, so two messages never race to create the room's conversation. */
	readonly #admissions = new Map<string, Promise<void>>();
	/** Event IDs whose answer is being awaited or sent. */
	readonly #inFlight = new Map<string, string>();
	readonly #sends = new Map<string, { resolve: (eventId: string) => void; reject: (error: Error) => void }>();
	readonly #work = new Set<Promise<void>>();

	constructor(options: BridgeOptions) {
		this.#options = options;
		this.#retryDelays = options.sendRetryDelaysMs ?? [5_000, 30_000, 120_000];
		this.#sendTimeoutMs = options.sendTimeoutMs ?? 60_000;
		this.#log = options.log ?? ((message) => console.error(message));
	}

	/** Starts listening to the gateway and picks up the answers the last process still owed. */
	start(): void {
		this.#options.link.onEvent((event) => this.#onEvent(event));
		for (const delivery of this.#options.db.pendingDeliveries()) this.#startDelivery(delivery);
	}

	/** Resolves once every admission and delivery started so far has finished. */
	async idle(): Promise<void> {
		while (this.#work.size > 0) await Promise.allSettled([...this.#work]);
	}

	#track(work: Promise<void>): void {
		this.#work.add(work);
		void work.finally(() => this.#work.delete(work));
	}

	#onEvent(event: GatewayEvent): void {
		switch (event.type) {
			case "message": {
				const previous = this.#admissions.get(event.roomId) ?? Promise.resolve();
				const next = previous.then(() => this.#admit(event)).catch((error) => {
					// Not acked, so the gateway offers the message again at its next start.
					this.#log(`admitting ${event.eventId} failed: ${describe(error)}`);
				});
				this.#admissions.set(event.roomId, next);
				this.#track(next);
				return;
			}
			case "undecryptable":
				this.#track(
					this.#send(event.roomId, `utd:${event.eventId}`, "このメッセージを復号できませんでした。もう一度送ってください。", true).then(
						() => {},
						(error) => this.#log(`notice for ${event.eventId} failed: ${describe(error)}`),
					),
				);
				return;
			case "sent":
				this.#sends.get(event.requestId)?.resolve(event.eventId);
				return;
			case "error":
				if (event.requestId === undefined) this.#log(`gateway: ${event.message}`);
				else this.#sends.get(event.requestId)?.reject(new Error(event.message));
				return;
			case "ready":
				this.#log(`gateway ready as ${event.userId} (device ${event.deviceId})`);
				return;
		}
	}

	async #admit(message: MessageEvent): Promise<void> {
		const { db, link, context } = this.#options;
		if (db.isDelivered(message.eventId)) {
			link.send({ type: "ack", eventId: message.eventId });
			return;
		}
		const conversation = await this.#conversationFor(message.roomId);
		const submission = await conversation.submit({ type: "input", content: message.body, requestId: message.eventId }, context);
		const delivery: Delivery = { eventId: message.eventId, roomId: message.roomId, submissionId: Number(submission.id) };
		db.addDelivery(delivery);
		link.send({ type: "ack", eventId: message.eventId });
		this.#startDelivery(delivery);
	}

	async #conversationFor(roomId: string): Promise<Conversation> {
		const { harness, db, config, context } = this.#options;
		const name = personaFor(config, roomId);
		const model = persona(config, name).model ?? config.model;
		const instructions = readSoul(config, name);

		const known = db.conversationOf(roomId);
		const existing = known === undefined ? undefined : await harness.conversation(idFromNumber<ConversationId>(known), context);
		if (existing !== undefined) {
			// The persona file and the model may have changed since the conversation last ran.
			const agent = await existing.agent(context);
			if (agent.instructions !== instructions || agent.model?.provider !== model.provider || agent.model.modelId !== model.modelId) {
				await existing.configure({ model, instructions }, context);
			}
			return existing;
		}
		const created = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model, instructions } }, context);
		db.setConversation(roomId, Number(created.id));
		return created;
	}

	#startDelivery(delivery: Delivery): void {
		// A resent message can reach here after the delivery the start picked up has already finished.
		if (this.#inFlight.has(delivery.eventId) || this.#options.db.isDelivered(delivery.eventId)) return;
		this.#inFlight.set(delivery.eventId, delivery.roomId);
		this.#options.link.send({ type: "typing", roomId: delivery.roomId, on: true });
		this.#track(
			this.#deliver(delivery)
				.catch((error) => this.#log(`delivering the answer to ${delivery.eventId} failed: ${describe(error)}`))
				.finally(() => {
					this.#inFlight.delete(delivery.eventId);
					if (![...this.#inFlight.values()].includes(delivery.roomId)) {
						this.#options.link.send({ type: "typing", roomId: delivery.roomId, on: false });
					}
				}),
		);
	}

	async #deliver(delivery: Delivery): Promise<void> {
		const { db } = this.#options;
		const answer = await this.#answerOf(delivery);
		for (let attempt = 0; ; attempt++) {
			try {
				const replyEventId = await this.#send(delivery.roomId, `reply:${delivery.eventId}`, answer.body, answer.notice);
				db.markDelivered(delivery.eventId, replyEventId);
				return;
			} catch (error) {
				const delay = this.#retryDelays[attempt];
				if (delay === undefined) throw error;
				this.#log(`sending the answer to ${delivery.eventId} failed, retrying in ${delay} ms: ${describe(error)}`);
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
	}

	async #answerOf(delivery: Delivery): Promise<{ body: string; notice: boolean }> {
		const { harness, context } = this.#options;
		const submission = await harness.submission(idFromNumber<SubmissionId>(delivery.submissionId), context);
		if (submission === undefined) return { body: "この発言の記録が見つからず、応答できませんでした。", notice: true };

		const settled = await submission.wait(context);
		if (settled.status !== "done" || settled.type !== "input") {
			const reason = settled.status === "unanswered" ? settled.reason : "no answer";
			const detail = settled.status === "unanswered" && typeof settled.detail === "string" ? `: ${settled.detail}` : "";
			return { body: `応答できませんでした（${reason}${detail}）`, notice: true };
		}
		const entry = await harness.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
		const text = (entry?.model ?? [])
			.flatMap((message) => (message.role === "assistant" ? message.content : []))
			.flatMap((block) => (block.type === "text" ? [block.text] : []))
			.join("\n\n")
			.trim();
		return text === "" ? { body: "（空の応答でした）", notice: true } : { body: text, notice: false };
	}

	/** Sends one message through the gateway and resolves with the ID of the event it became. */
	#send(roomId: string, txnId: string, body: string, notice: boolean): Promise<string> {
		// The transaction ID doubles as the request ID: one send per ID is in flight at a time.
		const requestId = txnId;
		return new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => settle(() => reject(new Error("the gateway did not answer in time"))), this.#sendTimeoutMs);
			const settle = (finish: () => void) => {
				clearTimeout(timer);
				this.#sends.delete(requestId);
				finish();
			};
			this.#sends.set(requestId, {
				resolve: (eventId) => settle(() => resolve(eventId)),
				reject: (error) => settle(() => reject(error)),
			});
			this.#options.link.send({ type: "send", requestId, roomId, txnId, body, notice });
		});
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
