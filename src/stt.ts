import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { request } from "node:http";

/** Turns a recording into text. */
export interface Transcriber {
	transcribe(path: string): Promise<string>;
}

export type WhisperServerOptions = {
	/** The `whisper-server` binary of whisper.cpp (`stt/install.sh` builds it). */
	readonly server: string;
	readonly model: string;
	/** The Silero VAD model. Without VAD, whisper.cpp dropped a whole sentence at a 30-second boundary. */
	readonly vadModel: string;
	readonly threads: number;
	readonly beamSize: number;
	/** Language code such as `ja`, or `auto`. */
	readonly language: string;
	/** Padding added around each stretch of speech VAD finds. The default 30 ms made the model invent a word in trailing silence. */
	readonly vadSpeechPadMs: number;
	/** The server listens here, so no port is taken and nothing else on the network can reach it. */
	readonly socketPath: string;
	/** The model holds about a gigabyte of (video) memory; a server nobody used for this long is stopped. */
	readonly idleMs: number;
	readonly startTimeoutMs?: number;
	readonly requestTimeoutMs?: number;
	/** Turns any recording into 16 kHz mono WAV, which is all the server reads; tests replace it. */
	readonly toWav?: (path: string) => Promise<Buffer>;
};

type Server = { readonly child: ChildProcess; ready: Promise<void>; readonly log: string[]; exited: boolean };

/**
 * whisper.cpp's `whisper-server`, started at the first recording and stopped when idle. It loads in well under a
 * second, so stopping it costs little. Requests go over a Unix socket; the server runs one inference at a time.
 */
export class WhisperServer implements Transcriber {
	readonly #options: WhisperServerOptions;
	readonly #toWav: (path: string) => Promise<Buffer>;
	#server: Server | undefined;
	#busy = 0;
	#idleTimer: NodeJS.Timeout | undefined;

	constructor(options: WhisperServerOptions) {
		this.#options = options;
		this.#toWav = options.toWav ?? toWav16k;
	}

	async transcribe(path: string): Promise<string> {
		this.#busy++;
		clearTimeout(this.#idleTimer);
		try {
			const wav = await this.#toWav(path);
			const server = this.#start();
			await server.ready;
			const reply = await this.#post(wav);
			if (typeof reply.text === "string") return reply.text.trim();
			throw new Error(`the speech recognizer failed: ${reply.error ?? JSON.stringify(reply).slice(0, 200)}`);
		} finally {
			if (--this.#busy === 0 && this.#server !== undefined) {
				this.#idleTimer = setTimeout(() => this.close(), this.#options.idleMs);
				this.#idleTimer.unref();
			}
		}
	}

	#start(): Server {
		if (this.#server !== undefined && !this.#server.exited) return this.#server;
		const o = this.#options;
		// A socket file left by a server that was killed would make the new one fail to bind.
		rmSync(o.socketPath, { force: true });
		const args = ["-m", o.model, "-t", String(o.threads), "-bs", String(o.beamSize), "-l", o.language, "-nt"];
		args.push("--vad", "-vm", o.vadModel, "-vp", String(o.vadSpeechPadMs), "--host", o.socketPath);
		const child = spawn(o.server, args, { stdio: ["ignore", "ignore", "pipe"] });
		// It logs every request at length; keep the tail for when something goes wrong.
		const log: string[] = [];
		child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
			log.push(...chunk.split("\n").filter((line) => line.trim() !== ""));
			log.splice(0, Math.max(0, log.length - 20));
		});
		const server: Server = { child, log, exited: false, ready: Promise.resolve() };
		const exited = new Promise<never>((_, reject) => {
			const fail = (reason: string) => {
				server.exited = true;
				reject(new Error(`the speech recognizer ${reason}${log.length === 0 ? "" : `: ${log.slice(-3).join(" / ")}`}`));
			};
			child.once("error", (error) => fail(`could not be started (${o.server}): ${error.message}`));
			child.once("exit", (code, signal) => fail(`exited (${signal ?? code})`));
		});
		exited.catch(() => {});
		server.ready = Promise.race([this.#waitHealthy(server, o.startTimeoutMs ?? 60_000), exited]);
		server.ready.catch(() => child.kill());
		this.#server = server;
		return server;
	}

	async #waitHealthy(server: Server, timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		// Once it has exited, `exited` has already given the reason.
		while (Date.now() < deadline && !server.exited) {
			const healthy = await this.#call("GET", "/health").then(
				(response) => response.status === 200,
				() => false,
			);
			if (healthy) return;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error("the speech recognizer did not start in time");
	}

	async #post(wav: Buffer): Promise<{ text?: unknown; error?: unknown }> {
		const boundary = `----agent-${randomUUID()}`;
		const body = Buffer.concat([
			Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
			wav,
			Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n--${boundary}--\r\n`),
		]);
		const response = await this.#call("POST", "/inference", body, `multipart/form-data; boundary=${boundary}`);
		try {
			return JSON.parse(response.body) as { text?: unknown; error?: unknown };
		} catch {
			throw new Error(`the speech recognizer answered ${response.status}: ${response.body.slice(0, 200)}`);
		}
	}

	#call(method: string, path: string, body?: Buffer, contentType?: string): Promise<{ status: number; body: string }> {
		return new Promise((resolve, reject) => {
			const req = request(
				{
					socketPath: this.#options.socketPath,
					path,
					method,
					timeout: this.#options.requestTimeoutMs ?? 300_000,
					headers: body === undefined ? {} : { "content-type": contentType, "content-length": body.length },
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (chunk: Buffer) => chunks.push(chunk));
					res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
					res.on("error", reject);
				},
			);
			req.on("timeout", () => req.destroy(new Error("the speech recognizer did not answer in time")));
			req.on("error", reject);
			req.end(body);
		});
	}

	/** Stops the server; the next recording starts it again. */
	close(): void {
		clearTimeout(this.#idleTimer);
		const server = this.#server;
		this.#server = undefined;
		if (server !== undefined && !server.exited) server.child.kill();
	}
}

/** Any recording ffmpeg can read, as 16 kHz mono 16-bit WAV. Needs the `ffmpeg` command. */
export function toWav16k(path: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn("ffmpeg", ["-nostdin", "-loglevel", "error", "-i", path, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-f", "wav", "pipe:1"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
		child.once("error", (error) => reject(new Error(`ffmpeg could not be started: ${error.message}`)));
		child.once("close", (code) => {
			if (code === 0) resolve(Buffer.concat(out));
			else reject(new Error(`ffmpeg could not decode the audio: ${Buffer.concat(err).toString().trim()}`));
		});
	});
}
