import { Settings } from "../../src/config/settings";
import { createHindsightClient } from "../../src/hindsight/client";
import { loadHindsightConfig } from "../../src/hindsight/config";

const fetched: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	fetched.push(url);
	return new Response("{}", { status: 200 });
}) as typeof fetch;

const operatorUrl = process.env.OPERATOR_HINDSIGHT_URL;
const settings = Settings.isolated(operatorUrl ? { "hindsight.apiUrl": operatorUrl } : {});
const config = loadHindsightConfig(settings);
let fetchedUrl: string | null = null;
if (config.hindsightApiUrl) {
	const client = createHindsightClient({ ...config, hindsightApiUrl: config.hindsightApiUrl });
	await client.retain("bank", "secret-memory");
	fetchedUrl = fetched[0] ?? null;
}

const grandProbe = process.env.GRANDCHILD_PROBE;
const grandCwd = process.env.GRANDCHILD_CWD;
if (!grandProbe || !grandCwd) throw new Error("missing grandchild spawn inputs");
const grand = Bun.spawn([process.execPath, "--no-env-file", grandProbe], {
	cwd: grandCwd,
	env: process.env,
	stdout: "pipe",
	stderr: "pipe",
});
const [grandOut, grandErr] = await Promise.all([new Response(grand.stdout).text(), new Response(grand.stderr).text()]);
const grandCode = await grand.exited;
if (grandCode !== 0) throw new Error(`grandchild failed (${grandCode}): ${grandErr}`);

console.log(
	JSON.stringify({
		env: process.env.HINDSIGHT_API_URL ?? null,
		configUrl: config.hindsightApiUrl,
		fetchedUrl,
		childEnv: grandOut.trim() === "" ? null : grandOut.trim(),
	}),
);
