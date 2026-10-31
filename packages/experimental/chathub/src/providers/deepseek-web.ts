/** DeepSeek Chat browser adapter. */

import {
  WEB_PROVIDER_CAPABILITIES,
  WebModelProvider,
  mergeWebProviderConfig,
  type WebChatTransport,
  type WebProviderConfig,
  type WebProviderOverrides,
} from './web-provider.ts'

/** Site identity, prompt style, and failure patterns DeepSeek Chat ships with. */
const DEEPSEEK_WEB: WebProviderConfig = {
  id: 'deepseek-web',
  name: 'DeepSeek Chat',
  capabilities: WEB_PROVIDER_CAPABILITIES,
  promptStyle: { heading: 'Task context' },
  failureRules: [
    { code: 'provider-unavailable', pattern: /服务器繁忙|服务繁忙|系统繁忙/ },
    { code: 'auth-required', pattern: /登录|未登录|登录已过期/ },
  ],
}

/** Drives DeepSeek Chat through a signed-in browser page. */
export class DeepSeekWebProvider extends WebModelProvider {
  /**
   * @param transport - Opener for DeepSeek Chat browser sessions.
   * @param overrides - Host changes to capabilities, prompt style, or failure rules.
   */
  constructor(transport: WebChatTransport, overrides: WebProviderOverrides = {}) {
    super(transport, mergeWebProviderConfig(DEEPSEEK_WEB, overrides))
  }
}
