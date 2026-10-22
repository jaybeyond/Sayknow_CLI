/**
 * Pure CLI metadata leaf.
 *
 * The actual `skc` entry (`packages/coding-agent/src/cli.ts`) must stay inert on
 * import: no directory resolution, logger construction, NSS lookup, native load
 * or environment probing may run before argv routing. `dirs.ts` performs all of
 * those at module scope, so the handful of constants the entry really needs live
 * here and `dirs.ts` re-exports them for its existing callers.
 *
 * Only build-time package metadata may be imported here.
 */

import { engines, version } from "../package.json" with { type: "json" };

/** App name (e.g. "skc") */
export const APP_NAME: string = "skc";

/** Version (e.g. "1.0.0") */
export const VERSION: string = version;

/** Minimum Bun version */
export const MIN_BUN_VERSION: string = engines.bun.replace(/[^0-9.]/g, "");

/**
 * Build the diagnostic shown when the Bun runtime executing `skc` is older
 * than {@link MIN_BUN_VERSION}. This is the most common Windows native-install
 * failure (issue #525): `bun install -g sayknow-cli` probes a recent Bun while
 * the `skc` launcher resolves an older Bun still on PATH. The message names the
 * exact detected runtime path and gives a platform-specific upgrade + PATH fix
 * instead of a bare `bun upgrade`.
 *
 * Pure and platform-parameterized so it can be unit-tested cross-platform.
 */
export function formatBunRuntimeError(opts: {
	currentVersion: string;
	minVersion: string;
	execPath?: string;
	platform?: NodeJS.Platform;
}): string {
	const platform = opts.platform ?? process.platform;
	const lines = [
		`error: ${APP_NAME} requires Bun >= ${opts.minVersion}, but the running Bun is v${opts.currentVersion}.`,
	];
	if (opts.execPath) {
		lines.push(`  detected Bun runtime: ${opts.execPath}`);
	}
	if (platform === "win32") {
		lines.push(
			"",
			"The 'skc' launcher is using an older Bun than the one used to install it.",
			"Upgrade Bun, then restart your terminal so PATH and the runtime refresh:",
			"",
			'  powershell -c "irm bun.sh/install.ps1|iex"',
			"",
			"After restarting the terminal, verify both versions match:",
			"  bun --version",
			"  skc --version",
			"",
			"If 'skc' still loads the old runtime, make sure %USERPROFILE%\\.bun\\bin is",
			"first on PATH and remove any stale Bun installs shadowing it.",
		);
	} else {
		lines.push(
			"",
			"Upgrade Bun, then restart your terminal:",
			"  bun upgrade",
			"",
			"Then verify:",
			"  bun --version",
			"  skc --version",
		);
	}
	return `${lines.join("\n")}\n`;
}
