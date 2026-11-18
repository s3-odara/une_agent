import { ffmpeg } from "./ffmpeg.ts";

/** A recording ready to send as a voice message. */
export type Speech = {
	/** Ogg Opus. */
	readonly ogg: Buffer;
	readonly durationMs: number;
	/** Loudness over time, each between 0 and 1. */
	readonly waveform: readonly number[];
};

export interface Synthesizer {
	/** `speaker` is a VOICEVOX style ID. */
	synthesize(text: string, speaker: number): Promise<Speech>;
	/** Mono 16-bit WAV at `sampleRate`, for playing into a call. */
	wav(text: string, speaker: number, sampleRate: number): Promise<Buffer>;
}

export type VoicevoxOptions = {
	/** The engine's base URL, e.g. `http://127.0.0.1:50021`. */
	readonly url: string;
	readonly timeoutMs?: number;
	readonly fetch?: typeof fetch;
	/** Turns WAV into Ogg Opus; tests replace it. */
	readonly encode?: (wav: Buffer) => Promise<Buffer>;
};

/** VOICEVOX Engine over its HTTP API: `audio_query` makes the reading and accents, `synthesis` makes the WAV. */
export class Voicevox implements Synthesizer {
	readonly #url: string;
	readonly #timeoutMs: number;
	readonly #fetch: typeof fetch;
	readonly #encode: (wav: Buffer) => Promise<Buffer>;

	constructor(options: VoicevoxOptions) {
		this.#url = options.url.replace(/\/+$/, "");
		this.#timeoutMs = options.timeoutMs ?? 120_000;
		this.#fetch = options.fetch ?? fetch;
		this.#encode = options.encode ?? wavToOggOpus;
	}

	async synthesize(text: string, speaker: number): Promise<Speech> {
		const wav = await this.#synthesis(text, speaker, undefined);
		const pcm = readWav(wav);
		return { ogg: await this.#encode(wav), durationMs: Math.round((pcm.samples.length / pcm.sampleRate) * 1000), waveform: waveform(pcm.samples) };
	}

	wav(text: string, speaker: number, sampleRate: number): Promise<Buffer> {
		return this.#synthesis(text, speaker, sampleRate);
	}

	async #synthesis(text: string, speaker: number, sampleRate: number | undefined): Promise<Buffer> {
		const signal = AbortSignal.timeout(this.#timeoutMs);
		let query = await this.#post(`/audio_query?${new URLSearchParams({ text, speaker: String(speaker) })}`, undefined, signal);
		if (sampleRate !== undefined) {
			// The engine resamples itself: 24 kHz by default.
			query = Buffer.from(JSON.stringify({ ...JSON.parse(query.toString("utf8")), outputSamplingRate: sampleRate, outputStereo: false }));
		}
		return this.#post(`/synthesis?${new URLSearchParams({ speaker: String(speaker) })}`, query, signal);
	}

	async #post(path: string, body: Buffer | undefined, signal: AbortSignal): Promise<Buffer> {
		const response = await this.#fetch(`${this.#url}${path}`, {
			method: "POST",
			signal,
			...(body === undefined ? {} : { body, headers: { "content-type": "application/json" } }),
		});
		if (!response.ok) throw new Error(`VOICEVOX ${path.split("?")[0]} answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
		return Buffer.from(await response.arrayBuffer());
	}
}

/** 16-bit PCM WAV, mono or the first channel, as samples between -1 and 1. */
export function readWav(wav: Buffer): { samples: Float32Array; sampleRate: number } {
	if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
	let channels = 1;
	let sampleRate = 0;
	let bits = 0;
	for (let offset = 12; offset + 8 <= wav.length; ) {
		const id = wav.toString("ascii", offset, offset + 4);
		const size = wav.readUInt32LE(offset + 4);
		const start = offset + 8;
		if (id === "fmt ") {
			channels = wav.readUInt16LE(start + 2);
			sampleRate = wav.readUInt32LE(start + 4);
			bits = wav.readUInt16LE(start + 14);
		} else if (id === "data") {
			if (bits !== 16 || sampleRate === 0) throw new Error(`unsupported WAV: ${bits} bits at ${sampleRate} Hz`);
			const end = Math.min(start + size, wav.length);
			const count = Math.floor((end - start) / (2 * channels));
			const samples = new Float32Array(count);
			for (let i = 0; i < count; i++) samples[i] = wav.readInt16LE(start + i * 2 * channels) / 32768;
			return { samples, sampleRate };
		}
		offset = start + size + (size % 2);
	}
	throw new Error("the WAV file has no data");
}

/** The peak of each of `buckets` equal slices, scaled so the loudest is 1, as clients draw a voice message. */
export function waveform(samples: Float32Array, buckets = 64): number[] {
	if (samples.length === 0) return [];
	const peaks: number[] = [];
	for (let b = 0; b < buckets; b++) {
		const from = Math.floor((b * samples.length) / buckets);
		const to = Math.max(from + 1, Math.floor(((b + 1) * samples.length) / buckets));
		let peak = 0;
		for (let i = from; i < to && i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i] as number));
		peaks.push(peak);
	}
	const loudest = Math.max(...peaks);
	return loudest === 0 ? peaks : peaks.map((peak) => Math.round((peak / loudest) * 1000) / 1000);
}

/** Matrix clients play voice messages as Ogg Opus. Needs the `ffmpeg` command. */
function wavToOggOpus(wav: Buffer): Promise<Buffer> {
	return ffmpeg(["-f", "wav", "-i", "pipe:0", "-c:a", "libopus", "-b:a", "32k", "-application", "voip", "-f", "ogg", "pipe:1"], wav);
}

/**
 * The answer as it should be read aloud. The model writes Markdown for the screen; read as is, a voice would say the
 * asterisks, the URLs and every cell of a table. The text reply still carries all of that.
 */
export function toSpeech(markdown: string, maxChars: number): string {
	return limitSpeech(speakable(markdown), maxChars);
}

/** Speech split where a sentence ends, so the first can play while the rest is still being made. */
export function sentences(speech: string): string[] {
	return speech.split(/(?<=[。！？!?])/).map((sentence) => sentence.trim()).filter((sentence) => sentence !== "");
}

function speakable(markdown: string): string {
	let text = markdown
		.replace(/```[\s\S]*?```/g, "（コードは文字で送りました）")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/<?https?:\/\/[^\s>)]+>?/g, "（リンク）")
		.replace(/^\s*\|?\s*:?-{3,}.*$/gm, "")
		.replace(/^\s{0,3}#{1,6}\s+/gm, "")
		.replace(/^\s*>\s?/gm, "")
		.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
		.replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
		.replace(/(^|[^*\w])[*_]([^*_\n]+)[*_](?![*\w])/g, "$1$2");
	text = text
		.split("\n")
		.map((line) => line.trim())
		// A table row: its cells, one after another.
		.map((line) => (line.includes("|") ? line.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()).filter((cell) => cell !== "").join("、") : line))
		.filter((line) => line !== "")
		.map((line) => (/[。！？!?、,.:：]$/.test(line) ? line : `${line}。`))
		.join("");
	return text;
}

function limitSpeech(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	// Cut at the last sentence end that fits, so the voice does not stop mid-word.
	const head = text.slice(0, maxChars);
	const end = Math.max(head.lastIndexOf("。"), head.lastIndexOf("！"), head.lastIndexOf("？"));
	return `${end > 0 ? head.slice(0, end + 1) : head}続きは文字で送りました。`;
}
