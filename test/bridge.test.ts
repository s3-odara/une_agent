import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { agentEnv } from "./env.ts";
import { answer, everything, instructionsOf, lastInput, message, type Request } from "./fakes.ts";

const ROOM = "!a:example.org";

test("a message is answered in its room, and acked", async () => {
	await using env = await agentEnv();
	env.faux.setResponses([fauxAssistantMessage("hello back")]);
	const bridge = env.bridge();

	env.link.emit(message(ROOM, "$1", "hello"));
	await bridge.idle();

	assert.deepEqual(
		env.link.of("send").map((send) => [send.roomId, send.body, send.notice]),
		[[ROOM, "hello back", false]],
	);
	assert.deepEqual(env.link.of("ack"), [{ type: "ack", eventId: "$1" }]);
});

test("a message reaches the model with when it was sent, in the user's time zone", async () => {
	await using env = await agentEnv({ config: { timezone: "Asia/Tokyo" } });
	const requests: Request[] = [];
	env.faux.setResponses([answer("ok", requests)]);
	const bridge = env.bridge();

	env.link.emit(message(ROOM, "$1", "明日の予定は?", Date.UTC(2026, 10, 17, 0, 0)));
	await bridge.idle();

	// Midnight UTC is nine in the morning in Tokyo.
	assert.match(lastInput(requests[0]!), /2026-11-17[^\]]*09:00[^\]]*\] 明日の予定は\?$/);
});

test("a message offered again after a lost ack is acked again but answered only once", async () => {
	await using env = await agentEnv();
	env.faux.setResponses([fauxAssistantMessage("hello back")]);
	const bridge = env.bridge();

	env.link.emit(message(ROOM, "$1", "hello"));
	await bridge.idle();
	env.link.emit(message(ROOM, "$1", "hello"));
	await bridge.idle();

	assert.equal(env.link.of("send").length, 1);
	assert.equal(env.link.of("ack").length, 2);
	assert.equal(env.faux.state.callCount, 1);
});

test("an answer that could not be sent is sent by the next process, as the same event, without asking the model again", async () => {
	await using env = await agentEnv();
	env.faux.setResponses([fauxAssistantMessage("kept answer")]);
	env.link.failSends = true;
	const first = env.bridge({ sendRetryDelaysMs: [] });
	env.link.emit(message(ROOM, "$1", "hello"));
	await first.idle();
	const attempt = env.link.of("send")[0];

	await env.restart();
	const second = env.bridge();
	await second.idle();

	const sent = env.link.of("send");
	assert.deepEqual(
		sent.map((send) => send.body),
		["kept answer"],
	);
	// The homeserver makes one event of one transaction ID, so a send the first process did get through is not doubled.
	assert.equal(sent[0]?.txnId, attempt?.txnId);
	assert.equal(env.faux.state.callCount, 1);
});

test("each room speaks as its own persona", async () => {
	await using env = await agentEnv({
		souls: { "calm.md": "SOUL-CALM", "blunt.md": "SOUL-BLUNT" },
		config: { personas: { calm: "calm.md", blunt: "blunt.md" }, defaultPersona: "calm", rooms: { "!blunt:example.org": "blunt" } },
	});
	const requests: Request[] = [];
	env.faux.setResponses([answer("calm", requests), answer("blunt", requests)]);
	const bridge = env.bridge();

	env.link.emit(message("!calm:example.org", "$1", "hi"));
	await bridge.idle();
	env.link.emit(message("!blunt:example.org", "$2", "hi"));
	await bridge.idle();

	const [calm, blunt] = requests.map(instructionsOf);
	assert.match(calm ?? "", /SOUL-CALM/);
	assert.doesNotMatch(calm ?? "", /SOUL-BLUNT/);
	assert.match(blunt ?? "", /SOUL-BLUNT/);
});

test("what is said in one room is not in another room's conversation", async () => {
	await using env = await agentEnv();
	const requests: Request[] = [];
	env.faux.setResponses([answer("ok", requests), answer("ok", requests)]);
	const bridge = env.bridge();

	env.link.emit(message("!one:example.org", "$1", "only-in-one"));
	await bridge.idle();
	env.link.emit(message("!two:example.org", "$2", "in-two"));
	await bridge.idle();

	assert.doesNotMatch(everything(requests[1]!), /only-in-one/);
});

test("a run that fails is told to the room as a notice", async () => {
	await using env = await agentEnv();
	env.faux.setResponses([
		() => {
			throw new Error("the model is down");
		},
	]);
	const bridge = env.bridge();

	env.link.emit(message(ROOM, "$1", "hello"));
	await bridge.idle();

	assert.deepEqual(
		env.link.of("send").map((send) => [send.roomId, send.notice]),
		[[ROOM, true]],
	);
});

test("after !new the model no longer sees what was said before, and !new itself does not reach it", async () => {
	await using env = await agentEnv();
	const requests: Request[] = [];
	env.faux.setResponses([answer("ok", requests), answer("ok", requests)]);
	const bridge = env.bridge();

	env.link.emit(message(ROOM, "$1", "before-reset"));
	await bridge.idle();
	env.link.emit(message(ROOM, "$2", "!new"));
	await bridge.idle();
	env.link.emit(message(ROOM, "$3", "after-reset"));
	await bridge.idle();

	assert.equal(requests.length, 2);
	assert.doesNotMatch(everything(requests[1]!), /before-reset|!new/);
	assert.match(lastInput(requests[1]!), /after-reset/);
	assert.ok(env.link.of("send").some((send) => send.notice && send.txnId === "cmd:$2"));
	assert.deepEqual(env.link.of("ack").map((ack) => ack.eventId), ["$1", "$2", "$3"]);
});

test("!new in a room that has not talked yet starts it fresh all the same", async () => {
	await using env = await agentEnv();
	const bridge = env.bridge();

	env.link.emit(message(ROOM, "$1", "!new"));
	await bridge.idle();

	assert.equal(env.faux.state.callCount, 0);
	assert.equal(env.link.of("send").filter((send) => send.notice).length, 1);
});

test("!new while an answer is being written stops it: the message gets a notice instead of an answer", async () => {
	await using env = await agentEnv();
	const { promise: writing, resolve: started } = Promise.withResolvers<void>();
	env.faux.setResponses([
		(_context, options) =>
			new Promise((_resolve, reject) => {
				started();
				options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
			}),
	]);
	const bridge = env.bridge();

	env.link.emit(message(ROOM, "$1", "a long question"));
	await writing;
	env.link.emit(message(ROOM, "$2", "!new"));
	await bridge.idle();

	assert.deepEqual(
		env.link.of("send").map((send) => [send.txnId, send.notice]),
		[
			["reply:$1", true],
			["cmd:$2", true],
		],
	);
});
