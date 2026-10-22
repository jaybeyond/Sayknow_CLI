import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@sayknow-cli/coding-agent/config/settings";
import { getRuntimeResourceCounts } from "@sayknow-cli/coding-agent/debug/runtime-gauges";
import {
	type BashResult,
	disposeAllShellSessions,
	executeBash,
	getShellSessionCount,
} from "@sayknow-cli/coding-agent/exec/bash-executor";
import { DEFAULT_MAX_BYTES } from "@sayknow-cli/coding-agent/session/streaming-output";
import * as shellSnapshot from "@sayknow-cli/coding-agent/utils/shell-snapshot";
import type { Shell } from "@sayknow-cli/natives";
import * as piNatives from "@sayknow-cli/natives";

// Matches the schema default for `tools.artifactHeadBytes` (20 KB) used by
// OutputSink when bash-executor pulls settings via resolveOutputSinkHeadBytes.
const ARTIFACT_HEAD_BYTES_DEFAULT = 20 * 1024;
const BACKGROUND_COMPLETION_RACE_MS = 750;
const KILL_MARKER_DELAY_SECONDS = "0.4";
const KILL_MARKER_ASSERTION_WAIT_MS = 900;

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "skc-bash-exec-"));
}

describe("executeBash", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = makeTempDir();
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir });
	});

	afterEach(() => {
		resetSettingsForTest();
		vi.restoreAllMocks();
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true });
		}
	});

	it("does not deadlock when a compound pipeline stage writes over a pipe buffer", async () => {
		if (process.platform === "win32") return;

		const result = await executeBash("{ head -c 70000 /dev/zero | tr '\\0' A; echo; } | grep ZZZ || true", {
			cwd: tempDir,
			timeout: 4000,
		});
		expect(result.cancelled).toBe(false);
		expect(result.exitCode).toBe(0);
	}, 10_000);

	it("does not deadlock when a for-loop pipeline stage writes over a pipe buffer", async () => {
		if (process.platform === "win32") return;

		const result = await executeBash("for i in $(seq 1 20000); do echo line$i; done | grep ZZZ || true", {
			cwd: tempDir,
			timeout: 4000,
		});
		expect(result.cancelled).toBe(false);
		expect(result.exitCode).toBe(0);
	}, 10_000);

	it("does not deadlock when a compound pipeline stage writes over 64 KiB", async () => {
		if (process.platform === "win32") return;

		const result = await executeBash(
			"i=0; while [ $i -lt 20000 ]; do echo line$i; i=$((i + 1)); done | grep ZZZ || true",
			{ cwd: tempDir, timeout: 4000 },
		);
		expect(result.cancelled).toBe(false);
		expect(result.exitCode).toBe(0);
	}, 10_000);

	it("preserves byte counts through a compound pipeline stage", async () => {
		if (process.platform === "win32") return;

		const result = await executeBash("{ head -c 200000 /dev/zero | tr '\\0' A; echo; } | wc -c", {
			cwd: tempDir,
			timeout: 4000,
		});
		expect(result.cancelled).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("200001");
	}, 10_000);

	it("preserves PIPESTATUS and pipefail across a compound pipeline", async () => {
		if (process.platform === "win32") return;

		const result = await executeBash(
			`set -o pipefail; { false; } | true; status=$? statuses=("\${PIPESTATUS[@]}"); printf '%s %s %s\\n' "$status" "\${statuses[0]}" "\${statuses[1]}"`,
			{ cwd: tempDir, timeout: 4000 },
		);
		expect(result.cancelled).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("1 1 0");
	}, 10_000);

	it("does not deadlock with multiple blocking compound readers", async () => {
		if (process.platform === "win32") return;

		const trigger = path.join(tempDir, "trigger");
		childProcess.execFileSync("mkfifo", [trigger]);
		const stages = Array.from({ length: 32 }, (_, i) => `{ : > stage-${i}; read v; printf '%s\\n' "$v"; }`);
		const started = new Set<string>();
		let released = false;
		// Poll instead of fs.watch: macOS FSEvents coalesces the stage-file creations,
		// so a watcher can miss all but one and never release the trigger.
		const poll = setInterval(() => {
			for (const filename of fs.readdirSync(tempDir)) {
				if (filename.startsWith("stage-")) started.add(filename);
			}
			if (!released && started.size === stages.length) {
				released = true;
				clearInterval(poll);
				fs.writeFileSync(trigger, "x\n");
			}
		}, 10);
		let result: BashResult;
		try {
			result = await executeBash(
				`shopt -u lastpipe; { read v < trigger; printf '%s\\n' "$v"; } | ${stages.join(" | ")}`,
				{ cwd: tempDir, timeout: 5000 },
			);
		} finally {
			clearInterval(poll);
		}
		expect(result.cancelled).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("x");
	}, 10_000);

	it("joins started compound stages after a later launch error", async () => {
		if (process.platform === "win32") return;

		const marker = path.join(tempDir, "marker");
		const result = await executeBash("{ sleep 1; printf late > marker; } | { :; } <&99", {
			cwd: tempDir,
			timeout: 5000,
		});
		expect(result.cancelled).toBe(false);
		expect(result.exitCode).toBeDefined();
		expect(result.exitCode).not.toBe(0);
		expect(fs.readFileSync(marker, "utf8")).toBe("late");
	}, 10_000);

	it("joins remaining compound stages after a stage wait error", async () => {
		if (process.platform === "win32") return;

		const marker = path.join(tempDir, "marker");
		const sessionKey = "pipeline-wait-error";
		const result = await executeBash("{ { :; } <&99; } | { sleep 1; printf late > marker; }", {
			cwd: tempDir,
			timeout: 5000,
			sessionKey,
		});
		expect(result.cancelled).toBe(false);
		expect(result.exitCode).toBeDefined();
		expect(result.exitCode).not.toBe(0);
		expect(fs.readFileSync(marker, "utf8")).toBe("late");

		const reused = await executeBash("printf reuse-ok", {
			cwd: tempDir,
			timeout: 5000,
			sessionKey,
		});
		expect(reused).toMatchObject({ exitCode: 0, cancelled: false });
		expect(reused.output).toBe("reuse-ok");
	}, 10_000);

	it("preserves parent compound and lastpipe mutations across a compound pipeline", async () => {
		if (process.platform === "win32") return;

		const result = await executeBash(
			"{ value=before; }; { value=changed; printf payload; } | cat >/dev/null; printf 'parent:%s\\n' \"$value\"; shopt -s lastpipe; printf 'line\\n' | { read value; }; printf 'lastpipe:%s\\n' \"$value\"",
			{ cwd: tempDir, timeout: 4000 },
		);
		expect(result.cancelled).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("parent:before\nlastpipe:line");
	}, 10_000);

	it("preserves simple pipeline behavior alongside compound pipelines", async () => {
		const result = await executeBash("printf 'simple pipeline\\n' | cat", { cwd: tempDir, timeout: 4000 });
		expect(result.cancelled).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("simple pipeline");
	}, 10_000);

	it("returns non-zero exit codes without cancellation", async () => {
		const result = await executeBash("exit 7", { cwd: tempDir, timeout: 5000 });
		expect(result.exitCode).toBe(7);
		expect(result.cancelled).toBe(false);
	});

	it("scrubs inherited managed transcript paths from shell sessions", async () => {
		const previousSessionFile = process.env.SKC_SESSION_FILE;
		const previousOwnerPath = process.env.SKC_MANAGED_OWNER_TRANSCRIPT_PATH;
		process.env.SKC_SESSION_FILE = "/managed/session.jsonl";
		process.env.SKC_MANAGED_OWNER_TRANSCRIPT_PATH = "/managed/owner.jsonl";
		try {
			await disposeAllShellSessions();
			const result = await executeBash(
				'printf "%s|%s" "$(printenv SKC_SESSION_FILE || printf unset)" "$(printenv SKC_MANAGED_OWNER_TRANSCRIPT_PATH || printf unset)"',
				{
					cwd: tempDir,
					timeout: 5000,
					sessionKey: "managed-env-scrub",
				},
			);
			expect(result.output).toBe("unset|unset");
		} finally {
			if (previousSessionFile === undefined) delete process.env.SKC_SESSION_FILE;
			else process.env.SKC_SESSION_FILE = previousSessionFile;
			if (previousOwnerPath === undefined) delete process.env.SKC_MANAGED_OWNER_TRANSCRIPT_PATH;
			else process.env.SKC_MANAGED_OWNER_TRANSCRIPT_PATH = previousOwnerPath;
			await disposeAllShellSessions();
		}
	});

	it("unsets all managed-owner env vars to allow nested admission to return fresh (issue #6139)", async () => {
		const names = [
			"SKC_MANAGED_OWNER_RUN_ID",
			"SKC_MANAGED_OWNER_INCARNATION",
			"SKC_MANAGED_OWNER_CHILD_TOKEN",
			"SKC_TMUX_OWNER_STATE_DIR",
			"SKC_TMUX_OWNER_GENERATION",
			"SKC_MANAGED_OWNER_PREDECESSOR_TOKEN",
			"SKC_MANAGED_OWNER_COMMAND_JSON",
		];
		const previous = new Map(names.map(name => [name, process.env[name]]));
		for (const name of names) process.env[name] = `test-${name}`;

		try {
			await disposeAllShellSessions();
			// Explicitly unset managed-owner vars like the bash tool does
			const unsetEnv = [
				...names,
				"SKC_COORDINATOR_SESSION_ID",
				"SKC_MANAGED_OWNER_PREDECESSOR_GENERATION",
				"SKC_MANAGED_OWNER_PREDECESSOR_RUN_ID",
				"SKC_MANAGED_OWNER_PREDECESSOR_INCARNATION",
			];
			const read = names.map(name => `"$(printenv ${name} || printf unset)"`).join(" ");
			for (const oneShot of [false, true]) {
				const result = await executeBash(`printf "%s|%s|%s|%s|%s|%s|%s" ${read}`, {
					cwd: tempDir,
					timeout: 5000,
					sessionKey: "managed-owner-unset-test",
					oneShot,
					unsetEnv,
				});
				expect(result.output).toBe(names.map(() => "unset").join("|"));
			}
		} finally {
			for (const [name, value] of previous) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			await disposeAllShellSessions();
		}
	});

	it("retains then fully disposes persistent shell sessions (MEM-7)", async () => {
		await disposeAllShellSessions();
		expect(getShellSessionCount()).toBe(0);
		await executeBash("echo hi", { cwd: tempDir, timeout: 5000, sessionKey: "leak-test" });
		expect(getShellSessionCount()).toBeGreaterThanOrEqual(1);
		// Disposal must await native aborts (not fire-and-forget) so shutdown
		// cleanup does not return before resources are released.
		const pending = disposeAllShellSessions();
		expect(pending).toBeInstanceOf(Promise);
		await pending;
		expect(getShellSessionCount()).toBe(0);
	});

	it("reports the bash shell-session owner count via runtime resource gauges", async () => {
		await disposeAllShellSessions();
		expect(getRuntimeResourceCounts()["bash.shellSessions"]).toBe(0);
		await executeBash("echo hi", { cwd: tempDir, timeout: 5000, sessionKey: "gauge-test" });
		expect(getRuntimeResourceCounts()["bash.shellSessions"]).toBeGreaterThanOrEqual(1);
		await disposeAllShellSessions();
		expect(getRuntimeResourceCounts()["bash.shellSessions"]).toBe(0);
	});

	it("honors cwd", async () => {
		const result = await executeBash("pwd", { cwd: tempDir, timeout: 5000 });
		expect(result.output.trim()).toBe(fs.realpathSync(tempDir));
	});

	it("canonicalizes symlinked cwd before execution", async () => {
		if (process.platform === "win32") {
			return;
		}

		const realDir = path.join(tempDir, "real");
		const linkDir = path.join(tempDir, "link");
		fs.mkdirSync(realDir);
		fs.symlinkSync(realDir, linkDir, "dir");

		const result = await executeBash("pwd", { cwd: linkDir, timeout: 5000 });
		expect(result.output.trim()).toBe(fs.realpathSync(linkDir));
	});

	it("passes env vars", async () => {
		const result = await executeBash("echo $PI_TEST_ENV", {
			cwd: tempDir,
			timeout: 5000,
			env: { PI_TEST_ENV: "hello" },
		});
		expect(result.output.trim()).toBe("hello");
	});

	it("applies non-interactive environment defaults", async () => {
		const result = await executeBash('echo "$GIT_TERMINAL_PROMPT:$PI_TEST_ENV"', {
			cwd: tempDir,
			timeout: 5000,
			env: { PI_TEST_ENV: "hello" },
		});
		expect(result.output.trim()).toBe("0:hello");
	});

	it("can ignore configured shell prefixes", async () => {
		vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
			shell: Bun.env.SHELL?.includes("bash") ? Bun.env.SHELL : "/bin/bash",
			args: ["-l", "-c"],
			env: {
				PATH: Bun.env.PATH ?? "",
				HOME: Bun.env.HOME ?? tempDir,
			},
			prefix: "false &&",
		});

		const blocked = await executeBash("echo prefixed", { cwd: tempDir, timeout: 5000 });
		expect(blocked.exitCode).not.toBe(0);

		const ignored = await executeBash("echo unprefixed", {
			cwd: tempDir,
			timeout: 5000,
			ignoreShellPrefix: true,
		});
		expect(ignored.output.trim()).toBe("unprefixed");
	});

	it("invokes onChunk with command output", async () => {
		let seenChunk: string | null = null;
		const result = await executeBash("echo hello", {
			cwd: tempDir,
			timeout: 5000,
			onChunk: chunk => {
				if (seenChunk === null) {
					seenChunk = chunk;
				}
			},
		});
		expect(result.output.trim()).toBe("hello");
		expect(seenChunk).not.toBeNull();
		expect(seenChunk ?? "").toContain("hello");
	});

	it("returns even if command spawns a background job", async () => {
		if (process.platform === "win32") {
			return;
		}
		const runPromise = executeBash("{ sleep 2; } & echo fg", {
			cwd: tempDir,
			timeout: 5000,
		});
		const timed = await Promise.race([
			runPromise.then(result => ({ type: "result" as const, result })),
			Bun.sleep(BACKGROUND_COMPLETION_RACE_MS).then(() => ({ type: "timeout" as const })),
		]);
		expect(timed.type).toBe("result");
		if (timed.type === "result") {
			expect(timed.result.output).toContain("fg");
		}
	});

	it("returns a real PID for background external commands", async () => {
		if (process.platform === "win32") {
			return;
		}

		const result = await executeBash('python3 -c "import time; time.sleep(10)" & echo $!', {
			cwd: tempDir,
			timeout: 5000,
		});
		const pid = Number.parseInt(result.output.trim(), 10);
		expect(Number.isInteger(pid)).toBe(true);
		expect(pid).toBeGreaterThan(0);
		expect(() => process.kill(pid, 0)).not.toThrow();
		expect(() => process.kill(pid, "SIGKILL")).not.toThrow();
	});

	it("times out commands", async () => {
		if (process.platform === "win32") {
			return;
		}
		const result = await executeBash("sleep 10", { cwd: tempDir, timeout: 50 });
		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("timed out");
	});

	it("times out before follow-up output", async () => {
		if (process.platform === "win32") {
			return;
		}
		const result = await executeBash("sleep 10; echo done", { cwd: tempDir, timeout: 50 });
		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("timed out");
		expect(result.output).not.toContain("done");
	});

	it("aborts commands", async () => {
		if (process.platform === "win32") {
			return;
		}
		const controller = new AbortController();
		const promise = executeBash("sleep 10", {
			cwd: tempDir,
			timeout: 5000,
			signal: controller.signal,
		});
		await Bun.sleep(50);
		controller.abort();
		const result = await promise;
		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("Command cancelled");
	});

	it("returns promptly and quarantines the session key when native abort cleanup stalls", async () => {
		if (process.platform === "win32") {
			return;
		}

		const originalRun = piNatives.Shell.prototype.run;
		let runCalls = 0;
		vi.spyOn(piNatives.Shell.prototype, "run").mockImplementation(function (this: Shell, options, onChunk) {
			runCalls++;
			if (runCalls === 1) {
				onChunk?.(null, "started\n");
				return new Promise(() => {});
			}
			return originalRun.call(this, options, onChunk);
		});
		const abortSpy = vi.spyOn(piNatives.Shell.prototype, "abort").mockResolvedValue();

		const controller = new AbortController();
		const promise = executeBash("sleep 10", {
			cwd: tempDir,
			timeout: 5000,
			signal: controller.signal,
			sessionKey: "hung-native-abort",
		});
		await Bun.sleep(50);
		controller.abort();

		const raced = await Promise.race([
			promise.then(result => ({ type: "result" as const, result })),
			Bun.sleep(750).then(() => ({ type: "timeout" as const })),
		]);

		expect(raced.type).toBe("result");
		if (raced.type === "result") {
			expect(raced.result.cancelled).toBe(true);
			expect(raced.result.output).toContain("Command cancelled");
		}
		expect(abortSpy).toHaveBeenCalled();

		const next = await executeBash("echo next", {
			cwd: tempDir,
			timeout: 5000,
			sessionKey: "hung-native-abort",
		});
		expect(next.output.trim()).toBe("next");
		expect(runCalls).toBe(1);
	});

	it("restores persistent sessions after native abort cleanup settles", async () => {
		if (process.platform === "win32") {
			return;
		}

		const nativeResult = Promise.withResolvers<{ exitCode: undefined; cancelled: true; timedOut: false }>();
		vi.spyOn(piNatives.Shell.prototype, "run").mockImplementation((_options, onChunk) => {
			onChunk?.(null, "started\n");
			return nativeResult.promise;
		});
		vi.spyOn(piNatives.Shell.prototype, "abort").mockResolvedValue();

		const controller = new AbortController();
		const promise = executeBash("sleep 10", {
			cwd: tempDir,
			timeout: 5000,
			signal: controller.signal,
			sessionKey: "settled-native-abort",
		});
		await Bun.sleep(50);
		controller.abort();
		await promise;

		nativeResult.resolve({ exitCode: undefined, cancelled: true, timedOut: false });
		await Bun.sleep(0);
		vi.restoreAllMocks();

		await executeBash("export PI_AFTER_ABORT=still_persistent", {
			cwd: tempDir,
			timeout: 5000,
			sessionKey: "settled-native-abort",
		});
		const next = await executeBash("printf '%s\n' \"$PI_AFTER_ABORT\"", {
			cwd: tempDir,
			timeout: 5000,
			sessionKey: "settled-native-abort",
		});
		expect(next.output.trim()).toBe("still_persistent");
	});

	it("returns at the JavaScript timeout when native timeout cleanup stalls", async () => {
		if (process.platform === "win32") {
			return;
		}

		vi.spyOn(piNatives.Shell.prototype, "run").mockImplementation((_options, onChunk) => {
			onChunk?.(null, "started\n");
			return new Promise(() => {});
		});
		const abortSpy = vi.spyOn(piNatives.Shell.prototype, "abort").mockResolvedValue();

		const promise = executeBash("sleep 10", {
			cwd: tempDir,
			timeout: 1000,
			sessionKey: "hung-native-timeout",
		});
		const raced = await Promise.race([
			promise.then(result => ({ type: "result" as const, result })),
			Bun.sleep(1500).then(() => ({ type: "timeout" as const })),
		]);

		expect(raced.type).toBe("result");
		if (raced.type === "result") {
			expect(raced.result.cancelled).toBe(true);
			expect(raced.result.output).toContain("Command timed out after 1 seconds");
		}
		expect(abortSpy).toHaveBeenCalled();
	});

	it("aborts before follow-up output", async () => {
		if (process.platform === "win32") {
			return;
		}
		const controller = new AbortController();
		const promise = executeBash("sleep 10; echo done", {
			cwd: tempDir,
			timeout: 5000,
			signal: controller.signal,
		});
		await Bun.sleep(100);
		controller.abort();
		const result = await promise;
		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("Command cancelled");
		expect(result.output).not.toContain("done");
	});

	it("resets persistent session state after abort", async () => {
		if (process.platform === "win32") {
			return;
		}

		const sessionKey = "reset-on-abort";
		await executeBash("export PI_RESET_VAR=alive", { cwd: tempDir, timeout: 5000, sessionKey });
		const beforeAbort = await executeBash("echo $PI_RESET_VAR", { cwd: tempDir, timeout: 5000, sessionKey });
		expect(beforeAbort.output.trim()).toBe("alive");

		const controller = new AbortController();
		const abortPromise = executeBash("sleep 10", {
			cwd: tempDir,
			timeout: 5000,
			signal: controller.signal,
			sessionKey,
		});
		await Bun.sleep(50);
		controller.abort();
		const aborted = await abortPromise;
		expect(aborted.cancelled).toBe(true);

		// biome-ignore lint/suspicious/noTemplateCurlyInString: this is a bash variable expansion
		const afterAbort = await executeBash("echo ${PI_RESET_VAR:-unset}", {
			cwd: tempDir,
			timeout: 5000,
			sessionKey,
		});
		expect(afterAbort.output.trim()).toBe("unset");
	});
	it("streams output chunks", async () => {
		const chunks: string[] = [];
		const result = await executeBash("i=1; while [ $i -le 20 ]; do echo line$i; i=$((i+1)); done", {
			cwd: tempDir,
			timeout: 5000,
			onChunk: chunk => {
				expect(chunk.length).toBeGreaterThan(0);
				chunks.push(chunk);
			},
		});
		// At least one chunk should have been delivered to onChunk
		expect(chunks.length).toBeGreaterThan(0);
		const combined = chunks.join("");
		expect(combined).toContain("line1");
		// Final result always has the complete output regardless of chunk throttle
		expect(result.output).toContain("line1");
		expect(result.output).toContain("line20");
	});

	it("streams large output without exhausting memory", async () => {
		if (process.platform === "win32") {
			return;
		}
		let sawChunk = false;
		const result = await executeBash("awk 'BEGIN { for (i = 0; i < 100000; i++) printf \"a\" }'", {
			cwd: tempDir,
			timeout: 5000,
			onChunk: () => {
				sawChunk = true;
			},
		});
		expect(sawChunk).toBe(true);
		expect(result.totalBytes).toBe(100000);
		expect(result.outputBytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(result.output).toContain("a");
	});

	it("handles multi-million line output without freeze or OOM", async () => {
		if (process.platform === "win32") return;

		// 5 million lines ~= 40MB of output. Before the 64KB read buffer and
		// direct-push fixes, this would freeze or OOM the process.
		const lineCount = 5_000_000;
		let chunkCount = 0;
		const start = Date.now();
		const result = await executeBash(`seq 1 ${lineCount}`, {
			cwd: tempDir,
			timeout: 30_000,
			onChunk: () => {
				chunkCount++;
			},
		});
		const elapsed = Date.now() - start;

		// Should complete, not hang or OOM
		expect(result.exitCode).toBe(0);
		expect(result.cancelled).toBe(false);

		// Native execution may cap pathological streams before JavaScript sees every
		// generated line. Keep the regression contract strong enough to prove we
		// streamed a large bounded capture, not just a tiny non-empty placeholder.
		expect(result.totalLines).toBeGreaterThan(100_000);
		expect(result.totalBytes).toBeGreaterThan(DEFAULT_MAX_BYTES * 100);
		expect(result.truncated).toBe(true);

		// Truncated output should be bounded by head + tail + marker overhead
		// (middle-elision keeps the head budget plus the tail spill window), and the
		// visible preview must be meaningfully smaller than the captured stream.
		expect(result.outputBytes).toBeLessThan(result.totalBytes);
		expect(result.outputBytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES + ARTIFACT_HEAD_BYTES_DEFAULT + 1024);
		expect(result.output.length).toBeGreaterThan(0);

		// The visible tail should reflect the end of the bounded native capture even
		// when that capture ends before the synthetic seq target.
		const tailValues = result.output
			.split("\n")
			.slice(-1000)
			.map(line => Number(line.trim()))
			.filter(Number.isFinite);
		expect(tailValues.some(value => value >= result.totalLines - 500 && value <= result.totalLines)).toBe(true);

		// With 64KB read buffer, ~40MB should produce ~600 chunks, not 5M.
		// Allow generous headroom but ensure it's orders of magnitude below lineCount.
		expect(chunkCount).toBeLessThan(lineCount / 100);

		// Should complete in reasonable time (not frozen). On a modern machine
		// seq 1 5000000 itself takes ~0.5s; with JS overhead allow 20s.
		expect(elapsed).toBeLessThan(20_000);
	}, 35_000);

	it("sources snapshot env vars across session commands", async () => {
		if (process.platform === "win32") {
			return;
		}
		const bashPath = Bun.env.SHELL?.includes("bash") ? Bun.env.SHELL : "/bin/bash";
		if (!fs.existsSync(bashPath)) {
			return;
		}
		const snapshotPath = path.join(tempDir, "snapshot.sh");
		fs.writeFileSync(snapshotPath, "export PI_SNAPSHOT_TEST=from_snapshot\n");
		vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
			shell: bashPath,
			args: ["-l", "-c"],
			env: {
				PATH: Bun.env.PATH ?? "",
				HOME: Bun.env.HOME ?? tempDir,
			},
			prefix: undefined,
		});
		vi.spyOn(shellSnapshot, "getOrCreateSnapshot").mockResolvedValue(snapshotPath);
		const sessionKey = "snapshot-test";
		await executeBash("true", { cwd: tempDir, timeout: 5000, sessionKey });
		const result = await executeBash("echo $PI_SNAPSHOT_TEST", { cwd: tempDir, timeout: 5000, sessionKey });
		expect(result.output.trim()).toBe("from_snapshot");
	});

	it("can disable shell snapshots", async () => {
		if (process.platform === "win32") {
			return;
		}
		const bashPath = Bun.env.SHELL?.includes("bash") ? Bun.env.SHELL : "/bin/bash";
		if (!fs.existsSync(bashPath)) {
			return;
		}
		const snapshotPath = path.join(tempDir, "disabled-snapshot.sh");
		fs.writeFileSync(snapshotPath, "export PI_DISABLED_SNAPSHOT_TEST=from_snapshot\n");
		vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
			shell: bashPath,
			args: ["-l", "-c"],
			env: {
				PATH: Bun.env.PATH ?? "",
				HOME: Bun.env.HOME ?? tempDir,
			},
			prefix: undefined,
		});
		vi.spyOn(shellSnapshot, "getOrCreateSnapshot").mockResolvedValue(snapshotPath);

		const result = await executeBash("printenv PI_DISABLED_SNAPSHOT_TEST || printf unset", {
			cwd: tempDir,
			timeout: 5000,
			disableShellSnapshot: true,
			sessionKey: "disabled-snapshot-test",
		});
		expect(result.output.trim()).toBe("unset");
	});

	it("sources large bash functions without base64 eval wrappers", async () => {
		if (process.platform === "win32") {
			return;
		}
		const realBashPath = Bun.env.SHELL?.includes("bash") ? Bun.env.SHELL : "/bin/bash";
		if (!fs.existsSync(realBashPath)) {
			return;
		}

		const bashPath = path.join(tempDir, "test-bash");
		fs.symlinkSync(realBashPath, bashPath);
		const largeBody = Array.from({ length: 200 }, (_, index) => `    echo "snapshot ${index}"`).join("\n");
		fs.writeFileSync(path.join(tempDir, ".bashrc"), `pi_snapshot_large_function ()\n{\n${largeBody}\n}\n`);

		vi.spyOn(os, "homedir").mockReturnValue(tempDir);
		vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
			shell: bashPath,
			args: ["-l", "-c"],
			env: {
				PATH: Bun.env.PATH ?? "",
				HOME: tempDir,
			},
			prefix: undefined,
		});

		const snapshotPath = await shellSnapshot.getOrCreateSnapshot(bashPath, {
			PATH: Bun.env.PATH ?? "",
			HOME: tempDir,
		});
		expect(snapshotPath).not.toBeNull();
		const snapshot = fs.readFileSync(snapshotPath!, "utf8");
		expect(snapshot).toContain("pi_snapshot_large_function");
		expect(snapshot).not.toContain("base64 -d");

		const result = await executeBash("printf 'snapshot_ok\\n'", {
			cwd: tempDir,
			timeout: 5000,
			sessionKey: "large-function-snapshot",
		});
		expect(result.cancelled).toBe(false);
		expect(result.output.trim()).toBe("snapshot_ok");
	});

	it("does not allow exec to replace the host", async () => {
		const result = await executeBash("exec echo hi", { cwd: tempDir, timeout: 5000 });
		expect(result.cancelled).toBe(false);
		expect(result.exitCode).not.toBeUndefined();
		if (!result.output.includes("hi")) {
			expect(result.output.toLowerCase()).toContain("exec");
		}
	});

	it("completes even when background job keeps stdout pipe open", async () => {
		if (process.platform === "win32") return;

		const runPromise = executeBash("{ sleep 2; echo late; } & echo immediate", {
			cwd: tempDir,
			timeout: 5000,
		});
		const timed = await Promise.race([
			runPromise.then(result => ({ type: "result" as const, result })),
			Bun.sleep(BACKGROUND_COMPLETION_RACE_MS).then(() => ({ type: "timeout" as const })),
		]);

		expect(timed.type).toBe("result");
		if (timed.type === "result") {
			expect(timed.result.cancelled).toBe(false);
			expect(timed.result.exitCode).toBe(0);
			expect(timed.result.output).toContain("immediate");
		}
	});
	it("kills spawned process on timeout (not just orphans it)", async () => {
		if (process.platform === "win32") return;

		const marker = path.join(tempDir, "marker.txt");
		const markerEscaped = marker.replace(/'/g, "'\\''");

		// Command creates marker after a short delay, but we timeout before then.
		const result = await executeBash(`sleep ${KILL_MARKER_DELAY_SECONDS} && echo done > '${markerEscaped}'`, {
			cwd: tempDir,
			timeout: 100,
		});

		expect(result.cancelled).toBe(true);

		// Wait longer than the command would have needed to create the marker.
		await Bun.sleep(KILL_MARKER_ASSERTION_WAIT_MS);

		// If process was killed (not orphaned), marker should NOT exist
		expect(fs.existsSync(marker)).toBe(false);
	});

	it("kills background jobs on timeout", async () => {
		if (process.platform === "win32") return;

		const marker = path.join(tempDir, "marker-bg.txt");
		const markerEscaped = marker.replace(/'/g, "'\\''");

		const result = await executeBash(
			`{ sleep ${KILL_MARKER_DELAY_SECONDS}; echo done > '${markerEscaped}'; } & sleep 10`,
			{
				cwd: tempDir,
				timeout: 100,
			},
		);

		expect(result.cancelled).toBe(true);

		await Bun.sleep(KILL_MARKER_ASSERTION_WAIT_MS);
		expect(fs.existsSync(marker)).toBe(false);
	});

	it("kills background jobs on abort", async () => {
		if (process.platform === "win32") return;

		const marker = path.join(tempDir, "marker-bg-abort.txt");
		const markerEscaped = marker.replace(/'/g, "'\\''");
		const controller = new AbortController();

		const promise = executeBash(
			`{ sleep ${KILL_MARKER_DELAY_SECONDS}; echo done > '${markerEscaped}'; } & sleep 10`,
			{
				cwd: tempDir,
				timeout: 10000,
				signal: controller.signal,
			},
		);

		await Bun.sleep(100);
		controller.abort();
		const result = await promise;

		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("Command cancelled");

		await Bun.sleep(KILL_MARKER_ASSERTION_WAIT_MS);
		expect(fs.existsSync(marker)).toBe(false);
	});

	it("kills spawned process on abort (not just orphans it)", async () => {
		if (process.platform === "win32") return;

		const marker = path.join(tempDir, "marker.txt");
		const markerEscaped = marker.replace(/'/g, "'\\''");
		const controller = new AbortController();

		// Command creates marker after a short delay.
		const promise = executeBash(`sleep ${KILL_MARKER_DELAY_SECONDS} && echo done > '${markerEscaped}'`, {
			cwd: tempDir,
			timeout: 10000,
			signal: controller.signal,
		});

		// Abort before the command can create the marker.
		await Bun.sleep(100);
		controller.abort();
		const result = await promise;

		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("Command cancelled");

		// Wait longer than the command would have needed to create the marker.
		await Bun.sleep(KILL_MARKER_ASSERTION_WAIT_MS);

		// If process was killed (not orphaned), marker should NOT exist
		expect(fs.existsSync(marker)).toBe(false);
	});
});
