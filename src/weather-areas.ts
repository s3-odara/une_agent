import { readFileSync } from "node:fs";

export type ForecastArea = { readonly officeCode: string; readonly areaCode: string; readonly temperatureCodes: readonly string[] };

type Region = { name: string; parent: string };
type Regions = Record<string, Region>;

const master = JSON.parse(readFileSync(new URL("./jma/area.json", import.meta.url), "utf8")) as {
	offices: Record<string, Region & { children: string[] }>;
	class10s: Regions;
	class15s: Regions;
	class20s: Regions;
};
const stations = JSON.parse(readFileSync(new URL("./jma/forecast_area.json", import.meta.url), "utf8")) as Record<string, { class10: string; amedas: string[] }[]>;

export function forecastArea(areaCode: string): ForecastArea | undefined {
	const officeCode = master.class10s[areaCode]?.parent;
	if (officeCode === undefined) return undefined;
	return { officeCode, areaCode, temperatureCodes: stations[officeCode]?.find((entry) => entry.class10 === areaCode)?.amedas ?? [] };
}

const prefectures = [
	"北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
	"茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
	"新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県", "三重県",
	"滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県",
	"鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県", "高知県",
	"福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
];

const normalize = (name: string) => name.normalize("NFKC").replace(/\s+/g, "");
const byName = new Map<string, Map<string, string>>();
function add(name: string, code: string, candidate: string) {
	const key = normalize(name);
	const matches = byName.get(key) ?? new Map<string, string>();
	matches.set(code, candidate);
	byName.set(key, matches);
}

function areaName(code: string): string {
	const region = master.class10s[code]!;
	const office = master.offices[region.parent]!.name;
	return office === region.name ? office : `${office}・${region.name}`;
}

for (const office of Object.values(master.offices)) {
	for (const code of office.children) add(office.name, code, areaName(code));
}
for (const [code, region] of Object.entries(master.class10s)) {
	const name = areaName(code);
	add(region.name, code, name);
	add(name, code, name);
}
for (const region of Object.values(master.class15s)) add(region.name, region.parent, areaName(region.parent));
for (const [code, region] of Object.entries(master.class20s)) {
	const areaCode = master.class15s[region.parent]?.parent ?? region.parent;
	const prefecture = prefectures[Number(code.slice(0, 2)) - 1];
	if (prefecture === undefined || master.class10s[areaCode] === undefined) continue;
	add(prefecture, areaCode, areaName(areaCode));
	const candidate = prefecture + region.name;
	const municipality = region.name.replace(/([市区町村])(?:東部|西部|南部|北部|中部)$/, "$1");
	for (const name of new Set([region.name, municipality])) {
		add(name, areaCode, candidate);
		add(prefecture + name, areaCode, candidate);
	}
}

export function resolveForecastArea(place: string): ForecastArea {
	const matches = byName.get(normalize(place));
	if (matches === undefined) throw new Error("指定の地名に対応する予報区域が見つかりません。市区町村名や予報区域名を確認してください。");
	if (matches.size > 1) {
		throw new Error(`予報区域を一つに絞れません。どの地域か確認してください：${[...matches.values()].join("、")}`);
	}
	return forecastArea(matches.keys().next().value!)!;
}
