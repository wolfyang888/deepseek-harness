/** DeepSeek Chat browser adapter. */

import type { ModelCapabilities } from '../types.ts'
import { WebModelProvider } from './web-provider.ts'

/** Drives DeepSeek Chat through a signed-in browser page. */
export class DeepSeekWebProvider extends WebModelProvider {
  readonly id = 'deepseek-web'
  readonly name = 'DeepSeek Chat'
  readonly capabilities: ModelCapabilities = {
    reasoning: true,
    coding: true,
    vision: false,
    webAccess: true,
    streaming: true,
  }
  protected readonly promptStyle = { heading: 'Task context' }
}
