import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export type GatewayErrorCode = "tooLarge" | "permanent";

export class GatewayError extends Error {
	readonly code: GatewayErrorCode | undefined;

	constructor(message: string, code?: GatewayErrorCode) {
		super(message);
		this.name = "GatewayError";
		this.code = code;
	}
}

export function isPermanentGatewayError(error: unknown): boolean {
	return error instanceof GatewayError && (error.code === "tooLarge" || error.code === "permanent");
}

/** Keep in step with `gateway/src/ipc.rs`. */
export type GatewayEvent =
	| {
			readonly type: "ready";
			readonly userId: string;
			readonly deviceId: string /** The largest upload the homeserver accepts, when it tells. */;
			readonly uploadLimit?: number;
	  }
	| {
			readonly type: "message";
			readonly roomId: string;
			readonly eventId: string;
			/** For a media message, the file name or description the sender's client gave it. */
			readonly body: string;
			readonly ts: number;
			/** A voice or media message, downloaded and decrypted. Delete it once done. */
			readonly attachment?: {
				readonly path: string;
				readonly mimeType: string /** True only of a voice message. */;
				readonly voice?: boolean;
			};
			readonly replyTo?: string;
	  }
	| { readonly type: "undecryptable"; readonly roomId: string; readonly eventId: string }
	| { readonly type: "mediaFailed"; readonly roomId: string; readonly eventId: string; readonly reason: string }
	| { readonly type: "sent"; readonly requestId: string; readonly eventId: string }
	| {
			readonly type: "error";
			readonly requestId?: string;
			readonly message: string;
			readonly code?: GatewayErrorCode;
	  }
	/** Not stored by the gateway: one missed while it was down is not offered again. */
	| {
			readonly type: "reaction";
			readonly roomId: string;
			readonly eventId: string;
			readonly relatesTo: string;
			readonly key: string;
	  }
	/** Out of the call: `reason` is empty when it left normally. */
	| { readonly type: "callLeft"; readonly roomId: string; readonly reason: string }
	/** Somebody started speaking. Never while the bot talks: the gateway does not listen then. */
	| { readonly type: "callSpeech"; readonly roomId: string }
	/** One utterance as a 16 kHz mono WAV file. Delete it once done. */
	| { readonly type: "callUtterance"; readonly roomId: string; readonly path: string; readonly startedAt: number }
	/** Played to the end, or not played at all because it could not be. */
	| { readonly type: "callSpoken"; readonly roomId: string; readonly id: string };

/** Keep in step with `gateway/src/ipc.rs`. */
export type GatewayCommand =
	| { readonly type: "ack"; readonly eventId: string }
	| {
			readonly type: "send";
			readonly requestId: string;
			readonly roomId: string;
			/** Matrix transaction ID: the homeserver sends one event per ID, however often it is retried. */
			readonly txnId: string;
			readonly body: string;
			/** Sent as `m.notice` instead of `m.text`. */
			readonly notice?: boolean;
			/** Sent as an edit of this event. */
			readonly replaces?: string;
	  }
	| {
			/** Any kind of file; what the receiver's client makes of it follows the MIME type. */
			readonly type: "sendAttachment";
			readonly requestId: string;
			readonly roomId: string;
			readonly txnId: string;
			readonly path: string;
			readonly name: string;
			readonly mimeType: string;
			/** Of an image, when it is known. */
			readonly width?: number;
			readonly height?: number;
			/** Sent as a voice message, which must be an Ogg Opus file. */
			readonly voice?: { readonly durationMs: number; readonly waveform?: readonly number[] };
	  }
	| { readonly type: "typing"; readonly roomId: string; readonly on: boolean }
	/** Answered with `sent` or `error` under `requestId`. */
	| {
			readonly type: "react";
			readonly requestId: string;
			readonly roomId: string;
			readonly txnId: string;
			readonly eventId: string;
			readonly key: string;
	  }
	/** Plays a 48 kHz mono 16-bit WAV file in the call after what is queued; the gateway reads it at once. */
	| { readonly type: "callSpeak"; readonly roomId: string; readonly id: string; readonly path: string };

export interface GatewayLink {
	send(command: GatewayCommand): void;
	onEvent(listener: (event: GatewayEvent) => void): void;
}

export type GatewayProcess = GatewayLink & {
	/** `null` when a signal ended it. */
	readonly exited: Promise<number | null>;
	stop(): void;
};

/** The gateway's stderr is its log. */
export function spawnGateway(bin: string, args: readonly string[]): GatewayProcess {
	const child = spawn(bin, args, { stdio: ["pipe", "pipe", "inherit"] });
	const listeners: ((event: GatewayEvent) => void)[] = [];

	createInterface({ input: child.stdout }).on("line", (line) => {
		if (line.trim() === "") return;
		let event: GatewayEvent;
		try {
			event = JSON.parse(line) as GatewayEvent;
		} catch {
			console.error(`gateway: ignoring a line that is not JSON: ${line}`);
			return;
		}
		for (const listener of listeners) listener(event);
	});

	const exited = new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => resolve(code));
	});
	// A write after the gateway died fails here instead of throwing from `send()`; `exited` reports the death.
	child.stdin.on("error", () => {});

	return {
		exited,
		send: (command) => {
			if (child.stdin.writable) child.stdin.write(`${JSON.stringify(command)}\n`);
		},
		onEvent: (listener) => {
			listeners.push(listener);
		},
		// Closing stdin asks the gateway to finish; it exits on end of input.
		stop: () => child.stdin.end(),
	};
}
