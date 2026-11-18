import { lookup } from "node:dns/promises";
import { createServer, type IncomingMessage, request as httpRequest, type Server, type ServerResponse } from "node:http";
import { BlockList, connect, isIP, type Socket } from "node:net";
import type { Duplex } from "node:stream";

/** IPv4 ranges that are not the public internet: this host, private networks, shared, link-local, reserved, multicast. */
const NOT_PUBLIC_V4: readonly [string, number][] = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.88.99.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
];

/**
 * IPv6 inside global unicast (2000::/3) that is still not a plain public host: protocol assignments including Teredo,
 * documentation, and 6to4, the last two of which can lead to an IPv4 address of their choosing.
 */
const NOT_PUBLIC_V6: readonly [string, number][] = [
	["2001::", 23],
	["2001:db8::", 32],
	["2002::", 16],
	["3fff::", 20],
];

const notPublic = new BlockList();
for (const [network, prefix] of NOT_PUBLIC_V4) notPublic.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of NOT_PUBLIC_V6) notPublic.addSubnet(network, prefix, "ipv6");
const globalUnicast = new BlockList();
globalUnicast.addSubnet("2000::", 3, "ipv6");

/**
 * Whether an address is a host on the public internet. IPv6 counts only inside global unicast, which also rules out
 * IPv4-mapped and NAT64 addresses: an IPv4 address written as IPv6 is never treated as public.
 */
export function isPublicAddress(address: string): boolean {
	switch (isIP(address)) {
		case 4:
			return !notPublic.check(address, "ipv4");
		case 6:
			return globalUnicast.check(address, "ipv6") && !notPublic.check(address, "ipv6");
		default:
			return false;
	}
}

const LOOKUP_TIMEOUT_MS = 10_000;

/** A connection the proxy refused; its message is written for the model. */
export class EgressError extends Error {}

export type EgressOptions = {
	/**
	 * Whether a connection to `address:port` is allowed. Default: public addresses only. Tests widen it to a server of
	 * their own on this host.
	 */
	readonly allow?: (address: string, port: number) => boolean;
};

/**
 * An HTTP proxy on this host that connects only to public addresses, for a browser that opens pages nobody vetted.
 *
 * The browser sends every connection through it, also those that redirects and a page's scripts start. The proxy looks
 * up each name itself, refuses it if any of its addresses is not allowed, and connects to the address it checked, so a
 * name that changes its answer between the check and the connection (DNS rebinding) cannot reach this host or the
 * local network. It is what keeps a page away from the services on this host, such as VOICEVOX.
 */
export class EgressProxy {
	readonly #server: Server;
	readonly #allow: (address: string, port: number) => boolean;
	readonly #sockets = new Set<Duplex>();

	private constructor(options: EgressOptions) {
		this.#allow = options.allow ?? ((address) => isPublicAddress(address));
		this.#server = createServer((request, response) => void this.#forward(request, response));
		this.#server.on("connect", (request: IncomingMessage, socket: Duplex, head: Buffer) => void this.#tunnel(request, socket, head));
		this.#server.on("connection", (socket) => this.#keep(socket));
	}

	/** A proxy listening on a free port of 127.0.0.1. */
	static async start(options: EgressOptions = {}): Promise<EgressProxy> {
		const proxy = new EgressProxy(options);
		await new Promise<void>((resolve, reject) => {
			proxy.#server.once("error", reject);
			proxy.#server.listen(0, "127.0.0.1", () => resolve());
		});
		return proxy;
	}

	/** The proxy's address, for the browser's `proxy.server`. */
	get url(): string {
		const address = this.#server.address();
		if (address === null || typeof address === "string") throw new Error("the egress proxy is not listening");
		return `http://127.0.0.1:${address.port}`;
	}

	/**
	 * The address a connection to `host:port` would go to, or an `EgressError` saying why there is none. The browser
	 * tools ask this before opening a page, so that a refused page gets a reason instead of a browser error.
	 */
	async resolve(host: string, port: number): Promise<string> {
		const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
		let addresses: string[];
		if (isIP(bare) !== 0) {
			addresses = [bare];
		} else {
			let timer: NodeJS.Timeout | undefined;
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new EgressError(`${bare} の名前解決が時間内に終わりませんでした。`)), LOOKUP_TIMEOUT_MS);
			});
			try {
				const found = await Promise.race([lookup(bare, { all: true, verbatim: true }), timeout]);
				addresses = found.map((item) => item.address);
			} catch (error) {
				if (error instanceof EgressError) throw error;
				throw new EgressError(`${bare} の名前解決に失敗しました。`);
			} finally {
				clearTimeout(timer);
			}
		}
		// One address that is not allowed refuses the whole name: a name that also points inside is not trusted to pick.
		if (addresses.length === 0 || addresses.some((address) => !this.#allow(address, port))) {
			throw new EgressError(`${bare} はこのホストか内部のネットワークを指しているので開けません。開けるのはインターネット上の公開されたアドレスだけです。`);
		}
		return addresses[0] as string;
	}

	/** `CONNECT host:port`: https, and WebSockets over it. */
	async #tunnel(request: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
		this.#keep(client);
		client.on("error", () => client.destroy());
		const target = authority(request.url ?? "");
		if (target === undefined) return void client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
		let address: string;
		try {
			address = await this.resolve(target.host, target.port);
		} catch {
			return void client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
		}
		const upstream: Socket = connect({ host: address, port: target.port });
		this.#keep(upstream);
		upstream.once("connect", () => {
			client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length > 0) upstream.write(head);
			upstream.pipe(client);
			client.pipe(upstream);
		});
		upstream.on("error", () => {
			if (upstream.connecting) client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
			else client.destroy();
		});
		client.on("close", () => upstream.destroy());
		upstream.on("close", () => client.destroy());
	}

	/** A plain `http://` request, which a proxy gets with the whole URL. */
	async #forward(request: IncomingMessage, response: ServerResponse): Promise<void> {
		let url: URL;
		try {
			url = new URL(request.url ?? "");
		} catch {
			return void response.writeHead(400).end();
		}
		if (url.protocol !== "http:") return void response.writeHead(400).end();
		const port = Number(url.port || 80);
		let address: string;
		try {
			address = await this.resolve(url.hostname, port);
		} catch (error) {
			const text = error instanceof EgressError ? error.message : "接続が拒否されました。";
			return void response.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end(text);
		}
		const headers = { ...request.headers };
		delete headers["proxy-connection"];
		delete headers["proxy-authorization"];
		const upstream = httpRequest({ host: address, port, method: request.method, path: `${url.pathname}${url.search}`, headers, setHost: false }, (reply) => {
			response.writeHead(reply.statusCode ?? 502, reply.statusMessage, reply.headers);
			reply.pipe(response);
		});
		upstream.on("error", () => {
			if (!response.headersSent) response.writeHead(502).end();
			else response.destroy();
		});
		request.pipe(upstream);
	}

	#keep(socket: Duplex): void {
		this.#sockets.add(socket);
		socket.once("close", () => this.#sockets.delete(socket));
	}

	async close(): Promise<void> {
		for (const socket of this.#sockets) socket.destroy();
		await new Promise<void>((resolve) => this.#server.close(() => resolve()));
	}
}

/** `host:port` of a CONNECT request, with an IPv6 host in brackets. */
function authority(value: string): { host: string; port: number } | undefined {
	const match = /^(\[[0-9A-Fa-f:.]+\]|[^\s:/[\]]+):(\d{1,5})$/.exec(value);
	if (match === null) return undefined;
	const port = Number(match[2]);
	return port >= 1 && port <= 65_535 ? { host: match[1] as string, port } : undefined;
}
