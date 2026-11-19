export function fail(message: string): never {
	throw new Error(message);
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
