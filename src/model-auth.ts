import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { readJsonObject, writeFileAtomic } from "./files.ts";

/**
 * The same file shape `pi-ai login` writes, so its auth.json can be copied in. OAuth refresh tokens rotate: a refreshed
 * credential that only lived in memory would leave a used-up token on disk, and the next start could not log in.
 */
export class FileCredentialStore implements CredentialStore {
	readonly #path: string;
	#chain: Promise<unknown> = Promise.resolve();

	constructor(path: string) {
		this.#path = path;
	}

	#read(): Record<string, Credential> {
		return readJsonObject(this.#path) as Record<string, Credential>;
	}

	#write(stored: Record<string, Credential>): void {
		writeFileAtomic(this.#path, JSON.stringify(stored, null, 2), 0o600);
	}

	/** One write at a time, so a refresh and a login never both start from the same old file. */
	#serial<T>(task: () => Promise<T>): Promise<T> {
		const run = this.#chain.then(task, task);
		this.#chain = run.catch(() => {});
		return run;
	}

	async read(providerId: string): Promise<Credential | undefined> {
		return this.#read()[providerId];
	}

	async list(): Promise<readonly CredentialInfo[]> {
		return Object.entries(this.#read()).map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}

	modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
		return this.#serial(async () => {
			const current = this.#read()[providerId];
			const next = await fn(current);
			if (next === undefined) return current;
			// Read again: the login command may have written another provider while `fn` waited on the network.
			this.#write({ ...this.#read(), [providerId]: next });
			return next;
		});
	}

	delete(providerId: string): Promise<void> {
		return this.#serial(async () => {
			const { [providerId]: _gone, ...rest } = this.#read();
			this.#write(rest);
		});
	}
}
