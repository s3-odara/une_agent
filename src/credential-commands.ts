import { CredentialError, type Credentials } from "./credentials.ts";
import { errorMessage } from "./errors.ts";
import type { Handled, MessageHandler } from "./rooms.ts";

const HELP = [
	"認証情報のコマンド:",
	"- !cred add https://example.com ユーザー名 パスワード … 登録（同じサイトは置き換え）。送ったあと、その発言は削除してください",
	"- !cred list … 登録済みのサイトとユーザー名",
	"- !cred remove https://example.com … 削除",
].join("\n");

/** `https://example.com/login` or `example.com` as an origin, or `undefined` when it is not a web address. */
function originOf(site: string): string | undefined {
	try {
		const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(site) ? site : `https://${site}`);
		if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
		// A word without a dot is more likely a typo than a site.
		return url.hostname.includes(".") || url.hostname.includes(":") || url.hostname === "localhost" ? url.origin : undefined;
	} catch {
		return undefined;
	}
}

/**
 * `!cred` commands, which add, list and remove site passwords from the chat. Every message starting with `!cred` is
 * taken here and never reaches the model or the conversation, also one that is malformed: it may hold a password.
 * The message itself stays in the room until the user deletes it; the reply says so.
 */
export class CredentialCommands implements MessageHandler {
	readonly #credentials: Credentials;

	constructor(credentials: Credentials) {
		this.#credentials = credentials;
	}

	onMessage(message: { readonly body: string }): Handled {
		const text = message.body.trim();
		if (!/^!cred(\s|$)/.test(text)) return { handled: false };
		try {
			return { handled: true, reply: this.#run(text) };
		} catch (error) {
			// A credentials error never holds a secret; anything else is described without its message, which might.
			return { handled: true, reply: error instanceof CredentialError ? error.message : `認証情報を書き込めませんでした（${errorMessage(error).split(":")[0]}）。` };
		}
	}

	#run(text: string): string {
		const [, command, rest = ""] = /^!cred\s*(\S*)\s*([\s\S]*)$/.exec(text) ?? [];
		switch (command) {
			case "add": {
				// The password is everything after the user name, so it may contain spaces.
				const match = /^(\S+)\s+(\S+)\s+([\s\S]+)$/.exec(rest);
				if (match === null) return `書き方: !cred add https://example.com ユーザー名 パスワード\n（この発言にパスワードが含まれていたら削除してください）`;
				const [, site, username, password] = match as unknown as [string, string, string, string];
				const origin = originOf(site);
				if (origin === undefined) return `「${site}」はサイトの URL として読めません。https://example.com の形で書いてください。\n（この発言は削除してください）`;
				const replaced = this.#credentials.set(origin, { username, password: password.trim() });
				return `${origin} の認証情報を${replaced ? "置き換えました" : "登録しました"}（ユーザー名: ${username}）。パスワードを含むこの発言は削除してください。`;
			}
			case "list": {
				const entries = this.#credentials.usernames();
				return entries.length === 0 ? "登録済みの認証情報はありません。" : ["登録済みの認証情報:", ...entries.map(([origin, username]) => `- ${origin}（${username}）`)].join("\n");
			}
			case "remove": {
				const origin = originOf(rest.trim());
				if (origin === undefined) return "書き方: !cred remove https://example.com";
				return this.#credentials.remove(origin) ? `${origin} の認証情報を削除しました。` : `${origin} の認証情報は登録されていません。`;
			}
			default:
				return HELP;
		}
	}
}
