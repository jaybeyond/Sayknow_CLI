/**
 * Sanitize a value destined for an HTTP header.
 *
 * OS-derived components (kernel release, hostname, os.version) can contain
 * non-ASCII characters — e.g. Android kernel releases such as
 * `4.4.302-Minimal™-EAS-QTI_Haptic-R26` — which `Headers`/`fetch` reject
 * before the request is ever sent. Strip everything outside printable
 * ASCII so header construction can never throw on runtime-derived values.
 */

const NON_PRINTABLE_ASCII = /[^\x20-\x7e]/g;

export function sanitizeHeaderComponent(value: string): string {
	return value.replace(NON_PRINTABLE_ASCII, "");
}
