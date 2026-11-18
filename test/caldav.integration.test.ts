import assert from "node:assert/strict";
import { test } from "node:test";
import { connectCalDav } from "../src/caldav.ts";
import { CalendarError, Calendars } from "../src/calendar.ts";
import { localToEpoch } from "../src/time.ts";

/**
 * Runs `src/caldav.ts` against a real CalDAV server. Skipped unless `CALDAV_TEST_URL` names one, for example a
 * throwaway Radicale:
 *
 *   uvx radicale --server-hosts 127.0.0.1:5232 --auth-type none --storage-filesystem-folder /tmp/radicale-test
 *   CALDAV_TEST_URL=http://127.0.0.1:5232 CALDAV_TEST_USER=test node --test test/caldav.integration.test.ts
 *
 * It creates two calendars under the user's home and writes to them, so point it only at a server made for the test.
 */
const url = process.env.CALDAV_TEST_URL;
const username = process.env.CALDAV_TEST_USER ?? "test";
const password = process.env.CALDAV_TEST_PASSWORD ?? "test";
const tz = "Asia/Tokyo";
const at = (local: string) => localToEpoch(local, tz);

async function makeCalendar(base: string, name: string, component: "VEVENT" | "VTODO"): Promise<void> {
	const response = await fetch(new URL(`/${username}/${name.toLowerCase()}-${Date.now()}/`, base), {
		method: "MKCALENDAR",
		headers: { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`, "content-type": "application/xml; charset=utf-8" },
		body: `<?xml version="1.0" encoding="utf-8"?>
<C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop>
<D:displayname>${name}</D:displayname>
<C:supported-calendar-component-set><C:comp name="${component}"/></C:supported-calendar-component-set>
</D:prop></D:set></C:mkcalendar>`,
	});
	assert.ok(response.status === 201, `MKCALENDAR ${name}: HTTP ${response.status}`);
}

const needsServer = { skip: url === undefined ? "CALDAV_TEST_URL is not set" : false };
const now = at("2026-11-17T09:00");
const week = [at("2026-11-16T00:00"), at("2026-11-23T00:00")] as const;

async function fresh() {
	const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const [events, todos] = [`It-Events-${stamp}`, `It-Todos-${stamp}`];
	await makeCalendar(url!, events, "VEVENT");
	await makeCalendar(url!, todos, "VTODO");
	const backend = connectCalDav({ url: url!, username, password, calendars: [events, todos] });
	return { events, todos, calendars: new Calendars(backend, { [events]: { kind: "events", description: "" }, [todos]: { kind: "todos", description: "" } }, tz) };
}

test("creating twice under one UID, as a rerun does, stores one event", needsServer, async () => {
	const { events, calendars } = await fresh();
	await calendars.create(events, "e1", { summary: "歯医者", start: "2026-11-18T15:30" }, now);
	await calendars.create(events, "e1", { summary: "歯医者", start: "2026-11-18T15:30" }, now);
	assert.deepEqual(
		(await calendars.events(...week)).map((event) => event.uid),
		["e1"],
	);
});

test("only the events in the range are listed, with what was stored", needsServer, async () => {
	const { events, calendars } = await fresh();
	const id = await calendars.create(events, "e1", { summary: "歯医者", start: "2026-11-18T15:30", location: "駅前" }, now);
	await calendars.create(events, "e2", { summary: "旅行", start: "2026-11-20", end: "2026-11-21" }, now);
	await calendars.create(events, "e3", { summary: "範囲の外", start: "2026-12-20T10:00" }, now);
	const listed = await calendars.events(...week);
	assert.deepEqual(
		listed.map((event) => [event.summary, event.start, event.allDay]),
		[
			["歯医者", at("2026-11-18T15:30"), false],
			["旅行", at("2026-11-20T00:00"), true],
		],
	);
	assert.equal(listed[0]?.id, id);
	assert.equal(listed[0]?.location, "駅前");
});

test("a listed event's ETag names the same revision as one read on its own, as the change watcher needs", needsServer, async () => {
	const { events, calendars } = await fresh();
	const id = await calendars.create(events, "e1", { summary: "歯医者", start: "2026-11-18T15:30" }, now);
	const [item] = await calendars.events(...week);
	assert.ok(item?.modified !== undefined, "the listing carries a modification time");
	assert.equal(await calendars.etag(id), item?.etag?.replace(/^W\//, "").replace(/^"|"$/g, ""));
});

test("a change is stored, as a new revision", needsServer, async () => {
	const { events, calendars } = await fresh();
	const id = await calendars.create(events, "e1", { summary: "歯医者", start: "2026-11-18T15:30", location: "駅前" }, now);
	const before = await calendars.etag(id);
	await calendars.update(id, { start: "2026-11-18T16:00", location: "" }, now + 60_000);
	const [item] = await calendars.events(...week);
	assert.deepEqual([item?.start, item?.location], [at("2026-11-18T16:00"), undefined]);
	assert.notEqual(await calendars.etag(id), before);
});

test("a task is listed with its due date, and completed however often asked", needsServer, async () => {
	const { todos, calendars } = await fresh();
	const task = await calendars.create(todos, "t1", { summary: "レポート提出", due: "2026-11-20" }, now);
	assert.deepEqual(
		(await calendars.todos()).map((todo) => [todo.summary, todo.due?.date, todo.done]),
		[["レポート提出", "2026-11-20", false]],
	);
	await calendars.complete(task, now);
	await calendars.complete(task, now);
	assert.equal((await calendars.todos())[0]?.done, true);
});

test("removing twice succeeds, and leaves the event gone", needsServer, async () => {
	const { events, calendars } = await fresh();
	const id = await calendars.create(events, "e1", { summary: "歯医者", start: "2026-11-18T15:30" }, now);
	await calendars.remove(id);
	await calendars.remove(id);
	assert.deepEqual(await calendars.events(...week), []);
	await assert.rejects(calendars.update(id, { summary: "x" }, now), CalendarError);
});

test("a calendar the account does not have is named in the error", needsServer, async () => {
	const missing = new Calendars(connectCalDav({ url: url!, username, password, calendars: ["No-Such-Calendar"] }), { "No-Such-Calendar": { kind: "events", description: "" } }, tz);
	await assert.rejects(missing.events(...week), /No-Such-Calendar/);
});
