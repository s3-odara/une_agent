import { DatabaseSync } from "node:sqlite";

export type Delivery = {
	/** The Matrix event being answered; also the submission's `requestId`. */
	readonly eventId: string;
	readonly roomId: string;
	readonly submissionId: number;
};

/** Event IDs of deliveries the scheduler asked for start with this; Matrix event IDs start with `$`. */
export const SCHEDULED_PREFIX = "sched:";

/** A change to the calendar that waits for the user's yes. */
export type PendingChange = {
	readonly token: string;
	readonly conversationId: number;
	/** The change itself, as JSON. */
	readonly action: string;
	/** The newest submission when the change was proposed: only a user message after it can be the yes. */
	readonly baseline: number;
	readonly createdAt: number;
};

/**
 * The host's own ledger beside the pi-durable session: which conversation a room talks to, and which answers still have
 * to reach Matrix. It is a separate file from the session, so nothing here is atomic with a session commit; every step
 * that uses it is safe to repeat instead (see `Bridge`).
 */
export class HostDb {
	readonly #db: DatabaseSync;

	constructor(path: string) {
		this.#db = new DatabaseSync(path);
		this.#db.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS rooms (
				room_id TEXT PRIMARY KEY,
				conversation_id INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS deliveries (
				event_id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL,
				submission_id INTEGER NOT NULL,
				delivered INTEGER NOT NULL DEFAULT 0,
				reply_event_id TEXT
			);
			CREATE TABLE IF NOT EXISTS notified (
				key TEXT PRIMARY KEY,
				at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS calendar_seen (
				id TEXT PRIMARY KEY,
				etag TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS pending_changes (
				token TEXT PRIMARY KEY,
				conversation_id INTEGER NOT NULL,
				action TEXT NOT NULL,
				baseline INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				done INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE IF NOT EXISTS kv (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
		`);
	}

	conversationOf(roomId: string): number | undefined {
		const row = this.#db.prepare("SELECT conversation_id FROM rooms WHERE room_id = ?").get(roomId);
		return row === undefined ? undefined : Number(row.conversation_id);
	}

	roomOf(conversationId: number): string | undefined {
		const row = this.#db.prepare("SELECT room_id FROM rooms WHERE conversation_id = ?").get(conversationId);
		return row === undefined ? undefined : String(row.room_id);
	}

	setConversation(roomId: string, conversationId: number): void {
		this.#db
			.prepare("INSERT INTO rooms (room_id, conversation_id) VALUES (?, ?) ON CONFLICT (room_id) DO UPDATE SET conversation_id = excluded.conversation_id")
			.run(roomId, conversationId);
	}

	/** Records an answer owed to Matrix. A repeat for the same event changes nothing. */
	addDelivery(delivery: Delivery): void {
		this.#db
			.prepare("INSERT OR IGNORE INTO deliveries (event_id, room_id, submission_id) VALUES (?, ?, ?)")
			.run(delivery.eventId, delivery.roomId, delivery.submissionId);
	}

	markDelivered(eventId: string, replyEventId: string): void {
		this.#db.prepare("UPDATE deliveries SET delivered = 1, reply_event_id = ? WHERE event_id = ?").run(replyEventId, eventId);
	}

	isDelivered(eventId: string): boolean {
		const row = this.#db.prepare("SELECT delivered FROM deliveries WHERE event_id = ?").get(eventId);
		return row !== undefined && Number(row.delivered) === 1;
	}

	pendingDeliveries(): Delivery[] {
		const rows = this.#db.prepare("SELECT event_id, room_id, submission_id FROM deliveries WHERE delivered = 0 ORDER BY rowid").all();
		return rows.map((row) => ({
			eventId: String(row.event_id),
			roomId: String(row.room_id),
			submissionId: Number(row.submission_id),
		}));
	}

	/** The newest submission the ledger knows, user message or scheduled; 0 when there is none. */
	latestSubmission(): number {
		const row = this.#db.prepare("SELECT MAX(submission_id) AS latest FROM deliveries").get();
		return Number(row?.latest ?? 0);
	}

	/** Whether a submission is a message a person sent, as opposed to one the scheduler made. */
	isUserSubmission(submissionId: number): boolean {
		const row = this.#db.prepare("SELECT event_id FROM deliveries WHERE submission_id = ?").get(submissionId);
		return row !== undefined && !String(row.event_id).startsWith(SCHEDULED_PREFIX);
	}

	/** The ledger of notifications already made, so none is made twice. */
	wasNotified(key: string): boolean {
		return this.#db.prepare("SELECT 1 FROM notified WHERE key = ?").get(key) !== undefined;
	}

	markNotified(keys: readonly string[], at: number): void {
		const insert = this.#db.prepare("INSERT OR IGNORE INTO notified (key, at) VALUES (?, ?)");
		for (const key of keys) insert.run(key, at);
	}

	/** Calendar items as last seen, by ID with their ETag: what "added or changed" is measured against. */
	seenItems(): Map<string, string> {
		const rows = this.#db.prepare("SELECT id, etag FROM calendar_seen").all();
		return new Map(rows.map((row) => [String(row.id), String(row.etag)]));
	}

	replaceSeenItems(items: ReadonlyMap<string, string>): void {
		this.#db.exec("BEGIN");
		try {
			this.#db.exec("DELETE FROM calendar_seen");
			const insert = this.#db.prepare("INSERT INTO calendar_seen (id, etag) VALUES (?, ?)");
			for (const [id, etag] of items) insert.run(id, etag);
			this.#db.exec("COMMIT");
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	/** Records an item the agent itself wrote, so the watcher does not report the agent's own work back to the user. */
	setSeenItem(id: string, etag: string | undefined): void {
		if (etag === undefined) this.#db.prepare("DELETE FROM calendar_seen WHERE id = ?").run(id);
		else this.#db.prepare("INSERT INTO calendar_seen (id, etag) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET etag = excluded.etag").run(id, etag);
	}

	putPendingChange(change: PendingChange): void {
		this.#db
			.prepare("INSERT OR IGNORE INTO pending_changes (token, conversation_id, action, baseline, created_at) VALUES (?, ?, ?, ?, ?)")
			.run(change.token, change.conversationId, change.action, change.baseline, change.createdAt);
		// Proposals nobody answered are of no use after a week.
		this.#db.prepare("DELETE FROM pending_changes WHERE created_at < ?").run(change.createdAt - 7 * 86_400_000);
	}

	pendingChange(token: string): (PendingChange & { done: boolean }) | undefined {
		const row = this.#db.prepare("SELECT token, conversation_id, action, baseline, created_at, done FROM pending_changes WHERE token = ?").get(token);
		if (row === undefined) return undefined;
		return {
			token: String(row.token),
			conversationId: Number(row.conversation_id),
			action: String(row.action),
			baseline: Number(row.baseline),
			createdAt: Number(row.created_at),
			done: Number(row.done) === 1,
		};
	}

	finishPendingChange(token: string): void {
		this.#db.prepare("UPDATE pending_changes SET done = 1 WHERE token = ?").run(token);
	}

	value(key: string): string | undefined {
		const row = this.#db.prepare("SELECT value FROM kv WHERE key = ?").get(key);
		return row === undefined ? undefined : String(row.value);
	}

	setValue(key: string, value: string): void {
		this.#db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
	}

	close(): void {
		this.#db.close();
	}
}
