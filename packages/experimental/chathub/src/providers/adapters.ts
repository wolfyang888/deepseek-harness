/** Browser provider adapters that ship with ChatHub. */

import type { IModelProvider } from '../types.ts'
import { ChatGptWebProvider } from './chatgpt-web.ts'
import { DeepSeekWebProvider } from './deepseek-web.ts'
import { DoubaoWebProvider } from './doubao-web.ts'
import { GeminiWebProvider } from './gemini-web.ts'
import type { WebChatTransport, WebProviderOverrides } from './web-provider.ts'

/** Construction inputs for one shipped browser adapter. */
export interface WebProviderAdapterOptions extends WebProviderOverrides {
  /** Host-supplied opener for signed-in browser sessions. */
  transport: WebChatTransport
}

/** Provider-id keyed constructors for the shipped browser adapters. */
export const webProviderAdapters = {
  'deepseek-web': (options: WebProviderAdapterOptions): IModelProvider =>
    new DeepSeekWebProvider(options.transport, options),
  'chatgpt-web': (options: WebProviderAdapterOptions): IModelProvider =>
    new ChatGptWebProvider(options.transport, options),
  'gemini-web': (options: WebProviderAdapterOptions): IModelProvider =>
    new GeminiWebProvider(options.transport, options),
  'doubao-web': (options: WebProviderAdapterOptions): IModelProvider =>
    new DoubaoWebProvider(options.transport, options),
} satisfies Record<string, (options: WebProviderAdapterOptions) => IModelProvider>
