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
	| { readonly type: "error"; readonly requestId?: string; readonly message: string };

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
	| { readonly type: "typing"; readonly roomId: string; readonly on: boolean };

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
