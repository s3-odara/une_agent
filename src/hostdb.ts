import { DatabaseSync } from "node:sqlite";

export type Delivery = {
	/** The Matrix event being answered; also the submission's `requestId`. */
	readonly eventId: string;
	readonly roomId: string;
	readonly submissionId: number;
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

	close(): void {
		this.#db.close();
	}
}
