import { coordinates, decodePngTile, features, frames, gridFor, inBatches, inJst, inRing, mercatorPixels, noDataMask, object, square, tileAt, tileOf, validatePoint, type Bounds, type Frame, type Point } from "./jma-grid.ts";
import { dateOf } from "./time.ts";
import { JMA_TIME_ZONE } from "./weather-areas.ts";

export const RAIN_HORIZONS = ["1h", "15h"] as const;
export type RainQuery = { lat: number; lon: number; horizon: (typeof RAIN_HORIZONS)[number] };
type Reading = { kind: "intensity"; band: string } | { kind: "amount"; mm: number } | { kind: "clear" | "no-data" | "unknown" };
type Sample = { base: number; valid: number; reading: Reading };
export type RainSource = (query: RainQuery) => Promise<readonly Sample[]>;

const ROOT = "https://www.jma.go.jp/bosai/jmatile/data";
const MINUTE = 60_000;
const INTENSITIES = new Map([
	["242,242,255", "1未満"], ["160,210,255", "1以上5未満"], ["33,140,255", "5以上10未満"], ["0,65,255", "10以上20未満"],
	["250,245,0", "20以上30未満"], ["255,245,0", "20以上30未満"], ["255,153,0", "30以上50未満"], ["255,40,0", "50以上80未満"], ["180,0,104", "80以上"],
]);

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
		const data = await geo(rootOf(frame, nowcast), layer);
		return nowcast ? coverage(data) : noDataMask(data);
	};
	const readTile = async (root: string, path: string) => decodePngTile(Buffer.from(await (await get(`${root}/hrpns/${path}`)).arrayBuffer()));
	return { select, rootOf, geo, readCoverage, readTile };
}

export function jmaRain(fetchRain = fetch): RainSource {
	const { select, rootOf, geo, readCoverage, readTile } = client(fetchRain);
	return async (query) => {
		validatePoint(query);
		const point = { lat: query.lat, lon: query.lon };
		const nowcast = query.horizon === "1h";
		const ordered = await select(nowcast);
		const location = nowcast ? tileOf(point) : undefined;
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

const BIN_SIZE = 2;
const nowcastBins = {
	x: (lon: number) => mercatorPixels.x(lon) / BIN_SIZE,
	y: (lat: number) => mercatorPixels.y(lat) / BIN_SIZE,
	lon: (col: number) => mercatorPixels.lon(col * BIN_SIZE),
	lat: (row: number) => mercatorPixels.lat(row * BIN_SIZE),
};

const bands = [...new Set(INTENSITIES.values())];

async function readNowcastBins(
	layout: ReturnType<typeof gridFor>, bounds: Bounds, missing: (point: Point) => boolean, readTile: (path: string) => Promise<Buffer>,
) {
	const west = Math.floor(mercatorPixels.x(bounds.west));
	const east = Math.ceil(mercatorPixels.x(bounds.east));
	const north = Math.floor(mercatorPixels.y(bounds.north));
	const south = Math.ceil(mercatorPixels.y(bounds.south));
	const paths = new Set<string>();
	const bins = layout.cells.map((row) => row.map((bin) => {
		const locations: (ReturnType<typeof tileAt> | null)[] = [];
		for (let y = Math.max(north, bin.row * BIN_SIZE); y < Math.min(south, (bin.row + 1) * BIN_SIZE); y++) {
			for (let x = Math.max(west, bin.col * BIN_SIZE); x < Math.min(east, (bin.col + 1) * BIN_SIZE); x++) {
				const location = missing({ lat: mercatorPixels.lat(y + 0.5), lon: mercatorPixels.lon(x + 0.5) }) ? null : tileAt(x, y);
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
		const bounds = square(query, 10_000);
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
