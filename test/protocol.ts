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
const vad = { threshold: 0.5, startMs: 200, endSilenceMs: 700, maxMs: 20_000, preRollMs: 250 };

export const events: Examples<GatewayEvent> = {
	ready: [{ type: "ready", userId: "@agent:example.org", deviceId: "DEVICE" }],
	message: [
		{ type: "message", roomId: room, eventId: "$text", body: "hi", ts: 5 },
		{ type: "message", roomId: room, eventId: "$voice", body: "Voice message.ogg", ts: 6, attachment: { path: "/d/v.ogg", mimeType: "audio/ogg", voice: true } },
		{ type: "message", roomId: room, eventId: "$file", body: "song.mp3", ts: 7, attachment: { path: "/d/f.audio", mimeType: "audio/mpeg" } },
		{ type: "message", roomId: room, eventId: "$reply", body: "AB12CD", ts: 8, replyTo: "$p" },
	],
	undecryptable: [{ type: "undecryptable", roomId: room, eventId: "$e" }],
	sent: [{ type: "sent", requestId: "q", eventId: "$s" }],
	error: [
		{ type: "error", requestId: "q", message: "boom" },
		{ type: "error", message: "boom" },
	],
	reaction: [{ type: "reaction", roomId: room, eventId: "$x", relatesTo: "$p", key: "✅" }],
	callMembers: [{ type: "callMembers", roomId: room, userIds: [me] }],
	callJoined: [{ type: "callJoined", roomId: room }],
	callLeft: [{ type: "callLeft", roomId: room, reason: "no LiveKit focus" }],
	callSpeech: [{ type: "callSpeech", roomId: room }],
	callUtterance: [{ type: "callUtterance", roomId: room, path: "/d/u.wav", startedAt: 5 }],
	callSpoken: [{ type: "callSpoken", roomId: room, id: "s1" }],
};

export const commands: Examples<GatewayCommand> = {
	ack: [{ type: "ack", eventId: "$e" }],
	send: [
		{ type: "send", requestId: "q", roomId: room, txnId: "t", body: "hello", notice: true },
		{ type: "send", requestId: "q", roomId: room, txnId: "t", body: "hello again", notice: true, replaces: "$p" },
	],
	sendAttachment: [
		{ type: "sendAttachment", requestId: "q", roomId: room, txnId: "t", path: "/d/v.ogg", name: "voice-message.ogg", mimeType: "audio/ogg", voice: { durationMs: 1500, waveform: [0.5, 0.25] } },
		{ type: "sendAttachment", requestId: "q", roomId: room, txnId: "t", path: "/d/s.png", name: "screenshot.png", mimeType: "image/png", width: 1280, height: 800 },
		{ type: "sendAttachment", requestId: "q", roomId: room, txnId: "t", path: "/d/f.bin", name: "report.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
	],
	typing: [{ type: "typing", roomId: room, on: true }],
	react: [{ type: "react", requestId: "q", roomId: room, txnId: "t", eventId: "$p", key: "❌" }],
	joinCall: [{ type: "joinCall", roomId: room, vad }],
	leaveCall: [{ type: "leaveCall", roomId: room }],
	callSpeak: [{ type: "callSpeak", roomId: room, id: "s1", path: "/d/s1.wav" }],
};

export function protocolJson(): { events: GatewayEvent[]; commands: GatewayCommand[] } {
	return { events: Object.values(events).flat(), commands: Object.values(commands).flat() };
}
