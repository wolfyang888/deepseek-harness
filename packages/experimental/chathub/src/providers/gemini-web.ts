/** Gemini browser adapter. */

import {
  WEB_PROVIDER_CAPABILITIES,
  WebModelProvider,
  mergeWebProviderConfig,
  type WebChatTransport,
  type WebProviderConfig,
  type WebProviderOverrides,
} from './web-provider.ts'

/** Site identity, prompt style, and failure patterns Gemini ships with. */
const GEMINI_WEB: WebProviderConfig = {
  id: 'gemini-web',
  name: 'Gemini',
  capabilities: WEB_PROVIDER_CAPABILITIES,
  promptStyle: { heading: 'Task context' },
  failureRules: [
    { code: 'rate-limited', pattern: /resource exhausted|quota exceeded|quota limit/ },
  ],
}

/** Drives Gemini through a signed-in browser page. */
export class GeminiWebProvider extends WebModelProvider {
  /**
   * @param transport - Opener for Gemini browser sessions.
   * @param overrides - Host changes to capabilities, prompt style, or failure rules.
   */
  constructor(transport: WebChatTransport, overrides: WebProviderOverrides = {}) {
    super(transport, mergeWebProviderConfig(GEMINI_WEB, overrides))
  }
}
