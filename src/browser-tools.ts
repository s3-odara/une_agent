import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool, GenerationTask, hook, section, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { bool, int, obj, opt, str } from "@earendil-works/pi-schema";
import { type BrowserPage, type Browsers, VIEWPORT } from "./browser.ts";
import { type CodeRequests, noCode } from "./codes.ts";
import type { Credentials } from "./credentials.ts";
import type { HostDb } from "./hostdb.ts";
import { startedByUser } from "./run.ts";
import { elide, textOutput } from "./text.ts";
import { UNTRUSTED } from "./untrusted.ts";
import { httpUrl } from "./urls.ts";
import { readParameters, renderPart } from "./web-tools.ts";

export type BrowserToolsOptions = {
	readonly browsers: Browsers;
	readonly credentials: Credentials;
	readonly db: HostDb;
	readonly profileOf: (conversationId: number) => string | undefined;
	readonly maxChars?: number;
	readonly snapshotWindow?: {
		readonly keep?: number;
		readonly batch?: number;
	};
	readonly codes?: CodeRequests;
	readonly screenshots?: {
		readonly send: (
			roomId: string,
			txnId: string,
			image: { path: string; name: string; width: number; height: number },
		) => Promise<string>;
		readonly dir: string;
	};
};

export const OMITTED_SNAPSHOT = "（古いスナップショット。省略）";

const SNAPSHOT_MARKER = `\n\n${UNTRUSTED}\n\n`;

const SNAPSHOT_TOOLS = new Set([
	"browser_open",
	"browser_snapshot",
	"browser_click",
	"browser_type",
	"browser_press",
	"browser_back",
	"browser_fill_credential",
	"browser_request_code",
]);

function isSnapshotResult(message: Message): message is Extract<Message, { role: "toolResult" }> {
	return (
		message.role === "toolResult" &&
		!message.isError &&
		SNAPSHOT_TOOLS.has(message.toolName) &&
		message.content.some((block) => block.type === "text" && block.text.includes(SNAPSHOT_MARKER))
	);
}

function omitSnapshot(message: Extract<Message, { role: "toolResult" }>): Message {
	const content = message.content.map((block) => {
		if (block.type !== "text") return block;
		const cut = block.text.indexOf(SNAPSHOT_MARKER);
		if (cut === -1) return block;
		return { ...block, text: `${block.text.slice(0, cut)}\n\n${OMITTED_SNAPSHOT}` };
	});
	return { ...message, content };
}

export function pngSize(png: Buffer): { width: number; height: number } {
	return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

const CODE_FIELDS = new Set(["text", "tel", "number", "password", "search", "email", "url", "textarea"]);

/** A refused request. Its message is written for the model. */
class BrowserError extends Error {}

/**
 * What the code guarantees, whatever the model or a page asks for:
 * - A stored password is typed only by `browser_fill_credential`, only into a password field, and only when that
 *   field's document has exactly the origin the password is stored for. It is removed from everything a tool returns.
 * - Only `http` and `https` pages are opened.
 * - Only a run a person's message started can write anything, not one the bot started of its own accord: a check
 *   being weighed is refused every writing tool before it reaches here, and sharing a screenshot to the room is
 *   refused by that tool itself. Reading pages is fine, there: the worst a thrown-away aside leaves behind is a tab.
 *
 * Everything else, including asking before anything irreversible, is an instruction to the model and not enforced.
 * None of these tools is rerun after a crash: a click is not safe to repeat, and the page it was on is gone anyway.
 */
export function createBrowserExtension(options: BrowserToolsOptions) {
	const { browsers, credentials, db, profileOf, codes, screenshots } = options;
	const maxChars = options.maxChars ?? 25_000;

	const clip = (text: string): string => elide(text, maxChars, (omitted) => `\n…（長いので ${omitted} 文字を省略）`);

	const roomOf = (api: Pick<ToolExecutionApi, "conversationId">) => db.requireRoom(Number(api.conversationId));

	const pageFor = async (
		api: Pick<ToolExecutionApi, "conversationId" | "snapshot">,
		context: Context,
	): Promise<BrowserPage> => {
		// While a check is weighed the writing tools are refused before they reach here, so what arrives is a reading
		// tool; user messages and user-scheduled timers are in the delivery ledger.
		if (!db.isWeighing(Number(api.conversationId)) && !(await startedByUser(api, db, context)))
			throw new BrowserError("ユーザーの発言で始まった実行でなければ、ブラウザは使えません。");
		const profile = profileOf(Number(api.conversationId));
		if (profile === undefined) throw new BrowserError("この会話ではブラウザを使えません。");
		return browsers.page(profile, roomOf(api));
	};

	/**
	 * Told with each page rather than listed in the system prompt: a list grows with every site, and a model told of a
	 * new site by a mid-conversation prompt update was seen to keep trusting the earlier list and refuse without trying.
	 */
	const storedOrigin = (url: string): string | undefined => {
		const origin = URL.parse(url)?.origin;
		if (origin === undefined || origin === "null") return undefined;
		try {
			return credentials.forOrigin(origin) === undefined ? undefined : origin;
		} catch {
			return undefined;
		}
	};

	const view = async (page: BrowserPage, note?: string, secret?: string) => {
		const snapshot = await page.snapshot();
		const origin = storedOrigin(snapshot.url);
		const stored =
			origin === undefined
				? []
				: [
						`このサイト（${origin}）には認証情報が登録されています。ログインフォームなら browser_fill_credential で入力できます。`,
					];
		const text = [
			...(note === undefined ? [] : [note, ""]),
			`URL: ${snapshot.url}`,
			`タイトル: ${snapshot.title}`,
			...stored,
			"",
			UNTRUSTED,
			"",
			clip(snapshot.tree),
		].join("\n");
		return textOutput(credentials.scrub(text, ...(secret === undefined ? [] : [secret])));
	};

	/** The common shape of a page action: do it, then show the page it left. */
	const act = async (
		api: Pick<ToolExecutionApi, "conversationId" | "snapshot">,
		context: Context,
		action: (page: BrowserPage) => Promise<unknown>,
	) => {
		const page = await pageFor(api, context);
		await action(page);
		return view(page);
	};

	/** What the model looks at to find a point to click; `shot` when the window was just shot for the room already. */
	const look = async (
		page: BrowserPage,
		note: string,
		options: { mark?: { x: number; y: number }; shot?: { data: Buffer; mimeType: string } } = {},
	) => {
		const location = await page.location();
		const shot = options.shot ?? {
			data: await page.screenshot({ format: "jpeg", ...(options.mark === undefined ? {} : { mark: options.mark }) }),
			mimeType: "image/jpeg",
		};
		const text = [
			note,
			`URL: ${location.url}`,
			`タイトル: ${location.title}`,
			`画像は ${VIEWPORT.width}×${VIEWPORT.height} ピクセルで、ページの見えている範囲そのまま。browser_click_at の x、y はこの画像のピクセルで指定する（左上が 0, 0）。`,
			"",
			UNTRUSTED,
		].join("\n");
		return {
			output: [
				{ type: "text" as const, text: credentials.scrub(text) },
				{ type: "image" as const, data: shot.data.toString("base64"), mimeType: shot.mimeType },
			],
		};
	};

	const pressEnterIf = async (
		page: BrowserPage,
		submit: boolean | undefined,
		ref: string | undefined,
	): Promise<void> => {
		if (submit === true) await page.press("Enter", ref);
	};

	const ref = str({ description: "直近のスナップショットにある要素の ref（例: e12）", minLength: 1 });
	const submit = opt(bool({ description: "入力後に Enter を押す" }));

	const tools = [
		defineTool({
			name: "browser_open",
			description: "URL を開き、ページのスナップショット（要素のツリー。操作できる要素には ref が付く）を返す。",
			parameters: obj({ url: str({ description: "http または https の URL", minLength: 1 }) }),
			executionMode: "sequential",
			execute: async (args, api, context) => {
				const url = httpUrl(args.url);
				return act(api, context, (page) => page.goto(url.href));
			},
		}),
		defineTool({
			name: "browser_snapshot",
			description: "いま開いているページのスナップショットを取り直す。ref は最新のスナップショットのものだけが有効。",
			parameters: obj({}),
			executionMode: "sequential",
			execute: (_args, api, context) => act(api, context, async () => {}),
		}),
		defineTool({
			name: "browser_read",
			description:
				"いま開いているページの本文を Markdown で返す。記事などを読むときはスナップショットよりこちらが短い。本文の判定で欲しい部分が落ちたときは whole=true でページ全体を読む。長いページは途中で切れ、続きは offset を付けて呼ぶ。",
			parameters: obj(readParameters),
			executionMode: "sequential",
			execute: async (args, api, context) => {
				const page = await pageFor(api, context);
				const whole = args.whole === true;
				const again = (next: number) => `browser_read を${whole ? " whole=true、" : " "}offset=${next} で呼ぶ`;
				return textOutput(
					credentials.scrub(renderPart(await page.read(whole), whole, args.offset ?? 0, maxChars, again)),
				);
			},
		}),
		defineTool({
			name: "browser_click",
			description: "要素をクリックし、その後のスナップショットを返す。",
			parameters: obj({ ref }),
			executionMode: "sequential",
			execute: (args, api, context) => act(api, context, (page) => page.click(args.ref)),
		}),
		defineTool({
			name: "browser_click_at",
			description:
				"ページの見えている範囲の一点をクリックし、その後の画面を画像で返す（クリックした位置に赤い丸）。ref の無いもの（画像認証のタイル、canvas、ゲーム）に使う。ref があるなら browser_click を使う。座標は browser_screenshot の画像のピクセル。",
			parameters: obj({
				x: int({ description: "左端からのピクセル", minimum: 0, maximum: VIEWPORT.width - 1 }),
				y: int({ description: "上端からのピクセル", minimum: 0, maximum: VIEWPORT.height - 1 }),
			}),
			executionMode: "sequential",
			execute: async (args, api, context) => {
				const page = await pageFor(api, context);
				await page.clickAt(args.x, args.y);
				return look(page, `(${args.x}, ${args.y}) をクリックしました。赤い丸がクリックした位置です。`, {
					mark: { x: args.x, y: args.y },
				});
			},
		}),
		defineTool({
			name: "browser_type",
			description:
				"入力欄の内容を text に置き換え、その後のスナップショットを返す。パスワードには使わず、browser_fill_credential を使う。",
			parameters: obj({
				ref,
				text: str({ description: "入力する文字列" }),
				submit,
			}),
			executionMode: "sequential",
			execute: (args, api, context) =>
				act(api, context, async (page) => {
					await page.fill(args.ref, args.text);
					await pressEnterIf(page, args.submit, args.ref);
				}),
		}),
		defineTool({
			name: "browser_press",
			description: "キーを押し、その後のスナップショットを返す。ref を付けるとその要素に、無ければページに送る。",
			parameters: obj({
				key: str({ description: "キー名（例: Enter、Escape、PageDown、Tab）", minLength: 1 }),
				ref: opt(ref),
			}),
			executionMode: "sequential",
			execute: (args, api, context) => act(api, context, (page) => page.press(args.key, args.ref)),
		}),
		defineTool({
			name: "browser_back",
			description: "前のページに戻り、そのスナップショットを返す。",
			parameters: obj({}),
			executionMode: "sequential",
			execute: (_args, api, context) => act(api, context, (page) => page.back()),
		}),
		defineTool({
			name: "browser_fill_credential",
			description:
				"いま開いているサイトに保存済みのユーザー名・パスワードを、ログインフォームに直接入力する。値はあなたには見えない。ユーザー名とパスワードの画面が分かれているサイトでは、片方ずつ呼ぶ。",
			parameters: obj({
				usernameRef: opt(str({ description: "ユーザー名（メールアドレス）欄の ref" })),
				passwordRef: opt(str({ description: "パスワード欄の ref" })),
				submit,
			}),
			executionMode: "sequential",
			execute: async (args, api, context) => {
				if (args.usernameRef === undefined && args.passwordRef === undefined)
					throw new BrowserError("usernameRef か passwordRef の少なくとも一方が必要です。");
				const page = await pageFor(api, context);

				// Checked against the element's own document: a login form inside a frame belongs to the frame's site.
				const [usernameField, passwordField] = await Promise.all(
					[args.usernameRef, args.passwordRef].map((field) => (field === undefined ? undefined : page.field(field))),
				);
				const origin = (passwordField ?? usernameField)?.origin ?? "";
				if (
					usernameField !== undefined &&
					passwordField !== undefined &&
					usernameField.origin !== passwordField.origin
				) {
					throw new BrowserError("ユーザー名欄とパスワード欄が別のサイトのものです。");
				}
				const credential = credentials.forOrigin(origin);
				if (credential === undefined) throw new BrowserError(`${origin} の認証情報は登録されていません。`);
				if (passwordField !== undefined && passwordField.kind !== "password") {
					throw new BrowserError(
						"passwordRef がパスワード欄ではありません。パスワードはパスワード欄にしか入力できません。",
					);
				}

				if (args.usernameRef !== undefined) await page.fill(args.usernameRef, credential.username);
				if (args.passwordRef !== undefined) await page.fill(args.passwordRef, credential.password);
				await pressEnterIf(page, args.submit, args.passwordRef ?? args.usernameRef);
				return view(page, `${origin} の認証情報を入力しました。`);
			},
		}),
		...(codes === undefined
			? []
			: [
					defineTool({
						name: "browser_request_code",
						description:
							"確認コード（認証アプリ、メール、SMS などで届くワンタイムコード）をユーザーに頼み、届いたコードを入力欄に直接入力して、その後のスナップショットを返す。コードはあなたには見えない。",
						parameters: obj({
							ref: str({ description: "コードの入力欄の ref", minLength: 1 }),
							submit,
						}),
						executionMode: "sequential",
						execute: async (args, api, context) => {
							const page = await pageFor(api, context);
							const field = await page.field(args.ref);
							if (!CODE_FIELDS.has(field.kind)) throw new BrowserError("ref がコードを入力できる欄ではありません。");
							const outcome = await codes.ask(
								roomOf(api),
								api.callId,
								`${field.origin} のログインに確認コードが要ります。`,
								context.abortSignal,
							);
							if (!outcome.ok) return textOutput(noCode(outcome.reason));
							await page.fill(args.ref, outcome.code);
							await pressEnterIf(page, args.submit, args.ref);
							return view(page, "ユーザーから届いたコードを入力しました。", outcome.code);
						},
					}),
				]),
		...(screenshots === undefined
			? []
			: [
					defineTool({
						name: "browser_screenshot",
						description:
							"いま開いているページの見えている範囲を画像で見る。ツリーでは分からないもの（画像認証、図、canvas）を見るときや、クリックする座標を決めるときに使う。share=true ならユーザーにもルームで見せる。",
						parameters: obj({
							share: opt(bool({ description: "ルームに画像として送り、ユーザーに見せる" })),
							fullPage: opt(
								bool({ description: "ルームに送る画像をページ全体にする（あなたに返る画像は見えている範囲のまま）" }),
							),
						}),
						executionMode: "sequential",
						execute: async (args, api, context) => {
							const page = await pageFor(api, context);
							if (args.share !== true) return look(page, "ページの画面です。");
							if (db.isWeighing(Number(api.conversationId)))
								throw new BrowserError("自分から話しかけるかを決めている間は、ルームに画像を送れません。");
							const roomId = roomOf(api);
							const png = await page.screenshot({ format: "png", fullPage: args.fullPage === true });
							await mkdir(screenshots.dir, { recursive: true });
							const path = join(screenshots.dir, `${randomUUID()}.png`);
							await writeFile(path, png);
							try {
								await screenshots.send(roomId, `screenshot:${api.callId}`, {
									path,
									name: "screenshot.png",
									...pngSize(png),
								});
							} finally {
								await rm(path, { force: true });
							}
							return look(
								page,
								"画面をルームに送りました。",
								args.fullPage === true ? {} : { shot: { data: png, mimeType: "image/png" } },
							);
						},
					}),
				]),
	];

	const keep = options.snapshotWindow?.keep ?? 2;
	const batch = options.snapshotWindow?.batch ?? 3;

	return defineExtension({
		name: "browser",
		sections: [
			section("browser", () =>
				[
					"browser_* でログインしたままの Web ブラウザを操作できる。",
					"",
					"- 購入、支払い、送信、投稿、削除、設定変更など取り返しのつかない操作の前には、内容を示してユーザーに確認する。",
					"- ログインは browser_fill_credential で行う。パスワードをユーザーに尋ねない。",
					"- 認証情報が登録されているサイトでは、ページを開いたときの結果にそう書かれる。ログイン画面を開く前に、未登録だと判断しない。",
					codes === undefined
						? "- 二段階認証のコードを求められたら、そこで止めてユーザーに伝える。"
						: "- 確認コード（二段階認証、メールや SMS で届くコード）を求められたら browser_request_code で頼む。コードをチャットで尋ねたり、推測したりしない。",
					screenshots === undefined
						? "- 画像認証など自分で進められない画面が出たら、そこで止めてユーザーに伝える。"
						: "- 画像認証は browser_screenshot で見て、browser_click_at で解いてよい。何度か試して解けなければ、browser_screenshot（share=true）でユーザーに画面を見せて止まる。",
				].join("\n"),
			),
		],
		hooks: [
			hook(GenerationTask, {
				// Dropped in batches so the prefix stays unchanged between drops and the provider's prompt cache holds.
				beforeRequest: ({ messages }) => {
					const total = messages.reduce((count, message) => count + (isSnapshotResult(message) ? 1 : 0), 0);
					const over = total - keep;
					if (over < batch) return undefined;
					let drop = over - (over % batch);
					const sent = messages.map((message) => {
						if (drop === 0 || !isSnapshotResult(message)) return message;
						drop--;
						return omitSnapshot(message);
					});
					return { messages: sent };
				},
			}),
		],
		tools,
	});
}
