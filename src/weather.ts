import { dateOf } from "./time.ts";

export type DayForecast = {
	readonly date: string;
	readonly weather?: string;
	readonly rain: readonly string[];
	readonly minTemp?: string;
	readonly maxTemp?: string;
};

export type Forecast = { readonly area: string; readonly reportedAt: string; readonly days: readonly DayForecast[] };

export type WeatherSource = () => Promise<Forecast>;

type Series = { timeDefines?: unknown; areas?: unknown };

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.map((item) => (typeof item === "string" ? item : "")) : [];
}

function areaOf(series: Series | undefined, index: number): Record<string, unknown> | undefined {
	const areas = Array.isArray(series?.areas) ? series.areas : [];
	const area: unknown = areas[index] ?? areas[0];
	return typeof area === "object" && area !== null ? (area as Record<string, unknown>) : undefined;
}

/**
 * The file is not a documented API: the layout is read defensively, and anything missing is left out instead of
 * failing. It holds the short-range forecast as three time series: weather per day, chance of rain per 6 hours, and
 * temperatures as (min, max) pairs per day.
 */
export function parseJmaForecast(json: unknown, tz: string, areaIndex = 0): Forecast {
	const block = Array.isArray(json) && typeof json[0] === "object" && json[0] !== null ? (json[0] as Record<string, unknown>) : {};
	const series = (Array.isArray(block.timeSeries) ? block.timeSeries : []) as Series[];
	const days = new Map<string, { weather?: string; rain: string[]; temps: { hour: number; value: number }[] }>();
	const day = (time: string) => {
		const date = dateOf(Date.parse(time), tz);
		let entry = days.get(date);
		if (entry === undefined) days.set(date, (entry = { rain: [], temps: [] }));
		return entry;
	};
	const hourOf = (time: string) => Temporal.Instant.fromEpochMilliseconds(Date.parse(time)).toZonedDateTimeISO(tz).hour;

	const weatherArea = areaOf(series[0], areaIndex);
	const weathers = strings(weatherArea?.weathers);
	strings(series[0]?.timeDefines).forEach((time, index) => {
		const weather = weathers[index]?.replace(/\s+/g, "");
		if (time !== "" && weather) day(time).weather = weather;
	});

	const pops = strings(areaOf(series[1], areaIndex)?.pops);
	strings(series[1]?.timeDefines).forEach((time, index) => {
		const pop = pops[index];
		if (time === "" || !pop) return;
		const hour = hourOf(time);
		day(time).rain.push(`${String(hour).padStart(2, "0")}-${String(hour + 6).padStart(2, "0")}時 ${pop}%`);
	});

	const temps = strings(areaOf(series[2], areaIndex)?.temps);
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

	const area = weatherArea?.area;
	return {
		area: typeof area === "object" && area !== null && typeof (area as { name?: unknown }).name === "string" ? (area as { name: string }).name : "",
		reportedAt: typeof block.reportDatetime === "string" ? block.reportDatetime : "",
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

/** The office code is all that is sent: a prefecture-sized area, nothing finer. */
export function jmaForecast(officeCode: string, tz: string, areaIndex = 0): WeatherSource {
	return async () => {
		const response = await fetch(`https://www.jma.go.jp/bosai/forecast/data/forecast/${encodeURIComponent(officeCode)}.json`, {
			signal: AbortSignal.timeout(20_000),
		});
		if (!response.ok) throw new Error(`JMA forecast failed: HTTP ${response.status}`);
		return parseJmaForecast(await response.json(), tz, areaIndex);
	};
}

export function formatForecast(forecast: Forecast, dates?: readonly string[]): string {
	const days = forecast.days.filter((day) => dates === undefined || dates.includes(day.date));
	if (days.length === 0) return "天気予報を取得できませんでした。";
	const lines = days.map((day) => {
		const temp = [day.minTemp === undefined ? "" : ` 最低${day.minTemp}℃`, day.maxTemp === undefined ? "" : ` 最高${day.maxTemp}℃`].join("");
		const rain = day.rain.length === 0 ? "" : ` 降水確率 ${day.rain.join("、")}`;
		return `- ${day.date} ${day.weather ?? "（天気は未発表）"}${temp}${rain}`;
	});
	return [`${forecast.area}の天気予報（気象庁、${forecast.reportedAt} 発表）`, ...lines].join("\n");
}
