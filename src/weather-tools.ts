import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { formatForecast, type WeatherSource } from "./weather.ts";

export function createWeatherExtension(weather: WeatherSource) {
	return defineExtension({
		name: "weather",
		tools: [
			defineTool({
				name: "weather_forecast",
				description: "気象庁の短期予報（予報区域の天気・降水確率、代表地点の気温）。候補が返ったら、文脈で絞れる場合は候補をそのまま place に渡し、絞れなければユーザーに確認する。",
				parameters: obj({ place: opt(str({ description: "都道府県名、市区町村名（都道府県名付きも可）、または予報区域名。省略時は設定された既定地域。" })) }),
				replay: "safe",
				execute: async ({ place }) => ({ output: [{ type: "text" as const, text: formatForecast(await weather(place)) }] }),
			}),
		],
	});
}
