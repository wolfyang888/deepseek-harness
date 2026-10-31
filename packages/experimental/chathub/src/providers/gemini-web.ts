/** Gemini browser adapter. */

import type { ModelCapabilities } from '../types.ts'
import { WebModelProvider } from './web-provider.ts'

/** Drives Gemini through a signed-in browser page. */
export class GeminiWebProvider extends WebModelProvider {
  readonly id = 'gemini-web'
  readonly name = 'Gemini'
  readonly capabilities: ModelCapabilities = {
    reasoning: true,
    coding: true,
    vision: false,
    webAccess: true,
    streaming: true,
  }
  protected readonly promptStyle = { heading: 'Task and constraints' }
}
