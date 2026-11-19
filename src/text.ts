export function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** So a cut never splits a surrogate pair. */
export function onCharacter(text: string, index: number): number {
	const code = text.charCodeAt(index - 1);
	return index > 0 && index < text.length && code >= 0xd800 && code <= 0xdbff ? index - 1 : index;
}
