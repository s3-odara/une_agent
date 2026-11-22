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
				description: "気象庁の予報。候補が返ったら、文脈で絞れる場合は候補をそのまま place に渡し、絞れなければユーザーに確認する。",
				parameters: obj({
					place: opt(str({ description: "都道府県名、市区町村名（都道府県名付きも可）、または予報区域名。省略時は設定された既定地域。" })),
					period: opt(oneOf(FORECAST_PERIODS, { description: "省略で短期予報。week は7日先までの日別予報、3h は明日までの3時間ごとの天気・風・気温（降水確率なし）。" })),
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
			description: "確認済みの座標で気象庁の降水予測を読む。1h は実況と5分ごとの降水強度、15h は1時間ごとの降水量。緯度・経度は推測せず、地図ピンなどで確認する。",
			parameters: obj({
				lat: num({ exclusiveMinimum: -85, exclusiveMaximum: 85, description: "緯度（10進度）" }),
				lon: num({ minimum: -180, exclusiveMaximum: 180, description: "経度（10進度）" }),
				horizon: oneOf(RAIN_HORIZONS),
			}),
			replay: "safe",
			execute: async (query) => ({ output: [{ type: "text" as const, text: formatRain(await rain(query), query) }] }),
		})],
	});
}
