/** ChatGPT browser adapter. */

import type { ModelCapabilities } from '../types.ts'
import { WebModelProvider } from './web-provider.ts'

/** Drives ChatGPT through a signed-in browser page. */
export class ChatGptWebProvider extends WebModelProvider {
  readonly id = 'chatgpt-web'
  readonly name = 'ChatGPT'
  readonly capabilities: ModelCapabilities = {
    reasoning: true,
    coding: true,
    vision: false,
    webAccess: true,
    streaming: true,
  }
  protected readonly promptStyle = { heading: 'Role and constraints' }
}
