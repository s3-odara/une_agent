import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import type { GatewayCommand } from "../src/gateway.ts";
import { TOOL_DONE, TOOL_FAILED, TOOL_RUNNING } from "../src/progress.ts";
import { agentEnv } from "./env.ts";
import { type FakeLink, call, message } from "./fakes.ts";

const ROOM = "!a:example.org";

type Send = Extract<GatewayCommand, { type: "send" }>;

function lookupExtension(lookup: (city: string) => Promise<string>) {
	return defineExtension({
		name: "lookup",
		tools: [
			defineTool({
				name: "lookup",
				description: "Looks a city up.",
				parameters: obj({ city: str() }),
				execute: async (args) => ({ output: [{ type: "text" as const, text: await lookup(args.city) }] }),
			}),
		],
	});
}

/** The progress notice as the room shows it: the first notice, with its newest edit applied. */
function progress(link: FakeLink): { readonly notice: Send; readonly shown: string; readonly sends: Send[] } {
	const sends = link.of("send");
	const notice = sends.find((send) => send.notice === true && send.replaces === undefined);
	assert.ok(notice, "a progress notice was sent");
	const id = `$sent-${notice.txnId}`;
	const edits = sends.filter((send) => send.replaces === id);
	return { notice, shown: (edits.at(-1) ?? notice).body, sends: [notice, ...edits] };
}

async function progressEnv(lookup: (city: string) => Promise<string> = async () => "sunny") {
	return agentEnv({ extensions: () => [lookupExtension(lookup)] });
}

test("the tools a run called are shown in a notice before the answer, with their arguments and that they succeeded", async () => {
	await using env = await progressEnv();
	env.faux.setResponses([call("lookup", { city: "Kyoto" }), fauxAssistantMessage("最終の答え")]);
	const bridge = env.bridge({ progressIntervalMs: 0 });

	env.link.emit(message(ROOM, "$1", "天気は?"));
	await bridge.idle();

	const { shown } = progress(env.link);
	assert.match(shown, /lookup/);
	assert.match(shown, /Kyoto/);
	assert.ok(shown.includes(TOOL_DONE));
	assert.doesNotMatch(shown, /最終の答え/);
	const messages = env.link.of("send").filter((send) => send.replaces === undefined);
	assert.deepEqual(
		messages.map((send) => send.notice),
		[true, false],
	);
	assert.equal(messages.at(-1)?.body, "最終の答え");
});

test("a tool that failed is shown as failed, with its error", async () => {
	await using env = await progressEnv(async () => {
		throw new Error("upstream 503");
	});
	env.faux.setResponses([call("lookup", { city: "Kyoto" }), fauxAssistantMessage("だめでした")]);
	const bridge = env.bridge({ progressIntervalMs: 0 });

	env.link.emit(message(ROOM, "$1", "天気は?"));
	await bridge.idle();

	const { shown } = progress(env.link);
	assert.ok(shown.includes(TOOL_FAILED));
	assert.match(shown, /upstream 503/);
});

test("the model's thinking and what it said before calling a tool are shown, and the answer is not", async () => {
	await using env = await progressEnv();
	env.faux.setResponses([
		fauxAssistantMessage([fauxThinking("天気を調べる必要がある"), fauxText("調べてみます"), fauxToolCall("lookup", { city: "Kyoto" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxThinking("晴れと答えればよい"), fauxText("晴れです")]),
	]);
	const bridge = env.bridge({ progressIntervalMs: 0 });

	env.link.emit(message(ROOM, "$1", "天気は?"));
	await bridge.idle();

	const { shown } = progress(env.link);
	assert.match(shown, /天気を調べる必要がある/);
	assert.match(shown, /調べてみます/);
	assert.match(shown, /晴れと答えればよい/);
	assert.doesNotMatch(shown, /晴れです/);
});

test("while a tool runs the notice shows it running, and that same notice is edited once it is done", async () => {
	const { promise: released, resolve: release } = Promise.withResolvers<string>();
	await using env = await progressEnv(() => released);
	env.faux.setResponses([call("lookup", { city: "Kyoto" }), fauxAssistantMessage("晴れです")]);
	const bridge = env.bridge({ progressIntervalMs: 0 });

	env.link.emit(message(ROOM, "$1", "天気は?"));
	const first = await env.link.waitFor("send", (send) => send.notice === true && send.body.includes(TOOL_RUNNING));
	release("sunny");
	await bridge.idle();

	const { notice, shown, sends } = progress(env.link);
	assert.equal(notice, first);
	assert.ok(shown.includes(TOOL_DONE));
	assert.ok(!shown.includes(TOOL_RUNNING));
	assert.equal(env.link.of("send").filter((send) => send.notice === true).length, sends.length);
});

test("an answer with nothing to show before it comes without a notice", async () => {
	await using env = await progressEnv();
	env.faux.setResponses([fauxAssistantMessage("こんにちは")]);
	const bridge = env.bridge({ progressIntervalMs: 0 });

	env.link.emit(message(ROOM, "$1", "やあ"));
	await bridge.idle();

	assert.deepEqual(
		env.link.of("send").map((send) => [send.body, send.notice]),
		[["こんにちは", false]],
	);
});
