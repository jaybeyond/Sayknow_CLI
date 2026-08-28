import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	BINARY_MANIFEST_FILE,
	BINARY_SHA256_FILE,
	RELEASE_BINARY_NAMES,
	buildReleaseBinariesManifest,
	formatSha256Sums,
	parseReleaseTag,
	parseSha256Sums,
	writeReleaseBinariesManifest,
} from "./release-binaries-manifest";

describe("Sayknow release binary manifest", () => {
	test("hashes every supported platform asset and writes both integrity assets", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sayknow-release-binaries-"));
		try {
			for (const name of RELEASE_BINARY_NAMES) fs.writeFileSync(path.join(dir, name), `payload-${name}`);
			const manifest = buildReleaseBinariesManifest({ binDir: dir, tag: "sayknow-v1.2.3" });
			expect(manifest).toMatchObject({
				schema: "sayknow-release-binaries-v1",
				schema_version: 1,
				release_version: "1.2.3",
				tag: "sayknow-v1.2.3",
			});
			expect(manifest.binaries).toHaveLength(5);
			const sums = formatSha256Sums(manifest);
			for (const entry of manifest.binaries) expect(parseSha256Sums(sums, entry.name)).toBe(entry.sha256);
			const first = manifest.binaries[0]!;
			expect(() =>
				parseSha256Sums(`${first.sha256}  ${first.name}\n${first.sha256}  ${first.name}\n`, first.name),
			).toThrow("more than once");
			const written = writeReleaseBinariesManifest({ binDir: dir, tag: "sayknow-v1.2.3" });
			expect(fs.existsSync(path.join(dir, BINARY_MANIFEST_FILE))).toBe(true);
			expect(fs.existsSync(path.join(dir, BINARY_SHA256_FILE))).toBe(true);
			expect(written.manifest.binaries).toEqual(manifest.binaries);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("rejects unsafe tags, missing binaries, and path-shaped checksum entries", () => {
		expect(parseReleaseTag("sayknow-v1.2.3")).toEqual({ tag: "sayknow-v1.2.3", version: "1.2.3" });
		expect(() => parseReleaseTag("v1.2.3")).toThrow("Invalid Sayknow release tag");
		expect(() => parseReleaseTag("sayknow-v1.2.3/../../asset")).toThrow("Invalid Sayknow release tag");
		expect(() => buildReleaseBinariesManifest({ binDir: os.tmpdir(), tag: "sayknow-v1.2.3" })).toThrow();
		expect(parseSha256Sums(`${"a".repeat(64)}  ../skc-linux-x64\n`, "skc-linux-x64")).toBeUndefined();
	});
});
