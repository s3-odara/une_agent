import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request, type Server } from "node:http";
import { connect } from "node:net";
import { test } from "node:test";
import { EgressProxy, isPublicAddress } from "../src/egress.ts";
import { listen } from "./env.ts";

for (const address of ["8.8.8.8", "1.1.1.1", "133.242.0.1", "2001:4860:4860::8888", "2400:cb00::1"]) {
	test(`${address} is public`, () => assert.equal(isPublicAddress(address), true));
}

for (const address of [
	"127.0.0.1",
	"10.1.2.3",
	"172.16.0.1",
	"192.168.1.1",
	"169.254.169.254",
	"100.64.0.1",
	"0.0.0.0",
	"224.0.0.1",
	"255.255.255.255",
	"::1",
	"::",
	"fe80::1",
	"fc00::1",
	"::ffff:127.0.0.1",
	"64:ff9b::7f00:1",
	"2002:7f00:1::1",
	"2001::1",
	"2001:db8::1",
	"localhost",
]) {
	test(`${address} is not public`, () => assert.equal(isPublicAddress(address), false));
}

async function local(): Promise<{ server: Server; port: number; hits: string[] }> {
	const hits: string[] = [];
	const server = createServer((req, res) => {
		hits.push(req.url ?? "");
		res.writeHead(200, { "content-type": "text/plain" }).end("hello");
	});
	return { server, port: await listen(server), hits };
}

/** As a browser makes it through a proxy: the whole URL on the request line. */
function viaProxy(proxy: EgressProxy, url: string): Promise<{ status: number; body: string }> {
	const { port } = new URL(proxy.url);
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port: Number(port), path: url, headers: { host: new URL(url).host } }, (res) => {
			let body = "";
			res.on("data", (chunk) => (body += chunk));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
		});
		req.on("error", reject);
		req.end();
	});
}

function tunnel(proxy: EgressProxy, target: string): Promise<string> {
	const { port } = new URL(proxy.url);
	return new Promise((resolve, reject) => {
		const socket = connect(Number(port), "127.0.0.1", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
		socket.once("data", (data) => {
			resolve(data.toString().split("\r\n")[0] ?? "");
			socket.destroy();
		});
		socket.on("error", reject);
	});
}

test("a request to an allowed address goes through", async () => {
	const site = await local();
	const proxy = await EgressProxy.start({ allow: (_address, port) => port === site.port });
	try {
		const reply = await viaProxy(proxy, `http://127.0.0.1:${site.port}/page`);
		assert.deepEqual(reply, { status: 200, body: "hello" });
		assert.deepEqual(site.hits, ["/page"]);
	} finally {
		await proxy.close();
		site.server.close();
	}
});

test("with the default policy, this host is not reached by address or by name", async () => {
	const site = await local();
	const proxy = await EgressProxy.start();
	try {
		for (const host of ["127.0.0.1", "localhost", "[::ffff:127.0.0.1]"]) {
			const reply = await viaProxy(proxy, `http://${host}:${site.port}/`);
			assert.equal(reply.status, 403, host);
			assert.match(await tunnel(proxy, `${host}:${site.port}`), /^HTTP\/1\.1 403/, host);
		}
		assert.deepEqual(site.hits, []);
	} finally {
		await proxy.close();
		site.server.close();
	}
});

test("a tunnel to an allowed address is opened, and one to another port of the same host is not", async () => {
	const site = await local();
	const other = await local();
	const proxy = await EgressProxy.start({ allow: (_address, port) => port === site.port });
	try {
		assert.match(await tunnel(proxy, `127.0.0.1:${site.port}`), /^HTTP\/1\.1 200/);
		assert.match(await tunnel(proxy, `127.0.0.1:${other.port}`), /^HTTP\/1\.1 403/);
		assert.deepEqual(other.hits, []);
	} finally {
		await proxy.close();
		site.server.close();
		other.server.close();
	}
});

test("closing a streamed response also disconnects the upstream HTTP server", async () => {
	const closed = Promise.withResolvers<void>();
	const server = createServer((_req, res) => {
		res.once("close", closed.resolve);
		res.write("first chunk");
	});
	const port = await listen(server);
	const proxy = await EgressProxy.start({ allow: (_address, to) => to === port });
	const client = request(proxy.url, { path: `http://127.0.0.1:${port}/` });
	const signal = AbortSignal.timeout(5000);
	try {
		client.end();
		await once(client, "response", { signal });
		client.destroy();
		await Promise.race([closed.promise, once(signal, "abort").then(() => { throw new Error("upstream was not closed"); })]);
	} finally {
		client.destroy();
		await proxy.close();
		server.closeAllConnections();
		server.close();
	}
});

test("asking about a refused host gives a reason", async () => {
	const proxy = await EgressProxy.start();
	try {
		await assert.rejects(proxy.resolve("localhost", 80), (error: Error) => error.message.includes("localhost"));
	} finally {
		await proxy.close();
	}
});
