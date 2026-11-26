import { ffmpeg } from "./ffmpeg.ts";

export type Point = { lat: number; lon: number };
export type Cell = Point & { col: number; row: number };
export type Frame = { basetime: string; validtime: string; member: string; base: number; valid: number; elements: string[] };
type JsonObject = Record<string, unknown>;
export type Bounds = { west: number; south: number; east: number; north: number };
type Grid = { id: string; longitudeEdges: number[]; latitudeEdges: number[] };

type Projection = Record<"x" | "y" | "lon" | "lat", (value: number) => number>;

const TILE_SIZE = 256;
const ZOOM = 10;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const WORLD_PIXELS = TILE_SIZE * 2 ** ZOOM;

export const JMA_5KM_MESH: Projection = {
	x: (lon: number) => lon * 16,
	y: (lat: number) => -lat * 20,
	lon: (col: number) => col / 16,
	lat: (row: number) => -row / 20,
};

export function meshCell(point: Point, projection = JMA_5KM_MESH): Cell {
	const col = Math.floor(projection.x(point.lon));
	const row = Math.floor(projection.y(point.lat));
	return { col, row, lon: projection.lon(col + 0.5), lat: projection.lat(row + 0.5) };
}

export const mercatorPixels: Projection = {
	x: (lon: number) => (lon + 180) / 360 * WORLD_PIXELS,
	y: (lat: number) => (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * WORLD_PIXELS,
	lon: (col: number) => col / WORLD_PIXELS * 360 - 180,
	lat: (row: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * row / WORLD_PIXELS))) * 180 / Math.PI,
};

export function tileAt(col: number, row: number) {
	return {
		path: `${ZOOM}/${Math.floor(col / TILE_SIZE)}/${Math.floor(row / TILE_SIZE)}.png`,
		offset: ((row % TILE_SIZE) * TILE_SIZE + (col % TILE_SIZE)) * 4,
	};
}

export function tileOf(point: Point) {
	return tileAt(Math.floor(mercatorPixels.x(point.lon)), Math.floor(mercatorPixels.y(point.lat)));
}

export async function decodePngTile(png: Buffer): Promise<Buffer> {
	if (png.length < 24 || png.length > 300_000 || !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.readUInt32BE(16) !== TILE_SIZE || png.readUInt32BE(20) !== TILE_SIZE) {
		throw new Error("Unexpected JMA tile");
	}
	const rgba = await ffmpeg(["-f", "png_pipe", "-c:v", "png", "-i", "pipe:0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], png);
	if (rgba.length !== TILE_SIZE ** 2 * 4) throw new Error("Unexpected JMA tile size");
	return rgba;
}

export function object(value: unknown): JsonObject {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Unexpected JMA object");
	return value as JsonObject;
}

function time(value: string): number {
	const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value);
	if (m === null) return NaN;
	return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
}

export function frames(value: unknown): Frame[] {
	if (!Array.isArray(value)) throw new Error("Unexpected JMA time list");
	return value.flatMap((entry: unknown) => {
		const { basetime, validtime, member = "none", elements } = object(entry);
		if (typeof basetime !== "string" || typeof validtime !== "string" || (member !== "none" && member !== "immed") || !Array.isArray(elements)) return [];
		const base = time(basetime);
		const valid = time(validtime);
		return Number.isFinite(base) && Number.isFinite(valid) ? [{ basetime, validtime, member, base, valid, elements: elements.filter((item): item is string => typeof item === "string") }] : [];
	});
}

export function features(value: unknown): unknown[] {
	const { type, features } = object(value);
	if (type !== "FeatureCollection" || !Array.isArray(features)) throw new Error("Unexpected JMA GeoJSON");
	return features;
}

export function coordinates(value: unknown): [number, number] {
	if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isFinite)) throw new Error("Unexpected JMA coordinates");
	return [value[0], value[1]];
}

export function inRing(point: Point, ring: [number, number][]): boolean {
	let [x1, y1] = ring[ring.length - 1]!;
	let inside = false;
	for (const [x2, y2] of ring) {
		if ((y1 > point.lat) !== (y2 > point.lat) && point.lon < x1 + (point.lat - y1) * (x2 - x1) / (y2 - y1)) inside = !inside;
		[x1, y1] = [x2, y2];
	}
	return inside;
}

function polygonContains(value: unknown, mask: boolean): ((point: Point) => boolean) | undefined {
	if (!Array.isArray(value)) throw new Error("Unexpected JMA polygon");
	if (value.length === 0) return undefined;
	const rings = value.map((ring: unknown) => {
		if (!Array.isArray(ring) || ring.length < 4) throw new Error("Unexpected JMA polygon ring");
		const coords = ring.map(coordinates);
		const [x0, y0] = coords[0]!;
		let [prevX, prevY] = [x0, y0];
		let area = 0;
		let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
		for (const [lon, lat] of coords) {
			area += (prevX - x0) * (lat - y0) - (lon - x0) * (prevY - y0);
			[prevX, prevY] = [lon, lat];
			west = Math.min(west, lon);
			east = Math.max(east, lon);
			south = Math.min(south, lat);
			north = Math.max(north, lat);
		}
		return { coords, west, east, south, north, area };
	});
	if (mask && !rings.some(({ area }) => Math.abs(area) >= 1e-10)) return undefined;
	// JMA puts disjoint exteriors alongside holes, and can leave the exterior ring open.
	return (point) => rings.reduce((inside, { coords, west, east, south, north }) =>
		point.lon >= west && point.lon < east && point.lat >= south && point.lat < north && inRing(point, coords) ? !inside : inside, false);
}

export function jmaPolygons(geometry: unknown, mask = false) {
	const { type, coordinates: shape } = object(geometry);
	if (type !== "Polygon" && (type !== "MultiPolygon" || !Array.isArray(shape))) throw new Error("Unexpected JMA polygon geometry");
	return (type === "Polygon" ? [shape] : shape as unknown[])
		.map((polygon) => polygonContains(polygon, mask)).filter((contains) => contains !== undefined);
}

export const polygonLocation = (point: Point): Point => point.lon < -45 ? { ...point, lon: point.lon + 360 } : point;

export function missingCoverage(polygons: ((point: Point) => boolean)[], required = true) {
	if (required && polygons.length === 0) throw new Error("Missing JMA forecast coverage mask");
	return (point: Point) => {
		const location = polygonLocation(point);
		return polygons.some((contains) => contains(location));
	};
}

export function noDataMask(value: unknown) {
	return missingCoverage(features(value).flatMap((entry) => {
		const { geometry, properties } = object(entry);
		if (object(properties).level !== "NoData") throw new Error("Unexpected JMA coverage level");
		return jmaPolygons(geometry, true);
	}));
}

export function validatePoint({ lat, lon }: Point) {
	if (!Number.isFinite(lat) || Math.abs(lat) >= 85 || !Number.isFinite(lon) || lon < -180 || lon >= 180) throw new Error("日本周辺の確認済みの緯度・経度を指定してください。");
}

export async function inBatches<T, U>(items: readonly T[], read: (item: T) => Promise<U>): Promise<U[]> {
	const result: U[] = [];
	for (let i = 0; i < items.length; i += 4) result.push(...await Promise.all(items.slice(i, i + 4).map(read)));
	return result;
}

export function square({ lat, lon, sizeMeters }: Point & { sizeMeters: number }, maxMeters?: number): Bounds {
	if (maxMeters !== undefined && (!Number.isInteger(sizeMeters) || sizeMeters < 1 || sizeMeters > maxMeters)) {
		throw new Error(`一辺は1〜${maxMeters} mの整数で指定してください。`);
	}
	const dy = sizeMeters / 2 / 6378137 * 180 / Math.PI;
	const dx = dy / Math.cos(lat * Math.PI / 180);
	const bounds = { west: lon - dx, east: lon + dx, south: lat - dy, north: lat + dy };
	if (bounds.west < -180 || bounds.east > 180 || bounds.south < -85 || bounds.north > 85) throw new Error("指定範囲が対応範囲を超えています。");
	return bounds;
}

export function gridFor(id: string, bounds: Bounds, projection: Projection, centerOffset: number) {
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

export const inJst = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().replace(".000Z", "+09:00");
export const clockJst = (iso: string) => iso.slice(5, 16).replace("T", " ");
