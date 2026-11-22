import { DatabaseSync } from "node:sqlite";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { arr, bool, num, obj, oneOf, opt, str, type Static } from "@earendil-works/pi-schema";

const PLACE_TYPES = {
	office: { kind: "市区町村の本庁", source: "国土数値情報 P05" },
	town: { kind: "大字・町丁目の代表点", source: "国土交通省 位置参照情報" },
	facility: { kind: "施設", source: "© OpenStreetMap contributors (ODbL)" },
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

export function lookupPlace(path: string, query: string): Lookup {
	const key = normalize(query);
	if (!key) return { candidates: [], more: false };
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		const lookup = db.prepare(`SELECT p.name, p.address, p.lat, p.lon, p.kind
			FROM alias a JOIN place p ON p.id = a.place_id
			WHERE a.key = ? AND p.kind IN ('office', 'town', 'facility') AND (? IS NULL OR p.kind = ?)
			ORDER BY p.kind, p.address, p.name, p.id LIMIT ${LIMIT + 1}`);
		const find = (name: string, kind: "town" | null, unmatched?: string): Lookup => {
			const rows = lookup.all(name, kind, kind);
			const candidates = rows.slice(0, LIMIT).map((row): Candidate => {
				const type = row.kind as PlaceType;
				return {
					name: row.name as string, address: row.address as string, lat: row.lat as number, lon: row.lon as number,
					...PLACE_TYPES[type],
					...(unmatched === undefined ? {} : { unmatched }),
				};
			});
			return { candidates, more: rows.length > LIMIT };
		};
		const exact = find(key, null);
		if (exact.candidates.length) return exact;
		const address = addressKey(key).replace(/[-−‐―]/gu, "-");
		const town = find(address, "town");
		if (town.candidates.length) return town;
		for (const match of address.matchAll(/[0-9]+/gu)) {
			const prefix = address.slice(0, match.index);
			const tail = address.slice(match.index);
			if (!prefix || prefix.endsWith("-") || !NUMBER_TAIL.test(tail)) continue;
			const rest = tail.slice(match[0].length);
			if (!prefix.endsWith("丁目") && rest.startsWith("-")) {
				const chomeTown = find(`${prefix}${match[0]}丁目`, "town", rest.slice(1));
				if (chomeTown.candidates.length) return chomeTown;
			}
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
			parameters: obj({ query: str({ minLength: 1, maxLength: 160 }) }),
			structuredOutputSchema: resultSchema,
			replay: "safe",
			execute: async ({ query }) => {
				try {
					const result = lookupPlace(path, query);
					return { structuredOutput: result, output: [{ type: "text", text: JSON.stringify(result) }] };
				} catch (error) {
					if ((error as { errcode?: number }).errcode !== 14) throw error;
					return { isError: true, output: [{ type: "text", text: "ジオコーディング用のデータベースを開けません。" }] };
				}
			},
		})],
	});
}
