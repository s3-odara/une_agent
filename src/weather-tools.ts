import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { formatThreeHourForecast } from "./weather-details.ts";
import { formatRain, jmaRain, RAIN_HORIZONS } from "./weather-rain.ts";
import { FORECAST_PERIODS, formatForecast, type jmaForecast } from "./weather.ts";

export function createWeatherExtension(weather: ReturnType<typeof jmaForecast>) {
	return defineExtension({
		name: "weather",
		tools: [
			defineTool({
				name: "weather_forecast",
				description: "気象庁の天気予報を取得する。",
				parameters: obj({
					place: opt(str({ description: "都道府県名、市区町村名（都道府県名は任意）、予報区域名のいずれか。省略時は既定地域。" })),
					period: opt(oneOf(FORECAST_PERIODS, { description: "省略で短期（天気は明後日まで）、week で週間、3h で3時間ごと（降水確率なし）。" })),
				}),
				replay: "safe",
				execute: async ({ place, period }) => {
					const forecast = await weather(place, period);
					return { output: [{ type: "text" as const, text: "slots" in forecast ? formatThreeHourForecast(forecast) : formatForecast(forecast) }] };
				},
			}),
		],
	});
}

export function createRainExtension(rain = jmaRain()) {
	return defineExtension({
		name: "weather-rain",
		tools: [defineTool({
			name: "weather_rain",
			description: "指定座標の降水予測を気象庁から取得する。",
			parameters: obj({
				lat: num({ exclusiveMinimum: -85, exclusiveMaximum: 85, description: "緯度（十進度）" }),
				lon: num({ minimum: -180, exclusiveMaximum: 180, description: "経度（十進度）" }),
				horizon: oneOf(RAIN_HORIZONS, { description: "1h は実況と60分先までの5分ごとの降水強度、15h は15時間先までの1時間降水量。" }),
			}),
			replay: "safe",
			execute: async (query) => ({ output: [{ type: "text" as const, text: formatRain(await rain(query), query) }] }),
		})],
	});
}
