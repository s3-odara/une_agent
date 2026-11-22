import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { jmaRain, jmaRainGrid } from "../src/weather-rain.ts";
import { createRainExtension } from "../src/weather-tools.ts";
import { agentEnv } from "./env.ts";
import { call, everything, message, noting, offered, type ToolResult } from "./fakes.ts";

const point = { lat: 40.625, lon: 140.03125 };
const timestamp = (time: string) => `20261122${time}00`;
const collection = (...features: object[]) => Response.json({ type: "FeatureCollection", features });
const noData = () => collection({
	type: "Feature",
	properties: { level: "NoData" },
	geometry: { type: "Polygon", coordinates: [[[139, 40], [141, 40], [141, 41], [139, 41], [139, 40]]] },
});

const rainCoverage = () => collection({
	type: "Feature",
	properties: { level: "NoData" },
	geometry: { type: "Polygon", coordinates: [
		[[-45, 85], [315, 85], [315, -85], [-45, -85]],
		[[139, 40], [141, 40], [141, 41], [139, 41], [139, 40]],
	] },
});

function png(rgba?: readonly number[], extra: readonly [x: number, y: number, rgba: readonly number[]][] = []): Response {
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
	if (rgba !== undefined) scanlines.set(rgba, 85 * 1025 + 1 + 79 * 4);
	for (const [x, y, color] of extra) scanlines.set(color, y * 1025 + 1 + x * 4);
	return new Response(new Uint8Array(Buffer.concat([
		Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(scanlines)), chunk("IEND", Buffer.alloc(0)),
	])));
}

const nowFrame = (valid: string, base = "0600") => ({ basetime: timestamp(base), validtime: timestamp(valid), elements: ["hrpns", "hrpns_nd"] });
const amountFrame = (base: string, valid: string, member: "immed" | "none") => ({
	basetime: timestamp(base), validtime: timestamp(valid), member, elements: ["rasrf_point", "rasrf_nd"],
});
function amount(lon: number, lat: number, value: string): object {
	return { type: "Feature", properties: { value }, geometry: { type: "Point", coordinates: [lon, lat] } };
}

test("the rain tool reads the requested pixel and separates clear, missing coverage, and unreadable frames", async () => {
	const rain = jmaRain(async (url) => {
		const path = new URL(String(url)).pathname;
		if (path.endsWith("targetTimes_N1.json")) return Response.json([nowFrame("0605", "0605"), nowFrame("0600")]);
		if (path.endsWith("targetTimes_N2.json")) return Response.json([nowFrame("0625"), nowFrame("0605"), nowFrame("0610"), nowFrame("0615"), nowFrame("0620")]);
		const valid = path.split("/")[7];
		if (path.includes("/hrpns_nd/")) return valid === timestamp("0610") ? noData() : collection();
		if (!path.endsWith("/10/910/385.png")) return new Response(null, { status: 404 });
		if (valid === timestamp("0600")) return png([33, 140, 255, 255]);
		if (valid === timestamp("0605")) return png();
		if (valid === timestamp("0615")) return png([1, 2, 3, 255]);
		if (valid === timestamp("0620")) return new Response("not a PNG");
		return new Response(null, { status: 404 });
	});
	const results: ToolResult[] = [];
	await using env = await agentEnv({ extensions: () => [createRainExtension(rain)] });
	env.faux.setResponses([call("weather_rain", { ...point, horizon: "1h" }), noting(results)]);
	const bridge = env.bridge();
	env.link.emit(message("!a:example.org", "$1", "この地点で雨が降りそう？"));
	await bridge.idle();

	assert.equal(results[0]?.isError, false);
	const text = results[0]?.text ?? "";
	assert.match(text, /日本時間/);
	assert.match(text, /降水強度.*mm\/h/);
	assert.match(text, /15:00.*実況.*5以上10未満/);
	assert.match(text, /15:05：降水表示なし/);
	assert.match(text, /15:10：欠測/);
	assert.match(text, /15:15：不明/);
	assert.match(text, /15:20：不明/);
	assert.match(text, /15:25：不明/);
});

function hourlyRainFixture(requests = new Set<string>()): typeof fetch {
	return async (input) => {
		const url = new URL(String(input));
		requests.add(url.href);
		const path = url.pathname;
		if (path.endsWith("targetTimes.json")) return Response.json([
			amountFrame("0600", "1300", "none"), amountFrame("0600", "1400", "none"), amountFrame("0600", "1500", "none"), amountFrame("0600", "1600", "none"),
			amountFrame("0620", "0720", "immed"), amountFrame("0620", "0820", "immed"), amountFrame("0610", "0710", "immed"),
		]);
		const valid = path.split("/")[7];
		if (path.includes("/rasrf_nd/")) {
			if (valid === timestamp("1400")) return noData();
			if (valid === timestamp("1600")) return collection();
			return rainCoverage();
		}
		if (valid === timestamp("0720")) return collection(amount(140.03125, 40.625294, "2.0"));
		if (valid === timestamp("0820")) return collection(amount(140.09375, 40.625294, "10.0"));
		if (valid === timestamp("1300")) return collection(amount(140.03125, 40.625, "0.4"));
		if (valid === timestamp("1500")) return new Response(null, { status: 503 });
		return collection(amount(140.03125, 40.625294, "99"));
	};
}

test("the 15-hour forecast uses the matching cell from each release, not its rainy neighbor", async () => {
	const rain = jmaRain(hourlyRainFixture());
	const samples = await rain({ ...point, horizon: "15h" });
	assert.deepEqual(samples.map(({ reading }) => reading), [
		{ kind: "amount", mm: 2 }, { kind: "amount", mm: 0 }, { kind: "amount", mm: 0.4 }, { kind: "no-data" }, { kind: "unknown" }, { kind: "unknown" },
	]);
	const neighbor = await rain({ ...point, lon: 140.09375, horizon: "15h" });
	assert.deepEqual(neighbor[1]?.reading, { kind: "amount", mm: 10 });
});

test("the 15-hour rain forecast does not disclose the requested coordinates to JMA", async () => {
	const forPoint = new Set<string>();
	const forOtherPoint = new Set<string>();
	await jmaRain(hourlyRainFixture(forPoint))({ ...point, horizon: "15h" });
	await jmaRain(hourlyRainFixture(forOtherPoint))({ ...point, lon: 139.10, horizon: "15h" });
	assert.ok(forPoint.size > 0);
	assert.deepEqual(forPoint, forOtherPoint);
});

test("the range forecast keeps adjacent native cells and distinguishes missing coverage from failed frames", async () => {
	const getGrid = jmaRainGrid(async (input) => {
		const path = new URL(String(input)).pathname;
		if (path.endsWith("targetTimes.json")) return Response.json([
			amountFrame("0600", "0700", "immed"), amountFrame("0600", "1300", "none"), amountFrame("0600", "1400", "none"), amountFrame("0600", "1500", "none"),
		]);
		const valid = path.split("/")[7];
		if (path.includes("/rasrf_nd/")) {
			if (valid === timestamp("1300")) return noData();
			if (valid === timestamp("1500")) return collection({ type: "Feature", properties: { level: "NoData" }, geometry: { type: "Polygon", coordinates: [] } });
			return rainCoverage();
		}
		if (valid === timestamp("1400")) return new Response(null, { status: 503 });
		return collection(amount(140.03125, 40.625294, "2.5"), amount(140.09375, 40.625294, "7"));
	});
	const result = await getGrid({ ...point, lon: 140.06249, sizeMeters: 1_000, horizon: "15h" });
	assert.equal(result.unit, "mm");
	const at = (validAt: string, lon: number) => {
		const frame = result.frames.find((item) => item.validAt === `${validAt}:00+09:00`);
		assert.ok(frame);
		if (frame.status === "unavailable") return frame.status;
		const grid = result.grids.find(({ id }) => id === frame.gridId);
		assert.ok(grid);
		const row = grid.latitudeEdges.findIndex((edge) => edge < point.lat) - 1;
		const col = grid.longitudeEdges.findIndex((edge) => edge > lon) - 1;
		return frame.rows[row]?.[col];
	};
	assert.equal(result.frames.find((frame) => frame.validAt === "2026-11-22T16:00:00+09:00")?.startAt, "2026-11-22T15:00:00+09:00");
	assert.deepEqual([140.061, 140.064].map((lon) => at("2026-11-22T16:00", lon)), [2.5, 7]);
	assert.equal(at("2026-11-22T22:00", 140.061), null);
	assert.equal(at("2026-11-22T23:00", 140.061), "unavailable");
	assert.equal(at("2026-11-23T00:00", 140.061), "unavailable");
});

test("codemode receives every 10 km nowcast frame with rain preserved and uncertain dry cells marked unknown, without exposing the grid to the model", async () => {
	const getGrid = jmaRainGrid(async (input) => {
		const path = new URL(String(input)).pathname;
		if (path.endsWith("targetTimes_N1.json")) return Response.json([nowFrame("0600")]);
		if (path.endsWith("targetTimes_N2.json")) return Response.json(["0605", "0610", "0615", "0620", "0625", "0630", "0635", "0640", "0645", "0650", "0655", "0700"].map((valid) => nowFrame(valid)));
		if (path.includes("/hrpns_nd/")) return collection();
		if (path.endsWith("/10/910/385.png")) return png([33, 140, 255, 255], [
			[78, 85, [255, 40, 0, 255]], [79, 84, [1, 2, 3, 255]], [80, 85, [1, 2, 3, 255]],
		]);
		return new Response(null, { status: 404 });
	});
	const results: ToolResult[] = [];
	await using env = await agentEnv({ extensions: () => [createRainExtension(undefined, getGrid)], codemode: {} });
	const args = { ...point, horizon: "1h", sizeMeters: 10_000 };
	const code = `const g = await tools.weather_rain_grid(${JSON.stringify(args)});
	const at = (frame, lon) => {
		const { latitudeEdges, longitudeEdges } = g.grids.find(grid => grid.id === frame.gridId);
		const y = latitudeEdges.findIndex(edge => edge < 40.6249) - 1;
		const x = longitudeEdges.findIndex(edge => edge > lon) - 1;
		return frame.rows[y][x];
	};
	return {
		times: g.frames.map(f => f.validAt.slice(11, 16)).join(','),
		rainy: g.frames.map(f => at(f, 140.03105)),
		aroundRain: [140.0283, 140.03105, 140.0338].map(lon => at(g.frames[0], lon))
	};`;
	const requests: NonNullable<Parameters<typeof noting>[1]> = [];
	env.faux.setResponses([call("codemode", { code }), noting(results, requests)]);
	const bridge = env.bridge();
	env.link.emit(message("!a:example.org", "$1", "周辺の雨は？"));
	await bridge.idle();
	assert.equal(results.length, 1);
	assert.equal(results[0]?.isError, false);
	const text = results[0]?.text ?? "";
	assert.match(text, /"times"\s*:\s*"15:00,15:05,15:10,15:15,15:20,15:25,15:30,15:35,15:40,15:45,15:50,15:55,16:00"/);
	assert.match(text, /"rainy"\s*:\s*\[\s*7(?:,\s*7){12}\s*\]/);
	assert.match(text, /"aroundRain"\s*:\s*\[\s*0,\s*7,\s*null\s*\]/);
	assert.ok(requests[0]);
	assert.ok(offered(requests[0]).includes("weather_rain"));
	assert.ok(!offered(requests[0]).includes("weather_rain_grid"));
	assert.doesNotMatch(everything(requests[0]), /"rows"\s*:/);
});
