import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { formatForecast, type WeatherSource } from "./weather.ts";

/** An extension of its own: it needs `weather` in the config, not the calendar. */
export function createWeatherExtension(weather: WeatherSource) {
	return defineExtension({
		name: "weather",
		tools: [
			defineTool({
				name: "weather_forecast",
				description: "ユーザーの地域の天気予報（気象庁、今日から数日分）を取得する。",
				parameters: obj({}),
				replay: "safe",
				execute: async () => ({ output: [{ type: "text" as const, text: formatForecast(await weather()) }] }),
			}),
		],
	});
}
