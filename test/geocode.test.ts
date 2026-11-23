import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createGeocodeExtension, lookupPlace } from "../src/geocode.ts";
import { agentEnv } from "./env.ts";
import { call, message, noting, type ToolResult } from "./fakes.ts";

function fixture(dir: string): string {
	const towns = join(dir, "towns.csv");
	writeFileSync(towns, [
		"都道府県名,市区町村コード,市区町村名,大字町丁目名,緯度,経度",
		"北海道,01101,札幌市中央区,大通西一丁目,43.06,141.35",
		"北海道,01101,札幌市中央区,大通西二丁目,43.061,141.353",
		"北海道,01204,旭川市,大通西二丁目,43.77,142.36",
		"北海道,01101,札幌市中央区,架空町,43.065,141.36",
		"北海道,01101,札幌市中央区,架空町二丁目,43.067,141.362",
	].join("\n"));
	const offices = join(dir, "offices.geojson");
	const office = (classification: string, name: string, lon: number) => ({
		properties: { P05_001: "01101", P05_002: classification, P05_003: name, P05_004: "札幌市中央区" },
		geometry: { type: "Point", coordinates: [lon, 43.06] },
	});
	writeFileSync(offices, JSON.stringify({ features: [office("1", "札幌市役所", 141.351), office("1", "札幌市中央区役所", 141.352), office("2", "札幌市南支所", 141.3)] }));
	const facilities = join(dir, "facilities.geojsonseq");
	writeFileSync(facilities, [
		{ properties: { leisure: "park", name: "架空公園", alt_name: "中央公園;テスト公園", "addr:city": "札幌市" }, geometry: { type: "Polygon", coordinates: [[[141, 43], [141.25, 43], [141.25, 43.25], [141, 43.25], [141, 43]]] } },
		{ properties: { leisure: "park", name: "架空公園", "addr:city": "旭川市" }, geometry: { type: "Point", coordinates: [142.36, 43.77] } },
		...Array.from({ length: 25 }, (_, i) => ({ properties: { amenity: "community_centre", name: "市民会館", "addr:full": `京都府京都市架空町${i}` }, geometry: { type: "Point", coordinates: [135.7, 35.01 + i / 1000] } })),
		{ properties: { amenity: "community_centre", name: "試験会館" }, geometry: { type: "Point", coordinates: [139.49, 35.66] } },
		{ properties: { highway: "residential", name: "架空通り" }, geometry: { type: "Point", coordinates: [141.2, 43.06] } },
		{ properties: { natural: "peak", name: "試験山" }, geometry: { type: "Point", coordinates: [138.474, 36.406] } },
		{ properties: { railway: "halt", name: "試験駅" }, geometry: { type: "Point", coordinates: [138.46, 36.38] } },
		{ properties: { railway: "halt", name: "北試験" }, geometry: { type: "Point", coordinates: [138.48, 36.39] } },
		{ properties: { highway: "traffic_signals", name: "試験交差点" }, geometry: { type: "Point", coordinates: [138.47, 36.38] } },
		{ properties: { place: "square", name: "試験広場" }, geometry: { type: "Polygon", coordinates: [[[138, 36], [138.25, 36], [138.25, 36.25], [138, 36.25], [138, 36]]] } },
		{ properties: { natural: "wood", name: "試験林" }, geometry: { type: "Polygon", coordinates: [[[138, 36], [138.25, 36], [138.25, 36.25], [138, 36.25], [138, 36]]] } },
		{ properties: { railway: "station", name: "西試験駅" }, geometry: { type: "LineString", coordinates: [[141, 43], [141.002, 43.001], [141.004, 43.002]] } },
		{ properties: { waterway: "dam", name: "試験東ダム" }, geometry: { type: "MultiLineString", coordinates: [[[138.4, 36.3], [138.41, 36.31], [138.42, 36.32]], [[138.41, 36.31], [138.412, 36.312]]] } },
	].map((feature) => `\x1e${JSON.stringify(feature)}\n`).join(""));
	const path = join(dir, "geocode.sqlite");
	execFileSync("python3", [fileURLToPath(new URL("../scripts/build-geocode.py", import.meta.url)), "--offices", offices, "--towns", towns, "--osm", facilities, "--output", path], { stdio: "pipe" });
	return path;
}

test("geocode returns town coordinates for full and abbreviated addresses", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "agent-geocode-"));
	t.after(() => rmSync(dir, { force: true, recursive: true }));
	const path = fixture(dir);
	for (const [query, rows] of [
		["札幌市中央区大通西二丁目3番5号", [[141.353, "3番5号"], [142.36, "3番5号"]]],
		["札幌市中央区大通西２－３－５", [[141.353, "3-5"], [142.36, "3-5"]]],
		["札幌市中央区架空町12-3番地", [[141.36, "12-3番地"]]],
		["札幌市中央区架空町2-4-5", [[141.362, "4-5"]]],
	] as const) {
		const { candidates } = lookupPlace(path, query);
		assert.deepEqual(candidates.map(({ kind, lon, unmatched }) => [kind, lon, unmatched]),
			rows.map(([lon, tail]) => ["大字・町丁目の代表点", lon, tail]), query);
	}
});

test("named mountains and urban landmarks can be found without a facility tag", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "agent-geocode-"));
	t.after(() => rmSync(dir, { force: true, recursive: true }));
	const path = fixture(dir);

	for (const [name, lon, lat] of [["試験山", 138.474, 36.406], ["試験交差点", 138.47, 36.38]] as const) {
		assert.deepEqual(lookupPlace(path, name).candidates.map(({ lon, lat }) => [lon, lat]), [[lon, lat]], name);
	}
	const [stationNode] = lookupPlace(path, "試験駅").candidates;
	assert.ok(stationNode);
	assert.deepEqual([stationNode.name, stationNode.lon, stationNode.lat], ["試験駅", 138.46, 36.38]);
	const [square] = lookupPlace(path, "試験広場").candidates;
	assert.ok(square);
	assert.ok(square.lon > 138 && square.lon < 138.25);
	assert.ok(square.lat > 36 && square.lat < 36.25);
	assert.deepEqual(lookupPlace(path, "試験林").candidates, []);
});

test("a town name alone returns same-name towns", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "agent-geocode-"));
	t.after(() => rmSync(dir, { force: true, recursive: true }));
	const path = fixture(dir);

	assert.deepEqual(lookupPlace(path, "大通西２丁目").candidates.map(({ address }) => address).sort(), [
		"北海道旭川市大通西二丁目", "北海道札幌市中央区大通西二丁目",
	]);
});

test("geocode distinguishes offices, approximates street addresses, and returns same-name facilities as candidates", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "agent-geocode-"));
	t.after(() => rmSync(dir, { force: true, recursive: true }));
	const path = fixture(dir);

	assert.deepEqual(lookupPlace(path, "北海道札幌市").candidates.map(({ name }) => name).sort(),
		["札幌市役所", "札幌市中央区役所", "北海道札幌市中央区大通西一丁目", "北海道札幌市中央区大通西二丁目", "北海道札幌市中央区架空町", "北海道札幌市中央区架空町二丁目"].sort());
	assert.equal(lookupPlace(path, "北海道札幌市").candidates[0]?.name, "札幌市役所");
	assert.equal(lookupPlace(path, "札幌市中央区").candidates[0]?.name, "札幌市中央区役所");
	assert.deepEqual(lookupPlace(path, "札幌市中央区").candidates.map(({ name }) => name).sort(),
		["札幌市中央区役所", "北海道札幌市中央区大通西一丁目", "北海道札幌市中央区大通西二丁目", "北海道札幌市中央区架空町", "北海道札幌市中央区架空町二丁目"].sort());
	assert.deepEqual(lookupPlace(path, "札幌市南支所").candidates, []);
	const address = lookupPlace(path, "札幌市中央区 大通西２－１");
	assert.deepEqual(address.candidates.map(({ name, lon, kind }) => ({ name, lon, kind })), [
		{ name: "北海道札幌市中央区大通西二丁目", lon: 141.353, kind: "大字・町丁目の代表点" },
		{ name: "北海道旭川市大通西二丁目", lon: 142.36, kind: "大字・町丁目の代表点" },
	]);
	assert.equal(address.candidates[0]?.unmatched, "1");
	assert.equal(lookupPlace(path, "架空通り").candidates.length, 0);
	assert.deepEqual(lookupPlace(path, "架空公園").candidates.map(({ address }) => address).sort(), ["旭川市", "札幌市"]);

	const results: ToolResult[] = [];
	await using env = await agentEnv({ extensions: () => [createGeocodeExtension(path)] });
	env.faux.setResponses([call("geocode", { query: "テスト公園" }), noting(results)]);
	const bridge = env.bridge();
	env.link.emit(message("!a:example.org", "$1", "公園の座標を教えて"));
	await bridge.idle();
	assert.equal(results[0]?.isError, false);
	const { candidates } = JSON.parse(results[0]?.text ?? "");
	assert.equal(candidates.length, 1);
	const [{ name, lat, lon, source }] = candidates;
	assert.equal(name, "架空公園");
	assert.ok(lat > 43 && lat < 43.25 && lon > 141 && lon < 141.25, "the representative point is inside the park");
	assert.equal(source, "© OpenStreetMap contributors (ODbL)");
});

test("a facility without address data can be found by name", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "agent-geocode-"));
	t.after(() => rmSync(dir, { force: true, recursive: true }));
	const path = fixture(dir);
	const { candidates } = lookupPlace(path, "試験会館");
	assert.deepEqual(candidates.map(({ address, lat, lon }) => ({ address, lat, lon })), [
		{ address: "", lat: 35.66, lon: 139.49 },
	]);
});

test("geocode limits results and reports omitted candidates", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "agent-geocode-"));
	t.after(() => rmSync(dir, { force: true, recursive: true }));
	const path = fixture(dir);
	const { candidates, omitted } = lookupPlace(path, "市民会館");
	assert.equal(candidates.length, 20);
	assert.equal(omitted, 5);
});

test("prefix matching fills in when no name matches exactly", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "agent-geocode-"));
	t.after(() => rmSync(dir, { force: true, recursive: true }));
	const path = fixture(dir);
	const { candidates, omitted } = lookupPlace(path, "試験");
	assert.deepEqual(candidates.map(({ name }) => name).sort(),
		["試験交差点", "試験会館", "試験駅", "試験東ダム", "試験山", "試験広場"].sort());
	assert.equal(omitted, undefined);
});

test("prefecture and municipality names are stripped when nothing matches", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "agent-geocode-"));
	t.after(() => rmSync(dir, { force: true, recursive: true }));
	const path = fixture(dir);
	const prefecture = lookupPlace(path, "北海道大通西二丁目");
	assert.deepEqual(prefecture.candidates.map(({ address }) => address).sort(),
		["北海道旭川市大通西二丁目", "北海道札幌市中央区大通西二丁目"]);
	const municipality = lookupPlace(path, "札幌市架空町");
	assert.deepEqual(municipality.candidates.map(({ lon }) => lon), [141.36, 141.362]);
	const station = lookupPlace(path, "北試験駅");
	assert.deepEqual(station.candidates.map(({ lon, lat, name }) => [lon, lat, name]), [[138.48, 36.39, "北試験"]]);
	const park = lookupPlace(path, "架空公園駅");
	assert.deepEqual(park.candidates.map(({ address }) => address).sort(), ["旭川市", "札幌市"]);
});

test("a station drawn as a line can be found near its shape", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "agent-geocode-"));
	t.after(() => rmSync(dir, { force: true, recursive: true }));
	const path = fixture(dir);
	const [station] = lookupPlace(path, "西試験駅").candidates;
	assert.ok(station);
	assert.ok(station.lon > 141 && station.lon < 141.004 && station.lat > 43 && station.lat < 43.002);
	const [dam] = lookupPlace(path, "試験東ダム").candidates;
	assert.ok(dam);
	assert.ok(dam.lon > 138.4 && dam.lon < 138.42 && dam.lat > 36.3 && dam.lat < 36.32);
});
