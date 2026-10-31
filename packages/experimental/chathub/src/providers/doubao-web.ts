/** Doubao browser adapter. */

import type { ModelCapabilities } from '../types.ts'
import { WebModelProvider } from './web-provider.ts'

/** Drives Doubao through a signed-in browser page. */
export class DoubaoWebProvider extends WebModelProvider {
  readonly id = 'doubao-web'
  readonly name = 'Doubao'
  readonly capabilities: ModelCapabilities = {
    reasoning: true,
    coding: true,
    vision: false,
    webAccess: true,
    streaming: true,
  }
  protected readonly promptStyle = { heading: 'Task and constraints' }
}
