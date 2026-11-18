import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { protocolJson } from "./protocol.ts";

test("the lines the gateway's tests read are the ones the agent's types describe", () => {
	const file = JSON.parse(readFileSync(new URL("protocol.json", import.meta.url), "utf8"));
	assert.deepEqual(file, protocolJson(), "regenerate test/protocol.json from test/protocol.ts");
});
