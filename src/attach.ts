import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool, section, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { int, obj, opt, str } from "@earendil-works/pi-schema";
import { readPdfImage, readPdfText, type PdfMode } from "./pdf.ts";
import { fileSizeOf, textOutput } from "./text.ts";
import type { HostDb } from "./hostdb.ts";
import { ReadError } from "./web-assets.ts";
import { pdfParameters, slicePart, validateCrop } from "./web-tools.ts";

export type AttachOptions = {
	readonly db: HostDb;
	readonly send: (roomId: string, txnId: string, file: { readonly path: string; readonly name: string; readonly mimeType: string }) => Promise<string>;
	/** The largest upload the homeserver accepts, when it says; without it nothing is refused in advance. */
	readonly uploadLimit: () => number | undefined;
	readonly maxChars?: number;
};

const DEFAULT_PDF_MAX_CHARS = 15_000;

const MIME_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
	["png", "image/png"],
	["jpg", "image/jpeg"],
	["jpeg", "image/jpeg"],
	["gif", "image/gif"],
	["webp", "image/webp"],
	["svg", "image/svg+xml"],
	["pdf", "application/pdf"],
	["txt", "text/plain"],
	["md", "text/markdown"],
	["csv", "text/csv"],
	["html", "text/html"],
	["xml", "text/xml"],
	["json", "application/json"],
	["mp3", "audio/mpeg"],
	["ogg", "audio/ogg"],
	["wav", "audio/wav"],
	["flac", "audio/flac"],
	["m4a", "audio/mp4"],
	["mp4", "video/mp4"],
	["webm", "video/webm"],
	["mov", "video/quicktime"],
	["zip", "application/zip"],
	["gz", "application/gzip"],
	["tar", "application/x-tar"],
	["7z", "application/x-7z-compressed"],
	["doc", "application/msword"],
	["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
	["xls", "application/vnd.ms-excel"],
	["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
	["ppt", "application/vnd.ms-powerpoint"],
	["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
]);

export function mimeTypeOf(name: string): string {
	const extension = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase();
	return (extension !== undefined && MIME_BY_EXTENSION.get(extension)) || "application/octet-stream";
}

export function createAttachExtension(options: AttachOptions) {
	const { db } = options;
	const maxChars = options.maxChars ?? DEFAULT_PDF_MAX_CHARS;
	const roomOf = (api: Pick<ToolExecutionApi, "conversationId">) => db.requireRoom(Number(api.conversationId));
	/** Like the other tools see a path: a relative one of the conversation's working directory, as `bash` has it. */
	const absolute = async (api: Pick<ToolExecutionApi, "env">, path: string, context: Context) => {
		if (api.env === undefined) return path;
		const resolved = await api.env.absolutePath(path, context);
		return resolved.ok ? resolved.value : path;
	};

	return defineExtension({
		name: "attach",
		sections: [section("attach", () => "ファイルをルームに添付して送るには send_file を使う。受け取った PDF の続きは read_pdf で読む。")],
		tools: [
			defineTool({
				name: "send_file",
				description: "パスを指定してこのルームにファイルを添付する。",
				parameters: obj({
					path: str({ description: "送るファイルのパス", minLength: 1 }),
					name: opt(str({ description: "添付の名前。省略するとパスの末尾" })),
				}),
				execute: async (args, api, context) => {
					const path = await absolute(api, args.path, context);
					const name = args.name ?? basename(path);
					const info = await stat(path).catch(() => Promise.reject(new Error(`${path} は読めません。`)));
					if (!info.isFile()) throw new Error(`${path} はファイルではありません。`);
					const limit = options.uploadLimit();
					if (limit !== undefined && info.size > limit) throw new Error(`ファイルは ${fileSizeOf(info.size)} で、homeserver の上限（${fileSizeOf(limit)}）を超えています。`);
					// Remembered with the call, so a rerun after a crash sends under the same transaction ID and the homeserver sends one event.
					const txnId = `file:${await api.memo("txn", randomUUID(), context)}`;
					const eventId = await options.send(roomOf(api), txnId, { path, name, mimeType: mimeTypeOf(name) });
					return textOutput(`送りました（event ${eventId}）。一時的なファイルなら、送った後に消してよい。`);
				},
			}),
			defineTool({
				name: "read_pdf",
				description:
					"ローカルの PDF を読む。page を省略すると全ページのテキスト。長いテキストの続きは offset で読む。表は page と pdfMode=layout、数式・図・スキャンは page と pdfMode=image（必要なら crop で拡大）で確認できる。",
				parameters: obj({
					path: str({ description: "PDF のパス", minLength: 1 }),
					offset: opt(int({ description: "続きを読むとき、前の結果が示した文字位置", minimum: 0 })),
					...pdfParameters,
				}),
				replay: "safe",
				execute: async (args, api, context) => {
					const mode = (args.pdfMode ?? "text") as PdfMode;
					const offset = args.offset ?? 0;
					const { page, crop } = args;
					validateCrop(crop);
					if (crop !== undefined && offset > 0) throw new ReadError("crop に offset は使えません。");
					if (mode !== "text" && page === undefined) throw new ReadError(`pdfMode=${mode} には page が必要です。`);
					if (mode === "image" && offset > 0) throw new ReadError("pdfMode=image に offset は使えません。");
					if (crop !== undefined && mode !== "image") throw new ReadError("PDF の crop には page と pdfMode=image が必要です。");

					const path = await absolute(api, args.path, context);
					const body = await readFile(path);
					if (mode === "image") {
						const image = await readPdfImage(body, page!, context.abortSignal, crop);
						const region =
							crop === undefined
								? `細部が読めなければ、同じ path、page=${page}、pdfMode=image に crop を指定して拡大できます。`
								: `切り出し範囲: x=${crop.x}, y=${crop.y}, width=${crop.width}, height=${crop.height}（元画像全体に対する割合）`;
						return { output: [{ type: "text" as const, text: `PDF ${page} ページ目\n${region}` }, { type: "image" as const, ...image }] };
					}
					const { markdown } = await readPdfText(body, mode, page, context.abortSignal);
					const flags = `${page === undefined ? "" : `、page=${page}`}${mode === "text" ? "" : `、pdfMode=${mode}`}`;
					const sliced = slicePart(markdown, offset, maxChars, (next) => `read_pdf を同じ path${flags}、offset=${next} で呼ぶ`);
					if ("error" in sliced) return textOutput(sliced.error);
					return textOutput(sliced.foot === undefined ? sliced.body : `${sliced.body}\n\n${sliced.foot}`);
				},
			}),
		],
	});
}
