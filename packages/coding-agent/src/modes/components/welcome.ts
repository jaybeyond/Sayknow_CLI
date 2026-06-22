import { type Component, padding, TERMINAL, truncateToWidth, visibleWidth } from "@sayknow-cli/tui";
import { APP_NAME } from "@sayknow-cli/utils";
import { t } from "../../i18n";
import { type ThemeColor, theme } from "../../modes/theme/theme";

export interface RecentSession {
	name: string;
	timeAgo: string;
}

export interface LspServerInfo {
	name: string;
	status: "ready" | "error" | "connecting";
	fileTypes: string[];
}

export type WelcomeLogoMode = "unicode" | "square" | "ascii";

/**
 * Sayknow-CLI launch surface: a blue-gradient SAYKNOW wordmark, compact
 * command affordances, and project signals — a distinct identity, not a
 * copy of another agent shell.
 */
export class WelcomeComponent implements Component {
	#animStart: number | null = null;
	#animTimer: NodeJS.Timeout | null = null;

	constructor(
		private readonly version: string,
		private modelName: string,
		private providerName: string,
		private recentSessions: RecentSession[] = [],
		private lspServers: LspServerInfo[] = [],
		private readonly logoMode: WelcomeLogoMode = "unicode",
	) {}

	invalidate(): void {}

	/**
	 * Play a one-shot intro that sweeps the gradient through every phase
	 * before settling on the resting frame. Safe to call multiple times —
	 * subsequent calls reset and replay.
	 */
	playIntro(requestRender: () => void): void {
		this.#stopAnimation();
		this.#animStart = performance.now();
		requestRender();
		this.#animTimer = setInterval(() => {
			const elapsed = performance.now() - (this.#animStart ?? 0);
			if (elapsed >= INTRO_MS) {
				this.#stopAnimation();
			}
			requestRender();
		}, INTRO_TICK_MS);
	}

	#stopAnimation(): void {
		if (this.#animTimer != null) {
			clearInterval(this.#animTimer);
			this.#animTimer = null;
		}
		this.#animStart = null;
	}

	setModel(modelName: string, providerName: string): void {
		this.modelName = modelName;
		this.providerName = providerName;
	}

	setRecentSessions(sessions: RecentSession[]): void {
		this.recentSessions = sessions;
	}

	setLspServers(servers: LspServerInfo[]): void {
		this.lspServers = servers;
	}

	render(termWidth: number): string[] {
		// Box dimensions - responsive with max width and small-terminal support
		const maxWidth = 100;
		const boxWidth = Math.min(maxWidth, Math.max(0, termWidth - 2));
		if (boxWidth < 4) {
			return [];
		}
		const dualContentWidth = boxWidth - 3; // 3 = │ + │ + │
		const preferredLeftCol = 36;
		const minLeftCol = 18; // wordmark plus Sayknow identity labels
		const minRightCol = 20;
		const modelPill = this.#pill(theme.icon.model || "model", this.modelName, "statusLineModel");
		const providerPill = this.#pill(theme.icon.package || "provider", this.providerName, "statusLinePath");
		const logoLines = this.#logoLines();
		const logoMinWidth = Math.max(...logoLines.map(line => visibleWidth(line)));
		const leftMinContentWidth = Math.max(
			minLeftCol,
			logoMinWidth,
			visibleWidth(t("welcome.tagline")),
			visibleWidth(modelPill),
			visibleWidth(providerPill),
		);
		const desiredLeftCol = Math.min(preferredLeftCol, Math.max(minLeftCol, Math.floor(dualContentWidth * 0.42)));
		const dualLeftCol =
			dualContentWidth >= minRightCol + 1
				? Math.min(desiredLeftCol, dualContentWidth - minRightCol)
				: Math.max(1, dualContentWidth - 1);
		const dualRightCol = Math.max(1, dualContentWidth - dualLeftCol);
		const showRightColumn = dualLeftCol >= leftMinContentWidth && dualRightCol >= minRightCol;
		const leftCol = showRightColumn ? dualLeftCol : boxWidth - 2;
		const rightCol = showRightColumn ? dualRightCol : 0;

		const logoColored = this.#currentLogoFrame(logoLines);

		// When no model is resolved yet, guide the user instead of showing "Unknown".
		const hasModel = this.modelName !== "Unknown" && this.modelName.length > 0;
		const identityTail = hasModel
			? [this.#centerText(modelPill, leftCol), this.#centerText(providerPill, leftCol)]
			: [
					this.#centerText(
						this.#pill(theme.icon.model || "model", t("welcome.chooseModel"), "statusLineModel"),
						leftCol,
					),
					this.#centerText(theme.fg("dim", t("welcome.modelHint")), leftCol),
				];

		// Left column - centered identity stack: wordmark, tagline, then model state.
		const leftLines = [
			"",
			...logoColored.map(l => this.#centerText(l, leftCol)),
			"",
			this.#centerText(theme.fg("muted", t("welcome.tagline")), leftCol),
			"",
			...identityTail,
		];

		// Right column separator
		const separatorWidth = Math.max(0, rightCol - 2); // padding on each side
		const separator = ` ${theme.fg("dim", theme.boxRound.horizontal.repeat(separatorWidth))}`;

		// Recent sessions content
		const sessionLines: string[] = [];
		if (this.recentSessions.length === 0) {
			sessionLines.push(` ${theme.fg("dim", t("welcome.noSessions"))}`);
		} else {
			// Reserve width for the bullet prefix (" • ") and the trailing " (timeAgo)"
			// so the relative time is never the part that gets truncated. The name
			// absorbs whatever space is left.
			const bulletPrefix = ` ${theme.md.bullet} `;
			const prefixWidth = visibleWidth(bulletPrefix);
			for (const session of this.recentSessions.slice(0, 3)) {
				const timeSuffixRaw = ` (${session.timeAgo})`;
				const timeWidth = visibleWidth(timeSuffixRaw);
				const nameBudget = Math.max(1, rightCol - prefixWidth - timeWidth);
				const nameVis = visibleWidth(session.name);
				const name = nameVis > nameBudget ? truncateToWidth(session.name, nameBudget) : session.name;
				sessionLines.push(
					`${theme.fg("dim", bulletPrefix)}${theme.fg("muted", name)}${theme.fg("dim", timeSuffixRaw)}`,
				);
			}
		}

		// LSP servers content
		const lspLines: string[] = [];
		if (this.lspServers.length === 0) {
			lspLines.push(` ${theme.fg("dim", t("welcome.noLsp"))}`);
		} else {
			for (const server of this.lspServers) {
				const icon =
					server.status === "ready"
						? theme.styledSymbol("status.success", "success")
						: server.status === "connecting"
							? theme.styledSymbol("status.pending", "muted")
							: theme.styledSymbol("status.error", "error");
				const exts = server.fileTypes.slice(0, 3).join(" ");
				lspLines.push(` ${icon} ${theme.fg("muted", server.name)} ${theme.fg("dim", exts)}`);
			}
		}

		// Workflow affordances: pad the command so descriptions align.
		const wf = (cmd: string, desc: string): string => {
			const pad = " ".repeat(Math.max(1, 17 - visibleWidth(cmd)));
			return ` ${theme.fg("accent", cmd)}${pad}${theme.fg("muted", desc)}`;
		};

		// Right column
		const rightLines = [
			` ${theme.bold(theme.fg("accent", t("welcome.workflows")))}`,
			wf("/deep-interview", t("welcome.wf.deepInterview")),
			wf("/ralplan", t("welcome.wf.ralplan")),
			wf("/ultragoal", t("welcome.wf.ultragoal")),
			wf("/team", t("welcome.wf.team")),
			separator,
			` ${theme.bold(theme.fg("accent", t("welcome.flowKeys")))}`,
			` ${theme.fg("dim", "/")}${theme.fg("muted", ` ${t("welcome.commands")}`)} ${theme.fg("dim", "·")} ${theme.fg(
				"dim",
				"#",
			)}${theme.fg("muted", ` ${t("welcome.actions")}`)}`,
			` ${theme.fg("dim", "!")}${theme.fg("muted", ` ${t("welcome.shell")}`)} ${theme.fg("dim", "·")} ${theme.fg("dim", "$")}${theme.fg(
				"muted",
				` ${t("welcome.python")}`,
			)}`,
			` ${theme.fg("dim", "?")}${theme.fg("muted", ` ${t("welcome.keymap")}`)} ${theme.fg("dim", "·")} ${theme.fg(
				"dim",
				"ctrl+l",
			)}${theme.fg("muted", ` ${t("welcome.model")}`)}`,
			` ${theme.fg("dim", "shift+tab")}${theme.fg("muted", ` ${t("welcome.reasoning")}`)}`,
			separator,
			` ${theme.bold(theme.fg("accent", t("welcome.projectPulse")))}`,
			...lspLines,
			separator,
			` ${theme.bold(theme.fg("accent", t("welcome.sessionTrail")))}`,
			...sessionLines,
			"",
		];

		// Border characters (dim)
		const hChar = theme.boxRound.horizontal;
		const h = theme.fg("dim", hChar);
		const v = theme.fg("dim", theme.boxRound.vertical);
		const tl = theme.fg("dim", theme.boxRound.topLeft);
		const tr = theme.fg("dim", theme.boxRound.topRight);
		const bl = theme.fg("dim", theme.boxRound.bottomLeft);
		const br = theme.fg("dim", theme.boxRound.bottomRight);

		const lines: string[] = [];

		// Top border with embedded title
		const title = ` ${APP_NAME} · Sayknow-CLI v${this.version} `;
		const titlePrefixRaw = hChar.repeat(3);
		const titleStyled = theme.fg("dim", titlePrefixRaw) + theme.fg("muted", title);
		const titleVisLen = visibleWidth(titlePrefixRaw) + visibleWidth(title);
		const titleSpace = boxWidth - 2;
		if (titleVisLen >= titleSpace) {
			lines.push(tl + truncateToWidth(titleStyled, titleSpace) + tr);
		} else {
			const afterTitle = titleSpace - titleVisLen;
			lines.push(tl + titleStyled + theme.fg("dim", hChar.repeat(afterTitle)) + tr);
		}

		// Content rows
		const maxRows = showRightColumn ? Math.max(leftLines.length, rightLines.length) : leftLines.length;
		for (let i = 0; i < maxRows; i++) {
			const left = this.#fitToWidth(leftLines[i] ?? "", leftCol);
			if (showRightColumn) {
				const right = this.#fitToWidth(rightLines[i] ?? "", rightCol);
				lines.push(v + left + v + right + v);
			} else {
				lines.push(v + left + v);
			}
		}
		// Bottom border
		if (showRightColumn) {
			lines.push(bl + h.repeat(leftCol) + theme.fg("dim", theme.boxSharp.teeUp) + h.repeat(rightCol) + br);
		} else {
			lines.push(bl + h.repeat(leftCol) + br);
		}

		return lines;
	}

	/** Center text within a given width */
	#centerText(text: string, width: number): string {
		const visLen = visibleWidth(text);
		if (visLen >= width) {
			return truncateToWidth(text, width);
		}
		const leftPad = Math.floor((width - visLen) / 2);
		const rightPad = width - visLen - leftPad;
		return padding(leftPad) + text + padding(rightPad);
	}

	/** Fit string to exact width with native ANSI/wide-glyph truncation and padding. */
	#fitToWidth(str: string, width: number): string {
		const visLen = visibleWidth(str);
		if (visLen > width) {
			return truncateToWidth(str, width, null, true);
		}
		return str + padding(width - visLen);
	}

	#pill(icon: string, text: string, color: ThemeColor): string {
		return `${theme.fg("borderMuted", "[")} ${theme.fg(color, icon)} ${theme.fg("muted", text)} ${theme.fg(
			"borderMuted",
			"]",
		)}`;
	}

	/** Pick the logo frame for the current intro phase, or the resting frame. */
	#currentLogoFrame(logoLines: readonly string[]): readonly string[] {
		if (this.#animStart == null) return REST_FRAMES[this.logoMode];
		const elapsed = performance.now() - this.#animStart;
		if (elapsed >= INTRO_MS) return REST_FRAMES[this.logoMode];
		// Ease-out cubic so the spin decelerates into the resting state.
		const progress = elapsed / INTRO_MS;
		const eased = 1 - (1 - progress) ** 3;
		// Sweep backward through INTRO_SWEEPS full rotations so the gradient
		// visibly spins multiple times. `eased == 1` → phase = 0 = resting frame.
		const phase = ((((1 - eased) * INTRO_SWEEPS) % 1) + 1) % 1;
		// Shine traverses the diagonal at a steady pace, decoupled from the
		// gradient phase so the two layers parallax. Strength fades out with
		// the same ease-out curve so the highlight is gone by the resting frame.
		const shinePos = (((progress * INTRO_SHINE_TRAVERSALS) % 1) + 1) % 1;
		const shineStrength = (1 - eased) ** 1.5;
		return gradientLogo(logoLines, phase, { strength: shineStrength, pos: shinePos });
	}

	#logoLines(): readonly string[] {
		return BRAND_LOGO;
	}
}

// biome-ignore format: preserve ASCII art layout
const BRAND_LOGO = [
	"╔═╗╔═╗╦ ╦╦╔═╔╗╔╔═╗╦ ╦",
	"╚═╗╠═╣╚╦╝╠╩╗║║║║ ║║║║",
	"╚═╝╩ ╩ ╩ ╩ ╩╝╚╝╚═╝╚╩╝",
];

/** Multi-stop palette for the blue-octopus diagonal gradient. */
const GRADIENT_STOPS: ReadonlyArray<readonly [number, number, number]> = [
	[6, 19, 33], // deep navy
	[11, 79, 138], // ocean
	[47, 155, 255], // octopus mantle blue
	[94, 200, 255], // bright tentacle blue
	[168, 224, 255], // sky highlight
];

/** 256-color ramp fallback when truecolor isn't available. */
const GRADIENT_RAMP_256 = [17, 18, 24, 31, 38, 75, 117];

/** Half-width of the shine highlight band, expressed in gradient-t units. */
const SHINE_HALF_WIDTH = 0.18;

interface ShineConfig {
	/** Overall opacity of the shine overlay, in [0, 1]. */
	strength: number;
	/** Center of the shine band along the diagonal, in [0, 1]. */
	pos: number;
}

/**
 * Apply a multi-stop diagonal gradient (bottom-left → top-right) plus an
 * optional sliding shine band across multi-line art. `phase` (0..1) shifts the
 * gradient along the diagonal, wrapping at 1. When `shine` is provided, a soft
 * white highlight is composited on top, centered at `shine.pos`.
 */
function gradientLogo(lines: readonly string[], phase = 0, shine?: ShineConfig): string[] {
	const reset = "\x1b[0m";
	const rows = lines.length;
	const cols = Math.max(...lines.map(l => l.length));
	// span+1 so `base` stays strictly < 1: avoids the wrap-around at the
	// far corner mapping back to t=0 (hot pink) on the resting frame.
	const span = Math.max(1, cols + rows - 1);
	const shineStrength = shine && shine.strength > 0 ? shine.strength : 0;
	const shinePos = shine ? shine.pos : 0;
	const colorAt = TERMINAL.trueColor
		? (t: number): string => {
				// 5-stop palette widens the visible color range and avoids the
				// deep-blue valley a naive HSL lerp falls into.
				const stops = GRADIENT_STOPS;
				const seg = t * (stops.length - 1);
				const i = Math.min(stops.length - 2, Math.floor(seg));
				const f = seg - i;
				const a = stops[i];
				const b = stops[i + 1];
				let r = a[0] + (b[0] - a[0]) * f;
				let g = a[1] + (b[1] - a[1]) * f;
				let bl = a[2] + (b[2] - a[2]) * f;
				if (shineStrength > 0) {
					const dist = Math.abs(t - shinePos);
					const intensity = Math.max(0, 1 - dist / SHINE_HALF_WIDTH) * shineStrength;
					if (intensity > 0) {
						r += (255 - r) * intensity;
						g += (255 - g) * intensity;
						bl += (255 - bl) * intensity;
					}
				}
				return `\x1b[38;2;${Math.round(r)};${Math.round(g)};${Math.round(bl)}m`;
			}
		: (t: number): string => {
				const ramp = GRADIENT_RAMP_256;
				let idx = Math.min(ramp.length - 1, Math.max(0, Math.floor(t * (ramp.length - 1) + 0.5)));
				if (shineStrength > 0) {
					const dist = Math.abs(t - shinePos);
					const intensity = Math.max(0, 1 - dist / SHINE_HALF_WIDTH) * shineStrength;
					// Promote to the brightest ramp slot when the shine band peaks here.
					if (intensity > 0.5) idx = ramp.length - 1;
				}
				return `\x1b[38;5;${ramp[idx]}m`;
			};
	return lines.map((line, y) => {
		let result = "";
		for (let x = 0; x < line.length; x++) {
			const char = line[x];
			if (char === " ") {
				result += char;
				continue;
			}
			// Diagonal: bottom-left (x=0, y=rows-1) → top-right (x=cols-1, y=0)
			const base = (x + (rows - 1 - y)) / span;
			const t = (((base + phase) % 1) + 1) % 1;
			result += colorAt(t) + char + reset;
		}
		return result;
	});
}

/** Total length of the intro animation. */
const INTRO_MS = 3000;
/** Render cadence during the intro (~30fps). */
const INTRO_TICK_MS = 33;
/** Number of full gradient rotations the sweep performs before settling. */
const INTRO_SWEEPS = 2.5;
/** Number of times the shine highlight crosses the diagonal across the intro. */
const INTRO_SHINE_TRAVERSALS = 3;

/** Resting gradient frames, cached for re-renders outside of the intro. */
const REST_FRAMES: Record<WelcomeLogoMode, readonly string[]> = {
	unicode: gradientLogo(BRAND_LOGO, 0),
	square: gradientLogo(BRAND_LOGO, 0),
	ascii: gradientLogo(BRAND_LOGO, 0),
};
