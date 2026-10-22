import { expect, test } from "bun:test";
import { canonicalEnvKey, type ProjectEnvSnapshot } from "@sayknow-cli/utils/env-file";
import { sdkCwdEqualityTestSeamActive } from "../src/commands/sdk";

// Port of upstream 42c8161857 (#7034) provenance property. The fork has only
// the two in-process cwd-equality seams and no broker child env to scrub, so
// the omit/child-env half and the runSessionHost integration cases are not
// applicable. fast-check is replaced by a seeded xorshift32 loop (same seed).

const SEAMS = ["SKC_SDK_TEST_HANG_MODEL_PROFILE", "SKC_SDK_TEST_FAIL_AFTER_REGISTRATION"] as const;

function emptySnapshot(): ProjectEnvSnapshot {
	return { values: {}, dynamic: new Set() };
}

test("property: cwd-equality seams follow trusted provenance", () => {
	let state = 30921 >>> 0;
	const next = (): number => {
		state ^= state << 13;
		state >>>= 0;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		return state / 0x1_0000_0000;
	};
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789/._- ";
	const modes = ["absent", "equal", "other", "dynamic"] as const;
	for (let run = 0; run < 64; run++) {
		const name = SEAMS[Math.floor(next() * SEAMS.length)] ?? SEAMS[0];
		let cwd = "";
		while (cwd.trim().length === 0) {
			cwd = Array.from({ length: 1 + Math.floor(next() * 24) }, () => chars[Math.floor(next() * chars.length)]).join(
				"",
			);
		}
		const mode = modes[Math.floor(next() * modes.length)];
		const key = canonicalEnvKey(name);
		const env: NodeJS.ProcessEnv = { [name]: cwd };
		const snapshot: ProjectEnvSnapshot =
			mode === "absent"
				? emptySnapshot()
				: mode === "equal"
					? { values: { [key]: cwd }, dynamic: new Set() }
					: mode === "other"
						? { values: { [key]: `${cwd}-other` }, dynamic: new Set() }
						: { values: { [key]: "$PWD" }, dynamic: new Set([key]) };
		const expected = mode === "absent" || mode === "other";
		expect(sdkCwdEqualityTestSeamActive(name, cwd, env, [snapshot, snapshot]), `${name} ${mode}`).toBe(expected);
		// Any snapshot that declares the same value refuses the seam.
		expect(
			sdkCwdEqualityTestSeamActive(name, cwd, env, [
				emptySnapshot(),
				{ values: { [key]: cwd }, dynamic: new Set() },
			]),
		).toBe(false);
		expect(env[name]).toBe(cwd);
	}
	expect(sdkCwdEqualityTestSeamActive("NOT_A_SEAM", "/repo", { NOT_A_SEAM: "/repo" }, [emptySnapshot()])).toBe(false);
	const spaced = "/repo ";
	expect(
		sdkCwdEqualityTestSeamActive(SEAMS[0], spaced, { [SEAMS[0]]: spaced }, [emptySnapshot(), emptySnapshot()]),
	).toBe(true);
	expect(sdkCwdEqualityTestSeamActive(SEAMS[0], "/repo", { [SEAMS[0]]: "/other" }, [emptySnapshot()])).toBe(false);
});
