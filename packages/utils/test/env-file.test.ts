import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalEnvKey, type ProjectEnvSnapshot, parseEnvFileContent, projectEnvSnapshot } from "../src/env-file";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

function randomString(random: () => number, alphabet: string, maxLength: number): string {
	const length = Math.floor(random() * (maxLength + 1));
	let value = "";
	for (let i = 0; i < length; i++) {
		value += alphabet[Math.floor(random() * alphabet.length)] ?? "";
	}
	return value;
}

describe("parseEnvFileContent dotenv comment properties", () => {
	test("matches Bun for seeded comment, quoted-hash, and escaped-quote values", async () => {
		const seed = 0x5eedc0de;
		const random = seededRandom(seed);
		const literalAlphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._/-";
		const commentAlphabet = `${literalAlphabet} \\"'`;
		const cases: Array<{ key: string; raw: string; expected: string }> = [];
		const addCase = (raw: string, expected: string): void => {
			cases.push({ key: `SKC_DOTENV_PROPERTY_${cases.length}`, raw, expected });
		};

		for (let i = 0; i < 64; i++) {
			const prefix = randomString(random, literalAlphabet, 16);
			const backslashes = "\\".repeat(i < 13 ? i : Math.floor(random() * 13));
			const suffix = randomString(random, commentAlphabet, 20);
			addCase(`${prefix}${backslashes}#${suffix}`, `${prefix}${backslashes}`);
		}

		for (let i = 0; i < 24; i++) {
			const quote = i % 2 === 0 ? '"' : "'";
			const prefix = randomString(random, literalAlphabet, 16);
			const suffix = randomString(random, literalAlphabet, 20);
			const value = `${prefix}#${suffix}`;
			addCase(`${quote}${value}${quote}`, value);
		}

		for (let i = 0; i < 24; i++) {
			const prefix = randomString(random, literalAlphabet, 16);
			const escaped = randomString(random, literalAlphabet, 12);
			const suffix = randomString(random, commentAlphabet, 16);
			const slashCount = 1 + 2 * (i % 4);
			const backslashes = "\\".repeat(slashCount);
			const escapedOutside = `${prefix}${backslashes}"${escaped}#${suffix}`;
			addCase(escapedOutside, `${prefix}${backslashes}"${escaped}`);

			const quotedSuffix = randomString(random, literalAlphabet, 16);
			const quotedEscaped = `"${prefix}${backslashes}"${escaped}#${quotedSuffix}"`;
			addCase(quotedEscaped, `${prefix}${backslashes}"${escaped}#${quotedSuffix}`);
		}

		const dotenv = `${cases.map(({ key, raw }) => `${key}=${raw}`).join("\n")}\n`;
		const cwd = tempDir("skc-env-comment-property-");
		const home = tempDir("skc-env-comment-property-home-");
		fs.writeFileSync(path.join(cwd, ".env"), dotenv);
		const keys = cases.map(({ key }) => key);
		const probe = path.join(cwd, "dotenv-probe.ts");
		await Bun.write(
			probe,
			`const keys = ${JSON.stringify(keys)};\n` +
				`console.log(JSON.stringify(Object.fromEntries(keys.map(key => [key, process.env[key] ?? null]))));\n`,
		);

		const childEnv: Record<string, string | undefined> = { ...process.env, HOME: home };
		for (const key of keys) delete childEnv[key];
		const proc = Bun.spawn([process.execPath, probe], {
			cwd,
			env: childEnv,
			stdout: "pipe",
			stderr: "pipe",
			timeout: 10_000,
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);

		const bunValues = JSON.parse(stdout.trim()) as Record<string, string | null>;
		const expected = Object.fromEntries(cases.map(({ key, expected }) => [key, expected]));
		expect(parseEnvFileContent(dotenv), `seed ${seed}`).toEqual(expected);
		expect(bunValues, `seed ${seed}`).toEqual(expected);
	}, 15_000);
});

describe("projectEnvSnapshot non-identifier declaration properties", () => {
	test("marks seeded Bun-loaded npm key variants dynamic across dotenv layers", async () => {
		const seed = 0x5eedc0de;
		const random = seededRandom(seed);
		const separators = ["_", "-", "."];
		const layerFiles = [".env", ".env.development", ".env.local", ".env.development.local"];
		const declarationsByLayer: Record<string, string[]> = Object.fromEntries(layerFiles.map(file => [file, []]));
		const cases: Array<{ key: string; value: string }> = [];

		for (let caseIndex = 0; caseIndex < 64; caseIndex++) {
			const words =
				caseIndex % 2 === 0 ? ["npm", "config", "node", "options"] : ["npm", "config", "script", "shell"];
			const casedWords = words.map(word =>
				[...word].map(letter => (random() < 0.5 ? letter.toUpperCase() : letter)).join(""),
			);
			const prefixSeparator = separators[caseIndex % separators.length] ?? "_";
			const optionSeparator = caseIndex % 2 === 0 ? "-" : ".";
			const key = `${casedWords[0]}${prefixSeparator}${casedWords[1]}_${casedWords[2]}${optionSeparator}${casedWords[3]}`;
			const value = `SKC_DOTENV_NON_IDENTIFIER_${caseIndex}`;
			const declaration =
				caseIndex % 3 === 0
					? `${key}=${value}`
					: caseIndex % 3 === 1
						? `export ${key} = ${value}`
						: `${key} : ${value}`;
			const layer = layerFiles[caseIndex % layerFiles.length] ?? ".env";
			declarationsByLayer[layer]?.push(declaration);
			cases.push({ key, value });
		}

		expect(new Set(cases.map(({ key }) => key)).size).toBe(cases.length);

		const cwd = tempDir("skc-env-nonidentifier-property-");
		const home = tempDir("skc-env-nonidentifier-property-home-");
		for (const [file, declarations] of Object.entries(declarationsByLayer)) {
			fs.writeFileSync(path.join(cwd, file), `${declarations.join("\n")}\n`);
		}

		const keys = cases.map(({ key }) => key);
		const envFileSource = path.resolve(import.meta.dir, "../src/env-file.ts");
		const probe = path.join(cwd, "dotenv-nonidentifier-probe.ts");
		await Bun.write(
			probe,
			`import { canonicalEnvKey, projectEnvSnapshot } from ${JSON.stringify(envFileSource)};\n` +
				`const keys = ${JSON.stringify(keys)};\n` +
				`const snapshot = projectEnvSnapshot(process.cwd());\n` +
				`console.log(JSON.stringify({\n` +
				`  loaded: keys.map(key => process.env[key] ?? null),\n` +
				`  snapshotHas: keys.map(key => Object.hasOwn(snapshot.values, canonicalEnvKey(key))),\n` +
				`  dynamic: keys.map(key => snapshot.dynamic.has(canonicalEnvKey(key))),\n` +
				`}));\n`,
		);

		const generatedKeys = new Set(keys.map(canonicalEnvKey));
		const childEnv: Record<string, string | undefined> = { ...process.env, HOME: home, NODE_ENV: "development" };
		for (const inheritedKey of Object.keys(childEnv)) {
			if (generatedKeys.has(canonicalEnvKey(inheritedKey))) delete childEnv[inheritedKey];
		}
		const proc = Bun.spawn([process.execPath, probe], {
			cwd,
			env: childEnv,
			stdout: "pipe",
			stderr: "pipe",
			timeout: 10_000,
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);

		const result = JSON.parse(stdout.trim()) as {
			loaded: Array<string | null>;
			snapshotHas: boolean[];
			dynamic: boolean[];
		};
		for (const [caseIndex, { key, value }] of cases.entries()) {
			const context = `seed ${seed}, case ${caseIndex}, key ${key}`;
			expect(result.loaded[caseIndex], context).toBe(value);
			expect(result.snapshotHas[caseIndex], context).toBe(true);
			expect(result.dynamic[caseIndex], context).toBe(true);
		}
	}, 15_000);
});

describe("projectEnvSnapshot quoted declarations", () => {
	test("compares a plain quoted literal and refuses a quoted escape", () => {
		const cwd = tempDir("skc-env-quote-snap-");
		fs.writeFileSync(path.join(cwd, ".env"), 'PLAIN="hello"\nESCAPED="a\\nb"\nBARE=/tmp/plain\n');
		const snapshot = projectEnvSnapshot(cwd);
		expect(snapshot.values.PLAIN).toBe("hello");
		expect(snapshot.dynamic.has("PLAIN")).toBe(false);
		expect(snapshot.dynamic.has("ESCAPED")).toBe(true);
		expect(snapshot.dynamic.has("BARE")).toBe(false);
		expect(snapshot.values.BARE).toBe("/tmp/plain");
	});

	test("refuses a quote that continues onto the next physical line", () => {
		const cwd = tempDir("skc-env-quote-ml-snap-");
		fs.writeFileSync(path.join(cwd, ".env"), 'SKC_CODING_AGENT_DIR="/tmp/planted-multiline\nagent"\n');
		const snapshot = projectEnvSnapshot(cwd);
		expect(snapshot.dynamic.has("SKC_CODING_AGENT_DIR")).toBe(true);
	});

	/** Starts a fresh Bun in `cwd` and returns what its dotenv loader set for `keys`. */
	async function bunLoaded(cwd: string, keys: string[]): Promise<Record<string, string | null>> {
		const proc = Bun.spawn(
			[
				process.execPath,
				"-e",
				`console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(k => [k, process.env[k] ?? null]))))`,
			],
			{ cwd, env: { PATH: process.env.PATH ?? "", HOME: cwd }, stdout: "pipe", stderr: "pipe" },
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		return JSON.parse(stdout.trim()) as Record<string, string | null>;
	}

	function expectRefusedOrExact(snapshot: ProjectEnvSnapshot, loaded: Record<string, string | null>): void {
		for (const [key, value] of Object.entries(loaded)) {
			// Provenance must either refuse the key or hold exactly what this Bun loaded.
			const safe = value === null || snapshot.dynamic.has(key) || snapshot.values[key] === value;
			expect(safe, `${key}: loaded ${JSON.stringify(value)}, snapshot ${JSON.stringify(snapshot.values[key])}`).toBe(
				true,
			);
		}
	}

	test("refuses a quoted value with a suffix, which Bun 1.3 and 1.4 load differently", async () => {
		const cwd = tempDir("skc-env-quote-suffix-snap-");
		const declarations: Array<[string, string]> = [
			["CLOSED_COMMENT", '"v" #c'],
			["CLOSED_SPACES", '"v"   '],
			["SUFFIX_SPACE", '"v" ignored'],
			["SUFFIX_TIGHT", '"v"ignored'],
			["SUFFIX_SINGLE", "'v' x"],
			["SUFFIX_REQUOTED", '"v"x"'],
			["SUFFIX_HASH_INSIDE", '"a#b" c'],
			["SUFFIX_EMPTY", '"" x'],
			["SUFFIX_URL", '"https://attacker.example/v1" ignored'],
		];
		fs.writeFileSync(path.join(cwd, ".env"), declarations.map(([key, raw]) => `${key}=${raw}\n`).join(""));
		const snapshot = projectEnvSnapshot(cwd);
		expectRefusedOrExact(
			snapshot,
			await bunLoaded(
				cwd,
				declarations.map(([key]) => key),
			),
		);
		for (const [key] of declarations.slice(2)) expect(snapshot.dynamic.has(key), key).toBe(true);
		expect(snapshot.dynamic.has("CLOSED_COMMENT")).toBe(false);
		expect(snapshot.values.CLOSED_COMMENT).toBe("v");
		expect(snapshot.dynamic.has("CLOSED_SPACES")).toBe(false);
		expect(snapshot.values.CLOSED_SPACES).toBe("v");
	});

	test("refuses a later declaration a multi-line quoted value may have swallowed", async () => {
		const files = [
			'K=planted\nX="a" c\nK="other"\n',
			"K=planted\nX='a' c\nK='other'\n",
			'K=planted\nX="a\nK="other"\n',
			'K=planted\nX="\nK=other\n"\n',
			'K=planted\nX="a\\"\nK="other"\n',
			'K=planted\nnpm-x="a\nK="other"\n',
			'K=planted\r\nX="a" c\r\nK="other"\r\n',
		];
		for (const content of files) {
			const cwd = tempDir("skc-env-quote-swallow-snap-");
			fs.writeFileSync(path.join(cwd, ".env"), content);
			const snapshot = projectEnvSnapshot(cwd);
			expectRefusedOrExact(snapshot, await bunLoaded(cwd, ["K", "X"]));
			expect(snapshot.dynamic.has("K"), JSON.stringify(content)).toBe(true);
		}
	});

	test("keeps comparing declarations when every quoted value closes on its line", () => {
		const cwd = tempDir("skc-env-quote-closed-snap-");
		fs.writeFileSync(path.join(cwd, ".env"), "A=\"a\" # note\nB='b'\nK=planted\n");
		const snapshot = projectEnvSnapshot(cwd);
		expect(snapshot.dynamic.has("K")).toBe(false);
		expect(snapshot.values.K).toBe("planted");
	});
});

describe("projectEnvSnapshot bounded reads", () => {
	test("marks an oversized dotenv layer incomplete without parsing partial declarations", () => {
		const cwd = tempDir("skc-env-bounded-large-");
		fs.writeFileSync(path.join(cwd, ".env"), `TMPDIR=/tmp/planted\n${"x".repeat(128)}`);

		const snapshot = projectEnvSnapshot(cwd, { maxFileBytes: 16 });
		expect(snapshot.incomplete).toBe(true);
		expect(snapshot.values.TMPDIR).toBeUndefined();
	});

	test("rejects a device-file dotenv layer without blocking", async () => {
		if (process.platform === "win32") return;
		const cwd = tempDir("skc-env-bounded-device-");
		const processCwd = tempDir("skc-env-bounded-runner-");
		fs.symlinkSync("/dev/zero", path.join(cwd, ".env"));
		const source = path.resolve(import.meta.dir, "../src/env-file.ts");
		const script = path.join(processCwd, "snapshot-probe.ts");
		await Bun.write(
			script,
			`import { projectEnvSnapshot } from ${JSON.stringify(source)};\n` +
				`console.log(JSON.stringify({ incomplete: projectEnvSnapshot(${JSON.stringify(cwd)}, { maxFileBytes: 64 }).incomplete }));\n`,
		);
		const proc = Bun.spawn([process.execPath, script], {
			cwd: processCwd,
			stdout: "pipe",
			stderr: "pipe",
			timeout: 5_000,
			killSignal: "SIGKILL",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout.trim())).toEqual({ incomplete: true });
	}, 10_000);
});

const dirsSource = path.join(import.meta.dir, "../src/dirs.ts");

async function printedAgentDir(cwd: string, env: Record<string, string | undefined> = {}): Promise<string> {
	const script = path.join(cwd, "print-agent-dir.ts");
	await Bun.write(script, `import { getAgentDir } from ${JSON.stringify(dirsSource)};\nconsole.log(getAgentDir());\n`);
	const childEnv: Record<string, string | undefined> = { ...process.env, HOME: env.HOME, ...env };
	delete childEnv.SKC_CODING_AGENT_DIR;
	delete childEnv.PI_CODING_AGENT_DIR;
	delete childEnv.SKC_CONFIG_DIR;
	delete childEnv.PI_CONFIG_DIR;
	if (env.SKC_CODING_AGENT_DIR !== undefined) childEnv.SKC_CODING_AGENT_DIR = env.SKC_CODING_AGENT_DIR;
	const proc = Bun.spawn([process.execPath, script], {
		cwd,
		env: childEnv,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const code = await proc.exited;
	if (code !== 0) throw new Error(stderr || stdout || `getAgentDir probe exited ${code}`);
	const printed = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
	if (printed.length === 0) throw new Error(`getAgentDir probe printed nothing: ${stderr}`);
	return printed;
}

describe("getAgentDir quote provenance", () => {
	test("does not follow a double-quoted newline planted by the project .env", async () => {
		const cwd = tempDir("skc-env-quote-nl-");
		const home = tempDir("skc-env-quote-home-");
		fs.writeFileSync(path.join(cwd, ".env"), 'SKC_CODING_AGENT_DIR="/tmp/planted-agent\\n"\n');
		const agentDir = await printedAgentDir(cwd, { HOME: home });
		expect(agentDir.includes("planted-agent")).toBe(false);
	});

	test("does not follow a planted value whose backslash is not an escape", async () => {
		const cwd = tempDir("skc-env-quote-bs-");
		const home = tempDir("skc-env-quote-home-");
		fs.writeFileSync(path.join(cwd, ".env"), 'SKC_CODING_AGENT_DIR="/tmp/planted\\agent"\n');
		const agentDir = await printedAgentDir(cwd, { HOME: home });
		expect(agentDir.includes("planted")).toBe(false);
	});

	test("does not follow a double-quoted agent dir split across physical lines", async () => {
		const cwd = tempDir("skc-env-quote-ml-");
		const home = tempDir("skc-env-quote-home-");
		fs.writeFileSync(path.join(cwd, ".env"), 'SKC_CODING_AGENT_DIR="/tmp/planted-multiline\nagent"\n');
		const agentDir = await printedAgentDir(cwd, { HOME: home });
		expect(agentDir.includes("planted-multiline")).toBe(false);
	});

	test("does not follow a legacy PI_CODING_AGENT_DIR quoted newline", async () => {
		const cwd = tempDir("skc-env-quote-pi-");
		const home = tempDir("skc-env-quote-home-");
		fs.writeFileSync(path.join(cwd, ".env"), 'PI_CODING_AGENT_DIR="/tmp/planted-pi\\n"\n');
		const agentDir = await printedAgentDir(cwd, { HOME: home });
		expect(agentDir.includes("planted-pi")).toBe(false);
	});

	test("does not follow a quoted CRLF that path.resolve would collapse", async () => {
		const cwd = tempDir("skc-env-quote-crlf-");
		const home = tempDir("skc-env-quote-home-");
		fs.writeFileSync(path.join(cwd, ".env"), 'SKC_CODING_AGENT_DIR="/tmp/segment\r\n/../planted-agent"\n');
		const agentDir = await printedAgentDir(cwd, { HOME: home });
		expect(agentDir.includes("planted-agent")).toBe(false);
	});

	test("does not follow a backslash and physical CR planted inside double quotes", async () => {
		const cwd = tempDir("skc-env-quote-cr-");
		const home = tempDir("skc-env-quote-home-");
		fs.writeFileSync(path.join(cwd, ".env"), 'SKC_CODING_AGENT_DIR="/tmp/planted-cr\\\r"\n');
		const agentDir = await printedAgentDir(cwd, { HOME: home });
		expect(agentDir.includes("planted-cr")).toBe(false);
	});

	test("still honors an operator agent dir when the project has no .env", async () => {
		const cwd = tempDir("skc-env-quote-op-");
		const home = tempDir("skc-env-quote-home-");
		const operatorDir = tempDir("skc-env-quote-operator-");
		const agentDir = await printedAgentDir(cwd, { HOME: home, SKC_CODING_AGENT_DIR: operatorDir });
		expect(agentDir).toBe(operatorDir);
	});

	test("still honors a different unquoted operator agent dir", async () => {
		const cwd = tempDir("skc-env-quote-op-unquoted-");
		const home = tempDir("skc-env-quote-home-");
		const operatorDir = tempDir("skc-env-quote-operator-");
		fs.writeFileSync(path.join(cwd, ".env"), "SKC_CODING_AGENT_DIR=/tmp/planted-unquoted\n");
		const agentDir = await printedAgentDir(cwd, { HOME: home, SKC_CODING_AGENT_DIR: operatorDir });
		expect(agentDir).toBe(operatorDir);
	});

	test("still honors an operator dir when a plain quote has a trailing comment", async () => {
		const cwd = tempDir("skc-env-quote-op-comment-");
		const home = tempDir("skc-env-quote-home-");
		const operatorDir = tempDir("skc-env-quote-operator-");
		fs.writeFileSync(path.join(cwd, ".env"), 'SKC_CODING_AGENT_DIR="/tmp/plain" # ordinary comment\n');
		const agentDir = await printedAgentDir(cwd, { HOME: home, SKC_CODING_AGENT_DIR: operatorDir });
		expect(agentDir).toBe(operatorDir);
	});

	test("still honors an operator dir when an unquoted comment contains a quote", async () => {
		const cwd = tempDir("skc-env-quote-op-unquoted-comment-");
		const home = tempDir("skc-env-quote-home-");
		const operatorDir = tempDir("skc-env-quote-operator-");
		fs.writeFileSync(path.join(cwd, ".env"), "SKC_CODING_AGENT_DIR=/tmp/plain # operator's note\n");
		const agentDir = await printedAgentDir(cwd, { HOME: home, SKC_CODING_AGENT_DIR: operatorDir });
		expect(agentDir).toBe(operatorDir);
	});

	test("still honors a different operator dir when the project quote is plain", async () => {
		const cwd = tempDir("skc-env-quote-op-plain-");
		const home = tempDir("skc-env-quote-home-");
		const operatorDir = tempDir("skc-env-quote-operator-");
		fs.writeFileSync(path.join(cwd, ".env"), 'SKC_CODING_AGENT_DIR="/tmp/planted-plain"\n');
		const agentDir = await printedAgentDir(cwd, { HOME: home, SKC_CODING_AGENT_DIR: operatorDir });
		expect(agentDir).toBe(operatorDir);
	});
});
