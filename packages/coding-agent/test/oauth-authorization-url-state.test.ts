import { describe, expect, it } from "bun:test";
import { OAuthAuthorizationUrlState } from "../src/modes/interactive-mode";

describe("OAuthAuthorizationUrlState", () => {
	it("prevents an older flow from clearing a newer URL", () => {
		const state = new OAuthAuthorizationUrlState();
		const older = state.set("https://auth.example/older");
		const newer = state.set("https://auth.example/newer");

		state.clear(older);
		expect(state.current).toBe("https://auth.example/newer");
		state.clear(newer);
		expect(state.current).toBeUndefined();
	});

	it("uses distinct ownership even when concurrent flows receive the same URL", () => {
		const state = new OAuthAuthorizationUrlState();
		const older = state.set("https://auth.example/shared");
		const newer = state.set("https://auth.example/shared");

		state.clear(older);
		expect(state.current).toBe("https://auth.example/shared");
		state.clear(newer);
		expect(state.current).toBeUndefined();
	});
});
