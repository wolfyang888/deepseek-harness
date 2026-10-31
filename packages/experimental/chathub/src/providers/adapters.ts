/** Browser provider adapters that ship with ChatHub. */

import type { IModelProvider } from '../types.ts'
import { ChatGptWebProvider } from './chatgpt-web.ts'
import { DeepSeekWebProvider } from './deepseek-web.ts'
import type { WebChatTransport } from './web-provider.ts'

/** Construction inputs for one shipped browser adapter. */
export interface WebProviderAdapterOptions {
  /** Host-supplied opener for signed-in browser sessions. */
  transport: WebChatTransport
}

/** Provider-id keyed constructors for the shipped browser adapters. */
export const webProviderAdapters = {
  'deepseek-web': (options: WebProviderAdapterOptions): IModelProvider => new DeepSeekWebProvider(options.transport),
  'chatgpt-web': (options: WebProviderAdapterOptions): IModelProvider => new ChatGptWebProvider(options.transport),
} satisfies Record<string, (options: WebProviderAdapterOptions) => IModelProvider>
