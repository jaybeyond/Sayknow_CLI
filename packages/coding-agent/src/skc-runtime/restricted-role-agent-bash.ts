export const SKC_RESTRICTED_ROLE_AGENT_BASH_ENV = "SKC_RESTRICTED_ROLE_AGENT_BASH";
export const SKC_RALPLAN_ARTIFACT_ENV = "SKC_RALPLAN_ARTIFACT";

export function isRestrictedRoleAgentBash(): boolean {
	return process.env[SKC_RESTRICTED_ROLE_AGENT_BASH_ENV] === "1";
}
