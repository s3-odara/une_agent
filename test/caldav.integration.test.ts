import assert from "node:assert/strict";
import { test } from "node:test";
import { connectCalDav } from "../src/caldav.ts";
import { Calendars, formatEvent, formatTodo } from "../src/calendar.ts";
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

test("events and tasks round-trip through a real CalDAV server", { skip: url === undefined ? "CALDAV_TEST_URL is not set" : false }, async () => {
	const events = `It-Events-${Date.now()}`;
	const todos = `It-Todos-${Date.now()}`;
	await makeCalendar(url!, events, "VEVENT");
	await makeCalendar(url!, todos, "VTODO");

	const backend = connectCalDav({ url: url!, username, password, calendars: [events, todos] });
	const calendars = new Calendars(backend, { [events]: { kind: "events", description: "" }, [todos]: { kind: "todos", description: "" } }, tz);
	const now = at("2026-11-17T09:00");
	const week = [at("2026-11-16T00:00"), at("2026-11-23T00:00")] as const;
	const listed = async () => (await calendars.events(...week)).map((event) => formatEvent(event, tz));

	// Create, twice under one UID as a rerun would: one object.
	const id = await calendars.create(events, "it-event-1", { summary: "歯医者", start: "2026-11-18T15:30", location: "駅前" }, now);
	await calendars.create(events, "it-event-1", { summary: "歯医者", start: "2026-11-18T15:30", location: "駅前" }, now);
	await calendars.create(events, "it-event-2", { summary: "旅行", start: "2026-11-20", end: "2026-11-21" }, now);
	await calendars.create(events, "it-event-3", { summary: "範囲の外", start: "2026-12-20T10:00" }, now);
	assert.deepEqual(await listed(), ["11/18(水) 15:30–16:30 歯医者 @駅前", "11/20(金)〜11/21(土) 終日 旅行"]);

	const item = (await calendars.events(...week))[0]!;
	assert.equal(item.id, id);
	assert.equal(item.uid, "it-event-1");
	assert.ok(item.etag !== undefined && item.etag !== "", "the listing carries an ETag");
	assert.ok(item.modified !== undefined, "the listing carries a modification time");
	// The ETag of a single GET and of the listing name the same revision: the change watcher depends on it.
	assert.equal(await calendars.etag(id), item.etag?.replace(/^W\//, "").replace(/^"|"$/g, ""));

	await calendars.update(id, { start: "2026-11-18T16:00", location: "" }, now + 60_000);
	assert.equal(await calendars.describe(id), "11/18(水) 16:00–17:00 歯医者");
	assert.notEqual((await calendars.events(...week))[0]?.etag, item.etag);

	const task = await calendars.create(todos, "it-todo-1", { summary: "レポート提出", due: "2026-11-20" }, now);
	assert.deepEqual((await calendars.todos()).map((todo) => `${formatTodo(todo, tz)} ${todo.done}`), ["レポート提出 期日 11/20(金) false"]);
	await calendars.complete(task, now);
	await calendars.complete(task, now);
	assert.equal((await calendars.todos())[0]?.done, true);

	await calendars.remove(id);
	await calendars.remove(id);
	assert.deepEqual(await listed(), ["11/20(金)〜11/21(土) 終日 旅行"]);
	await assert.rejects(calendars.update(id, { summary: "x" }, now), /見つかりません/);

	// A calendar the account does not have is named in the error, with the ones it does have.
	const missing = new Calendars(connectCalDav({ url: url!, username, password, calendars: ["No-Such-Calendar"] }), { "No-Such-Calendar": { kind: "events", description: "" } }, tz);
	await assert.rejects(missing.events(...week), /"No-Such-Calendar" not found; the account has: /);
});
