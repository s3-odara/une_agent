import { createHash } from "node:crypto";
import { type CalItem, type Calendars, type EventItem, formatEvent, formatTodo, normalizeEtag, type TodoItem } from "./calendar.ts";
import type { Config } from "./config.ts";
import { errorMessage } from "./errors.ts";
import type { HostDb } from "./hostdb.ts";
import { formatTidy, type TidyChange } from "./tidy.ts";
import { addDays, dateOf, daysBetween, formatDay, formatStamp, minutesOfDay, startOfDay } from "./time.ts";
import { formatForecast, type WeatherSource } from "./weather.ts";

/** One thing worth telling the user, with the ledger key that keeps it from being told twice. */
/** Something to tell the user: a reminder, or news of an item someone else added or changed. */
type Trigger = { readonly kind: "reminder" | "change"; readonly key: string; readonly line: string };

/** How far ahead events are read: what "added or changed" covers. */
const LOOKAHEAD_DAYS = 60;

/** Timed events that start within the lead time. One reminder per occurrence. */
function eventReminders(events: readonly EventItem[], now: number, leadMinutes: number, tz: string): Trigger[] {
	return events
		.filter((event) => !event.allDay && event.start > now && event.start - now <= leadMinutes * 60_000)
		.map((event) => ({
			kind: "reminder" as const,
			key: `soon:${event.id}:${event.start}`,
			line: `まもなく開始（約${Math.round((event.start - now) / 60_000)}分後）: ${formatEvent(event, tz)}`,
		}));
}

/** Open tasks whose due date is exactly one of the lead days away. One reminder per task, due date and lead. */
function dueReminders(todos: readonly TodoItem[], today: string, leadDays: readonly number[], tz: string): Trigger[] {
	return todos.flatMap((todo) => {
		if (todo.done || todo.due === undefined) return [];
		const days = daysBetween(today, todo.due.date);
		if (!leadDays.includes(days)) return [];
		const when = days === 0 ? "今日が期日" : days === 1 ? "明日が期日" : `${days}日後が期日`;
		return [{ kind: "reminder" as const, key: `due:${todo.id}:${todo.due.date}:${days}`, line: `${when}: ${formatTodo(todo, tz)}` }];
	});
}

/**
 * Upcoming events and open tasks that were added or changed since the last check, by someone other than the agent.
 *
 * An item counts when its ETag differs from the one last seen and the item itself says it was written since the last
 * check. The second condition matters: an event made long ago enters the lookahead window as time passes and is new
 * to the snapshot without being news. An item that does not say when it was written is never reported.
 */
function changedItems(items: readonly CalItem[], seen: ReadonlyMap<string, string>, since: number | undefined, tz: string): Trigger[] {
	if (since === undefined) return [];
	const reported = new Set<string>();
	return items.flatMap((item) => {
		const etag = normalizeEtag(item.etag);
		if (etag === "" || reported.has(item.id) || seen.get(item.id) === etag) return [];
		if (item.modified === undefined || item.modified < since - 60_000) return [];
		if (item.kind === "todo" && item.done) return [];
		// A recurring event is reported once, by its next occurrence.
		reported.add(item.id);
		const what = seen.has(item.id) ? "変更された" : "追加された";
		const line = item.kind === "event" ? `${what}予定: ${formatEvent(item, tz)}` : `${what}タスク: ${formatTodo(item, tz)}`;
		return [{ kind: "change" as const, key: `chg:${item.id}:${etag}`, line }];
	});
}

export type SchedulerOptions = {
	readonly config: Config;
	readonly db: HostDb;
	readonly calendars?: Calendars;
	readonly weather?: WeatherSource;
	/** Asks the room's persona to write something; resolves once the request is stored (`Bridge.submitScheduled`). */
	readonly submit: (roomId: string, key: string, content: string) => Promise<void>;
	/** Sends a plain notice (`Bridge.notice`). */
	readonly notice: (roomId: string, key: string, body: string) => Promise<void>;
	/** The memory tidy, when it is on. */
	readonly tidy?: { fingerprint(): string; run(date: string): Promise<TidyChange[]> };
	readonly now?: () => number;
	/** How long after `start()` the first check runs: the gateway needs a moment before it can send. */
	readonly startDelayMs?: number;
	readonly log?: (message: string) => void;
};

/**
 * What the agent does without being asked: the morning brief, reminders, news of calendar changes, and the memory tidy.
 *
 * Whether anything is due is decided here in code, on every tick, without the model. The model is only woken to word a
 * message that is certain to be sent. What has been sent is recorded in the ledger (`HostDb.markNotified`) after the
 * request is stored; a crash between the two repeats the request under the same key, which changes nothing.
 */
export class Scheduler {
	readonly #options: SchedulerOptions;
	readonly #now: () => number;
	readonly #log: (message: string) => void;
	#running = false;
	#timers: NodeJS.Timeout[] = [];

	constructor(options: SchedulerOptions) {
		this.#options = options;
		this.#now = options.now ?? Date.now;
		this.#log = options.log ?? ((message) => console.error(message));
	}

	/** Checks shortly after the start, then every `tickMinutes`. */
	start(): void {
		const minutes = this.#options.config.proactive?.tickMinutes ?? 15;
		this.#timers = [setTimeout(() => void this.tick(), this.#options.startDelayMs ?? 20_000), setInterval(() => void this.tick(), minutes * 60_000)];
	}

	stop(): void {
		for (const timer of this.#timers) clearTimeout(timer);
		this.#timers = [];
	}

	/** One check. A tick that arrives while another is still running is dropped. */
	async tick(): Promise<void> {
		if (this.#running) return;
		this.#running = true;
		try {
			const now = this.#now();
			await this.#tidy(now).catch((error) => this.#log(`memory tidy failed: ${errorMessage(error)}`));
			await this.#calendar(now).catch((error) => this.#log(`calendar check failed: ${errorMessage(error)}`));
		} finally {
			this.#running = false;
		}
	}

	async #tidy(now: number): Promise<void> {
		const { config, db, tidy } = this.#options;
		if (tidy === undefined || config.memory.tidyAt === undefined) return;
		const today = dateOf(now, config.timezone);
		if (minutesOfDay(now, config.timezone) < config.memory.tidyAt) return;
		const last = db.value("tidy.date");
		if (last !== undefined && daysBetween(last, today) < config.memory.tidyEveryDays) return;

		// Nothing was written since the last tidy: there is nothing to look at a second time.
		if (tidy.fingerprint() !== db.value("tidy.fingerprint")) {
			const changes = await tidy.run(today);
			db.setValue("tidy.fingerprint", tidy.fingerprint());
			if (changes.length > 0 && config.proactive !== undefined) {
				await this.#options.notice(config.proactive.roomId, `tidy:${today}`, formatTidy(changes)).catch((error) => this.#log(`tidy notice failed: ${errorMessage(error)}`));
			}
		}
		db.setValue("tidy.date", today);
	}

	async #calendar(now: number): Promise<void> {
		const { config, db, calendars } = this.#options;
		const proactive = config.proactive;
		if (proactive === undefined || calendars === undefined) return;
		const tz = config.timezone;
		const today = dateOf(now, tz);
		const minutes = minutesOfDay(now, tz);
		const inWindow = minutes >= proactive.windowStart && minutes < proactive.windowEnd;
		const briefDue = minutes >= proactive.briefAt && minutes < proactive.windowEnd && !db.wasNotified(`brief:${today}`);
		if (!inWindow && !briefDue) return;

		let events: EventItem[];
		let todos: TodoItem[];
		try {
			[events, todos] = await Promise.all([calendars.events(startOfDay(today, tz), startOfDay(addDays(today, LOOKAHEAD_DAYS), tz)), calendars.todos()]);
		} catch (error) {
			// Said once a day: a brief that silently never comes is worse than one message about why.
			const key = `caldav-down:${today}`;
			this.#log(`calendar fetch failed: ${errorMessage(error)}`);
			if (!db.wasNotified(key)) {
				await this.#options.notice(proactive.roomId, key, `カレンダー（CalDAV）に接続できません: ${errorMessage(error)}\n復旧するまで、ブリーフとリマインドは送れません。`);
				db.markNotified([key], now);
			}
			return;
		}

		const upcoming = events.filter((event) => event.end > now);
		const since = db.value("calendar.checked");
		const triggers = [
			...eventReminders(upcoming, now, proactive.eventLeadMinutes, tz),
			...dueReminders(todos, today, proactive.dueLeadDays, tz),
			...changedItems([...upcoming, ...todos], db.seenItems(), since === undefined ? undefined : Number(since), tz),
		].filter((trigger) => !db.wasNotified(trigger.key));
		const stamp = formatStamp(now, tz);

		if (briefDue) {
			// The brief covers everything due right now, so none of it is sent again as a reminder.
			await this.#options.submit(proactive.roomId, `brief:${today}`, await this.#brief(stamp, today, events, todos, triggers));
			db.markNotified([`brief:${today}`, ...triggers.map((trigger) => trigger.key)], now);
		} else if (triggers.length > 0) {
			const keys = triggers.map((trigger) => trigger.key).sort();
			const key = `check:${createHash("sha256").update(keys.join("\n")).digest("hex").slice(0, 16)}`;
			const content = [
				`[定時チェック ${stamp}]`,
				"これはユーザーの発言ではなく、スケジューラからの通知です。次の内容をユーザーに簡潔に知らせてください。ここに無いことは足さないでください。",
				"",
				...triggers.map((trigger) => `- ${trigger.line}`),
			].join("\n");
			await this.#options.submit(proactive.roomId, key, content);
			db.markNotified(keys, now);
		}

		db.replaceSeenItems(new Map([...upcoming, ...todos].flatMap((item) => (normalizeEtag(item.etag) === "" ? [] : [[item.id, normalizeEtag(item.etag)] as const]))));
		db.setValue("calendar.checked", String(now));
	}

	async #brief(stamp: string, today: string, events: readonly EventItem[], todos: readonly TodoItem[], triggers: readonly Trigger[]): Promise<string> {
		const { config, weather } = this.#options;
		const tz = config.timezone;
		const tomorrow = addDays(today, 1);
		const on = (date: string) => {
			const [from, to] = [startOfDay(date, tz), startOfDay(addDays(date, 1), tz)];
			const lines = events.filter((event) => event.start < to && Math.max(event.end, event.start + 1) > from).map((event) => `- ${formatEvent(event, tz)}`);
			return lines.length === 0 ? ["- なし"] : lines;
		};

		const open = todos.filter((todo) => !todo.done);
		const dated = open.flatMap((todo) => (todo.due === undefined ? [] : [{ todo, days: daysBetween(today, todo.due.date) }]));
		const soon = dated.filter(({ days }) => days <= 7).map(({ todo, days }) => `- ${formatTodo(todo, tz)}${days < 0 ? `（期日を${-days}日過ぎている）` : days === 0 ? "（今日）" : ""}`);
		const later = open.length - soon.length;

		let forecast: string | undefined;
		if (weather !== undefined) {
			forecast = await weather().then(
				(result) => formatForecast(result, [today, tomorrow]),
				(error) => {
					this.#log(`weather failed: ${errorMessage(error)}`);
					return "天気予報を取得できませんでした。";
				},
			);
		}
		const news = triggers.filter((trigger) => trigger.kind === "change");
		// The reminders that fall due now: the brief is sent in their place, so it has to say them.
		const reminders = triggers.filter((trigger) => trigger.kind === "reminder");

		return [
			`[朝ブリーフ ${stamp}]`,
			"これはユーザーの発言ではなく、スケジューラからの依頼です。下のデータだけを使って、今日の朝のブリーフを書いてください。",
			"- 今日と明日の予定を時刻順に伝える。無ければ無いと書く。",
			...(forecast === undefined ? [] : ["- 天気を一言で伝える。外出を伴いそうな予定があれば、その時間帯の降水確率に触れる。"]),
			"- 7日以内に期日が来るタスクと、期日を過ぎたタスクを伝える。",
			...(reminders.length === 0 ? [] : ["- 「いま知らせること」にある項目は、埋もれないように必ず触れる。"]),
			"- データに無いことは書かない。短く、読みやすく。",
			"",
			`## 今日 ${formatDay(today)} の予定`,
			...on(today),
			"",
			`## 明日 ${formatDay(tomorrow)} の予定`,
			...on(tomorrow),
			"",
			"## 期日が7日以内、または過ぎているタスク",
			...(soon.length === 0 ? ["- なし"] : soon),
			...(later > 0 ? [`（ほかに、期日が先または期日なしの未完了タスクが ${later} 件）`] : []),
			...(reminders.length === 0 ? [] : ["", "## いま知らせること", ...reminders.map((trigger) => `- ${trigger.line}`)]),
			...(forecast === undefined ? [] : ["", "## 天気", forecast]),
			...(news.length === 0 ? [] : ["", "## 前回の確認以降に追加・変更された項目", ...news.map((trigger) => `- ${trigger.line}`)]),
		].join("\n");
	}
}
