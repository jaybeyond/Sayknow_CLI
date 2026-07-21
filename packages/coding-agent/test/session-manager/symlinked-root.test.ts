import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager } from "../../src/session/session-manager";

// Regression: the native owner-only primitive and the session-storage reparse
// guard intentionally reject any symlinked path component. A user whose session
// root traverses a symlink (e.g. a symlinked `$HOME`, project, or `/tmp`) must
// still be able to create and persist sessions. Production canonicalizes the
// trusted session root before the strict guards run; this test drives an
// explicitly symlinked directory so that canonicalization is exercised even
// though the test preload canonicalizes `os.tmpdir()` itself.
describe("SessionManager symlinked storage root", () => {
	let realRoot: string;
	let linkRoot: string;

	beforeEach(async () => {
		realRoot = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "skc-symlink-real-")));
		linkRoot = path.join(path.dirname(realRoot), `skc-symlink-link-${path.basename(realRoot)}`);
		await fsp.symlink(realRoot, linkRoot, "dir");
	});

	afterEach(async () => {
		await fsp.rm(linkRoot, { force: true });
		await fsp.rm(realRoot, { recursive: true, force: true });
	});

	it("canonicalizes a symlinked session directory so strict owner-only guards accept writes", () => {
		const symlinkedSessionDir = path.join(linkRoot, "sessions", "s1");

		// Without canonicalization this throws `reparse_point` / `Unsafe reparse
		// storage path` because `linkRoot` is a symlink component.
		const session = SessionManager.create(realRoot, symlinkedSessionDir);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		const dir = session.getSessionDir();
		expect(dir.startsWith(realRoot)).toBe(true);
		expect(dir.startsWith(linkRoot)).toBe(false);
	});
});
