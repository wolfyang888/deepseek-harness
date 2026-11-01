/** Doubao browser adapter. */

import {
  WEB_PROVIDER_CAPABILITIES,
  WebModelProvider,
  mergeWebProviderConfig,
  type WebChatTransport,
  type WebProviderConfig,
  type WebProviderOverrides,
} from './web-provider.ts'

/** Site identity, prompt style, and failure patterns Doubao ships with. */
const DOUBAO_WEB: WebProviderConfig = {
  id: 'doubao-web',
  name: 'Doubao',
  capabilities: WEB_PROVIDER_CAPABILITIES,
  promptStyle: { heading: 'Task context' },
  failureRules: [
    { code: 'auth-required', pattern: /登录|未登录|账号异常|from_logout|logout|session expired/ },
    { code: 'provider-unavailable', pattern: /服务繁忙|系统繁忙/ },
  ],
}

/** Drives Doubao through a signed-in browser page. */
export class DoubaoWebProvider extends WebModelProvider {
  /**
   * @param transport - Opener for Doubao browser sessions.
   * @param overrides - Host changes to capabilities, prompt style, or failure rules.
   */
  constructor(transport: WebChatTransport, overrides: WebProviderOverrides = {}) {
    super(transport, mergeWebProviderConfig(DOUBAO_WEB, overrides))
  }
}
