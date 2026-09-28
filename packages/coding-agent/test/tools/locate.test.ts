import { describe, expect, it } from "bun:test";
import { summarizeCode } from "@sayknow-cli/natives";
import { Settings } from "../../src/config/settings";
import type { DecisionRequest, DecisionResult } from "../../src/decisions/types";
import { LocateTool } from "../../src/tools/locate";
import { LEAF_FOLDER_FILES, locateCode, outlineFromSegments } from "../../src/tools/locate-core";

function outlineOf(code: string, path = "sample.ts") {
	return outlineFromSegments(
		summarizeCode({ code, path, minBodyLines: 1, minCommentLines: 1 }).segments,
		code.split("\n"),
	);
}

describe("outline sent to Jev", () => {
	it("keeps declaration lines and drops bodies, comments and imports", () => {
		const outline = outlineOf(`import { secretImport } from "./x";

// secret line comment
/** secret doc comment */
export function refresh(key: string): boolean {
	const secretBody = key.split("");
	return secretBody.length > 0;
}

export class Store {
	private secretField = "secret-initialiser";
	reload(): void {
		console.log("secret statement");
	}
}
`);
		const text = outline.map(entry => entry.text).join("\n");
		expect(text).toContain("export function refresh(key: string): boolean {");
		expect(text).toContain("export class Store {");
		expect(text).toContain("reload(): void {");
		for (const leaked of [
			"secretBody",
			"secret statement",
			"secret line comment",
			"secret doc comment",
			"secretImport",
			"secret-initialiser",
		]) {
			expect(text).not.toContain(leaked);
		}
		expect(outline.find(entry => entry.text.startsWith("export function refresh"))?.line).toBe(5);
	});

	it("keeps classes and methods before fields when a file has too many declarations", () => {
		const fields = Array.from({ length: 80 }, (_, i) => `\tfield${i}: string;`).join("\n");
		const outline = outlineOf(
			`export interface Wide {\n${fields}\n}\n\nexport class Late {\n\tmethod(a: number): number {\n\t\treturn a;\n\t}\n}\n`,
		);
		const text = outline.map(entry => entry.text).join("\n");
		expect(text).toContain("export class Late {");
		expect(text).toContain("method(a: number): number {");
		expect(outline.length).toBeLessThanOrEqual(60);
		// Line order is preserved.
		expect(outline.map(entry => entry.line)).toEqual([...outline.map(entry => entry.line)].sort((a, b) => a - b));
	});
});

/** Big enough that the root is split: auth/ui/db folders of 20 files each. */
function repo(): string[] {
	const files: string[] = ["README.md"];
	for (const folder of ["auth", "ui", "db"]) {
		for (let i = 0; i < 20; i++) files.push(`app/${folder}/file${i}.ts`);
	}
	files.push("app/auth/login.ts");
	return files;
}

function fakeJev(onRequest: (request: DecisionRequest) => void = () => {}) {
	return async (request: DecisionRequest): Promise<DecisionResult> => {
		onRequest(request);
		const answers: DecisionResult["answers"] = {};
		for (const [key, question] of Object.entries(request.questions)) {
			const target = /"([^"]+)"/.exec(question.instructions)?.[1] ?? "";
			// Like Jev: the path toward the answer is plausible, the answer itself is clear.
			const isFolder = target.endsWith("/");
			const score = isFolder
				? target === "app/" || target === "app/auth/"
					? 0.8
					: 0.1
				: target.endsWith("login.ts")
					? 0.9
					: 0.2;
			answers[key] = { type: "noul", noul: score };
		}
		return { answers, backend: "typesafe", model: "jev-test", calibrated: true, durationMs: 1 };
	};
}

describe("locateCode", () => {
	it("enters only plausible folders and ranks files by Jev's judgement", async () => {
		expect(repo().length).toBeGreaterThan(LEAF_FOLDER_FILES);
		const states: string[] = [];
		const result = await locateCode(
			{ query: "Where is login handled?", root: "/repo", limit: 5 },
			{
				listFiles: async () => repo(),
				outline: async file => [
					{ line: 1, text: `export function ${file.split("/").pop()?.replace(".ts", "")}() {` },
				],
				decide: fakeJev(request => states.push(String(request.state))),
			},
		);
		expect(result.files.map(file => file.path)).toEqual(["app/auth/login.ts"]);
		expect(result.failedRequests).toBe(0);
		// The ui/ and db/ files were never sent for file judgement.
		const fileStates = states.filter(state => state.includes("Files (declarations only)"));
		expect(fileStates.length).toBeGreaterThan(0);
		expect(fileStates.join("\n")).not.toContain("app/ui/");
		expect(fileStates.join("\n")).not.toContain("app/db/");
	});

	it("treats a request that throws as a failed judgement, not a failed search", async () => {
		const result = await locateCode(
			{ query: "anything", root: "/repo", limit: 5 },
			{
				listFiles: async () => repo(),
				outline: async () => [],
				decide: async () => {
					throw new DOMException("The operation was aborted.", "AbortError");
				},
			},
		);
		expect(result.requests).toBeGreaterThan(0);
		expect(result.failedRequests).toBe(result.requests);
		expect(result.files).toEqual([]);
	});

	it("offers weak leads when nothing clears the bar", async () => {
		const result = await locateCode(
			{ query: "q", root: "/repo", limit: 5 },
			{
				listFiles: async () => ["a.ts", "b.ts"],
				outline: async () => [],
				decide: async request => ({
					answers: Object.fromEntries(
						Object.keys(request.questions).map(key => [key, { type: "noul", noul: 0.2 }]),
					),
					backend: "typesafe",
					model: "jev-test",
					calibrated: true,
					durationMs: 1,
				}),
			},
		);
		expect(result.files).toEqual([]);
		expect(result.weakLeads.map(file => file.path)).toEqual(["a.ts", "b.ts"]);
	});
});

describe("locate tool availability", () => {
	const session = (settings: Record<string, unknown>, hasKey: boolean) =>
		({
			cwd: "/repo",
			settings: Settings.isolated(settings),
			modelRegistry: { authStorage: { hasAuth: (provider: string) => hasKey && provider === "typesafe" } },
		}) as never;

	it("is offered only with a TypeSafe key and while enabled", () => {
		expect(LocateTool.createIf(session({}, true))).toBeInstanceOf(LocateTool);
		expect(LocateTool.createIf(session({}, false))).toBeNull();
		expect(LocateTool.createIf(session({ "locate.enabled": false }, true))).toBeNull();
	});
});
