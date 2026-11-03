/** Qianwen browser adapter. */

import {
  WEB_PROVIDER_CAPABILITIES,
  WebModelProvider,
  mergeWebProviderConfig,
  type WebChatTransport,
  type WebProviderConfig,
  type WebProviderOverrides,
} from './web-provider.ts'

/** Site identity, prompt style, and failure patterns Qianwen ships with. */
const QIANWEN_WEB: WebProviderConfig = {
  id: 'qianwen-web',
  name: 'Qianwen',
  capabilities: WEB_PROVIDER_CAPABILITIES,
  promptStyle: { heading: 'Task context' },
  failureRules: [
    { code: 'auth-required', pattern: /登录|未登录|账号异常|请先登录|session expired/ },
    { code: 'provider-unavailable', pattern: /服务繁忙|系统繁忙|请求过于频繁/ },
  ],
}

/** Drives Qianwen through a signed-in browser page. */
export class QianwenWebProvider extends WebModelProvider {
  /**
   * @param transport - Opener for Qianwen browser sessions.
   * @param overrides - Host changes to capabilities, prompt style, or failure rules.
   */
  constructor(transport: WebChatTransport, overrides: WebProviderOverrides = {}) {
    super(transport, mergeWebProviderConfig(QIANWEN_WEB, overrides))
  }
}
