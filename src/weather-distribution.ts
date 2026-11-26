import { coordinates, features, frames, gridFor, inBatches, inJst, jmaPolygons, missingCoverage, object, polygonLocation, square, validatePoint, type Frame, type Point } from "./jma-grid.ts";

const ROOT = "https://www.jma.go.jp/bosai/jmatile/data/wdist";
const HOUR = 3_600_000;
const LAYERS = ["weather", "rain", "snow", "temperature", "high", "low"] as const;
export const WEATHER_GRID_MAX_METERS = 50_000;
const bands = {
	weather: [["Clear", "晴"], ["Cloudy", "曇"], ["Rain", "雨"], ["Rain/snow", "雨または雪"], ["Snow", "雪"]],
	rain: [[null, "0"], ["1<=mm<5", "1〜4"], ["5<=mm<10", "5〜9"], ["10<=mm<15", "10〜14"], ["15<=mm<20", "15〜19"], ["20<=mm", "20以上"]],
	snow: [[null, "0"], ["1<=cm<3", "1〜2"], ["3<=cm<6", "3〜5"], ["6<=cm", "6以上"]],
} as const;
const legends = {
	weather: bands.weather.map(([, label]) => label),
	rain: bands.rain.map(([, label]) => label),
	snow: bands.snow.map(([, label]) => label),
};
type Layer = (typeof LAYERS)[number];
type GridQuery = Point & { sizeMeters: number };
type LayerResult = { status: "available"; rows: (number | null)[][] } | { status: "unavailable" };
const elements: Record<Layer, string> = {
	weather: "wm", rain: "r3", snow: "s3", temperature: "temp_point", high: "max_temp_point", low: "min_temp_point",
};

const mesh = {
	x: (lon: number) => lon * 16,
	y: (lat: number) => -lat * 20,
	lon: (col: number) => col / 16,
	lat: (row: number) => -row / 20,
};
const cellKey = (col: number, row: number) => `${col},${row}`;
type Cell = Point & { col: number; row: number };

function pointValues(value: unknown) {
	const values = new Map<string, number>();
	for (const feature of features(value)) {
		const { geometry, properties } = object(feature);
		const shape = object(geometry);
		if (shape.type !== "Point") throw new Error("Unexpected JMA temperature geometry");
		const [lon, lat] = coordinates(shape.coordinates);
		const col = Math.round(mesh.x(lon) - 0.5);
		const row = Math.round(mesh.y(lat) - 0.5);
		// The GeoJSON rounds mesh-center longitudes to three decimal places.
		if (Math.abs(lon - mesh.lon(col + 0.5)) > 0.00051 || Math.abs(lat - mesh.lat(row + 0.5)) > 0.00051) throw new Error("Unexpected JMA temperature mesh");
		const raw = object(properties).value;
		const celsius = typeof raw === "string" && /^-?\d+$/.test(raw) ? Number(raw) : raw;
		if (typeof celsius !== "number" || !Number.isSafeInteger(celsius)) throw new Error("Unexpected JMA temperature value");
		values.set(cellKey(col, row), celsius);
	}
	return (cell: Cell) => values.get(cellKey(cell.col, cell.row)) ?? null;
}

function polygonValues(value: unknown, layer: keyof typeof bands) {
	const regions = features(value).map((entry) => {
		const { geometry, properties } = object(entry);
		const level = object(properties).level;
		const index = typeof level === "string" ? bands[layer].findIndex(([code]) => code === level) : -1;
		if (index === -1 && level !== "NoData") throw new Error("Unexpected JMA forecast level");
		return { index, polygons: jmaPolygons(geometry, level === "NoData") };
	});
	const missing = missingCoverage(regions.filter(({ index }) => index === -1).flatMap(({ polygons }) => polygons), layer !== "weather");
	const covered = regions.filter(({ index }) => index !== -1);
	return (cell: Cell) => {
		if (missing(cell)) return null;
		const point = polygonLocation(cell);
		return covered.find(({ polygons }) => polygons.some((contains) => contains(point)))?.index ?? (layer === "weather" ? null : 0);
	};
}

function client(fetchForecast: typeof fetch) {
	const json = async (path: string): Promise<unknown> => {
		const response = await fetchForecast(`${ROOT}/${path}`, { signal: AbortSignal.timeout(15_000), redirect: "error" });
		if (!response.ok) throw new Error(`JMA weather distribution: HTTP ${response.status}`);
		return response.json();
	};
	const read = async (frame: Frame, layer: Layer, cells: Cell[][]): Promise<LayerResult> => {
		const element = elements[layer];
		try {
			const value = await json(`${frame.basetime}/${frame.member}/${frame.validtime}/surf/${element}/data.geojson?id=${element}`);
			const at = layer === "weather" || layer === "rain" || layer === "snow" ? polygonValues(value, layer) : pointValues(value);
			return { status: "available", rows: cells.map((row) => row.map(at)) };
		} catch {
			return { status: "unavailable" };
		}
	};
	return async (cells: Cell[][]) => {
		const index = frames(await json("targetTimes.json")).filter((frame) => LAYERS.some((layer) => frame.elements.includes(elements[layer])));
		const latest = Math.max(...index.map(({ base }) => base));
		const selected = index.filter(({ base }) => base === latest).sort((a, b) => a.valid - b.valid);
		return inBatches(selected, async (frame) => {
			const pairs: [Layer, LayerResult][] = [];
			for (const layer of LAYERS) {
				if (frame.elements.includes(elements[layer])) pairs.push([layer, await read(frame, layer, cells)]);
			}
			return {
				baseAt: inJst(frame.base), validAt: inJst(frame.valid),
				...(pairs.some(([layer]) => layer === "weather" || layer === "rain" || layer === "snow") && { startAt: inJst(frame.valid - 3 * HOUR) }),
				layers: Object.fromEntries(pairs) as Partial<Record<Layer, LayerResult>>,
			};
		});
	};
}

export function jmaWeatherDistribution(fetchForecast = fetch) {
	const read = client(fetchForecast);
	return async (point: Point) => {
		validatePoint(point);
		const col = Math.floor(mesh.x(point.lon));
		const row = Math.floor(mesh.y(point.lat));
		return read([[{ col, row, lon: mesh.lon(col + 0.5), lat: mesh.lat(row + 0.5) }]]);
	};
}

export function jmaWeatherDistributionGrid(fetchForecast = fetch) {
	const read = client(fetchForecast);
	return async (query: GridQuery) => {
		validatePoint(query);
		if (!Number.isInteger(query.sizeMeters) || query.sizeMeters < 1 || query.sizeMeters > WEATHER_GRID_MAX_METERS) throw new Error("一辺は1〜50000 mの整数で指定してください。");
		const bounds = square(query);
		const { grid: { longitudeEdges, latitudeEdges }, cells } = gridFor("wdist", bounds, mesh, 0);
		return { bounds, longitudeEdges, latitudeEdges, legends, frames: await read(cells) };
	};
}

const labels: Record<Layer, string> = {
	weather: "天気",
	rain: "降水(mm)",
	snow: "降雪(cm)",
	temperature: "気温(開始時点, ℃)",
	high: "日中の最高気温",
	low: "朝の最低気温",
};
const clock = (value: string) => value.slice(5, 16).replace("T", " ");

function formatLayerCell(key: Layer, layer: LayerResult | undefined): string {
	if (layer === undefined) return "—";
	if (layer.status === "unavailable") return "取得・判定できず";
	const value = layer.rows[0]?.[0];
	if (value == null) return "欠測";
	return key === "weather" || key === "rain" || key === "snow" ? legends[key][value]! : String(value);
}

export function formatWeatherDistribution(report: Awaited<ReturnType<ReturnType<typeof jmaWeatherDistribution>>>, point: Point) {
	const first = report[0];
	if (first === undefined) return "気象庁の天気分布予報に利用できる時刻が見つかりませんでした。";
	const daily = new Map<string, string[]>();
	const temps = new Map<string, LayerResult>();
	const intervals: { startAt: string; validAt: string; layers: Partial<Record<Layer, LayerResult>> }[] = [];

	for (const { startAt, validAt, layers } of report) {
		if (layers.temperature !== undefined) temps.set(validAt, layers.temperature);
		if (startAt !== undefined && (layers.weather !== undefined || layers.rain !== undefined || layers.snow !== undefined)) {
			intervals.push({ startAt, validAt, layers });
		}
		const extremes = (["low", "high"] as const).flatMap((key) => {
			const layer = layers[key];
			if (layer === undefined) return [];
			const formatted = formatLayerCell(key, layer);
			return [`${labels[key]} ${/^-?\d+$/.test(formatted) ? `${formatted}℃` : formatted}`];
		});
		if (extremes.length > 0) {
			const day = validAt.slice(5, 10);
			daily.set(day, [...(daily.get(day) ?? []), ...extremes]);
		}
	}

	const usedTemps = new Set<string>();
	const entries: { sortKey: string; period: string; layers: Partial<Record<Layer, LayerResult>> }[] = intervals.map(({ startAt, validAt, layers }) => {
		const temperature = temps.get(startAt);
		if (temperature !== undefined) usedTemps.add(startAt);
		return {
			sortKey: startAt,
			period: `${clock(startAt)}〜${clock(validAt)}`,
			layers: {
				...(layers.weather !== undefined && { weather: layers.weather }),
				...(layers.rain !== undefined && { rain: layers.rain }),
				...(layers.snow !== undefined && { snow: layers.snow }),
				...(temperature !== undefined && { temperature }),
			},
		};
	});
	for (const [validAt, temperature] of temps) {
		if (usedTemps.has(validAt)) continue;
		entries.push({ sortKey: validAt, period: clock(validAt), layers: { temperature } });
	}
	entries.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

	const tableLayers = (["weather", "rain", "snow", "temperature"] as const).filter((key) => entries.some(({ layers }) => layers[key] !== undefined));
	const row = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
	const table = entries.length === 0 ? [] : [
		"",
		row(["期間", ...tableLayers.map((key) => labels[key])]),
		row(["---", ...tableLayers.map(() => "---")]),
		...entries.map(({ period, layers }) => row([period, ...tableLayers.map((key) => formatLayerCell(key, layers[key]))])),
	];
	const dailyLines = [...daily].map(([day, extremes]) => `- ${day}：${extremes.join("、")}`);
	return [
		`気象庁｜天気分布予報（日本時間、約5 km格子）｜緯度 ${point.lat}、経度 ${point.lon}`,
		`発表 ${clock(first.baseAt)}`,
		...table,
		...(dailyLines.length === 0 ? [] : ["", ...dailyLines]),
	].join("\n");
}
