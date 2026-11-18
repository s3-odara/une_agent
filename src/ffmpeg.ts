import { spawn } from "node:child_process";

/** Runs the `ffmpeg` command with `input` on its stdin, if any, and resolves with what it wrote to stdout. */
export function ffmpeg(args: readonly string[], input?: Buffer): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn("ffmpeg", ["-nostdin", "-loglevel", "error", ...args], { stdio: ["pipe", "pipe", "pipe"] });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
		child.once("error", (error) => reject(new Error(`ffmpeg could not be started: ${error.message}`)));
		child.once("close", (code) => {
			if (code === 0) resolve(Buffer.concat(out));
			else reject(new Error(`ffmpeg failed (${code}): ${Buffer.concat(err).toString().trim()}`));
		});
		child.stdin.on("error", () => {});
		child.stdin.end(input);
	});
}
