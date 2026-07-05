import { type Component, padding, truncateToWidth, visibleWidth } from "@sayknow-cli/tui";
import { theme } from "../theme/theme";

export class TwoColumnBody implements Component {
	constructor(
		private readonly leftPane: Component,
		private readonly rightPane: Component,
		private readonly maxHeight: number,
	) {}

	render(width: number): string[] {
		const leftWidth = Math.floor(width * 0.5);
		const separatorText = theme.fg("dim", ` ${theme.boxSharp.vertical} `);
		const separatorWidth = width - leftWidth > 3 ? visibleWidth(separatorText) : 0;
		const separator = separatorWidth > 0 ? separatorText : "";
		const rightWidth = Math.max(0, width - leftWidth - separatorWidth);
		const leftLines = this.leftPane.render(leftWidth);
		const rightLines = this.rightPane.render(rightWidth);
		const lineCount = Math.min(this.maxHeight, Math.max(leftLines.length, rightLines.length));
		const out: string[] = [];

		for (let i = 0; i < lineCount; i++) {
			const left = truncateToWidth(leftLines[i] ?? "", leftWidth);
			const leftPadded = left + padding(Math.max(0, leftWidth - visibleWidth(left)));
			const right = truncateToWidth(rightLines[i] ?? "", rightWidth);
			out.push(leftPadded + separator + right);
		}

		return out;
	}

	invalidate(): void {
		this.leftPane.invalidate?.();
		this.rightPane.invalidate?.();
	}
}
