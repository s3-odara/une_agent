import { dateOf } from "./time.ts";
import { JMA_TIME_ZONE, forecastAreaCodes, resolveForecastArea, type ForecastArea } from "./weather-areas.ts";
import { parseThreeHourForecast, parseWeeklyForecast, type ThreeHourForecast } from "./weather-details.ts";

export type DayForecast = {
	readonly date: string;
	readonly weather?: string;
	readonly rain: readonly string[];
	readonly minTemp?: string;
	readonly maxTemp?: string;
	readonly reliability?: string;
};

export type Forecast = { readonly area: string; readonly temperatureStation?: string; readonly reportedAt: string; readonly days: readonly DayForecast[]; readonly period?: "week" };

export const FORECAST_PERIODS = ["week", "3h"] as const;
export type ForecastPeriod = (typeof FORECAST_PERIODS)[number];
export type WeatherSource = (place?: string) => Promise<Forecast>;

type Series = { timeDefines?: unknown; areas?: unknown };
type AreaData = { area?: { code?: string; name?: string }; weathers?: unknown; pops?: unknown; temps?: unknown };

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.map((item) => (typeof item === "string" ? item : "")) : [];
}

function areaOf(series: Series | undefined, code: string): AreaData | undefined {
	const areas: AreaData[] = Array.isArray(series?.areas) ? series.areas : [];
	return areas.find((entry) => entry?.area?.code === code);
}

/**
 * The file is not a documented API: the layout is read defensively, and anything missing is left out instead of
 * failing. It holds the short-range forecast as three time series: weather per day, chance of rain per 6 hours, and
 * temperatures as (min, max) pairs per day.
 */
export function parseJmaForecast(json: unknown, target: ForecastArea): Forecast {
	const block = Array.isArray(json) && typeof json[0] === "object" && json[0] !== null ? (json[0] as Record<string, unknown>) : {};
	const series = (Array.isArray(block.timeSeries) ? block.timeSeries : []) as Series[];
	const days = new Map<string, { weather?: string; rain: string[]; temps: { hour: number; value: number }[] }>();
	const day = (time: string) => {
		const date = dateOf(Date.parse(time), JMA_TIME_ZONE);
		let entry = days.get(date);
		if (entry === undefined) days.set(date, (entry = { rain: [], temps: [] }));
		return entry;
	};
	const hourOf = (time: string) => Temporal.Instant.fromEpochMilliseconds(Date.parse(time)).toZonedDateTimeISO(JMA_TIME_ZONE).hour;

	const weatherArea = areaOf(series[0], target.areaCode);
	const rainArea = areaOf(series[1], target.areaCode);
	const regionName = weatherArea?.area?.name ?? rainArea?.area?.name;
	const reportedAt = typeof block.reportDatetime === "string" ? block.reportDatetime : "";
	if (typeof regionName !== "string" || !regionName) return { area: "", reportedAt, days: [] };

	const weathers = strings(weatherArea?.weathers);
	strings(series[0]?.timeDefines).forEach((time, index) => {
		const weather = weathers[index]?.replace(/\s+/g, "");
		if (time !== "" && weather) day(time).weather = weather;
	});

	const pops = strings(rainArea?.pops);
	strings(series[1]?.timeDefines).forEach((time, index) => {
		const pop = pops[index];
		if (time === "" || !pop) return;
		const hour = hourOf(time);
		day(time).rain.push(`${String(hour).padStart(2, "0")}-${String(hour + 6).padStart(2, "0")}時 ${pop}%`);
	});

	const temperatureArea = target.temperatureCodes.map((code) => areaOf(series[2], code)).find((entry) => entry !== undefined);
	const temperatureStation = temperatureArea?.area?.name;
	const temps = typeof temperatureStation === "string" && temperatureStation ? strings(temperatureArea?.temps) : [];
	strings(series[2]?.timeDefines).forEach((time, index) => {
		const temp = Number(temps[index]);
		if (time === "" || !temps[index] || Number.isNaN(temp)) return;
		day(time).temps.push({ hour: hourOf(time), value: temp });
	});
	// A day has a value at midnight and one at 9 o'clock: its minimum and maximum. Which slot holds which is not
	// consistent for the current day, so a pair is told apart by size. Two equal values mean the minimum has passed
	// and the file repeats the maximum; a lone value is taken by its slot.
	const range = (temps: { hour: number; value: number }[]): { minTemp?: string; maxTemp?: string } => {
		const [first, second] = temps;
		if (first === undefined) return {};
		if (second === undefined) return first.hour === 0 ? { minTemp: String(first.value) } : { maxTemp: String(first.value) };
		const [min, max] = [Math.min(first.value, second.value), Math.max(first.value, second.value)];
		return min === max ? { maxTemp: String(max) } : { minTemp: String(min), maxTemp: String(max) };
	};

	return {
		area: regionName,
		temperatureStation: typeof temperatureStation === "string" ? temperatureStation : undefined,
		reportedAt,
		days: [...days]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([date, entry]) => ({
				date,
				weather: entry.weather,
				rain: entry.rain,
				...range(entry.temps),
			})),
	};
}

export function jmaForecast(defaultArea: ForecastArea | undefined, fetchForecast = fetch) {
	const get = async (path: string): Promise<unknown> => {
		const response = await fetchForecast(`https://www.jma.go.jp/bosai/${path}`, { signal: AbortSignal.timeout(20_000), redirect: "error" });
		if (!response.ok) throw new Error(`JMA forecast failed: HTTP ${response.status}`);
		return response.json();
	};

	function forecast(place?: string, period?: "week"): Promise<Forecast>;
	function forecast(place: string | undefined, period: "3h"): Promise<ThreeHourForecast>;
	function forecast(place: string | undefined, period: ForecastPeriod | undefined): Promise<Forecast | ThreeHourForecast>;
	async function forecast(place?: string, period?: ForecastPeriod): Promise<Forecast | ThreeHourForecast> {
		const target = place === undefined ? defaultArea : resolveForecastArea(place);
		if (target === undefined) throw new Error("既定地域が設定されていません。地名を指定してください。");
		if (period === "3h") {
			// Sending the same requests for every place in an office avoids revealing which area was selected.
			const codes = forecastAreaCodes(target.officeCode);
			const results = await Promise.allSettled(codes.map((code) => get(`jmatile/data/wdist/VPFD/${code}.json`)));
			const result = results[codes.indexOf(target.areaCode)];
			if (result?.status === "rejected") throw result.reason;
			return parseThreeHourForecast(result?.value, target);
		}
		// JMA serves Tokachi and Amami in their neighboring offices’ forecast files.
		const code = target.officeCode === "014030" ? "014100" : target.officeCode === "460040" ? "460100" : target.officeCode;
		const data = await get(`forecast/data/forecast/${encodeURIComponent(code)}.json`);
		return period === "week" ? parseWeeklyForecast(data, target) : parseJmaForecast(data, target);
	}
	return forecast;
}

export function formatForecast(forecast: Forecast, dates?: readonly string[]): string {
	const days = forecast.days.filter((day) => dates === undefined || dates.includes(day.date));
	const name = forecast.period === "week" ? "週間天気予報" : "天気予報";
	if (days.length === 0) return `${name}を取得できませんでした。`;
	const hasReliability = forecast.period === "week" || days.some((day) => day.reliability !== undefined);
	const station = forecast.temperatureStation && days.some((day) => day.minTemp !== undefined || day.maxTemp !== undefined) ? `、気温：${forecast.temperatureStation}地点` : "";
	const columns = ["日付", "天気", "最低(℃)", "最高(℃)", "降水確率", ...(hasReliability ? ["信頼度"] : [])];
	const row = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
	const rows = days.map((day) => row([
		day.date,
		day.weather ?? "—",
		day.minTemp ?? "—",
		day.maxTemp ?? "—",
		day.rain.length === 0 ? "—" : day.rain.join("、"),
		...(hasReliability ? [day.reliability ?? "—"] : []),
	]));
	return [
		`${forecast.area}の${name}（気象庁、${forecast.reportedAt} 発表${station}、日本時間）`,
		"",
		row(columns),
		row(columns.map(() => "---")),
		...rows,
	].join("\n");
}
