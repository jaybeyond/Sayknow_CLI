import { describe, expect, it } from "bun:test";
import { closeSync } from "node:fs";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportFromFile } from "../../src/export/html";
import { openHtmlExportDestination } from "../../src/export/html/html-export-destination";
import { SessionManager } from "../../src/session/session-manager";

describe("HTML export file mode", () => {
	it("creates an owner-only file and removes other users' access from an existing one", async () => {
		if (process.platform === "win32") return;
		const dir = await mkdtemp(path.join(tmpdir(), "html-export-mode-"));
		try {
			const created = path.join(dir, "new.html");
			closeSync(openHtmlExportDestination(created));
			expect((await stat(created)).mode & 0o777).toBe(0o600);

			const existing = path.join(dir, "old.html");
			await writeFile(existing, "transcript");
			await chmod(existing, 0o666);
			closeSync(openHtmlExportDestination(existing));
			expect((await stat(existing)).mode & 0o777).toBe(0o600);
			expect(await Bun.file(existing).text()).toBe("transcript");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("writes exportFromFile output owner-only and replaces a world-readable file in place", async () => {
		if (process.platform === "win32") return;
		const dir = await mkdtemp(path.join(tmpdir(), "html-export-e2e-"));
		try {
			const session = SessionManager.create(dir, dir);
			session.appendMessage({ role: "user", content: "export-mode-marker", timestamp: Date.now() });
			await session.flush();
			const sessionFile = session.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persisted session file");
			await session.close();

			const output = path.join(dir, "out.html");
			await writeFile(output, "x".repeat(4_000_000));
			await chmod(output, 0o644);
			await exportFromFile(sessionFile, output);
			expect((await stat(output)).mode & 0o777).toBe(0o600);
			const html = await Bun.file(output).text();
			expect(html.startsWith("<!")).toBe(true);
			expect(html.includes("xxxxxxxxxx")).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
