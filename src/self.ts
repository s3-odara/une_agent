import { fileURLToPath } from "node:url";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { errorMessage } from "./errors.ts";

const MANUAL = fileURLToPath(new URL("../manual/agent.md", import.meta.url));

export type SelfOptions = {
	readonly configPath: string;
	/** Where `bash` runs. */
	readonly workDir: string;
	readonly roomOf: (conversationId: number) => string | undefined;
	/** Throws when the config would not start. */
	readonly check: () => Promise<unknown>;
	/** After the answer being written is sent. */
	readonly restart: () => void;
};

export function createSelfExtension(options: SelfOptions) {
	return defineExtension({
		name: "self",
		sections: [
			section("self", (input) => {
				const roomId = options.roomOf(Number(input.conversationId));
				return [
					`このエージェント自身の説明書は ${MANUAL} にある。設定の変更（人格、ルームの人格、モデルなど）や、このエージェントの仕組み・できることを聞かれたら、先に read で読む。`,
					`設定ファイルは ${options.configPath}。bash の作業ディレクトリは ${options.workDir}。`,
					"設定ファイルの変更は agent_restart で再起動するまで効かない（人格の SOUL ファイルと記憶はすぐ効く）。",
					...(roomId === undefined ? [] : [`この会話のルーム ID: ${roomId}`]),
				].join("\n");
			}),
		],
		tools: [
			defineTool({
				name: "agent_restart",
				description: "設定ファイルを確かめてから、このエージェントを再起動する。再起動はこの返答を送ったあと。設定に誤りがあれば再起動せず、その内容を返す。",
				parameters: obj({}),
				execute: async () => {
					// A config that does not start would leave no one to message about fixing it.
					try {
						await options.check();
					} catch (error) {
						throw new Error(`設定に誤りがあるため再起動しません: ${errorMessage(error)}`);
					}
					options.restart();
					return { output: [{ type: "text" as const, text: "設定に誤りはありません。この返答を送ったあと再起動します。" }] };
				},
			}),
		],
	});
}
