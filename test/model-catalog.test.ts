import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { getClientVersion } from "@earendil-works/pi-ai/utils/identity";
import { createAgentModels, prepareModels } from "../src/harness.ts";

const NEW = { provider: "openai-codex", modelId: "gpt-9-test" };
const newModel = { id: NEW.modelId, name: "Test", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100, type: "chat" };

/** Stands in for pi.dev: a Codex catalog with one model the bundled catalog does not know. */
function piDev(t: TestContext, answer: () => Promise<Response> = async () => Response.json([newModel])) {
	const seen: Request[] = [];
	t.mock.method(globalThis, "fetch", async (input: string, init?: RequestInit) => {
		seen.push(new Request(input, init));
		return answer();
	});
	return seen;
}

/** Codex counts as configured once a login is stored; reading the catalog never uses or refreshes it. */
function loggedIn(): string {
	const dir = mkdtempSync(join(tmpdir(), "catalog-"));
	writeFileSync(join(dir, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: 0 } }));
	return dir;
}

test("a model newer than pi-ai's built-in catalog is usable once the start has fetched the current one", async (t) => {
	const seen = piDev(t);
	const models = createAgentModels(loggedIn());
	assert.equal(models.getModel(NEW.provider, NEW.modelId), undefined);
	await prepareModels(models, [NEW]);
	assert.equal(models.getModel(NEW.provider, NEW.modelId)?.id, NEW.modelId);
	assert.equal(models.getModel("openai-codex", "gpt-6.1-sol")?.id, "gpt-6.1-sol");
	assert.deepEqual(
		seen.map((request) => request.url),
		["https://pi.dev/api/models/providers/openai-codex?types=chat,image,classifier"],
	);
	assert.equal(seen[0]?.headers.get("user-agent")?.split(" ")[0], `pi/${getClientVersion()}`);
});

test("a later start without pi.dev uses the catalog saved last time, and does not wait for it", async (t) => {
	const dir = loggedIn();
	let up = true;
	piDev(t, async () => (up ? Response.json([newModel]) : new Promise(() => {})));
	await prepareModels(createAgentModels(dir), [NEW]);
	up = false;
	const later = createAgentModels(dir);
	await prepareModels(later, [NEW]);
	assert.equal(later.getModel(NEW.provider, NEW.modelId)?.id, NEW.modelId);
});

test("a catalog saved by another pi-ai version is not used", async (t) => {
	const dir = loggedIn();
	writeFileSync(join(dir, "model-catalog.json"), JSON.stringify({ piAi: "0.0.1", providers: { "openai-codex": { models: [{ ...newModel, provider: "openai-codex" }] } } }));
	piDev(t, async () => new Response(null, { status: 503 }));
	await assert.rejects(prepareModels(createAgentModels(dir), [NEW]), /gpt-9-test.*not in the catalog.*gpt-6\.1-sol/);
});

test("a provider without a login stops the start and says how to log in", async (t) => {
	piDev(t);
	const dir = mkdtempSync(join(tmpdir(), "catalog-"));
	await assert.rejects(prepareModels(createAgentModels(dir), [NEW]), /openai-codex.*just model-login openai-codex/);
	await assert.rejects(prepareModels(createAgentModels(dir), [{ provider: "openai", modelId: "x" }]), /unknown model provider "openai".*openai-codex/);
});

test("only the providers the config uses are fetched", async (t) => {
	const seen = piDev(t);
	const dir = loggedIn();
	// OpenRouter is configured too, but the config does not use it.
	process.env.OPENROUTER_API_KEY = "k";
	t.after(() => delete process.env.OPENROUTER_API_KEY);
	await prepareModels(createAgentModels(dir), [NEW]);
	assert.equal(seen.length, 1);
});
