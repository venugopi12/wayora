import { assistantProvider, type Env } from '../../config/env.js';
import { AnthropicProvider } from './anthropic.js';
import { DemoAssistantProvider } from './demo.js';
import type { AssistantProvider } from './provider.js';

/**
 * The provider chosen by AI_PROVIDER (docs/assistant.md#configuration), or
 * null when the assistant is off. config/env.ts already refused a live
 * provider without AI_API_KEY and AI_MODEL.
 */
export function createAssistantProvider(
  env: Env,
  options: { fetch?: typeof fetch } = {},
): AssistantProvider | null {
  switch (assistantProvider(env)) {
    case 'none':
      return null;
    case 'demo':
      return new DemoAssistantProvider();
    case 'anthropic':
      if (!env.AI_API_KEY || !env.AI_MODEL) return null;
      return new AnthropicProvider({
        apiKey: env.AI_API_KEY,
        model: env.AI_MODEL,
        ...(env.AI_BASE_URL ? { baseUrl: env.AI_BASE_URL } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
  }
}

export { AssistantService } from './assistant.service.js';
export { assistantRouter } from './assistant.routes.js';
export type { AssistantProvider } from './provider.js';
