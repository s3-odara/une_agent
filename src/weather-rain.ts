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

function inRing(point: Point, ring: unknown): boolean {
	if (!Array.isArray(ring) || ring.length < 3) throw new Error("Unexpected JMA polygon ring");
	let [x1, y1] = coordinates(ring.at(-1));
	let inside = false;
	for (const vertex of ring) {
		const [x2, y2] = coordinates(vertex);
		if ((y1 > point.lat) !== (y2 > point.lat) && point.lon < x1 + (point.lat - y1) * (x2 - x1) / (y2 - y1)) inside = !inside;
		[x1, y1] = [x2, y2];
	}
	return inside;
}

function noData(value: unknown, point: Point): boolean {
	// JMA draws the enclosing coverage polygon in longitudes -45 through 315.
	const location = point.lon < -45 ? { ...point, lon: point.lon + 360 } : point;
	return features(value).map((entry) => {
		const { geometry, properties } = object(entry);
		if (object(properties).level !== "NoData") throw new Error("Unexpected JMA coverage level");
		const { type, coordinates } = object(geometry);
		const polygons = type === "Polygon" ? [coordinates] : type === "MultiPolygon" ? coordinates : undefined;
		if (!Array.isArray(polygons)) throw new Error("Unexpected JMA coverage geometry");
		return polygons.map((polygon: unknown) => {
			if (!Array.isArray(polygon) || polygon.length === 0) throw new Error("Unexpected JMA polygon");
			const [inside, ...holes] = polygon.map((ring) => inRing(location, ring));
			return inside && !holes.includes(true);
		}).includes(true);
	}).includes(true);
}

function amountAt(value: unknown, point: Point, member: string): number {
	// The viewer's numeric overlay uses an approximately 5 km grid even for the first six hours.
	const lonStep = 0.0625;
	const latStep = member === "immed" ? 0.049998 : 0.05;
	const column = (lon: number) => Math.round((lon - 118.03125) / lonStep);
	const row = (lat: number) => Math.round((47.975 - lat) / latStep);
	let amount = 0;
	for (const entry of features(value)) {
		const { geometry, properties } = object(entry);
		const shape = object(geometry);
		if (shape.type !== "Point") throw new Error("Unexpected JMA rain grid point");
		const [lon, lat] = coordinates(shape.coordinates);
		const raw = object(properties).value;
		const mm = typeof raw === "number" || (typeof raw === "string" && raw.trim() !== "") ? Number(raw) : NaN;
		if (!Number.isFinite(mm) || mm < 0) throw new Error("Unexpected JMA rain amount");
		if (Math.abs(lon - (118.03125 + column(lon) * lonStep)) > 0.00001 || Math.abs(lat - (47.975 - row(lat) * latStep)) > 0.00001) throw new Error("Unexpected JMA rain grid");
		if (column(lon) === column(point.lon) && row(lat) === row(point.lat)) amount = mm;
	}
	return amount;
}

function tile(point: Point) {
	const world = TILE_SIZE * 2 ** ZOOM;
	const x = Math.floor((point.lon + 180) / 360 * world);
	const y = Math.floor((1 - Math.asinh(Math.tan(point.lat * Math.PI / 180)) / Math.PI) / 2 * world);
	return { path: `${ZOOM}/${Math.floor(x / TILE_SIZE)}/${Math.floor(y / TILE_SIZE)}.png`, offset: ((y % TILE_SIZE) * TILE_SIZE + (x % TILE_SIZE)) * 4 };
}

async function intensity(png: Buffer, offset: number): Promise<Reading> {
	if (png.length < 24 || png.length > 300_000 || !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.readUInt32BE(16) !== TILE_SIZE || png.readUInt32BE(20) !== TILE_SIZE) return { kind: "unknown" };
	const rgba = await ffmpeg(["-f", "png_pipe", "-c:v", "png", "-i", "pipe:0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], png);
	if (rgba.length !== TILE_SIZE ** 2 * 4) return { kind: "unknown" };
	const [r, g, b, alpha] = rgba.subarray(offset, offset + 4);
	if (alpha === 0) return { kind: "clear" };
	const band = INTENSITIES.get(`${r},${g},${b}`);
	return alpha === 255 && band !== undefined ? { kind: "intensity", band } : { kind: "unknown" };
}

function newest(items: readonly Frame[]): Frame[] {
	const latest = Math.max(...items.map((item) => item.base));
	return items.filter((item) => item.base === latest);
}

export function jmaRain(fetchRain = fetch): RainSource {
	const get = async (path: string) => {
		const response = await fetchRain(`${ROOT}/${path}`, { signal: AbortSignal.timeout(15_000), redirect: "error" });
		if (!response.ok) throw new Error(`JMA rain: HTTP ${response.status}`);
		return response;
	};
	const json = async (path: string): Promise<unknown> => (await get(path)).json();
	const index = async (path: string) => frames(await json(path));
	const geo = (root: string, layer: string) => json(`${root}/${layer}/data.geojson?id=${layer}`);

	return async (query) => {
		if (!Number.isFinite(query.lat) || Math.abs(query.lat) >= 85 || !Number.isFinite(query.lon) || query.lon < -180 || query.lon >= 180) throw new Error("日本周辺の確認済みの緯度・経度を指定してください。");
		const point = { lat: query.lat, lon: query.lon };
		const nowcast = query.horizon === "1h";
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
		const samples: Sample[] = [];
		const ordered = selected.sort((a, b) => a.valid - b.valid || b.base - a.base);
		const location = nowcast ? tile(point) : undefined;
		const readReading = async ({ basetime, validtime, member, elements }: Frame): Promise<Reading> => {
			const layer = nowcast ? "hrpns" : "rasrf";
			const root = `${nowcast ? "nowc" : "rasrf"}/${basetime}/${member}/${validtime}/surf`;
			try {
				if (!elements.includes(`${layer}_nd`)) return { kind: "unknown" };
				if (noData(await geo(root, `${layer}_nd`), point)) return { kind: "no-data" };
				if (location !== undefined) {
					const response = await get(`${root}/${layer}/${location.path}`);
					return await intensity(Buffer.from(await response.arrayBuffer()), location.offset);
				}
				return { kind: "amount", mm: amountAt(await geo(root, "rasrf_point"), point, member) };
			} catch {
				return { kind: "unknown" };
			}
		};
		const read = async (frame: Frame): Promise<Sample> => ({
			base: frame.base,
			valid: frame.valid,
			reading: await readReading(frame),
		});
		for (let i = 0; i < ordered.length; i += 4) samples.push(...await Promise.all(ordered.slice(i, i + 4).map(read)));
		return samples;
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
