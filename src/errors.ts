/** The message of a thrown value, for logs and for telling the user what went wrong. */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
