import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";

/**
 * Why the tests that drive a real Chromium are skipped, if they are. A Chromium that is there but does not start fails
 * them: that is how a sandbox that keeps it from starting shows.
 */
export const noChromium: string | false = existsSync(process.env.AGENT_CHROMIUM ?? "") ? false : "AGENT_CHROMIUM is not set (the dev shell sets it)";

/** The root directory each Chromium renderer this test process has started (however deep) sees its files from. */
export function rendererRoots(): string[] {
	const children = new Map<number, number[]>();
	for (const name of readdirSync("/proc")) {
		if (!/^\d+$/.test(name)) continue;
		let stat: string;
		try {
			stat = readFileSync(`/proc/${name}/stat`, "utf8");
		} catch {
			continue;
		}
		// The command name before ")" may itself hold spaces and parentheses.
		const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
		children.set(parent, [...(children.get(parent) ?? []), Number(name)]);
	}
	const roots: string[] = [];
	const pending = [...(children.get(process.pid) ?? [])];
	for (let pid = pending.pop(); pid !== undefined; pid = pending.pop()) {
		pending.push(...(children.get(pid) ?? []));
		try {
			// Chromium rewrites its command line into one string of arguments joined by spaces.
			if (!readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("--type=renderer")) continue;
			roots.push(readlinkSync(`/proc/${pid}/root`));
		} catch {}
	}
	return roots;
}
