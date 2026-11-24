import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createAttachExtension, mimeTypeOf } from "../src/attach.ts";
import { agentEnv } from "./env.ts";
import { samplePdf } from "./pdf-fixture.ts";
import { call, lastToolResult, message, type Request } from "./fakes.ts";

const ROOM = "!a:example.org";

async function setup(limit?: number) {
	const sent: { readonly roomId: string; readonly txnId: string; readonly path: string; readonly name: string; readonly mimeType: string }[] = [];
	const env = await agentEnv({
		extensions: ({ db }) => [
			createAttachExtension({
				db,
				send: async (roomId, txnId, file) => {
					sent.push({ roomId, txnId, ...file });
					return `$attached-${txnId}`;
				},
				uploadLimit: () => limit,
			}),
		],
	});
	const bridge = env.bridge();
	let request: Request | undefined;
	return {
		env,
		sent,
		say: async (body: string, args: Parameters<typeof call>[1]) => {
			env.faux.setResponses([
				call("send_file", args),
				(r: Request) => {
					request = r;
					return fauxAssistantMessage("送りました");
				},
			]);
			env.link.emit(message(ROOM, `$${sent.length + 1}`, body));
			await bridge.idle();
			return lastToolResult(request!);
		},
	};
}

test("a file is sent with the MIME type its extension suggests", async () => {
	const t = await setup();
	const path = join(t.env.dir, "report.pdf");
	writeFileSync(path, "%PDF-");
	const result = await t.say("これを送って", { path });
	assert.ok(!result.isError, result.text);
	assert.deepEqual(t.sent.map(({ txnId, ...file }) => file), [{ roomId: ROOM, path, name: "report.pdf", mimeType: "application/pdf" }]);
	// The transaction ID is remembered with the call, so a rerun after a crash sends one event.
	assert.match(t.sent[0]?.txnId ?? "", /^file:/);
});

test("a file without an extension goes as an octet stream, and the name can be given", async () => {
	const t = await setup();
	const path = join(t.env.dir, "binary");
	writeFileSync(path, "x");
	await t.say("これを送って", { path, name: "送るもの" });
	assert.equal(t.sent[0]?.mimeType, "application/octet-stream");
	assert.equal(t.sent[0]?.name, "送るもの");
});

test("a file larger than the homeserver's limit is refused before it is sent", async () => {
	const t = await setup(10);
	const path = join(t.env.dir, "big.bin");
	writeFileSync(path, Buffer.alloc(11));
	const result = await t.say("送って", { path });
	assert.equal(result.isError, true);
	assert.match(result.text, /上限/);
	assert.deepEqual(t.sent, []);
});

test("a file that is not there is refused", async () => {
	const t = await setup();
	const result = await t.say("送って", { path: join(t.env.dir, "nothing.bin") });
	assert.equal(result.isError, true);
	assert.match(result.text, /読めません/);
	assert.deepEqual(t.sent, []);
});

test("what a name's extension suggests it is", () => {
	assert.equal(mimeTypeOf("shot.png"), "image/png");
	assert.equal(mimeTypeOf("REPORT.PDF"), "application/pdf");
	assert.equal(mimeTypeOf("plain"), "application/octet-stream");
});

const withPoppler = process.env.AGENT_POPPLER_BIN ? test : test.skip;

async function readPdfTool(args: Parameters<typeof call>[1]) {
	await using env = await agentEnv({
		extensions: ({ db }) => [createAttachExtension({ db, send: async () => "$attached", uploadLimit: () => undefined })],
	});
	const path = join(env.dir, "doc.pdf");
	writeFileSync(path, samplePdf());
	const bridge = env.bridge();
	let request: Request | undefined;
	env.faux.setResponses([
		call("read_pdf", { path, ...args }),
		(r: Request) => {
			request = r;
			return fauxAssistantMessage("わかりました");
		},
	]);
	env.link.emit(message(ROOM, "$1", "読んで"));
	await bridge.idle();
	return lastToolResult(request!);
}

withPoppler("a PDF is read as its text", async () => {
	const result = await readPdfTool({});
	assert.ok(!result.isError, result.text);
	assert.match(result.text, /--- PDF 1 ページ目 \/ 全 2 ページ ---/);
	assert.match(result.text, /left column/);
});

withPoppler("an image of a PDF needs a page", async () => {
	const result = await readPdfTool({ pdfMode: "image" });
	assert.equal(result.isError, true);
	assert.match(result.text, /page/);
});
