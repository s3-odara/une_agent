import { DatabaseSync } from "node:sqlite";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { arr, num, obj, oneOf, opt, str, type Static } from "@earendil-works/pi-schema";

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
const resultSchema = obj({
	candidates: arr(candidateSchema),
	omitted: opt(num({ description: "上限で省略した候補の件数（最大200。これ以上ある場合も200）" })),
});
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

const LIMIT = 20;
const COUNT_CAP = 200;
const HEAD_MAX = 16;
const PREFECTURES = [
	"北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県", "群馬県",
	"埼玉県", "千葉県", "東京都", "神奈川県", "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県",
	"岐阜県", "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県",
	"鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県", "高知県", "福岡県",
	"佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
];
const NUMBER_TAIL = /^[0-9]+(?:(?:番地?-?|-)\d+)*(?:番地?|号)?$/u;

type Row = { id: number; name: string; address: string; lat: number; lon: number; kind: string };
type Item = { row: Row; unmatched?: string };

const cast = (statement: { all(...params: unknown[]): unknown }, ...params: unknown[]): Row[] =>
	statement.all(...params) as Row[];

export function lookupPlace(path: string, query: string): Lookup {
	const key = normalize(query);
	if (!key) return { candidates: [] };
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		const lookup = db.prepare(`SELECT p.id, p.name, p.address, p.lat, p.lon, p.kind
			FROM alias a JOIN place p ON p.id = a.place_id
			WHERE a.key = ? AND p.kind IN ('office', 'town', 'facility') AND (? IS NULL OR p.kind = ?)
			ORDER BY p.kind, p.address, p.name, p.id LIMIT ${COUNT_CAP}`);
		const prefix = db.prepare(`SELECT p.id, p.name, p.address, p.lat, p.lon, p.kind
			FROM alias a JOIN place p ON p.id = a.place_id
			WHERE a.key >= ? AND a.key < ? AND p.kind IN ('office', 'town', 'facility')
			ORDER BY a.key, p.id LIMIT ${COUNT_CAP}`);
		const isOffice = db.prepare(`SELECT 1 FROM alias a JOIN place p ON p.id = a.place_id
			WHERE a.key = ? AND p.kind = 'office' LIMIT 1`);

		// 入力の先頭から都道府県名・市区町村名（本庁の別名）を外した形も候補にする。
		const stripPrefecture = (k: string): string | null => {
			for (const pref of PREFECTURES) {
				if (k.startsWith(pref)) return k.slice(pref.length) || null;
			}
			return null;
		};
		const stripMunicipality = (k: string): string | null => {
			for (let len = Math.min(k.length - 1, HEAD_MAX); len >= 2; len--) {
				if (isOffice.get(k.slice(0, len))) return k.slice(len);
			}
			return null;
		};
		const keys = [key];
		for (let i = 0; i < keys.length && keys.length < 8; i++) {
			const k = keys[i]!;
			const strippedStation = k.endsWith("駅") ? k.slice(0, -1) : null;
			for (const stripped of [stripPrefecture(k), stripMunicipality(k), strippedStation]) {
				if (stripped && !keys.includes(stripped)) keys.push(stripped);
			}
		}

		// 住所（丁目・番地）の照合。番地より前の一致に対し、照合できなかった末尾を unmatched に入れる。
		const addressItems = (k: string): Item[] => {
			const address = addressKey(k).replace(/[-−‐―]/gu, "-");
			const town: Item[] = cast(lookup, address, "town", "town").map((row) => ({ row }));
			if (town.length) return town;
			for (const match of address.matchAll(/[0-9]+/gu)) {
				const head = address.slice(0, match.index);
				const tail = address.slice(match.index);
				if (!head || head.endsWith("-") || !NUMBER_TAIL.test(tail)) continue;
				const rest = tail.slice(match[0].length);
				if (!head.endsWith("丁目") && rest.startsWith("-")) {
					const chome = cast(lookup, `${head}${match[0]}丁目`, "town", "town");
					if (chome.length) return chome.map((row) => ({ row, unmatched: rest.slice(1) }));
				}
				const partial = cast(lookup, head, "town", "town");
				if (partial.length) return partial.map((row) => ({ row, unmatched: tail }));
			}
			return [];
		};

		// 完全一致（住所の照合を含む）をすべての候補キーで集め、だめなら前方一致。
		const sources: Item[][] = [];
		for (const k of keys) {
			const exact: Item[] = cast(lookup, k, null, null).map((row) => ({ row }));
			sources.push(exact.length ? exact : addressItems(k));
		}
		for (const k of keys) {
			sources.push(cast(prefix, k, `${k}\uffff`).map((row) => ({ row })));
		}

		const shown: Candidate[] = [];
		const shownIds = new Set<number>();
		const omittedIds = new Set<number>();
		let omitted = 0;
		outer: for (const source of sources) {
			for (const { row, unmatched } of source) {
				if (shownIds.has(row.id)) continue;
				if (shown.length < LIMIT) {
					shownIds.add(row.id);
					const type = row.kind as PlaceType;
					shown.push({
						name: row.name, address: row.address, lat: row.lat, lon: row.lon,
						...PLACE_TYPES[type],
						...(unmatched === undefined ? {} : { unmatched }),
					});
				} else {
					if (omittedIds.has(row.id)) continue;
					omittedIds.add(row.id);
					if (++omitted >= COUNT_CAP) break outer;
				}
			}
		}
		return { candidates: shown, ...(omitted ? { omitted } : {}) };
	} finally {
		db.close();
	}
}

export function createGeocodeExtension(path: string) {
	return defineExtension({
		name: "geocode",
		tools: [defineTool({
			name: "geocode",
			description: "日本の地名・住所・施設名から緯度経度の候補を引く。完全一致のほか、見つからないときは入力で始まる名前や、都道府県・市区町村名を外した名前も探す。候補は最大20件で、超えた分は omitted に入る。空のときは名前を短くして試し直すと見つかることがある。",
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
