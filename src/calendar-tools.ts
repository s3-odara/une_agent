import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { CalendarError, type Calendars, type EventFields, formatEvent, formatTodo, type ItemChanges, splitId, type TodoFields } from "./calendar.ts";
import type { HostDb } from "./hostdb.ts";
import { runInputs } from "./run.ts";
import { addDays, dateOf, startOfDay } from "./time.ts";
import { formatForecast, type WeatherSource } from "./weather.ts";

export type CalendarToolsOptions = {
	readonly calendars: Calendars;
	readonly db: HostDb;
	readonly weather?: WeatherSource;
};

/** A change that only runs after the user has said yes. */
type GatedAction = { readonly kind: "update"; readonly id: string; readonly changes: ItemChanges } | { readonly kind: "delete"; readonly id: string };

/** A proposal the user has not answered within a day is void. */
const PROPOSAL_TTL_MS = 86_400_000;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WHEN = "終日なら YYYY-MM-DD、時刻つきなら YYYY-MM-DDTHH:MM（ユーザーの現地時刻）";

function describeChanges(changes: ItemChanges): string {
	const labels: Record<keyof ItemChanges, string> = { summary: "件名", start: "開始", end: "終了", due: "期日", location: "場所", description: "メモ" };
	const lines = (Object.keys(labels) as (keyof ItemChanges)[]).flatMap((key) => {
		const value = changes[key];
		return value === undefined ? [] : [`${labels[key]} → ${value === "" ? "（削除）" : value}`];
	});
	return lines.join("、");
}

/**
 * The calendar as tools. Reading and creating run at once. Changing and deleting an existing item are gated in code,
 * not only by instruction: the first call records the change and returns a confirmation code without touching the
 * calendar, and the code is accepted only in a run that a later message from the user started. The model still judges
 * whether that message was a yes; it cannot skip asking.
 *
 * Every tool is safe to rerun after a crash: a created item gets a UID remembered with the call, and changing,
 * completing and deleting all end in the same state however often they are applied.
 */
export function createCalendarExtension(options: CalendarToolsOptions) {
	const { calendars, db, weather } = options;
	const tz = calendars.tz;
	const done = (text: string) => ({ output: [{ type: "text" as const, text }] });
	const names = Object.keys(calendars.calendars);

	/** After the agent's own write: the watcher must not report it back to the user as news. */
	const noteOwnWrite = async (id: string) => db.setSeenItem(id, await calendars.etag(id));

	const run = async (action: GatedAction, now: number): Promise<string> => {
		if (action.kind === "delete") {
			await calendars.remove(action.id);
			db.setSeenItem(action.id, undefined);
			return "削除しました。";
		}
		await calendars.update(action.id, action.changes, now);
		await noteOwnWrite(action.id);
		return `変更しました: ${await calendars.describe(action.id)}`;
	};

	type GateApi = { readonly conversationId: unknown; now(): number; memo<T extends string>(name: string, candidate: T, context: Context): Promise<T> };

	const gate = async (tool: string, action: GatedAction | undefined, confirm: string | undefined, api: GateApi, inputs: readonly number[], context: Context): Promise<string> => {
		const conversationId = Number(api.conversationId);
		if (confirm === undefined) {
			if (action === undefined) throw new CalendarError("変更内容がありません。");
			const target = await calendars.describe(action.id);
			// Remembered with the call, so a rerun after a crash proposes under the same code.
			const token = await api.memo("token", randomUUID().slice(0, 8), context);
			db.putPendingChange({ token, conversationId, action: JSON.stringify(action), baseline: db.latestSubmission(), createdAt: api.now() });
			const what = action.kind === "delete" ? "削除" : `変更（${describeChanges(action.changes)}）`;
			return [
				"まだ実行していません。ユーザーの確認が必要です。",
				`対象: ${target}`,
				`操作: ${what}`,
				"この内容をユーザーに示して、実行してよいか尋ねてください。",
				`ユーザーが承諾したら、id と confirm: "${token}" だけを付けて ${tool} をもう一度呼んでください。承諾がなければ何もしないでください。`,
			].join("\n");
		}

		const pending = db.pendingChange(confirm);
		if (pending === undefined || pending.conversationId !== conversationId) throw new CalendarError("確認コードが違います。変更内容を指定して、提案からやり直してください。");
		if (pending.done) return "実行済みです。";
		if (api.now() - pending.createdAt > PROPOSAL_TTL_MS) throw new CalendarError("この提案は古くなりました。変更内容を指定して、提案からやり直してください。");
		// The yes can only be a message the user sent after the proposal, and this run must be the one it started.
		const answered = inputs.some((input) => input > pending.baseline && db.isUserSubmission(input));
		if (!answered) throw new CalendarError("ユーザーの返事をまだ受け取っていません。変更内容をユーザーに示して返事を待ってください。");

		const result = await run(JSON.parse(pending.action) as GatedAction, api.now());
		db.finishPendingChange(confirm);
		return result;
	};


	const tools = [
		defineTool({
			name: "calendar_list",
			description: "予定と未完了のタスクを一覧する。変更・削除・完了に使う id もここで分かる。",
			parameters: obj({
				from: opt(str({ description: "最初の日 YYYY-MM-DD。省略すると今日。" })),
				to: opt(str({ description: "最後の日 YYYY-MM-DD。省略すると from の7日後。" })),
			}),
			replay: "safe",
			execute: async (args, api) => {
				const from = args.from ?? dateOf(api.now(), tz);
				const to = args.to ?? addDays(from, 7);
				if (!DATE.test(from) || !DATE.test(to) || to < from) throw new CalendarError("from / to は YYYY-MM-DD で、to は from 以降にしてください。");
				const [events, todos] = await Promise.all([calendars.events(startOfDay(from, tz), startOfDay(addDays(to, 1), tz)), calendars.todos()]);
				const open = todos.filter((todo) => !todo.done);
				return done(
					[
						`予定（${from}〜${to}）`,
						...(events.length === 0 ? ["- なし"] : events.map((event) => `- ${formatEvent(event, tz)} [${event.id}]`)),
						"",
						"未完了のタスク",
						...(open.length === 0 ? ["- なし"] : open.map((todo) => `- ${formatTodo(todo, tz)} [${todo.id}]`)),
					].join("\n"),
				);
			},
		}),
		defineTool({
			name: "calendar_create",
			description: "予定またはタスクを1件登録する。ユーザーが実行する意思を明示し、内容が具体的なときだけ使う。",
			parameters: obj({
				calendar: str({ description: `登録先: ${names.join(" / ")}` }),
				summary: str({ description: "件名", minLength: 1 }),
				start: opt(str({ description: `予定の開始。${WHEN}。予定では必須。` })),
				end: opt(str({ description: "予定の終了。省略すると時刻つきは1時間、終日は1日。終日の end は最後の日。" })),
				due: opt(str({ description: `タスクの期日。${WHEN}。` })),
				location: opt(str({ description: "場所" })),
				description: opt(str({ description: "メモ" })),
			}),
			replay: "safe",
			execute: async (args, api, context) => {
				const kind = calendars.calendars[args.calendar]?.kind;
				let fields: EventFields | TodoFields;
				if (kind === "todos") {
					if (args.start !== undefined || args.end !== undefined) throw new CalendarError("タスクに start / end はありません。期日は due で指定してください。");
					fields = { summary: args.summary, due: args.due, description: args.description };
				} else {
					if (args.start === undefined) throw new CalendarError("予定には start が必要です。");
					if (args.due !== undefined) throw new CalendarError("予定に due はありません。日時は start / end で指定してください。");
					fields = { summary: args.summary, start: args.start, end: args.end, location: args.location, description: args.description };
				}
				// Remembered with the call: a rerun after a crash writes the same object instead of a second one.
				const uid = await api.memo("uid", randomUUID(), context);
				const id = await calendars.create(args.calendar, uid, fields, api.now());
				await noteOwnWrite(id);
				return done(`登録しました: ${await calendars.describe(id)} [${id}]`);
			},
		}),
		defineTool({
			name: "calendar_update",
			description:
				"既存の予定・タスクを変更する。1回目は変更を記録するだけで、確認コードを返す。ユーザーに内容を示して承諾を得てから、id と confirm だけを付けてもう一度呼ぶと実行される。繰り返し予定は全ての回が変わる。",
			parameters: obj({
				id: str({ description: "calendar_list が返した id", minLength: 1 }),
				summary: opt(str({ description: "新しい件名" })),
				start: opt(str({ description: `予定の新しい開始。${WHEN}。end を省略すると長さを保って移動する。` })),
				end: opt(str({ description: "予定の新しい終了" })),
				due: opt(str({ description: `タスクの新しい期日。${WHEN}。空文字で期日を消す。` })),
				location: opt(str({ description: "新しい場所。空文字で消す。" })),
				description: opt(str({ description: "新しいメモ。空文字で消す。" })),
				confirm: opt(str({ description: "ユーザーの承諾を得た後に付ける確認コード" })),
			}),
			replay: "safe",
			execute: async (args, api, context) => {
				const { id, confirm, ...changes } = args;
				splitId(id);
				const action = Object.values(changes).some((value) => value !== undefined) ? ({ kind: "update", id, changes } as const) : undefined;
				return done(await gate("calendar_update", action, confirm, api, await runInputs(api, context), context));
			},
		}),
		defineTool({
			name: "calendar_delete",
			description:
				"既存の予定・タスクを削除する。1回目は記録するだけで、確認コードを返す。ユーザーに内容を示して承諾を得てから、id と confirm を付けてもう一度呼ぶと実行される。繰り返し予定は全ての回が消える。",
			parameters: obj({
				id: str({ description: "calendar_list が返した id", minLength: 1 }),
				confirm: opt(str({ description: "ユーザーの承諾を得た後に付ける確認コード" })),
			}),
			replay: "safe",
			execute: async (args, api, context) => {
				splitId(args.id);
				return done(await gate("calendar_delete", { kind: "delete", id: args.id }, args.confirm, api, await runInputs(api, context), context));
			},
		}),
		defineTool({
			name: "calendar_complete",
			description: "タスクを完了にする。ユーザーが終えたと言ったときに使う。確認は要らない。",
			parameters: obj({ id: str({ description: "calendar_list が返した id", minLength: 1 }) }),
			replay: "safe",
			execute: async (args, api) => {
				await calendars.complete(args.id, api.now());
				await noteOwnWrite(args.id);
				return done("完了にしました。");
			},
		}),
		...(weather === undefined
			? []
			: [
					defineTool({
						name: "weather_forecast",
						description: "ユーザーの地域の天気予報（気象庁、今日から数日分）を取得する。",
						parameters: obj({}),
						replay: "safe",
						execute: async () => done(formatForecast(await weather())),
					}),
				]),
	];

	const calendarLines = Object.entries(calendars.calendars).map(([name, calendar]) => `- ${name}（${calendar.kind === "todos" ? "タスク" : "予定"}）: ${calendar.description}`);
	return defineExtension({
		name: "calendar",
		sections: [
			section("calendar", () =>
				[
					"予定とタスクの正はカレンダー（CalDAV）にある。記憶や会話の内容より、calendar_list の結果を信じる。",
					...calendarLines,
					"",
					"- ユーザーが実行する意思を明示し、日時や内容が具体的な予定・タスクは、その場で calendar_create で登録する。曖昧なら登録せずに尋ねる。",
					"- 登録の前に、同じものが既に無いか calendar_list で確かめる。",
					"- 既存の項目の変更と削除は、必ずユーザーに内容を示して承諾を得てから行う。ツールがその手順を強制する。",
					"- ユーザーが終えたと言ったタスクは calendar_complete で完了にする。",
					"- 日時は各発言の先頭にある時刻を基準に、ユーザーの現地時刻で解釈する。",
					"- 繰り返す予定の新規作成はできない。頼まれたら、できないと伝える。",
				].join("\n"),
			),
		],
		tools,
	});
}
