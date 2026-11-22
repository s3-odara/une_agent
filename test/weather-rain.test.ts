import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { jmaRain } from "../src/weather-rain.ts";
import { createRainExtension } from "../src/weather-tools.ts";
import { agentEnv } from "./env.ts";
import { call, message, noting, type ToolResult } from "./fakes.ts";

const point = { lat: 40.625, lon: 140.03125 };
const tz = "Asia/Tokyo";
const timestamp = (time: string) => `20261122${time}00`;
const collection = (...features: object[]) => Response.json({ type: "FeatureCollection", features });
const noData = () => collection({
	type: "Feature",
	properties: { level: "NoData" },
	geometry: { type: "Polygon", coordinates: [[[139, 40], [141, 40], [141, 41], [139, 41], [139, 40]]] },
});

function png(rgba?: readonly number[]): Response {
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
	await using env = await agentEnv({ extensions: () => [createRainExtension(tz, rain)] });
	env.faux.setResponses([call("weather_rain", { ...point, horizon: "1h" }), noting(results)]);
	const bridge = env.bridge();
	env.link.emit(message("!a:example.org", "$1", "この地点で雨が降りそう？"));
	await bridge.idle();

	assert.equal(results[0]?.isError, false);
	const text = results[0]?.text ?? "";
	assert.match(text, /15:00（実況）：5以上10未満 mm\/h/);
	assert.match(text, /15:05：降水表示なし/);
	assert.match(text, /15:10：欠測/);
	assert.match(text, /15:15：不明/);
	assert.match(text, /15:20：不明/);
	assert.match(text, /15:25：不明/);
});

test("the 15-hour forecast uses the matching cell from each release, not its rainy neighbor", async () => {
	const urls: string[] = [];
	const rain = jmaRain(async (input) => {
		const url = String(input);
		urls.push(url);
		const path = new URL(url).pathname;
		if (path.endsWith("targetTimes.json")) return Response.json([
			amountFrame("0600", "1300", "none"), amountFrame("0600", "1400", "none"), amountFrame("0600", "1500", "none"),
			amountFrame("0620", "0720", "immed"), amountFrame("0620", "0820", "immed"), amountFrame("0610", "0710", "immed"),
		]);
		const valid = path.split("/")[7];
		if (path.includes("/rasrf_nd/")) {
			if (valid === timestamp("1400")) return noData();
			return collection();
		}
		if (valid === timestamp("0720")) return collection(amount(140.03125, 40.625294, "2.0"));
		if (valid === timestamp("0820")) return collection(amount(140.09375, 40.625294, "10.0"));
		if (valid === timestamp("1300")) return collection(amount(140.03125, 40.625, "0.4"));
		if (valid === timestamp("1500")) return new Response(null, { status: 503 });
		return collection(amount(140.03125, 40.625294, "99"));
	});

	const samples = await rain({ ...point, horizon: "15h" });
	assert.deepEqual(samples.map(({ reading }) => reading), [
		{ kind: "amount", mm: 2 }, { kind: "amount", mm: 0 }, { kind: "amount", mm: 0.4 }, { kind: "no-data" }, { kind: "unknown" },
	]);
	assert.ok(urls.every((url) => /targetTimes\.json$|\/data\.geojson\?id=rasrf_(?:nd|point)$/.test(url)));
});
