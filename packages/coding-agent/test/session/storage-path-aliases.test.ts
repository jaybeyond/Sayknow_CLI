import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	ManagedSessionDescendantStore,
	managedDirectoryRoot,
} from "../../src/session/internal/managed-session-storage";
import { assertNoReparseStoragePath } from "../../src/session/session-storage";

const temporaryDirectories: string[] = [];

function tempDir(parent = os.tmpdir()): string {
	const dir = fs.mkdtempSync(path.join(parent, "skc-storage-alias-"));
	temporaryDirectories.push(dir);
	fs.chmodSync(dir, 0o700);
	return dir;
}

afterEach(() => {
	for (const dir of temporaryDirectories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** First top-level OS link (macOS `/var`, `/tmp`; merged-usr `/bin`, `/lib`) owned by root. */
function rootOwnedSystemLink(): string | undefined {
	if (process.platform === "win32") return undefined;
	for (const candidate of ["/var", "/tmp", "/bin", "/lib", "/sbin"]) {
		try {
			const stat = fs.lstatSync(candidate);
			if (stat.isSymbolicLink() && stat.uid === 0) return candidate;
		} catch {}
	}
	return undefined;
}

/** The OS temp dir when it is named only through root-owned links, e.g. macOS `/var/folders/...`. */
function osAliasedTempDir(): string | undefined {
	if (process.platform === "win32") return undefined;
	const textual = path.resolve(os.tmpdir());
	if (fs.realpathSync.native(textual) === textual) return undefined;
	let current = path.parse(textual).root;
	for (const part of textual.split(path.sep)) {
		if (!part) continue;
		current = path.join(current, part);
		const stat = fs.lstatSync(current);
		if (stat.isSymbolicLink() && stat.uid !== 0) return undefined;
	}
	return textual;
}

describe("storage path aliases", () => {
	it("rejects a managed path that reaches the root through a user-owned ancestor alias", () => {
		const base = fs.realpathSync.native(tempDir());
		const realParent = path.join(base, "real");
		fs.mkdirSync(path.join(realParent, "root"), { recursive: true, mode: 0o700 });
		fs.symlinkSync(realParent, path.join(base, "alias"));
		const root = managedDirectoryRoot(path.join(realParent, "root"));

		expect(() => new ManagedSessionDescendantStore(root, path.join(base, "alias", "root", "sessions"))).toThrow(
			/escapes configured root/,
		);
	});

	it("rejects a managed path that reaches the root through a link to the root itself", () => {
		const base = fs.realpathSync.native(tempDir());
		fs.mkdirSync(path.join(base, "root"), { mode: 0o700 });
		fs.symlinkSync(path.join(base, "root"), path.join(base, "root-link"));
		const root = managedDirectoryRoot(path.join(base, "root"));

		expect(() => new ManagedSessionDescendantStore(root, path.join(base, "root-link", "sessions"))).toThrow(
			/escapes configured root/,
		);
	});

	it("rejects a user-owned link in a storage path", () => {
		const base = tempDir();
		fs.mkdirSync(path.join(base, "target"));
		fs.symlinkSync(path.join(base, "target"), path.join(base, "link"));

		expect(() => assertNoReparseStoragePath(path.join(base, "link", "session.jsonl"))).toThrow(
			/Unsafe reparse storage path/,
		);
	});

	const systemLink = rootOwnedSystemLink();
	it.skipIf(systemLink === undefined)("accepts a storage path below a root-owned OS link", () => {
		expect(() =>
			assertNoReparseStoragePath(path.join(systemLink as string, "skc-storage-alias-probe")),
		).not.toThrow();
	});

	const aliasedTemp = osAliasedTempDir();
	it.skipIf(aliasedTemp === undefined || process.platform === "linux")(
		"accepts a managed root named through a root-owned OS link",
		() => {
			const base = tempDir(aliasedTemp as string);
			fs.mkdirSync(path.join(base, "root"), { mode: 0o700 });
			const root = managedDirectoryRoot(path.join(base, "root"));
			expect(root.canonicalPath).not.toBe(path.join(base, "root"));

			// Previously rejected as "escapes configured root": the root is canonical, the caller's path is not.
			const store = new ManagedSessionDescendantStore(root, path.join(base, "root", "sessions"));
			expect(store).toBeInstanceOf(ManagedSessionDescendantStore);
		},
	);
});
