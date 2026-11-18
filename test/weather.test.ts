import assert from "node:assert/strict";
import { test } from "node:test";
import { parseJmaForecast } from "../src/weather.ts";
import { createWeatherExtension } from "../src/weather-tools.ts";
import { agentEnv } from "./env.ts";
import { call, message, noting, type ToolResult } from "./fakes.ts";

const tz = "Asia/Tokyo";

/** A forecast file of the shape the JMA serves. */
const jmaFile = [
	{
		publishingOffice: "気象庁",
		reportDatetime: "2026-11-17T05:00:00+09:00",
		timeSeries: [
			{ timeDefines: ["2026-11-17T05:00:00+09:00", "2026-11-18T00:00:00+09:00"], areas: [{ area: { name: "東京地方" }, weathers: ["くもり　昼過ぎ　から　雨", "晴れ"] }] },
			{ timeDefines: ["2026-11-17T06:00:00+09:00", "2026-11-17T12:00:00+09:00", "2026-11-18T00:00:00+09:00"], areas: [{ pops: ["30", "70", "10"] }] },
			{ timeDefines: ["2026-11-17T09:00:00+09:00", "2026-11-17T00:00:00+09:00", "2026-11-18T00:00:00+09:00", "2026-11-18T09:00:00+09:00"], areas: [{ temps: ["15", "15", "9", "21"] }] },
		],
	},
];

test("a forecast file is read into days, each with its weather, chances of rain and temperatures", () => {
	const forecast = parseJmaForecast(jmaFile, tz);
	assert.equal(forecast.area, "東京地方");
	assert.deepEqual(forecast.days, [
		{ date: "2026-11-17", weather: "くもり昼過ぎから雨", rain: ["06-12時 30%", "12-18時 70%"], maxTemp: "15" },
		{ date: "2026-11-18", weather: "晴れ", rain: ["00-06時 10%"], minTemp: "9", maxTemp: "21" },
	]);
});

test("a file of another shape gives no days instead of failing", () => {
	assert.deepEqual(parseJmaForecast({ unexpected: true }, tz).days, []);
	assert.deepEqual(parseJmaForecast([{ timeSeries: "nope" }], tz).days, []);
});

test("the forecast tool gives the model the forecast of the configured area", async () => {
	const results: ToolResult[] = [];
	await using env = await agentEnv({ extensions: () => [createWeatherExtension(async () => parseJmaForecast(jmaFile, tz))] });
	env.faux.setResponses([
		call("weather_forecast", {}),
		noting(results),
	]);
	const bridge = env.bridge();
	env.link.emit(message("!a:example.org", "$1", "天気は?"));
	await bridge.idle();

	assert.equal(results[0]?.isError, false);
	assert.match(results[0]?.text ?? "", /東京地方/);
	assert.match(results[0]?.text ?? "", /くもり昼過ぎから雨/);
});
