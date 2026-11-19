import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import type { Approvals } from "./approval.ts";
import { CalendarError, type Calendars, type EventFields, formatEvent, formatTodo, type ItemChanges, splitId, type TodoFields } from "./calendar.ts";
import type { HostDb } from "./hostdb.ts";
import { textOutput } from "./text.ts";
import { addDays, dateOf, startOfDay } from "./time.ts";

export type CalendarToolsOptions = {
	readonly calendars: Calendars;
	readonly db: HostDb;
	readonly approvals: Approvals;
};

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
 * Changing and deleting an existing item ask the user first, in code rather than by instruction (see `Approvals`).
 *
 * Every tool is safe to rerun after a crash: a created item gets a UID remembered with the call, an approval request
 * is remembered with the call too, and changing, completing and deleting all end in the same state however often they
 * are applied.
 */
export function createCalendarExtension(options: CalendarToolsOptions) {
	const { calendars, db, approvals } = options;
	const tz = calendars.tz;
	const names = Object.keys(calendars.calendars);

	/** After the agent's own write: the watcher must not report it back to the user as news. */
	const noteOwnWrite = async (id: string) => db.setSeenItem(id, await calendars.etag(id));

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
				return textOutput(
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
			description: "予定またはタスクを1件登録する。登録を頼まれ、日時と内容が具体的ならその場で登録する。曖昧なら登録せずに尋ねる。登録の前に、同じものが既に無いか calendar_list で確かめる。繰り返す予定は登録できない。",
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
				return textOutput(`登録しました: ${await calendars.describe(id)} [${id}]`);
			},
		}),
		defineTool({
			name: "calendar_update",
			description:
				"既存の予定・タスクを変更する。実行前にツールがユーザーに承認を求め、決定が出るまで待つ。前もって会話で確認を取る必要はない。繰り返し予定は全ての回が変わる。",
			parameters: obj({
				id: str({ description: "calendar_list が返した id", minLength: 1 }),
				summary: opt(str({ description: "新しい件名" })),
				start: opt(str({ description: `予定の新しい開始。${WHEN}。end を省略すると長さを保って移動する。` })),
				end: opt(str({ description: "予定の新しい終了" })),
				due: opt(str({ description: `タスクの新しい期日。${WHEN}。空文字で期日を消す。` })),
				location: opt(str({ description: "新しい場所。空文字で消す。" })),
				description: opt(str({ description: "新しいメモ。空文字で消す。" })),
			}),
			replay: "safe",
			execute: async (args, api, context) => {
				const { id, ...changes } = args;
				splitId(id);
				if (!Object.values(changes).some((value) => value !== undefined)) throw new CalendarError("変更内容がありません。");
				const no = await approvals.forCall("calendar_update", `予定・タスクを変更: ${await calendars.describe(id)}（${describeChanges(changes)}）`, api, context);
				if (no !== undefined) return textOutput(no);
				await calendars.update(id, changes, api.now());
				await noteOwnWrite(id);
				return textOutput(`変更しました: ${await calendars.describe(id)}`);
			},
		}),
		defineTool({
			name: "calendar_delete",
			description:
				"既存の予定・タスクを削除する。実行前にツールがユーザーに承認を求め、決定が出るまで待つ。前もって会話で確認を取る必要はない。繰り返し予定は全ての回が消える。",
			parameters: obj({ id: str({ description: "calendar_list が返した id", minLength: 1 }) }),
			replay: "safe",
			execute: async (args, api, context) => {
				splitId(args.id);
				const target = await calendars.describe(args.id);
				const no = await approvals.forCall("calendar_delete", `予定・タスクを削除: ${target}`, api, context);
				if (no !== undefined) return textOutput(no);
				await calendars.remove(args.id);
				db.setSeenItem(args.id, undefined);
				return textOutput(`削除しました: ${target}`);
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
				return textOutput("完了にしました。");
			},
		}),
	];

	const calendarLines = Object.entries(calendars.calendars).map(([name, calendar]) => `- ${name}（${calendar.kind === "todos" ? "タスク" : "予定"}）: ${calendar.description ?? name}`);
	return defineExtension({
		name: "calendar",
		sections: [
			section("calendar", () =>
				[
					"予定とタスクの正はカレンダー（CalDAV）にある。記憶や会話の内容より、calendar_list の結果を信じる。",
					...calendarLines,
					"",
					"- 頼まれていなくても、ユーザーがこれからの自分の予定を日時つきで話したら（「今日14時から面接なんだよね」）、calendar_list で確かめ、無ければ登録するか短く尋ねる。",
					"- 日時の決まった予定とタスクは記憶に書かない。そこに含まれる今後も役に立つ事実（引っ越し先、人の名前など）は記憶に書いてよい。",
				].join("\n"),
			),
		],
		tools,
	});
}
