import * as path from "node:path";

type NativePathApi = Pick<typeof path, "resolve" | "dirname" | "basename">;

function nativeTargetHasSeparator(value: string): boolean {
	return value.includes("/") || value.includes("\\") || value.includes("\0");
}

/**
 * Resolve the temporary build directory prefix and the installed addon path for a
 * native build. `CROSS_TARGET`, `TARGET_PLATFORM`, and `TARGET_ARCH` are environment
 * input, so a value carrying a path separator could place the build directory or the
 * installed addon outside the package `native` directory; such values are refused.
 */
export function resolveNativeBuildOutputPaths(
	input: {
		nativeDir: string;
		crossTarget?: string;
		targetPlatform: string;
		targetArch: string;
		variantSuffix: string;
		variantLabel: string;
		profileLabel: string;
	},
	pathApi: NativePathApi = path,
): { buildOutputDirPrefix: string; canonicalAddonFilename: string; canonicalAddonPath: string } {
	if (input.crossTarget !== undefined && nativeTargetHasSeparator(input.crossTarget)) {
		throw new Error("Unsupported CROSS_TARGET: path separators are not allowed");
	}
	if (nativeTargetHasSeparator(input.targetPlatform)) {
		throw new Error("Unsupported TARGET_PLATFORM: path separators are not allowed");
	}
	if (nativeTargetHasSeparator(input.targetArch)) {
		throw new Error("Unsupported TARGET_ARCH: path separators are not allowed");
	}
	const root = pathApi.resolve(input.nativeDir);
	const buildRoot = pathApi.resolve(root, ".build");
	const buildTarget = input.crossTarget ?? `${input.targetPlatform}-${input.targetArch}`;
	const buildOutputDirPrefix = pathApi.resolve(
		buildRoot,
		`${buildTarget}-${input.variantLabel}-${input.profileLabel}-`,
	);
	if (pathApi.dirname(buildOutputDirPrefix) !== buildRoot) {
		throw new Error("Native build output path escapes the native build directory");
	}
	const canonicalAddonFilename = `pi_natives.${input.targetPlatform}-${input.targetArch}${input.variantSuffix}.node`;
	const canonicalAddonPath = pathApi.resolve(root, canonicalAddonFilename);
	if (
		pathApi.dirname(canonicalAddonPath) !== root ||
		pathApi.basename(canonicalAddonPath) !== canonicalAddonFilename
	) {
		throw new Error("Native build install path escapes the native directory");
	}
	return { buildOutputDirPrefix, canonicalAddonFilename, canonicalAddonPath };
}
