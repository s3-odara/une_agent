import type { CDPSession, Page } from "playwright-core";
import { errorMessage } from "./errors.ts";

export class ReadError extends Error {}

export type ReadImage = {
	readonly url: string;
	readonly status?: number;
	readonly image: { readonly data: string; readonly mimeType: string };
};

const MAX_BYTES = 5 * 1024 * 1024;
const TOO_LARGE = "ファイルが大きすぎます（上限 5 MiB）。";
const TEXT = /^(text\/(plain|csv|xml|tab-separated-values)|application\/(json|csv|xml|[^/;]+\+(json|xml)))$/;

type Asset = { body: Buffer; url: string; status: number; mediaType: string; contentType: string };

export async function interceptAsset(cdp: CDPSession): Promise<() => Promise<Asset | undefined>> {
	const { frameTree } = await cdp.send("Page.getFrameTree");
	let result: Promise<Asset | ReadError> | undefined;
	cdp.on("Fetch.requestPaused", ({ frameId, requestId, request, responseStatusCode: status, responseHeaders }) => {
		const header = (name: string) => responseHeaders?.find((item) => item.name.toLowerCase() === name)?.value;
		const contentType = header("content-type") ?? "text/html";
		const mediaType = (contentType.split(";", 1)[0] ?? "").trim().toLowerCase();
		const redirect = status !== undefined && [301, 302, 303, 307, 308].includes(status) && header("location") !== undefined;
		if (result !== undefined || frameId !== frameTree.frame.id || redirect || status === undefined || status === 204 || status === 205 ||
			mediaType === "text/html" || mediaType === "application/xhtml+xml") {
			void cdp.send("Fetch.continueRequest", { requestId }).catch(() => {});
			return;
		}
		result = (async () => {
			if (!mediaType.startsWith("image/") && !TEXT.test(mediaType)) return new ReadError(`この形式は読めません（${mediaType}）。`);
			if (Number(header("content-length")) > MAX_BYTES) return new ReadError(TOO_LARGE);
			const { stream } = await cdp.send("Fetch.takeResponseBodyAsStream", { requestId });
			return { body: await readBody(cdp, stream), url: request.url, status, mediaType, contentType };
		})().catch((error: unknown) => error instanceof ReadError ? error : new ReadError(`ファイルを読めませんでした: ${errorMessage(error).split("\n")[0]}`));
		// Prevent downloads and give the image decoder a document with no site scripts.
		void result.then(() => cdp.send("Fetch.fulfillRequest", {
			requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/html" }], body: "",
		})).catch(() => {});
	});
	await cdp.send("Fetch.enable", { patterns: [{ resourceType: "Document", requestStage: "Response" }] });
	return async () => {
		const value = await result;
		if (value instanceof ReadError) throw value;
		return value;
	};
}

async function readBody(cdp: CDPSession, handle: string): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const { data, base64Encoded, eof } = await cdp.send("IO.read", { handle, size: 64 * 1024 });
			const chunk = Buffer.from(data, base64Encoded === true ? "base64" : "utf8");
			bytes += chunk.length;
			if (bytes > MAX_BYTES) throw new ReadError(TOO_LARGE);
			chunks.push(chunk);
			if (eof) return Buffer.concat(chunks, bytes);
		}
	} finally {
		await cdp.send("IO.close", { handle }).catch(() => {});
	}
}

export function decodeText(body: Buffer, contentType: string): string {
	const bom = body[0] === 0xff && body[1] === 0xfe ? "utf-16le" : body[0] === 0xfe && body[1] === 0xff ? "utf-16be" : undefined;
	const charset = bom ?? /;\s*charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1]
		?? /^<\?xml\s+[^>]*?\bencoding\s*=\s*["']([^"']+)/i.exec(body.toString("ascii", 0, 256))?.[1]
		?? "utf-8";
	try {
		return new TextDecoder(charset).decode(body);
	} catch {
		throw new ReadError(`テキストの文字コードに対応していません（${charset}）。`);
	}
}

type BrowserImage = { src: string; decode(): Promise<void>; naturalWidth: number; naturalHeight: number };
type Canvas = {
	width: number;
	height: number;
	getContext(kind: "2d"): {
		drawImage(image: BrowserImage, x: number, y: number, width: number, height: number): void;
		globalCompositeOperation: string;
		fillStyle: string;
		fillRect(x: number, y: number, width: number, height: number): void;
	} | null;
	toDataURL(type: string, quality?: number): string;
};

export async function readImage(page: Page, mediaType: string, body: Buffer): Promise<ReadImage["image"]> {
	const result = await page.evaluate(async ({ mediaType, data }) => {
		const { Image, document } = globalThis as unknown as { Image: new () => BrowserImage; document: { createElement(tag: "canvas"): Canvas } };
		const blob = new Blob([Uint8Array.fromBase64(data)], { type: mediaType });
		const url = URL.createObjectURL(blob);
		try {
			const image = new Image();
			image.src = url;
			if (!(await image.decode().then(() => true, () => false))) return { error: "画像を読み込めませんでした。" };
			const { naturalWidth: width, naturalHeight: height } = image;
			if (width === 0 || height === 0) return { error: "画像を読み込めませんでした。" };
			if (width > 8192 || height > 8192 || width * height > 16_000_000) return { error: "画像の寸法が大きすぎます。" };
			const canvas = document.createElement("canvas");
			const scale = Math.min(1, 1568 / Math.max(width, height));
			canvas.width = Math.max(1, Math.round(width * scale));
			canvas.height = Math.max(1, Math.round(height * scale));
			const ctx = canvas.getContext("2d");
			if (ctx === null) return { error: "画像を描画できませんでした。" };
			ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
			const png = canvas.toDataURL("image/png");
			if (png.length <= 5_000_000) return { data: png.slice(png.indexOf(",") + 1), mimeType: "image/png" };
			ctx.globalCompositeOperation = "destination-over";
			ctx.fillStyle = "white";
			ctx.fillRect(0, 0, canvas.width, canvas.height);
			const jpeg = canvas.toDataURL("image/jpeg", 0.9);
			return { data: jpeg.slice(jpeg.indexOf(",") + 1), mimeType: "image/jpeg" };
		} finally {
			URL.revokeObjectURL(url);
		}
	}, { mediaType, data: body.toString("base64") });
	if (result.error !== undefined) throw new ReadError(result.error);
	return result;
}
