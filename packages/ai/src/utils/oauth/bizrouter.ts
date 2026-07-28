/** BizRouter login flow (API key paste, validated via /v1/models). */
import { createApiKeyLogin } from "./api-key-login";

export const loginBizRouter = createApiKeyLogin({
	providerLabel: "BizRouter",
	authUrl: "https://bizrouter.ai/settings/keys",
	instructions: "Create or copy your BizRouter API key",
	promptMessage: "Paste your BizRouter API key",
	placeholder: "sk-br-v1-...",
	validation: {
		kind: "models-endpoint",
		provider: "BizRouter",
		modelsUrl: "https://api.bizrouter.ai/v1/models",
	},
});
