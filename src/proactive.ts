import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool, type Harness, hook, section, ToolTask } from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME } from "@earendil-works/pi-durable/codemode";
import { TOOL_SEARCH_TOOL_NAME } from "@earendil-works/pi-durable/tool-search";
import { obj, str } from "@earendil-works/pi-schema";
import { answerOf } from "./answer.ts";
import { errorMessage } from "./errors.ts";
import type { Aside, HostDb, Wake } from "./hostdb.ts";
import { textOutput } from "./text.ts";
import { formatStamp, localToEpoch } from "./time.ts";

/** What `Proactive` needs of the bridge to the rooms. */
export interface Rooms {
	startAside(roomId: string): Promise<Aside | undefined>;
	adopt(roomId: string, aside: Aside): Promise<boolean>;
	say(roomId: string, txnId: string, body: string): Promise<string>;
	/** Runs the room's conversation on from what the aside answered, with every tool there is. */
	continueRun(roomId: string, key: string): Promise<void>;
}

export type ProactiveOptions = {
	readonly harness: Harness;
	readonly db: HostDb;
	readonly rooms: Rooms;
	readonly context: Context;
	readonly now?: () => number;
	readonly log?: (message: string) => void;
};

/** The line an aside's answer ends with to have what it weighed up carried out once its conversation is the room's. */
const CONTINUATION = "実行継続";

/** The last non-empty line is checked, so anything above it is the answer. */
export function withoutContinuation(text: string): { readonly body: string; readonly continues: boolean } {
	const last = text.split("\n").findLast((line) => line.trim() !== "");
	if (last === undefined || last.trim() !== CONTINUATION) return { body: text, continues: false };
	return { body: text.slice(0, text.lastIndexOf(last)).trimEnd(), continues: true };
}

/** A brief or a check not weighed by then is of no use any more. */
const CHECK_STALE_MS = 3 * 3_600_000;
/** A timer is kept longer: the user asked for it, and late is better than never, though not days late. */
const TIMER_STALE_MS = 24 * 3_600_000;

/**
 * Whether to speak is the model's to decide, in a conversation made aside from the room's: a check that ends in silence
 * leaves nothing behind, so the room's conversation does not fill with silent checks that teach the model to stay
 * silent. One that speaks becomes the room's conversation, so what was said is there to be asked about and not said
 * again.
 *
 * Every step can be repeated after a crash: the wake and its aside are in the ledger, the aside's submission has the
 * wake's key as its request ID, adopting what is already adopted succeeds, and the message is sent under a transaction
 * ID of the key.
 */
export class Proactive {
	readonly #options: ProactiveOptions;
	readonly #now: () => number;
	readonly #log: (message: string) => void;
	#running: Promise<void> | undefined;
	#again = false;

	constructor(options: ProactiveOptions) {
		this.#options = options;
		this.#now = options.now ?? Date.now;
		this.#log = options.log ?? ((message) => console.error(message));
	}

	/**
	 * Weighs every open wake: the rooms side by side, each room's one at a time in the order they came. A call while that
	 * goes on makes it go round once more.
	 */
	run(): Promise<void> {
		if (this.#running !== undefined) {
			this.#again = true;
			return this.#running;
		}
		this.#running = (async () => {
			do {
				this.#again = false;
				const rooms = Map.groupBy(this.#options.db.openWakes(), (wake) => wake.roomId);
				await Promise.all(
					[...rooms.values()].map(async (wakes) => {
						for (const wake of wakes) await this.#weigh(wake).catch((error) => this.#log(`weighing ${wake.key} failed: ${errorMessage(error)}`));
					}),
				);
			} while (this.#again);
		})().finally(() => (this.#running = undefined));
		return this.#running;
	}

	async #weigh(wake: Wake): Promise<void> {
		const { harness, db, rooms, context } = this.#options;
		let aside = wake.aside;
		if (aside === undefined) {
			if (this.#now() - wake.createdAt > (wake.kind === "timer" ? TIMER_STALE_MS : CHECK_STALE_MS)) return db.endWake(wake.key, "expired");
			aside = await rooms.startAside(wake.roomId);
			// The room's conversation is at work; the next run tries again.
			if (aside === undefined) return;
			db.setAside(wake.key, aside);
		}

		const conversation = await harness.conversation(aside.conversationId as never, context);
		if (conversation === undefined) {
			db.setAside(wake.key, undefined);
			return;
		}
		const submission = await conversation.submit({ type: "input", content: wake.content, requestId: `wake:${wake.key}` }, context);
		const answer = await answerOf(harness, await submission.wait(context), context);
		if (!answer.ok && answer.empty) return db.endWake(wake.key, "silent");
		if (!answer.ok) {
			// The model could not be reached, or the run failed: not a decision to stay silent. The next tick tries again.
			this.#log(`${wake.key} ended without a decision, to be weighed again: ${answer.reason}`);
			return db.setAside(wake.key, undefined);
		}
		if (!(await rooms.adopt(wake.roomId, aside))) {
			// The room's conversation moved on meanwhile: weigh it again from where it is now.
			db.setAside(wake.key, undefined);
			this.#again = true;
			return;
		}
		const { body, continues } = withoutContinuation(answer.text);
		if (body !== "") await rooms.say(wake.roomId, `reply:wake:${wake.key}`, body);
		db.endWake(wake.key, "sent");
		// The conversation is the room's now, so what the aside weighed up is carried out with every tool there is.
		if (continues) await rooms.continueRun(wake.roomId, wake.key).catch((error) => this.#log(`continuing ${wake.key} failed: ${errorMessage(error)}`));
	}
}

/**
 * The tools that only read. A check that is thrown away must not have done anything, so while one is weighed every other
 * tool is refused, those added later and those of MCP servers included. Reading pages in the browser is among them: the
 * worst a thrown-away aside leaves behind is a tab opened. A script's calls are refused one by one, as any call is, so
 * `codemode` itself may run; a screenshot shared to the room from there is refused by the tool itself.
 */
const READS: ReadonlySet<string> = new Set([
	"read",
	"calendar_list",
	"weather_forecast",
	"weather_forecast_area",
	"weather_forecast_grid",
	"weather_rain",
	"weather_rain_grid",
	"geocode",
	"web_extract",
	"timer_list",
	"stay_silent",
	"browser_open",
	"browser_snapshot",
	"browser_read",
	"browser_screenshot",
	CODEMODE_TOOL_NAME,
	TOOL_SEARCH_TOOL_NAME,
]);

export const WEIGHING_REFUSAL = "自分から話しかけるかを決めている間は、書き込むツールは使えません。実行が必要なら、返答の最後の行を「実行継続」だけにしてください。";

export type ProactiveExtensionOptions = {
	readonly db: HostDb;
	readonly tz: string;
	/** Told when a timer is added or removed, so the next one is waited for. */
	readonly onTimers?: () => void;
	/** Tools besides the agent's own that only read, such as an MCP server's. */
	readonly reads?: (tool: string) => boolean;
};

/**
 * Its tools are offered in every conversation, so an aside offers the same tools as the room's conversation and the
 * provider's prompt cache holds for it.
 */
export function createProactiveExtension(options: ProactiveExtensionOptions) {
	const { db, tz } = options;
	const roomOf = (conversationId: unknown) => db.requireRoom(Number(conversationId));
	const reads = (tool: string) => READS.has(tool) || options.reads?.(tool) === true;

	return defineExtension({
		name: "proactive",
		sections: [
			section("proactive", () =>
				[
					"朝のブリーフ、定時の確認、カレンダーの動き、約束の時刻に起こされ、この会話を読み返して、伝えることがあれば自分から話しかける。",
					"- ユーザーが時刻を決めて頼んだこと（「20時に教えて」「金曜の夜に結果を聞いて」）は timer_add で登録する。",
					"- 時刻の決まっていない「あとで聞く」は登録しない。定時の確認で会話から拾う。",
					"- 予定やタスクそのものはカレンダーに登録する。予定の前の知らせは、決まった時刻を頼まれたときだけ timer で足す。",
				].join("\n"),
			),
		],
		tools: [
			defineTool({
				name: "stay_silent",
				description: "自分から話しかけるかを決める確認で、いまは話しかけないときに呼ぶ。呼ぶときは文章を書かない。確認のとき以外は使えない。",
				parameters: obj({}),
				replay: "safe",
				execute: async (_args, api) => {
					if (!db.isWeighing(Number(api.conversationId))) throw new Error("自分から話しかけるかを決める確認のときだけ使えます。");
					return { ...textOutput("今回は話しかけません。"), control: { terminate: true } };
				},
			}),
			defineTool({
				name: "timer_add",
				description: "決まった時刻に自分から話しかけるよう登録する。",
				parameters: obj({
					at: str({ description: "時刻。ユーザーの現地時刻で YYYY-MM-DDTHH:MM", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$" }),
					note: str({ description: "その時刻に何をするか。会話を読み返さなくても分かるように具体的に（例: 14時の面接の結果を聞く）", minLength: 1 }),
				}),
				replay: "safe",
				execute: async (args, api, context) => {
					const dueAt = localToEpoch(args.at, tz);
					if (dueAt <= api.now()) throw new Error(`${args.at} は過ぎています。`);
					// Remembered with the call: a rerun after a crash adds the same timer instead of a second one.
					const id = await api.memo("id", randomUUID().slice(0, 8), context);
					db.addTimer({ id, roomId: roomOf(api.conversationId), dueAt, note: args.note, createdAt: api.now() });
					options.onTimers?.();
					return textOutput(`${formatStamp(dueAt, tz)} に登録しました [${id}]`);
				},
			}),
			defineTool({
				name: "timer_list",
				description: "このルームで登録した、まだ来ていない時刻の一覧。",
				parameters: obj({}),
				replay: "safe",
				execute: async (_args, api) => {
					const timers = db.timers(roomOf(api.conversationId));
					return textOutput(timers.length === 0 ? "登録はありません。" : timers.map((timer) => `- ${formatStamp(timer.dueAt, tz)} ${timer.note} [${timer.id}]`).join("\n"));
				},
			}),
			defineTool({
				name: "timer_cancel",
				description: "登録した時刻を取り消す。",
				parameters: obj({ id: str({ description: "timer_add か timer_list が返した id", minLength: 1 }) }),
				replay: "safe",
				execute: async (args, api) => {
					const removed = db.removeTimer(args.id, roomOf(api.conversationId));
					options.onTimers?.();
					return textOutput(removed ? "取り消しました。" : "その id の登録はありません（もう来たか、取り消し済み）。");
				},
			}),
		],
		hooks: [
			hook(ToolTask, {
				beforeTool: (call, api) => (db.isWeighing(Number(api.conversationId)) && !reads(call.name) ? { block: WEIGHING_REFUSAL } : undefined),
			}),
		],
	});
}
