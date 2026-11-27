import { readFileSync, renameSync, writeFileSync } from "node:fs";

/** Written beside `path` and renamed over it, so a crash leaves the old file or the new one, never half of one. */
export function writeFileAtomic(path: string, data: string, mode?: number): void {
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, data, mode === undefined ? {} : { mode });
	renameSync(temporary, path);
}

/**
 * A missing file is an empty object. A file that is not JSON throws the parser's SyntaxError, and one that is JSON but not
 * an object a TypeError, so a caller whose file holds secrets can replace the message, which may quote the file.
 */
export function readJsonObject(path: string): Record<string, unknown> {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	const value: unknown = JSON.parse(text);
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new TypeError(`${path} is not a JSON object`);
	return value as Record<string, unknown>;
}
