import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { Conversation, Harness } from "@earendil-works/pi-durable";
import { type Answer, answerOf } from "./answer.ts";
import { errorMessage } from "./errors.ts";
import { type Config, persona, personaFor, readSoul } from "./config.ts";
import type { GatewayCommand, GatewayEvent, GatewayLink } from "./gateway.ts";
import { type Delivery, type HostDb, SCHEDULED_PREFIX } from "./hostdb.ts";
import type { Transcriber } from "./stt.ts";
import { formatStamp } from "./time.ts";
import { type Synthesizer, toSpeech } from "./tts.ts";

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
	/** After the last, the answer waits for the next start. */
	readonly sendRetryDelaysMs?: readonly number[];
	readonly sendTimeoutMs?: number;
	readonly log?: (message: string) => void;
	readonly voice?: VoiceOptions;
	readonly handlers?: readonly MessageHandler[];
};

export type Handled = { readonly handled: false } | { readonly handled: true; readonly reply?: string };

export interface MessageHandler {
	onMessage(message: { readonly roomId: string; readonly body: string; readonly replyTo?: string }): Handled;
	/** The user sent a voice message, which no handler takes. */
	interrupt?(roomId: string): void;
	onReaction?(roomId: string, relatesTo: string, key: string): void;
}

export type VoiceOptions = {
	readonly transcriber: Transcriber;
	readonly synthesizer?: Synthesizer;
	readonly outDir: string;
};

/**
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
	readonly #inFlight = new Map<string, string>();
	readonly #sends = new Map<string, { resolve: (eventId: string) => void; reject: (error: Error) => void }>();
	readonly #work = new Set<Promise<void>>();

	constructor(options: BridgeOptions) {
		this.#options = options;
		this.#retryDelays = options.sendRetryDelaysMs ?? [5_000, 30_000, 120_000];
		this.#sendTimeoutMs = options.sendTimeoutMs ?? 60_000;
		this.#log = options.log ?? ((message) => console.error(message));
	}

	start(): void {
		this.#options.link.onEvent((event) => this.#onEvent(event));
		for (const delivery of this.#options.db.pendingDeliveries()) this.#startDelivery(delivery);
	}

	async idle(): Promise<void> {
		while (this.#work.size > 0) await Promise.allSettled([...this.#work]);
	}

	#track(work: Promise<void>): void {
		this.#work.add(work);
		void work.finally(() => this.#work.delete(work));
	}

	#onEvent(event: GatewayEvent): void {
		switch (event.type) {
			case "message":
				this.#track(
					this.#serial(event.roomId, () => this.#admit(event)).catch((error) => {
						// Not acked, so the gateway offers the message again at its next start.
						this.#log(`admitting ${event.eventId} failed: ${errorMessage(error)}`);
					}),
				);
				return;
			case "undecryptable":
				this.#track(
					this.#send(event.roomId, `utd:${event.eventId}`, "このメッセージを復号できませんでした。もう一度送ってください。", true).then(
						() => {},
						(error) => this.#log(`notice for ${event.eventId} failed: ${errorMessage(error)}`),
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
			case "reaction":
				for (const handler of this.#options.handlers ?? []) handler.onReaction?.(event.roomId, event.relatesTo, event.key);
				return;
		}
	}

	async #admit(message: MessageEvent): Promise<void> {
		const { db, link, config } = this.#options;
		// The time it was sent, so "tomorrow" means something. A system prompt that changed every minute would
		// defeat the provider's prompt cache; a stamp on the message does not.
		const time = message.ts > 0 ? formatStamp(message.ts, config.timezone) : undefined;
		// A message already in the conversation is one resent after a crash: no handler took it the first time.
		if (!db.hasDelivery(message.eventId)) {
			const handlers = this.#options.handlers ?? [];
			if (message.audio !== undefined) {
				for (const handler of handlers) handler.interrupt?.(message.roomId);
			} else {
				const text = { roomId: message.roomId, body: message.body, ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }) };
				for (const handler of handlers) {
					const result = handler.onMessage(text);
					if (!result.handled) continue;
					if (result.reply !== undefined) await this.#send(message.roomId, `cmd:${message.eventId}`, result.reply, true);
					link.send({ type: "ack", eventId: message.eventId });
					return;
				}
			}
		}
		if (message.audio === undefined) {
			if (!db.isDelivered(message.eventId)) await this.#submit(message.roomId, message.eventId, `${time === undefined ? "" : `[${time}] `}${message.body}`);
		} else if (!db.hasDelivery(message.eventId)) {
			// Once admitted, the transcript lives in the conversation; a resent recording is not transcribed again.
			await this.#admitAudio(message, message.audio.path, time);
		}
		link.send({ type: "ack", eventId: message.eventId });
		if (message.audio !== undefined) await rm(message.audio.path, { force: true });
	}

	/** When it cannot be transcribed, the message is acked all the same: a recording that failed once would fail again at every start. */
	async #admitAudio(message: MessageEvent, path: string, time: string | undefined): Promise<void> {
		const { link } = this.#options;
		const voice = this.#options.voice;
		const tell = (body: string) => this.#send(message.roomId, `stt:${message.eventId}`, body, true);
		if (voice === undefined) return void (await tell("音声メッセージには対応していません（設定に voice がありません）。"));

		link.send({ type: "typing", roomId: message.roomId, on: true });
		let text: string;
		try {
			text = (await voice.transcriber.transcribe(path)).trim();
		} catch (error) {
			link.send({ type: "typing", roomId: message.roomId, on: false });
			this.#log(`transcribing ${message.eventId} failed: ${errorMessage(error)}`);
			return void (await tell(`音声を文字にできませんでした（${errorMessage(error)}）。`));
		}
		if (text === "") {
			link.send({ type: "typing", roomId: message.roomId, on: false });
			return void (await tell("音声を聞き取れませんでした。"));
		}
		await this.#submit(message.roomId, message.eventId, `[${time === undefined ? "" : `${time} `}音声] ${text}`, true);
	}

	async #submit(roomId: string, key: string, content: string, voice = false): Promise<void> {
		const { db, context } = this.#options;
		const conversation = await this.#conversationFor(roomId);
		const submission = await conversation.submit({ type: "input", content, requestId: key }, context);
		const delivery: Delivery = { eventId: key, roomId, submissionId: Number(submission.id), voice };
		db.addDelivery(delivery);
		this.#startDelivery(delivery);
	}

	/** The same key again asks for nothing new. */
	submitScheduled(roomId: string, key: string, content: string): Promise<void> {
		const eventId = `${SCHEDULED_PREFIX}${key}`;
		return this.#serial(roomId, async () => {
			if (!this.#options.db.isDelivered(eventId)) await this.#submit(roomId, eventId, content);
		});
	}

	/**
	 * Not in the delivery ledger, so an answer still owed when the process stops is left in the conversation and not
	 * sent later, by which time the call is over.
	 */
	async ask(roomId: string, key: string, content: string): Promise<Answer> {
		const { harness, context } = this.#options;
		const submission = await this.#serial(roomId, async () => (await this.#conversationFor(roomId)).submit({ type: "input", content, requestId: key }, context));
		return answerOf(harness, await submission.wait(context), context);
	}

	#serial<T>(roomId: string, admit: () => Promise<T>): Promise<T> {
		const result = (this.#admissions.get(roomId) ?? Promise.resolve()).then(admit);
		const settled = result.then(
			() => {},
			() => {},
		);
		this.#admissions.set(roomId, settled);
		this.#track(settled);
		return result;
	}

	/** The same ID again sends nothing new. */
	post(roomId: string, txnId: string, body: string): Promise<string> {
		return this.#send(roomId, txnId, body, true);
	}

	sendImage(roomId: string, txnId: string, image: { readonly path: string; readonly name: string; readonly width: number; readonly height: number }): Promise<string> {
		return this.#request({ type: "sendImage", requestId: txnId, roomId, txnId, ...image });
	}

	async react(roomId: string, txnId: string, eventId: string, key: string): Promise<void> {
		await this.#request({ type: "react", requestId: txnId, roomId, txnId, eventId, key });
	}

	/** The same key again sends nothing new. */
	async notice(roomId: string, key: string, body: string): Promise<void> {
		await this.#send(roomId, `notice:${key}`, body, true);
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
				.catch((error) => this.#log(`delivering the answer to ${delivery.eventId} failed: ${errorMessage(error)}`))
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
		const replyEventId = await this.#retrying(`the answer to ${delivery.eventId}`, () =>
			this.#send(delivery.roomId, `reply:${delivery.eventId}`, answer.body, answer.notice),
		);
		// The text goes first: it is there at once, while speech takes a while to make.
		if (delivery.voice === true && !answer.notice) {
			try {
				await this.#retrying(`the spoken answer to ${delivery.eventId}`, () => this.#sendSpoken(delivery, answer.body));
			} catch (error) {
				// The text has arrived, so the answer is not lost; say why the voice did not come instead of retrying forever.
				await this.#send(delivery.roomId, `voicefail:${delivery.eventId}`, `音声の返答を作れませんでした（${errorMessage(error)}）。`, true).catch(
					(noticeError) => this.#log(`notice for ${delivery.eventId} failed: ${errorMessage(noticeError)}`),
				);
			}
		}
		db.markDelivered(delivery.eventId, replyEventId);
	}

	async #retrying<T>(what: string, attempt: () => Promise<T>): Promise<T> {
		for (let tries = 0; ; tries++) {
			try {
				return await attempt();
			} catch (error) {
				const delay = this.#retryDelays[tries];
				if (delay === undefined) throw error;
				this.#log(`sending ${what} failed, retrying in ${delay} ms: ${errorMessage(error)}`);
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
	}

	async #sendSpoken(delivery: Delivery, body: string): Promise<void> {
		const { config } = this.#options;
		const synthesizer = this.#options.voice?.synthesizer;
		const tts = config.voice?.tts;
		if (synthesizer === undefined || tts === undefined) return;
		const text = toSpeech(body, tts.maxChars);
		if (text === "") return;
		const speaker = persona(config, personaFor(config, delivery.roomId)).voice ?? tts.speaker;
		const speech = await synthesizer.synthesize(text, speaker);

		const dir = (this.#options.voice as VoiceOptions).outDir;
		await mkdir(dir, { recursive: true });
		const path = join(dir, `${delivery.eventId.replace(/[^A-Za-z0-9_-]/g, "_")}.ogg`);
		await writeFile(path, speech.ogg);
		try {
			const txnId = `voice:${delivery.eventId}`;
			await this.#request({ type: "sendVoice", requestId: txnId, roomId: delivery.roomId, txnId, path, durationMs: speech.durationMs, waveform: speech.waveform });
		} finally {
			await rm(path, { force: true });
		}
	}

	async #answerOf(delivery: Delivery): Promise<{ body: string; notice: boolean }> {
		const { harness, context } = this.#options;
		const submission = await harness.submission(idFromNumber<SubmissionId>(delivery.submissionId), context);
		if (submission === undefined) return { body: "この発言の記録が見つからず、応答できませんでした。", notice: true };

		const answer = await answerOf(harness, await submission.wait(context), context);
		if (answer.ok) return { body: answer.text, notice: false };
		return { body: answer.reason === "empty answer" ? "（空の応答でした）" : `応答できませんでした（${answer.reason}）`, notice: true };
	}

	#send(roomId: string, txnId: string, body: string, notice: boolean): Promise<string> {
		// The transaction ID doubles as the request ID: one send per ID is in flight at a time.
		return this.#request({ type: "send", requestId: txnId, roomId, txnId, body, notice });
	}

	#request(command: Extract<GatewayCommand, { requestId: string }>): Promise<string> {
		const { requestId } = command;
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
			this.#options.link.send(command);
		});
	}
}
