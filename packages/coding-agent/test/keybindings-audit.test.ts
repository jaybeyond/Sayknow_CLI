import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KEYBINDINGS } from "../src/config/keybindings";

const DOC_PATH = join(import.meta.dir, "../../../docs/keybindings.md");

describe("docs/keybindings.md current-surface audit", () => {
	it("documents every registry action ID (no drift)", () => {
		const doc = readFileSync(DOC_PATH, "utf8");
		const missing = Object.keys(KEYBINDINGS).filter(id => !doc.includes(`\`${id}\``));
		expect(missing).toEqual([]);
	});
});
