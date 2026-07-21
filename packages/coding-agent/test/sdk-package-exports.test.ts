import { describe, expect, it } from "bun:test";
import type {
	Q10CurrentThinkingLevel,
	Q10Model,
	Q10SettableThinkingLevel,
	Q10ThinkingCapabilities,
	Q10ThinkingEffort,
	Q10ThinkingMode,
} from "@sayknow-cli/coding-agent/sdk";
import * as publicSdk from "@sayknow-cli/coding-agent/sdk";
import * as bus from "@sayknow-cli/coding-agent/sdk/bus";
import packageJson from "../package.json";
import * as root from "../src/index";
import * as sdk from "../src/sdk";
import * as session from "../src/sdk/session";

const q10DtoTypes:
	| [
			Q10Model,
			Q10ThinkingCapabilities,
			Q10ThinkingEffort,
			Q10SettableThinkingLevel,
			Q10CurrentThinkingLevel,
			Q10ThinkingMode,
	  ]
	| undefined = undefined;

void q10DtoTypes;

describe("SDK package exports", () => {
	it("preserves the session SDK surface and bus namespace after the namespace move", () => {
		for (const exportName of Object.keys(session)) expect(sdk).toHaveProperty(exportName);
		expect(sdk).toHaveProperty("bus");
		expect(root).toHaveProperty("createAgentSession");
	});

	it("loads the public SDK and bus package subpaths", () => {
		expect(publicSdk.createAgentSession).toBeFunction();
		expect(bus.createNotificationsExtension).toBeFunction();
	});

	it.each([
		"@sayknow-cli/coding-agent/sdk/models",
		"@sayknow-cli/coding-agent/sdk/models.js",
		"@sayknow-cli/coding-agent/sdk/lifecycle-session",
		"@sayknow-cli/coding-agent/sdk/lifecycle-session.js",
		"@sayknow-cli/coding-agent/sdk/startup-capability",
		"@sayknow-cli/coding-agent/sdk/startup-capability.js",
	])("rejects resolution of the private %s subpath", async subpath => {
		const child = Bun.spawn([process.execPath, "-e", `await import(${JSON.stringify(subpath)})`], {
			cwd: import.meta.dir,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		const output = `${stdout}${stderr}`;

		expect(exitCode).not.toBe(0);
		expect(output).toMatch(/error/i);
		expect(output).toContain(subpath);
	});

	it("keeps internal SDK modules off the public package surface", () => {
		for (const subpath of [
			"./sdk/models",
			"./sdk/models.js",
			"./sdk/lifecycle-session",
			"./sdk/lifecycle-session.js",
			"./sdk/startup-capability",
			"./sdk/startup-capability.js",
		] as const)
			expect(packageJson.exports[subpath]).toBeNull();
	});
});
