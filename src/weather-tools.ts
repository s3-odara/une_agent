import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { arr, nullable, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { formatThreeHourForecast } from "./weather-details.ts";
import {
	formatWeatherDistribution,
	jmaWeatherDistribution,
	jmaWeatherDistributionGrid,
	WEATHER_GRID_MAX_METERS,
} from "./weather-distribution.ts";
import { formatRain, jmaRain, jmaRainGrid, RAIN_HORIZONS } from "./weather-rain.ts";
import { formatSnow, jmaSnow, jmaSnowGrid, SNOW_GRID_MAX_METERS, SNOW_MAX_PAST_HOURS } from "./weather-snow.ts";
import { FORECAST_PERIODS, formatForecast, type jmaForecast } from "./weather.ts";

export function createWeatherExtension(
	weather: ReturnType<typeof jmaForecast>,
	distribution = jmaWeatherDistribution(),
	distributionGrid = jmaWeatherDistributionGrid(),
) {
	return defineExtension({
		name: "weather",
		tools: [
			defineTool({
				name: "weather_forecast_area",
				description:
					"一定区域（県北部・南部など）の天気を地名で調べる。おおざっぱな空間解像度、風向・風速、3時間ごとの気温、明後日以降の天気を知りたいときに使う。市区町村名を指定しても予報は区域単位。",
				parameters: obj({
					place: opt(
						str({
							description: "都道府県名、市区町村名（都道府県名は任意）、予報区域名のいずれか。省略時は既定地域。",
						}),
					),
					period: opt(
						oneOf(FORECAST_PERIODS, {
							description:
								"省略: 府県天気（明後日までの日ごとの天気）。3h: 地域時系列予報（明日までの3時間ごとの天気、風）。week: 日ごとの週間予報（3-7日先までの天気、2日までは府県天気のコピー、信頼度つき）。",
						}),
					),
				}),
				replay: "safe",
				execute: async ({ place, period }) => {
					const forecast = await weather(place, period);
					return {
						output: [
							{
								type: "text" as const,
								text: "slots" in forecast ? formatThreeHourForecast(forecast) : formatForecast(forecast),
							},
						],
					};
				},
			}),
			defineTool({
				name: "weather_forecast",
				description:
					"指定座標を含む約5 kmメッシュについて、明日までの3時間ごとの天気・気温・降水量／降雪量の階級、日ごとの最高・最低気温を調べる。地名は geocode で座標に変換する。周辺の格子をまとめて見るには codemode の weather_forecast_grid を使う。",
				parameters: obj(coordinateParameters),
				replay: "safe",
				execute: async (point) => ({
					output: [{ type: "text" as const, text: formatWeatherDistribution(await distribution(point), point) }],
				}),
			}),
			defineTool({
				name: "weather_forecast_grid",
				description: [
					"指定範囲の天気分布を返す。約5 kmメッシュで明日までの3時間ごとの天気が全て返る。データが大きくなることがあるので必要に応じてcodemode 内で時刻・地点・値等を絞ってから出力する。",
					"位置: latitudeEdges・longitudeEdges で座標を格子に対応づける。rows は北→南、各行は西→東。",
					"時刻（日本時間）: weather・rain・snow は startAt〜validAt の3時間、temperature は validAt 時点。high・low は validAt の日付の日中最高・朝の最低。",
					"値: weather・rain（mm）・snow（cm）は要素別の legends の添字。rain・snow の 0 は降水・降雪なし。temperature・high・low は℃。null は格子の欠測、unavailable は要素の取得・判定不能（rows なし）。未掲載の要素はキーなし。",
				].join("\n"),
				parameters: obj({
					...coordinateParameters,
					sizeMeters: num({
						minimum: 1,
						maximum: WEATHER_GRID_MAX_METERS,
						description: "指定座標を中心とする正方形の一辺（1〜50000 mの整数）。",
					}),
				}),
				callers: ["tools"],
				structuredOutputSchema: distributionGridSchema,
				replay: "safe",
				execute: async (query) => ({ structuredOutput: await distributionGrid(query), output: [] }),
			}),
		],
	});
}

const boundsSchema = obj({ west: num(), south: num(), east: num(), north: num() });
const cellRowsSchema = arr(arr(nullable(num())));
const rainGridSchema = obj({
	bounds: boundsSchema,
	grids: arr(obj({ id: str(), longitudeEdges: arr(num()), latitudeEdges: arr(num()) })),
	cellType: oneOf(["intensityBand", "hourlyAmount"]),
	unit: oneOf(["mm/h", "mm"]),
	legend: opt(arr(str())),
	frames: arr(
		obj({
			gridId: str(),
			baseAt: str(),
			validAt: str(),
			startAt: opt(str()),
			status: oneOf(["available", "unavailable"]),
			rows: opt(cellRowsSchema),
		}),
	),
});

const layerResultSchema = obj({
	status: oneOf(["available", "unavailable"]),
	rows: opt(cellRowsSchema),
});
const distributionGridSchema = obj({
	bounds: boundsSchema,
	longitudeEdges: arr(num()),
	latitudeEdges: arr(num()),
	legends: obj({ weather: arr(str()), rain: arr(str()), snow: arr(str()) }),
	frames: arr(
		obj({
			baseAt: str(),
			validAt: str(),
			startAt: opt(str()),
			layers: obj({
				weather: opt(layerResultSchema),
				rain: opt(layerResultSchema),
				snow: opt(layerResultSchema),
				temperature: opt(layerResultSchema),
				high: opt(layerResultSchema),
				low: opt(layerResultSchema),
			}),
		}),
	),
});

const coordinateParameters = {
	lat: num({ exclusiveMinimum: -85, exclusiveMaximum: 85, description: "緯度（十進度）" }),
	lon: num({ minimum: -180, exclusiveMaximum: 180, description: "経度（十進度）" }),
};
const rainParameters = {
	...coordinateParameters,
	horizon: oneOf(RAIN_HORIZONS, {
		description: "1h は実況と60分先までの5分ごとの降水強度、15h は15時間先までの1時間降水量。",
	}),
};

export function createRainExtension(rain = jmaRain(), rainGrid = jmaRainGrid()) {
	return defineExtension({
		name: "weather-rain",
		tools: [
			defineTool({
				name: "weather_rain",
				description:
					"指定座標1点で、いつ降りそうか・どれくらい降りそうか調べる。地名は geocode で座標に変換する。周辺の降水まで見るなら codemode で weather_rain_grid を使う。",
				parameters: obj(rainParameters),
				replay: "safe",
				execute: async (query) => ({ output: [{ type: "text" as const, text: formatRain(await rain(query), query) }] }),
			}),
			defineTool({
				name: "weather_rain_grid",
				description: [
					"指定範囲の降水分布を返す。1hは約250mのセルで5分ごと、15hは約5kmのメッシュで1時間ごとの天気が全て返る。データが大きくなることがあるので、必要に応じてcodemode 内で時刻・地点・値等を絞ってから出力する。",
					"位置: gridId が指す grids の latitudeEdges・longitudeEdges で座標を格子に対応づける。rows は北→南、各行は西→東。",
					"時刻（日本時間）: 1h は validAt 時点の強さ、15h は startAt〜validAt の1時間降水量。",
					"値: 1h は legend の添字（mm/h の強さの階級）、15h は降水量（mm）。0 は降水なし、null は格子の判定不能、unavailable はその時刻の取得・判定不能（rows なし）。",
				].join("\n"),
				parameters: obj({
					...rainParameters,
					sizeMeters: num({
						minimum: 1,
						maximum: 10_000,
						description: "指定座標を中心とする正方形の一辺（1〜10000 mの整数）。",
					}),
				}),
				callers: ["tools"],
				structuredOutputSchema: rainGridSchema,
				replay: "safe",
				execute: async (query) => ({ structuredOutput: await rainGrid(query), output: [] }),
			}),
		],
	});
}

const snowGridSchema = obj({
	bounds: boundsSchema,
	longitudeEdges: arr(num()),
	latitudeEdges: arr(num()),
	unit: oneOf(["cm"]),
	legends: obj({
		depth: arr(str()),
		snowfall3h: arr(str()),
		snowfall6h: arr(str()),
		snowfall12h: arr(str()),
		snowfall24h: arr(str()),
		snowfall48h: arr(str()),
		snowfall72h: arr(str()),
	}),
	frames: arr(
		obj({
			baseAt: str(),
			validAt: str(),
			layers: obj({
				depth: opt(layerResultSchema),
				snowfall3h: opt(layerResultSchema),
				snowfall6h: opt(layerResultSchema),
				snowfall12h: opt(layerResultSchema),
				snowfall24h: opt(layerResultSchema),
				snowfall48h: opt(layerResultSchema),
				snowfall72h: opt(layerResultSchema),
			}),
		}),
	),
});
const snowParameters = {
	...coordinateParameters,
	pastHours: opt(
		num({
			minimum: 0,
			maximum: SNOW_MAX_PAST_HOURS,
			description: "最新実況より前にさかのぼる時間数（0〜24の整数、省略時は0で最新実況〜6時間先まで）。",
		}),
	),
};

export function createSnowExtension(snow = jmaSnow(), snowGrid = jmaSnowGrid()) {
	return defineExtension({
		name: "weather-snow",
		tools: [
			defineTool({
				name: "weather_snow",
				description:
					"指定座標を含む約5 kmメッシュについて、気象庁「今後の雪」で積雪の深さと3・6・12・24・48・72時間降雪量（最新実況〜6時間先、pastHours指定時は過去実況も）を調べる。地名は geocode で座標に変換する。周辺の格子をまとめて見るには codemode の weather_snow_grid を使う。",
				parameters: obj(snowParameters),
				replay: "safe",
				execute: async (query) => ({ output: [{ type: "text" as const, text: formatSnow(await snow(query), query) }] }),
			}),
			defineTool({
				name: "weather_snow_grid",
				description: [
					"指定範囲の気象庁「今後の雪」分布を返す。約5 kmメッシュで1時間ごとの積雪の深さと3・6・12・24・48・72時間降雪量が返る。データが大きくなることがあるので必要に応じてcodemode 内で時刻・地点・値等を絞ってから出力する。",
					"位置: latitudeEdges・longitudeEdges で座標を格子に対応づける。rows は北→南、各行は西→東。",
					"時刻（日本時間）: validAt 時点の積雪深と、validAt までの各時間累積降雪量。validAt === baseAt が実況。",
					"値: 各要素は legends の添字（cmの階級）。0 は積雪なし・降雪なし、null は格子の欠測・対象外・判定不能、unavailable は要素の取得・判定不能（rows なし）。未掲載の要素はキーなし。",
				].join("\n"),
				parameters: obj({
					...snowParameters,
					sizeMeters: num({
						minimum: 1,
						maximum: SNOW_GRID_MAX_METERS,
						description: "指定座標を中心とする正方形の一辺（1〜50000 mの整数）。",
					}),
				}),
				callers: ["tools"],
				structuredOutputSchema: snowGridSchema,
				replay: "safe",
				execute: async (query) => ({ structuredOutput: await snowGrid(query), output: [] }),
			}),
		],
	});
}
