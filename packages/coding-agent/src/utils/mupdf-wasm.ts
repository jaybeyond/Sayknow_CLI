/**
 * MuPDF wasm asset resolution inside compiled binaries (upstream #5433).
 *
 * `mupdf`'s Emscripten loader resolves `mupdf-wasm.wasm` relative to
 * `import.meta.url` (or `scriptDirectory`). Inside a `bun build --compile`
 * bunfs that path points at the bunfs root where the asset does not exist,
 * so every mupdf import aborted with
 * `ENOENT: ... /$bunfs/root/mupdf-wasm.wasm`.
 *
 * The wasm is embedded via `with { type: "file" }`, which lands it at a
 * hashed bunfs path. MuPDF's top-level factory call reads
 * `globalThis["$libmupdf_wasm_Module"]`, so seeding that config with a
 * `locateFile` hook that returns the embedded asset path makes the loader
 * read the wasm from the bunfs directly — no disk sidecar needed.
 *
 * The asset MUST live under this package (`vendor/mupdf/…`), not under the
 * monorepo `node_modules/` tree. A `../../../../node_modules/mupdf/…` import
 * resolves in a workspace checkout but breaks every published install
 * (`bun install -g` / npm) where `@sayknow-cli/coding-agent` sits several
 * directories deeper and mupdf is hoisted elsewhere — that was the 0.5.8
 * startup crash. Refresh the vendored bytes from
 * `node_modules/mupdf/dist/mupdf-wasm.wasm` whenever markit-ai's mupdf
 * dependency moves.
 *
 * This must run before the first `import("mupdf")` anywhere in the process.
 */
import mupdfWasmPath from "../../vendor/mupdf/mupdf-wasm.wasm" with { type: "file" };

const MODULE_CONFIG_KEY = "$libmupdf_wasm_Module";

export function ensureMupdfWasmResolution(): void {
	const globalScope = globalThis as typeof globalThis & Record<string, unknown>;
	if (globalScope[MODULE_CONFIG_KEY] !== undefined) return;
	globalScope[MODULE_CONFIG_KEY] = { locateFile: () => String(mupdfWasmPath) };
}
