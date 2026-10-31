/** ChatHub runtime core: provider-agnostic sessions, semantic handoff, and task routing. */

export type * from './types.ts'
export { ChatHubError, errorMessage } from './errors.ts'
export { createCheckpointId, createMemoryEntryId, createSessionId, formatDateStamp } from './ids.ts'
export { ProviderRegistry, probeProvider } from './provider-registry.ts'
export {
  SessionMemoryService,
  clonePlan,
  memoryHighlights,
  sessionFacts,
} from './session-memory.ts'
export type { PlanStepUpdate, RecordMemoryInput } from './session-memory.ts'
export { ContextCompiler } from './context-compiler.ts'
export type { ContextCompilerOptions, ContextDetail } from './context-compiler.ts'
export { CheckpointService } from './checkpoint.ts'
export { ModelRouter } from './model-router.ts'
export type {
  CompletionRequest,
  CompletionResult,
  ModelRouterOptions,
  ProviderAttempt,
  RouteRequest,
  RouteResult,
  TaskType,
} from './model-router.ts'
export { SessionManager } from './session-manager.ts'
export type {
  BuildRequestInput,
  CreateSessionInput,
  ModelSwitchOutcome,
  SessionManagerOptions,
} from './session-manager.ts'
