import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Approvals } from "../src/approval.ts";
import { buildEvent, buildTodo, Calendars } from "../src/calendar.ts";
import { createCalendarExtension } from "../src/calendar-tools.ts";
import { parseConfig } from "../src/config.ts";
import { openAgentHarness } from "../src/harness.ts";
import { HostDb } from "../src/hostdb.ts";
import { Bridge } from "../src/rooms.ts";
import { localToEpoch } from "../src/time.ts";
import { createWeatherExtension } from "../src/weather-tools.ts";
import { call, FakeLink, MemoryCalDav, message, type Request, report } from "./fakes.ts";

const tz = "Asia/Tokyo";
const room = "!main:example.org";
const at = (local: string) => localToEpoch(local, tz);

async function setup(options: { approvalTimeoutMs?: number } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "agent-caltools-test-"));
	writeFileSync(join(dir, "soul.md"), "SOUL");
	const faux = fauxProvider();
	const model = faux.getModel();
	const config = parseConfig(
		{
			matrix: { homeserver: "https://example.org", userId: "@agent:example.org", allowedUsers: ["@me:example.org"] },
			model: { provider: model.provider, modelId: model.id },
			personas: { default: "soul.md" },
			timezone: tz,
			caldav: { url: "https://dav.example.org", username: "me", calendars: { Home: { kind: "events", description: "個人的な予定" }, ToDo: { kind: "todos", description: "タスク" } } },
		},
		dir,
	);
	const models = createModels();
	models.setProvider(faux.provider);
	const db = new HostDb(join(dir, "host.sqlite"));
	const backend = new MemoryCalDav();
	const calendars = new Calendars(backend, config.caldav!.calendars, tz);
	const weather = async () => ({ area: "東京地方", reportedAt: "2026-11-17T05:00:00+09:00", days: [{ date: "2026-11-17", weather: "晴れ", rain: [] }] });
	const link = new FakeLink();
	let bridge: Bridge | undefined;
	const approvals = new Approvals({
		db,
		notice: (roomId, txnId, body) => bridge!.post(roomId, txnId, body),
		react: (roomId, txnId, eventId, key) => bridge!.react(roomId, txnId, eventId, key),
		timeoutMs: options.approvalTimeoutMs,
		log: () => {},
	});
	const extensions = [createCalendarExtension({ calendars, db, approvals }), createWeatherExtension(weather)];
	const harness = await openAgentHarness(new MemoryStorage(), models, context, extensions, () => at("2026-11-17T09:00"));
	bridge = new Bridge({ harness, db, link, config, context, approvals });
	bridge.start();
	let sent = 0;
	const sends = () => link.of("send");
	/** Sends a user message; resolves with what the bot answered once everything has settled. */
	const start = (body: string) => {
		const before = sends().length;
		link.emit(message(room, `$${++sent}`, body, at("2026-11-17T09:00")));
		return bridge!.idle().then(() =>
			sends()
				.slice(before)
				.filter((command) => !command.txnId.startsWith("approval:"))
				.map((command) => command.body)
				.join("\n"),
		);
	};
	/** Waits until the bot has posted `count` approval requests, and returns the last. */
	const prompt = async (count = 1) => {
		for (let i = 0; i < 400; i++) {
			const prompts = sends().filter((command) => command.txnId.startsWith("approval:"));
			const latest = prompts[count - 1];
			if (latest !== undefined) return { body: latest.body, eventId: `$sent-${latest.txnId}` };
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error("no approval request was posted");
	};
	const react = (eventId: string, key: string) =>
		link.emit({ type: "reaction", roomId: room, eventId: `$r${++sent}`, relatesTo: eventId, key, sender: "@me:example.org" });
	return {
		faux,
		db,
		backend,
		calendars,
		link,
		start,
		prompt,
		react,
		/** Sends a user message and returns what the bot answered. */
		say: start,
		cleanup: async () => {
			await harness.close(context);
			db.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("the model sees when a message was sent, which calendars exist, and can list them", async () => {
	const t = await setup();
	try {
		t.backend.put("Home", "dentist.ics", buildEvent("dentist", { summary: "歯医者", start: "2026-11-18T15:30" }, tz, 0));
		t.backend.put("ToDo", "report.ics", buildTodo("report", { summary: "レポート提出", due: "2026-11-20" }, tz, 0));
		t.backend.put("ToDo", "done.ics", buildTodo("done", { summary: "済んだこと" }, tz, 0).replace("NEEDS-ACTION", "COMPLETED"));

		t.faux.setResponses([(request: Request) => fauxAssistantMessage(JSON.stringify(request.messages)), call("calendar_list", {}), report, call("weather_forecast", {}), report]);
		const seen = await t.say("明日の予定は?");
		assert.match(seen, /\[2026-11-17\(火\) 09:00\] 明日の予定は\?/);
		assert.match(seen, /Home（予定）: 個人的な予定/);

		assert.equal(
			await t.say("一覧"),
			["予定（2026-11-17〜2026-11-24）", "- 11/18(水) 15:30–16:30 歯医者 [Home/dentist.ics]", "", "未完了のタスク", "- レポート提出 期日 11/20(金) [ToDo/report.ics]"].join("\n"),
		);
		assert.match(await t.say("天気"), /東京地方の天気予報（気象庁/);
	} finally {
		await t.cleanup();
	}
});

test("creating runs at once, and the watcher is told so it does not report the agent's own work", async () => {
	const t = await setup();
	try {
		t.faux.setResponses([
			call("calendar_create", { calendar: "Home", summary: "歯医者", start: "2026-11-18T15:30", location: "駅前" }),
			report,
			call("calendar_create", { calendar: "ToDo", summary: "レポート提出", due: "2026-11-20" }),
			report,
			call("calendar_create", { calendar: "Home", summary: "期日つきの予定", due: "2026-11-20" }),
			report,
		]);
		const created = await t.say("明日15時半に歯医者");
		assert.match(created, /^登録しました: 11\/18\(水\) 15:30–16:30 歯医者 @駅前 \[Home\/[0-9a-f-]{36}\.ics\]$/);
		const [file] = t.backend.files("Home");
		assert.equal(t.db.seenItems().get(`Home/${file}`), (await t.calendars.etag(`Home/${file}`)) ?? "missing");

		assert.match(await t.say("レポートを金曜までに"), /^登録しました: レポート提出 期日 11\/20\(金\) \[ToDo\//);
		assert.match(await t.say("変な依頼"), /予定には start が必要です/);
		assert.equal(t.backend.files("Home").length, 1);
	} finally {
		await t.cleanup();
	}
});

test("a change waits for the user's decision, given as a reaction to the request", async () => {
	const t = await setup();
	try {
		t.backend.put("Home", "dentist.ics", buildEvent("dentist", { summary: "歯医者", start: "2026-11-18T15:30" }, tz, 0));
		const id = "Home/dentist.ics";
		t.faux.setResponses([call("calendar_update", { id, start: "2026-11-18T16:00" }), report]);
		const answer = t.start("歯医者を16時に");
		const request = await t.prompt();
		assert.match(request.body, /^承認が必要です: 予定・タスクを変更: 11\/18\(水\) 15:30–16:30 歯医者（開始 → 2026-11-18T16:00）\n✅ 今回だけ許可 \/ 🔁/);
		// The bot puts the four choices under the request, to be pressed.
		assert.deepEqual(
			t.link.of("react").map((command) => [command.eventId, command.key]),
			["✅", "🔁", "♾️", "❌"].map((key) => [request.eventId, key]),
		);
		// Nothing has changed while the decision is open.
		assert.equal(await t.calendars.describe(id), "11/18(水) 15:30–16:30 歯医者");

		t.react("$unrelated", "✅");
		t.react(request.eventId, "✅");
		assert.equal(await answer, "変更しました: 11/18(水) 16:00–17:00 歯医者");
		assert.equal(await t.calendars.describe(id), "11/18(水) 16:00–17:00 歯医者");
	} finally {
		await t.cleanup();
	}
});

test("a reject leaves the item alone, and a command answers like a reaction", async () => {
	const t = await setup();
	try {
		t.backend.put("Home", "dentist.ics", buildEvent("dentist", { summary: "歯医者", start: "2026-11-18T15:30" }, tz, 0));
		const id = "Home/dentist.ics";
		t.faux.setResponses([call("calendar_delete", { id }), report]);
		const rejected = t.start("歯医者を消して");
		t.react((await t.prompt()).eventId, "❌");
		assert.equal(await rejected, "ユーザーが拒否しました。実行していません。");
		assert.deepEqual(t.backend.files("Home"), ["dentist.ics"]);

		t.faux.setResponses([call("calendar_delete", { id }), report]);
		const approved = t.start("やっぱり消して");
		await t.prompt(2);
		// The command is answered by the bot, not passed to the model.
		const commandReply = t.start("!approve");
		assert.equal(await approved, "今回だけ許可: 予定・タスクを削除: 11/18(水) 15:30–16:30 歯医者\n削除しました: 11/18(水) 15:30–16:30 歯医者");
		await commandReply;
		assert.deepEqual(t.backend.files("Home"), []);
		assert.equal(await t.say("!reject"), "承認待ちはありません。");

		t.faux.setResponses([call("calendar_update", { id: "Home/nope.ics", summary: "x" }), report, call("calendar_update", { id: "bad-id", summary: "x" }), report]);
		assert.match(await t.say("無いもの"), /見つかりません/);
		assert.match(await t.say("変な id"), /id「bad-id」の形が違います/);
	} finally {
		await t.cleanup();
	}
});

test("writing something else instead of answering is a no, and what was written goes to the model", async () => {
	const t = await setup();
	try {
		t.backend.put("Home", "dentist.ics", buildEvent("dentist", { summary: "歯医者", start: "2026-11-18T15:30" }, tz, 0));
		let next = "";
		t.faux.setResponses([
			call("calendar_update", { id: "Home/dentist.ics", start: "2026-11-18T16:00" }),
			report,
			(request: Request) => {
				next = JSON.stringify(request.messages);
				return fauxAssistantMessage("17時にしますね。");
			},
		]);
		const first = t.start("歯医者を16時に");
		await t.prompt();
		const second = t.start("いや、17時にして");
		const both = await first;
		await second;
		assert.match(both, /^ユーザーは承認せず、別の発言を送りました。実行していません。/);
		assert.match(both, /17時にしますね。$/);
		assert.match(next, /いや、17時にして/);
		assert.equal(await t.calendars.describe("Home/dentist.ics"), "11/18(水) 15:30–16:30 歯医者");
	} finally {
		await t.cleanup();
	}
});

test("approve_session covers the same tool for the rest of the run; approve_always for good, until revoked", async () => {
	const t = await setup();
	try {
		for (const name of ["a", "b", "c", "d"]) t.backend.put("Home", `${name}.ics`, buildEvent(name, { summary: name, start: "2026-11-18T15:30" }, tz, 0));
		t.faux.setResponses([call("calendar_delete", { id: "Home/a.ics" }), call("calendar_delete", { id: "Home/b.ics" }), report]);
		const both = t.start("a と b を消して");
		t.react((await t.prompt()).eventId, "🔁");
		assert.equal(await both, "削除しました: 11/18(水) 15:30–16:30 b");
		assert.deepEqual(t.backend.files("Home"), ["c.ics", "d.ics"]);
		// The next run asks again.
		t.faux.setResponses([call("calendar_delete", { id: "Home/c.ics" }), report]);
		const again = t.start("c も");
		t.react((await t.prompt(2)).eventId, "♾️");
		assert.match(await again, /^削除しました/);

		t.faux.setResponses([call("calendar_delete", { id: "Home/d.ics" }), report]);
		assert.match(await t.say("d も"), /^削除しました/);
		assert.equal(t.link.of("send").filter((command) => command.txnId.startsWith("approval:")).length, 2, "no request for d");
		assert.match(await t.say("!approvals"), /確認しないツール: calendar_delete/);
		assert.equal(await t.say("!revoke calendar_delete"), "calendar_delete は今後また確認します。");
		assert.deepEqual(t.db.alwaysApproved(), []);
	} finally {
		await t.cleanup();
	}
});

test("a request nobody answers runs out", async () => {
	const t = await setup({ approvalTimeoutMs: 30 });
	try {
		t.backend.put("Home", "dentist.ics", buildEvent("dentist", { summary: "歯医者", start: "2026-11-18T15:30" }, tz, 0));
		t.faux.setResponses([call("calendar_delete", { id: "Home/dentist.ics" }), report]);
		assert.equal(await t.say("歯医者を消して"), "承認の返事が無いまま期限が過ぎました。実行していません。");
		assert.deepEqual(t.backend.files("Home"), ["dentist.ics"]);
	} finally {
		await t.cleanup();
	}
});

test("completing a task needs no confirmation", async () => {
	const t = await setup();
	try {
		t.backend.put("ToDo", "report.ics", buildTodo("report", { summary: "レポート提出", due: "2026-11-20" }, tz, 0));
		t.faux.setResponses([call("calendar_complete", { id: "ToDo/report.ics" }), report]);
		assert.equal(await t.say("レポート出した"), "完了にしました。");
		assert.equal((await t.calendars.todos())[0]?.done, true);
	} finally {
		await t.cleanup();
	}
});
