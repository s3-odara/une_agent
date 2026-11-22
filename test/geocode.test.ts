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

const hallAddresses = [...Array.from({ length: 9 }, (_, i) => `京都府京都市架空町${i}`), "東京都府中市 架空町"];

function fixture(dir: string, blocks = false): string {
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
		...hallAddresses.map((address, i) => ({ properties: { amenity: "community_centre", name: "市民会館", "addr:full": address }, geometry: { type: "Point", coordinates: [135.7, 35.01 + i / 1000] } })),
		{ properties: { amenity: "community_centre", name: "市民会館" }, geometry: { type: "Point", coordinates: [139.49, 35.66] } },
		{ properties: { highway: "residential", name: "架空通り" }, geometry: { type: "Point", coordinates: [141.2, 43.06] } },
	].map((feature) => `\x1e${JSON.stringify(feature)}\n`).join(""));
	const blockArgs = [];
	if (blocks) {
		const csv = join(dir, "blocks.csv");
		writeFileSync(csv, [
			"都道府県名,市区町村名,大字・町丁目名,小字・通称名,街区符号・地番,緯度,経度,代表フラグ,更新後履歴フラグ",
			"北海道,札幌市中央区,大通西二丁目,,3,43.062,141.354,1,0",
			"北海道,札幌市中央区,大通西二丁目,,3,43.063,141.355,0,0",
			"北海道,札幌市中央区,大通西二丁目,,4,43.064,141.356,1,3",
			"北海道,札幌市中央区,架空町,,12-3,43.066,141.361,1,0",
			"北海道,札幌市中央区,架空町,,2-3,43.068,141.363,1,0",
			"北海道,札幌市中央区,架空町,,2-4-5,43.069,141.364,1,0",
			"北海道,札幌市中央区,架空町二丁目,,4,43.07,141.365,1,0",
		].join("\n"));
		const zip = join(dir, "blocks.zip");
		execFileSync("python3", ["-c", "import sys, zipfile; from pathlib import Path\nwith zipfile.ZipFile(sys.argv[1], 'w') as z: z.writestr('blocks.csv', Path(sys.argv[2]).read_text(encoding='utf-8').encode('cp932'))", zip, csv]);
		blockArgs.push("--blocks-dir", dir);
	}
	const path = join(dir, "geocode.sqlite");
	execFileSync("python3", [fileURLToPath(new URL("../scripts/build-geocode.py", import.meta.url)), "--offices", offices, "--towns", towns, ...blockArgs, "--osm", facilities, "--output", path], { stdio: "pipe" });
	return path;
}

test("geocode uses the representative block when it matches, otherwise the town", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "agent-geocode-"));
	t.after(() => rmSync(dir, { force: true, recursive: true }));
	const path = fixture(dir, true);
	for (const address of ["札幌市中央区大通西二丁目3番5号", "札幌市中央区大通西２－３－５"]) {
		const { candidates } = lookupPlace(path, address);
		assert.equal(candidates.length, 1);
		assert.equal(candidates[0]?.kind, "街区・地番の代表点");
		assert.equal(candidates[0]?.source, "街区レベル位置参照情報 国土交通省");
		assert.equal(candidates[0]?.lon, 141.354);
	}
	assert.equal(lookupPlace(path, "札幌市中央区大通西二丁目3番5号").candidates[0]?.unmatched, "5号");
	assert.equal(lookupPlace(path, "札幌市中央区大通西二丁目4番").candidates[0]?.kind, "大字・町丁目の代表点");
	assert.equal(lookupPlace(path, "札幌市中央区架空町12番地").candidates[0]?.kind, "大字・町丁目の代表点");
	assert.equal(lookupPlace(path, "札幌市中央区架空町12-3番地").candidates[0]?.lon, 141.361);
});

test("an abbreviated address considers both block interpretations before falling back to the town", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "agent-geocode-"));
	t.after(() => rmSync(dir, { force: true, recursive: true }));
	const path = fixture(dir, true);

	assert.deepEqual(lookupPlace(path, "札幌市中央区架空町2-3").candidates.map(({ name }) => name), [
		"北海道札幌市中央区架空町2-3番",
	]);
	const ambiguous = lookupPlace(path, "札幌市中央区架空町2-4-5").candidates;
	assert.equal(ambiguous.length, 2);
	assert.deepEqual(new Map(ambiguous.map(({ name, unmatched }) => [name, unmatched])), new Map([
		["北海道札幌市中央区架空町二丁目4番", "5"],
		["北海道札幌市中央区架空町2-4-5番", undefined],
	]));
	assert.deepEqual(lookupPlace(path, "札幌市中央区架空町二丁目4番5号").candidates.map(({ name }) => name), [
		"北海道札幌市中央区架空町二丁目4番",
	]);
});

test("a town name alone returns same-name towns, but area only searches facilities", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "agent-geocode-"));
	t.after(() => rmSync(dir, { force: true, recursive: true }));
	const path = fixture(dir);

	assert.deepEqual(lookupPlace(path, "大通西２丁目").candidates.map(({ address }) => address).sort(), [
		"北海道旭川市大通西二丁目", "北海道札幌市中央区大通西二丁目",
	]);
	assert.deepEqual(lookupPlace(path, "大通西二丁目", "札幌市中央区").candidates, []);
});

test("geocode distinguishes offices, approximates street addresses, and returns same-name facilities as candidates", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "agent-geocode-"));
	t.after(() => rmSync(dir, { force: true, recursive: true }));
	const path = fixture(dir);

	assert.deepEqual(lookupPlace(path, "北海道札幌市").candidates.map(({ name }) => name), ["札幌市役所"]);
	assert.deepEqual(lookupPlace(path, "札幌市中央区").candidates.map(({ name }) => name), ["札幌市中央区役所"]);
	assert.deepEqual(lookupPlace(path, "札幌市南支所").candidates, []);
	const address = lookupPlace(path, "札幌市中央区 大通西２－１");
	assert.deepEqual(address.candidates.map(({ name, lon, kind }) => ({ name, lon, kind })), [
		{ name: "北海道札幌市中央区大通西二丁目", lon: 141.353, kind: "大字・町丁目の代表点" },
	]);
	assert.equal(address.candidates[0]?.unmatched, "1");
	assert.equal(lookupPlace(path, "架空通り").candidates.length, 0);
	assert.deepEqual(lookupPlace(path, "架空公園").candidates.map(({ address }) => address).sort(), ["旭川市", "札幌市"]);

	const results: ToolResult[] = [];
	await using env = await agentEnv({ extensions: () => [createGeocodeExtension(path)] });
	env.faux.setResponses([call("geocode", { query: "札幌市 テスト公園" }), noting(results)]);
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

test("the tool filters by a facility's full address before limiting candidates", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "agent-geocode-"));
	t.after(() => rmSync(dir, { force: true, recursive: true }));
	const path = fixture(dir);
	const unfiltered = lookupPlace(path, "市民会館");
	assert.equal(unfiltered.more, true);
	const omitted = hallAddresses.find((address) => !unfiltered.candidates.some((candidate) => candidate.address === address));
	assert.ok(omitted);
	const area = omitted.replace("架空町", " 架空町");

	const results: ToolResult[] = [];
	await using env = await agentEnv({ extensions: () => [createGeocodeExtension(path)] });
	env.faux.setResponses([call("geocode", { query: "市民会館", area }), noting(results)]);
	const bridge = env.bridge();
	env.link.emit(message("!a:example.org", "$1", `${area}の市民会館の座標を教えて`));
	await bridge.idle();
	assert.equal(results[0]?.isError, false);
	const { candidates, more } = JSON.parse(results[0]?.text ?? "");
	assert.deepEqual(candidates.map(({ address }: { address: string }) => address), [omitted]);
	assert.equal(more, false);
});
