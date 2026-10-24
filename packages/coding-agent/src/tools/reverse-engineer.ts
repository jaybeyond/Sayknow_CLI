/**
 * `reverse_engineer` — REA (Reverse Engineer Anything, https://github.com/morluto/rea, MIT) as a
 * built-in tool for "build something like this" requests.
 *
 * REA ships as the `rea-agents` npm package. SKC does not bundle it: with Playwright, Frida and
 * node-pty its install tree is about 230 MB, and its MCP server advertises 207 tools whose input
 * schemas alone are about 720 KB. This tool instead runs the pinned release through npx/bunx on
 * demand (cached after the first call), exposes a vetted subset of its CLI, and keeps the model's
 * view of each result small while the full result is saved for follow-up commands.
 */
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@sayknow-cli/agent-core";
import { $which, prompt, untilAborted } from "@sayknow-cli/utils";
import * as z from "zod/v4";
import reverseEngineerDescription from "../prompts/tools/reverse-engineer.md" with { type: "text" };
import type { ToolSession } from ".";
import { publishExplicitArtifactText } from "./explicit-artifact";
import type { OutputMeta } from "./output-meta";
import { ToolAbortError, ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";
import { wrapUntrustedContent } from "./untrusted-content";

export const REA_PACKAGE = "rea-agents";
/** Pinned so the command list below always matches the CLI that runs. */
export const REA_VERSION = "6.7.0";

/**
 * Commands of rea-agents@6.7.0 the tool may run. Left out on purpose: commands that change the
 * host, a device, or an analysis database (`setup`, `uninstall`, `update`, `annotate-native-function`,
 * adb install/uninstall/push/start/stop), unrestricted debugger or Rizin/Cutter consoles, and
 * commands that drive or instrument the user's own running apps (`capture-native-ui-scenario`,
 * `capture-process`, `observe-native-calls`).
 */
export const REA_COMMANDS = [
	"address-to-file-offset",
	"analyze",
	"analyze-javascript-application",
	"analyze-web-bundle",
	"build-reconstruction-obligation-ledger",
	"capabilities",
	"capture-adb-screen",
	"capture-browser-scenario",
	"capture-electron-scenario",
	"capture-web-screenshot",
	"collect-adb-bugreport",
	"compare",
	"compare-application-versions",
	"compare-javascript-export-shapes",
	"compare-managed-members",
	"compare-process-captures",
	"compare-source-to-bundle",
	"compare-wasm-interfaces",
	"compare-web-captures",
	"compare-web-screenshots",
	"decode-android-resources",
	"decode-interface-builder",
	"decode-signal-recording",
	"decompile",
	"decompile-jeb-item",
	"demangle-swift",
	"discover-webmcp-tools",
	"doctor",
	"evaluate-reconstruction-coverage",
	"evidence-export",
	"evidence-import",
	"export-web-scripts",
	"extract-artifact",
	"extract-firmware",
	"function",
	"identify-flutter-build",
	"import-managed-reconstruction",
	"import-reference-source",
	"inspect",
	"inspect-adb-client",
	"inspect-adb-device",
	"inspect-adb-display",
	"inspect-adb-package",
	"inspect-adb-window",
	"inspect-analysis-view",
	"inspect-android-class",
	"inspect-android-method",
	"inspect-android-package",
	"inspect-apktool-client",
	"inspect-artifact",
	"inspect-asset-catalog",
	"inspect-binary-layout",
	"inspect-dart-aot",
	"inspect-electron-fuses",
	"inspect-electron-page",
	"inspect-evidence-bundle",
	"inspect-evm-interface",
	"inspect-firmware-regions",
	"inspect-go-binary",
	"inspect-jeb-client",
	"inspect-keyed-archive",
	"inspect-macho",
	"inspect-managed-artifact",
	"inspect-managed-members",
	"inspect-managed-native-boundaries",
	"inspect-native-api",
	"inspect-native-data-type",
	"inspect-native-dispatch-metadata",
	"inspect-native-instruction",
	"inspect-native-load-image",
	"inspect-packet-capture",
	"inspect-packet-fields",
	"inspect-pcap-capture",
	"inspect-pcap-client",
	"inspect-pe-resources",
	"inspect-plist",
	"inspect-recorded-crash",
	"inspect-rust-binary",
	"inspect-signal-decoders",
	"inspect-signature",
	"inspect-sqlite-database",
	"inspect-wasm-artifact",
	"inspect-web-event-listeners",
	"inspect-web-network-capture",
	"inspect-web-page",
	"inspect-with-objdump",
	"instructions",
	"instrument-with-frida",
	"list-adb-devices",
	"list-adb-directory",
	"list-adb-features",
	"list-adb-packages",
	"list-adb-processes",
	"list-adb-services",
	"list-architectures",
	"list-browser-targets",
	"list-cutter-sessions",
	"list-electron-targets",
	"list-frida-devices",
	"list-frida-processes",
	"list-javascript-runtime-targets",
	"list-jeb-units",
	"list-objdump-architectures",
	"observe-javascript-runtime",
	"observe-native-ui",
	"observe-web-execution",
	"observe-web-session",
	"open-jeb-project",
	"project-android-application-graph",
	"project-apple-application-graph",
	"project-harmony-application-graph",
	"project-managed-application-graph",
	"providers",
	"pull-adb-file",
	"pull-adb-package",
	"read-adb-logcat",
	"read-adb-setting",
	"read-bytes",
	"reconcile-javascript-runtime",
	"recover-javascript-sources",
	"resolve-adb-packages",
	"resolve-native-call-targets",
	"search",
	"search-android-classes",
	"search-bytes",
	"trace",
	"trace-android-references",
	"trace-application-feature",
	"trace-dylib-resolution",
	"trace-javascript-semantics",
	"trace-native-ui-action",
	"trace-native-values",
	"trace-web-module-imports",
	"trace-web-source-location",
	"verify-managed-native-boundaries",
	"xrefs",
] as const;

const COMMAND_SET = new Set<string>(REA_COMMANDS);
const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_TIMEOUT_SECONDS = 1800;
/** Strings longer than this (screenshots, script bodies, DOM dumps) are elided from the model view. */
const MAX_INLINE_STRING = 2000;
const MAX_VISIBLE_CHARS = 24_000;

const BROWSER_CANDIDATES: Record<string, string[]> = {
	darwin: [
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
	],
	linux: [
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/usr/bin/microsoft-edge",
		"/snap/bin/chromium",
	],
	win32: [
		"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
		"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
	],
};

const reverseEngineerSchema = z
	.object({
		op: z.enum(["run", "help", "browsers"] as const).describe("operation"),
		command: z.string().describe("REA command in kebab-case, e.g. analyze-javascript-application").optional(),
		args: z.array(z.string()).describe("positional arguments and flags, one element each").optional(),
		timeout: z.number().describe("seconds before the command is stopped (default 300, max 1800)").optional(),
	})
	.strict();

type ReverseEngineerInput = z.infer<typeof reverseEngineerSchema>;

export interface ReverseEngineerToolDetails {
	meta?: OutputMeta;
	op: ReverseEngineerInput["op"];
	command?: string;
	exitCode?: number;
	savedPath?: string;
}

export interface ReaRunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export type ReaRunner = (
	argv: string[],
	options: { cwd: string; signal?: AbortSignal; timeoutMs: number },
) => Promise<ReaRunResult>;

export interface ReverseEngineerDeps {
	which?: (command: string) => string | null | undefined;
	run?: ReaRunner;
	fileExists?: (filePath: string) => Promise<boolean>;
	listDir?: (dir: string) => Promise<string[]>;
	homeDir?: string;
	platform?: NodeJS.Platform;
}

/** Package-runner argv prefix that starts the pinned REA release, or null when none is installed. */
export function reaRunnerArgv(which: (command: string) => string | null | undefined): string[] | null {
	const spec = `${REA_PACKAGE}@${REA_VERSION}`;
	if (which("npx")) return ["npx", "-y", spec];
	if (which("bunx")) return ["bunx", spec];
	return null;
}

const defaultRun: ReaRunner = async (argv, { cwd, signal, timeoutMs }) => {
	const timeout = AbortSignal.timeout(timeoutMs);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const child = Bun.spawn(argv, {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
		signal: combined,
		env: { ...process.env, NO_COLOR: "1", CI: "1" },
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode: exitCode ?? 1, stdout, stderr, timedOut: timeout.aborted && !signal?.aborted };
};

/** Replace long strings so a screenshot or script body cannot flood the context. */
export function elideLargeStrings(value: unknown): unknown {
	if (typeof value === "string") {
		return value.length > MAX_INLINE_STRING
			? `${value.slice(0, 200)}… [${value.length - 200} more chars elided; see saved result]`
			: value;
	}
	if (Array.isArray(value)) return value.map(elideLargeStrings);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, elideLargeStrings(entry)]));
	}
	return value;
}

export function summarizeReaOutput(stdout: string): string {
	let text: string;
	try {
		text = JSON.stringify(elideLargeStrings(JSON.parse(stdout)), null, 1);
	} catch {
		text = stdout.trim();
	}
	return text.length > MAX_VISIBLE_CHARS
		? `${text.slice(0, MAX_VISIBLE_CHARS)}\n… [output truncated at ${MAX_VISIBLE_CHARS} chars; read the saved result for the rest]`
		: text;
}

function lastLines(text: string, count: number): string {
	return text.trim().split("\n").slice(-count).join("\n");
}

export class ReverseEngineerTool implements AgentTool<typeof reverseEngineerSchema, ReverseEngineerToolDetails> {
	readonly name = "reverse_engineer";
	readonly summary =
		"Reverse engineer a referenced website, app, or binary (REA) to build one like it: clone, copy, make this, 참고해서 만들어줘, 똑같이 만들어줘";
	readonly loadMode = "discoverable";
	readonly label = "Reverse Engineer";
	readonly description = prompt.render(reverseEngineerDescription, { version: REA_VERSION });
	readonly parameters = reverseEngineerSchema;
	readonly strict = true;

	readonly #which: (command: string) => string | null | undefined;
	readonly #run: ReaRunner;
	readonly #fileExists: (filePath: string) => Promise<boolean>;
	readonly #listDir: (dir: string) => Promise<string[]>;
	readonly #homeDir: string;
	readonly #platform: NodeJS.Platform;

	constructor(
		private readonly session: ToolSession,
		deps: ReverseEngineerDeps = {},
	) {
		this.#which = deps.which ?? $which;
		this.#run = deps.run ?? defaultRun;
		this.#fileExists = deps.fileExists ?? (filePath => Bun.file(filePath).exists());
		this.#listDir =
			deps.listDir ??
			(async dir => {
				try {
					return await Array.fromAsync(new Bun.Glob("*").scan({ cwd: dir, onlyFiles: false }));
				} catch {
					return [];
				}
			});
		this.#homeDir = deps.homeDir ?? (process.env.HOME || process.env.USERPROFILE || "");
		this.#platform = deps.platform ?? process.platform;
	}

	static createIf(session: ToolSession): ReverseEngineerTool | null {
		if (!reaRunnerArgv($which)) return null;
		return new ReverseEngineerTool(session);
	}

	async execute(
		_toolCallId: string,
		params: ReverseEngineerInput,
		signal?: AbortSignal,
		_onUpdate?: unknown,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<ReverseEngineerToolDetails>> {
		return untilAborted(signal, async () => {
			switch (params.op) {
				case "run":
					return this.#runCommand(params, signal);
				case "help":
					return this.#help(params, signal);
				case "browsers":
					return this.#browsers();
				default:
					throw new ToolError(`Unsupported reverse_engineer op: ${String((params as { op: unknown }).op)}`);
			}
		});
	}

	#runner(): string[] {
		const argv = reaRunnerArgv(this.#which);
		if (!argv) throw new ToolError("REA needs npx (Node.js) or bunx (Bun) on PATH.");
		return argv;
	}

	#command(params: ReverseEngineerInput): string {
		const command = params.command?.trim();
		if (!command) throw new ToolError("command is required");
		if (!COMMAND_SET.has(command)) {
			throw new ToolError(
				`"${command}" is not an allowed REA command. Use kebab-case names such as analyze-javascript-application, capture-browser-scenario, export-web-scripts, analyze, decompile, or inspect-android-package.`,
			);
		}
		return command;
	}

	async #exec(argv: string[], signal: AbortSignal | undefined, timeoutSeconds: number | undefined) {
		throwIfAborted(signal);
		const seconds = Math.min(Math.max(Math.floor(timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS), 1), MAX_TIMEOUT_SECONDS);
		try {
			return await this.#run(argv, { cwd: this.session.cwd, signal, timeoutMs: seconds * 1000 });
		} catch (error) {
			if (signal?.aborted) throw new ToolAbortError();
			throw error;
		} finally {
			throwIfAborted(signal);
		}
	}

	async #runCommand(
		params: ReverseEngineerInput,
		signal: AbortSignal | undefined,
	): Promise<AgentToolResult<ReverseEngineerToolDetails>> {
		const command = this.#command(params);
		const args = params.args ?? [];
		const argv = [...this.#runner(), command, ...args];
		if (!args.includes("--format")) argv.push("--format", "json");
		const result = await this.#exec(argv, signal, params.timeout);
		if (result.timedOut) {
			throw new ToolError(`rea ${command} did not finish within the timeout; raise timeout or narrow the request.`);
		}

		let savedPath: string | undefined;
		if (result.stdout.trim()) {
			const artifact = await this.session.allocateOutputArtifact?.("reverse_engineer");
			if (artifact?.path) {
				await publishExplicitArtifactText(artifact.path, result.stdout);
				savedPath = path.resolve(artifact.path);
			}
		}

		const header =
			result.exitCode === 0
				? `rea ${command} completed.`
				: `rea ${command} failed with exit code ${result.exitCode}.`;
		const lines = [header];
		if (savedPath) lines.push(`Saved full result: ${savedPath}`);
		if (result.stdout.trim()) lines.push("", summarizeReaOutput(result.stdout));
		else if (result.stderr.trim()) lines.push("", lastLines(result.stderr, 20));
		const details: ReverseEngineerToolDetails = { op: "run", command, exitCode: result.exitCode, savedPath };
		return toolResult<ReverseEngineerToolDetails>(details)
			.text(wrapUntrustedContent(lines.join("\n")))
			.done();
	}

	async #help(
		params: ReverseEngineerInput,
		signal: AbortSignal | undefined,
	): Promise<AgentToolResult<ReverseEngineerToolDetails>> {
		const command = this.#command(params);
		const runner = this.#runner();
		const usage = await this.#exec([...runner, command, "--help"], signal, params.timeout);
		const schema = await this.#exec([...runner, command, "--schema", "--format", "json"], signal, params.timeout);
		const text = [
			`# rea ${command}`,
			"",
			usage.stdout.trim() || lastLines(usage.stderr, 20),
			"",
			"## Input schema",
			summarizeReaOutput(schema.stdout) || lastLines(schema.stderr, 20),
		].join("\n");
		return toolResult<ReverseEngineerToolDetails>({ op: "help", command }).text(text).done();
	}

	async #browsers(): Promise<AgentToolResult<ReverseEngineerToolDetails>> {
		const found: string[] = [];
		for (const candidate of BROWSER_CANDIDATES[this.#platform] ?? []) {
			if (await this.#fileExists(candidate)) found.push(candidate);
		}
		for (const name of ["google-chrome", "chromium", "chromium-browser", "microsoft-edge"]) {
			const resolved = this.#which(name);
			if (resolved && !found.includes(resolved)) found.push(resolved);
		}
		found.push(...(await this.#playwrightBrowsers()));
		const text =
			found.length > 0
				? [
						"Chromium-family executables for capture-browser-scenario launch mode:",
						...found.map(f => `- ${f}`),
					].join("\n")
				: "No Chromium-family browser found. Install Google Chrome or run `npx playwright install chromium`, or connect to a running browser with list-browser-targets.";
		return toolResult<ReverseEngineerToolDetails>({ op: "browsers" }).text(text).done();
	}

	/** Browsers installed by Playwright (`npx playwright install chromium`). */
	async #playwrightBrowsers(): Promise<string[]> {
		const cacheDir =
			this.#platform === "darwin"
				? path.join(this.#homeDir, "Library", "Caches", "ms-playwright")
				: this.#platform === "linux"
					? path.join(this.#homeDir, ".cache", "ms-playwright")
					: undefined;
		if (!cacheDir || !this.#homeDir) return [];
		const relative =
			this.#platform === "darwin"
				? [
						"chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
						"chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
						"chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium",
						"chrome-mac/Chromium.app/Contents/MacOS/Chromium",
					]
				: ["chrome-linux64/chrome", "chrome-linux/chrome"];
		const found: string[] = [];
		const entries = (await this.#listDir(cacheDir))
			.filter(entry => /^chromium-\d+$/.test(entry))
			.sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
		for (const entry of entries) {
			for (const rel of relative) {
				const candidate = path.join(cacheDir, entry, rel);
				if (await this.#fileExists(candidate)) found.push(candidate);
			}
		}
		return found;
	}
}
