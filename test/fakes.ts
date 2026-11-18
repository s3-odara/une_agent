import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { CalDavBackend, RawObject } from "../src/calendar.ts";
import type { GatewayCommand, GatewayEvent, GatewayLink } from "../src/gateway.ts";

/** A gateway stand-in that records commands and, unless told not to, confirms every send. */
export class FakeLink implements GatewayLink {
	readonly commands: GatewayCommand[] = [];
	confirmSends = true;
	/** Answers a `callSpeak` as the gateway would once it has played (or cut off) the speech; unset, it never does. */
	speak: ((command: Extract<GatewayCommand, { type: "callSpeak" }>) => GatewayEvent | undefined) | undefined;
	readonly #listeners: ((event: GatewayEvent) => void)[] = [];

	send(command: GatewayCommand): void {
		this.commands.push(command);
		if ((command.type === "send" || command.type === "sendVoice" || command.type === "react") && this.confirmSends) {
			queueMicrotask(() => this.emit({ type: "sent", requestId: command.requestId, eventId: `$sent-${command.txnId}` }));
		}
		if (command.type === "callSpeak" && this.speak !== undefined) {
			const reply = this.speak(command);
			if (reply !== undefined) queueMicrotask(() => this.emit(reply));
		}
	}
	onEvent(listener: (event: GatewayEvent) => void): void {
		this.#listeners.push(listener);
	}
	emit(event: GatewayEvent): void {
		for (const listener of this.#listeners) listener(event);
	}
	of<T extends GatewayCommand["type"]>(type: T): Extract<GatewayCommand, { type: T }>[] {
		return this.commands.filter((command): command is Extract<GatewayCommand, { type: T }> => command.type === type);
	}
	/** Everything sent to a room so far, joined. */
	bodyIn(roomId: string): string {
		return this.of("send")
			.flatMap((command) => (command.roomId === roomId ? [command.body] : []))
			.join("\n");
	}
}

export function message(roomId: string, eventId: string, body: string, ts = 0): GatewayEvent {
	return { type: "message", roomId, eventId, sender: "@me:example.org", body, ts };
}

/**
 * CalDAV in memory, with the conditional writes of a real server: an update or delete only applies to the ETag it was
 * read with. It returns every object of a calendar regardless of the time range, as a server may return more than
 * asked; narrowing to the range is the caller's job.
 */
export class MemoryCalDav implements CalDavBackend {
	readonly #calendars = new Map<string, Map<string, { data: string; etag: string }>>();
	#revision = 0;
	/** Set to make every call fail, as an unreachable server does. */
	down = false;

	#calendar(name: string): Map<string, { data: string; etag: string }> {
		if (this.down) throw new Error("connect ECONNREFUSED");
		let calendar = this.#calendars.get(name);
		if (calendar === undefined) this.#calendars.set(name, (calendar = new Map()));
		return calendar;
	}

	#raw(calendar: string, file: string, object: { data: string; etag: string }): RawObject {
		return { url: `https://dav.example.org/cal/${calendar}/${encodeURIComponent(file)}`, etag: object.etag, data: object.data };
	}

	/** Stores an object as another client would, bypassing the agent. */
	put(calendar: string, file: string, data: string): void {
		this.#calendar(calendar).set(file, { data, etag: `"${++this.#revision}"` });
	}

	data(calendar: string, file: string): string | undefined {
		return this.#calendar(calendar).get(file)?.data;
	}

	files(calendar: string): string[] {
		return [...this.#calendar(calendar).keys()];
	}

	async #holding(calendar: string, component: string): Promise<RawObject[]> {
		return [...this.#calendar(calendar)].flatMap(([file, object]) =>
			object.data.includes(`BEGIN:${component}`) ? [this.#raw(calendar, file, object)] : [],
		);
	}
	events(calendar: string): Promise<RawObject[]> {
		return this.#holding(calendar, "VEVENT");
	}
	todos(calendar: string): Promise<RawObject[]> {
		return this.#holding(calendar, "VTODO");
	}
	async get(calendar: string, file: string): Promise<RawObject | undefined> {
		const object = this.#calendar(calendar).get(file);
		return object === undefined ? undefined : this.#raw(calendar, file, object);
	}
	async create(calendar: string, file: string, data: string): Promise<"created" | "exists"> {
		if (this.#calendar(calendar).has(file)) return "exists";
		this.put(calendar, file, data);
		return "created";
	}
	async update(object: RawObject): Promise<"updated" | "conflict"> {
		const [calendar, file] = object.url.split("/").slice(-2).map(decodeURIComponent) as [string, string];
		if (this.#calendar(calendar).get(file)?.etag !== object.etag) return "conflict";
		this.put(calendar, file, object.data);
		return "updated";
	}
	async remove(object: RawObject): Promise<"deleted" | "gone" | "conflict"> {
		const [calendar, file] = object.url.split("/").slice(-2).map(decodeURIComponent) as [string, string];
		const current = this.#calendar(calendar).get(file);
		if (current === undefined) return "gone";
		if (current.etag !== object.etag) return "conflict";
		this.#calendar(calendar).delete(file);
		return "deleted";
	}
}

/** An iCalendar object from its component lines, with the line endings the format requires. */
export function ics(...lines: string[]): string {
	return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", ...lines, "END:VCALENDAR", ""].join("\r\n");
}

export type Request = { messages: { role: string; content: unknown }[] };

/** The text of the newest tool result the model was given. */
export function lastToolResult(request: Request): string {
	const result = request.messages.findLast((item) => item.role === "toolResult");
	return (result?.content as { text?: string }[] | undefined)?.map((block) => block.text ?? "").join("") ?? "";
}

/** A model turn that calls one tool. */
export const call = (name: string, args: Record<string, string | boolean>) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
/** A model turn that answers with what the last tool said, so a test can read it in the room. */
export const report = (request: Request) => fauxAssistantMessage(lastToolResult(request));
