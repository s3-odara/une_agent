import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CredentialError, Credentials } from "../src/credentials.ts";
import { tempDir } from "./env.ts";

function credentialsFile() {
	const dir = tempDir();
	const path = join(dir.path, "credentials.json");
	return { credentials: new Credentials(path), write: (content: unknown) => writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content)), [Symbol.dispose]: () => dir[Symbol.dispose]() };
}

test("without a credentials file, no site has a login and nothing is hidden", () => {
	using t = credentialsFile();
	assert.deepEqual(t.credentials.origins(), []);
	assert.equal(t.credentials.scrub("nothing stored"), "nothing stored");
});

test("a site on another port is another site", () => {
	using t = credentialsFile();
	t.write({ "https://b.example.com:8443": { username: "b", password: "pw-b" } });
	assert.equal(t.credentials.forOrigin("https://b.example.com:8443")?.username, "b");
	assert.equal(t.credentials.forOrigin("https://b.example.com"), undefined);
});

test("the file is read again at each use, so an edit applies at once", () => {
	using t = credentialsFile();
	t.write({ "https://a.example.com": { username: "a", password: "pw-a" } });
	assert.deepEqual(t.credentials.origins(), ["https://a.example.com"]);
	t.write({});
	assert.deepEqual(t.credentials.origins(), []);
});

test("every stored password is hidden, and one inside another leaves no fragment behind", () => {
	using t = credentialsFile();
	t.write({ "https://a.example.com": { username: "a", password: "pw-long-one" }, "https://b.example.com": { username: "b", password: "pw-long" } });
	const hidden = t.credentials.scrub("x pw-long-one y pw-long z");
	assert.ok(!hidden.includes("pw-long"), hidden);
	assert.ok(hidden.startsWith("x ") && hidden.endsWith(" z") && hidden.includes(" y "), hidden);
});

test("a file that cannot be read is an error that does not quote it", () => {
	using t = credentialsFile();
	t.write('{ "https://a.example.com": { "username": "a", "password": "s3cret-value" ');
	assert.throws(
		() => t.credentials.origins(),
		(error: unknown) => error instanceof CredentialError && !error.message.includes("s3cret-value"),
	);
});

for (const [what, content] of [
	["a key that is not a URL", { "a.example.com": { username: "a", password: "x" } }],
	["a login without a password", { "https://a.example.com": { username: "a" } }],
] as const) {
	test(`a credentials file with ${what} is refused`, () => {
		using t = credentialsFile();
		t.write(content);
		assert.throws(() => t.credentials.origins(), CredentialError);
	});
}
