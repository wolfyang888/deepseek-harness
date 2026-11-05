/** ChatHub runtime core: provider-agnostic sessions, semantic handoff, and task routing. */

export type * from './types.ts'
export { ChatHubError, errorMessage } from './errors.ts'
export {
  createCheckpointId,
  createMemoryEntryId,
  createSessionId,
  createTimelineEntryId,
  formatDateStamp,
} from './ids.ts'
export { ProviderRegistry, probeProvider } from './provider-registry.ts'
export { SessionTimelineService } from './timeline.ts'
export type { TimelineEntryInput, TimelineListOptions } from './timeline.ts'
export {
  SessionMemoryService,
  clonePlan,
  memoryHighlights,
  sessionFacts,
} from './session-memory.ts'
export type {
  MemoryCompactionOptions,
  MemoryCompactionResult,
  PlanStepUpdate,
  RecordMemoryInput,
  SessionMemoryOptions,
} from './session-memory.ts'
export { ContextCompiler } from './context-compiler.ts'
export type { ContextCompilerOptions, ContextDetail } from './context-compiler.ts'
export { CheckpointService, restoreFromCheckpoint, CHECKPOINT_SCHEMA_VERSION } from './checkpoint.ts'
export { ModelRouter } from './model-router.ts'
export type {
  CompletionRequest,
  CompletionResult,
  ModelRouterOptions,
  ProviderAttempt,
  RetryableErrorCode,
  RetryPolicy,
  RouteRequest,
  RouteResult,
  TaskType,
} from './model-router.ts'
export {
  WEB_PROVIDER_CAPABILITIES,
  WebModelProvider,
  mergeWebProviderConfig,
  renderWebPrompt,
  splitRequestMessages,
} from './providers/web-provider.ts'
export type {
  WebChatPayload,
  WebChatRawResponse,
  WebChatTransport,
  WebChatTransportClosed,
  WebChatTransportSession,
  WebPromptStyle,
  WebProviderConfig,
  WebProviderOverrides,
} from './providers/web-provider.ts'
export { DeepSeekWebProvider } from './providers/deepseek-web.ts'
export { ChatGptWebProvider } from './providers/chatgpt-web.ts'
export { GeminiWebProvider } from './providers/gemini-web.ts'
export { DoubaoWebProvider } from './providers/doubao-web.ts'
export { QianwenWebProvider } from './providers/qianwen-web.ts'
export { GlmWebProvider } from './providers/glm-web.ts'
export { webProviderAdapters } from './providers/adapters.ts'
export type { WebProviderAdapterOptions } from './providers/adapters.ts'
export { answerMarkdownOf } from './providers/answer-markdown.ts'
export { SessionManager } from './session-manager.ts'
export type {
  BuildRequestInput,
  CreateSessionInput,
  ModelSwitchOutcome,
  SessionManagerOptions,
} from './session-manager.ts'
