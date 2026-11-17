import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type Config, parseConfig } from "../src/config.ts";
import type { GatewayCommand, GatewayEvent, GatewayLink } from "../src/gateway.ts";
import { openAgentHarness } from "../src/harness.ts";
import { HostDb } from "../src/hostdb.ts";
import { Bridge } from "../src/rooms.ts";

/** A gateway stand-in that records commands and, unless told not to, confirms every send. */
class FakeLink implements GatewayLink {
	readonly commands: GatewayCommand[] = [];
	confirmSends = true;
	#listener: (event: GatewayEvent) => void = () => {};

	send(command: GatewayCommand): void {
		this.commands.push(command);
		if (command.type === "send" && this.confirmSends) {
			queueMicrotask(() => this.emit({ type: "sent", requestId: command.requestId, eventId: `$sent-${command.txnId}` }));
		}
	}
	onEvent(listener: (event: GatewayEvent) => void): void {
		this.#listener = listener;
	}
	emit(event: GatewayEvent): void {
		this.#listener(event);
	}
	of<T extends GatewayCommand["type"]>(type: T): Extract<GatewayCommand, { type: T }>[] {
		return this.commands.filter((command): command is Extract<GatewayCommand, { type: T }> => command.type === type);
	}
}

function message(roomId: string, eventId: string, body: string): GatewayEvent {
	return { type: "message", roomId, eventId, sender: "@me:example.org", body, ts: 0 };
}

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "agent-test-"));
	writeFileSync(join(dir, "calm.md"), "SOUL-CALM");
	writeFileSync(join(dir, "blunt.md"), "SOUL-BLUNT");
	const faux = fauxProvider();
	const model = faux.getModel();
	const config: Config = parseConfig(
		{
			matrix: { homeserver: "https://example.org", userId: "@agent:example.org", allowedUsers: ["@me:example.org"] },
			model: { provider: model.provider, modelId: model.id },
			personas: { calm: "calm.md", blunt: "blunt.md" },
			defaultPersona: "calm",
			rooms: { "!blunt:example.org": "blunt" },
		},
		dir,
	);
	const models = createModels();
	models.setProvider(faux.provider);
	const open = async () => ({
		harness: await openAgentHarness(await openNodeSqliteStorage(join(dir, "session.sqlite")), models, context),
		db: new HostDb(join(dir, "host.sqlite")),
	});
	return { dir, faux, config, open, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a message is answered once, acked, and recorded as delivered", async () => {
	const { faux, config, open, cleanup } = setup();
	const { harness, db } = await open();
	try {
		faux.setResponses([fauxAssistantMessage("hello back")]);
		const link = new FakeLink();
		const bridge = new Bridge({ harness, db, link, config, context });
		bridge.start();

		link.emit(message("!a:example.org", "$1", "hello"));
		await bridge.idle();

		assert.deepEqual(link.of("ack"), [{ type: "ack", eventId: "$1" }]);
		const sends = link.of("send");
		assert.equal(sends.length, 1);
		assert.equal(sends[0]?.body, "hello back");
		assert.equal(sends[0]?.txnId, "reply:$1");
		assert.equal(db.isDelivered("$1"), true);
		assert.deepEqual(db.pendingDeliveries(), []);

		// The gateway offers the same event again, as it does when its ack was lost.
		link.emit(message("!a:example.org", "$1", "hello"));
		await bridge.idle();
		assert.equal(link.of("send").length, 1);
		assert.equal(link.of("ack").length, 2);
		assert.equal(faux.state.callCount, 1);
	} finally {
		await harness.close(context);
		db.close();
		cleanup();
	}
});

test("an answer that could not be sent is sent by the next process without asking the model again", async () => {
	const { faux, config, open, cleanup } = setup();
	faux.setResponses([fauxAssistantMessage("kept answer")]);

	const first = await open();
	const deadLink = new FakeLink();
	deadLink.confirmSends = false;
	const firstBridge = new Bridge({ ...first, link: deadLink, config, context, sendRetryDelaysMs: [], sendTimeoutMs: 20, log: () => {} });
	firstBridge.start();
	deadLink.emit(message("!a:example.org", "$1", "hello"));
	await firstBridge.idle();
	assert.equal(first.db.pendingDeliveries().length, 1);
	await first.harness.close(context);
	first.db.close();

	const second = await open();
	try {
		const link = new FakeLink();
		const bridge = new Bridge({ ...second, link, config, context });
		bridge.start();
		// The gateway also resends the event if the first process never acked it.
		link.emit(message("!a:example.org", "$1", "hello"));
		await bridge.idle();

		const sends = link.of("send");
		assert.equal(sends.length, 1);
		assert.equal(sends[0]?.body, "kept answer");
		assert.equal(sends[0]?.txnId, "reply:$1");
		assert.equal(second.db.isDelivered("$1"), true);
		assert.equal(faux.state.callCount, 1);
	} finally {
		await second.harness.close(context);
		second.db.close();
		cleanup();
	}
});

test("each room has its own conversation and persona", async () => {
	const { faux, config, open, cleanup } = setup();
	const { harness, db } = await open();
	try {
		const seen = (requestContext: { messages: unknown }) => fauxAssistantMessage(JSON.stringify(requestContext.messages));
		faux.setResponses([seen, seen]);
		const link = new FakeLink();
		const bridge = new Bridge({ harness, db, link, config, context });
		bridge.start();

		link.emit(message("!calm:example.org", "$1", "only-in-calm"));
		await bridge.idle();
		link.emit(message("!blunt:example.org", "$2", "only-in-blunt"));
		await bridge.idle();

		const calm = link.of("send").find((send) => send.roomId === "!calm:example.org")?.body ?? "";
		const blunt = link.of("send").find((send) => send.roomId === "!blunt:example.org")?.body ?? "";
		assert.match(calm, /SOUL-CALM/);
		assert.doesNotMatch(calm, /SOUL-BLUNT/);
		assert.match(blunt, /SOUL-BLUNT/);
		assert.doesNotMatch(blunt, /only-in-calm/);
		assert.notEqual(db.conversationOf("!calm:example.org"), db.conversationOf("!blunt:example.org"));
	} finally {
		await harness.close(context);
		db.close();
		cleanup();
	}
});

test("a run that fails is reported to the room as a notice", async () => {
	const { faux, config, open, cleanup } = setup();
	const { harness, db } = await open();
	try {
		faux.setResponses([]); // the faux provider has nothing to say, which fails the request
		const link = new FakeLink();
		const bridge = new Bridge({ harness, db, link, config, context });
		bridge.start();
		link.emit(message("!a:example.org", "$1", "hello"));
		await bridge.idle();

		const sends = link.of("send");
		assert.equal(sends.length, 1);
		assert.equal(sends[0]?.notice, true);
		assert.match(sends[0]?.body ?? "", /応答できませんでした/);
	} finally {
		await harness.close(context);
		db.close();
		cleanup();
	}
});

test("a persona that is used but not defined is rejected when the config is read", () => {
	assert.throws(
		() =>
			parseConfig(
				{
					matrix: { homeserver: "https://example.org", userId: "@agent:example.org", allowedUsers: ["@me:example.org"] },
					model: { provider: "anthropic", modelId: "claude-fable-5-2" },
					personas: { default: "personas/default.md" },
					rooms: { "!a:example.org": "missing" },
				},
				"/nowhere",
			),
		/persona "missing"/,
	);
});
