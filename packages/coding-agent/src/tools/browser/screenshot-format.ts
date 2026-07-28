import * as os from "node:os";
import * as path from "node:path";

import { formatDimensionNote, type ResizedImage } from "../../utils/image-resize";

function shortenPath(filePath: string): string {
	const home = os.homedir();
	if (!home) return filePath;
	// Require a separator boundary so a sibling that shares the home prefix
	// (e.g. "/home/woodyx/x" for home "/home/woody") is not corrupted into "~x/x".
	const boundary = home.endsWith(path.sep) ? home : home + path.sep;
	return filePath === home || filePath.startsWith(boundary) ? `~${filePath.slice(home.length)}` : filePath;
}

export function formatScreenshot(opts: {
	saveFullRes: boolean;
	savedMimeType: string;
	savedByteLength: number;
	dest: string;
	resized: ResizedImage;
}): string[] {
	const lines = ["Screenshot captured"];
	if (opts.saveFullRes) {
		lines.push(
			`Saved: ${opts.savedMimeType} (${(opts.savedByteLength / 1024).toFixed(2)} KB) to ${shortenPath(opts.dest)}`,
		);
		lines.push(
			`Model: ${opts.resized.mimeType} (${(opts.resized.buffer.length / 1024).toFixed(2)} KB, ${opts.resized.width}x${opts.resized.height})`,
		);
	} else {
		lines.push(`Format: ${opts.resized.mimeType} (${(opts.resized.buffer.length / 1024).toFixed(2)} KB)`);
		lines.push(`Dimensions: ${opts.resized.width}x${opts.resized.height}`);
	}
	const dimensionNote = formatDimensionNote(opts.resized);
	if (dimensionNote) {
		lines.push(dimensionNote);
	}
	return lines;
}
