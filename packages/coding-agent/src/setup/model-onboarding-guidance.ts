import { formatProviderCredentialHint } from "@sayknow-cli/ai/stream";

export const MODEL_ONBOARDING_API_PROVIDER_COMMAND =
	"/provider add --compat <openai|anthropic> --provider <id> --base-url <url> --api-key-env <ENV> --model <model>";
export const MODEL_ONBOARDING_PROVIDER_PRESET_COMMAND = "/provider add --preset <minimax|minimax-cn|glm>";

export const MODEL_ONBOARDING_SETUP_COMMAND = "skc setup provider";
export const MODEL_ONBOARDING_OAUTH_COMMAND = "/provider login [provider-id] or /login [provider-id]";
/**
 * TypeSafe is not a chat model and never appears in the model list, so the only way a
 * user learns it exists is from the surfaces where they go to add credentials.
 */
export const MODEL_ONBOARDING_TYPESAFE_COMMAND = "/provider typesafe";

export function formatModelOnboardingGuidance(): string {
	return [
		"Model selection only shows configured providers.",
		"Assignment targets are DEFAULT plus the SKC role agents: EXECUTOR, ARCHITECT, PLANNER, and CRITIC.",
		"Legacy model-role aliases are compatibility-only and are not shown as assignment targets.",
		`Provider presets: ${MODEL_ONBOARDING_PROVIDER_PRESET_COMMAND} (or ${MODEL_ONBOARDING_SETUP_COMMAND} --preset <preset>).`,
		`API-compatible custom providers: ${MODEL_ONBOARDING_API_PROVIDER_COMMAND}.`,
		`OAuth/subscription providers: ${MODEL_ONBOARDING_OAUTH_COMMAND}.`,
		`Typed decisions (not a chat model): ${MODEL_ONBOARDING_TYPESAFE_COMMAND} adds a TypeSafe key.`,
		"Then run /model to select a configured model or assign it to a target.",
	].join("\n");
}

export function formatModelOnboardingInlineHint(): string {
	return `Add MiniMax/GLM presets with ${MODEL_ONBOARDING_PROVIDER_PRESET_COMMAND}; custom API providers with ${MODEL_ONBOARDING_API_PROVIDER_COMMAND} (or ${MODEL_ONBOARDING_SETUP_COMMAND}); OAuth/subscription with ${MODEL_ONBOARDING_OAUTH_COMMAND}; TypeSafe typed decisions with ${MODEL_ONBOARDING_TYPESAFE_COMMAND}; then run /model for DEFAULT, EXECUTOR, ARCHITECT, PLANNER, and CRITIC.`;
}

export function formatNoModelOnboardingError(): string {
	return `No model selected.\n\n${formatModelOnboardingGuidance()}`;
}

export function formatNoCredentialOnboardingError(providerId: string): string {
	const lines = [
		`No credentials found for ${providerId}.`,
		"",
		`For MiniMax/GLM presets, configure credentials with ${MODEL_ONBOARDING_PROVIDER_PRESET_COMMAND} (or ${MODEL_ONBOARDING_SETUP_COMMAND} --preset <preset>).`,
		`For custom API-compatible providers, use ${MODEL_ONBOARDING_API_PROVIDER_COMMAND}.`,
		`For OAuth/subscription providers, use ${MODEL_ONBOARDING_OAUTH_COMMAND} (interactive; not available in headless/print mode).`,
	];
	const headlessHint = formatProviderCredentialHint(providerId);
	if (headlessHint) lines.push(headlessHint);
	lines.push(
		"Then run /model to select a configured model or assign it to DEFAULT, EXECUTOR, ARCHITECT, PLANNER, or CRITIC.",
	);
	return lines.join("\n");
}

export function formatNoModelsAvailableFallback(): string {
	return `No models available. ${formatModelOnboardingGuidance()}`;
}
