/** Browser entry of the ChatHub panel: the sidebar entry and the main panel it opens. */
import type { Context } from '@deepseek-ai/cordis'
import chatHubRemote from '@deepseek-ai/dsh-experimental-chathub-host/remote'
import { mountChatHubPanel } from './mount.ts'

export { inject, PANEL_ID } from './mount.ts'
export type { ChatHubPanelFace, ChatHubTranslate } from './mount.ts'
export type { ChatHubPanelProps } from './ChatHubPanel.tsx'
export type { ChatHubActions, ChatHubState } from './panel-store.ts'
export type { ChatHubLocaleKey } from './locales.ts'

/**
 * Mount the ChatHub panel Remote and its UI.
 * @param ctx - browser plugin context.
 * @returns the disposer that withdraws the UI, then the Remote.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return await mountChatHubPanel(ctx, chatHubRemote)
}
