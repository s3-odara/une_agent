import { ffmpeg } from "./ffmpeg.ts";
import { features, frames, gridFor, inBatches, inJst, jmaPolygons, missingCoverage, object, square, validatePoint, type Frame, type Point } from "./jma-grid.ts";

const ROOT = "https://www.jma.go.jp/bosai/jmatile/data/snow";
const HOUR = 3_600_000;
const TILE_SIZE = 256;
const ZOOM = 10;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

export const SNOW_GRID_MAX_METERS = 50_000;
export const SNOW_MAX_PAST_HOURS = 24;

const LAYERS = ["depth", "snowfall3h", "snowfall6h", "snowfall12h", "snowfall24h", "snowfall48h", "snowfall72h"] as const;
type Layer = (typeof LAYERS)[number];
type LayerResult = { status: "available"; rows: (number | null)[][] } | { status: "unavailable" };
type Cell = Point & { col: number; row: number };

export type SnowQuery = Point & { pastHours?: number };
export type SnowGridQuery = SnowQuery & { sizeMeters: number };

const elements: Record<Layer, string> = {
	depth: "snowd",
	snowfall3h: "snowf03h",
	snowfall6h: "snowf06h",
	snowfall12h: "snowf12h",
	snowfall24h: "snowf24h",
	snowfall48h: "snowf48h",
	snowfall72h: "snowf72h",
};

function bandLabels(none: string, thresholds: readonly number[]): string[] {
	return [
		none,
		`${thresholds[0]}未満`,
		...thresholds.slice(0, -1).map((low, index) => `${low}以上${thresholds[index + 1]}未満`),
		`${thresholds[thresholds.length - 1]}以上`,
	];
}

const legends: Record<Layer, string[]> = {
	depth: bandLabels("積雪なし", [5, 20, 50, 100, 150, 200]),
	snowfall3h: bandLabels("降雪なし", [3, 5, 10, 15, 20, 25, 30]),
	snowfall6h: bandLabels("降雪なし", [5, 10, 15, 20, 25, 30, 40]),
	snowfall12h: bandLabels("降雪なし", [7, 15, 20, 25, 30, 40, 50]),
	snowfall24h: bandLabels("降雪なし", [10, 20, 30, 40, 50, 60, 70]),
	snowfall48h: bandLabels("降雪なし", [10, 20, 30, 40, 60, 80, 100]),
	snowfall72h: bandLabels("降雪なし", [10, 20, 40, 60, 80, 100, 120]),
};

// Legend SVGs and actual PNG tiles differ slightly on the lightest blue and yellow swatches.
const DEPTH_COLORS = new Map<string, number>([
	["160,210,255", 1], ["33,140,255", 2], ["0,65,255", 3],
	["250,245,0", 4], ["255,245,0", 4], ["255,153,0", 5], ["255,40,0", 6], ["180,0,104", 7],
]);

const SNOWFALL_COLORS = new Map<string, number>([
	["242,242,255", 1], ["240,240,248", 1], ["160,210,255", 2], ["33,140,255", 3], ["0,65,255", 4],
	["250,245,0", 5], ["255,245,0", 5], ["255,153,0", 6], ["255,40,0", 7], ["180,0,104", 8],
]);

const mesh = {
	x: (lon: number) => lon * 16,
	y: (lat: number) => -lat * 20,
	lon: (col: number) => col / 16,
	lat: (row: number) => -row / 20,
};

const world = TILE_SIZE * 2 ** ZOOM;
const pixels = {
	x: (lon: number) => (lon + 180) / 360 * world,
	y: (lat: number) => (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * world,
};

function tileOf(point: Point) {
	const col = Math.floor(pixels.x(point.lon));
	const row = Math.floor(pixels.y(point.lat));
	return {
		path: `${ZOOM}/${Math.floor(col / TILE_SIZE)}/${Math.floor(row / TILE_SIZE)}.png`,
		offset: ((row % TILE_SIZE) * TILE_SIZE + (col % TILE_SIZE)) * 4,
	};
}

async function decodePng(png: Buffer): Promise<Buffer> {
	if (png.length < 24 || png.length > 300_000 || !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.readUInt32BE(16) !== TILE_SIZE || png.readUInt32BE(20) !== TILE_SIZE) throw new Error("Unexpected JMA snow tile");
	const rgba = await ffmpeg(["-f", "png_pipe", "-c:v", "png", "-i", "pipe:0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], png);
	if (rgba.length !== TILE_SIZE ** 2 * 4) throw new Error("Unexpected JMA snow tile size");
	return rgba;
}

function classifyPixel(rgba: Buffer, offset: number, layer: Layer): number | null {
	const [r, g, b, alpha] = rgba.subarray(offset, offset + 4);
	if (alpha === 0) return 0;
	if (alpha !== 255) return null;
	const colors = layer === "depth" ? DEPTH_COLORS : SNOWFALL_COLORS;
	return colors.get(`${r},${g},${b}`) ?? null;
}

function inDepthDomain(point: Point): boolean {
	return point.lat >= 20 && point.lat <= 48 && point.lon >= 118 && point.lon <= 150;
}

function validatePastHours(pastHours: number | undefined): number {
	const hours = pastHours ?? 0;
	if (!Number.isInteger(hours) || hours < 0 || hours > SNOW_MAX_PAST_HOURS) {
		throw new Error(`過去時間は0〜${SNOW_MAX_PAST_HOURS}の整数で指定してください。`);
	}
	return hours;
}

function selectFrames(all: readonly Frame[], pastHours: number): Frame[] {
	const relevant = all.filter((frame) => LAYERS.some((layer) => frame.elements.includes(elements[layer])));
	if (relevant.length === 0) return [];
	const latest = Math.max(...relevant.map(({ base }) => base));
	const selected = new Map<number, Frame>();
	for (const frame of relevant) {
		const isCurrentOrForecast = frame.base === latest && frame.valid >= latest;
		const isPastAnalysis = pastHours > 0 && frame.base === frame.valid && frame.valid < latest && frame.valid >= latest - pastHours * HOUR;
		if (!isCurrentOrForecast && !isPastAnalysis) continue;
		const existing = selected.get(frame.valid);
		if (existing === undefined || frame.base > existing.base) selected.set(frame.valid, frame);
	}
	return [...selected.values()].sort((a, b) => a.valid - b.valid);
}

function client(fetchSnow: typeof fetch) {
	const get = async (path: string) => {
		const response = await fetchSnow(`${ROOT}/${path}`, { signal: AbortSignal.timeout(15_000), redirect: "error" });
		if (!response.ok) throw new Error(`JMA snow: HTTP ${response.status}`);
		return response;
	};
	const json = async (path: string): Promise<unknown> => (await get(path)).json();
	const readTile = async (path: string) => decodePng(Buffer.from(await (await get(path)).arrayBuffer()));

	const readCoverage = async (frame: Frame, element: string) => {
		const maskElement = `${element}_nd`;
		if (!frame.elements.includes(maskElement)) throw new Error("JMA snow: missing coverage layer");
		const data = await json(`${frame.basetime}/${frame.member}/${frame.validtime}/surf/${maskElement}/data.geojson?id=${maskElement}`);
		return missingCoverage(features(data).flatMap((entry) => {
			const { geometry, properties } = object(entry);
			if (object(properties).level !== "NoData") throw new Error("Unexpected JMA snow coverage level");
			return jmaPolygons(geometry, true);
		}));
	};

	const readLayer = async (frame: Frame, layer: Layer, cells: Cell[][]): Promise<LayerResult> => {
		const element = elements[layer];
		try {
			const missing = layer === "depth" ? (point: Point) => !inDepthDomain(point) : await readCoverage(frame, element);
			const paths = new Set<string>();
			const targets = cells.map((row) => row.map((cell) => {
				if (missing(cell)) return null;
				const target = tileOf(cell);
				paths.add(target.path);
				return target;
			}));
			const prefix = `${frame.basetime}/${frame.member}/${frame.validtime}/surf/${element}`;
			const tiles = new Map(await inBatches([...paths], async (path) => [path, await readTile(`${prefix}/${path}`).catch(() => undefined)] as const));
			if (tiles.size > 0 && ![...tiles.values()].some((tile) => tile !== undefined)) return { status: "unavailable" };
			const rows = targets.map((row) => row.map((target) => {
				if (target === null) return null;
				const rgba = tiles.get(target.path);
				return rgba === undefined ? null : classifyPixel(rgba, target.offset, layer);
			}));
			return { status: "available", rows };
		} catch {
			return { status: "unavailable" };
		}
	};

	return async (cells: Cell[][], pastHours: number) => {
		const selected = selectFrames(frames(await json("targetTimes.json")), pastHours);
		return inBatches(selected, async (frame) => {
			const present = LAYERS.filter((layer) => frame.elements.includes(elements[layer]));
			const pairs = await inBatches(present, async (layer) => [layer, await readLayer(frame, layer, cells)] as const);
			return {
				baseAt: inJst(frame.base),
				validAt: inJst(frame.valid),
				layers: Object.fromEntries(pairs) as Partial<Record<Layer, LayerResult>>,
			};
		});
	};
}

export function jmaSnow(fetchSnow = fetch) {
	const read = client(fetchSnow);
	return async (query: SnowQuery) => {
		validatePoint(query);
		const pastHours = validatePastHours(query.pastHours);
		const col = Math.floor(mesh.x(query.lon));
		const row = Math.floor(mesh.y(query.lat));
		return read([[{ col, row, lon: mesh.lon(col + 0.5), lat: mesh.lat(row + 0.5) }]], pastHours);
	};
}

export function jmaSnowGrid(fetchSnow = fetch) {
	const read = client(fetchSnow);
	return async (query: SnowGridQuery) => {
		validatePoint(query);
		const pastHours = validatePastHours(query.pastHours);
		if (!Number.isInteger(query.sizeMeters) || query.sizeMeters < 1 || query.sizeMeters > SNOW_GRID_MAX_METERS) {
			throw new Error(`一辺は1〜${SNOW_GRID_MAX_METERS} mの整数で指定してください。`);
		}
		const bounds = square(query);
		const { grid: { longitudeEdges, latitudeEdges }, cells } = gridFor("snow", bounds, mesh, 0);
		return { bounds, longitudeEdges, latitudeEdges, unit: "cm" as const, legends, frames: await read(cells, pastHours) };
	};
}

const labels: Record<Layer, string> = {
	depth: "積雪",
	snowfall3h: "3h降雪",
	snowfall6h: "6h降雪",
	snowfall12h: "12h降雪",
	snowfall24h: "24h降雪",
	snowfall48h: "48h降雪",
	snowfall72h: "72h降雪",
};
const clock = (value: string) => value.slice(5, 16).replace("T", " ");

export function formatSnow(report: Awaited<ReturnType<ReturnType<typeof jmaSnow>>>, query: SnowQuery): string {
	if (report.length === 0) return "気象庁の今後の雪データに利用できる時刻が見つかりませんでした。";
	const latestBase = report.reduce((max, frame) => (frame.baseAt > max ? frame.baseAt : max), report[0]!.baseAt);
	const activeLayers = LAYERS.filter((key) => report.some(({ layers }) => layers[key] !== undefined));
	const row = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
	const header = row(["時刻", ...activeLayers.map((key) => labels[key])]);
	const separator = row(["---", ...activeLayers.map(() => "---")]);
	const rows = report.map(({ baseAt, validAt, layers }) => {
		const tag = validAt === baseAt ? "（実況）" : "";
		const cells = activeLayers.map((key) => {
			const layer = layers[key];
			if (layer === undefined) return "—";
			if (layer.status === "unavailable") return "取得・判定できず";
			const value = layer.rows[0]?.[0];
			if (value == null) return "欠測";
			return value === 0 ? "なし" : legends[key][value]!;
		});
		return row([`${clock(validAt)}${tag}`, ...cells]);
	});
	return [
		`気象庁｜今後の雪（cm・日本時間、約5 km格子）｜緯度 ${query.lat}、経度 ${query.lon}`,
		`基準 ${clock(latestBase)}`,
		"",
		header,
		separator,
		...rows,
	].join("\n");
}
