import type { Context } from "@earendil-works/chord/context";
import { LiveDoc, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { HostDb } from "./hostdb.ts";

type RunApi = Pick<ToolExecutionApi, "conversationId" | "snapshot">;

/** The submissions the run a tool is called in is answering. */
export async function runInputs(api: RunApi, context: Context): Promise<number[]> {
	return ((await api.snapshot(LiveDoc, api.conversationId, context))?.run?.inputs ?? []).map(Number);
}

/** Whether a message from a person, not the scheduler, started the run a tool is called in. */
export async function startedByUser(api: RunApi, db: HostDb, context: Context): Promise<boolean> {
	return (await runInputs(api, context)).some((input) => db.isUserSubmission(input));
}
