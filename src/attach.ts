import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool, section, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { readPdf, type PdfMode } from "./pdf.ts";
import { fileSizeOf, textOutput } from "./text.ts";
import type { HostDb } from "./hostdb.ts";
import { type BinarySource } from "./web-assets.ts";

export type AttachOptions = {
	readonly db: HostDb;
	/** Sends to the room the call is in; answered with the event's ID. */
	readonly send: (roomId: string, txnId: string, file: { readonly path: string; readonly name: string; readonly mimeType: string }) => Promise<string>;
	/** The largest upload the homeserver accepts, when it says; without it nothing is refused in advance. */
	readonly uploadLimit: () => number | undefined;
};

/** What a file's extension suggests it is; a kindless one goes as an octet stream. */
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
					const size = await stat(path).then((info) => info.size, () => Promise.reject(new Error(`${path} は読めません。`)));
					const limit = options.uploadLimit();
					if (limit !== undefined && size > limit) throw new Error(`ファイルは ${fileSizeOf(size)} で、homeserver の上限（${fileSizeOf(limit)}）を超えています。`);
					// Remembered with the call, so a rerun after a crash sends under the same transaction ID and the homeserver sends one event.
					const txnId = `file:${await api.memo("txn", randomUUID(), context)}`;
					const eventId = await options.send(roomOf(api), txnId, { path, name, mimeType: mimeTypeOf(name) });
					return textOutput(`送りました（event ${eventId}）。一時的なファイルなら、送った後に消してよい。`);
				},
			}),
			defineTool({
				name: "read_pdf",
				description:
					"ローカルの PDF を読む。page を省略すると全ページのテキスト（上限あり）。表は page と pdfMode=layout、数式・図・スキャンは page と pdfMode=image で確認できる。",
				parameters: obj({
					path: str({ description: "PDF のパス", minLength: 1 }),
					page: opt(int({ description: "PDF の先頭を 1 とするページ番号。省略時は複数ページのテキストを読む", minimum: 1 })),
					pdfMode: opt(oneOf(["text", "layout", "image"], { description: "text は既定、layout は配置を保つ。layout / image は page 必須" })),
				}),
				execute: async (args, api, context) => {
					const mode = (args.pdfMode ?? "text") as PdfMode;
					if (mode !== "text" && args.page === undefined) throw new Error("pdfMode=layout と pdfMode=image のときは page を指定してください。");
					const document: BinarySource = { kind: "pdf", url: "file://", status: 200, body: await readFile(await absolute(api, args.path, context)), mediaType: "application/pdf" };
					const result = await readPdf(document, mode, args.page);
					return "markdown" in result ? textOutput(result.markdown) : { output: [{ type: "image" as const, data: result.data, mimeType: result.mimeType }] };
				},
			}),
		],
	});
}
