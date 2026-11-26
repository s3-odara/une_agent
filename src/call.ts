import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Answer } from "./answer.ts";
import { chimeWav } from "./chime.ts";
import { type Config, persona, personaFor } from "./config.ts";
import { errorMessage } from "./errors.ts";
import type { GatewayEvent, GatewayLink } from "./gateway.ts";
import type { Transcriber } from "./stt.ts";
import { formatStamp } from "./time.ts";
import { type Synthesizer, toSpeech } from "./tts.ts";

/** What the gateway plays into a call. */
const CALL_SAMPLE_RATE = 48_000;

export type CallsOptions = {
	readonly link: GatewayLink;
	readonly config: Config;
	readonly transcriber: Transcriber;
	readonly synthesizer: Synthesizer;
	readonly ask: (roomId: string, key: string, content: string) => Promise<Answer>;
	readonly notice: (roomId: string, key: string, body: string) => Promise<void>;
	readonly outDir: string;
	readonly log?: (message: string) => void;
};

type RoomCall = {
	joined: boolean;
	/** Goes up whenever the user starts speaking: an answer to an older turn is not spoken any more. */
	turn: number;
	tail: Promise<void>;
	/** The last answer was not spoken because the user went on speaking; the next utterance tells the persona so. */
	overtaken: boolean;
	readonly spoken: Map<string, () => void>;
};

/** The bot and the user take turns: the gateway does not listen while the bot talks, so the bot is never talked over. */
export class Calls {
	readonly #options: CallsOptions;
	readonly #log: (message: string) => void;
	readonly #rooms = new Map<string, RoomCall>();
	readonly #wanted = new Set<string>();
	readonly #work = new Set<Promise<void>>();
	#chime: Promise<string> | undefined;

	constructor(options: CallsOptions) {
		this.#options = options;
		this.#log = options.log ?? ((message) => console.error(message));
	}

	start(): void {
		this.#options.link.onEvent((event) => this.#onEvent(event));
	}

	async idle(): Promise<void> {
		while (this.#work.size > 0) await Promise.allSettled([...this.#work]);
	}

	#join(roomId: string): void {
		const { link, config } = this.#options;
		this.#rooms.set(roomId, { joined: false, turn: 0, tail: Promise.resolve(), overtaken: false, spoken: new Map() });
		link.send({ type: "joinCall", roomId, vad: (config.voice?.call ?? fail()).vad });
	}

	#onEvent(event: GatewayEvent): void {
		const { link } = this.#options;
		switch (event.type) {
			case "callMembers": {
				const room = this.#rooms.get(event.roomId);
				if (event.userIds.length > 0) {
					this.#wanted.add(event.roomId);
					if (room === undefined) this.#join(event.roomId);
				} else {
					this.#wanted.delete(event.roomId);
					if (room !== undefined) link.send({ type: "leaveCall", roomId: event.roomId });
				}
				return;
			}
			case "callJoined": {
				const room = this.#rooms.get(event.roomId);
				if (room !== undefined) room.joined = true;
				this.#log(`joined the call in ${event.roomId}`);
				if (!this.#wanted.has(event.roomId)) link.send({ type: "leaveCall", roomId: event.roomId });
				return;
			}
			case "callLeft": {
				const room = this.#rooms.get(event.roomId);
				this.#rooms.delete(event.roomId);
				for (const resolve of room?.spoken.values() ?? []) resolve();
				if (event.reason === "") {
					this.#log(`left the call in ${event.roomId}`);
					if (this.#wanted.has(event.roomId)) this.#join(event.roomId);
					return;
				}
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
				this.#rooms.get(event.roomId)?.spoken.get(event.id)?.();
				return;
		}
	}

	#track(work: Promise<void>): void {
		const tracked = work.catch((error) => this.#log(errorMessage(error)));
		this.#work.add(tracked);
		void tracked.finally(() => this.#work.delete(tracked));
	}

	async #hear(utterance: Extract<GatewayEvent, { type: "callUtterance" }>, room: RoomCall): Promise<void> {
		const { config, transcriber, notice } = this.#options;
		const call = config.voice?.call ?? fail();
		const { roomId } = utterance;
		const key = basename(utterance.path);
		const turn = room.turn;
		let text: string;
		try {
			text = (await transcriber.transcribe(utterance.path)).trim();
		} finally {
			await rm(utterance.path, { force: true });
		}
		if (text === "") return;
		// Not into the user's next utterance: the gateway would stop listening to it.
		if (call.chime && this.#rooms.get(roomId) === room && room.turn === turn) {
			try {
				const chimePath = await this.#chimeFile();
				if (this.#rooms.get(roomId) === room && room.turn === turn) {
					// Nobody waits for it to finish, so `callSpoken` for it finds no listener and the file is kept for next time.
					this.#options.link.send({ type: "callSpeak", roomId, id: randomUUID(), path: chimePath });
				}
			} catch (error) {
				this.#log(`playing the chime in ${roomId} failed: ${errorMessage(error)}`);
			}
		}
		this.#track(notice(roomId, `callheard:${key}`, `🎤 ${text}`));

		const note = room.overtaken ? `（${OVERTAKEN}）` : "";
		room.overtaken = false;
		const content = `[${formatStamp(utterance.startedAt, config.timezone)} 通話] ${note}${text}`;
		// The file name is unique per utterance; the same key again would get the same answer back.
		const answer = await this.#options.ask(roomId, `call:${key}`, content);
		if (!answer.ok) {
			if (answer.stopped) return;
			await notice(roomId, `callfail:${key}`, `通話の発言に答えられませんでした（${answer.reason}）。`);
			return;
		}
		// Written even when it is not spoken: the room keeps what the persona answered.
		this.#track(notice(roomId, `callanswer:${key}`, answer.text));
		if (this.#overtaken(room, turn)) return;
		await this.#speak(roomId, room, turn, answer.text);
	}

	#chimeFile(): Promise<string> {
		const { outDir } = this.#options;
		this.#chime ??= (async () => {
			const path = join(outDir, "chime.wav");
			await mkdir(outDir, { recursive: true });
			await writeFile(path, chimeWav(CALL_SAMPLE_RATE));
			return path;
		})().catch((error) => {
			this.#chime = undefined;
			throw error;
		});
		return this.#chime;
	}

	async #play(roomId: string, room: RoomCall, wav: Buffer): Promise<void> {
		const { outDir } = this.#options;
		await mkdir(outDir, { recursive: true });
		const id = randomUUID();
		const path = join(outDir, `call-${id}.wav`);
		await writeFile(path, wav);
		try {
			// `callLeft` may have arrived while writing the file; registering on a removed room would never be resolved.
			if (this.#rooms.get(roomId) !== room) return;
			const spoken = new Promise<void>((resolve) => room.spoken.set(id, resolve));
			this.#options.link.send({ type: "callSpeak", roomId, id, path });
			return await spoken;
		} finally {
			room.spoken.delete(id);
			await rm(path, { force: true });
		}
	}

	/**
	 * Made whole before it plays: sentence by sentence, a gap where making the next one fell behind would read as the
	 * end of the bot's turn, and the gateway would listen again in the middle of it.
	 */
	async #speak(roomId: string, room: RoomCall, turn: number, answer: string): Promise<void> {
		const { config, synthesizer } = this.#options;
		const call = config.voice?.call ?? fail();
		const speech = toSpeech(answer, call.maxChars);
		if (speech === "") return;
		const speaker = persona(config, personaFor(config, roomId)).voice ?? config.voice?.tts?.speaker ?? fail();
		let wav: Buffer;
		try {
			wav = await synthesizer.wav(speech, speaker, CALL_SAMPLE_RATE);
		} catch (error) {
			const reason = errorMessage(error);
			this.#log(`making speech for a call in ${roomId} failed: ${reason}`);
			await this.#options.notice(
				roomId,
				`callvoice:${randomUUID()}`,
				`音声を作れませんでした（${reason}）。`,
			);
			return;
		}
		if (this.#rooms.get(roomId) !== room || this.#overtaken(room, turn)) return;
		await this.#play(roomId, room, wav);
	}

	#overtaken(room: RoomCall, turn: number): boolean {
		if (room.turn === turn) return false;
		room.overtaken = true;
		return true;
	}
}

export const OVERTAKEN = "直前の返答は、読み上げる前にユーザーが話し始めたので伝わっていません";

function fail(): never {
	throw new Error("calls need voice.call and voice.tts in config.json");
}
