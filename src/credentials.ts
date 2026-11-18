import { readFileSync, renameSync, writeFileSync } from "node:fs";

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

	#load(): Map<string, Credential> {
		const found = new Map<string, Credential>();
		for (const [site, value] of Object.entries(this.#raw())) {
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
		this.#load();
		const raw = this.#raw();
		const replaced = this.#keysOf(raw, origin);
		for (const key of replaced) delete raw[key];
		raw[origin] = { username: credential.username, password: credential.password };
		this.#write(raw);
		return replaced.length > 0;
	}

	/** Removes the credential of `origin`. Resolves with whether there was one. */
	remove(origin: string): boolean {
		this.#load();
		const raw = this.#raw();
		const keys = this.#keysOf(raw, origin);
		for (const key of keys) delete raw[key];
		if (keys.length > 0) this.#write(raw);
		return keys.length > 0;
	}

	/** The usernames by origin. Not secret: the user is shown them with `!cred list`. */
	usernames(): [origin: string, username: string][] {
		return [...this.#load()].map(([origin, credential]): [string, string] => [origin, credential.username]).sort(([a], [b]) => a.localeCompare(b));
	}

	#keysOf(raw: Record<string, unknown>, origin: string): string[] {
		return Object.keys(raw).filter((key) => {
			try {
				return new URL(key).origin === origin;
			} catch {
				return false;
			}
		});
	}

	/** Written whole to a file beside it and moved over it, so a crash never leaves half a file. */
	#write(raw: Record<string, unknown>): void {
		const temporary = `${this.#path}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(raw, null, "\t")}\n`, { mode: 0o600 });
		renameSync(temporary, this.#path);
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
