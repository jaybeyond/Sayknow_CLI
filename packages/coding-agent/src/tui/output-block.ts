/**
 * Railed output container with optional header and sections.
 */
import {
	ImageProtocol,
	isTerminalGraphicsFallbackActive,
	padding,
	TERMINAL,
	visibleWidth,
	wrapTextWithAnsi,
} from "@sayknow-cli/tui";
import type { Theme } from "../modes/theme/theme";
import { containsSixelSequence, getSixelLineMask } from "../utils/sixel";
import type { State } from "./types";
import type { RenderCache } from "./utils";
import { Hasher, padToWidth, truncateToWidth } from "./utils";

export interface OutputBlockOptions {
	header?: string;
	headerMeta?: string;
	state?: State;
	sections?: Array<{ label?: string; lines: string[] }>;
	width: number;
}

/**
 * Render a tool output block as an open rail: a header line, then content hung
 * off a single left rule in the state color. There is no enclosing box and no
 * filled background in any state; the rail color alone carries running/success/error.
 *
 * ```
 * ✓ Bash · 0.4s
 * │ $ bun test
 * ├ Output
 * │ 12 pass
 * ```
 */
export function renderOutputBlock(options: OutputBlockOptions, theme: Theme): string[] {
	const { header, headerMeta, state, sections = [], width } = options;
	const lineWidth = Math.max(0, width);
	// Rail colors: running/pending use accent, success recedes to dim, error/warning keep their colors.
	const railColor: "error" | "warning" | "accent" | "dim" =
		state === "error"
			? "error"
			: state === "warning"
				? "warning"
				: state === "running" || state === "pending"
					? "accent"
					: "dim";
	const rail = (text: string) => theme.fg(railColor, text);
	const lines: string[] = [];
	const labelText = [header, headerMeta].filter(Boolean).join(theme.sep.dot);
	if (labelText) lines.push(padToWidth(truncateToWidth(labelText, lineWidth), lineWidth));

	const contentPrefix = rail(`${theme.boxSharp.vertical} `);
	const contentWidth = Math.max(0, lineWidth - visibleWidth(contentPrefix));

	for (const section of sections) {
		if (section.label) {
			const tee = rail(`${theme.boxSharp.teeRight} `);
			const label = truncateToWidth(theme.fg("dim", section.label), contentWidth);
			lines.push(padToWidth(`${tee}${label}`, lineWidth));
		}
		const allLines = section.lines.flatMap(l => l.split("\n"));
		const fallbackActive = isTerminalGraphicsFallbackActive();
		const sixelLineMask =
			fallbackActive || TERMINAL.imageProtocol === ImageProtocol.Sixel ? getSixelLineMask(allLines) : undefined;
		for (let lineIndex = 0; lineIndex < allLines.length; lineIndex++) {
			const sixelLine = sixelLineMask?.[lineIndex] ?? false;
			if (sixelLine && !fallbackActive) {
				lines.push(allLines[lineIndex]!);
				continue;
			}
			if (sixelLine && sixelLineMask?.[lineIndex - 1] && !containsSixelSequence(allLines[lineIndex]!)) continue;
			const line = sixelLine ? "[SIXEL image hidden while IRC sidebar is visible]" : allLines[lineIndex]!;
			const wrappedLines = wrapTextWithAnsi(line.trimEnd(), contentWidth);
			for (const wrappedLine of wrappedLines) {
				const innerPadding = padding(Math.max(0, contentWidth - visibleWidth(wrappedLine)));
				lines.push(padToWidth(`${contentPrefix}${wrappedLine}${innerPadding}`, lineWidth));
			}
		}
	}

	// A block with neither header nor content still marks its place with a bare rail row.
	if (lines.length === 0) lines.push(padToWidth(rail(theme.boxSharp.vertical), lineWidth));
	return lines;
}

/**
 * Cached wrapper around `renderOutputBlock`.
 *
 * Since output blocks are re-rendered on every frame (via `render(width)` closures),
 * but their content rarely changes, this cache avoids redundant `visibleWidth()` and
 * `padding()` computations on ~99% of render calls.
 */
export class CachedOutputBlock {
	#cache?: RenderCache;

	/** Render with caching. Returns cached result if options haven't changed. */
	render(options: OutputBlockOptions, theme: Theme): string[] {
		const key = this.#buildKey(options);
		if (this.#cache?.key === key) return this.#cache.lines;
		const lines = renderOutputBlock(options, theme);
		this.#cache = { key, lines };
		return lines;
	}

	/** Invalidate the cache, forcing a rebuild on next render. */
	invalidate(): void {
		this.#cache = undefined;
	}

	#buildKey(options: OutputBlockOptions): bigint {
		const h = new Hasher();
		h.u32(options.width);
		h.optional(options.header);
		h.optional(options.headerMeta);
		h.optional(options.state);
		h.bool(isTerminalGraphicsFallbackActive());
		if (options.sections) {
			for (const s of options.sections) {
				h.optional(s.label);
				for (const line of s.lines) {
					h.str(line);
				}
			}
		}
		return h.digest();
	}
}
