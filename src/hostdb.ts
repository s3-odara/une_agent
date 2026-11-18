import { DatabaseSync } from "node:sqlite";

export type Delivery = {
	/** Also the submission's `requestId`. */
	readonly eventId: string;
	readonly roomId: string;
	readonly submissionId: number;
	readonly voice?: boolean;
};

/** Event IDs of deliveries the scheduler asked for start with this; Matrix event IDs start with `$`. */
export const SCHEDULED_PREFIX = "sched:";

export type Decision = "approve" | "approve_session" | "approve_always" | "reject";

export type ApprovalRow = {
	readonly id: string;
	readonly roomId: string;
	/** The run the call belongs to: `approve_session` covers the same tool in the rest of it. */
	readonly runKey: string;
	readonly tool: string;
	readonly summary: string;
	readonly createdAt: number;
	readonly promptEventId?: string;
	readonly decision?: Decision;
	/** Why it was rejected without a reject: `message` (the user wrote something else instead) or `timeout`. */
	readonly reason?: string;
};

/**
 * It is a separate file from the pi-durable session, so nothing here is atomic with a session commit; every step that
 * uses it is safe to repeat instead (see `Bridge`).
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
				reply_event_id TEXT,
				voice INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE IF NOT EXISTS notified (
				key TEXT PRIMARY KEY,
				at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS calendar_seen (
				id TEXT PRIMARY KEY,
				etag TEXT NOT NULL
			);
			DROP TABLE IF EXISTS pending_changes;
			CREATE TABLE IF NOT EXISTS approvals (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL,
				run_key TEXT NOT NULL,
				tool TEXT NOT NULL,
				summary TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				prompt_event_id TEXT,
				decision TEXT,
				reason TEXT
			);
			CREATE TABLE IF NOT EXISTS approval_rules (
				tool TEXT PRIMARY KEY,
				created_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS kv (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
		`);
		// Ledgers made before voice messages lack the column.
		const columns = this.#db.prepare("PRAGMA table_info(deliveries)").all().map((row) => String(row.name));
		if (!columns.includes("voice")) this.#db.exec("ALTER TABLE deliveries ADD COLUMN voice INTEGER NOT NULL DEFAULT 0");
		// Every browser tool call asks whether its run was started by the user.
		this.#db.exec("CREATE INDEX IF NOT EXISTS deliveries_submission ON deliveries(submission_id)");
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

	addDelivery(delivery: Delivery): void {
		this.#db
			.prepare("INSERT OR IGNORE INTO deliveries (event_id, room_id, submission_id, voice) VALUES (?, ?, ?, ?)")
			.run(delivery.eventId, delivery.roomId, delivery.submissionId, delivery.voice === true ? 1 : 0);
	}

	markDelivered(eventId: string, replyEventId: string): void {
		this.#db.prepare("UPDATE deliveries SET delivered = 1, reply_event_id = ? WHERE event_id = ?").run(replyEventId, eventId);
	}

	hasDelivery(eventId: string): boolean {
		return this.#db.prepare("SELECT 1 FROM deliveries WHERE event_id = ?").get(eventId) !== undefined;
	}

	isDelivered(eventId: string): boolean {
		const row = this.#db.prepare("SELECT delivered FROM deliveries WHERE event_id = ?").get(eventId);
		return row !== undefined && Number(row.delivered) === 1;
	}

	pendingDeliveries(): Delivery[] {
		const rows = this.#db.prepare("SELECT event_id, room_id, submission_id, voice FROM deliveries WHERE delivered = 0 ORDER BY rowid").all();
		return rows.map((row) => ({
			eventId: String(row.event_id),
			roomId: String(row.room_id),
			submissionId: Number(row.submission_id),
			voice: Number(row.voice) === 1,
		}));
	}

	isUserSubmission(submissionId: number): boolean {
		const row = this.#db.prepare("SELECT event_id FROM deliveries WHERE submission_id = ?").get(submissionId);
		return row !== undefined && !String(row.event_id).startsWith(SCHEDULED_PREFIX);
	}

	wasNotified(key: string): boolean {
		return this.#db.prepare("SELECT 1 FROM notified WHERE key = ?").get(key) !== undefined;
	}

	markNotified(keys: readonly string[], at: number): void {
		const insert = this.#db.prepare("INSERT OR IGNORE INTO notified (key, at) VALUES (?, ?)");
		for (const key of keys) insert.run(key, at);
	}

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

	/** So the watcher does not report the agent's own work back to the user. */
	setSeenItem(id: string, etag: string | undefined): void {
		if (etag === undefined) this.#db.prepare("DELETE FROM calendar_seen WHERE id = ?").run(id);
		else this.#db.prepare("INSERT INTO calendar_seen (id, etag) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET etag = excluded.etag").run(id, etag);
	}

	addApproval(row: Omit<ApprovalRow, "promptEventId" | "decision" | "reason">): void {
		this.#db
			.prepare("INSERT OR IGNORE INTO approvals (id, room_id, run_key, tool, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)")
			.run(row.id, row.roomId, row.runKey, row.tool, row.summary, row.createdAt);
		this.#db.prepare("DELETE FROM approvals WHERE decision IS NOT NULL AND created_at < ?").run(row.createdAt - 7 * 86_400_000);
	}

	approval(id: string): ApprovalRow | undefined {
		const row = this.#db.prepare("SELECT * FROM approvals WHERE id = ?").get(id);
		return row === undefined ? undefined : approvalRow(row);
	}

	approvalByPrompt(roomId: string, promptEventId: string): ApprovalRow | undefined {
		const row = this.#db.prepare("SELECT * FROM approvals WHERE room_id = ? AND prompt_event_id = ?").get(roomId, promptEventId);
		return row === undefined ? undefined : approvalRow(row);
	}

	undecidedApprovals(roomId: string): ApprovalRow[] {
		return this.#db.prepare("SELECT * FROM approvals WHERE room_id = ? AND decision IS NULL ORDER BY created_at, rowid").all(roomId).map(approvalRow);
	}

	setApprovalPrompt(id: string, promptEventId: string): void {
		this.#db.prepare("UPDATE approvals SET prompt_event_id = ? WHERE id = ?").run(promptEventId, id);
	}

	decideApproval(id: string, decision: Decision, reason?: string): boolean {
		return this.#db.prepare("UPDATE approvals SET decision = ?, reason = ? WHERE id = ? AND decision IS NULL").run(decision, reason ?? null, id).changes > 0;
	}

	approvedForRun(runKey: string, tool: string): boolean {
		return this.#db.prepare("SELECT 1 FROM approvals WHERE run_key = ? AND tool = ? AND decision = 'approve_session'").get(runKey, tool) !== undefined;
	}

	alwaysApproved(): string[] {
		return this.#db.prepare("SELECT tool FROM approval_rules ORDER BY tool").all().map((row) => String(row.tool));
	}

	setAlwaysApproved(tool: string, on: boolean, at: number): boolean {
		if (on) return this.#db.prepare("INSERT OR IGNORE INTO approval_rules (tool, created_at) VALUES (?, ?)").run(tool, at).changes > 0;
		return this.#db.prepare("DELETE FROM approval_rules WHERE tool = ?").run(tool).changes > 0;
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

function approvalRow(row: Record<string, unknown>): ApprovalRow {
	return {
		id: String(row.id),
		roomId: String(row.room_id),
		runKey: String(row.run_key),
		tool: String(row.tool),
		summary: String(row.summary),
		createdAt: Number(row.created_at),
		...(row.prompt_event_id === null ? {} : { promptEventId: String(row.prompt_event_id) }),
		...(row.decision === null ? {} : { decision: String(row.decision) as Decision }),
		...(row.reason === null ? {} : { reason: String(row.reason) }),
	};
}
