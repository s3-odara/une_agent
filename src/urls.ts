/** `raw` as an http or https URL; anything else is an error whose message is for the model. */
export function httpUrl(raw: string): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("URL の形が違います。https://example.com のように指定してください。");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("開けるのは http と https の URL だけです。");
	return url;
}
