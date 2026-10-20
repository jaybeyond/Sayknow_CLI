/**
 * verification-receipts: git policy shared by the tools: the pinned `-c` knobs, the repo-local filter guard
 * and the NUL record splitter used by the freshness fingerprint.
 *
 * Independent re-implementation of the contracts of jjongguet/gjc-plugin
 * `verification-receipts` (MIT, Copyright (c) 2026 jjongguet). See NOTICE.md and LICENSE.gjc-plugin.
 */

/**
 * Repo-local config must never weaken change detection: pin every stat/refresh/mode knob that can hide an edit.
 * `core.fileMode=true` makes a mode-only change of a clean tracked file visible to `git status`; on a filesystem
 * without trustworthy exec bits this reports such files as dirty (fail-closed, it can reach `file_limit`).
 * `core.symlinks=true` makes a symlink -> regular-file swap visible (`core.symlinks=false` treats a regular file
 * holding the link target as the symlink); the tools are POSIX-only, so the pin is always correct.
 * `core.ignorecase=false`: with a repo-local `core.ignorecase=true` on a case-sensitive filesystem, git hides a new
 * untracked file whose name differs from a tracked one only in case. On a case-insensitive filesystem the pin can
 * report a tracked file whose on-disk name case differs from the index as missing plus untracked (fail-closed:
 * stale, possibly `file_limit`).
 */
export const GIT_PINS = [
	"core.fsmonitor=false",
	"core.trustctime=true",
	"core.checkStat=default",
	"core.ignoreStat=false",
	"core.untrackedCache=false",
	"core.fileMode=true",
	"core.symlinks=true",
	"core.ignorecase=false",
].flatMap(pin => ["-c", pin]);

/**
 * Stat-only dirty source (no index refresh or write, no content conversion): lists every tracked path whose stat data
 * differs from the index. Check-in conversions (`text`/`eol`/`autocrlf`, `ident`, `working-tree-encoding`,
 * `core.attributesFile`) make `git status` compare converted content, so a same-size raw edit can be invisible to it;
 * these paths are unioned into the dirty set and hashed raw (conservative: a path touched without a content change
 * is listed too, which can only make a receipt stale, never fresh).
 */
export const DIFF_FILES_ARGS = ["diff-files", "--name-only", "-z", "--no-renames", "--ignore-submodules=none"];

/**
 * `git config --show-scope -z --get-regexp` arguments for clean/smudge-style filter drivers. A clean filter can
 * rewrite the working copy before `git status` compares it, so a repo-local one can make an edit invisible.
 */
export const FILTER_CONFIG_ARGS = ["config", "--show-scope", "-z", "--get-regexp", "^filter\\..*\\.(clean|process)$"];

const LFS_CLEAN = /^git-lfs clean(?: --)? %f$/;
const LFS_PROCESS = /^git-lfs filter-process(?: --skip)?$/;

/**
 * True when the `FILTER_CONFIG_ARGS` output holds a filter driver that repository-controlled config (local,
 * worktree, included files, command line) defines, other than the stock content-addressed git-lfs drivers.
 * `global`/`system` config is the user's own and is not examined, so a globally installed git-lfs keeps working.
 * Malformed output is unsupported (fail closed).
 */
export function hasUnsupportedFilter(raw: string): boolean {
	const parts = raw.split("\0");
	if (parts.pop() !== "" || parts.length % 2 !== 0) return true;
	for (let i = 0; i < parts.length; i += 2) {
		const scope = parts[i];
		if (scope === "system" || scope === "global") continue;
		const entry = parts[i + 1] ?? "";
		const nl = entry.indexOf("\n");
		const key = nl < 0 ? entry : entry.slice(0, nl);
		const value = nl < 0 ? "" : entry.slice(nl + 1);
		const m = /^filter\.(.+)\.(clean|process)$/.exec(key);
		const stock = m?.[1] === "lfs" && (m[2] === "clean" ? LFS_CLEAN : LFS_PROCESS).test(value);
		if (!stock) return true;
	}
	return false;
}

/** Splits a NUL-separated byte stream into records across chunk boundaries. */
export class RecordSplitter {
	#rest: Buffer = Buffer.alloc(0);
	constructor(private readonly onRecord: (record: Buffer) => void) {}
	push(chunk: Uint8Array): void {
		let buf = this.#rest.byteLength ? Buffer.concat([this.#rest, chunk]) : Buffer.from(chunk);
		for (let nul = buf.indexOf(0); nul !== -1; nul = buf.indexOf(0)) {
			this.onRecord(buf.subarray(0, nul));
			buf = buf.subarray(nul + 1);
		}
		this.#rest = Buffer.from(buf);
	}
	finish(): boolean {
		return this.#rest.byteLength === 0;
	}
}
