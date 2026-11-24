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
		const prompt = new RailMarkdown(text, color, rail);
		this.addChild(prompt);
		if (this.#viewportAnchorSource) this.setViewportAnchorSource(prompt, this.#viewportAnchorSource);
	}
}

/**
 * Markdown behind the user rail. It deliberately emits no OSC 133 shell-prompt
 * marks: terminals such as Tern treat a prompt mark as "the program exited" and
 * reset the Kitty keyboard flags SKC pushed, which breaks Shift+Enter.
 */
class RailMarkdown implements Component {
	#markdown: Markdown;
	#rail: () => string;

	constructor(text: string, color: (value: string) => string, rail: () => string) {
		this.#markdown = new Markdown(text, 0, 0, getMarkdownTheme(), { color });
		this.#rail = rail;
	}

	invalidate(): void {
		this.#markdown.invalidate();
	}

	#withRail(lines: string[]): string[] {
		const rail = this.#rail();
		return lines.map(line => `${rail} ${line}`);
	}

	#innerWidth(width: number): number {
		return Math.max(1, width - RAIL_WIDTH);
	}

	renderWithViewportAnchorSource(width: number, source: ViewportAnchorSource): ViewportAnchorRender {
		const rendered = this.#markdown.renderWithViewportAnchorSource(this.#innerWidth(width), source);
		return { lines: this.#withRail(rendered.lines), anchors: rendered.anchors };
	}
	render(width: number): string[] {
		return this.#withRail(this.#markdown.render(this.#innerWidth(width)));
	}
}
