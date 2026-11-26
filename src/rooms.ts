import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { type Conversation, type Harness, LiveDoc, ProviderDoc, type UserInput } from "@earendil-works/pi-durable";
import { type Answer, answerOf, type Settled, type Submission } from "./answer.ts";
import { errorMessage } from "./errors.ts";
import { type Config, modelFor, persona, personaFor, readSoul, thinkingFor } from "./config.ts";
import type { GatewayCommand, GatewayEvent, GatewayLink } from "./gateway.ts";
import type { Aside, Delivery, HostDb } from "./hostdb.ts";
import { ProgressReport } from "./progress.ts";
import { readPdfText } from "./pdf.ts";
import type { Transcriber } from "./stt.ts";
import { fileSizeOf } from "./text.ts";
import { formatStamp } from "./time.ts";
import { type Synthesizer, toSpeech } from "./tts.ts";

type ConversationId = Conversation["id"];
type SubmissionId = Parameters<Harness["submission"]>[0];
type MessageEvent = Extract<GatewayEvent, { type: "message" }>;
type Attachment = NonNullable<MessageEvent["attachment"]>;

/** What a picture is allowed to weigh before it is left out of the conversation: it goes through base64 there. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** Longer text or PDF attachments are left on disk without inlining so they do not bloat the conversation history. */
const FILE_TEXT_MAX = 5_000;
/** What the model sees of an image; the same kinds the Anthropic API takes. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

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
	/** The least time between two edits of a run's progress notice. */
	readonly progressIntervalMs?: number;
	readonly log?: (message: string) => void;
	readonly voice?: VoiceOptions;
	readonly handlers?: readonly MessageHandler[];
};

export type Handled = { readonly handled: false } | { readonly handled: true; readonly reply?: string };

export interface MessageHandler {
	/** Lines for `!help`. */
	readonly help?: readonly string[];
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
	/** What the homeserver says it takes, at its ready; undefined until it does. */
	#uploadLimit: number | undefined;
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
			case "mediaFailed":
				this.#track(
					this.#send(event.roomId, `mediafail:${event.eventId}`, `添付ファイルを取得できませんでした（${event.reason}）。`, true).then(
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
				this.#uploadLimit = event.uploadLimit;
				this.#log(`gateway ready as ${event.userId} (device ${event.deviceId})${event.uploadLimit === undefined ? "" : `, upload limit ${event.uploadLimit}`}`);
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
			if (message.attachment !== undefined) {
				// A media message runs no command: it interrupts one waiting, as a voice message does.
				for (const handler of this.#options.handlers ?? []) handler.interrupt?.(message.roomId);
			} else {
				const command = await this.#command({ roomId: message.roomId, body: message.body, ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }) });
				if (command !== undefined) {
					if (command.reply !== undefined) await this.#send(message.roomId, `cmd:${message.eventId}`, command.reply, true);
					link.send({ type: "ack", eventId: message.eventId });
					return;
				}
			}
		}
		const attachment = message.attachment;
		if (attachment === undefined) {
			if (!db.isDelivered(message.eventId)) await this.#submit(message.roomId, message.eventId, `${time === undefined ? "" : `[${time}] `}${message.body}`);
		} else if (!db.hasDelivery(message.eventId)) {
			// Once admitted, what was made of the file lives in the conversation; a resent one is not processed again.
			if (attachment.voice === true) await this.#admitAudio(message, attachment.path, time);
			else await this.#admitFile(message, attachment, time);
		}
		link.send({ type: "ack", eventId: message.eventId });
		// The transcription lives in the conversation, so the recording is of no use afterwards.
		if (attachment?.voice === true) await rm(attachment.path, { force: true });
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
		this.#track(this.notice(message.roomId, `heard:${message.eventId}`, `🎤 ${text}`).catch((error) => {
			this.#log(`posting the transcript of ${message.eventId} failed: ${errorMessage(error)}`);
		}));
		await this.#submit(message.roomId, message.eventId, `[${time === undefined ? "" : `${time} `}音声] ${text}`, true);
	}

	/**
	 * Every received non-voice file is kept on disk until the scheduler cleans up old files, so the model can inspect
	 * the original file later even when it was inlined or omitted.
	 */
	async #admitFile(message: MessageEvent, attachment: Attachment, time: string | undefined): Promise<void> {
		const { link } = this.#options;
		const tell = (body: string) => this.#send(message.roomId, `file:${message.eventId}`, body, true);
		const name = message.body.trim() === "" ? "添付ファイル" : message.body.trim();
		const bytes = await stat(attachment.path).then((info) => info.size, () => 0);
		const kind = `${name}（${attachment.mimeType}、${fileSizeOf(bytes)}）`;
		const stamp = time === undefined ? "" : `${time} `;
		const kept = `（保存先: ${attachment.path}）`;

		link.send({ type: "typing", roomId: message.roomId, on: true });
		try {
			if (IMAGE_TYPES.has(attachment.mimeType) && bytes <= MAX_IMAGE_BYTES) {
				const content: UserInput = [
					{ type: "text", text: `[${stamp}画像添付] ${kind} ${kept}` },
					{ type: "image", data: (await readFile(attachment.path)).toString("base64"), mimeType: attachment.mimeType },
				];
				await this.#submit(message.roomId, message.eventId, content);
				return;
			}
			if (attachment.mimeType === "application/pdf") {
				const { markdown, pages } = await readPdfText(await readFile(attachment.path));
				const body = markdown.length <= FILE_TEXT_MAX ? `\n${markdown}` : `（全 ${pages} ページ、${markdown.length} 字のため本文省略。read_pdf で確認してください）`;
				await this.#submit(message.roomId, message.eventId, `[${stamp}PDF添付] ${kind} ${kept}${body}`);
				return;
			}
			if (attachment.mimeType.startsWith("text/") || attachment.mimeType === "application/json") {
				const text = (await readFile(attachment.path, "utf8")).trim();
				const body = text.length <= FILE_TEXT_MAX ? `\n${text}` : `（${text.split("\n").length} 行、${text.length} 字のため本文省略。必要に応じて read や bash で確認してください）`;
				await this.#submit(message.roomId, message.eventId, `[${stamp}ファイル添付] ${kind} ${kept}${body}`);
				return;
			}
			const note = IMAGE_TYPES.has(attachment.mimeType) ? `大きすぎるため会話に載せられません。` : "";
			await this.#submit(message.roomId, message.eventId, `[${stamp}ファイル添付] ${kind} ${kept}${note}`);
		} catch (error) {
			this.#log(`reading ${message.eventId} failed: ${errorMessage(error)}`);
			await tell(`ファイルを処理できませんでした（${errorMessage(error)}）。`);
		} finally {
			link.send({ type: "typing", roomId: message.roomId, on: false });
		}
	}

	/** What a person said, into the room's conversation; counted, so a check knows something was said in the room. */
	async #submitToRoom(roomId: string, key: string, content: string | UserInput) {
		const submission = await (await this.#conversationFor(roomId)).submit({ type: "input", content, requestId: key, whenBusy: "steer" }, this.#options.context);
		this.#options.db.noteActivity(roomId);
		return submission;
	}

	async #submit(roomId: string, key: string, content: string | UserInput, voice = false): Promise<void> {
		const { db } = this.#options;
		const submission = await this.#submitToRoom(roomId, key, content);
		const delivery: Delivery = { eventId: key, roomId, submissionId: Number(submission.id), voice };
		db.addDelivery(delivery);
		this.#startDelivery(delivery);
	}

	/**
	 * A conversation that starts as the room's is now, for something to be weighed in without the room's conversation
	 * holding it; `adopt()` makes it the room's. Undefined while the room's conversation is at work: what it is doing
	 * would be cut in half. The provider's session identity is carried over, so the prompt cache built by the room's
	 * conversation serves this one.
	 */
	startAside(roomId: string): Promise<Aside | undefined> {
		return this.#serial(roomId, async () => {
			const { harness, context, db } = this.#options;
			const main = await this.#conversationFor(roomId);
			const { busy, latest } = await this.#head(main);
			if (busy) return undefined;
			let aside: Conversation;
			if (latest === undefined) {
				aside = await this.#createConversation(roomId);
			} else {
				const session = (await harness.snapshot(ProviderDoc, main.id, context))?.sessionId;
				aside = await main.fork(
					latest.id,
					{
						ownership: { kind: "ownerless" },
						...(session === undefined ? {} : { init: async (tx, id) => void ((await tx.doc(ProviderDoc, id)).sessionId = session) }),
					},
					context,
				);
			}
			db.addConversationRoom(Number(aside.id), roomId);
			return { conversationId: Number(aside.id), from: { conversationId: Number(main.id), entryId: latest === undefined ? 0 : Number(latest.id) } };
		});
	}

	/**
	 * Makes the aside the room's conversation, unless the room's has moved on since the aside was made (a message came,
	 * or `!new`): the aside would not know of it. Repeating it after it succeeded succeeds again.
	 */
	adopt(roomId: string, aside: Aside): Promise<boolean> {
		return this.#serial(roomId, async () => {
			const { harness, context, db } = this.#options;
			const current = db.conversationOf(roomId);
			if (current === aside.conversationId) return true;
			if (current !== aside.from.conversationId) return false;
			const main = await harness.conversation(idFromNumber<ConversationId>(current), context);
			if (main === undefined) return false;
			const { busy, latest } = await this.#head(main);
			if (busy || (latest === undefined ? 0 : Number(latest.id)) !== aside.from.entryId) return false;
			db.setConversation(roomId, aside.conversationId);
			return true;
		});
	}

	/** Whether the conversation is at work, and its newest entry: what an aside starts from and is checked against. */
	async #head(conversation: Conversation) {
		const { harness, context } = this.#options;
		const busy = (await harness.snapshot(LiveDoc, conversation.id, context))?.run !== undefined;
		const [latest] = (await conversation.entries({}, 1, undefined, context)).items;
		return { busy, latest };
	}

	/** A message of the bot's own accord, which notifies as an answer does. The same ID again sends nothing new. */
	say(roomId: string, txnId: string, body: string): Promise<string> {
		return this.#retrying(`the message ${txnId}`, () => this.#send(roomId, txnId, body, false));
	}

	/**
	 * Runs the room's conversation on from what an aside answered, as the input its continuation line stands for. An
	 * input rather than a bare run, so what comes of it reaches the room like any other answer.
	 */
	continueRun(roomId: string, key: string): Promise<void> {
		return this.#serial(roomId, async () => {
			const submission = await this.#submitToRoom(roomId, `continue:${key}`, "[確認の後続] 直前の返答が「実行継続」で終わっていたので、その続きをここで実行する。ユーザーの発言ではない。");
			const delivery: Delivery = { eventId: `continue:${key}`, roomId, submissionId: Number(submission.id), voice: false };
			this.#options.db.addDelivery(delivery);
			this.#startDelivery(delivery);
		});
	}

	/**
	 * Not in the delivery ledger, so an answer still owed when the process stops is left in the conversation and not
	 * sent later, by which time the call is over.
	 */
	async ask(roomId: string, key: string, content: string): Promise<Answer> {
		const submission = await this.#serial(roomId, () => this.#submitToRoom(roomId, key, content));
		const { harness, context } = this.#options;
		const result = submission.wait(context);
		this.#track(this.#reportProgress(roomId, key, submission, result));
		return answerOf(harness, await result, context);
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

	/** The largest upload the homeserver accepts, when it says. */
	uploadLimit(): number | undefined {
		return this.#uploadLimit;
	}

	/** The same ID again sends nothing new; a retry uploads again and still ends in one event. */
	sendAttachment(
		roomId: string,
		txnId: string,
		file: {
			readonly path: string;
			readonly name: string;
			readonly mimeType: string;
			readonly width?: number;
			readonly height?: number;
			readonly voice?: { readonly durationMs: number; readonly waveform?: readonly number[] };
		},
	): Promise<string> {
		return this.#request({ type: "sendAttachment", requestId: txnId, roomId, txnId, ...file });
	}

	async react(roomId: string, txnId: string, eventId: string, key: string): Promise<void> {
		await this.#request({ type: "react", requestId: txnId, roomId, txnId, eventId, key });
	}

	/** The same key again sends nothing new. */
	async notice(roomId: string, key: string, body: string): Promise<void> {
		await this.#send(roomId, `notice:${key}`, body, true);
	}

	async #command(message: { readonly roomId: string; readonly body: string; readonly replyTo?: string }): Promise<Extract<Handled, { handled: true }> | undefined> {
		// Before the handlers, so asking for help does not give up a pending approval or code request.
		if (message.body.trim() === "!help") return { handled: true, reply: this.#help(message.roomId) };
		for (const handler of this.#options.handlers ?? []) {
			const result = handler.onMessage(message);
			if (result.handled) return result;
		}
		// Not a handler but after them: they take it as any other message, so a pending approval or code request is given up.
		if (message.body.trim() !== "!new") return undefined;
		await this.#startOver(message.roomId);
		return { handled: true, reply: "新しい会話を始めました。これまでの会話は引き継ぎません（記憶はそのままです）。" };
	}

	#help(roomId: string): string {
		const { config } = this.#options;
		const name = personaFor(config, roomId);
		const model = modelFor(config, name);
		return [
			"コマンド:",
			"- !help … この一覧",
			"- !new … このルームの会話を最初からやり直す（記憶とカレンダーはそのまま）",
			...(this.#options.handlers ?? []).flatMap((handler) => handler.help ?? []),
			"",
			`このルーム: 人格 ${name}、モデル ${model.provider}/${model.modelId}`,
		].join("\n");
	}

	/** A reset rather than a new conversation: the ledger and the browser tab still refer to it. */
	async #startOver(roomId: string): Promise<void> {
		const conversation = await this.#existingConversation(roomId);
		// Without the abort, the reset waits for the answer being written, and that answer is still sent.
		await conversation?.abort(this.#options.context);
		await conversation?.reset(undefined, this.#options.context);
	}

	async #existingConversation(roomId: string): Promise<Conversation | undefined> {
		const known = this.#options.db.conversationOf(roomId);
		return known === undefined ? undefined : this.#options.harness.conversation(idFromNumber<ConversationId>(known), this.#options.context);
	}

	async #conversationFor(roomId: string): Promise<Conversation> {
		const { config, context, db } = this.#options;
		const name = personaFor(config, roomId);
		const model = modelFor(config, name);
		const thinkingLevel = thinkingFor(config, name);
		const instructions = readSoul(config, name);

		const existing = await this.#existingConversation(roomId);
		if (existing !== undefined) {
			// The persona file and the model may have changed since the conversation last ran.
			const agent = await existing.agent(context);
			if (
				agent.instructions !== instructions ||
				agent.model?.provider !== model.provider ||
				agent.model.modelId !== model.modelId ||
				agent.thinkingLevel !== thinkingLevel
			) {
				await existing.configure({ model, thinkingLevel, instructions }, context);
			}
			return existing;
		}
		const created = await this.#createConversation(roomId);
		db.setConversation(roomId, Number(created.id));
		return created;
	}

	#createConversation(roomId: string): Promise<Conversation> {
		const { harness, config, context } = this.#options;
		const name = personaFor(config, roomId);
		const agent = { model: modelFor(config, name), thinkingLevel: thinkingFor(config, name), instructions: readSoul(config, name) };
		return harness.createConversation({ ownership: { kind: "ownerless" }, agent }, context);
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
		if (answer === undefined) return void db.markDelivered(delivery.eventId);
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
			await this.sendAttachment(delivery.roomId, `voice:${delivery.eventId}`, {
				path,
				name: "voice-message.ogg",
				mimeType: "audio/ogg",
				voice: { durationMs: speech.durationMs, waveform: speech.waveform },
			});
		} finally {
			await rm(path, { force: true });
		}
	}

	/** Undefined when nothing is to be sent: the run was stopped by `!new`, or another message of the same run answers. */
	async #answerOf(delivery: Delivery): Promise<{ body: string; notice: boolean } | undefined> {
		const { harness, context } = this.#options;
		const submission = await harness.submission(idFromNumber<SubmissionId>(delivery.submissionId), context);
		if (submission === undefined) return { body: "この発言の記録が見つからず、応答できませんでした。", notice: true };

		const result = submission.wait(context);
		const progress = this.#options.db.isUserSubmission(delivery.submissionId)
			? this.#reportProgress(delivery.roomId, delivery.eventId, submission, result)
			: undefined;
		const settled = await result;
		const [answer] = await Promise.all([answerOf(harness, settled, context), progress]);
		if ((!answer.ok && answer.stopped) || !(await this.#answers(delivery, settled))) return undefined;
		if (answer.ok) return { body: answer.text, notice: false };
		if (answer.empty) return { body: "（空の応答でした）", notice: true };
		return { body: `応答できませんでした（${answer.reason}）`, notice: true };
	}

	/** Whether this message, of all that joined its run, is the one that answers it. */
	async #answers(delivery: Delivery, settled: Settled): Promise<boolean> {
		if (settled.type === "input" && settled.status === "done") return this.#options.db.claimAnswer(Number(settled.answer), delivery.eventId) === delivery.eventId;
		const { harness, context, db } = this.#options;
		const conversationId = db.conversationOf(delivery.roomId);
		const failure = conversationId === undefined ? undefined : (await harness.snapshot(LiveDoc, idFromNumber<ConversationId>(conversationId), context))?.runFailure;
		// Once the next run has started the failure is gone, and each of its messages tells it: twice rather than never.
		const inputs = (failure?.inputs ?? []).map(Number);
		return !inputs.includes(delivery.submissionId) || inputs[0] === delivery.submissionId;
	}

	async #reportProgress(roomId: string, key: string, submission: Submission, result: Promise<Settled>): Promise<void> {
		try {
			const conversation = await this.#existingConversation(roomId);
			if (conversation === undefined) return;
			const report = new ProgressReport({
				conversation,
				submission,
				// The first send is keyed to the message, so after a restart the run goes on in the same notice. Edits need no
				// such key: an edit sent twice shows the same thing.
				send: (body, replaces) =>
					this.#send(roomId, replaces === undefined ? `progress:${key}` : `progress:${key}:${randomUUID()}`, body, true, replaces),
				intervalMs: this.#options.progressIntervalMs ?? 2_000,
				context: this.#options.context,
				log: this.#log,
			});
			await report.start();
			await report.finish(await result);
		} catch (error) {
			this.#log(`showing the progress failed: ${errorMessage(error)}`);
		}
	}

	#send(roomId: string, txnId: string, body: string, notice: boolean, replaces?: string): Promise<string> {
		// The transaction ID doubles as the request ID: one send per ID is in flight at a time.
		return this.#request({ type: "send", requestId: txnId, roomId, txnId, body, notice, ...(replaces === undefined ? {} : { replaces }) });
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
