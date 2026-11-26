export function textOutput(text: string) {
	return { output: [{ type: "text" as const, text }] };
}

export function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** So a cut never splits a surrogate pair. */
export function onCharacter(text: string, index: number): number {
	const code = text.charCodeAt(index - 1);
	return index > 0 && index < text.length && code >= 0xd800 && code <= 0xdbff ? index - 1 : index;
}

export function elide(text: string, max: number, suffix: string | ((omitted: number) => string) = "…"): string {
	if (text.length <= max) return text;
	const end = onCharacter(text, max);
	const tail = typeof suffix === "function" ? suffix(text.length - end) : suffix;
	return `${text.slice(0, end)}${tail}`;
}

export function fileSizeOf(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
