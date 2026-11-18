import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./files.ts";

export type Credential = { readonly username: string; readonly password: string };

/** A credentials file that cannot be used. Its message never contains a secret. */
export class CredentialError extends Error {}

export const HIDDEN = "［伏せ字］";

/**
 * Site passwords, kept in a plain JSON file a person edits by hand:
 *
 *     { "https://example.com": { "username": "me", "password": "..." } }
 *
 * The key is the site's origin. The file is read at each use, so an edit applies at once. Nothing here hands a password
 * to the model: the browser tools type it into the page themselves, and `scrub()` removes it from everything they
 * return. `set()` and `remove()` write it for the `!cred` commands; the file stays readable by its owner only.
 */
export class Credentials {
	readonly #path: string;

	constructor(path: string) {
		this.#path = path;
	}

	/** The file as it is, keys as written. */
	#raw(): Record<string, unknown> {
		let text: string;
		try {
			text = readFileSync(this.#path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
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
		return parsed as Record<string, unknown>;
	}

	#load(raw = this.#raw()): Map<string, Credential> {
		const found = new Map<string, Credential>();
		for (const [site, value] of Object.entries(raw)) {
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

	/**
	 * Stores the credential of `origin`, replacing the one it had, whatever key that was written under. A file that
	 * cannot be read is left alone rather than overwritten. Resolves with whether one was replaced.
	 */
	set(origin: string, credential: Credential): boolean {
		const { raw, removed } = this.#without(origin);
		raw[origin] = { username: credential.username, password: credential.password };
		this.#write(raw);
		return removed;
	}

	remove(origin: string): boolean {
		const { raw, removed } = this.#without(origin);
		if (removed) this.#write(raw);
		return removed;
	}

	/** The file without `origin`, whatever key it was written under; a file that cannot be read is an error. */
	#without(origin: string): { raw: Record<string, unknown>; removed: boolean } {
		const raw = this.#raw();
		this.#load(raw);
		const keys = Object.keys(raw).filter((key) => URL.parse(key)?.origin === origin);
		for (const key of keys) delete raw[key];
		return { raw, removed: keys.length > 0 };
	}

	/** The usernames by origin. Not secret: the user is shown them with `!cred list`. */
	usernames(): [origin: string, username: string][] {
		return [...this.#load()].map(([origin, credential]): [string, string] => [origin, credential.username]).sort(([a], [b]) => a.localeCompare(b));
	}

	#write(raw: Record<string, unknown>): void {
		writeFileAtomic(this.#path, `${JSON.stringify(raw, null, "\t")}\n`, 0o600);
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
	scrub(text: string, ...others: string[]): string {
		let clean = text;
		let passwords: string[];
		try {
			passwords = [...[...this.#load().values()].map((credential) => credential.password), ...others.filter((other) => other !== "")];
		} catch {
			passwords = others.filter((other) => other !== "");
		}
		// Longest first, so a password that contains another is removed whole.
		for (const password of passwords.sort((a, b) => b.length - a.length)) clean = clean.replaceAll(password, HIDDEN);
		return clean;
	}
}
