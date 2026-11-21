import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import type { GatewayCommand } from "../src/gateway.ts";
import { renderProgress, TOOL_DONE, TOOL_FAILED, TOOL_RUNNING } from "../src/progress.ts";
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
	return agentEnv({ extensions: () => [lookupExtension(lookup)], codemode: {} });
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

test("a call gets its answer without waiting for its tool progress notice", { timeout: 5_000 }, async () => {
	await using env = await progressEnv();
	env.faux.setResponses([call("lookup", { city: "Kyoto" }), fauxAssistantMessage("晴れです")]);
	const bridge = env.bridge();
	const ack = Promise.withResolvers<void>();
	env.link.beforeSent = () => ack.promise;
	try {
		assert.deepEqual(await bridge.ask(ROOM, "turn", "天気は?"), { ok: true, text: "晴れです" });
	} finally {
		ack.resolve();
		await bridge.idle();
	}
	assert.match(progress(env.link).shown, /lookup/);
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

test("a progress notice shows streamed thinking without the answer text", () => {
	const { role, api, provider, model, usage, stopReason, timestamp } = fauxAssistantMessage("");
	const content = [fauxThinking("まず天気を確認する。次に"), fauxText("晴れです。続きは生成中")];
	const message = { role, api, provider, model, usage, stopReason, timestamp, content };
	const shown = renderProgress([], { generation: { attempt: 1, message } });
	assert.match(shown, /まず天気を確認する/);
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

test("the calls a script made are shown under it, with their arguments and how they went", async () => {
	await using env = await progressEnv(async (city) => {
		if (city === "Atlantis") throw new Error("no such city");
		return "sunny";
	});
	const script = 'await tools.lookup({ city: "Kyoto" });\ntry { await tools.lookup({ city: "Atlantis" }); } catch {}';
	env.faux.setResponses([call("codemode", { code: script }), fauxAssistantMessage("晴れです")]);
	const bridge = env.bridge({ progressIntervalMs: 0 });

	env.link.emit(message(ROOM, "$1", "天気は?"));
	await bridge.idle();

	const lines = progress(env.link).shown.split("\n");
	const at = lines.findIndex((line) => line.includes("codemode"));
	assert.ok(lines[at + 1]?.startsWith("  ") && lines[at + 1]?.includes(TOOL_DONE) && lines[at + 1]?.includes("Kyoto"));
	assert.ok(lines[at + 2]?.startsWith("  ") && lines[at + 2]?.includes(TOOL_FAILED) && lines[at + 2]?.includes("no such city"));
});

test("while a script's call runs, the notice shows it running under the script", async () => {
	const { promise: released, resolve: release } = Promise.withResolvers<string>();
	await using env = await progressEnv(() => released);
	env.faux.setResponses([call("codemode", { code: 'return await tools.lookup({ city: "Kyoto" });' }), fauxAssistantMessage("晴れです")]);
	const bridge = env.bridge({ progressIntervalMs: 0 });

	env.link.emit(message(ROOM, "$1", "天気は?"));
	await env.link.waitFor("send", (send) => send.notice === true && send.body.includes(`  - ${TOOL_RUNNING} lookup`));
	release("sunny");
	await bridge.idle();
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
