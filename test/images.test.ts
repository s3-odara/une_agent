import assert from "node:assert/strict";
import { test } from "node:test";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { createImageWindowExtension, OMITTED } from "../src/images.ts";
import { agentEnv } from "./env.ts";
import { call, everything, message, noting, type Request } from "./fakes.ts";

const ROOM = "!main:example.org";

/** Each call returns an image of its own, numbered in its data. */
function camera() {
	let n = 0;
	return defineExtension({
		name: "camera",
		tools: [
			defineTool({
				name: "shoot",
				description: "画面を撮る",
				parameters: obj({}),
				execute: async () => ({
					output: [
						{ type: "image" as const, data: Buffer.from(`shot-${++n}`).toString("base64"), mimeType: "image/png" },
					],
				}),
			}),
		],
	});
}

/** The shots sent in a request, by number, oldest first. */
function shotsIn(request: Request): number[] {
	return request.messages.flatMap((item) =>
		Array.isArray(item.content)
			? item.content.flatMap((block: { type: string; data?: string }) =>
					block.type === "image"
						? [
								Number(
									Buffer.from(block.data ?? "", "base64")
										.toString()
										.slice(5),
								),
							]
						: [],
				)
			: [],
	);
}

async function shootThenAsk(shots: number): Promise<Request> {
	await using env = await agentEnv({ extensions: () => [camera(), createImageWindowExtension()] });
	const bridge = env.bridge();
	const requests: Request[] = [];
	env.faux.setResponses([...Array.from({ length: shots }, () => call("shoot", {})), noting([], requests)]);
	env.link.emit(message(ROOM, "$1", "撮って"));
	await bridge.idle();
	return requests[0]!;
}

for (const [shots, sent] of [
	[3, [1, 2, 3]],
	[5, [1, 2, 3, 4, 5]],
	[6, [4, 5, 6]],
	[8, [4, 5, 6, 7, 8]],
] as const) {
	test(`after ${shots} images, the request sends ${sent.join(", ")} and leaves the older out in words`, async () => {
		const request = await shootThenAsk(shots);
		assert.deepEqual(shotsIn(request), sent);
		assert.equal(everything(request).split(OMITTED).length - 1, shots - sent.length);
	});
}
