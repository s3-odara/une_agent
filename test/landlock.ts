import { execFileSync } from "node:child_process";
import { SANDBOX_BIN } from "../src/sandbox.ts";

export function noLandlock(): string | false {
	const abi = execFileSync(SANDBOX_BIN, ["--landlock-abi"], { encoding: "utf8" }).trim();
	if (!/^\d+$/.test(abi)) throw new Error(`Unexpected Landlock ABI: ${abi}`);
	return Number(abi) < 10 ? `Landlock ABI 10 required (found ${abi === "0" ? "no Landlock" : abi})` : false;
}
