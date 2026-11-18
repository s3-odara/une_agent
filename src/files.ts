import { renameSync, writeFileSync } from "node:fs";

/** Written beside `path` and renamed over it, so a crash leaves the old file or the new one, never half of one. */
export function writeFileAtomic(path: string, data: string, mode?: number): void {
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, data, mode === undefined ? {} : { mode });
	renameSync(temporary, path);
}
