// Prints the Anthropic endpoint decisions this process resolves.
// Spawned with a controlled cwd so the caller can plant a project `.env`: the
// env module parses `projectEnv` at load time from `process.cwd()`, so the
// trust boundary can only be exercised from a separate process.
import { resolveAnthropicBaseUrlFromEnv } from "@sayknow-cli/ai/utils/anthropic-auth";
import { isFoundryEnabled } from "@sayknow-cli/ai/utils/foundry";

console.log(
	JSON.stringify({
		foundryEnabled: isFoundryEnabled(),
		baseUrl: resolveAnthropicBaseUrlFromEnv() ?? null,
	}),
);
