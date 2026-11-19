import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { CalDavBackend, RawObject } from "../src/calendar.ts";
import type { GatewayCommand, GatewayEvent, GatewayLink } from "../src/gateway.ts";

export class FakeLink implements GatewayLink {
	readonly commands: GatewayCommand[] = [];
	failSends = false;
	/** The gateway answers a `callSpeak` once it has played (or cut off) the speech. */
	speak: ((command: Extract<GatewayCommand, { type: "callSpeak" }>) => GatewayEvent | undefined) | undefined;
	readonly #listeners: ((event: GatewayEvent) => void)[] = [];
	#waiters: ((command: GatewayCommand) => boolean)[] = [];

	send(command: GatewayCommand): void {
		this.commands.push(command);
		this.#waiters = this.#waiters.filter((waiter) => !waiter(command));
		if (command.type === "send" || command.type === "sendVoice" || command.type === "sendImage" || command.type === "react") {
			const reply: GatewayEvent = this.failSends
				? { type: "error", requestId: command.requestId, message: "the homeserver cannot be reached" }
				: { type: "sent", requestId: command.requestId, eventId: `$sent-${command.txnId}` };
			queueMicrotask(() => this.emit(reply));
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
	waitFor<T extends GatewayCommand["type"]>(type: T, matches: (command: Extract<GatewayCommand, { type: T }>) => boolean = () => true): Promise<Extract<GatewayCommand, { type: T }>> {
		const fits = (command: GatewayCommand): command is Extract<GatewayCommand, { type: T }> => command.type === type && matches(command as Extract<GatewayCommand, { type: T }>);
		const sent = this.commands.find(fits);
		if (sent !== undefined) return Promise.resolve(sent);
		return new Promise((resolve) => {
			this.#waiters.push((command) => {
				if (!fits(command)) return false;
				resolve(command);
				return true;
			});
		});
	}
	bodyIn(roomId: string): string {
		return this.of("send")
			.flatMap((command) => (command.roomId === roomId ? [command.body] : []))
			.join("\n");
	}
}

export function message(roomId: string, eventId: string, body: string, ts = 0, replyTo?: string): GatewayEvent {
	return { type: "message", roomId, eventId, sender: "@me:example.org", body, ts, ...(replyTo === undefined ? {} : { replyTo }) };
}

/**
 * CalDAV in memory, with the conditional writes of a real server: an update or delete only applies to the ETag it was
 * read with. It returns every object of a calendar regardless of the time range, as a server may return more than
 * asked; narrowing to the range is the caller's job.
 */
export class MemoryCalDav implements CalDavBackend {
	readonly #calendars = new Map<string, Map<string, { data: string; etag: string }>>();
	#revision = 0;
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

/** The line endings are the ones the format requires. */
export function ics(...lines: string[]): string {
	return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", ...lines, "END:VCALENDAR", ""].join("\r\n");
}

export type Request = {
	readonly systemPrompt?: string;
	readonly messages: readonly {
		readonly role: string;
		readonly content: unknown;
		readonly sections?: Readonly<Record<string, string | null>>;
		readonly isError?: boolean;
	}[];
};

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block: { text?: string }) => block.text ?? "").join("");
}

export function instructionsOf(request: Request): string {
	const system = request.messages.filter((item) => item.role === "system");
	return [request.systemPrompt ?? "", ...system.flatMap((item) => [textOf(item.content), ...Object.values(item.sections ?? {}).map((section) => section ?? "")])].join("\n");
}

export function lastInput(request: Request): string {
	return textOf(request.messages.findLast((item) => item.role === "user")?.content);
}

export function everything(request: Request): string {
	return [instructionsOf(request), ...request.messages.filter((item) => item.role !== "system").map((item) => textOf(item.content))].join("\n");
}

export function lastToolResult(request: Request): { readonly text: string; readonly isError: boolean } {
	const result = request.messages.findLast((item) => item.role === "toolResult");
	return { text: textOf(result?.content), isError: result?.isError === true };
}

export const call = (name: string, args: Record<string, string | boolean | number>) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
export type ToolResult = ReturnType<typeof lastToolResult>;
export const noting =
	(results: ToolResult[], requests: Request[] = []) =>
	(request: Request) => {
		requests.push(request);
		results.push(lastToolResult(request));
		return fauxAssistantMessage("ok");
	};
export const answer =
	(text: string, requests: Request[] = []) =>
	(request: Request) => {
		requests.push(request);
		return fauxAssistantMessage(text);
	};

/** A 16-bit mono WAV file of `samples` between -1 and 1. */
export function wav(samples: ArrayLike<number>, rate: number): Buffer {
	const data = Buffer.alloc(samples.length * 2);
	for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round((samples[i] ?? 0) * 32767), i * 2);
	const header = Buffer.alloc(44);
	header.write("RIFFxxxxWAVEfmt ", 0, "latin1");
	header.writeUInt32LE(36 + data.length, 4);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(rate, 24);
	header.writeUInt32LE(rate * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36, "latin1");
	header.writeUInt32LE(data.length, 40);
	return Buffer.concat([header, data]);
}
