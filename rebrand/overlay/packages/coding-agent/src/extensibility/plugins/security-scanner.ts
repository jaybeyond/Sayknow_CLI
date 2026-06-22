// Regex-based, false-positive-prone — ADVISORY ONLY. Never hard-block by default.

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";

import type { DoctorCheck } from "./types";

// ─── Types ───────────────────────────────────────────────────────────────────

export type RiskLevel = "none" | "low" | "medium" | "high";

export type FindingCategory =
	| "credential"
	| "execution"
	| "network"
	| "obfuscation"
	| "package_install"
	| "persistence";

export interface SecurityFinding {
	category: FindingCategory;
	id: string;
	label: string;
	severity: "low" | "medium" | "high";
	file: string;
	line?: number;
	snippet?: string;
}

export interface ScanReport {
	findings: SecurityFinding[];
	networkUrls: string[];
	riskLevel: RiskLevel;
	score: number;
	reasoning: string;
	recommendation: string;
}

// ─── Rule definitions ─────────────────────────────────────────────────────────

interface ScanRule {
	id: string;
	label: string;
	pattern: RegExp;
	category: FindingCategory;
	severity: "low" | "medium" | "high";
}

const CREDENTIAL_RULES: ScanRule[] = [
	{
		id: "credential_keyword",
		label: "Hardcoded credential keyword (API key/token/secret)",
		pattern: /\b(api[_-]?key|secret|token|private[_-]?key|access[_-]?key|auth[_-]?token|bearer)\b/i,
		category: "credential",
		severity: "medium",
	},
	{
		id: "credential_access",
		label: "Environment variable access (process.env / os.environ)",
		pattern: /\b(os\.environ|getenv|process\.env|dotenv|load_dotenv)\b/i,
		category: "credential",
		severity: "low",
	},
	{
		id: "crypto_wallet",
		label: "Cryptocurrency wallet reference (wallet/seed/mnemonic)",
		pattern: /\b(wallet\.dat|keystore|mnemonic|seed phrase|private key|ledger|trezor|metamask)\b/i,
		category: "credential",
		severity: "high",
	},
	{
		id: "ssh_access",
		label: "SSH key / config access",
		pattern: /(~\/.ssh|\\.ssh|id_rsa|id_ed25519|authorized_keys)/i,
		category: "credential",
		severity: "medium",
	},
	{
		id: "cloud_credentials",
		label: "Cloud credential file reference (AWS / GCloud / Azure)",
		pattern: /(\.aws\/credentials|\.aws\/config|\.config\/gcloud|\.azure\/)/i,
		category: "credential",
		severity: "medium",
	},
	{
		id: "browser_data",
		label: "Browser sensitive data access (cookies/passwords)",
		pattern: /(Login Data|Chrome\/User Data|Firefox\/Profiles|Brave\/User Data)/i,
		category: "credential",
		severity: "medium",
	},
];

const EXEC_RULES: ScanRule[] = [
	{
		id: "download_exec",
		label: "Download-then-execute pattern (curl|wget piped to shell)",
		pattern: /(curl\s+.*\|\s*(bash|sh)|wget\s+.*\|\s*(bash|sh)|powershell\s+.*-c|Invoke-Expression)/i,
		category: "execution",
		severity: "high",
	},
	{
		id: "shell_exec",
		label: "Arbitrary system command execution (shell/subprocess)",
		pattern: /\b(subprocess\.Popen|os\.system|popen|child_process\.exec|Runtime\.getRuntime\(\)\.exec)\b/i,
		category: "execution",
		severity: "medium",
	},
	{
		id: "dynamic_exec",
		label: "Dynamic code loading (eval / import)",
		pattern: /\b(eval\(|__import__|importlib|dlopen)\b/i,
		category: "execution",
		severity: "medium",
	},
];

const PERSISTENCE_RULES: ScanRule[] = [
	{
		id: "persistence",
		label: "Background persistence / scheduled job (cron/systemd/launchd)",
		pattern: /\b(cron|crontab|@reboot|systemd|launchd\.plist|schtasks)\b/i,
		category: "persistence",
		severity: "high",
	},
];

const OBFUSCATION_RULES: ScanRule[] = [
	{
		id: "obfuscation_encoding",
		label: "Obfuscation / encoding (base64 / hex / XOR)",
		pattern: /\b(base64|atob|btoa|fromCharCode|rot13|xor|unescape|eval\(atob)\b/i,
		category: "obfuscation",
		severity: "medium",
	},
	{
		id: "geo_evasion",
		label: "Locale/timezone evasion pattern",
		pattern: /(timezone|Intl\.DateTimeFormat|locale|LANG=)\b/i,
		category: "obfuscation",
		severity: "low",
	},
];

const PACKAGE_INSTALL_RULES: ScanRule[] = [
	{
		id: "npm_install",
		label: "npm install invocation",
		pattern: /\b(npm\s+install|npm\s+i\s|npx\s)/i,
		category: "package_install",
		severity: "low",
	},
	{
		id: "pip_install",
		label: "pip install invocation",
		pattern: /\b(pip\s+install|pip3\s+install|python\s+-m\s+pip)\b/i,
		category: "package_install",
		severity: "low",
	},
	{
		id: "apt_install",
		label: "apt-get install invocation",
		pattern: /\b(apt-get\s+install|apt\s+install)\b/i,
		category: "package_install",
		severity: "low",
	},
	{
		id: "brew_install",
		label: "brew install invocation",
		pattern: /\b(brew\s+install)\b/i,
		category: "package_install",
		severity: "low",
	},
];

const ALL_RULES: ScanRule[] = [
	...CREDENTIAL_RULES,
	...EXEC_RULES,
	...PERSISTENCE_RULES,
	...OBFUSCATION_RULES,
	...PACKAGE_INSTALL_RULES,
];

const URL_REGEX = /https?:\/\/[^\s)\]"'<>]+/gi;

const TEXT_EXTS = new Set([
	".md",
	".py",
	".js",
	".ts",
	".tsx",
	".sh",
	".json",
	".yaml",
	".yml",
	".toml",
	".txt",
	".env",
	".ini",
	".conf",
	".rb",
	".go",
	".java",
	".html",
	".css",
	".xml",
	".jsx",
	".mjs",
	".cjs",
]);

const SKIP_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	"__pycache__",
	".venv",
	"venv",
	".idea",
	".vscode",
	"coverage",
]);

const ENV_FILENAMES = new Set([
	".env",
	".env.local",
	".env.production",
	".env.development",
	".env.test",
	".env.example",
	"config.json",
	"secrets.json",
]);

const MAX_FILE_SIZE = 2_000_000; // 2 MB

const SNIPPET_MAX_LEN = 120;

// ─── Score deduction per unique category ─────────────────────────────────────

function deductionForCategory(category: FindingCategory): number {
	switch (category) {
		case "execution":
			return 25;
		case "persistence":
			return 20;
		case "credential":
			return 15;
		case "obfuscation":
			return 10;
		case "network":
			return 5;
		case "package_install":
			return 5;
	}
}

// ─── Risk thresholds ──────────────────────────────────────────────────────────
//
// Flags with inherently high risk elevate the level regardless of score.
// Otherwise: score ≤ 50 → high, ≤ 75 → medium, ≤ 90 → low, 91-100 → none.

const HIGH_FLAGS = new Set(["download_exec", "persistence", "crypto_wallet"]);
const MEDIUM_FLAGS = new Set([
	"shell_exec",
	"dynamic_exec",
	"ssh_access",
	"cloud_credentials",
	"browser_data",
	"obfuscation_encoding",
	"geo_evasion",
]);

function determineRiskLevel(flagIds: Set<string>, score: number, networkCount: number): RiskLevel {
	for (const f of HIGH_FLAGS) {
		if (flagIds.has(f)) return "high";
	}
	for (const f of MEDIUM_FLAGS) {
		if (flagIds.has(f)) return "medium";
	}
	if (networkCount > 0) return "medium";
	if (flagIds.size === 0) return "none";
	if (score <= 50) return "high";
	if (score <= 75) return "medium";
	if (score <= 90) return "low";
	// Findings are present here (the flagIds.size === 0 case returned "none" above), so a
	// single low-weight pattern (e.g. a package-install / supply-chain marker scoring 95)
	// still surfaces as an advisory instead of being silently suppressed.
	return "low";
}

function buildReasoning(flagIds: Set<string>, networkCount: number): string {
	const reasons: string[] = [];
	if (flagIds.has("download_exec")) reasons.push("download-then-execute pattern detected");
	if (flagIds.has("persistence")) reasons.push("background persistence / scheduled job");
	if (flagIds.has("crypto_wallet")) reasons.push("cryptocurrency wallet / private key access");
	if (flagIds.has("shell_exec")) reasons.push("arbitrary system command execution");
	if (flagIds.has("dynamic_exec")) reasons.push("dynamic code execution (eval/import)");
	if (flagIds.has("ssh_access") || flagIds.has("cloud_credentials"))
		reasons.push("SSH key or cloud credential access");
	if (flagIds.has("browser_data")) reasons.push("browser sensitive data access");
	if (flagIds.has("obfuscation_encoding")) reasons.push("code obfuscation / encoding signs");
	if (networkCount > 2) reasons.push(`multiple external connections (${networkCount})`);
	else if (networkCount > 0) reasons.push("external network URLs present");
	return reasons.length > 0 ? reasons.join("; ") : "";
}

function buildRecommendation(riskLevel: RiskLevel): string {
	switch (riskLevel) {
		case "high":
			return "HIGH RISK: Do not install in environments with real credentials. Test only in an isolated sandbox.";
		case "medium":
			return "SUSPICIOUS: Test in an isolated environment and verify network traffic before activating.";
		case "low":
			return "LOW RISK: No clearly malicious patterns detected. Follow least-privilege principles.";
		case "none":
			return "No security concerns detected.";
	}
}

// ─── Walker ───────────────────────────────────────────────────────────────────

async function walkDir(
	dir: string,
	rootDir: string,
	callback: (relPath: string, content: string, absPath: string) => void,
): Promise<void> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		const fullPath = join(dir, entry.name);

		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			await walkDir(fullPath, rootDir, callback);
		} else if (entry.isFile()) {
			const ext = extname(entry.name).toLowerCase();
			const isText = TEXT_EXTS.has(ext) || ENV_FILENAMES.has(entry.name);
			if (!isText) continue;

			try {
				const info = await stat(fullPath);
				if (info.size > MAX_FILE_SIZE) continue;
			} catch {
				continue;
			}

			try {
				const content = await readFile(fullPath, "utf-8");
				const relPath = relative(rootDir, fullPath);
				callback(relPath, content, fullPath);
			} catch {
				// ignore unreadable files
			}
		}
	}
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Recursively scan `dir` for risky patterns.
 * Never throws — on any top-level error returns an empty safe report.
 */
export async function scanPluginDir(dir: string): Promise<ScanReport> {
	try {
		const findings: SecurityFinding[] = [];
		const networkUrls: string[] = [];
		const flagIds = new Set<string>();
		const seenFlagFiles = new Map<string, Set<string>>(); // flagId -> set of relPaths already recorded

		await walkDir(dir, dir, (relPath, content) => {
			// Sensitive file detection
			if (ENV_FILENAMES.has(basename(relPath))) {
				findings.push({
					category: "credential",
					id: "sensitive_file",
					label: `Sensitive config file present: ${relPath}`,
					severity: "medium",
					file: relPath,
				});
				flagIds.add("sensitive_file");
			}

			// Per-line rule matching
			const lines = content.split("\n");
			for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
				const line = lines[lineIdx];
				for (const rule of ALL_RULES) {
					if (!rule.pattern.test(line)) continue;
					// Reset lastIndex for global regexes
					rule.pattern.lastIndex = 0;

					const fileSet = seenFlagFiles.get(rule.id) ?? new Set<string>();
					seenFlagFiles.set(rule.id, fileSet);
					// One finding per (rule.id, file) pair to avoid noise
					if (fileSet.has(relPath)) continue;
					fileSet.add(relPath);

					flagIds.add(rule.id);
					const snippet = line.trim().slice(0, SNIPPET_MAX_LEN);
					findings.push({
						category: rule.category,
						id: rule.id,
						label: rule.label,
						severity: rule.severity,
						file: relPath,
						line: lineIdx + 1,
						snippet,
					});
				}
				// Reset all global regexes after each line
				for (const rule of ALL_RULES) rule.pattern.lastIndex = 0;

				// URL extraction (not per-rule deduplicated)
				URL_REGEX.lastIndex = 0;
				for (const urlMatch of line.matchAll(URL_REGEX)) {
					if (!networkUrls.includes(urlMatch[0])) networkUrls.push(urlMatch[0]);
				}
			}
		});

		// Calculate score
		const seenCategories = new Set<FindingCategory>();
		let deduction = 0;
		for (const f of findings) {
			if (!seenCategories.has(f.category)) {
				seenCategories.add(f.category);
				deduction += deductionForCategory(f.category);
			}
		}
		const score = Math.max(0, Math.min(100, 100 - deduction));
		const riskLevel = determineRiskLevel(flagIds, score, networkUrls.length);

		return {
			findings,
			networkUrls,
			riskLevel,
			score,
			reasoning: buildReasoning(flagIds, networkUrls.length),
			recommendation: buildRecommendation(riskLevel),
		};
	} catch {
		return { findings: [], networkUrls: [], riskLevel: "none", score: 0, reasoning: "", recommendation: "" };
	}
}

/**
 * Convert a ScanReport into DoctorCheck entries for the plugin health check.
 * Returns [] when riskLevel is "none".
 * NEVER emits status:"error" — advisory only.
 */
export function toDoctorChecks(pluginName: string, report: ScanReport): DoctorCheck[] {
	if (report.riskLevel === "none") return [];

	const topFindings = report.findings.slice(0, 5);
	const topLines = topFindings.map(f => `${f.id}: ${f.file}${f.line !== undefined ? `:${f.line}` : ""}`).join(", ");

	const message =
		`risk=${report.riskLevel} score=${report.score}` +
		(topLines ? ` | ${topLines}` : "") +
		(report.findings.length > 5 ? ` (+${report.findings.length - 5} more)` : "");

	return [
		{
			name: `plugin:${pluginName}:security`,
			status: "warning",
			message,
		},
	];
}
