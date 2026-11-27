import assert from "node:assert/strict";
import { test } from "node:test";
import { jmaWeatherDistribution, jmaWeatherDistributionGrid } from "../src/weather-distribution.ts";
import { createWeatherExtension } from "../src/weather-tools.ts";
import { jmaForecast } from "../src/weather.ts";
import { agentEnv } from "./env.ts";
import { call, message, noting, offered, type ToolResult } from "./fakes.ts";

const point = { lat: 35.025, lon: 140.03 };
const next = { ...point, lon: 140.09 };
const collection = (...features: object[]) => Response.json({ type: "FeatureCollection", features });
const ring = (west: number, east: number, south = 35, north = 35.05) => [
	[west, south],
	[east, south],
	[east, north],
	[west, north],
	[west, south],
];
const polygon = (level: string, ...rings: number[][][]) => ({
	type: "Feature",
	properties: { level },
	geometry: { type: "Polygon", coordinates: rings },
});
const temperature = (lon: number, value: string) => ({
	type: "Feature",
	properties: { value },
	geometry: { type: "Point", coordinates: [lon, point.lat] },
});

function forecastFixture(requests = new Set<string>()): typeof fetch {
	const frame = (validtime: string, elements: string[], basetime = "20261122080000") => ({
		basetime,
		validtime,
		member: "none",
		elements,
	});
	return async (input) => {
		const url = new URL(String(input));
		requests.add(url.href);
		if (url.pathname.endsWith("/targetTimes.json"))
			return Response.json([
				frame("20261123150000", ["wm", "r3", "temp_point"]),
				frame("20261123000000", ["min_temp_point"]),
				frame("20261123090000", ["wm", "r3", "s3", "temp_point", "max_temp_point"]),
				frame("20261123000000", ["wm"], "20261122020000"),
			]);
		const element = url.searchParams.get("id");
		if (element === "wm")
			return collection(
				polygon("Rain", ring(140.0625, 140.125)),
				polygon("Clear", ring(140.25, 140.3125), ring(140, 140.0625)),
			);
		if (element === "r3" && url.pathname.includes("/20261123150000/"))
			return collection(polygon("1<=mm<5"), polygon("NoData"));
		if (element === "r3")
			return collection(
				polygon("20<=mm"),
				polygon("1<=mm<5", ring(140.0625, 140.125)),
				polygon("NoData", ring(-45, 315, -85, 85).slice(0, -1), ring(140, 140.125)),
			);
		if (element === "s3") return new Response(null, { status: 503 });
		if (element === "temp_point") return collection(temperature(140.031, "-2"), temperature(140.094, "1"));
		if (element === "max_temp_point") return collection(temperature(140.031, "7"));
		if (element === "min_temp_point") return collection(temperature(140.031, "-4"));
		return new Response(null, { status: 404 });
	};
}

test("the point forecast shows mesh weather, rainfall bands, and distinct interval and temperature times", async () => {
	const distribution = jmaWeatherDistribution(forecastFixture());
	const results: ToolResult[] = [];
	await using env = await agentEnv({
		extensions: () => [createWeatherExtension(jmaForecast(undefined), distribution)],
	});
	const bridge = env.bridge();
	env.faux.setResponses([call("weather_forecast", point), noting(results)]);
	env.link.emit(message("!a:example.org", "$1", "この地点の天気は？"));
	await bridge.idle();
	env.faux.setResponses([call("weather_forecast", next), noting(results)]);
	env.link.emit(message("!a:example.org", "$2", "隣の天気は？"));
	await bridge.idle();

	assert.equal(results[0]?.isError, false);
	const lines = (results[0]?.text ?? "").split("\n");
	assert.ok(lines.includes("| 期間 | 天気 | 降水(mm) | 降雪(cm) | 気温(開始時点, ℃) |"));
	assert.ok(lines.includes("| 11-23 15:00〜11-23 18:00 | 晴 | 0 | 取得・判定できず | — |"));
	assert.ok(lines.includes("| 11-23 18:00 | — | — | — | -2 |"));
	assert.ok(lines.includes("| 11-23 21:00〜11-24 00:00 | 晴 | 取得・判定できず | — | — |"));
	assert.ok(lines.includes("| 11-24 00:00 | — | — | — | -2 |"));
	const daily = lines.filter((line) => /最高|最低/.test(line));
	assert.ok(daily.some((line) => /最低気温.*-4℃/.test(line)));
	assert.ok(daily.some((line) => /最高気温.*7℃/.test(line)));
	for (const line of daily) {
		assert.match(line, /11-23/);
		assert.doesNotMatch(line, /\d{2}:\d{2}/);
	}
	const neighbor = results[1]?.text ?? "";
	assert.match(neighbor, /\| 11-23 15:00〜11-23 18:00 \| 雨 \| 1〜4 \|/);
	assert.match(neighbor, /日中の最高気温 欠測/);
});

test("the point forecast does not disclose the requested coordinates to JMA", async () => {
	const forPoint = new Set<string>();
	const forNeighbor = new Set<string>();
	await jmaWeatherDistribution(forecastFixture(forPoint))(point);
	await jmaWeatherDistribution(forecastFixture(forNeighbor))({ lat: 34.69, lon: 135.5 });
	assert.ok(forPoint.size > 0);
	assert.deepEqual(forPoint, forNeighbor);
});

test("codemode can select dry, wet and missing cells without exposing the range tool directly", async () => {
	const distributionGrid = jmaWeatherDistributionGrid(forecastFixture());
	const results: ToolResult[] = [];
	const requests: NonNullable<Parameters<typeof noting>[1]> = [];
	await using env = await agentEnv({
		extensions: () => [createWeatherExtension(jmaForecast(undefined), undefined, distributionGrid)],
		codemode: {},
	});
	const code = `const g = await tools.weather_forecast_grid({ lat: 35.025, lon: 140.0625, sizeMeters: 50000 });
	const rain = g.frames[1].layers.rain;
	const row = g.latitudeEdges.findIndex(edge => edge < 35.025) - 1;
	const amounts = [140.03, 140.09, 140.16].map(lon => {
		const value = rain.rows[row][g.longitudeEdges.findIndex(edge => edge > lon) - 1];
		return value === null ? null : g.legends.rain[value];
	});
	return { amounts, frames: g.frames.length, snow: g.frames[1].layers.snow.status, emptyMask: g.frames[2].layers.rain.status, omitted: !('high' in g.frames[2].layers) };`;
	env.faux.setResponses([call("codemode", { code }), noting(results, requests)]);
	const bridge = env.bridge();
	env.link.emit(message("!a:example.org", "$1", "周辺の降水を比べて"));
	await bridge.idle();

	assert.equal(results[0]?.isError, false);
	assert.match(results[0]?.text ?? "", /"amounts"\s*:\s*\[\s*"0",\s*"1〜4",\s*null\s*\]/);
	assert.match(results[0]?.text ?? "", /"frames"\s*:\s*3/);
	assert.match(results[0]?.text ?? "", /"emptyMask"\s*:\s*"unavailable"/);
	assert.match(results[0]?.text ?? "", /"snow"\s*:\s*"unavailable"/);
	assert.match(results[0]?.text ?? "", /"omitted"\s*:\s*true/);
	assert.ok(requests[0] && !offered(requests[0]).includes("weather_forecast_grid"));
	await assert.rejects(distributionGrid({ ...point, sizeMeters: 50_001 }), /一辺/);
});
