import { Buffer } from "node:buffer";
import * as path from "node:path";

export const SKC_TMUX_LAUNCHED_ENV = "SKC_TMUX_LAUNCHED";

export interface WindowsPowerShellInnerCommandOptions {
	command: readonly string[];
	args?: readonly string[];
	environment?: Record<string, string>;
	tmuxExitMarkerPath?: string;
}

function powershellQuote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function buildPowerShellTmuxExitMarkerFinally(markerPath: string): string {
	const markerDir = path.win32.dirname(markerPath);
	return [
		"} finally {",
		"\ttry {",
		`\t\tNew-Item -ItemType Directory -Force -Path ${powershellQuote(markerDir)} -ErrorAction Stop | Out-Null`,
		"\t\t$__skcTmuxExitMarker = @{ schema_version = 1; source = 'tmux_inner_shell'; ended_at = (Get-Date).ToUniversalTime().ToString('o'); exit_code = $__skcTmuxExitCode } | ConvertTo-Json -Compress",
		`\t\tSet-Content -LiteralPath ${powershellQuote(markerPath)} -Value $__skcTmuxExitMarker -Encoding UTF8 -ErrorAction Stop`,
		"\t} catch {",
		"\t}",
		"}",
	].join("\n");
}

/** Builds the shared BOM-free UTF-16LE command for native Windows tmux-compatible panes. */
export function buildWindowsPowerShellInnerCommand({
	command,
	args = [],
	environment,
	tmuxExitMarkerPath,
}: WindowsPowerShellInnerCommandOptions): string {
	const envLines = Object.entries({ [SKC_TMUX_LAUNCHED_ENV]: "1", ...(environment ?? {}) }).map(
		([key, value]) => `$env:${key} = ${powershellQuote(value)}`,
	);
	const resolvedCommand = command.map(powershellQuote).join(" ");
	const innerArgs = args.map(powershellQuote).join(" ");
	const invocation = `& ${resolvedCommand} ${innerArgs}`;
	const exitLine = "if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 }";
	const script = tmuxExitMarkerPath
		? [
				...envLines,
				"$__skcTmuxExitCode = 1",
				"try {",
				`\t${invocation}`,
				"\tif ($null -ne $LASTEXITCODE) { $__skcTmuxExitCode = $LASTEXITCODE } else { $__skcTmuxExitCode = 1 }",
				buildPowerShellTmuxExitMarkerFinally(tmuxExitMarkerPath),
				"exit $__skcTmuxExitCode",
			].join("\n")
		: [...envLines, invocation, exitLine].join("\n");
	const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
	return `pwsh -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodedCommand}`;
}
