import { readFileSync } from "node:fs";
import { clockJst, inJst } from "./jma-grid.ts";
import { markdownTable } from "./text.ts";
import { forecastAreaName, type ForecastArea } from "./weather-areas.ts";
import type { DayForecast, Forecast } from "./weather.ts";

const weekCodes = JSON.parse(readFileSync(new URL("./jma/week_area05.json", import.meta.url), "utf8")) as Record<
	string,
	string[]
>;
const weekStations = JSON.parse(readFileSync(new URL("./jma/week_area.json", import.meta.url), "utf8")) as Record<
	string,
	{ week: string; amedas: string }[]
>;
const weatherCodes = JSON.parse(readFileSync(new URL("./jma/weather_codes.json", import.meta.url), "utf8")) as Record<
	string,
	string
>;

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

const items = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const label = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);
const numeric = (value: unknown) =>
	(typeof value === "number" || label(value) !== undefined) && Number.isFinite(Number(value))
		? String(Number(value))
		: undefined;

function areaIn(series: unknown, code: string) {
	return items(record(series)?.areas)
		.map(record)
		.find((entry) => record(entry?.area)?.code === code);
}

function dated(series: unknown, fn: (date: string, index: number) => void) {
	items(record(series)?.timeDefines).forEach((value, index) => {
		if (typeof value === "string" && Number.isFinite(Date.parse(value))) fn(value.slice(0, 10), index);
	});
}

export function parseWeeklyForecast(json: unknown, target: ForecastArea): Forecast {
	const block = record(items(json)[1]);
	const [weatherSeries, tempSeries] = items(block?.timeSeries);
	const approvedCodes = weekCodes[target.areaCode] ?? [];
	const selection = [target.areaCode, ...approvedCodes]
		.map((code) => ({ code, data: areaIn(weatherSeries, code) }))
		.find(({ data }) => label(record(data?.area)?.name) !== undefined);
	const reportedAt = label(block?.reportDatetime) ?? "";
	const area = label(record(selection?.data?.area)?.name);
	if (selection === undefined || area === undefined) return { area: "", period: "week", reportedAt, days: [] };

	const { data, code } = selection;
	const days = new Map<string, DayForecast>();
	dated(weatherSeries, (date, index) => {
		const key = label(items(data?.weatherCodes)[index]);
		const weather = key === undefined ? undefined : weatherCodes[key];
		const pop = numeric(items(data?.pops)[index]);
		const confidence = label(items(data?.reliabilities)[index]);
		const reliability = confidence !== undefined && /^[ABC]$/.test(confidence) ? confidence : undefined;
		if (weather !== undefined || pop !== undefined || reliability !== undefined)
			days.set(date, { date, weather, rain: pop === undefined ? [] : [`${pop}%`], reliability });
	});

	const representative = weekStations[target.officeCode]?.find((entry) => entry.week === code)?.amedas;
	const stationCodes = [
		...(code === target.areaCode ? target.temperatureCodes : []),
		...(representative === undefined ? [] : [representative]),
	];
	const temp = stationCodes
		.map((station) => areaIn(tempSeries, station))
		.find((entry) => label(record(entry?.area)?.name) !== undefined);
	const temperatureStation = label(record(temp?.area)?.name);
	if (temperatureStation !== undefined)
		dated(tempSeries, (date, index) => {
			const minTemp = numeric(items(temp?.tempsMin)[index]);
			const maxTemp = numeric(items(temp?.tempsMax)[index]);
			if (minTemp !== undefined || maxTemp !== undefined)
				days.set(date, { ...(days.get(date) ?? { date, rain: [] }), minTemp, maxTemp });
		});
	return {
		area,
		period: "week",
		reportedAt,
		temperatureStation,
		days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
	};
}

type Slot = { start: number; end?: number; weather?: string; wind?: string; temperature?: string };
export type ThreeHourForecast = {
	area: string;
	reportedAt?: string;
	temperatureStation?: string;
	slots: readonly Slot[];
};

function windText(value: unknown): string | undefined {
	const wind = record(value);
	const direction = label(wind?.direction);
	const [low, high] =
		label(wind?.range)
			?.split(/\s+/)
			.filter((part) => /^\d+$/.test(part)) ?? [];
	const range = low === undefined ? undefined : high === undefined ? `${low}以上` : `${low}〜${high}`;
	return [direction, range === undefined ? undefined : `${range} m/s`].filter(Boolean).join(" ") || undefined;
}

export function parseThreeHourForecast(json: unknown, target: ForecastArea): ThreeHourForecast {
	const area = forecastAreaName(target.areaCode);
	const data = record(json);
	if (data?.firstAreaCode !== target.areaCode) return { area, slots: [] };
	const weather = record(data.areaTimeSeries);
	const temp = record(data.pointTimeSeries);
	const temperatureStation = label(temp?.pointNameJP);
	const slots = new Map<number, Slot>();
	items(weather?.timeDefines).forEach((raw, index) => {
		const time = record(raw);
		const start = Date.parse(label(time?.dateTime) ?? "");
		if (!Number.isFinite(start) || time?.duration !== "PT3H") return;
		const end = start + 3 * 60 * 60 * 1000;
		const sky = label(items(weather?.weather)[index]);
		const wind = windText(items(weather?.wind)[index]);
		if (sky !== undefined || wind !== undefined) slots.set(start, { start, end, weather: sky, wind });
	});
	if (temperatureStation !== undefined)
		items(temp?.timeDefines).forEach((raw, index) => {
			const start = Date.parse(label(record(raw)?.dateTime) ?? "");
			const temperature = numeric(items(temp?.temperature)[index]);
			if (Number.isFinite(start) && temperature !== undefined)
				slots.set(start, { ...(slots.get(start) ?? { start }), temperature });
		});
	return {
		area,
		reportedAt: label(data.reportDateTime),
		temperatureStation,
		slots: [...slots.values()].sort((a, b) => a.start - b.start),
	};
}

export function formatThreeHourForecast(forecast: ThreeHourForecast): string {
	if (forecast.slots.length === 0) return "指定区域の3時間ごとの予報を取得できませんでした。";
	const stamp = (ms: number) => clockJst(inJst(ms));
	const hasTemp = forecast.slots.some((slot) => slot.temperature !== undefined);
	const hasWind = forecast.slots.some((slot) => slot.wind !== undefined);
	const station = forecast.temperatureStation && hasTemp ? `、気温：${forecast.temperatureStation}地点` : "";
	const report = forecast.reportedAt === undefined ? "" : `、${forecast.reportedAt} 発表`;
	const columns = ["期間", "天気", ...(hasWind ? ["風"] : []), ...(hasTemp ? ["気温(開始時点, ℃)"] : [])];
	const rows = forecast.slots.map(({ start, end, weather, wind, temperature }) => {
		const period = end === undefined ? stamp(start) : `${stamp(start)}〜${stamp(end)}`;
		return [period, weather ?? "—", ...(hasWind ? [wind ?? "—"] : []), ...(hasTemp ? [temperature ?? "—"] : [])];
	});
	return [
		`${forecast.area}の3時間ごとの予報（気象庁${report}${station}、日本時間）`,
		"",
		...markdownTable(columns, rows),
	].join("\n");
}
