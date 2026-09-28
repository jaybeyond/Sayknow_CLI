import { afterEach, describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import { applyCredentialRankingModeSetting } from "../../src/session/auth-storage-discovery";

const ENV = "SKC_CREDENTIAL_RANKING_MODE";
const original = process.env[ENV];

afterEach(() => {
	if (original === undefined) delete process.env[ENV];
	else process.env[ENV] = original;
});

function recorder() {
	const modes: string[] = [];
	return { modes, storage: { setCredentialRankingMode: (mode: string) => void modes.push(mode) } };
}

describe("auth.credentialRankingMode", () => {
	it("defaults to balanced and applies the configured order to the credential store", () => {
		delete process.env[ENV];
		expect(Settings.isolated().get("auth.credentialRankingMode")).toBe("balanced");

		const { modes, storage } = recorder();
		const settings = Settings.isolated({ "auth.credentialRankingMode": "earliest-reset" });
		expect(applyCredentialRankingModeSetting(storage, settings)).toBe("earliest-reset");
		expect(modes).toEqual(["earliest-reset"]);
	});

	it("lets the per-machine env var win, and ignores an unknown env value", () => {
		const settings = Settings.isolated({ "auth.credentialRankingMode": "earliest-reset" });
		const { modes, storage } = recorder();

		process.env[ENV] = "balanced";
		expect(applyCredentialRankingModeSetting(storage, settings)).toBe("balanced");

		process.env[ENV] = "fastest";
		expect(applyCredentialRankingModeSetting(storage, settings)).toBe("earliest-reset");
		expect(modes).toEqual(["balanced", "earliest-reset"]);
	});
});
