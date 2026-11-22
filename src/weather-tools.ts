import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { formatThreeHourForecast } from "./weather-details.ts";
import { formatWeatherDistribution, jmaWeatherDistribution, jmaWeatherDistributionGrid, WEATHER_GRID_MAX_METERS } from "./weather-distribution.ts";
import { formatRain, jmaRain, jmaRainGrid, RAIN_HORIZONS } from "./weather-rain.ts";
import { FORECAST_PERIODS, formatForecast, type jmaForecast } from "./weather.ts";

export function createWeatherExtension(
	weather: ReturnType<typeof jmaForecast>, distribution = jmaWeatherDistribution(), distributionGrid = jmaWeatherDistributionGrid(),
) {
	return defineExtension({
		name: "weather",
		tools: [
			defineTool({
				name: "weather_forecast_area",
				description: "気象庁の予報区域の天気予報（府県天気・3時間ごとの地域時系列・週間）を取得する。地点周辺の約5 km格子の予報は weather_forecast を使う。",
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
			defineTool({
				name: "weather_forecast",
				description: "指定座標を含む約5 km格子の天気分布予報を気象庁から取得する。翌日24時までの3時間ごとの天気・気温・降水量と降雪量の階級、日中の最高気温と朝の最低気温。座標は geocode で引ける。風・降水確率・明後日以降は weather_forecast_area、周辺の格子比較は codemode から weather_forecast_grid を使う。",
				parameters: obj(coordinateParameters),
				replay: "safe",
				execute: async (point) => ({ output: [{ type: "text" as const, text: formatWeatherDistribution(await distribution(point), point) }] }),
			}),
			defineTool({
				name: "weather_forecast_grid",
				description: [
					"指定範囲に重なる約5 km格子の天気分布予報を全時刻ぶん返す。rows は北→南、各行は西→東。位置は latitudeEdges・longitudeEdges で絞る。",
					"layers の weather・rain（mm）・snow（cm）は legends 内の添字。rain・snow の 0 は降水・降雪なし。temperature・high・low は℃。",
					"startAt から validAt までが天気・降水・降雪の対象期間。temperature は validAt の気温。high（日中の最高）・low（朝の最低）は validAt の日本時間の日付に対する値で、時刻値ではない。",
					"null は格子の欠測、unavailable は取得・判定できなかった要素、掲載のない要素はキーなし。必要な時刻・範囲・要素を codemode で絞ってから出力する。",
				].join("\n"),
				parameters: obj({
					...coordinateParameters,
					sizeMeters: num({ minimum: 1, maximum: WEATHER_GRID_MAX_METERS, description: "指定座標を中心とする正方形の一辺（1〜50000 mの整数）。" }),
				}),
				callers: ["tools"],
				structuredOutputSchema: distributionGridSchema,
				replay: "safe",
				execute: async (query) => ({ structuredOutput: await distributionGrid(query), output: [] }),
			}),
		],
	});
}

const numberType = { type: "number" };
const stringType = { type: "string" };
const arrayOf = (items: object) => ({ type: "array", items });
const recordOf = (properties: Record<string, object>, required = Object.keys(properties)) => ({ type: "object", properties, required });
const rainGridSchema = recordOf({
	bounds: recordOf({ west: numberType, south: numberType, east: numberType, north: numberType }),
	grids: arrayOf(recordOf({ id: stringType, longitudeEdges: arrayOf(numberType), latitudeEdges: arrayOf(numberType) })),
	cellType: { enum: ["intensityBand", "hourlyAmount"] },
	unit: { enum: ["mm/h", "mm"] },
	legend: arrayOf(stringType),
	frames: arrayOf(recordOf({
		gridId: stringType, baseAt: stringType, validAt: stringType, startAt: stringType,
		status: { enum: ["available", "unavailable"] },
		rows: arrayOf(arrayOf({ type: ["number", "null"] })),
	}, ["gridId", "baseAt", "validAt", "status"])),
}, ["bounds", "grids", "cellType", "unit", "frames"]);

const distributionLayerSchema = recordOf({
	status: { enum: ["available", "unavailable"] },
	rows: arrayOf(arrayOf({ type: ["number", "null"] })),
}, ["status"]);
const distributionGridSchema = recordOf({
	bounds: recordOf({ west: numberType, south: numberType, east: numberType, north: numberType }),
	longitudeEdges: arrayOf(numberType),
	latitudeEdges: arrayOf(numberType),
	legends: recordOf({ weather: arrayOf(stringType), rain: arrayOf(stringType), snow: arrayOf(stringType) }),
	frames: arrayOf(recordOf({
		baseAt: stringType, validAt: stringType, startAt: stringType,
		layers: recordOf(Object.fromEntries(["weather", "rain", "snow", "temperature", "high", "low"].map((key) => [key, distributionLayerSchema])), []),
	}, ["baseAt", "validAt", "layers"])),
});

const coordinateParameters = {
	lat: num({ exclusiveMinimum: -85, exclusiveMaximum: 85, description: "緯度（十進度）" }),
	lon: num({ minimum: -180, exclusiveMaximum: 180, description: "経度（十進度）" }),
};
const rainParameters = {
	...coordinateParameters,
	horizon: oneOf(RAIN_HORIZONS, { description: "1h は実況と60分先までの5分ごとの降水強度、15h は15時間先までの1時間降水量。" }),
};

export function createRainExtension(rain = jmaRain(), rainGrid = jmaRainGrid()) {
	return defineExtension({
		name: "weather-rain",
		tools: [defineTool({
			name: "weather_rain",
			description: "指定座標1点の降水予測を気象庁から取得する。座標がわからなければ geocode で引く。一定範囲の降水分布を調べるなら codemode から weather_rain_grid を使う。",
			parameters: obj(rainParameters),
			replay: "safe",
			execute: async (query) => ({ output: [{ type: "text" as const, text: formatRain(await rain(query), query) }] }),
		}), defineTool({
			name: "weather_rain_grid",
			description: [
				"指定範囲の雨の分布を全時刻ぶん返す。1h は約250 mごとの雨の強さ（legend の添字）、15h は約5 kmごとの1時間降水量（mm）。",
				"位置で絞るには gridId に対応する latitudeEdges・longitudeEdges を使う。rows は北→南、各行は西→東。",
				"0 は降水なし、null は判定不能、unavailable は rows なし。",
				"データ量が大きくなる場合もあるので、必要に応じて codemode 内で絞り込みや集計をしてから出力する。",
			].join("\n"),
			parameters: obj({
				...rainParameters,
				sizeMeters: num({ minimum: 1, maximum: 10_000, description: "指定座標を中心とする正方形の一辺（1〜10000 mの整数）。" }),
			}),
			callers: ["tools"],
			structuredOutputSchema: rainGridSchema,
			replay: "safe",
			execute: async (query) => ({ structuredOutput: await rainGrid(query), output: [] }),
		})],
	});
}
