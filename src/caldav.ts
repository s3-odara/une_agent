import { createDAVClient, type DAVCalendar } from "tsdav";
import type { CalDavBackend, RawObject } from "./calendar.ts";

export type CalDavOptions = {
	readonly url: string;
	readonly username: string;
	readonly password: string;
	/** Display names of the calendars to use. */
	readonly calendars: readonly string[];
};

type Session = {
	readonly client: Awaited<ReturnType<typeof createDAVClient>>;
	readonly calendars: ReadonlyMap<string, DAVCalendar>;
};

const TODO_FILTER = [{ "comp-filter": { _attributes: { name: "VCALENDAR" }, "comp-filter": { _attributes: { name: "VTODO" } } } }];

function displayName(calendar: DAVCalendar): string {
	return typeof calendar.displayName === "string" ? calendar.displayName : "";
}

/**
 * CalDAV over tsdav for discovery and queries, and plain conditional HTTP requests for single objects.
 *
 * The connection is made at first use and again after any failure, so a server that is down when the agent starts, or
 * goes away later, only fails the calls made while it is down.
 */
export function connectCalDav(options: CalDavOptions): CalDavBackend {
	const authorization = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`;
	let session: Promise<Session> | undefined;

	const open = async (): Promise<Session> => {
		const client = await createDAVClient({
			serverUrl: options.url,
			credentials: { username: options.username, password: options.password },
			authMethod: "Basic",
			defaultAccountType: "caldav",
		});
		const found = await client.fetchCalendars();
		const calendars = new Map<string, DAVCalendar>();
		for (const name of options.calendars) {
			const calendar = found.find((candidate) => displayName(candidate) === name);
			if (calendar === undefined) {
				const names = found.map(displayName).filter((candidate) => candidate !== "");
				throw new Error(`CalDAV calendar "${name}" not found; the account has: ${names.join(", ") || "(none)"}`);
			}
			calendars.set(name, calendar);
		}
		return { client, calendars };
	};

	const use = async <T>(run: (session: Session) => Promise<T>): Promise<T> => {
		session ??= open();
		try {
			return await run(await session);
		} catch (error) {
			session = undefined;
			throw error;
		}
	};

	const calendarOf = (current: Session, name: string): DAVCalendar => {
		const calendar = current.calendars.get(name);
		if (calendar === undefined) throw new Error(`calendar "${name}" is not configured`);
		return calendar;
	};

	const objectUrl = (calendar: DAVCalendar, file: string): string => new URL(encodeURIComponent(file), calendar.url.endsWith("/") ? calendar.url : `${calendar.url}/`).href;

	const raws = (objects: { url: string; etag?: string; data?: unknown }[]): RawObject[] =>
		objects.flatMap((object) => (typeof object.data === "string" && object.data !== "" ? [{ url: object.url, etag: object.etag, data: object.data }] : []));

	const request = async (url: string, method: string, headers: Record<string, string>, body?: string): Promise<Response> => {
		const response = await fetch(url, { method, headers: { authorization, ...headers }, body });
		// The body is not needed, and an unread one keeps the connection busy.
		if (method !== "GET") await response.body?.cancel();
		return response;
	};

	const failed = (action: string, response: Response) => new Error(`CalDAV ${action} failed: HTTP ${response.status}`);

	return {
		events: (name, from, to) =>
			use(async (current) =>
				raws(
					await current.client.fetchCalendarObjects({
						calendar: calendarOf(current, name),
						timeRange: { start: new Date(from).toISOString(), end: new Date(to).toISOString() },
					}),
				),
			),
		todos: (name) => use(async (current) => raws(await current.client.fetchCalendarObjects({ calendar: calendarOf(current, name), filters: TODO_FILTER }))),
		get: (name, file) =>
			use(async (current) => {
				const url = objectUrl(calendarOf(current, name), file);
				const response = await request(url, "GET", { accept: "text/calendar" });
				if (response.status === 404) {
					await response.body?.cancel();
					return undefined;
				}
				if (!response.ok) throw failed("GET", response);
				return { url, etag: response.headers.get("etag") ?? undefined, data: await response.text() };
			}),
		create: (name, file, data) =>
			use(async (current) => {
				const response = await request(objectUrl(calendarOf(current, name), file), "PUT", { "content-type": "text/calendar; charset=utf-8", "if-none-match": "*" }, data);
				if (response.status === 412) return "exists";
				if (!response.ok) throw failed("PUT", response);
				return "created";
			}),
		update: (object) =>
			use(async () => {
				const condition: Record<string, string> = object.etag === undefined ? {} : { "if-match": object.etag };
				const response = await request(object.url, "PUT", { "content-type": "text/calendar; charset=utf-8", ...condition }, object.data);
				if (response.status === 412) return "conflict";
				if (!response.ok) throw failed("PUT", response);
				return "updated";
			}),
		remove: (object) =>
			use(async () => {
				const condition: Record<string, string> = object.etag === undefined ? {} : { "if-match": object.etag };
				const response = await request(object.url, "DELETE", condition);
				if (response.status === 404) return "gone";
				if (response.status === 412) return "conflict";
				if (!response.ok) throw failed("DELETE", response);
				return "deleted";
			}),
	};
}
