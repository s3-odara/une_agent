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
import { type Synthesizer, sentences, toSpeech } from "./tts.ts";

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
	note: string | undefined;
	readonly spoken: Map<string, (spoken: Spoken) => void>;
};

type Spoken = { readonly playedMs: number; readonly interrupted: boolean };

/** Talking over the bot stops it: the gateway does that at once, not this code. */
export class Calls {
	readonly #options: CallsOptions;
	readonly #log: (message: string) => void;
	readonly #rooms = new Map<string, RoomCall>();
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
		if (call.chime && this.#rooms.get(roomId) === room) {
			try {
				// Nobody waits for it to finish, so `callSpoken` for it finds no listener and the file is kept for next time.
				this.#options.link.send({ type: "callSpeak", roomId, id: randomUUID(), path: await this.#chimeFile() });
			} catch (error) {
				this.#log(`playing the chime in ${roomId} failed: ${errorMessage(error)}`);
			}
		}
		if (call.transcript) this.#track(notice(roomId, `callheard:${key}`, `🎤 ${text}`));

		const note = room.note === undefined ? "" : `（${room.note}）`;
		room.note = undefined;
		const content = `[${formatStamp(utterance.startedAt, config.timezone)} 通話] ${note}${text}`;
		// The file name is unique per utterance; the same key again would get the same answer back.
		const answer = await this.#options.ask(roomId, `call:${key}`, content);
		if (!answer.ok) {
			if (answer.stopped) return;
			await notice(roomId, `callfail:${key}`, `通話の発言に答えられませんでした（${answer.reason}）。`);
			return;
		}
		// Written even when it is not spoken: the room keeps what the persona answered.
		if (call.transcript) this.#track(notice(roomId, `callanswer:${key}`, answer.text));
		if (room.turn !== turn) {
			room.note = OVERTAKEN;
			return;
		}
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

	async #play(roomId: string, room: RoomCall, wav: Buffer): Promise<Spoken> {
		const { outDir } = this.#options;
		await mkdir(outDir, { recursive: true });
		const id = randomUUID();
		const path = join(outDir, `call-${id}.wav`);
		await writeFile(path, wav);
		const spoken = new Promise<Spoken>((resolve) => room.spoken.set(id, resolve));
		try {
			this.#options.link.send({ type: "callSpeak", roomId, id, path });
			return await spoken;
		} finally {
			room.spoken.delete(id);
			await rm(path, { force: true });
		}
	}

	async #speak(roomId: string, room: RoomCall, turn: number, answer: string): Promise<void> {
		const { config, synthesizer } = this.#options;
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
		const said: string[] = [];
		for (const [i, part] of parts.entries()) {
			let wav: Buffer | undefined;
			try {
				wav = await made[i];
			} catch (error) {
				// The listener hears nothing more; the room gets the answer in text instead.
				const reason = errorMessage(error);
				this.#log(`making speech for a call in ${roomId} failed: ${reason}`);
				await this.#options.notice(
					roomId,
					`callvoice:${randomUUID()}`,
					call.transcript ? `音声を作れませんでした（${reason}）。` : `音声を作れなかったので文字で送ります（${reason}）。\n\n${answer}`,
				);
				return;
			}
			if (wav === undefined || !current()) {
				if (this.#rooms.get(roomId) === room) room.note = interrupted(said.join(""));
				return;
			}
			const result = await this.#play(roomId, room, wav);
			if (result.interrupted) {
				if (this.#rooms.get(roomId) === room) room.note = interrupted([...said, result.playedMs > 0 ? `${part}（の途中）` : ""].join(""));
				return;
			}
			said.push(part);
		}
	}
}

export const OVERTAKEN = "直前の返答は、読み上げる前にユーザーが話し始めたので伝わっていません";

function interrupted(heard: string): string {
	return heard === "" ? "直前の返答は、話し始める前に遮られました" : `直前の返答は「${heard}」まで話したところで遮られました`;
}

function fail(): never {
	throw new Error("calls need voice.call and voice.tts in config.json");
}
