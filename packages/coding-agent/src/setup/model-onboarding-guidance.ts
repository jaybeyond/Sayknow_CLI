import { formatProviderCredentialHint } from "@sayknow-cli/ai/stream";
import { getOAuthProviders } from "@sayknow-cli/ai/utils/oauth";
import { formatProviderPresetChoices } from "./provider-onboarding";

export const MODEL_ONBOARDING_API_PROVIDER_COMMAND =
	"/provider add --compat <openai|anthropic> --provider <id> --base-url <url> --api-key-env <ENV> --model <model>";
/** Built from the bundled preset catalog, so a new preset shows up here without editing copy. */
export const MODEL_ONBOARDING_PROVIDER_PRESET_COMMAND = `/provider add --preset <${formatProviderPresetChoices()}>`;

export const MODEL_ONBOARDING_SETUP_COMMAND = "skc setup provider";
export const MODEL_ONBOARDING_OAUTH_COMMAND = "/provider login [provider-id] or /login [provider-id]";
/**
 * TypeSafe is not a chat model and never appears in the model list, so the only way a
 * user learns it exists is from the surfaces where they go to add credentials.
 */
export const MODEL_ONBOARDING_TYPESAFE_COMMAND = "/provider typesafe";
/** Where the models tried after a blocked one are shown and edited. */
export const MODEL_ONBOARDING_FALLBACK_COMMAND = "/fallback";

export function formatModelOnboardingGuidance(): string {
	return [
		"Model selection only shows configured providers.",
		"Assignment targets are DEFAULT plus the SKC role agents: EXECUTOR, ARCHITECT, PLANNER, and CRITIC.",
		"Legacy model-role aliases are compatibility-only and are not shown as assignment targets.",
		`OAuth/subscription providers: ${MODEL_ONBOARDING_OAUTH_COMMAND}.`,
		`Provider presets: ${MODEL_ONBOARDING_PROVIDER_PRESET_COMMAND} (or ${MODEL_ONBOARDING_SETUP_COMMAND} --preset <preset>).`,
		`API-compatible custom providers: ${MODEL_ONBOARDING_API_PROVIDER_COMMAND}.`,
		`Typed decisions (not a chat model): ${MODEL_ONBOARDING_TYPESAFE_COMMAND} adds a TypeSafe key.`,
		`Then run /model to select a configured model or assign it to a target, and ${MODEL_ONBOARDING_FALLBACK_COMMAND} to see what runs when it is blocked.`,
	].join("\n");
}

export function formatModelOnboardingInlineHint(): string {
	return `Log in with ${MODEL_ONBOARDING_OAUTH_COMMAND}; presets with ${MODEL_ONBOARDING_PROVIDER_PRESET_COMMAND}; custom API providers with ${MODEL_ONBOARDING_API_PROVIDER_COMMAND} (or ${MODEL_ONBOARDING_SETUP_COMMAND}); TypeSafe typed decisions with ${MODEL_ONBOARDING_TYPESAFE_COMMAND}; then run /model for DEFAULT, EXECUTOR, ARCHITECT, PLANNER, and CRITIC, and ${MODEL_ONBOARDING_FALLBACK_COMMAND} for what runs when a model is blocked.`;
}

export function formatNoModelOnboardingError(): string {
	return `No model selected.\n\n${formatModelOnboardingGuidance()}`;
}

/**
 * Missing credentials for the provider the session tried to call. The fix for that
 * provider comes first; the ways to add a different provider follow as alternatives.
 */
export function formatNoCredentialOnboardingError(providerId: string): string {
	const lines = [`No credentials found for ${providerId}.`, ""];
	const canLogIn = getOAuthProviders().some(provider => provider.id === providerId);
	const credentialHint = formatProviderCredentialHint(providerId);
	if (canLogIn) {
		lines.push(`Log in to ${providerId}: /login ${providerId} (interactive; not available in headless/print mode).`);
	}
	if (credentialHint) lines.push(credentialHint);
	if (!canLogIn && !credentialHint) {
		lines.push(`Add an API key for ${providerId} (the env var or apiKey its models.yml entry names).`);
	}
	lines.push(
		"",
		"Or use another provider:",
		`- OAuth/subscription: ${MODEL_ONBOARDING_OAUTH_COMMAND} (interactive; not available in headless/print mode).`,
		`- Presets: ${MODEL_ONBOARDING_PROVIDER_PRESET_COMMAND} (or ${MODEL_ONBOARDING_SETUP_COMMAND} --preset <preset>).`,
		`- API-compatible: ${MODEL_ONBOARDING_API_PROVIDER_COMMAND}.`,
		`Then run /model to select a configured model or assign it to DEFAULT, EXECUTOR, ARCHITECT, PLANNER, or CRITIC. With another provider logged in, a blocked model falls back automatically (${MODEL_ONBOARDING_FALLBACK_COMMAND}).`,
	);
	return lines.join("\n");
}

export function formatNoModelsAvailableFallback(): string {
	return `No models available. ${formatModelOnboardingGuidance()}`;
}
