import type { Context } from "@earendil-works/chord/context";
import { LiveDoc, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { HostDb } from "./hostdb.ts";

type RunApi = Pick<ToolExecutionApi, "conversationId" | "snapshot">;

export async function runInputs(api: RunApi, context: Context): Promise<number[]> {
	return ((await api.snapshot(LiveDoc, api.conversationId, context))?.run?.inputs ?? []).map(Number);
}

export async function startedByUser(api: RunApi, db: HostDb, context: Context): Promise<boolean> {
	return (await runInputs(api, context)).some((input) => db.isUserSubmission(input));
}
