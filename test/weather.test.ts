import assert from "node:assert/strict";
import { test } from "node:test";
import { jmaForecast, parseJmaForecast } from "../src/weather.ts";
import { createWeatherExtension } from "../src/weather-tools.ts";
import { agentEnv, testConfig } from "./env.ts";
import { call, message, noting, type ToolResult } from "./fakes.ts";

const tokyo = testConfig("/nowhere", { weather: { areaCode: "130010" } }).weather!;
const island = { name: "伊豆諸島北部", code: "130020" };
const mainland = { name: "東京地方", code: "130010" };
const jmaFile = [
	{
		reportDatetime: "2026-11-17T05:00:00+09:00",
		timeSeries: [
			{ timeDefines: ["2026-11-17T05:00:00+09:00", "2026-11-18T00:00:00+09:00"], areas: [{ area: mainland, weathers: ["くもり　昼過ぎ　から　雨", "晴れ"] }, { area: island, weathers: ["雨", "雨"] }] },
			{ timeDefines: ["2026-11-17T06:00:00+09:00", "2026-11-17T12:00:00+09:00", "2026-11-18T00:00:00+09:00"], areas: [{ area: island, pops: ["90", "90", "90"] }, { area: mainland, pops: ["30", "70", "10"] }] },
			{ timeDefines: ["2026-11-17T09:00:00+09:00", "2026-11-17T00:00:00+09:00", "2026-11-18T00:00:00+09:00", "2026-11-18T09:00:00+09:00"], areas: [{ area: { name: "大島", code: "44172" }, temps: ["18", "18", "17", "19"] }, { area: { name: "東京", code: "44132" }, temps: ["15", "15", "9", "21"] }] },
		],
	},
];

test("the forecast combines the requested area's weather and rain with its representative station, even when the orders differ", () => {
	const forecast = parseJmaForecast(jmaFile, tokyo);
	assert.equal(forecast.area, "東京地方");
	assert.equal(forecast.temperatureStation, "東京");
	assert.deepEqual(forecast.days, [
		{ date: "2026-11-17", weather: "くもり昼過ぎから雨", rain: ["06-12時 30%", "12-18時 70%"], maxTemp: "15" },
		{ date: "2026-11-18", weather: "晴れ", rain: ["00-06時 10%"], minTemp: "9", maxTemp: "21" },
	]);
});

test("missing rain or temperature for an area is left out rather than borrowed from another area", () => {
	const [weather, rain, temps] = jmaFile[0]!.timeSeries;
	const file = [{ timeSeries: [
		weather,
		{ ...rain, areas: rain!.areas.filter((entry) => entry.area.name === island.name) },
		{ ...temps, areas: temps!.areas.filter((entry) => entry.area.name === "大島") },
	] }];
	const forecast = parseJmaForecast(file, tokyo);
	assert.equal(forecast.area, mainland.name);
	assert.ok(forecast.days.some((day) => day.weather !== undefined));
	for (const day of forecast.days) {
		assert.equal(day.rain.length, 0);
		assert.equal(day.minTemp, undefined);
		assert.equal(day.maxTemp, undefined);
	}
});

test("a file of another shape gives no days instead of failing", () => {
	assert.deepEqual(parseJmaForecast({ unexpected: true }, tokyo).days, []);
	assert.deepEqual(parseJmaForecast([{ timeSeries: "nope" }], tokyo).days, []);
});

test("the model can request a municipality without changing the default forecast", async () => {
	const results: ToolResult[] = [];
	await using env = await agentEnv({
		config: { weather: { areaCode: "130010" } },
		extensions: ({ config }) => [createWeatherExtension(jmaForecast(config.weather, async () => Response.json(jmaFile)))],
	});
	env.faux.setResponses([
		call("weather_forecast_area", { place: "東京都大島町" }),
		noting(results),
		call("weather_forecast_area", {}),
		noting(results),
	]);
	const bridge = env.bridge();
	env.link.emit(message("!a:example.org", "$1", "大島町の天気は?"));
	await bridge.idle();
	env.link.emit(message("!a:example.org", "$2", "いつもの地域は?"));
	await bridge.idle();

	assert.equal(results[0]?.isError, false);
	assert.match(results[0]?.text ?? "", /伊豆諸島北部の天気予報.*気温：大島地点/);
	assert.equal(results[1]?.isError, false);
	assert.match(results[1]?.text ?? "", /東京地方の天気予報.*気温：東京地点.*日本時間/);
	assert.match(results[1]?.text ?? "", /2026-11-18 晴れ.*00-06時 10%/);
});

test("without a default, a prefecture-qualified municipality sends only its forecast office code to JMA", async () => {
	const urls: string[] = [];
	const weather = jmaForecast(undefined, async (url) => {
		urls.push(String(url));
		return Response.json([]);
	});

	await assert.rejects(weather(), /地名を指定/);
	await weather("北海道札幌市");
	await weather("沖縄県那覇市");
	assert.deepEqual(urls, [
		"https://www.jma.go.jp/bosai/forecast/data/forecast/016000.json",
		"https://www.jma.go.jp/bosai/forecast/data/forecast/471000.json",
	]);
});

test("without a configured default, the model can resolve an ambiguous place and get its forecast", async () => {
	const results: ToolResult[] = [];
	const urls: string[] = [];
	const weather = jmaForecast(undefined, async (url) => {
		urls.push(String(url));
		return Response.json(jmaFile);
	});
	await using env = await agentEnv({ extensions: () => [createWeatherExtension(weather)] });
	env.faux.setResponses([
		call("weather_forecast_area", { place: "府中市" }), noting(results),
		call("weather_forecast_area", { place: "東京都府中市" }), noting(results),
	]);
	const bridge = env.bridge();
	env.link.emit(message("!a:example.org", "$1", "府中市の天気は?"));
	await bridge.idle();

	assert.equal(results[0]?.isError, true);
	assert.match(results[0]?.text ?? "", /東京都府中市/);
	assert.match(results[0]?.text ?? "", /広島県府中市/);
	assert.deepEqual(urls, []);

	env.link.emit(message("!a:example.org", "$2", "東京の方"));
	await bridge.idle();
	assert.equal(results[1]?.isError, false);
	assert.match(results[1]?.text ?? "", /東京地方の天気予報/);
	assert.deepEqual(urls, ["https://www.jma.go.jp/bosai/forecast/data/forecast/130000.json"]);
});

test("a prefecture served by several forecast offices returns area choices that can be retried", async () => {
	const urls: string[] = [];
	const weather = jmaForecast(undefined, async (url) => {
		urls.push(String(url));
		return Response.json([]);
	});
	await assert.rejects(weather("沖縄県"), (error: Error) => {
		assert.match(error.message, /沖縄本島地方・本島中南部/);
		assert.match(error.message, /宮古島地方/);
		return true;
	});
	assert.deepEqual(urls, []);

	await weather("沖縄本島地方・本島中南部");
	await weather("宮古島地方");
	assert.deepEqual(urls, [
		"https://www.jma.go.jp/bosai/forecast/data/forecast/471000.json",
		"https://www.jma.go.jp/bosai/forecast/data/forecast/473000.json",
	]);
});

test("a prefecture with one forecast area does not require a choice", async () => {
	const urls: string[] = [];
	const weather = jmaForecast(undefined, async (url) => {
		urls.push(String(url));
		return Response.json([]);
	});
	await weather("大阪府");
	assert.deepEqual(urls, ["https://www.jma.go.jp/bosai/forecast/data/forecast/270000.json"]);
});

test("a weekly request uses the covering region and labels its actual temperature station", async () => {
	const dates = ["2026-11-18T00:00:00+09:00", "2026-11-19T00:00:00+09:00"];
	const weather = jmaForecast(undefined, async () => Response.json([jmaFile[0], {
			reportDatetime: "2026-11-17T11:00:00+09:00",
			timeSeries: [
				{ timeDefines: dates, areas: [{ area: { code: "140000", name: "神奈川県" }, weatherCodes: ["100", "212"], pops: ["", "50"], reliabilities: ["", "B"] }] },
				{ timeDefines: dates.slice(1), areas: [{ area: { code: "46106", name: "横浜" }, tempsMin: ["8"], tempsMax: ["18"] }] },
			],
	}]));
	const results: ToolResult[] = [];
	await using env = await agentEnv({ extensions: () => [createWeatherExtension(weather)] });
	env.faux.setResponses([call("weather_forecast_area", { place: "小田原市", period: "week" }), noting(results)]);
	const bridge = env.bridge();
	env.link.emit(message("!a:example.org", "$1", "小田原の週間天気は？"));
	await bridge.idle();

	assert.equal(results[0]?.isError, false);
	const forecast = results[0]?.text ?? "";
	assert.match(forecast, /神奈川県の週間天気予報/);
	assert.match(forecast, /横浜地点/);
	const day = forecast.split("\n").find((line) => line.includes("2026-11-19")) ?? "";
	for (const field of [/曇後一時雨/, /最低\s*8℃/, /最高\s*18℃/, /50%/, /信頼度\s*B/]) assert.match(day, field);
});

test("three-hour queries in one office disclose the same areas but show the requested area locally", async () => {
	const requested = new Set<string>();
	const weather = jmaForecast(undefined, async (input) => {
		const area = new URL(String(input)).pathname.split("/").at(-1)!.replace(/\.json$/, "");
		requested.add(area);
		const west = area === "140020";
		return Response.json({
			firstAreaCode: west ? "140020" : "140010",
			reportDateTime: "2026-11-17T11:00:00+09:00",
			areaTimeSeries: {
				timeDefines: [{ dateTime: "2026-11-17T15:00:00+09:00", duration: "PT3H" }],
				weather: [west ? "雨" : "晴れ"], wind: [{ direction: "北", range: "3 5" }],
			},
			pointTimeSeries: {
				pointNameJP: west ? "小田原" : "横浜",
				timeDefines: [{ dateTime: "2026-11-17T18:00:00+09:00" }, { dateTime: "2026-11-17T15:00:00+09:00" }],
				temperature: [8, 10],
			},
		});
	});
	const results: ToolResult[] = [];
	await using env = await agentEnv({ extensions: () => [createWeatherExtension(weather)] });
	env.faux.setResponses([
		call("weather_forecast_area", { place: "小田原市", period: "3h" }), noting(results),
		call("weather_forecast_area", { place: "横浜市", period: "3h" }), noting(results),
	]);
	const bridge = env.bridge();
	env.link.emit(message("!a:example.org", "$1", "小田原の時間ごとの天気は？"));
	await bridge.idle();
	assert.deepEqual(requested, new Set(["140010", "140020"]));
	requested.clear();
	env.link.emit(message("!a:example.org", "$2", "横浜は？"));
	await bridge.idle();

	assert.deepEqual(requested, new Set(["140010", "140020"]));
	assert.equal(results[0]?.isError, false);
	const west = results[0]?.text ?? "";
	assert.match(west, /神奈川県・西部/);
	assert.match(west, /小田原地点/);
	const slot = west.split("\n").find((line) => line.includes("15:00")) ?? "";
	for (const field of [/18:00/, /雨/, /北/, /3\D+5\s*m\/s/, /10℃/, /開始時点/]) assert.match(slot, field);
	assert.ok(west.split("\n").some((line) => line.includes("18:00") && line.includes("8℃") && !line.includes("15:00")));
	assert.equal(results[1]?.isError, false);
	const east = results[1]?.text ?? "";
	assert.match(east, /神奈川県・東部/);
	assert.match(east, /横浜地点/);
	assert.ok(east.split("\n").some((line) => line.includes("15:00") && line.includes("晴れ")));
});

test("an unknown place is not treated as the default area", async () => {
	const weather = jmaForecast(tokyo, async () => assert.fail("an unresolved place must not reach JMA"));
	await assert.rejects(weather("架空市"), /見つかりません/);
});
