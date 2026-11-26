import { createHash } from "node:crypto";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { type CalItem, type Calendars, type EventItem, formatEvent, formatTodo, normalizeEtag, type TodoItem } from "./calendar.ts";
import type { Config } from "./config.ts";
import { errorMessage } from "./errors.ts";
import type { HostDb, Wake } from "./hostdb.ts";
import { formatTidy, type TidyChange } from "./tidy.ts";
import { addDays, dateOf, daysBetween, formatClock, formatDay, formatStamp, localToEpoch, startOfDay } from "./time.ts";
import { JMA_TIME_ZONE } from "./weather-areas.ts";
import { formatForecast, type WeatherSource } from "./weather.ts";

type Trigger = { readonly kind: "reminder" | "change"; readonly key: string; readonly line: string };

const LOOKAHEAD_DAYS = 60;

function eventReminders(events: readonly EventItem[], now: number, leadMinutes: number, tz: string): Trigger[] {
	return events
		.filter((event) => !event.allDay && event.start > now && event.start - now <= leadMinutes * 60_000)
		.map((event) => ({
			kind: "reminder" as const,
			key: `soon:${event.id}:${event.start}`,
			line: `まもなく開始（約${Math.round((event.start - now) / 60_000)}分後）: ${formatEvent(event, tz)}`,
		}));
}

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
	readonly weigh?: () => void;
	readonly runTimer?: (roomId: string, id: string, content: string) => Promise<void>;
	readonly notice: (roomId: string, key: string, body: string) => Promise<void>;
	readonly tidy?: { fingerprint(): string; run(date: string): Promise<TidyChange[]> };
	readonly filesDir?: string;
	readonly filesTtlMs?: number;
	readonly now?: () => number;
	/** The gateway needs a moment before it can send. */
	readonly startDelayMs?: number;
	readonly log?: (message: string) => void;
};

/** The longest a timer is waited for in one go; past it the wait is set again. */
const MAX_WAIT_MS = 3_600_000;

/** A check found this late, after the agent was down, is skipped: it would come at a time no one asked for. */
const CHECK_LATENESS_MS = 60 * 60_000;
const DEFAULT_FILES_TTL_MS = 7 * 86_400_000;

/** What every wake is, whatever it is for. When to speak is said by each kind of wake. */
const ASIDE = [
	"これはユーザーの発言ではなく、自分から話しかけるかを決める確認。返答はそのままユーザーへのメッセージとしてルームに送られ、通知が鳴る。",
	"- 話しかけないなら、文章を書かずに stay_silent を呼ぶ（「特にありません」とも書かない）。",
	"- この確認の間は、書き込むツール（記憶、カレンダー、timer、bash など）と、ページを書き換えるブラウザ操作（クリック、入力、ログイン）は使えない。読むだけのブラウザ操作はできる。",
	"- 書き込みや実行が必要なら、この返答でユーザーに提案・確認する（実行はユーザーの返信後に行う）。",
];

/** A check comes several times a day whether or not there is anything to say. */
const CHECK = [
	"- 話題の補足、雑談、挨拶だけのためには話しかけない。",
	"- 会話の中ですでに伝えたことは繰り返さない。",
];

/**
 * The brief mentions the day's events; without this, the model takes the reminder of one for a repetition and stays
 * silent.
 */
export const NEAR = "（時刻や期日が近づいたという知らせ。朝のブリーフなどで予定そのものに触れていても、近づいたことはまだ伝えていないので伝える）";

/**
 * When to wake the model is decided here in code, without the model: at the brief, at the check times, when the
 * calendar has something to tell, when a task falls due at its hour, and when a timer falls due. Whether to say
 * anything, and what, is the model's to decide (see `Proactive`). What it was woken for is recorded in the ledger (`HostDb.markNotified`) after the wake is
 * stored; a crash between the two repeats the wake under the same key, which changes nothing.
 */
export class Scheduler {
	readonly #options: SchedulerOptions;
	readonly #now: () => number;
	readonly #log: (message: string) => void;
	#running = false;
	#timers: NodeJS.Timeout[] = [];
	#timerWait: NodeJS.Timeout | undefined;

	constructor(options: SchedulerOptions) {
		this.#options = options;
		this.#now = options.now ?? Date.now;
		this.#log = options.log ?? ((message) => console.error(message));
	}

	start(): void {
		const minutes = this.#options.config.proactive?.tickMinutes ?? 15;
		this.#timers = [setTimeout(() => void this.tick(), this.#options.startDelayMs ?? 20_000), setInterval(() => void this.tick(), minutes * 60_000)];
	}

	stop(): void {
		for (const timer of this.#timers) clearTimeout(timer);
		this.#timers = [];
		clearTimeout(this.#timerWait);
		this.#timerWait = undefined;
	}

	/** A timer was added or removed: the next one is waited for on its own, so it comes on time rather than at a tick. */
	timersChanged(): void {
		if (this.#timers.length === 0) return;
		clearTimeout(this.#timerWait);
		const [next] = this.#options.db.timers();
		if (next === undefined) return;
		this.#timerWait = setTimeout(() => void this.tick(), Math.min(Math.max(next.dueAt - this.#now(), 0), MAX_WAIT_MS));
	}

	async tick(): Promise<void> {
		if (this.#running) return;
		this.#running = true;
		try {
			const now = this.#now();
			await this.#cleanFiles(now).catch((error) => this.#log(`cleaning received files failed: ${errorMessage(error)}`));
			await this.#tidy(now).catch((error) => this.#log(`memory tidy failed: ${errorMessage(error)}`));
			await this.#dueTimers(now).catch((error) => this.#log(`timers failed: ${errorMessage(error)}`));
			await this.#proactive(now).catch((error) => this.#log(`proactive check failed: ${errorMessage(error)}`));
			this.#options.weigh?.();
		} finally {
			this.#running = false;
			this.timersChanged();
		}
	}

	#wake(now: number, wake: Omit<Wake, "aside" | "createdAt">): void {
		this.#options.db.addWake({ ...wake, createdAt: now });
	}

	async #cleanFiles(now: number): Promise<void> {
		const dir = this.#options.filesDir;
		if (dir === undefined) return;
		const cutoff = now - (this.#options.filesTtlMs ?? DEFAULT_FILES_TTL_MS);
		let names: string[];
		try {
			names = await readdir(dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for (const name of names) {
			const path = join(dir, name);
			const info = await stat(path).catch(() => undefined);
			if (info?.isFile() && info.mtimeMs < cutoff) await rm(path, { force: true });
		}
	}

	async #tidy(now: number): Promise<void> {
		const { config, db, tidy } = this.#options;
		if (tidy === undefined || config.memory.tidyTime === null) return;
		const today = dateOf(now, config.timezone);
		if (formatClock(now, config.timezone) < config.memory.tidyTime) return;
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

	/** At any hour: the user set the time. Runs directly in the room with full tools instead of an aside. */
	async #dueTimers(now: number): Promise<void> {
		const { config, db, runTimer } = this.#options;
		if (runTimer === undefined) return;
		const tz = config.timezone;
		for (const timer of db.timers().filter((item) => item.dueAt <= now)) {
			const content = [
				`[約束の時刻 ${formatStamp(now, tz)}]`,
				`これはユーザーの発言ではなく、timer_add で ${formatStamp(timer.createdAt, tz)} に登録した時刻（${formatStamp(timer.dueAt, tz)}）の自動実行。登録した内容を実行または確認し、結果をユーザーに伝える。`,
				"すでに会話の中で済んでいる（ユーザーがもう済ませた、要らなくなったと言った）場合は実行せず、その旨を短く触れるだけでよい。",
				"",
				"登録した内容:",
				timer.note,
			].join("\n");
			await runTimer(timer.roomId, timer.id, content);
			db.markTimerFired(timer.id);
		}
	}

	async #proactive(now: number): Promise<void> {
		const { config, db, calendars } = this.#options;
		const proactive = config.proactive;
		if (proactive === undefined) return;
		const tz = config.timezone;
		const today = dateOf(now, tz);
		// "HH:MM" compares as text in the order of the day.
		const clock = formatClock(now, tz);
		const inWindow = clock >= proactive.windowStart && clock < proactive.windowEnd;
		const briefDue = clock >= proactive.briefTime && clock < proactive.windowEnd && !db.wasNotified(`brief:${today}`);
		const checkDue = proactive.checkTimes.find((time) => {
			const late = now - localToEpoch(`${today}T${time}`, tz);
			return late >= 0 && late < CHECK_LATENESS_MS && !db.wasNotified(`check:${today}:${time}`);
		});
		if (!inWindow && !briefDue && checkDue === undefined) return;
		// Other rooms do not use the calendar, so a CalDAV outage must not hold up their checks.
		if (checkDue !== undefined) await this.#otherRooms(now, today, checkDue);

		const watching = inWindow || briefDue;
		let events: EventItem[] = [];
		let todos: TodoItem[] = [];
		if (calendars !== undefined) {
			try {
				[events, todos] = await Promise.all([calendars.events(startOfDay(today, tz), startOfDay(addDays(today, LOOKAHEAD_DAYS), tz)), calendars.todos()]);
			} catch (error) {
				// Said once a day: a brief that silently never comes is worse than one message about why.
				const key = `caldav-down:${today}`;
				this.#log(`calendar fetch failed: ${errorMessage(error)}`);
				if (watching && !db.wasNotified(key)) {
					await this.#options.notice(proactive.roomId, key, `カレンダー（CalDAV）に接続できません: ${errorMessage(error)}\n復旧するまで、ブリーフと定時の確認はしません。`);
					db.markNotified([key], now);
				}
				return;
			}
		}

		const upcoming = events.filter((event) => event.end > now);
		const since = db.value("calendar.checked");
		// Outside the window the calendar is not weighed for news, so what changed meanwhile is still news when it opens.
		const watchCalendar = calendars !== undefined && watching;
		const triggers = watchCalendar
			? [
					...eventReminders(upcoming, now, proactive.eventLeadMinutes, tz),
					...dueReminders(todos, today, proactive.dueLeadDays, tz),
					...changedItems([...upcoming, ...todos], db.seenItems(), since === undefined ? undefined : Number(since), tz),
				].filter((trigger) => !db.wasNotified(trigger.key))
			: [];
		const stamp = formatStamp(now, tz);
		const keys = triggers.map((trigger) => trigger.key).sort();

		if (briefDue) {
			// The brief covers everything due right now, so none of it is woken for again.
			this.#wake(now, { key: `brief:${today}`, roomId: proactive.roomId, kind: "brief", content: await this.#brief(now, stamp, today, events, todos, triggers) });
			db.markNotified([`brief:${today}`, ...(checkDue === undefined ? [] : [`check:${today}:${checkDue}`]), ...keys], now);
		} else if (checkDue !== undefined || triggers.length > 0) {
			const key = checkDue !== undefined ? `check:${today}:${checkDue}` : `check:${createHash("sha256").update(keys.join("\n")).digest("hex").slice(0, 16)}`;
			this.#wake(now, { key, roomId: proactive.roomId, kind: "check", content: this.#check(stamp, today, events, todos, triggers) });
			db.markNotified([...(checkDue === undefined ? [] : [key]), ...keys], now);
		}

		if (watchCalendar) {
			db.replaceSeenItems(new Map([...upcoming, ...todos].flatMap((item) => (normalizeEtag(item.etag) === "" ? [] : [[item.id, normalizeEtag(item.etag)] as const]))));
			db.setValue("calendar.checked", String(now));
		}
	}

	/**
	 * The other rooms are checked for what was said in them, each by its own persona, so a matter told to one persona is
	 * followed up where it was told. Only a room something was said in since its last check: one where nothing happened
	 * has nothing new to follow up, and each check reads the whole conversation.
	 */
	async #otherRooms(now: number, today: string, time: string): Promise<void> {
		const { config, db } = this.#options;
		const stamp = formatStamp(now, config.timezone);
		for (const [roomId, seq] of this.#options.db.activity()) {
			if (roomId === config.proactive?.roomId || seq <= Number(db.value(`checked:${roomId}`) ?? 0)) continue;
			const content = [
				`[定時チェック ${stamp}]`,
				...ASIDE,
				"",
				"これまでの会話を見て、会話に出た用事やユーザーが気にしていたことのその後（「面接はどうだった？」）で、いま聞くとよいことがあるときだけ、その文面を書く。予定やタスクの知らせは別のルームが受け持つので、ここではしない。",
				...CHECK,
			].join("\n");
			this.#wake(now, { key: `check:${today}:${time}:${roomId}`, roomId, kind: "check", content });
			db.setValue(`checked:${roomId}`, String(seq));
		}
	}

	#calendarLines(today: string, events: readonly EventItem[], todos: readonly TodoItem[]): string[] {
		if (this.#options.calendars === undefined) return [];
		const tz = this.#options.config.timezone;
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
		return [
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
		];
	}

	/** `near` says what to make of the reminders, under their heading. */
	#triggerLines(triggers: readonly Trigger[], near: string): string[] {
		const reminders = triggers.filter((trigger) => trigger.kind === "reminder");
		const news = triggers.filter((trigger) => trigger.kind === "change");
		return [
			...(reminders.length === 0 ? [] : ["", "## いま近づいていること", near, ...reminders.map((trigger) => `- ${trigger.line}`)]),
			...(news.length === 0 ? [] : ["", "## 前回の確認以降に追加・変更された項目（ユーザーかほかの人が書いた）", ...news.map((trigger) => `- ${trigger.line}`)]),
		];
	}

	#check(stamp: string, today: string, events: readonly EventItem[], todos: readonly TodoItem[], triggers: readonly Trigger[]): string {
		return [
			`[定時チェック ${stamp}]`,
			...ASIDE,
			"",
			"これまでの会話と下の材料を見て、いまユーザーが知ると助かること（近づいた予定や期日、追加・変更された予定）か、会話に出た用事やユーザーが気にしていたことのその後（「面接はどうだった？」）があるときだけ、その文面を書く。",
			...CHECK,
			...this.#calendarLines(today, events, todos),
			...this.#triggerLines(triggers, NEAR),
		].join("\n");
	}

	async #brief(now: number, stamp: string, today: string, events: readonly EventItem[], todos: readonly TodoItem[], triggers: readonly Trigger[]): Promise<string> {
		const { weather } = this.#options;
		let forecast: string | undefined;
		if (weather !== undefined) {
			const jmaToday = dateOf(now, JMA_TIME_ZONE);
			forecast = await weather().then(
				(result) => formatForecast(result, [jmaToday, addDays(jmaToday, 1)]),
				(error) => {
					this.#log(`weather failed: ${errorMessage(error)}`);
					return "天気予報を取得できませんでした。";
				},
			);
		}
		const calendar = this.#options.calendars !== undefined;
		return [
			`[朝ブリーフ ${stamp}]`,
			...ASIDE,
			"",
			"下の材料とこれまでの会話から、今日の朝のブリーフを書く。",
			...(calendar ? ["- 今日と明日の予定を時刻順に伝える。予定の無い日は無いと書く。", "- 7日以内に期日が来るタスクと、期日を過ぎたタスクがあれば伝える（無いことは書かない）。"] : []),
			...(forecast === undefined ? [] : ["- 天気を一言で伝える。外出を伴いそうな予定があれば、その時間帯の降水確率に触れる。"]),
			"- 会話に出ていた用事で、今日気にかけるとよいことがあれば一言添える。",
			"- 材料と会話に無いことは書かない。短く、読みやすく。",
			...this.#calendarLines(today, events, todos),
			...this.#triggerLines(triggers, "（ここにある項目は、埋もれないように必ず触れる）"),
			...(forecast === undefined ? [] : ["", "## 天気", forecast]),
		].join("\n");
	}
}
