import { expect, test } from "bun:test";
import {
	assertNativeRuntimeCompatibility,
	NativeRuntimeCompatibilityError,
} from "../src/sdk/bus/native-runtime-compatibility";

test("accepts matching generated native build versions with workflow arbitration capabilities", () => {
	expect(() =>
		assertNativeRuntimeCompatibility({
			runtimeVersion: "0.10.2",
			nativeVersion: "0.10.2",
			notificationServer: {
				registerArbitratedAsk: () => {},
				retireIfUnclaimed: () => {},
				stopAndWait: () => {},
			},
		}),
	).not.toThrow();
});

class StaleNotificationServer {
	registerArbitratedAsk(): void {}
}

test("rejects a matching native build missing a required workflow arbitration capability", () => {
	expect(() =>
		assertNativeRuntimeCompatibility({
			runtimeVersion: "0.10.2",
			nativeVersion: "0.10.2",
			notificationServer: StaleNotificationServer.prototype,
		}),
	).toThrow(NativeRuntimeCompatibilityError);

	try {
		assertNativeRuntimeCompatibility({
			runtimeVersion: "0.10.2",
			nativeVersion: "0.10.2",
			notificationServer: StaleNotificationServer.prototype,
		});
	} catch (error) {
		expect(error).toMatchObject({
			code: "native_runtime_incompatible",
			retryable: false,
			runtimeVersion: "0.10.2",
			nativeVersion: "0.10.2",
			workflowArbitrationAvailable: false,
		});
	}
});
test("rejects a matching native build missing stopAndWait", () => {
	expect(() =>
		assertNativeRuntimeCompatibility({
			runtimeVersion: "0.10.2",
			nativeVersion: "0.10.2",
			notificationServer: {
				registerArbitratedAsk: () => {},
				retireIfUnclaimed: () => {},
			},
		}),
	).toThrow(NativeRuntimeCompatibilityError);
});
test("rejects mismatched generated native build versions as non-retryable compatibility errors", () => {
	expect(() =>
		assertNativeRuntimeCompatibility({
			runtimeVersion: "0.10.2",
			nativeVersion: "0.10.1",
			notificationServer: {
				registerArbitratedAsk: () => {},
				retireIfUnclaimed: () => {},
				stopAndWait: () => {},
			},
		}),
	).toThrow(NativeRuntimeCompatibilityError);
});

test("reports a version mismatch without claiming the arbitration capability is a cause", () => {
	try {
		assertNativeRuntimeCompatibility({
			runtimeVersion: "0.10.2",
			nativeVersion: "0.10.1",
			notificationServer: {
				registerArbitratedAsk: () => {},
				retireIfUnclaimed: () => {},
				stopAndWait: () => {},
			},
			nativeModulePath: "/repo/packages/coding-agent/node_modules/@sayknow-cli/natives/native/index.js",
		});
		throw new Error("expected NativeRuntimeCompatibilityError");
	} catch (error) {
		const message = (error as Error).message;
		expect(message).toContain("loaded native version is 0.10.1");
		expect(message).toContain("expected 0.10.2");
		expect(message).toContain("/repo/packages/coding-agent/node_modules/@sayknow-cli/natives/native/index.js");
		expect(message).not.toContain("arbitration methods are available");
		expect(message).not.toContain("arbitration methods are missing");
	}
});

test("reports the module path resolved from the running process when the caller supplies none", () => {
	try {
		assertNativeRuntimeCompatibility({
			runtimeVersion: "0.10.2",
			nativeVersion: "0.10.1",
			notificationServer: StaleNotificationServer.prototype,
		});
		throw new Error("expected NativeRuntimeCompatibilityError");
	} catch (error) {
		expect(error).toBeInstanceOf(NativeRuntimeCompatibilityError);
		const { nativeModulePath, message } = error as NativeRuntimeCompatibilityError;
		expect(nativeModulePath).toContain("natives");
		expect(message).toContain(`loaded from ${nativeModulePath}`);
		expect(message).toContain("required workflow arbitration methods are missing");
	}
});
