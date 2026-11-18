import type { GatewayCommand, GatewayEvent } from "../src/gateway.ts";

/**
 * One or more lines of every type the gateway and the agent exchange, as the agent's types say they look, with every
 * optional field present at least once. `protocol.json` holds the same lines for the gateway's tests to read: the two
 * sides are checked against one set of lines instead of each against its own idea of the other.
 */
type Examples<T extends { type: string }> = { readonly [K in T["type"]]: readonly Extract<T, { type: K }>[] };

const room = "!r:example.org";
const me = "@me:example.org";
// Values a 32-bit float holds exactly, so the gateway writes them back as they were.
const vad = { threshold: 0.5, startMs: 200, endSilenceMs: 700, minSpeechMs: 300, maxMs: 20_000, preRollMs: 250 };

export const events: Examples<GatewayEvent> = {
	ready: [{ type: "ready", userId: "@agent:example.org", deviceId: "DEVICE" }],
	message: [
		{ type: "message", roomId: room, eventId: "$text", sender: me, body: "hi", ts: 5 },
		{ type: "message", roomId: room, eventId: "$voice", sender: me, body: "Voice message.ogg", ts: 6, audio: { path: "/d/v.ogg", mimetype: "audio/ogg", voice: true } },
		{ type: "message", roomId: room, eventId: "$file", sender: me, body: "song.mp3", ts: 7, audio: { path: "/d/f.audio", voice: false } },
		{ type: "message", roomId: room, eventId: "$reply", sender: me, body: "AB12CD", ts: 8, replyTo: "$p" },
	],
	undecryptable: [{ type: "undecryptable", roomId: room, eventId: "$e", sender: me }],
	sent: [{ type: "sent", requestId: "q", eventId: "$s" }],
	error: [
		{ type: "error", requestId: "q", message: "boom" },
		{ type: "error", message: "boom" },
	],
	reaction: [{ type: "reaction", roomId: room, eventId: "$x", relatesTo: "$p", key: "✅", sender: me }],
	callMembers: [{ type: "callMembers", roomId: room, userIds: [me] }],
	callJoined: [{ type: "callJoined", roomId: room }],
	callLeft: [{ type: "callLeft", roomId: room, reason: "no LiveKit focus" }],
	callSpeech: [{ type: "callSpeech", roomId: room, userId: me }],
	callUtterance: [{ type: "callUtterance", roomId: room, userId: me, path: "/d/u.wav", startedAt: 5, durationMs: 1200 }],
	callSpoken: [{ type: "callSpoken", roomId: room, id: "s1", playedMs: 900, interrupted: true }],
};

export const commands: Examples<GatewayCommand> = {
	ack: [{ type: "ack", eventId: "$e" }],
	send: [{ type: "send", requestId: "q", roomId: room, txnId: "t", body: "hello", notice: true }],
	sendVoice: [{ type: "sendVoice", requestId: "q", roomId: room, txnId: "t", path: "/d/v.ogg", durationMs: 1500, waveform: [0.5, 0.25] }],
	sendImage: [{ type: "sendImage", requestId: "q", roomId: room, txnId: "t", path: "/d/s.png", name: "screenshot.png", width: 1280, height: 800 }],
	typing: [{ type: "typing", roomId: room, on: true }],
	react: [{ type: "react", requestId: "q", roomId: room, txnId: "t", eventId: "$p", key: "❌" }],
	joinCall: [{ type: "joinCall", roomId: room, vad }],
	leaveCall: [{ type: "leaveCall", roomId: room }],
	callSpeak: [{ type: "callSpeak", roomId: room, id: "s1", path: "/d/s1.wav" }],
};

/** The lines as `protocol.json` holds them. */
export function protocolJson(): { events: GatewayEvent[]; commands: GatewayCommand[] } {
	return { events: Object.values(events).flat(), commands: Object.values(commands).flat() };
}
