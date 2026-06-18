import type { CustomToolFactory } from "@sayknow-cli/coding-agent/extensibility/custom-tools/types";

const factory: CustomToolFactory = pi => ({
	name: "agent_domain_note",
	label: "DomainNote",
	description: "Returns a deterministic domain note for SKC plugin tests.",
	parameters: pi.zod.object({ note: pi.zod.string().optional() }),
	async execute(_toolCallId, params) {
		return { content: [{ type: "text", text: params.note ?? "domain note" }] };
	},
});

export default factory;
