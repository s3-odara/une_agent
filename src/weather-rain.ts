import { ffmpeg } from "./ffmpeg.ts";
import { dateOf } from "./time.ts";
import { JMA_TIME_ZONE } from "./weather-areas.ts";

export const RAIN_HORIZONS = ["1h", "15h"] as const;
export type RainQuery = { lat: number; lon: number; horizon: (typeof RAIN_HORIZONS)[number] };
type Point = { lat: number; lon: number };
type Reading = { kind: "intensity"; band: string } | { kind: "amount"; mm: number } | { kind: "clear" | "no-data" | "unknown" };
type Frame = { basetime: string; validtime: string; member: string; base: number; valid: number; elements: string[] };
type Sample = { base: number; valid: number; reading: Reading };
export type RainSource = (query: RainQuery) => Promise<readonly Sample[]>;

type JsonObject = Record<string, unknown>;
const ROOT = "https://www.jma.go.jp/bosai/jmatile/data";
const MINUTE = 60_000;
const TILE_SIZE = 256;
const ZOOM = 10;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const INTENSITIES = new Map([
	["242,242,255", "1未満"], ["160,210,255", "1以上5未満"], ["33,140,255", "5以上10未満"], ["0,65,255", "10以上20未満"],
	["250,245,0", "20以上30未満"], ["255,245,0", "20以上30未満"], ["255,153,0", "30以上50未満"], ["255,40,0", "50以上80未満"], ["180,0,104", "80以上"],
]);

function object(value: unknown): JsonObject {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Unexpected JMA object");
	return value as JsonObject;
}

function time(value: string): number {
	const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value);
	if (m === null) return NaN;
	return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
}

function frames(value: unknown): Frame[] {
	if (!Array.isArray(value)) throw new Error("Unexpected JMA time list");
	return value.flatMap((entry: unknown) => {
		const { basetime, validtime, member = "none", elements } = object(entry);
		if (typeof basetime !== "string" || typeof validtime !== "string" || (member !== "none" && member !== "immed") || !Array.isArray(elements)) return [];
		const base = time(basetime);
		const valid = time(validtime);
		return Number.isFinite(base) && Number.isFinite(valid) ? [{ basetime, validtime, member, base, valid, elements: elements.filter((item): item is string => typeof item === "string") }] : [];
	});
}

function features(value: unknown): unknown[] {
	const { type, features } = object(value);
	if (type !== "FeatureCollection" || !Array.isArray(features)) throw new Error("Unexpected JMA GeoJSON");
	return features;
}

function coordinates(value: unknown): [number, number] {
	if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isFinite)) throw new Error("Unexpected JMA coordinates");
	return [value[0], value[1]];
}

function inRing(point: Point, ring: [number, number][]): boolean {
	let [x1, y1] = ring[ring.length - 1]!;
	let inside = false;
	for (const [x2, y2] of ring) {
		if ((y1 > point.lat) !== (y2 > point.lat) && point.lon < x1 + (point.lat - y1) * (x2 - x1) / (y2 - y1)) inside = !inside;
		[x1, y1] = [x2, y2];
	}
	return inside;
}

function coverage(value: unknown): (point: Point) => boolean {
	const rings = features(value).flatMap((entry) => {
		const { geometry, properties } = object(entry);
		if (object(properties).level !== "NoData") throw new Error("Unexpected JMA coverage level");
		const { type, coordinates: shape } = object(geometry);
		const polygons = type === "Polygon" ? [shape] : type === "MultiPolygon" ? shape : undefined;
		if (!Array.isArray(polygons)) throw new Error("Unexpected JMA coverage geometry");
		return polygons.map((polygon: unknown) => {
			if (!Array.isArray(polygon) || polygon.length === 0) throw new Error("Unexpected JMA polygon");
			return polygon.map((ring: unknown) => {
				if (!Array.isArray(ring) || ring.length < 3) throw new Error("Unexpected JMA polygon ring");
				return ring.map(coordinates);
			});
		});
	});
	return (point) => {
		// JMA draws the enclosing coverage polygon in longitudes -45 through 315.
		const location = point.lon < -45 ? { ...point, lon: point.lon + 360 } : point;
		return rings.some(([outer, ...holes]) => outer !== undefined && inRing(location, outer) && !holes.some((hole) => inRing(location, hole)));
	};
}

function amountGrid(member: string) {
	// The viewer's numeric overlay uses an approximately 5 km grid even for the first six hours.
	const lonStep = 0.0625;
	const latStep = member === "immed" ? 0.049998 : 0.05;
	const x = (lon: number) => (lon - 118.03125) / lonStep;
	const y = (lat: number) => (47.975 - lat) / latStep;
	return { x, y, lon: (col: number) => 118.03125 + col * lonStep, lat: (row: number) => 47.975 - row * latStep };
}

function amounts(value: unknown, member: string): (col: number, row: number) => number {
	const grid = amountGrid(member);
	const values = new Map<string, number>();
	for (const entry of features(value)) {
		const { geometry, properties } = object(entry);
		const shape = object(geometry);
		if (shape.type !== "Point") throw new Error("Unexpected JMA rain grid point");
		const [lon, lat] = coordinates(shape.coordinates);
		const raw = object(properties).value;
		const mm = typeof raw === "number" || (typeof raw === "string" && raw.trim() !== "") ? Number(raw) : NaN;
		if (!Number.isFinite(mm) || mm < 0) throw new Error("Unexpected JMA rain amount");
		const col = Math.round(grid.x(lon));
		const row = Math.round(grid.y(lat));
		if (Math.abs(lon - grid.lon(col)) > 0.00001 || Math.abs(lat - grid.lat(row)) > 0.00001) throw new Error("Unexpected JMA rain grid");
		values.set(`${col},${row}`, mm);
	}
	return (col, row) => values.get(`${col},${row}`) ?? 0;
}

const world = TILE_SIZE * 2 ** ZOOM;
const pixels = {
	x: (lon: number) => (lon + 180) / 360 * world,
	y: (lat: number) => (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * world,
	lon: (col: number) => col / world * 360 - 180,
	lat: (row: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * row / world))) * 180 / Math.PI,
};

function tile(col: number, row: number) {
	return { path: `${ZOOM}/${Math.floor(col / TILE_SIZE)}/${Math.floor(row / TILE_SIZE)}.png`, offset: ((row % TILE_SIZE) * TILE_SIZE + (col % TILE_SIZE)) * 4 };
}

async function decodePng(png: Buffer): Promise<Buffer> {
	if (png.length < 24 || png.length > 300_000 || !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.readUInt32BE(16) !== TILE_SIZE || png.readUInt32BE(20) !== TILE_SIZE) throw new Error("Unexpected JMA tile");
	const rgba = await ffmpeg(["-f", "png_pipe", "-c:v", "png", "-i", "pipe:0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], png);
	if (rgba.length !== TILE_SIZE ** 2 * 4) throw new Error("Unexpected JMA tile size");
	return rgba;
}

function intensity(rgba: Buffer, offset: number): Reading {
	const [r, g, b, alpha] = rgba.subarray(offset, offset + 4);
	if (alpha === 0) return { kind: "clear" };
	const band = INTENSITIES.get(`${r},${g},${b}`);
	return alpha === 255 && band !== undefined ? { kind: "intensity", band } : { kind: "unknown" };
}

function newest(items: readonly Frame[]): Frame[] {
	const latest = Math.max(...items.map((item) => item.base));
	return items.filter((item) => item.base === latest);
}

export type RainGridQuery = RainQuery & { sizeMeters: number };
type Bounds = { west: number; south: number; east: number; north: number };
type Grid = { id: string; longitudeEdges: number[]; latitudeEdges: number[] };
type GridFrame = { gridId: string; baseAt: string; validAt: string; startAt?: string } & (
	{ status: "available"; rows: (number | null)[][] } | { status: "unavailable" }
);

function client(fetchRain: typeof fetch) {
	const get = async (path: string) => {
		const response = await fetchRain(`${ROOT}/${path}`, { signal: AbortSignal.timeout(15_000), redirect: "error" });
		if (!response.ok) throw new Error(`JMA rain: HTTP ${response.status}`);
		return response;
	};
	const json = async (path: string): Promise<unknown> => (await get(path)).json();
	const index = async (path: string) => frames(await json(path));
	const geo = (root: string, layer: string) => json(`${root}/${layer}/data.geojson?id=${layer}`);

	const select = async (nowcast: boolean) => {
		let selected: Frame[];
		if (nowcast) {
			const [analyses, forecasts] = await Promise.all([index("nowc/targetTimes_N1.json"), index("nowc/targetTimes_N2.json")]);
			const candidates = newest(forecasts.filter((f) => f.elements.includes("hrpns") && f.valid > f.base && f.valid <= f.base + 60 * MINUTE));
			const base = candidates[0]?.base;
			const observed = analyses.filter((f) => f.elements.includes("hrpns") && f.base === f.valid && (base === undefined || f.base === base));
			selected = [...newest(observed), ...candidates];
		} else {
			const forecast = (await index("rasrf/targetTimes.json")).filter((f) => f.elements.includes("rasrf_point"));
			const near = newest(forecast.filter((f) => f.member === "immed" && f.valid > f.base && f.valid <= f.base + 360 * MINUTE));
			const far = newest(forecast.filter((f) => f.member === "none" && f.valid >= f.base + 420 * MINUTE && f.valid <= f.base + 900 * MINUTE));
			selected = [...near, ...far];
		}
		return selected.sort((a, b) => a.valid - b.valid || b.base - a.base);
	};
	const rootOf = ({ basetime, validtime, member }: Frame, nowcast: boolean) => `${nowcast ? "nowc" : "rasrf"}/${basetime}/${member}/${validtime}/surf`;
	const readCoverage = async (frame: Frame, nowcast: boolean) => {
		const layer = nowcast ? "hrpns_nd" : "rasrf_nd";
		if (!frame.elements.includes(layer)) throw new Error("JMA rain: missing coverage layer");
		return coverage(await geo(rootOf(frame, nowcast), layer));
	};
	const readTile = async (root: string, path: string) => decodePng(Buffer.from(await (await get(`${root}/hrpns/${path}`)).arrayBuffer()));
	return { select, rootOf, geo, readCoverage, readTile };
}

function validatePoint({ lat, lon }: Point) {
	if (!Number.isFinite(lat) || Math.abs(lat) >= 85 || !Number.isFinite(lon) || lon < -180 || lon >= 180) throw new Error("日本周辺の確認済みの緯度・経度を指定してください。");
}

async function inBatches<T, U>(items: readonly T[], read: (item: T) => Promise<U>): Promise<U[]> {
	const result: U[] = [];
	for (let i = 0; i < items.length; i += 4) result.push(...await Promise.all(items.slice(i, i + 4).map(read)));
	return result;
}

export function jmaRain(fetchRain = fetch): RainSource {
	const { select, rootOf, geo, readCoverage, readTile } = client(fetchRain);
	return async (query) => {
		validatePoint(query);
		const point = { lat: query.lat, lon: query.lon };
		const nowcast = query.horizon === "1h";
		const ordered = await select(nowcast);
		const location = nowcast ? tile(Math.floor(pixels.x(point.lon)), Math.floor(pixels.y(point.lat))) : undefined;
		const readReading = async (frame: Frame): Promise<Reading> => {
			const { member } = frame;
			const root = rootOf(frame, nowcast);
			try {
				const missing = await readCoverage(frame, nowcast);
				if (missing(point)) return { kind: "no-data" };
				if (location !== undefined) return intensity(await readTile(root, location.path), location.offset);
				const grid = amountGrid(member);
				return { kind: "amount", mm: amounts(await geo(root, "rasrf_point"), member)(Math.round(grid.x(point.lon)), Math.round(grid.y(point.lat))) };
			} catch {
				return { kind: "unknown" };
			}
		};
		const read = async (frame: Frame): Promise<Sample> => ({
			base: frame.base,
			valid: frame.valid,
			reading: await readReading(frame),
		});
		return inBatches(ordered, read);
	};
}

function square({ lat, lon, sizeMeters }: RainGridQuery): Bounds {
	const dy = sizeMeters / 2 / 6378137 * 180 / Math.PI;
	const dx = dy / Math.cos(lat * Math.PI / 180);
	const bounds = { west: lon - dx, east: lon + dx, south: lat - dy, north: lat + dy };
	if (bounds.west < -180 || bounds.east > 180 || bounds.south < -85 || bounds.north > 85) throw new Error("指定範囲が対応範囲を超えています。");
	return bounds;
}

function gridFor(id: string, bounds: Bounds, projection: typeof pixels, centerOffset: number) {
	const edges = (start: number, end: number, coordinate: (index: number) => number) => {
		const first = Math.floor(start + centerOffset);
		return { first, values: Array.from({ length: Math.max(first + 1, Math.ceil(end + centerOffset)) - first + 1 }, (_, i) => coordinate(first + i - centerOffset)) };
	};
	const x = edges(projection.x(bounds.west), projection.x(bounds.east), projection.lon);
	const y = edges(projection.y(bounds.north), projection.y(bounds.south), projection.lat);
	const grid: Grid = { id, longitudeEdges: x.values, latitudeEdges: y.values };
	const cells = Array.from({ length: y.values.length - 1 }, (_, j) => Array.from({ length: x.values.length - 1 }, (_, i) => {
		const col = x.first + i;
		const row = y.first + j;
		return { col, row, lon: projection.lon(col + 0.5 - centerOffset), lat: projection.lat(row + 0.5 - centerOffset) };
	}));
	return { grid, cells };
}

const BIN_SIZE = 2;
const nowcastBins = {
	x: (lon: number) => pixels.x(lon) / BIN_SIZE,
	y: (lat: number) => pixels.y(lat) / BIN_SIZE,
	lon: (col: number) => pixels.lon(col * BIN_SIZE),
	lat: (row: number) => pixels.lat(row * BIN_SIZE),
};

const inJst = (ms: number) => new Date(ms + 9 * 60 * MINUTE).toISOString().replace(".000Z", "+09:00");
const bands = [...new Set(INTENSITIES.values())];

async function readNowcastBins(
	layout: ReturnType<typeof gridFor>, bounds: Bounds, missing: (point: Point) => boolean, readTile: (path: string) => Promise<Buffer>,
) {
	const west = Math.floor(pixels.x(bounds.west));
	const east = Math.ceil(pixels.x(bounds.east));
	const north = Math.floor(pixels.y(bounds.north));
	const south = Math.ceil(pixels.y(bounds.south));
	const paths = new Set<string>();
	const bins = layout.cells.map((row) => row.map((bin) => {
		const locations: (ReturnType<typeof tile> | null)[] = [];
		for (let y = Math.max(north, bin.row * BIN_SIZE); y < Math.min(south, (bin.row + 1) * BIN_SIZE); y++) {
			for (let x = Math.max(west, bin.col * BIN_SIZE); x < Math.min(east, (bin.col + 1) * BIN_SIZE); x++) {
				const location = missing({ lat: pixels.lat(y + 0.5), lon: pixels.lon(x + 0.5) }) ? null : tile(x, y);
				if (location !== null) paths.add(location.path);
				locations.push(location);
			}
		}
		return locations;
	}));
	const tiles = new Map(await inBatches([...paths], async (path) => [path, await readTile(path).catch(() => undefined)] as const));
	if (tiles.size > 0 && ![...tiles.values()].some((tile) => tile !== undefined)) return undefined;
	return bins.map((row) => row.map((locations) => {
		let max = -1;
		let known = 0;
		for (const location of locations) {
			if (location === null) continue;
			const rgba = tiles.get(location.path);
			if (rgba === undefined) continue;
			const reading = intensity(rgba, location.offset);
			if (reading.kind !== "clear" && reading.kind !== "intensity") continue;
			known++;
			max = Math.max(max, reading.kind === "intensity" ? bands.indexOf(reading.band) + 1 : 0);
		}
		return max > 0 || (max === 0 && known === locations.length) ? max : null;
	}));
}

export function jmaRainGrid(fetchRain = fetch) {
	const { select, rootOf, geo, readCoverage, readTile } = client(fetchRain);
	return async (query: RainGridQuery) => {
		validatePoint(query);
		if (!Number.isInteger(query.sizeMeters) || query.sizeMeters < 1 || query.sizeMeters > 10_000) throw new Error("一辺は1〜10000 mの整数で指定してください。");
		const bounds = square(query);
		const nowcast = query.horizon === "1h";
		const selected = await select(nowcast);
		const layouts = new Map<string, ReturnType<typeof gridFor>>();
		const prepared = selected.map((frame) => {
			const id = nowcast ? "pixelBins" : frame.member;
			const layout = layouts.get(id) ?? gridFor(id, bounds, nowcast ? nowcastBins : amountGrid(frame.member), nowcast ? 0 : 0.5);
			layouts.set(id, layout);
			return { frame, layout };
		});
		const frames = await inBatches(prepared, async ({ frame, layout }): Promise<GridFrame> => {
			const times = { gridId: layout.grid.id, baseAt: inJst(frame.base), validAt: inJst(frame.valid), ...(!nowcast && { startAt: inJst(frame.valid - 60 * MINUTE) }) };
			const unavailable = { ...times, status: "unavailable" as const };
			const root = rootOf(frame, nowcast);
			try {
				const missing = await readCoverage(frame, nowcast);
				if (nowcast) {
					const rows = await readNowcastBins(layout, bounds, missing, (path) => readTile(root, path));
					return rows === undefined ? unavailable : { ...times, status: "available", rows };
				}
				const covered = layout.cells.map((row) => row.map((cell) => missing(cell) ? null : cell));
				const read = covered.some((row) => row.some((cell) => cell !== null)) ? amounts(await geo(root, "rasrf_point"), frame.member) : () => null;
				const rows = covered.map((row) => row.map((cell) => cell === null ? null : read(cell.col, cell.row)));
				return { ...times, status: "available", rows };
			} catch {
				return unavailable;
			}
		});
		return { bounds, grids: [...layouts.values()].map(({ grid }) => grid), frames, ...(nowcast
			? { cellType: "intensityBand", unit: "mm/h", legend: ["降水なし", ...bands] }
			: { cellType: "hourlyAmount", unit: "mm" }) };
	};
}

export function formatRain(samples: readonly Sample[], query: RainQuery): string {
	if (samples.length === 0) return "気象庁の降水データに利用できる時刻が見つかりませんでした。";
	const date = new Intl.DateTimeFormat("ja-JP", { timeZone: JMA_TIME_ZONE, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
	const clock = new Intl.DateTimeFormat("ja-JP", { timeZone: JMA_TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
	const relativeTime = (time: number, reference: number) => dateOf(time, JMA_TIME_ZONE) === dateOf(reference, JMA_TIME_ZONE) ? clock.format(time) : date.format(time);
	const nowcast = query.horizon === "1h";
	const groups = new Map<number, string[]>();
	for (const { base, valid, reading } of samples) {
		const start = valid - 60 * MINUTE;
		const period = nowcast ? `${relativeTime(valid, base)}${valid === base ? "（実況）" : ""}` : `${date.format(start)}〜${relativeTime(valid, start)}`;
		const value = reading.kind === "intensity" ? reading.band : reading.kind === "amount" ? String(reading.mm) : reading.kind === "clear" ? "降水表示なし" : reading.kind === "no-data" ? "欠測" : "不明（取得・判定できず）";
		const lines = groups.get(base) ?? [];
		lines.push(`- ${period}：${value}`);
		groups.set(base, lines);
	}
	const title = nowcast ? "降水強度（mm/h・日本時間）" : "1時間降水量（mm・日本時間、約5 km格子）";
	const header = `気象庁｜${title}｜緯度 ${query.lat}、経度 ${query.lon}`;
	return [header, ...[...groups].map(([base, lines]) => [`基準 ${date.format(base)}`, ...lines].join("\n"))].join("\n\n");
}
