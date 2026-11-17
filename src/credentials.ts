import { readFileSync } from "node:fs";

export type Credential = { readonly username: string; readonly password: string };

/** A credentials file that cannot be used. Its message never contains a secret. */
export class CredentialError extends Error {}

const HIDDEN = "［伏せ字］";

/**
 * Site passwords, kept in a plain JSON file a person edits by hand:
 *
 *     { "https://example.com": { "username": "me", "password": "..." } }
 *
 * The key is the site's origin. The file is read at each use, so an edit applies at once. Nothing here hands a password
 * to the model: the browser tools type it into the page themselves, and `scrub()` removes it from everything they
 * return.
 */
export class Credentials {
	readonly #path: string;

	constructor(path: string) {
		this.#path = path;
	}

	#load(): Map<string, Credential> {
		let text: string;
		try {
			text = readFileSync(this.#path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
			throw new CredentialError(`認証情報ファイルを読めません: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			// The parser's message can quote the file, so it is not passed on.
			throw new CredentialError("認証情報ファイルが JSON として読めません。");
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new CredentialError("認証情報ファイルはオブジェクトである必要があります。");

		const found = new Map<string, Credential>();
		for (const [site, value] of Object.entries(parsed)) {
			let origin: string;
			try {
				origin = new URL(site).origin;
			} catch {
				throw new CredentialError(`認証情報ファイルのキー「${site}」は URL ではありません。https://example.com の形で書いてください。`);
			}
			const entry = value as { username?: unknown; password?: unknown } | null;
			if (typeof entry?.username !== "string" || typeof entry.password !== "string" || entry.password === "") {
				throw new CredentialError(`認証情報ファイルの「${site}」には username と password の文字列が必要です。`);
			}
			found.set(origin, { username: entry.username, password: entry.password });
		}
		return found;
	}

	/** The origins that have a credential. Not secret: the model is told where it can log in. */
	origins(): string[] {
		return [...this.#load().keys()].sort();
	}

	/** The credential of exactly this origin: scheme, host and port all have to match. */
	forOrigin(origin: string): Credential | undefined {
		return this.#load().get(origin);
	}

	/** The text with every stored password replaced. A page may echo what was typed into it. */
	scrub(text: string): string {
		let clean = text;
		let passwords: string[];
		try {
			passwords = [...this.#load().values()].map((credential) => credential.password);
		} catch {
			return clean;
		}
		// Longest first, so a password that contains another is removed whole.
		for (const password of passwords.sort((a, b) => b.length - a.length)) clean = clean.replaceAll(password, HIDDEN);
		return clean;
	}
}
