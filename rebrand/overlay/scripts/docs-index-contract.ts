/**
 * docs-index-contract.ts — the single definition of which docs get embedded.
 *
 * Two places need this answer: `packages/coding-agent/scripts/generate-docs-index.ts`
 * writes the generated index, and `scripts/check-public-version-sync.ts` regenerates
 * it to prove the committed file is not stale. When each kept its own copy of the
 * rule they drifted apart, and the checker reported a stale index for a file that was
 * in fact freshly generated. Both import from here so that cannot recur.
 */

/**
 * Docs excluded from the embedded index.
 *
 * Fork-maintenance docs describe how the rebrand pipeline itself works and must quote
 * upstream's brand tokens verbatim. They are not product documentation, so bundling
 * them would both mislead users and leak those tokens into the generated index (which
 * the sync residual-token gate then flags).
 */
export const EXCLUDED_DOCS: ReadonlySet<string> = new Set(["FORK_MAINTENANCE.md"]);

/** True when `relativePath` (POSIX, relative to `docs/`) belongs in the embedded index. */
export function isEmbeddableDoc(relativePath: string): boolean {
	return !EXCLUDED_DOCS.has(relativePath);
}
