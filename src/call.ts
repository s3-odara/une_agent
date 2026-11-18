import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Answer } from "./answer.ts";
import { type Config, persona, personaFor } from "./config.ts";
import { errorMessage } from "./errors.ts";
import type { GatewayEvent, GatewayLink } from "./gateway.ts";
import type { Transcriber } from "./stt.ts";
import { formatStamp } from "./time.ts";
import { type Synthesizer, sentences, toSpeech } from "./tts.ts";

/** What the gateway plays into a call. */
const CALL_SAMPLE_RATE = 48_000;

export type CallsOptions = {
	readonly link: GatewayLink;
	readonly config: Config;
	readonly transcriber: Transcriber;
	readonly synthesizer: Synthesizer;
	/** Puts what was said to the room's conversation and resolves with the answer (`Bridge.ask`). */
	readonly ask: (roomId: string, key: string, content: string) => Promise<Answer>;
	/** Tells the room something in text (`Bridge.notice`). */
	readonly notice: (roomId: string, key: string, body: string) => Promise<void>;
	/** Where speech is written until the gateway has read it. */
	readonly outDir: string;
	readonly log?: (message: string) => void;
};

type RoomCall = {
	joined: boolean;
	/** Goes up whenever the user starts speaking: an answer to an older turn is not spoken any more. */
	turn: number;
	/** Utterances are handled one at a time, in order. */
	tail: Promise<void>;
	/** What the persona should know about how its last answer came across, told with the next utterance. */
	note: string | undefined;
	/** Clips sent to be played, by ID, until the gateway says how far they got. */
	readonly spoken: Map<string, (spoken: Spoken) => void>;
};

type Spoken = { readonly playedMs: number; readonly interrupted: boolean };

/**
 * The bot's side of calls. It joins a room's call once an allowed user is in it and leaves when they all have. What
 * they say becomes input to the room's conversation, marked as said in a call; the answer is spoken sentence by
 * sentence, the next one made while the last plays. Talking over the bot stops it (the gateway does that at once), and
 * the persona is told with the next input how far it got.
 */
export class Calls {
	readonly #options: CallsOptions;
	readonly #log: (message: string) => void;
	readonly #rooms = new Map<string, RoomCall>();
	readonly #work = new Set<Promise<void>>();

	constructor(options: CallsOptions) {
		this.#options = options;
		this.#log = options.log ?? ((message) => console.error(message));
	}

	start(): void {
		this.#options.link.onEvent((event) => this.#onEvent(event));
	}

	/** Resolves once every utterance taken so far has been handled. */
	async idle(): Promise<void> {
		while (this.#work.size > 0) await Promise.allSettled([...this.#work]);
	}

	#onEvent(event: GatewayEvent): void {
		const { link, config } = this.#options;
		switch (event.type) {
			case "callMembers": {
				const room = this.#rooms.get(event.roomId);
				if (event.userIds.length > 0 && room === undefined) {
					this.#rooms.set(event.roomId, { joined: false, turn: 0, tail: Promise.resolve(), note: undefined, spoken: new Map() });
					link.send({ type: "joinCall", roomId: event.roomId, vad: (config.voice?.call ?? fail()).vad });
				} else if (event.userIds.length === 0 && room !== undefined) {
					link.send({ type: "leaveCall", roomId: event.roomId });
				}
				return;
			}
			case "callJoined": {
				const room = this.#rooms.get(event.roomId);
				if (room !== undefined) room.joined = true;
				this.#log(`joined the call in ${event.roomId}`);
				return;
			}
			case "callLeft": {
				const room = this.#rooms.get(event.roomId);
				this.#rooms.delete(event.roomId);
				for (const resolve of room?.spoken.values() ?? []) resolve({ playedMs: 0, interrupted: true });
				if (event.reason === "") return this.#log(`left the call in ${event.roomId}`);
				this.#log(`left the call in ${event.roomId}: ${event.reason}`);
				this.#track(this.#options.notice(event.roomId, `callleft:${randomUUID()}`, `通話から抜けました（${event.reason}）。`));
				return;
			}
			case "callSpeech": {
				const room = this.#rooms.get(event.roomId);
				if (room !== undefined) room.turn++;
				return;
			}
			case "callUtterance": {
				const room = this.#rooms.get(event.roomId);
				if (room === undefined) {
					void rm(event.path, { force: true });
					return;
				}
				const next = room.tail.then(() => this.#hear(event, room)).catch((error) => this.#log(`a call utterance in ${event.roomId} failed: ${errorMessage(error)}`));
				room.tail = next;
				this.#track(next);
				return;
			}
			case "callSpoken":
				this.#rooms.get(event.roomId)?.spoken.get(event.id)?.({ playedMs: event.playedMs, interrupted: event.interrupted });
				return;
		}
	}

	#track(work: Promise<void>): void {
		const tracked = work.catch((error) => this.#log(errorMessage(error)));
		this.#work.add(tracked);
		void tracked.finally(() => this.#work.delete(tracked));
	}

	async #hear(utterance: Extract<GatewayEvent, { type: "callUtterance" }>, room: RoomCall): Promise<void> {
		const { config, transcriber } = this.#options;
		const turn = room.turn;
		let text: string;
		try {
			text = (await transcriber.transcribe(utterance.path)).trim();
		} finally {
			await rm(utterance.path, { force: true });
		}
		if (text === "") return;

		const note = room.note === undefined ? "" : `（${room.note}）`;
		room.note = undefined;
		const content = `[${formatStamp(utterance.startedAt, config.timezone)} 通話] ${note}${text}`;
		// The file name is unique per utterance; the same key again would get the same answer back.
		const answer = await this.#options.ask(utterance.roomId, `call:${basename(utterance.path)}`, content);
		if (!answer.ok) {
			await this.#options.notice(utterance.roomId, `callfail:${basename(utterance.path)}`, `通話の発言に答えられませんでした（${answer.reason}）。`);
			return;
		}
		if (room.turn !== turn) {
			room.note = OVERTAKEN;
			return;
		}
		await this.#speak(utterance.roomId, room, turn, answer.text);
	}

	/** Speaks an answer one sentence at a time until it is done, or the user talks over it or starts a new turn. */
	async #speak(roomId: string, room: RoomCall, turn: number, answer: string): Promise<void> {
		const { config, synthesizer, link, outDir } = this.#options;
		const call = config.voice?.call ?? fail();
		const parts = sentences(toSpeech(answer, call.maxChars));
		const speaker = persona(config, personaFor(config, roomId)).voice ?? config.voice?.tts?.speaker ?? fail();
		const current = () => room.turn === turn && this.#rooms.get(roomId) === room;

		// Each sentence is made after the one before, and only while it is still wanted.
		let previous: Promise<Buffer | undefined> = Promise.resolve(undefined);
		const made = parts.map((part) => {
			previous = previous.then(() => (current() ? synthesizer.wav(part, speaker, CALL_SAMPLE_RATE) : undefined));
			return previous;
		});
		// After a failure every later one fails too, and is never awaited.
		for (const promise of made) promise.catch(() => {});
		await mkdir(outDir, { recursive: true });
		const said: string[] = [];
		for (const [i, part] of parts.entries()) {
			let wav: Buffer | undefined;
			try {
				wav = await made[i];
			} catch (error) {
				// The listener hears nothing more; the room gets the answer in text instead.
				this.#log(`making speech for a call in ${roomId} failed: ${errorMessage(error)}`);
				await this.#options.notice(roomId, `callvoice:${randomUUID()}`, `音声を作れなかったので文字で送ります（${errorMessage(error)}）。\n\n${answer}`);
				return;
			}
			if (wav === undefined || !current()) {
				if (this.#rooms.get(roomId) === room) room.note = interrupted(said.join(""));
				return;
			}
			const id = randomUUID();
			const path = join(outDir, `call-${id}.wav`);
			await writeFile(path, wav);
			const spoken = new Promise<Spoken>((resolve) => room.spoken.set(id, resolve));
			try {
				link.send({ type: "callSpeak", roomId, id, path });
				const result = await spoken;
				if (result.interrupted) {
					if (this.#rooms.get(roomId) === room) room.note = interrupted([...said, result.playedMs > 0 ? `${part}（の途中）` : ""].join(""));
					return;
				}
			} finally {
				room.spoken.delete(id);
				await rm(path, { force: true });
			}
			said.push(part);
		}
	}
}

/** Told with the next utterance when the answer was not spoken because the user had started speaking again. */
export const OVERTAKEN = "直前の返答は、読み上げる前にユーザーが話し始めたので伝わっていません";

/** Told with the next utterance when the user talked over the answer after `heard` of it. */
function interrupted(heard: string): string {
	return heard === "" ? "直前の返答は、話し始める前に遮られました" : `直前の返答は「${heard}」まで話したところで遮られました`;
}

function fail(): never {
	throw new Error("calls need voice.call and voice.tts in config.json");
}
