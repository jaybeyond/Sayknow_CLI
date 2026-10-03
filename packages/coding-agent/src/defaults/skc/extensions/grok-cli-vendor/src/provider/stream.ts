import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from '@sayknow-cli/ai';
import { streamOpenAIResponses } from '@sayknow-cli/ai/providers/openai-responses';

/**
 * Client version presented to cli-chat-proxy. The proxy rejects outdated
 * clients with HTTP 426 ("Your Grok CLI version (...) is outdated"), so this
 * must track the minimum accepted Grok CLI release. It is applied after any
 * caller/model headers so a stale configured value can never override it.
 */
export const GROK_CLI_VERSION = '1.0.13';

/**
 * Stream function that adds Grok CLI-specific headers to requests.
 *
 * SKC Grok Build extension sends cli-chat-proxy headers (see agent.models.grok-cli.yml):
 *   - x-grok-conv-id: <session/conversation ID>
 *   - x-grok-model-override: <model ID>
 *   - x-xai-token-auth: xai-grok-cli
 */
export function streamGrokCli(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const sessionId = options?.sessionId;
  const headers: Record<string, string> = {
    ...options?.headers,
    'x-grok-client-identifier': 'skc-grok-cli',
    'x-grok-client-version': GROK_CLI_VERSION,
    'x-xai-token-auth': 'xai-grok-cli',
    'x-grok-model-override': model.id,
  };

  if (sessionId) {
    headers['x-grok-conv-id'] = sessionId;
  }

  const responsesModel = {
    ...model,
    api: 'openai-responses',
  } as Model<'openai-responses'>;

  return streamOpenAIResponses(responsesModel, context, {
    ...options,
    headers,
    onResponse(response) {
      options?.onResponse?.(response, model);
    },
  });
}
