import { afterEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { getPackageDir } from "@sayknow-cli/coding-agent/config";

const ORIGINAL_SKC_PACKAGE_DIR = process.env.SKC_PACKAGE_DIR;
const ORIGINAL_PI_PACKAGE_DIR = process.env.PI_PACKAGE_DIR;

describe("getPackageDir", () => {
	afterEach(() => {
		process.env.SKC_PACKAGE_DIR = ORIGINAL_SKC_PACKAGE_DIR;
		process.env.PI_PACKAGE_DIR = ORIGINAL_PI_PACKAGE_DIR;
	});

	it("prefers SKC_PACKAGE_DIR over legacy PI_PACKAGE_DIR", () => {
		const skcPackageDir = path.join(os.tmpdir(), "skc-package-dir");
		const legacyPackageDir = path.join(os.tmpdir(), "legacy-pi-package-dir");

		process.env.SKC_PACKAGE_DIR = skcPackageDir;
		process.env.PI_PACKAGE_DIR = legacyPackageDir;

		expect(getPackageDir()).toBe(skcPackageDir);
	});

	it("keeps PI_PACKAGE_DIR as a legacy fallback", () => {
		const legacyPackageDir = path.join(os.tmpdir(), "legacy-pi-package-dir");

		delete process.env.SKC_PACKAGE_DIR;
		process.env.PI_PACKAGE_DIR = legacyPackageDir;

		expect(getPackageDir()).toBe(legacyPackageDir);
	});
});
