import { DatabaseSync } from "node:sqlite";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { arr, bool, num, obj, oneOf, opt, str, type Static } from "@earendil-works/pi-schema";

const PLACE_TYPES = {
	office: { kind: "市区町村の本庁", source: "国土数値情報 P05" },
	town: { kind: "大字・町丁目の代表点", source: "国土交通省 位置参照情報" },
	facility: { kind: "施設", source: "© OpenStreetMap contributors (ODbL)" },
	block: { kind: "街区・地番の代表点", source: "街区レベル位置参照情報 国土交通省" },
} as const;
type PlaceType = keyof typeof PLACE_TYPES;
const placeTypes = Object.values(PLACE_TYPES);
const candidateSchema = obj({
	name: str(), address: str(), lat: num(), lon: num(),
	kind: oneOf(placeTypes.map((p) => p.kind)), source: oneOf(placeTypes.map((p) => p.source)),
	unmatched: opt(str({ description: "照合できなかった住所の末尾（番地や号など）。" })),
});
const resultSchema = obj({ candidates: arr(candidateSchema), more: bool() });
type Candidate = Static<typeof candidateSchema>;
type Lookup = Static<typeof resultSchema>;

function normalize(query: string): string {
	return query.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");
}

const KANJI_DIGITS = "一二三四五六七八九";
function addressKey(key: string): string {
	return key.replace(/(?:[一二三四五六七八九]?十[一二三四五六七八九]?|[一二三四五六七八九])(?=丁目)/gu, (match) => {
		const digit = (s: string) => s ? KANJI_DIGITS.indexOf(s) + 1 : 0;
		const [tens = "", ones] = match.split("十");
		return String(ones === undefined ? digit(tens) : (digit(tens) || 1) * 10 + digit(ones));
	});
}

const LIMIT = 8;
const NUMBER_TAIL = /^[0-9]+(?:(?:番地?-?|-)\d+)*(?:番地?|号)?$/u;

function combine(first: Lookup, second: Lookup): Lookup {
	const candidates = [...first.candidates];
	for (const candidate of second.candidates) {
		if (!candidates.some((c) => c.name === candidate.name && c.address === candidate.address && c.lat === candidate.lat && c.lon === candidate.lon)) {
			candidates.push(candidate);
		}
	}
	return { candidates: candidates.slice(0, LIMIT), more: first.more || second.more || candidates.length > LIMIT };
}

function blockKeys(prefix: string, tail: string): { key: string; unmatched?: string }[] {
	const explicit = /^([0-9]+(?:-[0-9]+)*)番地?(?:-?([0-9]+(?:-[0-9]+)*号?))?$/u.exec(tail);
	if (explicit) return [{ key: `${prefix}${explicit[1]}番`, unmatched: explicit[2] }];
	if (!/^[0-9]+(?:-[0-9]+)*号?$/u.test(tail)) return [];
	const parts = tail.split("-");
	const keys = [];
	for (let end = parts.length - Number(tail.endsWith("号")); end > 0; end--) {
		keys.push({ key: `${prefix}${parts.slice(0, end).join("-")}番`, unmatched: parts.slice(end).join("-") || undefined });
	}
	return keys;
}

export function lookupPlace(path: string, query: string, area?: string): Lookup {
	const key = normalize(query);
	const areaKey = addressKey(normalize(area ?? ""));
	if (!key) return { candidates: [], more: false };
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		db.function("matches_area", { deterministic: true }, (address, area) =>
			Number(typeof address === "string" && typeof area === "string" && addressKey(normalize(address)).includes(area)));
		const lookup = db.prepare(`SELECT p.name, p.address, p.lat, p.lon, p.kind
			FROM alias a JOIN place p ON p.id = a.place_id
			WHERE a.key = ? AND (? IS NULL OR p.kind = ?) AND (? = '' OR matches_area(p.address, ?))
			ORDER BY p.kind, p.address, p.name, p.id LIMIT ${LIMIT + 1}`);
		const find = (name: string, kind: PlaceType | null, unmatched?: string): Lookup => {
			const rows = lookup.all(name, kind, kind, areaKey, areaKey);
			const candidates = rows.slice(0, LIMIT).map((row): Candidate => {
				const type = row.kind as PlaceType;
				if (!Object.hasOwn(PLACE_TYPES, type)) throw new Error("ジオコーディング用DBの種別が不明です。just geocode-db で再生成してください。");
				return {
					name: row.name as string, address: row.address as string, lat: row.lat as number, lon: row.lon as number,
					...PLACE_TYPES[type],
					...(unmatched === undefined ? {} : { unmatched }),
				};
			});
			return { candidates, more: rows.length > LIMIT };
		};
		if (area !== undefined) return find(key, "facility");
		const exact = find(key, null);
		if (exact.candidates.length) return exact;
		const address = addressKey(key).replace(/[-−‐―]/gu, "-");
		const town = find(address, "town");
		if (town.candidates.length) return town;
		const block = (prefix: string, tail: string) => {
			for (const candidate of blockKeys(prefix, tail)) {
				const result = find(candidate.key, "block", candidate.unmatched);
				if (result.candidates.length) return result;
			}
			return undefined;
		};
		for (const match of address.matchAll(/[0-9]+/gu)) {
			const prefix = address.slice(0, match.index);
			const tail = address.slice(match.index);
			if (!prefix || prefix.endsWith("-") || !NUMBER_TAIL.test(tail)) continue;
			const rest = tail.slice(match[0].length);
			const exactBlock = block(prefix, tail);
			if (!prefix.endsWith("丁目") && rest.startsWith("-")) {
				const chome = `${prefix}${match[0]}丁目`;
				const afterChome = rest.slice(1);
				const chomeBlock = block(chome, afterChome);
				if (chomeBlock && exactBlock) return combine(chomeBlock, exactBlock);
				if (chomeBlock) return chomeBlock;
				if (exactBlock) return exactBlock;
				const chomeTown = find(chome, "town", afterChome);
				if (chomeTown.candidates.length) return chomeTown;
			}
			if (exactBlock) return exactBlock;
			const partial = find(prefix, "town", tail);
			if (partial.candidates.length) return partial;
		}
		return exact;
	} finally {
		db.close();
	}
}

export function createGeocodeExtension(path: string) {
	return defineExtension({
		name: "geocode",
		tools: [defineTool({
			name: "geocode",
			description: "日本の地名・住所・施設名から緯度経度の候補を引く。",
			parameters: obj({
				query: str({ minLength: 1, maxLength: 160 }),
				area: opt(str({ minLength: 1, maxLength: 160, description: "施設名で検索するとき、所在地で絞る（例：東京都府中市）。" })),
			}),
			structuredOutputSchema: resultSchema,
			replay: "safe",
			execute: async ({ query, area }) => {
				try {
					const result = lookupPlace(path, query, area);
					return { structuredOutput: result, output: [{ type: "text", text: JSON.stringify(result) }] };
				} catch (error) {
					if ((error as { errcode?: number }).errcode !== 14) throw error;
					return { isError: true, output: [{ type: "text", text: "ジオコーディング用のデータベースを開けません。" }] };
				}
			},
		})],
	});
}
