import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileCredentialStore } from "../src/model-auth.ts";

const oauth = (access: string) => ({ type: "oauth" as const, access, refresh: `r-${access}`, expires: 1 });

function authFile(): string {
	return join(mkdtempSync(join(tmpdir(), "model-auth-")), "auth.json");
}

test("a login copied from pi-ai's auth.json is read, and a refreshed one is written back for the next start", async () => {
	const path = authFile();
	writeFileSync(path, JSON.stringify({ "openai-codex": oauth("old"), anthropic: { type: "api_key", key: "k" } }));
	const store = new FileCredentialStore(path);
	assert.equal((await store.read("openai-codex"))?.type, "oauth");

	await store.modify("openai-codex", async () => oauth("new"));

	const again = new FileCredentialStore(path);
	assert.deepEqual(await again.read("openai-codex"), oauth("new"));
	assert.deepEqual(await again.read("anthropic"), { type: "api_key", key: "k" });
	assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("writes at the same time all land", async () => {
	const store = new FileCredentialStore(authFile());
	await Promise.all(["a", "b", "c"].map((id) => store.modify(id, async () => oauth(id))));
	assert.deepEqual((await store.list()).map((item) => item.providerId).sort(), ["a", "b", "c"]);
});

test("a logout removes only that provider", async () => {
	const path = authFile();
	const store = new FileCredentialStore(path);
	await store.modify("a", async () => oauth("a"));
	await store.modify("b", async () => oauth("b"));
	await store.delete("a");
	assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, "utf8"))), ["b"]);
});
