import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAddonFilenames } from "../../natives/native/loader-state.js";
import { convertFileWithMarkit } from "../src/utils/markit";
import { ensureMupdfWasmResolution } from "../src/utils/mupdf-wasm";

const MODULE_CONFIG_KEY = "$libmupdf_wasm_Module";
const fixturePdfPath = path.resolve(import.meta.dirname, "fixtures/dummy-pdf-fixture.pdf");

function resolveVendoredMupdfWasmPath(): string {
	return path.resolve(import.meta.dirname, "../vendor/mupdf/mupdf-wasm.wasm");
}

describe("mupdf wasm embedding (upstream #5433)", () => {
	it("embeds the wasm from the package-local vendor path, not monorepo node_modules", () => {
		const vendored = resolveVendoredMupdfWasmPath();
		expect(fs.existsSync(vendored)).toBe(true);
		const bytes = fs.readFileSync(vendored);
		// Real wasm magic, not a Git LFS pointer (which would pack as ~130 bytes
		// of ASCII and crash every published install the same way 0.5.8 did).
		expect(bytes.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]))).toBe(true);
		expect(bytes.byteLength).toBeGreaterThan(1_000_000);

		const source = fs.readFileSync(path.resolve(import.meta.dirname, "../src/utils/mupdf-wasm.ts"), "utf8");
		const importLines = source.split("\n").filter(line => line.trimStart().startsWith("import "));
		expect(importLines.some(line => line.includes('../../vendor/mupdf/mupdf-wasm.wasm" with { type: "file" }'))).toBe(
			true,
		);
		expect(importLines.some(line => line.includes("node_modules/mupdf"))).toBe(false);
	});

	it("seeds the emscripten module config with a locateFile hook", () => {
		const globalScope = globalThis as typeof globalThis & Record<string, unknown>;
		const previous = globalScope[MODULE_CONFIG_KEY];
		delete globalScope[MODULE_CONFIG_KEY];
		try {
			ensureMupdfWasmResolution();
			const seeded = globalScope[MODULE_CONFIG_KEY] as { locateFile?: unknown } | undefined;
			expect(typeof seeded?.locateFile).toBe("function");
			// Idempotent: seeding again must not replace an existing config.
			ensureMupdfWasmResolution();
			expect(globalScope[MODULE_CONFIG_KEY]).toBe(seeded);
		} finally {
			if (previous === undefined) {
				delete globalScope[MODULE_CONFIG_KEY];
			} else {
				globalScope[MODULE_CONFIG_KEY] = previous;
			}
		}
	});

	it("preserves a pre-existing emscripten module config", () => {
		const globalScope = globalThis as typeof globalThis & Record<string, unknown>;
		const sentinel = { locateFile: () => "/sentinel/mupdf-wasm.wasm" };
		const previous = globalScope[MODULE_CONFIG_KEY];
		globalScope[MODULE_CONFIG_KEY] = sentinel;
		try {
			ensureMupdfWasmResolution();
			expect(globalScope[MODULE_CONFIG_KEY]).toBe(sentinel);
		} finally {
			if (previous === undefined) {
				delete globalScope[MODULE_CONFIG_KEY];
			} else {
				globalScope[MODULE_CONFIG_KEY] = previous;
			}
		}
	});

	it("converts a one-page PDF to text through markit", async () => {
		const result = await convertFileWithMarkit(fixturePdfPath);
		expect(result.ok).toBe(true);
		expect(result.content).toContain("Dummy PDF file");
	});

	it("reports a bounded error for a corrupt PDF instead of succeeding", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "skc-mupdf-corrupt-"));
		try {
			const corruptPath = path.join(tempDir, "corrupt.pdf");
			fs.writeFileSync(corruptPath, Buffer.from("%PDF-1.4 not really a pdf\n"));
			const result = await convertFileWithMarkit(corruptPath);
			expect(result.ok).toBe(false);
			expect(result.error).toContain("pdf:");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

describe("mupdf wasm embedding in a compiled binary (upstream #5433)", () => {
	it("converts a one-page PDF end to end", async () => {
		const workspaceRoot = path.resolve(import.meta.dirname, "../..");
		const fixtureEntry = path.resolve(import.meta.dirname, "fixtures/mupdf-compiled-convert-entry.ts");
		const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "skc-mupdf-compiled-"));
		const executable = path.join(outDir, "mupdf-convert-fixture");
		try {
			const compile = Bun.spawn(
				[process.execPath, "build", fixtureEntry, "--compile", "--minify", "--keep-names", "--outfile", executable],
				{ cwd: workspaceRoot, stdout: "pipe", stderr: "pipe" },
			);
			const [compileExit, compileStderr] = await Promise.all([compile.exited, new Response(compile.stderr).text()]);
			expect(compileExit, compileStderr.slice(0, 2000)).toBe(0);

			// The fixture binary bundles the product import graph, which loads the
			// pi_natives addon at startup. Unlike release builds it does not go
			// through the embed-native pipeline, so satisfy the loader's
			// cwd fallback by placing the locally built addon next to the binary.
			// This keeps the assertion focused on what the test proves: the mupdf
			// wasm asset resolves from inside the bunfs.
			//
			// Use the loader's own filename list so CI-built x64 variants
			// (`pi_natives.<tag>-baseline.node` / `-modern.node`) satisfy the check
			// as well as the unsuffixed local build. The binary picks its variant at
			// runtime (AVX2 detection), so every built variant is staged next to it.
			const platformTag = `${process.platform}-${process.arch}`;
			const nativeDir = path.join(workspaceRoot, "natives/native");
			const addonNames = [
				...new Set([
					...getAddonFilenames({ tag: platformTag, arch: process.arch, variant: "modern" }),
					...getAddonFilenames({ tag: platformTag, arch: process.arch, variant: "baseline" }),
					...getAddonFilenames({ tag: platformTag, arch: process.arch, variant: null }),
				]),
			];
			const builtAddons = addonNames.filter(name => fs.existsSync(path.join(nativeDir, name)));
			expect(
				builtAddons.length > 0,
				`missing ${addonNames.map(name => path.join(nativeDir, name)).join(" or ")}; run: bun --cwd=packages/natives run build`,
			).toBe(true);
			for (const addonName of builtAddons) {
				fs.copyFileSync(path.join(nativeDir, addonName), path.join(outDir, addonName));
			}

			const run = Bun.spawn([executable, fixturePdfPath], { cwd: outDir, stdout: "pipe", stderr: "pipe" });
			const [runExit, stdout, stderr] = await Promise.all([
				run.exited,
				new Response(run.stdout).text(),
				new Response(run.stderr).text(),
			]);
			expect(stderr).not.toContain("mupdf-wasm.wasm");
			expect(runExit, stderr.slice(0, 2000) || stdout).toBe(0);
			expect(stdout).toContain("CONVERTED:Dummy PDF file");
		} finally {
			fs.rmSync(outDir, { recursive: true, force: true });
		}
	}, 240_000);
});
