import { execFile } from "node:child_process";
import { join } from "node:path";
import type { ReadPage } from "./extract.ts";
import { SANDBOX_BIN } from "./sandbox.ts";
import { IMAGE_EDGE, ReadError, type BinarySource, type Crop, type Image } from "./web-assets.ts";

export type PdfMode = "text" | "layout" | "image";

const MAX_PAGES = 200;
const MAX_CROP_DPI = 1200;
const MAX_VIRTUAL_EDGE = 16_384;
const MAX_OUTPUT = 4 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

export async function readPdf(document: BinarySource, mode: PdfMode, page: number | undefined, signal?: AbortSignal, crop?: Crop): Promise<ReadPage | Image> {	const bin = process.env.AGENT_POPPLER_BIN;
	if (!bin) throw new ReadError("PDF の抽出器が設定されていません（AGENT_POPPLER_BIN）。");
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	const stop = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
	const run = (tool: string, args: readonly string[]) => new Promise<Buffer>((resolve, reject) => {
		if (stop.aborted) return reject(interrupted());
		const child = execFile(SANDBOX_BIN, [...args], {
			cwd: "/",
			encoding: "buffer",
			maxBuffer: MAX_OUTPUT,
			killSignal: "SIGKILL",
			signal: stop,
			env: {
				AGENT_SANDBOX_EXEC: join(bin, tool),
				AGENT_SANDBOX_READ: "/nix/store\n/etc/fonts\n/usr/share/fonts\n/var/cache/fontconfig",
				LC_ALL: "C",
				FONTCONFIG_FILE: process.env.AGENT_PDF_FONTCONFIG,
			},
		}, (error, stdout) => {
			if (stop.aborted) return reject(interrupted());
			if (error === null) return resolve(stdout);
			if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return reject(new ReadError("PDF の抽出結果が長すぎます。page でページを指定してください。"));
			return reject(new ReadError("PDF を読めませんでした（ファイルが壊れている、暗号化されている、または抽出器を起動できない可能性があります）。"));
		});
		child.stdin?.on("error", () => {});
		child.stdin?.end(document.body);
	});
	function interrupted(): ReadError {
		return new ReadError(signal?.aborted ? "PDF の処理を中止しました。" : "PDF の処理が時間内に終わりませんでした。");
	}

	const info = await run("pdfinfo", ["-"]);
	const pages = Number(/^Pages:\s+(\d+)$/m.exec(info.toString("utf8"))?.[1]);
	if (!Number.isSafeInteger(pages) || pages < 1) throw new ReadError("PDF のページ数が分かりませんでした。");
	if (page !== undefined && page > pages) throw new ReadError(`この PDF は全 ${pages} ページです。page=${page} はありません。`);
	const first = page ?? 1;
	const last = page ?? Math.min(pages, MAX_PAGES);
	const range = ["-f", String(first), "-l", String(last)];
	const { url, status } = document;
	if (mode === "image") {
		const sizing = crop === undefined ? ["-scale-to", String(IMAGE_EDGE)]
			: pdfCrop((await run("pdfinfo", [...range, "-box", "-"])).toString("utf8"), crop);
		const rendered = await run("pdftoppm", [...range, "-cropbox", ...sizing, "-singlefile", "-jpeg", "-"]);
		if (rendered.length < 4 || rendered.readUInt16BE(0) !== 0xffd8 || rendered.readUInt16BE(rendered.length - 2) !== 0xffd9) throw new ReadError(`PDF の ${first} ページ目を画像にできませんでした。`);
		return { data: rendered.toString("base64"), mimeType: "image/jpeg" };
	}
	const extracted = await run("pdftotext", ["-enc", "UTF-8", ...range, ...(mode === "layout" ? ["-layout"] : []), "-", "-"]);
	const parts = extracted.toString("utf8").split("\f");
	const sections: string[] = [];
	for (let n = first; n <= last; n++) {
		const text = parts[n - first] ?? "";
		sections.push(`--- PDF ${n} ページ目 / 全 ${pages} ページ ---\n${text.trim() === "" ? "（文字を抽出できませんでした。page を指定して pdfMode=image で確認できます。）" : text}`);
	}
	if (page === undefined && last < pages) sections.push(`（最初の ${last} ページのみ抽出しました。以降は page で指定してください。）`);
	return { url, status, title: "", scope: "page", mediaType: "application/pdf", markdown: sections.join("\n\n") };
}

/** Text alone, for callers that never ask for an image and do not care to narrow the result. */
export async function readPdfText(document: BinarySource): Promise<ReadPage> {
	const result = await readPdf(document, "text", undefined);
	if (!("markdown" in result)) throw new ReadError("PDF を画像にできませんでした。");
	return result;
}

function pdfCrop(info: string, crop: Crop): string[] {
	const box = /^Page[ \t]+\d+[ \t]+CropBox:[ \t]+([^\r\n]+)$/m.exec(info)?.[1]?.trim().split(/\s+/).map(Number);
	const rotation = Number(/^Page[ \t]+\d+[ \t]+rot:[ \t]+(-?\d+)/m.exec(info)?.[1]);
	const [left, bottom, right, top] = box ?? [];
	if (left === undefined || bottom === undefined || right === undefined || top === undefined || !Number.isFinite(rotation)) {
		throw new ReadError("PDF のページ寸法を取得できませんでした。");
	}
	let [width, height] = [right - left, top - bottom];
	if (rotation % 180 !== 0) [width, height] = [height, width];
	if (!(width > 0 && height > 0) || !Number.isFinite(width + height)) throw new ReadError("PDF のページ寸法が不正です。");
	const dpi = Math.min(MAX_CROP_DPI, MAX_VIRTUAL_EDGE * 72 / Math.max(width, height), IMAGE_EDGE * 72 / Math.max(width * crop.width, height * crop.height));
	const pixels = (size: number, start: number, length: number): [number, number] => {
		const end = size * dpi / 72;
		const origin = Math.min(Math.ceil(end) - 1, Math.floor(end * start));
		return [origin, Math.min(IMAGE_EDGE, Math.max(1, Math.ceil(end * (start + length)) - origin))];
	};
	const [x, w] = pixels(width, crop.x, crop.width);
	const [y, h] = pixels(height, crop.y, crop.height);
	return ["-r", String(dpi), "-x", String(x), "-y", String(y), "-W", String(w), "-H", String(h)];
}
