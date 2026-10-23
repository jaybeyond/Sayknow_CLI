import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const ARTIFACT_NOFOLLOW = process.platform === "win32" ? 0 : (nodeFs.constants.O_NOFOLLOW ?? 0);

async function unlinkOwnedStaging(staging: string, dev: bigint, ino: bigint): Promise<void> {
	try {
		const stat = await fs.lstat(staging, { bigint: true });
		if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== dev || stat.ino !== ino) return;
		await fs.unlink(staging);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

/**
 * Publish text at an explicit artifact path the way `ArtifactManager.save` does:
 * a temp file opened with `O_NOFOLLOW` and mode 0600, then rename. A symlink is
 * not followed. A pre-existing regular file is replaced, so mode 0644 is not kept.
 *
 * Node built-ins only, so `gh` can publish without importing `tools/fetch`.
 */
export async function publishExplicitArtifactText(destination: string, text: string): Promise<void> {
	const bytes = Buffer.from(text, "utf8");
	const parent = path.dirname(destination);
	// Bun.write created a missing parent. Match that when the allocated path's
	// directory does not exist yet.
	try {
		await fs.lstat(parent);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		await fs.mkdir(parent, { recursive: true, mode: 0o700 });
	}
	// Keep the staging component a fixed length. A destination basename near NAME_MAX
	// plus a UUID would make the temp name longer than the filesystem allows.
	const staging = path.join(parent, `.artifact-${randomUUID()}.staging`);
	let handle: fs.FileHandle | undefined;
	let stagedDev: bigint | undefined;
	let stagedIno: bigint | undefined;
	let published = false;
	try {
		handle = await fs.open(
			staging,
			nodeFs.constants.O_CREAT | nodeFs.constants.O_EXCL | nodeFs.constants.O_WRONLY | ARTIFACT_NOFOLLOW,
			0o600,
		);
		const opened = await handle.stat({ bigint: true });
		stagedDev = opened.dev;
		stagedIno = opened.ino;
		if (process.platform !== "win32") await handle.chmod(0o600);
		await handle.writeFile(bytes);
		await handle.sync();
		const staged = await handle.stat({ bigint: true });
		if (process.platform !== "win32" && (Number(staged.mode) & 0o777) !== 0o600) {
			throw new Error("artifact_publish_mode");
		}
		await handle.close();
		handle = undefined;

		let existing: nodeFs.Stats | undefined;
		try {
			existing = await fs.lstat(destination);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (existing?.isSymbolicLink()) throw new Error("artifact_destination_symlink");
		if (existing && !existing.isFile()) throw new Error("artifact_destination_not_file");

		await fs.rename(staging, destination);
		const named = await fs.lstat(destination, { bigint: true });
		if (
			!named.isFile() ||
			named.isSymbolicLink() ||
			named.dev !== stagedDev ||
			named.ino !== stagedIno ||
			(process.platform !== "win32" && (Number(named.mode) & 0o777) !== 0o600)
		) {
			throw new Error("artifact_destination_identity_changed");
		}
		published = true;
	} finally {
		if (handle) await handle.close().catch(() => undefined);
		if (!published && stagedDev !== undefined && stagedIno !== undefined) {
			await unlinkOwnedStaging(staging, stagedDev, stagedIno);
		}
	}
}
