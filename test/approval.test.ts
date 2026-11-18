import assert from "node:assert/strict";
import { join } from "node:path";
import { mock, test } from "node:test";
import { type ApprovalRequest, Approvals, type Outcome } from "../src/approval.ts";
import { HostDb } from "../src/hostdb.ts";
import { tempDir } from "./env.ts";

const ROOM = "!a:example.org";
const DAY = 86_400_000;

/**
 * Approvals on a real database, posting to a room that only records what it was given. The clock is a fake one, moved
 * by the test: a request left open does not hold the process for a day.
 */
function setup() {
	mock.timers.enable({ apis: ["setTimeout"] });
	const dir = tempDir();
	const db = new HostDb(join(dir.path, "host.sqlite"));
	const posted: { roomId: string; body: string; eventId: string }[] = [];
	const reactions: { eventId: string; key: string }[] = [];
	const approvals = new Approvals({
		db,
		notice: async (roomId, txnId, body) => {
			const eventId = `$prompt-${txnId}`;
			posted.push({ roomId, body, eventId });
			return eventId;
		},
		react: async (_roomId, _txnId, eventId, key) => void reactions.push({ eventId, key }),
		now: () => 0,
		timeoutMs: DAY,
		log: () => {},
	});
	let n = 0;
	const request = (fields: Partial<ApprovalRequest> = {}): ApprovalRequest => ({ id: `r${++n}`, roomId: ROOM, runKey: "run-1", tool: "calendar_delete", summary: `削除 ${n}`, ...fields });
	/** Asks, and resolves with the request's event once it is up with its choices under it. */
	const ask = async (fields: Partial<ApprovalRequest> = {}) => {
		const outcome = approvals.ask(request(fields));
		let settled: Outcome | undefined;
		void outcome.then((value) => (settled = value));
		// Posting is a few awaits deep; a bounded wait, so a request that never comes fails the test instead of hanging it.
		const posting = () => posted.length === 0 || reactions.filter((reaction) => reaction.eventId === posted.at(-1)?.eventId).length < 4;
		for (let turns = 0; turns < 100 && posting() && settled === undefined; turns++) await new Promise((resolve) => setImmediate(resolve));
		return { outcome, eventId: posted.at(-1)?.eventId ?? "" };
	};
	return {
		db,
		approvals,
		posted,
		reactions,
		ask,
		request,
		[Symbol.dispose]() {
			mock.timers.reset();
			db.close();
			dir[Symbol.dispose]();
		},
	};
}

const PENDING = Symbol("pending");

/** The promise's value if it has settled by the time what is queued now has run, else `PENDING`. */
function now<T>(promise: Promise<T>): Promise<T | typeof PENDING> {
	return Promise.race([promise, new Promise<typeof PENDING>((resolve) => setImmediate(() => resolve(PENDING)))]);
}

/** Whether a promise has settled, without waiting for it. */
async function isSettled(promise: Promise<unknown>): Promise<boolean> {
	return (await now(promise)) !== PENDING;
}

/** What was decided, which must be decided already: a test fails here instead of waiting for ever. */
async function decided(outcome: Promise<Outcome>): Promise<Outcome> {
	const value = await now(outcome);
	assert.notEqual(value, PENDING, "not decided");
	return value as Outcome;
}

test("a request is posted to its room with what it is for, and the four choices are put under it to press", async () => {
	using t = setup();
	const { eventId } = await t.ask({ summary: "予定・タスクを削除: 歯医者" });

	assert.equal(t.posted.length, 1);
	assert.equal(t.posted[0]?.roomId, ROOM);
	assert.match(t.posted[0]?.body ?? "", /予定・タスクを削除: 歯医者/);
	assert.deepEqual(
		t.reactions.map((reaction) => [reaction.eventId, reaction.key]),
		["✅", "🔁", "♾️", "❌"].map((key) => [eventId, key]),
	);
});

test("the call waits until a choice is pressed under the request", async () => {
	using t = setup();
	const { outcome, eventId } = await t.ask();
	assert.equal(await isSettled(outcome), false);

	t.approvals.onReaction(ROOM, eventId, "✅");
	assert.deepEqual(await decided(outcome), { approved: true, by: "approve" });
});

test("pressing ❌ is a no", async () => {
	using t = setup();
	const { outcome, eventId } = await t.ask();
	t.approvals.onReaction(ROOM, eventId, "❌");
	assert.deepEqual(await decided(outcome), { approved: false, reason: "rejected" });
});

test("a reaction to another message, or with another emoji, decides nothing", async () => {
	using t = setup();
	const { outcome, eventId } = await t.ask();
	t.approvals.onReaction(ROOM, "$something-else", "✅");
	t.approvals.onReaction(ROOM, eventId, "👍");
	assert.equal(await isSettled(outcome), false);
});

test("an emoji counts the same with or without the variation selector, as clients differ", async () => {
	using t = setup();
	const { outcome, eventId } = await t.ask();
	t.approvals.onReaction(ROOM, eventId, "♾");
	assert.deepEqual(await decided(outcome), { approved: true, by: "approve_always" });
});

test("a command answers the oldest open request in the room and is not passed on", async () => {
	using t = setup();
	const older = await t.ask();
	const newer = await t.ask();

	assert.equal(t.approvals.onMessage({ roomId: ROOM, body: "!reject" }).handled, true);
	assert.deepEqual(await decided(older.outcome), { approved: false, reason: "rejected" });
	assert.equal(await isSettled(newer.outcome), false);
});

test("a command with nothing open is answered and decides nothing", () => {
	using t = setup();
	assert.equal(t.approvals.onMessage({ roomId: ROOM, body: "!approve" }).handled, true);
});

test("saying something else instead of answering is a no for what waits in that room, and the message is passed on", async () => {
	using t = setup();
	const here = await t.ask();
	const elsewhere = await t.ask({ roomId: "!b:example.org" });

	assert.equal(t.approvals.onMessage({ roomId: ROOM, body: "いや、17時にして" }).handled, false);
	assert.deepEqual(await decided(here.outcome), { approved: false, reason: "message" });
	assert.equal(await isSettled(elsewhere.outcome), false);
});

test("approve_session lets the same tool through for the rest of the run, without asking", async () => {
	using t = setup();
	const first = await t.ask({ runKey: "run-1" });
	t.approvals.onReaction(ROOM, first.eventId, "🔁");
	await decided(first.outcome);

	assert.deepEqual(await decided(t.approvals.ask(t.request({ runKey: "run-1" }))), { approved: true, by: "run" });
	assert.equal(t.posted.length, 1);
});

test("approve_session does not cover another run or another tool", async () => {
	using t = setup();
	const first = await t.ask({ runKey: "run-1", tool: "calendar_delete" });
	t.approvals.onReaction(ROOM, first.eventId, "🔁");
	await decided(first.outcome);

	const otherRun = await t.ask({ runKey: "run-2", tool: "calendar_delete" });
	const otherTool = await t.ask({ runKey: "run-1", tool: "calendar_update" });
	assert.equal(await isSettled(otherRun.outcome), false);
	assert.equal(await isSettled(otherTool.outcome), false);
});

test("approve_always lets the tool through in every room and run, until it is revoked", async () => {
	using t = setup();
	const first = await t.ask({ tool: "calendar_delete" });
	t.approvals.onReaction(ROOM, first.eventId, "♾️");
	await decided(first.outcome);

	assert.deepEqual(await decided(t.approvals.ask(t.request({ roomId: "!b:example.org", runKey: "run-9" }))), { approved: true, by: "rule" });
	const listed = t.approvals.onMessage({ roomId: ROOM, body: "!approvals" });
	assert.ok(listed.handled && listed.reply?.includes("calendar_delete"));

	t.approvals.onMessage({ roomId: ROOM, body: "!revoke calendar_delete" });
	const after = await t.ask({ runKey: "run-10" });
	assert.equal(await isSettled(after.outcome), false);
});

test("a request nobody answers is a no once its time is up", async () => {
	using t = setup();
	const { outcome } = await t.ask();

	mock.timers.tick(DAY - 1);
	assert.equal(await isSettled(outcome), false);
	mock.timers.tick(1);
	assert.deepEqual(await decided(outcome), { approved: false, reason: "timeout" });
});

test("a call rerun after a crash gets the decision already made, without asking again", async () => {
	using t = setup();
	const first = await t.ask({ id: "same" });
	t.approvals.onReaction(ROOM, first.eventId, "✅");
	await decided(first.outcome);

	assert.deepEqual(await decided(t.approvals.ask(t.request({ id: "same" }))), { approved: true, by: "approve" });
	assert.equal(t.posted.length, 1);
});
