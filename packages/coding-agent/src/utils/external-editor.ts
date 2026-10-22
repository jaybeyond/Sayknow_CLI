/**
 * Utilities for launching an external text editor ($VISUAL / $EDITOR).
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $env } from "@sayknow-cli/utils";

/** Returns the user's preferred editor command, or undefined if not configured. */
export function getEditorCommand(): string | undefined {
	return $env.VISUAL || $env.EDITOR || undefined;
}

export interface OpenInEditorOptions {
	/** File extension for the temp file (default: ".md"). */
	extension?: string;
	/** Custom stdio configuration (default: all "inherit"). */
	stdio?: [number | "inherit", number | "inherit", number | "inherit"];
	/** Keep the file's trailing newline instead of trimming it from the returned text. */
	trimTrailingNewline?: boolean;
}

/** Remove one platform-standard trailing line terminator from editor content. */
export function trimEditorTrailingNewline(text: string): string {
	return text.replace(/\r?\n$/, "");
}

/**
 * Opens `content` in the user's external editor and returns the edited text.
 * Returns `null` if the editor exits with a non-zero code.
 *
 * The caller is responsible for stopping/starting the TUI around this call.
 */
export async function openInEditor(
	editorCmd: string,
	content: string,
	options?: OpenInEditorOptions,
): Promise<string | null> {
	const ext = options?.extension ?? ".md";
	// Random directory plus an exclusive create: a preexisting symlink under the
	// temp directory is not opened, and the draft is not left world-readable.
	let tempDir: string | undefined;
	let tmpFile = "";

	try {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "skc-editor-"));
		if (process.platform !== "win32") await fs.chmod(tempDir, 0o700);
		tmpFile = path.join(tempDir, `draft${ext}`);
		const handle = await fs.open(tmpFile, "wx", 0o600);
		try {
			await handle.writeFile(content);
		} finally {
			await handle.close();
		}
		if (process.platform !== "win32") await fs.chmod(tmpFile, 0o600);

		const [editor, ...editorArgs] = editorCmd.split(" ");
		const stdio = options?.stdio ?? ["inherit", "inherit", "inherit"];

		const child = spawn(editor, [...editorArgs, tmpFile], { stdio, shell: process.platform === "win32" });
		const { promise, reject, resolve } = Promise.withResolvers<number>();
		child.once("exit", (code, signal) => resolve(code ?? (signal ? -1 : 0)));
		child.once("error", error => reject(error));
		const exitCode = await promise;

		if (exitCode === 0) {
			const text = await Bun.file(tmpFile).text();
			if (options?.trimTrailingNewline === false) {
				return text;
			}
			return trimEditorTrailingNewline(text);
		}
		return null;
	} finally {
		if (tempDir) {
			try {
				await fs.rm(tempDir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors
			}
		}
	}
}
