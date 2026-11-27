import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { jmaSnow, jmaSnowGrid } from "../src/weather-snow.ts";
import { createSnowExtension } from "../src/weather-tools.ts";
import { agentEnv } from "./env.ts";
import { call, everything, message, noting, offered, type ToolResult } from "./fakes.ts";

const point = { lat: 43.025, lon: 141.03125 };
const neighbor = { lat: 43.025, lon: 141.09375 };
const ALL_ELEMENTS = [
	"snowd",
	"snowf03h",
	"snowf03h_nd",
	"snowf06h",
	"snowf06h_nd",
	"snowf12h",
	"snowf12h_nd",
	"snowf24h",
	"snowf24h_nd",
	"snowf48h",
	"snowf48h_nd",
	"snowf72h",
	"snowf72h_nd",
];

function pixelOf(lat: number, lon: number) {
	const world = 256 * 2 ** 10;
	const col = Math.floor(((lon + 180) / 360) * world);
	const row = Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * world);
	return { path: `10/${Math.floor(col / 256)}/${Math.floor(row / 256)}.png`, x: col % 256, y: row % 256 };
}

function png(pixels: readonly [x: number, y: number, rgba: readonly number[]][] = []): Response {
	const chunk = (type: string, bytes: Buffer) => {
		const data = Buffer.concat([Buffer.from(type), bytes]);
		const length = Buffer.alloc(4);
		const checksum = Buffer.alloc(4);
		length.writeUInt32BE(bytes.length);
		checksum.writeUInt32BE(crc32(data));
		return Buffer.concat([length, data, checksum]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(256);
	header.writeUInt32BE(256, 4);
	header.set([8, 6], 8);
	const scanlines = Buffer.alloc(256 * 1025);
	for (const [x, y, color] of pixels) scanlines.set(color, y * 1025 + 1 + x * 4);
	return new Response(
		new Uint8Array(
			Buffer.concat([
				Buffer.from("89504e470d0a1a0a", "hex"),
				chunk("IHDR", header),
				chunk("IDAT", deflateSync(scanlines)),
				chunk("IEND", Buffer.alloc(0)),
			]),
		),
	);
}

const ring = (west: number, east: number, south = 43, north = 43.05) => [
	[west, south],
	[east, south],
	[east, north],
	[west, north],
	[west, south],
];
const noDataMask = (...validHoles: number[][][]) =>
	Response.json({
		type: "FeatureCollection",
		features: [
			{
				type: "Feature",
				properties: { level: "NoData" },
				geometry: {
					type: "Polygon",
					coordinates: [
						[
							[-45, 85],
							[315, 85],
							[315, -85],
							[-45, -85],
						],
						...validHoles,
					],
				},
			},
		],
	});

const frame = (basetime: string, validtime: string, elements = ALL_ELEMENTS) => ({ basetime, validtime, elements });

function snowFixture(): typeof fetch {
	const p = pixelOf(point.lat, point.lon);
	const n = pixelOf(neighbor.lat, neighbor.lon);
	assert.equal(p.path, n.path);
	const tilePath = `/${p.path}`;

	return async (input) => {
		const url = new URL(String(input));
		const path = url.pathname;
		if (path.endsWith("/targetTimes.json")) {
			return Response.json([
				frame("20261126110000", "20261126130000"),
				frame("20261126110000", "20261126120000"),
				frame("20261126110000", "20261126110000"),
				frame("20261126100000", "20261126100000"),
				frame("20261126090000", "20261126090000"),
				frame("20261126060000", "20261126060000"),
			]);
		}
		const valid = path.split("/")[7];
		const element = path.split("/")[9];

		if (element?.endsWith("_nd")) {
			if (element === "snowf03h_nd" && valid === "20261126120000") return noDataMask(ring(141.0625, 141.125));
			return noDataMask(ring(141, 141.125));
		}
		if (!path.endsWith(tilePath)) return new Response(null, { status: 404 });

		if (element === "snowd") {
			if (valid === "20261126090000") return png([[p.x, p.y, [160, 210, 255, 255]]]);
			if (valid === "20261126100000") return png([[p.x, p.y, [33, 140, 255, 255]]]);
			if (valid === "20261126110000")
				return png([
					[p.x, p.y, [0, 65, 255, 255]],
					[n.x, n.y, [250, 245, 0, 255]],
				]);
			if (valid === "20261126120000") return png();
			if (valid === "20261126130000") return new Response(null, { status: 503 });
		}
		if (element === "snowf03h") {
			if (valid === "20261126110000")
				return png([
					[p.x, p.y, [242, 242, 255, 255]],
					[n.x, n.y, [160, 210, 255, 255]],
				]);
			if (valid === "20261126120000") return png([[n.x, n.y, [33, 140, 255, 255]]]);
			if (valid === "20261126130000") return png([[p.x, p.y, [180, 0, 104, 255]]]);
		}
		if (element === "snowf06h" && valid === "20261126110000") return png([[p.x, p.y, [160, 210, 255, 255]]]);
		if (element === "snowf12h" && valid === "20261126110000") return png([[p.x, p.y, [33, 140, 255, 255]]]);
		if (element === "snowf24h" && valid === "20261126110000") return png([[p.x, p.y, [250, 245, 0, 255]]]);
		if (element === "snowf48h" && valid === "20261126110000") return png([[p.x, p.y, [255, 153, 0, 255]]]);
		if (element === "snowf72h" && valid === "20261126110000") return png([[p.x, p.y, [255, 40, 0, 255]]]);
		return png();
	};
}

test("weather_snow reports current and forecast depth and all snowfall bands, separating clear, missing, and unavailable", async () => {
	const snow = jmaSnow(snowFixture());
	const results: ToolResult[] = [];
	await using env = await agentEnv({ extensions: () => [createSnowExtension(snow)] });
	const bridge = env.bridge();
	env.faux.setResponses([call("weather_snow", point), noting(results)]);
	env.link.emit(message("!a:example.org", "$1", "この地点の今後の雪は？"));
	await bridge.idle();

	assert.equal(results[0]?.isError, false);
	const text = results[0]?.text ?? "";
	assert.match(text, /基準 11-26 20:00/);
	const lines = text.split("\n");
	assert.ok(lines.includes("| 時刻 | 積雪 | 3h降雪 | 6h降雪 | 12h降雪 | 24h降雪 | 48h降雪 | 72h降雪 |"));
	assert.ok(
		lines.includes(
			"| 11-26 20:00（実況） | 20以上50未満 | 3未満 | 5以上10未満 | 15以上20未満 | 40以上50未満 | 60以上80未満 | 100以上120未満 |",
		),
	);
	assert.ok(lines.includes("| 11-26 21:00 | なし | 欠測 | なし | なし | なし | なし | なし |"));
	assert.ok(lines.includes("| 11-26 22:00 | 取得・判定できず | 30以上 | なし | なし | なし | なし | なし |"));

	assert.doesNotMatch(text, /11-26 19:00/);
	assert.doesNotMatch(text, /11-26 18:00/);
});

test("weather_snow includes only the requested past analysis hours when pastHours is set", async () => {
	const snow = jmaSnow(snowFixture());
	const results: ToolResult[] = [];
	await using env = await agentEnv({ extensions: () => [createSnowExtension(snow)] });
	const bridge = env.bridge();
	env.faux.setResponses([call("weather_snow", { ...point, pastHours: 2 }), noting(results)]);
	env.link.emit(message("!a:example.org", "$1", "過去2時間も含めて雪の状況を見て"));
	await bridge.idle();

	assert.equal(results[0]?.isError, false);
	const text = results[0]?.text ?? "";
	assert.match(text, /\| 11-26 18:00（実況） \| 5未満 \|/);
	assert.match(text, /\| 11-26 19:00（実況） \| 5以上20未満 \|/);
	assert.match(text, /\| 11-26 20:00（実況） \| 20以上50未満 \|/);
	assert.doesNotMatch(text, /11-26 15:00/);
});

test("weather_snow treats coordinates outside the snow depth domain as missing without fetching tiles", async () => {
	let tileRequests = 0;
	const snow = jmaSnow(async (input) => {
		const path = new URL(String(input)).pathname;
		if (path.endsWith("/targetTimes.json"))
			return Response.json([frame("20261126110000", "20261126110000", ["snowd", "snowf03h", "snowf03h_nd"])]);
		if (path.includes("_nd/")) return noDataMask(ring(141, 141.125));
		tileRequests++;
		return new Response(null, { status: 500 });
	});
	const report = await snow({ lat: 10, lon: 140 });
	assert.equal(tileRequests, 0);
	assert.deepEqual(report[0]?.layers.depth, { status: "available", rows: [[null]] });
	assert.deepEqual(report[0]?.layers.snowfall3h, { status: "available", rows: [[null]] });
});

test("codemode reads adjacent snow meshes and legends without exposing weather_snow_grid directly", async () => {
	const snowGrid = jmaSnowGrid(snowFixture());
	const results: ToolResult[] = [];
	const requests: NonNullable<Parameters<typeof noting>[1]> = [];
	await using env = await agentEnv({ extensions: () => [createSnowExtension(undefined, snowGrid)], codemode: {} });
	const code = `const g = await tools.weather_snow_grid({ lat: 43.025, lon: 141.0625, sizeMeters: 10000, pastHours: 1 });
	const row = g.latitudeEdges.findIndex(edge => edge < 43.025) - 1;
	const at = (layer, lon, legend) => {
		const col = g.longitudeEdges.findIndex(edge => edge > lon) - 1;
		const v = layer.rows[row][col];
		return v === null ? null : legend[v];
	};
	const now = g.frames.find(f => f.validAt === "2026-11-26T20:00:00+09:00");
	const plus1h = g.frames.find(f => f.validAt === "2026-11-26T21:00:00+09:00");
	const plus2h = g.frames.find(f => f.validAt === "2026-11-26T22:00:00+09:00");
	return {
		unit: g.unit,
		times: g.frames.map(f => f.validAt.slice(11, 16)),
		depths: [141.03125, 141.09375].map(lon => at(now.layers.depth, lon, g.legends.depth)),
		snow3hPlus1h: [141.03125, 141.09375].map(lon => at(plus1h.layers.snowfall3h, lon, g.legends.snowfall3h)),
		plus2hDepthStatus: plus2h.layers.depth.status,
	};`;
	env.faux.setResponses([call("codemode", { code }), noting(results, requests)]);
	const bridge = env.bridge();
	env.link.emit(message("!a:example.org", "$1", "周辺の積雪と降雪を比べて"));
	await bridge.idle();

	assert.equal(results[0]?.isError, false);
	const text = results[0]?.text ?? "";
	assert.match(text, /"unit"\s*:\s*"cm"/);
	assert.match(text, /19:00[\s\S]*20:00[\s\S]*21:00[\s\S]*22:00/);
	assert.match(text, /20以上50未満[\s\S]*50以上100未満/);
	assert.match(text, /null[\s\S]*5以上10未満/);
	assert.match(text, /"plus2hDepthStatus"\s*:\s*"unavailable"/);
	assert.ok(requests[0]);
	assert.ok(offered(requests[0]).includes("weather_snow"));
	assert.ok(!offered(requests[0]).includes("weather_snow_grid"));
	assert.doesNotMatch(everything(requests[0]), /"rows"\s*:/);
});
