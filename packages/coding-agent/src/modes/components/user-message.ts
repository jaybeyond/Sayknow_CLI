import {
	type Component,
	Container,
	Markdown,
	Spacer,
	Text,
	type ViewportAnchorRender,
	type ViewportAnchorSource,
} from "@sayknow-cli/tui";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";

// OSC 133 shell integration: marks prompt zones for terminal multiplexers
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/** Columns taken by the rail glyph plus the gap before the prompt text. */
const RAIL_WIDTH = 2;

/**
 * Component that renders a user message: the prompt sits on the transcript
 * background behind an accent rail instead of inside a filled bubble, so the
 * user's turns read as margin notes rather than cards.
 */
export class UserMessageComponent extends Container {
	#viewportAnchorSource?: ViewportAnchorSource;

	constructor(text: string, synthetic = false, viewportAnchorId?: string) {
		super();
		if (viewportAnchorId) this.#viewportAnchorSource = { id: viewportAnchorId };
		const color = synthetic
			? (value: string) => theme.fg("dim", value)
			: (value: string) => theme.fg("userMessageText", value);
		// Resolved per render so a /theme switch recolors prompts already in the transcript.
		const rail = () => theme.fg(synthetic ? "dim" : "accent", theme.rail.user);
		this.addChild(new Spacer(1));
		// A replayed prompt is not something the user just typed; say so once, quietly.
		if (synthetic) this.addChild(new Text(`${rail()} ${theme.fg("dim", "replay")}`, 0, 0));
		const prompt = new PromptZoneMarkdown(text, color, rail);
		this.addChild(prompt);
		if (this.#viewportAnchorSource) this.setViewportAnchorSource(prompt, this.#viewportAnchorSource);
	}
}

class PromptZoneMarkdown implements Component {
	#markdown: Markdown;
	#rail: () => string;

	constructor(text: string, color: (value: string) => string, rail: () => string) {
		this.#markdown = new Markdown(text, 0, 0, getMarkdownTheme(), { color });
		this.#rail = rail;
	}

	invalidate(): void {
		this.#markdown.invalidate();
	}

	#withRailAndPromptZone(lines: string[]): string[] {
		if (lines.length === 0) return lines;
		const rail = this.#rail();
		const zoned = lines.map(line => `${rail} ${line}`);
		zoned[0] = OSC133_ZONE_START + zoned[0];
		zoned[zoned.length - 1] = `${zoned[zoned.length - 1]}${OSC133_ZONE_END}${OSC133_ZONE_FINAL}`;
		return zoned;
	}

	#innerWidth(width: number): number {
		return Math.max(1, width - RAIL_WIDTH);
	}

	renderWithViewportAnchorSource(width: number, source: ViewportAnchorSource): ViewportAnchorRender {
		const rendered = this.#markdown.renderWithViewportAnchorSource(this.#innerWidth(width), source);
		return { lines: this.#withRailAndPromptZone(rendered.lines), anchors: rendered.anchors };
	}
	render(width: number): string[] {
		return this.#withRailAndPromptZone(this.#markdown.render(this.#innerWidth(width)));
	}
}
