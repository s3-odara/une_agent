import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { buildEvent, buildTodo, Calendars } from "../src/calendar.ts";
import { createCalendarExtension } from "../src/calendar-tools.ts";
import { parseConfig } from "../src/config.ts";
import { openAgentHarness } from "../src/harness.ts";
import { HostDb } from "../src/hostdb.ts";
import { Bridge } from "../src/rooms.ts";
import { localToEpoch } from "../src/time.ts";
import { FakeLink, MemoryCalDav, message } from "./fakes.ts";

const tz = "Asia/Tokyo";
const room = "!main:example.org";
const at = (local: string) => localToEpoch(local, tz);

type Request = { messages: { role: string; content: unknown }[] };

/** The text of the newest tool result the model was given. */
function lastToolResult(request: Request): string {
	const result = request.messages.findLast((item) => item.role === "toolResult");
	return (result?.content as { text?: string }[] | undefined)?.map((block) => block.text ?? "").join("") ?? "";
}

/** A model turn that calls one tool. */
const call = (name: string, args: Record<string, string>) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
/** A model turn that answers with what the last tool said, so a test can read it in the room. */
const report = (request: Request) => fauxAssistantMessage(lastToolResult(request));
/** The confirmation code from the transcript, as a model would copy it. */
const code = (request: Request) => /confirm: \\?"([0-9a-f]{8})\\?"/.exec(JSON.stringify(request.messages))?.[1] ?? "missing";

async function setup() {
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
	const harness = await openAgentHarness(new MemoryStorage(), models, context, [createCalendarExtension({ calendars, db, weather })], () => at("2026-11-17T09:00"));
	const link = new FakeLink();
	const bridge = new Bridge({ harness, db, link, config, context });
	bridge.start();
	let sent = 0;
	return {
		faux,
		db,
		backend,
		calendars,
		bridge,
		link,
		/** Sends a user message and returns what the bot answered. */
		say: async (body: string) => {
			const before = link.of("send").length;
			link.emit(message(room, `$${++sent}`, body, at("2026-11-17T09:00")));
			await bridge.idle();
			return link.of("send").slice(before).map((command) => command.body).join("\n");
		},
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

test("a change waits for the user's yes: not the model's own, and not a scheduler message", async () => {
	const t = await setup();
	try {
		t.backend.put("Home", "dentist.ics", buildEvent("dentist", { summary: "歯医者", start: "2026-11-18T15:30" }, tz, 0));
		const id = "Home/dentist.ics";
		const confirm = (request: Request) => call("calendar_update", { id, confirm: code(request) });

		// The model proposes, then tries to confirm in the same run, before the user has seen anything.
		t.faux.setResponses([call("calendar_update", { id, start: "2026-11-18T16:00" }), confirm, report]);
		assert.match(await t.say("歯医者を16時に"), /ユーザーの返事をまだ受け取っていません/);
		assert.equal(await t.calendars.describe(id), "11/18(水) 15:30–16:30 歯医者");

		// A run the scheduler started is not the user's answer either.
		t.faux.setResponses([confirm, report]);
		await t.bridge.submitScheduled(room, "check:1", "[定時チェック] ...");
		await t.bridge.idle();
		assert.match(t.link.of("send").at(-1)?.body ?? "", /ユーザーの返事をまだ受け取っていません/);
		assert.equal(await t.calendars.describe(id), "11/18(水) 15:30–16:30 歯医者");

		// The user answers: now the same code runs the change that was proposed.
		t.faux.setResponses([confirm, report, confirm, report]);
		assert.equal(await t.say("はい"), "変更しました: 11/18(水) 16:00–17:00 歯医者");
		assert.equal(await t.calendars.describe(id), "11/18(水) 16:00–17:00 歯医者");
		assert.equal(await t.say("もう一度"), "実行済みです。");

		t.faux.setResponses([call("calendar_update", { id, confirm: "deadbeef" }), report]);
		assert.match(await t.say("でたらめなコード"), /確認コードが違います/);
	} finally {
		await t.cleanup();
	}
});

test("a first call shows what would change and leaves the calendar alone; deleting works the same way", async () => {
	const t = await setup();
	try {
		t.backend.put("Home", "dentist.ics", buildEvent("dentist", { summary: "歯医者", start: "2026-11-18T15:30" }, tz, 0));
		const id = "Home/dentist.ics";

		t.faux.setResponses([call("calendar_delete", { id }), report]);
		const proposal = await t.say("歯医者を消して");
		assert.match(proposal, /^まだ実行していません。ユーザーの確認が必要です。\n対象: 11\/18\(水\) 15:30–16:30 歯医者\n操作: 削除\n/);
		assert.match(proposal, /id と confirm: "[0-9a-f]{8}" だけを付けて calendar_delete をもう一度/);
		assert.deepEqual(t.backend.files("Home"), ["dentist.ics"]);

		t.faux.setResponses([(request: Request) => call("calendar_delete", { id, confirm: code(request) }), report]);
		assert.equal(await t.say("はい、消して"), "削除しました。");
		assert.deepEqual(t.backend.files("Home"), []);

		t.faux.setResponses([call("calendar_update", { id: "Home/nope.ics", summary: "x" }), report, call("calendar_update", { id: "bad-id", summary: "x" }), report]);
		assert.match(await t.say("無いもの"), /見つかりません/);
		assert.match(await t.say("変な id"), /id「bad-id」の形が違います/);
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
