/**
 * `<untrusted-content>` envelope for tool output the model must treat as data.
 *
 * Kept free of imports so low-level tools (for example `gh`, which is reachable
 * from `config/settings` through internal URLs) can wrap output without pulling
 * `tools/fetch` and the web scrapers into the settings import cycle.
 */

export const UNTRUSTED_CONTENT_OPEN = "<untrusted-content>";
const UNTRUSTED_CONTENT_CLOSE = "</untrusted-content>";
export const WRAP_PREFIX_CHARS = `${UNTRUSTED_CONTENT_OPEN}\n`.length;
export const WRAP_SUFFIX = `\n${UNTRUSTED_CONTENT_CLOSE}`;

export function escapeUntrustedContent(content: string): string {
	// HTML and XML accept whitespace between the tag name and ">".
	return content
		.replace(/<\/untrusted-content>/gi, "&lt;/untrusted-content>")
		.replace(/<\/untrusted-content[ \t\n\r\f]+>/gi, "&lt;/untrusted-content>");
}

export function wrapUntrustedContent(content: string): string {
	return `${UNTRUSTED_CONTENT_OPEN}\n${escapeUntrustedContent(content)}${WRAP_SUFFIX}`;
}
