/**
 * Update CLI command handler.
 *
 * Handles `skc update` to check for and install updates.
 * Uses bun if available, otherwise downloads binary from GitHub releases.
 */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { $which, APP_NAME, isEnoent, VERSION } from "@sayknow-cli/utils";
import { $ } from "bun";
import chalk from "chalk";
import { installDefaultSkcDefinitions } from "../defaults/skc-defaults";
import { theme } from "../modes/theme/theme";

const RELEASE_REPO = "jaybeyond/Sayknow_CLI";
const PACKAGE = "@sayknow-cli/coding-agent";
const NPM_WRAPPER_PACKAGE = "sayknow-cli";
const NPM_MANAGED_PACKAGES = [NPM_WRAPPER_PACKAGE, PACKAGE] as const;
const BINARY_MANIFEST_ASSET = "sayknow-release-binaries-v1.json";
const BINARY_SHA256_ASSET = "sayknow-release-binaries.sha256";

interface ReleaseInfo {
	tag: string;
	version: string;
}

/** Result from running the installed binary and parsing its reported version. */
export interface InstalledVersionVerification {
	ok: boolean;
	actual?: string;
	path?: string;
	smokeTestFailed?: boolean;
	smokeTestOutput?: string;
	cleanupWarning?: string;
}

export interface PackageManagerUpdateResult {
	exitCode: number | null;
	text: () => string;
}

export type PackageManagerUpdateRunner = (expectedVersion: string) => Promise<PackageManagerUpdateResult>;

export interface PackageManagerUpdateOptions {
	managerName: string;
	expectedVersion: string;
	runInstall: PackageManagerUpdateRunner;
	verifyInstalledRuntime: (expectedVersion: string) => Promise<InstalledVersionVerification>;
	printRecoveredVerification?: (expectedVersion: string) => void;
}

/** Paths and verifier used while replacing a downloaded binary update. */
export interface BinaryReplacementOptions {
	targetPath: string;
	tempPath: string;
	backupPath: string;
	expectedVersion: string;
	verifyInstalledVersion: (expectedVersion: string) => Promise<InstalledVersionVerification>;
}

/**
 * Parse update subcommand arguments.
 * Returns undefined if not an update command.
 */
export function parseUpdateArgs(args: string[]): { force: boolean; check: boolean } | undefined {
	if (args.length === 0 || args[0] !== "update") {
		return undefined;
	}

	return {
		force: args.includes("--force") || args.includes("-f"),
		check: args.includes("--check") || args.includes("-c"),
	};
}

async function getBunGlobalBinDir(): Promise<string | undefined> {
	if (!$which("bun")) return undefined;
	try {
		const result = await $`bun pm bin -g`.quiet().nothrow();
		if (result.exitCode !== 0) return undefined;
		const output = result.text().trim();
		return output.length > 0 ? output : undefined;
	} catch {
		return undefined;
	}
}

function normalizePathForComparison(filePath: string): string {
	const normalized = path.normalize(filePath);
	if (process.platform === "win32") return normalized.toLowerCase();
	return normalized;
}

function tryRealpath(p: string): string | undefined {
	try {
		return fs.realpathSync.native(p);
	} catch {
		return undefined;
	}
}

function isPathInDirectoryLexical(filePath: string, directoryPath: string): boolean {
	const normalizedPath = normalizePathForComparison(path.resolve(filePath));
	const normalizedDirectory = normalizePathForComparison(path.resolve(directoryPath));
	const relativePath = path.relative(normalizedDirectory, normalizedPath);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function isPathInDirectory(filePath: string, directoryPath: string): boolean {
	if (isPathInDirectoryLexical(filePath, directoryPath)) return true;
	// Layer realpath resolution on top of the lexical guard. On Windows, ~/.bun
	// is a junction when Bun is installed via Scoop, so `bun pm bin -g` and the
	// PATH-resolved skc path can refer to the same directory through different
	// strings. path.resolve does not traverse junctions/symlinks; realpath does.
	// Resolve the file's parent directory to tolerate the file itself not yet
	// existing (e.g. a fresh install path) while still catching link-traversed
	// equality once the directory exists.
	const fileDir = tryRealpath(path.dirname(path.resolve(filePath)));
	const dirReal = tryRealpath(path.resolve(directoryPath));
	if (!fileDir || !dirReal) return false;
	const resolvedFile = path.join(fileDir, path.basename(filePath));
	return isPathInDirectoryLexical(resolvedFile, dirReal);
}

export type PackageManagerTarget = { manager: "npm"; packageName: string };
export type UpdateTarget =
	| { method: "bun" }
	| { method: "npm"; packageName: string }
	| { method: "binary"; path: string };

type PathPlatform = NodeJS.Platform;
type PackageExists = (packageName: string, packageRoot: string) => boolean;

function pathApiForPlatform(platform: PathPlatform): typeof path.posix | typeof path.win32 {
	return platform === "win32" ? path.win32 : path.posix;
}

function defaultPackageExists(_packageName: string, packageRoot: string): boolean {
	return fs.existsSync(path.join(packageRoot, "package.json"));
}

function npmPackageRootForBinPath(binPath: string, packageName: string, platform: PathPlatform): string {
	const pathApi = pathApiForPlatform(platform);
	const segments = packageName.split("/");
	return pathApi.join(pathApi.dirname(binPath), "node_modules", ...segments);
}

function resolveNpmManagedTarget(
	ompPath: string,
	platform: PathPlatform = process.platform,
	packageExists: PackageExists = defaultPackageExists,
): PackageManagerTarget | undefined {
	if (platform !== "win32") return undefined;
	const pathApi = pathApiForPlatform(platform);
	const extension = pathApi.extname(ompPath).toLowerCase();
	if (extension !== ".cmd" && extension !== ".ps1") return undefined;
	const basename = pathApi.basename(ompPath, extension).toLowerCase();
	if (basename !== APP_NAME.toLowerCase()) return undefined;

	for (const packageName of NPM_MANAGED_PACKAGES) {
		const packageRoot = npmPackageRootForBinPath(ompPath, packageName, platform);
		if (packageExists(packageName, packageRoot)) return { manager: "npm", packageName };
	}
	return undefined;
}

function resolveUpdateMethod(ompPath: string, bunBinDir: string | undefined): "bun" | "npm" | "binary" {
	if (resolveNpmManagedTarget(ompPath)) return "npm";
	if (!bunBinDir) return "binary";
	return isPathInDirectory(ompPath, bunBinDir) ? "bun" : "binary";
}

export function resolveUpdateMethodForTest(ompPath: string, bunBinDir: string | undefined): "bun" | "npm" | "binary" {
	return resolveUpdateMethod(ompPath, bunBinDir);
}

export function resolveNpmManagedTargetForTest(
	ompPath: string,
	platform: PathPlatform,
	packageExists: PackageExists,
): PackageManagerTarget | undefined {
	return resolveNpmManagedTarget(ompPath, platform, packageExists);
}
async function resolveUpdateTarget(): Promise<UpdateTarget> {
	const bunBinDir = await getBunGlobalBinDir();
	const ompPath = resolveSkcPath();

	if (ompPath) {
		const npmTarget = resolveNpmManagedTarget(ompPath);
		if (npmTarget) return { method: "npm", packageName: npmTarget.packageName };
		const method = resolveUpdateMethod(ompPath, bunBinDir);
		if (method === "bun") return { method };
		if (method === "npm") {
			throw new Error(
				formatUnsupportedTargetMessage(`Could not resolve npm package root for ${APP_NAME} shim ${ompPath}`),
			);
		}
		return { method, path: ompPath };
	}

	if (bunBinDir) return { method: "bun" };

	throw new Error(formatUnsupportedTargetMessage(`Could not resolve ${APP_NAME} binary path in PATH`));
}

/**
 * Get the latest release info from the npm registry.
 * Uses npm instead of GitHub API to avoid unauthenticated rate limiting.
 */
async function getLatestRelease(): Promise<ReleaseInfo> {
	const response = await fetch(`https://registry.npmjs.org/${PACKAGE}/latest`);
	if (!response.ok) {
		throw new Error(`Failed to fetch release info: ${response.statusText}`);
	}

	const data = (await response.json()) as { version: string };
	const version = data.version;
	const tag = `v${version}`;

	return {
		tag,
		version,
	};
}

/**
 * Compare semver versions. Returns:
 * - negative if a < b
 * - 0 if a == b
 * - positive if a > b
 */
function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);

	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const na = pa[i] || 0;
		const nb = pb[i] || 0;
		if (na !== nb) return na - nb;
	}
	return 0;
}

/**
 * Get the appropriate binary name for this platform.
 */
function getBinaryName(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
	let os: string;
	switch (platform) {
		case "linux":
			os = "linux";
			break;
		case "darwin":
			os = "darwin";
			break;
		case "win32":
			os = "windows";
			break;
		default:
			throw new Error(formatUnsupportedTargetMessage(`Unsupported platform: ${platform}`));
	}

	let archName: string;
	switch (arch) {
		case "x64":
			archName = "x64";
			break;
		case "arm64":
			archName = "arm64";
			break;
		default:
			throw new Error(formatUnsupportedTargetMessage(`Unsupported architecture: ${arch}`));
	}

	if (os === "windows") {
		if (archName !== "x64") {
			throw new Error(formatUnsupportedTargetMessage(`Unsupported architecture for Windows: ${arch}`));
		}
		return `${APP_NAME}-${os}-${archName}.exe`;
	}
	return `${APP_NAME}-${os}-${archName}`;
}

export function getBinaryNameForTest(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): string {
	return getBinaryName(platform, arch);
}

/**
 * Resolve the path that `skc` maps to in the user's PATH.
 */
function resolveSkcPath(): string | undefined {
	return $which(APP_NAME) ?? undefined;
}

/**
 * Run the resolved skc binary and check if it reports the expected version.
 */
async function verifyInstalledVersion(expectedVersion: string): Promise<InstalledVersionVerification> {
	const ompPath = resolveSkcPath();
	if (!ompPath) return { ok: false };
	try {
		const result = await $`${ompPath} --version`.quiet().nothrow();
		if (result.exitCode !== 0) return { ok: false, path: ompPath };
		const output = result.text().trim();
		// Output format: "skc/X.Y.Z"
		const match = output.match(/\/(\d+\.\d+\.\d+)/);
		const actual = match?.[1];
		return { ok: actual === expectedVersion, actual, path: ompPath };
	} catch {
		return { ok: false, path: ompPath };
	}
}

async function verifyInstalledRuntime(expectedVersion: string): Promise<InstalledVersionVerification> {
	const versionResult = await verifyInstalledVersion(expectedVersion);
	if (!versionResult.ok || !versionResult.path) {
		return versionResult;
	}
	try {
		const smokeResult = await $`${versionResult.path} --smoke-test`.quiet().nothrow();
		if (smokeResult.exitCode === 0) {
			return versionResult;
		}
		return {
			...versionResult,
			ok: false,
			smokeTestFailed: true,
			smokeTestOutput: smokeResult.text().trim(),
		};
	} catch (error) {
		return {
			...versionResult,
			ok: false,
			smokeTestFailed: true,
			smokeTestOutput: error instanceof Error ? error.message : String(error),
		};
	}
}

function printRestartGuidance(): void {
	console.log(chalk.dim(`Restart ${APP_NAME} to use the new version`));
}

function printVerifiedVersion(expectedVersion: string): void {
	console.log(chalk.green(`\n${theme.status.success} Updated to ${expectedVersion}`));
}

function printSuccessfulVerification(expectedVersion: string): void {
	printVerifiedVersion(expectedVersion);
	printRestartGuidance();
}

function formatBinaryInstallInstruction(platform: NodeJS.Platform = process.platform): string {
	if (platform === "win32") {
		return `For a supported binary install, reinstall with PowerShell: irm https://raw.githubusercontent.com/${RELEASE_REPO}/main/scripts/install.ps1 | iex`;
	}
	return `For a supported binary install, reinstall with: curl -fsSL https://raw.githubusercontent.com/${RELEASE_REPO}/main/scripts/install.sh | sh -s -- --binary`;
}

function formatManualUpdateInstructions(platform: NodeJS.Platform = process.platform): string {
	return [
		`If ${APP_NAME} was installed with Bun, run: bun install -g ${PACKAGE}@latest`,
		`If ${APP_NAME} was installed with npm, pnpm, or another package manager, update it with that same manager.`,
		formatBinaryInstallInstruction(platform),
	].join("\n");
}

function formatUnsupportedTargetMessage(reason: string, platform: NodeJS.Platform = process.platform): string {
	return `${reason}.\n${formatManualUpdateInstructions(platform)}`;
}

function buildReleaseBinaryUrl(
	version: string,
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): string {
	const binaryName = getBinaryName(platform, arch);
	const tag = `sayknow-v${version}`;
	return `https://github.com/${RELEASE_REPO}/releases/download/${tag}/${binaryName}`;
}

function buildReleaseAssetUrl(version: string, assetName: string): string {
	return `https://github.com/${RELEASE_REPO}/releases/download/sayknow-v${version}/${assetName}`;
}

function parseExpectedDigestFromSums(text: string, assetName: string): string | undefined {
	const matches: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const match = line.trim().match(/^([a-fA-F0-9]{64}) {2}[ *]?([^/\\]+)$/);
		if (match?.[2] === assetName) matches.push(match[1]!.toLowerCase());
	}
	if (matches.length > 1) throw new Error(`Release checksum file lists ${assetName} more than once`);
	return matches[0];
}

function expectedDigestFromManifest(value: unknown, version: string, assetName: string): string {
	if (!value || typeof value !== "object") throw new Error("Release binary manifest is not an object");
	const manifest = value as Record<string, unknown>;
	if (
		manifest.schema !== "sayknow-release-binaries-v1" ||
		manifest.schema_version !== 1 ||
		manifest.release_version !== version ||
		manifest.tag !== `sayknow-v${version}` ||
		!Array.isArray(manifest.binaries)
	) {
		throw new Error("Release binary manifest metadata does not match the requested release");
	}
	const matches = manifest.binaries.filter(
		entry => entry && typeof entry === "object" && (entry as Record<string, unknown>).name === assetName,
	) as Array<Record<string, unknown>>;
	if (matches.length !== 1 || typeof matches[0]?.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(matches[0].sha256)) {
		throw new Error(`Release binary manifest does not contain one valid SHA-256 for ${assetName}`);
	}
	return matches[0].sha256;
}

export async function fetchExpectedBinaryDigest(
	version: string,
	assetName: string,
	fetchImpl: (url: string) => Promise<Response> = fetch,
): Promise<string> {
	const sumsResponse = await fetchImpl(buildReleaseAssetUrl(version, BINARY_SHA256_ASSET));
	if (sumsResponse.ok) {
		const digest = parseExpectedDigestFromSums(await sumsResponse.text(), assetName);
		if (!digest) throw new Error(`Release checksum file does not list ${assetName}`);
		return digest;
	}
	if (sumsResponse.status !== 404) {
		throw new Error(`Release checksum file could not be fetched: HTTP ${sumsResponse.status}`);
	}

	const manifestResponse = await fetchImpl(buildReleaseAssetUrl(version, BINARY_MANIFEST_ASSET));
	if (!manifestResponse.ok) {
		if (manifestResponse.status === 404) {
			throw new Error(`Release ${version} has no Sayknow binary integrity manifest`);
		}
		throw new Error(`Release binary manifest could not be fetched: HTTP ${manifestResponse.status}`);
	}
	return expectedDigestFromManifest(await manifestResponse.json(), version, assetName);
}

async function sha256File(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
	return hash.digest("hex");
}

export async function verifyReleaseBinaryIntegrity(
	filePath: string,
	version: string,
	assetName: string,
	fetchImpl: (url: string) => Promise<Response> = fetch,
): Promise<void> {
	const expected = await fetchExpectedBinaryDigest(version, assetName, fetchImpl);
	const actual = await sha256File(filePath);
	if (actual !== expected) {
		throw new Error(`SHA-256 mismatch for ${assetName}: expected ${expected}, got ${actual}`);
	}
}

function formatBinaryDownloadFailureMessage(
	binaryName: string,
	url: string,
	status: string | number,
	platform: NodeJS.Platform = process.platform,
): string {
	return `Download failed for ${binaryName} from ${url}: ${status}.\n${formatManualUpdateInstructions(platform)}`;
}

export function formatBinaryDownloadFailureMessageForTest(
	binaryName: string,
	url: string,
	status: string | number,
	platform: NodeJS.Platform = process.platform,
): string {
	return formatBinaryDownloadFailureMessage(binaryName, url, status, platform);
}

export function buildReleaseBinaryUrlForTest(
	version: string,
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): string {
	return buildReleaseBinaryUrl(version, platform, arch);
}

export function formatManualUpdateInstructionsForTest(platform: NodeJS.Platform = process.platform): string {
	return formatManualUpdateInstructions(platform);
}

function normalizeVerificationOutput(output: string | undefined): string {
	return output?.replace(/\s+/g, " ").trim() ?? "";
}

function formatVerificationFailure(result: InstalledVersionVerification, expectedVersion: string): string {
	if (result.smokeTestFailed) {
		const output = normalizeVerificationOutput(result.smokeTestOutput);
		const outputSuffix = output ? `: ${output}` : "";
		const pathSuffix = result.path ? ` at ${result.path}` : "";
		return `${APP_NAME}${pathSuffix} reports ${result.actual ?? expectedVersion}, but --smoke-test failed${outputSuffix}. Close running ${APP_NAME} sessions and reinstall to repair a stale or partial update.`;
	}
	if (result.actual) {
		return `${APP_NAME} at ${result.path} still reports ${result.actual} (expected ${expectedVersion})`;
	}
	return `could not verify updated version${result.path ? ` at ${result.path}` : ""}`;
}

export function formatVerificationFailureForTest(
	result: InstalledVersionVerification,
	expectedVersion: string,
): string {
	return formatVerificationFailure(result, expectedVersion);
}

async function unlinkIfExists(filePath: string): Promise<void> {
	try {
		await fs.promises.unlink(filePath);
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
}

function formatBackupCleanupWarning(backupPath: string, err: unknown): string {
	return `Installed update, but could not remove backup file ${backupPath}: ${err}. You can delete it manually after closing shells or antivirus processes that may still hold it.`;
}

async function cleanupVerifiedBackup(backupPath: string): Promise<string | undefined> {
	try {
		await unlinkDurably(backupPath);
		return undefined;
	} catch (err) {
		return formatBackupCleanupWarning(backupPath, err);
	}
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.promises.lstat(filePath);
		return true;
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

async function syncParentDirectory(filePath: string): Promise<void> {
	// Node cannot portably fsync directory handles on Windows. NTFS journals the
	// rename operations used below; POSIX platforms require an explicit parent sync.
	if (process.platform === "win32") return;
	const handle = await fs.promises.open(path.dirname(filePath), "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function unlinkDurably(filePath: string): Promise<void> {
	await unlinkIfExists(filePath);
	await syncParentDirectory(filePath);
}

async function renameDurably(sourcePath: string, targetPath: string): Promise<void> {
	await fs.promises.rename(sourcePath, targetPath);
	await syncParentDirectory(targetPath);
	if (path.dirname(sourcePath) !== path.dirname(targetPath)) await syncParentDirectory(sourcePath);
}

export async function withBinaryUpdateLock<T>(targetPath: string, operation: () => Promise<T>): Promise<T> {
	const lockPath = path.join(path.dirname(targetPath), ".skc-install.lock");
	try {
		await fs.promises.mkdir(lockPath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") {
			throw new Error(`Another SKC installer or update is already running (lock: ${lockPath}).`);
		}
		throw err;
	}
	try {
		await fs.promises.writeFile(
			path.join(lockPath, "owner.json"),
			JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
			{ flag: "wx" },
		);
		return await operation();
	} finally {
		await fs.promises.rm(lockPath, { recursive: true, force: true });
	}
}

type BinaryReplacementPhase = "replacing" | "committed";

interface BinaryReplacementState {
	phase: BinaryReplacementPhase;
	hadTarget: boolean;
}

function binaryReplacementStatePath(backupPath: string): string {
	return `${backupPath}.state.json`;
}

async function readBinaryReplacementState(statePath: string): Promise<BinaryReplacementState | undefined> {
	try {
		const value = JSON.parse(await fs.promises.readFile(statePath, "utf8")) as Partial<BinaryReplacementState>;
		if ((value.phase === "replacing" || value.phase === "committed") && typeof value.hadTarget === "boolean") {
			return value as BinaryReplacementState;
		}
		return { phase: "replacing", hadTarget: true };
	} catch (err) {
		if (isEnoent(err)) return undefined;
		return { phase: "replacing", hadTarget: true };
	}
}

async function writeBinaryReplacementState(statePath: string, state: BinaryReplacementState): Promise<void> {
	const handle = await fs.promises.open(statePath, "w", 0o600);
	try {
		await handle.writeFile(JSON.stringify(state));
		await handle.sync();
	} finally {
		await handle.close();
	}
	await syncParentDirectory(statePath);
}

async function recoverInterruptedBinaryReplacement(targetPath: string, backupPath: string): Promise<void> {
	const statePath = binaryReplacementStatePath(backupPath);
	const state = await readBinaryReplacementState(statePath);
	if (!(await pathExists(backupPath))) {
		if (state?.phase === "replacing" && state.hadTarget === false) {
			await unlinkDurably(targetPath);
		}
		await unlinkDurably(statePath);
		return;
	}
	if (state?.phase === "committed" && (await pathExists(targetPath))) {
		await unlinkDurably(backupPath);
		await unlinkDurably(statePath);
		return;
	}
	await unlinkDurably(targetPath);
	await renameDurably(backupPath, targetPath);
	await unlinkDurably(statePath);
}

async function cleanupCommittedReplacementState(statePath: string): Promise<string | undefined> {
	try {
		await unlinkDurably(statePath);
		return undefined;
	} catch (err) {
		return `Installed update, but could not remove transaction state file ${statePath}: ${err}. The verified binary remains installed.`;
	}
}

/**
 * Atomically replace the installed binary and roll back if version verification fails.
 */
export async function replaceBinaryForUpdate(options: BinaryReplacementOptions): Promise<InstalledVersionVerification> {
	const statePath = binaryReplacementStatePath(options.backupPath);
	await recoverInterruptedBinaryReplacement(options.targetPath, options.backupPath);
	await unlinkDurably(options.backupPath);
	const hadTarget = await pathExists(options.targetPath);
	let backupReady = false;
	let publishedNew = false;
	let verification: InstalledVersionVerification;
	try {
		await writeBinaryReplacementState(statePath, {
			phase: "replacing",
			hadTarget,
		});
		try {
			await fs.promises.rename(options.targetPath, options.backupPath);
			backupReady = true;
			await syncParentDirectory(options.backupPath);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		await fs.promises.rename(options.tempPath, options.targetPath);
		publishedNew = true;
		await syncParentDirectory(options.targetPath);

		verification = await options.verifyInstalledVersion(options.expectedVersion);
		if (!verification.ok) {
			throw new Error(
				`${formatVerificationFailure(verification, options.expectedVersion)}; restored previous ${APP_NAME} binary`,
			);
		}

		await writeBinaryReplacementState(statePath, {
			phase: "committed",
			hadTarget,
		});
		backupReady = false;
	} catch (err) {
		if (backupReady) {
			await unlinkDurably(options.targetPath);
			await renameDurably(options.backupPath, options.targetPath);
		} else if (publishedNew) {
			await unlinkDurably(options.targetPath);
		}
		await unlinkDurably(options.tempPath);
		await unlinkDurably(statePath);
		throw err;
	}

	let cleanupWarning = await cleanupVerifiedBackup(options.backupPath);
	if (!cleanupWarning) cleanupWarning = await cleanupCommittedReplacementState(statePath);
	return cleanupWarning ? { ...verification, cleanupWarning } : verification;
}

function formatPackageManagerInstallFailure(
	managerName: string,
	result: PackageManagerUpdateResult,
	verification: InstalledVersionVerification,
	expectedVersion: string,
): string {
	const output = normalizeVerificationOutput(result.text());
	const outputSuffix = output ? `: ${output}` : "";
	return `${managerName} install failed with exit code ${result.exitCode ?? "unknown"}${outputSuffix}. ${formatVerificationFailure(verification, expectedVersion)}`;
}

function formatPackageManagerVerificationFailure(
	managerName: string,
	verification: InstalledVersionVerification,
	expectedVersion: string,
): string {
	return `${managerName} install exited successfully, but the selected ${APP_NAME} runtime failed verification: ${formatVerificationFailure(verification, expectedVersion)}`;
}

export async function runPackageManagerUpdateForTest(
	options: PackageManagerUpdateOptions,
): Promise<InstalledVersionVerification> {
	return updateViaPackageManager(options);
}

async function updateViaPackageManager(options: PackageManagerUpdateOptions): Promise<InstalledVersionVerification> {
	const result = await options.runInstall(options.expectedVersion);
	if (result.exitCode === 0) {
		const verification = await options.verifyInstalledRuntime(options.expectedVersion);
		if (!verification.ok) {
			throw new Error(
				formatPackageManagerVerificationFailure(options.managerName, verification, options.expectedVersion),
			);
		}
		printSuccessfulVerification(options.expectedVersion);
		return verification;
	}

	const verification = await options.verifyInstalledRuntime(options.expectedVersion);
	if (verification.ok) {
		console.warn(
			chalk.yellow(
				`${options.managerName} exited with ${result.exitCode ?? "unknown"}, but ${APP_NAME} now verifies as ${options.expectedVersion}. Treating the update as installed.`,
			),
		);
		(options.printRecoveredVerification ?? printSuccessfulVerification)(options.expectedVersion);
		return verification;
	}

	throw new Error(
		formatPackageManagerInstallFailure(options.managerName, result, verification, options.expectedVersion),
	);
}

/**
 * Update via bun package manager.
 */
async function updateViaBun(expectedVersion: string): Promise<void> {
	console.log(chalk.dim("Updating via bun..."));
	await updateViaPackageManager({
		managerName: "bun",
		expectedVersion,
		runInstall: async version => await $`bun install -g ${PACKAGE}@${version}`.nothrow(),
		verifyInstalledRuntime,
	});
}

async function updateViaNpm(packageName: string, expectedVersion: string): Promise<void> {
	console.log(chalk.dim(`Updating npm-managed install via npm (${packageName})...`));
	await updateViaPackageManager({
		managerName: "npm",
		expectedVersion,
		runInstall: async version => await $`npm install -g ${packageName}@${version}`.nothrow(),
		verifyInstalledRuntime,
	});
}

/**
 * Flush a freshly written file's data to stable storage.
 *
 * Critical on network filesystems (e.g. NFS home directories): `pipeline`
 * resolving does not guarantee the downloaded bytes are durable on the
 * server, so the post-install `skc --version` check can exec a binary whose
 * pages are not yet consistent. The child then faults, the version check
 * fails, and the update is rolled back with "could not verify updated
 * version" even though the download itself succeeded. Explicitly fsyncing
 * before the rename/exec avoids the race.
 */
async function fsyncFile(filePath: string): Promise<void> {
	const handle = await fs.promises.open(filePath, "r+");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export async function fsyncFileForTest(filePath: string): Promise<void> {
	return fsyncFile(filePath);
}

/**
 * Download a release binary to a temp path, throwing a friendly error when the
 * release asset cannot be fetched.
 */
async function downloadBinaryTo(url: string, tempPath: string, binaryName: string): Promise<void> {
	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok || !response.body) {
		throw new Error(formatBinaryDownloadFailureMessage(binaryName, url, response.statusText || response.status));
	}
	const fileStream = fs.createWriteStream(tempPath, { mode: 0o755 });
	await pipeline(response.body, fileStream);
}

/** Injectable steps of the binary update flow (seams for testing ordering). */
export interface BinaryUpdateFlow {
	download(url: string, tempPath: string): Promise<void>;
	verifyIntegrity(filePath: string): Promise<void>;
	fsync(filePath: string): Promise<void>;
	replace(options: BinaryReplacementOptions): Promise<InstalledVersionVerification>;
	verifyInstalledVersion(expectedVersion: string): Promise<InstalledVersionVerification>;
	/** Best-effort cleanup of the temp file when the flow aborts before replace. */
	removeTemp?(filePath: string): Promise<void>;
	/** Stable suffix for focused tests; production uses a process-unique staging path. */
	transactionId?: string;
	/** Called once fsync has succeeded, right before replacement begins. */
	beforeReplace?(): void;
}

/**
 * Orchestrate download → integrity verification → fsync → replace → version/smoke verification.
 * contract: the downloaded temp binary MUST be flushed to stable storage
 * before it is published (renamed into place) or exec'd for verification.
 *
 * If fsync fails the temp bytes are not durable, so we abort before
 * replacement/verification and clean up the temp file rather than installing a
 * possibly-truncated binary.
 */
export async function runBinaryUpdateFlow(
	targetPath: string,
	url: string,
	expectedVersion: string,
	flow: BinaryUpdateFlow,
): Promise<InstalledVersionVerification> {
	const transactionId = flow.transactionId ?? `${process.pid}.${randomUUID()}`;
	const tempPath = `${targetPath}.new.${transactionId}`;
	const backupPath = `${targetPath}.bak`;

	await flow.download(url, tempPath);
	try {
		await flow.verifyIntegrity(tempPath);
		await flow.fsync(tempPath);
	} catch (err) {
		if (flow.removeTemp) await flow.removeTemp(tempPath);
		throw err;
	}

	flow.beforeReplace?.();
	return flow.replace({
		targetPath,
		tempPath,
		backupPath,
		expectedVersion,
		verifyInstalledVersion: flow.verifyInstalledVersion,
	});
}

/**
 * Download a release binary to a target path, replacing an existing file.
 */
async function updateViaBinaryAt(targetPath: string, expectedVersion: string): Promise<void> {
	const binaryName = getBinaryName();
	const url = buildReleaseBinaryUrl(expectedVersion);
	console.log(chalk.dim(`Downloading ${binaryName}…`));

	const verification = await withBinaryUpdateLock(targetPath, () =>
		runBinaryUpdateFlow(targetPath, url, expectedVersion, {
			download: (downloadUrl, tempPath) => downloadBinaryTo(downloadUrl, tempPath, binaryName),
			verifyIntegrity: tempPath => verifyReleaseBinaryIntegrity(tempPath, expectedVersion, binaryName),
			fsync: fsyncFile,
			replace: replaceBinaryForUpdate,
			verifyInstalledVersion: verifyInstalledRuntime,
			removeTemp: unlinkIfExists,
			beforeReplace: () => console.log(chalk.dim("Installing update...")),
		}),
	);

	printVerifiedVersion(expectedVersion);
	if (verification.cleanupWarning) console.warn(chalk.yellow(verification.cleanupWarning));
	printRestartGuidance();
}

/**
 * Run the update command.
 */
export interface UpdateCommandDependencies {
	getLatestRelease?: () => Promise<ReleaseInfo>;
	resolveUpdateTarget?: () => Promise<UpdateTarget>;
	performUpdate?: (target: UpdateTarget, expectedVersion: string) => Promise<void>;
	refreshInstalledDefaultSkills?: () => Promise<void>;
	exit?: (code: number) => never;
}

async function performUpdate(target: UpdateTarget, expectedVersion: string): Promise<void> {
	if (target.method === "bun") {
		await updateViaBun(expectedVersion);
	} else if (target.method === "npm") {
		await updateViaNpm(target.packageName, expectedVersion);
	} else {
		await updateViaBinaryAt(target.path, expectedVersion);
	}
}

export async function runUpdateCommand(
	opts: { force: boolean; check: boolean },
	deps: UpdateCommandDependencies = {},
): Promise<void> {
	const lookupRelease = deps.getLatestRelease ?? getLatestRelease;
	const resolveTarget = deps.resolveUpdateTarget ?? resolveUpdateTarget;
	const update = deps.performUpdate ?? performUpdate;
	const refreshDefaults = deps.refreshInstalledDefaultSkills ?? refreshInstalledDefaultSkills;
	const exit = deps.exit ?? process.exit;

	console.log(chalk.dim(`Current version: ${VERSION}`));

	let release: ReleaseInfo;
	try {
		release = await lookupRelease();
	} catch (err) {
		console.error(chalk.red(`Failed to check for updates: ${err}`));
		return exit(1);
	}

	const comparison = compareVersions(release.version, VERSION);

	if (comparison <= 0 && !opts.force) {
		console.log(chalk.green(`${theme.status.success} Already up to date`));
		return;
	}

	if (comparison > 0) {
		console.log(chalk.cyan(`New version available: ${release.version}`));
	} else {
		console.log(chalk.yellow(`Forcing reinstall of ${release.version}`));
	}

	if (opts.check) return;

	try {
		const target = await resolveTarget();
		await update(target, release.version);
	} catch (err) {
		console.error(chalk.red(`Update failed: ${err}`));
		return exit(1);
	}

	await refreshDefaults();
}

/**
 * Refresh opted-in on-disk default workflow skill copies after a successful
 * update. The four default skills ship embedded in the binary, so most users
 * need nothing here. But users who ran `skc setup defaults` have on-disk copies
 * under the agent dir that shadow the embedded defaults; those would otherwise
 * go stale after an update. Only rewrite files that already exist and differ —
 * never materialize new copies for users who never opted in.
 */
async function refreshInstalledDefaultSkills(): Promise<void> {
	try {
		const result = await installDefaultSkcDefinitions({ refreshOnly: true });
		if (result.written > 0) {
			console.log(
				chalk.dim(`Refreshed ${result.written} local default workflow skill file(s) at ${result.targetRoot}`),
			);
		}
	} catch (err) {
		console.error(chalk.yellow(`Warning: failed to refresh local default workflow skills: ${err}`));
	}
}

/**
 * Print update command help.
 */
export function printUpdateHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} update`)} - Check for and install updates

${chalk.bold("Usage:")}
  ${APP_NAME} update [options]

${chalk.bold("Options:")}
  -c, --check   Check for updates without installing
  -f, --force   Force reinstall even if up to date

${chalk.bold("Examples:")}
  ${APP_NAME} update           Update to latest version
  ${APP_NAME} update --check   Check if updates are available
  ${APP_NAME} update --force   Force reinstall
`);
}
