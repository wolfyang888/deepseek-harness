/** GLM (智谱清言, chatglm.cn) browser adapter. */

import {
  WEB_PROVIDER_CAPABILITIES,
  WebModelProvider,
  mergeWebProviderConfig,
  type WebChatTransport,
  type WebProviderConfig,
  type WebProviderOverrides,
} from './web-provider.ts'

/** Site identity, prompt style, and failure patterns GLM ships with. */
const GLM_WEB: WebProviderConfig = {
  id: 'glm-web',
  name: 'GLM',
  capabilities: WEB_PROVIDER_CAPABILITIES,
  promptStyle: { heading: 'Task context' },
  failureRules: [
    { code: 'auth-required', pattern: /登录|未登录|请先登录|账号异常|session expired/ },
    { code: 'provider-unavailable', pattern: /服务繁忙|系统繁忙|请求过于频繁|稍后再试/ },
  ],
}

/** Drives GLM through a signed-in browser page. */
export class GlmWebProvider extends WebModelProvider {
  /**
   * @param transport - Opener for GLM browser sessions.
   * @param overrides - Host changes to capabilities, prompt style, or failure rules.
   */
  constructor(transport: WebChatTransport, overrides: WebProviderOverrides = {}) {
    super(transport, mergeWebProviderConfig(GLM_WEB, overrides))
  }
}
