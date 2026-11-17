import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** Lines the gateway writes. Keep in step with `gateway/src/ipc.rs`. */
export type GatewayEvent =
	| { readonly type: "ready"; readonly userId: string; readonly deviceId: string }
	| {
			readonly type: "message";
			readonly roomId: string;
			readonly eventId: string;
			readonly sender: string;
			/** The text; for audio, the file name or description the sender's client gave it. */
			readonly body: string;
			readonly ts: number;
			/** Present for an audio message: the recording, downloaded and decrypted. Delete it once done. */
			readonly audio?: { readonly path: string; readonly mimetype?: string; readonly voice: boolean };
	  }
	| { readonly type: "undecryptable"; readonly roomId: string; readonly eventId: string; readonly sender: string }
	| { readonly type: "sent"; readonly requestId: string; readonly eventId: string }
	| { readonly type: "error"; readonly requestId?: string; readonly message: string }
	/** The allowed users (not the bot) now in the room's call; empty once they have all left. */
	| { readonly type: "callMembers"; readonly roomId: string; readonly userIds: readonly string[] }
	| { readonly type: "callJoined"; readonly roomId: string }
	/** Out of the call: `reason` is empty when it left as asked or because everyone else did. */
	| { readonly type: "callLeft"; readonly roomId: string; readonly reason: string }
	/** Somebody started speaking; the gateway has already stopped whatever the bot was saying. */
	| { readonly type: "callSpeech"; readonly roomId: string; readonly userId: string }
	/** One utterance as a 16 kHz mono WAV file. Delete it once done. */
	| {
			readonly type: "callUtterance";
			readonly roomId: string;
			readonly userId: string;
			readonly path: string;
			readonly startedAt: number;
			readonly durationMs: number;
	  }
	/** A `callSpeak` finished, or was cut off after `playedMs`. */
	| { readonly type: "callSpoken"; readonly roomId: string; readonly id: string; readonly playedMs: number; readonly interrupted: boolean };

/** How the gateway cuts a participant's audio into utterances. Keep in step with `VadConfig` in `gateway/src/audio.rs`. */
export type CallVad = {
	/** The VAD's score (0 to 1) from which a 16 ms frame counts as speech. */
	readonly threshold: number;
	/** Speech must last this long to start an utterance, and to stop the bot talking. */
	readonly startMs: number;
	/** This much silence ends an utterance. */
	readonly endSilenceMs: number;
	/** Utterances with less speech are dropped. */
	readonly minSpeechMs: number;
	/** Longer utterances are passed on in parts. */
	readonly maxMs: number;
	readonly preRollMs: number;
};

/** Lines the gateway reads. */
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
	  }
	| {
			/** Sends an Ogg Opus file as a voice message. */
			readonly type: "sendVoice";
			readonly requestId: string;
			readonly roomId: string;
			readonly txnId: string;
			readonly path: string;
			readonly durationMs: number;
			readonly waveform?: readonly number[];
	  }
	| { readonly type: "typing"; readonly roomId: string; readonly on: boolean }
	| { readonly type: "joinCall"; readonly roomId: string; readonly vad: CallVad }
	| { readonly type: "leaveCall"; readonly roomId: string }
	/** Plays a 48 kHz mono 16-bit WAV file in the call after what is queued; the gateway reads it at once. */
	| { readonly type: "callSpeak"; readonly roomId: string; readonly id: string; readonly path: string }
	| { readonly type: "callHush"; readonly roomId: string };

export interface GatewayLink {
	send(command: GatewayCommand): void;
	onEvent(listener: (event: GatewayEvent) => void): void;
}

export type GatewayProcess = GatewayLink & {
	/** Settles when the gateway process has exited, with its exit code (`null` when a signal ended it). */
	readonly exited: Promise<number | null>;
	stop(): void;
};

/** Runs the gateway as a child process and speaks JSON Lines over its stdin and stdout. Its stderr is its log. */
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
