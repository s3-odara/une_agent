import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { CodeRequests } from "../src/codes.ts";
import type { MessageHandler } from "../src/rooms.ts";
import { agentEnv } from "./env.ts";
import { samplePdf } from "./pdf-fixture.ts";
import { answer, call, everything, inputImages, instructionsOf, lastInput, message, type Request } from "./fakes.ts";

const ROOM = "!a:example.org";
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), Buffer.from([0, 0, 2, 128, 0, 0, 1, 224])]);

test("a picture goes to the model as an image, and is kept on disk with its path", async () => {
	await using env = await agentEnv();
	const requests: Request[] = [];
	env.faux.setResponses([answer("きれいな写真ですね", requests)]);
	const bridge = env.bridge();
	const path = join(env.dir, "photo.png");
	writeFileSync(path, PNG);
	env.link.emit({ type: "message", roomId: ROOM, eventId: "$p", body: "photo.png", ts: 0, attachment: { path, mimeType: "image/png" } });
	await bridge.idle();

	assert.deepEqual(inputImages(requests[0]!), [{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }]);
	assert.match(lastInput(requests[0]!), /画像添付\] photo\.png（image\/png、\d+ B）/);
	assert.match(lastInput(requests[0]!), /保存先: /);
	assert.equal(existsSync(path), true);
});

test("a short text file is carried into the conversation, and kept on disk", async () => {
	await using env = await agentEnv();
	const requests: Request[] = [];
	env.faux.setResponses([answer("読みました", requests)]);
	const bridge = env.bridge();
	const path = join(env.dir, "notes.txt");
	writeFileSync(path, "買い物リスト\n牛乳");
	env.link.emit({ type: "message", roomId: ROOM, eventId: "$t", body: "notes.txt", ts: 0, attachment: { path, mimeType: "text/plain" } });
	await bridge.idle();

	const input = lastInput(requests[0]!);
	assert.match(input, /ファイル添付\] notes\.txt（text\/plain、\d+ B）/);
	assert.match(input, /保存先: /);
	assert.match(input, /買い物リスト\n牛乳$/);
	assert.equal(existsSync(path), true);
});

test("a long text file is announced by path without inlining its body", async () => {
	await using env = await agentEnv();
	const requests: Request[] = [];
	env.faux.setResponses([answer("確認します", requests)]);
	const bridge = env.bridge();
	const path = join(env.dir, "huge.txt");
	writeFileSync(path, "あいうえお\n".repeat(1000));
	env.link.emit({ type: "message", roomId: ROOM, eventId: "$t2", body: "huge.txt", ts: 0, attachment: { path, mimeType: "text/plain" } });
	await bridge.idle();

	const input = lastInput(requests[0]!);
	assert.match(input, /保存先: /);
	assert.match(input, /1000 行/);
	assert.doesNotMatch(input, /あいうえお/);
	assert.equal(existsSync(path), true);
});

test("a file of a kind the conversation cannot carry is only announced, and kept for the model to read", async () => {
	await using env = await agentEnv();
	const requests: Request[] = [];
	env.faux.setResponses([answer("どこにありますか", requests)]);
	const bridge = env.bridge();
	const path = join(env.dir, "data.zip");
	writeFileSync(path, "PK");
	env.link.emit({ type: "message", roomId: ROOM, eventId: "$f", body: "data.zip", ts: 0, attachment: { path, mimeType: "application/zip" } });
	await bridge.idle();

	const input = lastInput(requests[0]!);
	assert.match(input, /ファイル添付\] data\.zip（application\/zip、2 B）/);
	assert.match(input, /保存先: /);
	assert.equal(existsSync(path), true);
});

test("a failed media download tells the room why as a notice", async () => {
	await using env = await agentEnv();
	const bridge = env.bridge();
	env.link.emit({ type: "mediaFailed", roomId: ROOM, eventId: "$big", reason: "the attachment is 25000000 bytes, more than 20971520" });
	await bridge.idle();

	const [notice] = env.link.of("send");
	assert.equal(notice?.notice, true);
	assert.match(notice?.body ?? "", /添付ファイルを取得できませんでした/);
	assert.match(notice?.body ?? "", /25000000/);
});

const withPoppler = process.env.AGENT_POPPLER_BIN ? test : test.skip;

withPoppler("a short PDF is carried into the conversation as its text, and kept for read_pdf", async () => {
	await using env = await agentEnv();
	const requests: Request[] = [];
	env.faux.setResponses([answer("読みました", requests)]);
	const bridge = env.bridge();
	const path = join(env.dir, "doc.pdf");
	writeFileSync(path, samplePdf());
	env.link.emit({ type: "message", roomId: ROOM, eventId: "$d", body: "doc.pdf", ts: 0, attachment: { path, mimeType: "application/pdf" } });
	await bridge.idle();

	const input = lastInput(requests[0]!);
	assert.match(input, /PDF添付\] doc\.pdf（application\/pdf、\d+(\.\d)? (KB|B)）/);
	assert.match(input, /--- PDF 1 ページ目 \/ 全 2 ページ ---/);
	assert.match(input, /left column/);
	assert.equal(existsSync(path), true);
});

withPoppler("a long PDF is announced by path without inlining its text", async () => {
	await using env = await agentEnv();
	const requests: Request[] = [];
	env.faux.setResponses([answer("確認します", requests)]);
	const bridge = env.bridge();
	const path = join(env.dir, "long.pdf");
	writeFileSync(path, samplePdf("LongText ".repeat(350)));
	env.link.emit({ type: "message", roomId: ROOM, eventId: "$d2", body: "long.pdf", ts: 0, attachment: { path, mimeType: "application/pdf" } });
	await bridge.idle();

	const input = lastInput(requests[0]!);
	assert.match(input, /PDF添付\] long\.pdf/);
	assert.match(input, /保存先: /);
	assert.match(input, /read_pdf/);
	assert.doesNotMatch(input, /LongText/);
	assert.equal(existsSync(path), true);
});

withPoppler("a PDF that cannot be read is answered with why, and kept", async () => {
	await using env = await agentEnv();
	env.faux.setResponses([fauxAssistantMessage("わかりました")]);
	const bridge = env.bridge();
	const path = join(env.dir, "doc.pdf");
	writeFileSync(path, "not a pdf");
	env.link.emit({ type: "message", roomId: ROOM, eventId: "$d", body: "doc.pdf", ts: 0, attachment: { path, mimeType: "application/pdf" } });
	await bridge.idle();

	assert.match(env.link.of("send").map((send) => send.body).find((body) => body !== "") ?? "", /ファイルを処理できませんでした/);
	assert.equal(existsSync(path), true);
});

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

test("!new while an answer is being written stops it, and nothing is sent for the stopped answer", async () => {
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
		[["cmd:$2", true]],
	);
});

test("!help lists the commands of every handler with this room's persona and model, and does not reach the model", async () => {
	await using env = await agentEnv({ config: { personas: { talker: { soul: "soul.md", model: "faux/own" } }, defaultPersona: "talker" } });
	const handler: MessageHandler = { help: ["- !frob … frobnicate"], onMessage: () => ({ handled: false }) };
	const bridge = env.bridge({ handlers: [handler] });

	env.link.emit(message(ROOM, "$1", "!help"));
	await bridge.idle();

	const [reply] = env.link.of("send");
	assert.equal(reply?.notice, true);
	assert.match(reply?.body ?? "", /!frob/);
	assert.match(reply?.body ?? "", /talker/);
	assert.match(reply?.body ?? "", /faux\/own/);
	assert.equal(env.faux.state.callCount, 0);
	assert.deepEqual(env.link.of("ack").map((ack) => ack.eventId), ["$1"]);
});

test("!help while a code is awaited leaves the request open for the code", async () => {
	await using env = await agentEnv();
	let bridge: ReturnType<typeof env.bridge> | undefined;
	const codes = new CodeRequests({ notice: (roomId, txnId, body) => bridge!.post(roomId, txnId, body) });
	bridge = env.bridge({ handlers: [codes] });
	const outcome = codes.ask(ROOM, "k", "コードを送ってください");

	env.link.emit(message(ROOM, "$1", "!help"));
	await bridge.idle();
	env.link.emit(message(ROOM, "$2", "123456"));
	await bridge.idle();

	assert.deepEqual(await outcome, { ok: true, code: "123456" });
});

for (const { name, config, room, level } of [
	{ name: "the default", config: { thinking: "high" }, room: ROOM, level: "high" },
	{
		name: "a persona's own over the default",
		config: { thinking: "high", personas: { default: "soul.md", deep: { soul: "soul.md", thinking: "low" } }, rooms: { "!deep:example.org": "deep" } },
		room: "!deep:example.org",
		level: "low",
	},
]) {
	test(`the thinking level the model is asked for is ${name}`, async () => {
		await using env = await agentEnv({ config });
		const asked: unknown[] = [];
		env.faux.setResponses([
			(_context, options) => {
				asked.push(options?.reasoning);
				return fauxAssistantMessage("ok");
			},
		]);
		const bridge = env.bridge();

		env.link.emit(message(room, "$1", "hi"));
		await bridge.idle();

		assert.deepEqual(asked, [level]);
	});
}

/** A tool that runs until the test lets it finish, so messages can arrive while the agent works. */
function gated() {
	const { promise: running, resolve: started } = Promise.withResolvers<void>();
	const { promise: released, resolve: release } = Promise.withResolvers<void>();
	const extension = defineExtension({
		name: "gate",
		tools: [
			defineTool({
				name: "gate",
				description: "Waits.",
				parameters: obj({}),
				execute: async () => {
					started();
					await released;
					return { output: [{ type: "text" as const, text: "done" }] };
				},
			}),
		],
	});
	return { extension, running, release };
}

test("a message sent while the agent works joins that work: the model sees it before answering, and one answer is sent", async () => {
	const gate = gated();
	await using env = await agentEnv({ extensions: () => [gate.extension] });
	const requests: Request[] = [];
	env.faux.setResponses([call("gate", {}), answer("両方に答えます", requests)]);
	const bridge = env.bridge();

	env.link.emit(message(ROOM, "$1", "first"));
	await gate.running;
	env.link.emit(message(ROOM, "$2", "second"));
	await env.link.waitFor("ack", (ack) => ack.eventId === "$2");
	gate.release();
	await bridge.idle();

	assert.match(lastInput(requests[0]!), /second$/);
	assert.deepEqual(
		env.link.of("send").filter((send) => !send.notice).map((send) => send.body),
		["両方に答えます"],
	);
	assert.equal(env.faux.state.callCount, 2);
});

test("a run that a later message joined and that then failed is told once", async () => {
	const gate = gated();
	await using env = await agentEnv({ extensions: () => [gate.extension] });
	env.faux.setResponses([
		call("gate", {}),
		() => {
			throw new Error("the model is down");
		},
	]);
	const bridge = env.bridge();

	env.link.emit(message(ROOM, "$1", "first"));
	await gate.running;
	env.link.emit(message(ROOM, "$2", "second"));
	await env.link.waitFor("ack", (ack) => ack.eventId === "$2");
	gate.release();
	await bridge.idle();

	assert.equal(env.link.of("send").filter((send) => send.body.includes("the model is down")).length, 1);
});
