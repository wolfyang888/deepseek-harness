/** ChatGPT browser adapter. */

import {
  WEB_PROVIDER_CAPABILITIES,
  WebModelProvider,
  mergeWebProviderConfig,
  type WebChatTransport,
  type WebProviderConfig,
  type WebProviderOverrides,
} from './web-provider.ts'

/** Site identity, prompt style, and failure patterns ChatGPT ships with. */
const CHATGPT_WEB: WebProviderConfig = {
  id: 'chatgpt-web',
  name: 'ChatGPT',
  capabilities: WEB_PROVIDER_CAPABILITIES,
  promptStyle: { heading: 'Task context' },
  failureRules: [
    { code: 'auth-required', pattern: /verify (?:you are|you're) (?:a )?human|captcha|unusual activity/ },
    { code: 'rate-limited', pattern: /you've reached .*limit|usage limit/ },
  ],
}

/** Drives ChatGPT through a signed-in browser page. */
export class ChatGptWebProvider extends WebModelProvider {
  /**
   * @param transport - Opener for ChatGPT browser sessions.
   * @param overrides - Host changes to capabilities, prompt style, or failure rules.
   */
  constructor(transport: WebChatTransport, overrides: WebProviderOverrides = {}) {
    super(transport, mergeWebProviderConfig(CHATGPT_WEB, overrides))
  }
}
