import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type Skill = { readonly name: string; readonly description: string; readonly path: string };

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;

function field(frontmatter: string, key: string): string | undefined {
	const line = frontmatter.split("\n").find((item) => item.startsWith(`${key}:`));
	const value = line?.slice(key.length + 1).trim();
	return value === undefined || value === "" ? undefined : value;
}

function parse(path: string, dirName: string): Skill | undefined {
	const frontmatter = FRONTMATTER.exec(readFileSync(path, "utf8").replaceAll("\r\n", "\n"))?.[1];
	if (frontmatter === undefined) return undefined;
	const description = field(frontmatter, "description");
	if (description === undefined) return undefined;
	return { name: field(frontmatter, "name") ?? dirName, description, path };
}

/** The list is read before every model request, so a file is read again only once it has changed. */
const parsed = new Map<string, { readonly mtimeMs: number; readonly skill: Skill | undefined }>();

/**
 * Each `<dir>/<name>/SKILL.md` with a `description` in its frontmatter. Looked at on each use, so a skill a person adds
 * is listed from the next message. A later directory's skill replaces an earlier one of the same name.
 */
export function listSkills(dirs: readonly string[]): Skill[] {
	const skills = new Map<string, Skill>();
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const path = join(dir, entry.name, "SKILL.md");
			if (!entry.isDirectory() || !existsSync(path)) continue;
			const { mtimeMs } = statSync(path);
			let known = parsed.get(path);
			if (known?.mtimeMs !== mtimeMs) parsed.set(path, (known = { mtimeMs, skill: parse(path, entry.name) }));
			if (known.skill !== undefined) skills.set(known.skill.name, known.skill);
		}
	}
	return [...skills.values()];
}
