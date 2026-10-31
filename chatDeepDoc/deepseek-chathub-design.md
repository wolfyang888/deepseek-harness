# DeepSeek ChatHub Design

## 1. Objective

Build a free, extensible, high-capability AI agent platform based on DeepSeek Harness, borrowing the multi-model UX strengths of ChatHub while keeping the agent runtime anchored in DeepSeek Harness's plugin-driven architecture.

The target product is not just a multi-model chat UI. It is a planning-oriented, work-capable AI agent that can:

- access free web-based LLM portals such as DeepSeek Chat, Doubao Chat, ChatGPT, Gemini, and similar providers
- switch between models during the same session without losing the reasoning thread
- maintain long-lived planning, memory, and task context
- operate well on large, complex repository or project tasks
- keep the codebase extensible and easy to evolve

## 2. Design principles

### 2.1 Agent-first, not chat-only

The system will not be implemented as "just a chat wrapper". It will use DeepSeek Harness as the runtime foundation for:

- agent loop
- tool calling
- session orchestration
- plugin/service extension
- long-running task management
- memory + planning state

### 2.2 Multi-provider model access without API tokens

The project will support free web-based model access by connecting to providers through browser-authenticated sessions rather than paid API tokens. This is the key difference from a standard SaaS LLM client.

### 2.3 Reasoning continuity across model switches

When the user changes from model A to model B, the system must preserve:

- task state
- objective summary
- plan tree
- working memory
- unresolved questions
- model-specific intermediate reasoning traces converted into a canonical semantic form

This is more important than raw message history.

### 2.4 Extensible architecture

The product must be organized around registries and service interfaces so it can add or replace:

- model providers
- memory backends
- browser automation adapters
- toolsets
- UI capabilities
- planning strategies

## 3. Requirements mapping

| Requirement | Design approach |
|---|---|
| Access AI models from websites | Provider adapters for browser-based web sessions |
| Switch models without losing context | Canonical session state + semantic memory + model switch checkpoint |
| Free to use | Browser-account access, no paid API keys |
| Good reasoning/planning | DeepSeek Harness agent loop + tool use + planning modules |
| Handle complex large projects | Structured task memory, worktree awareness, plan tracking |
| Low code churn / extensibility | Plugin-driven provider registry and capability interfaces |

## 4. Why DeepSeek Harness as the base

DeepSeek Harness is a strong base for this product because it already provides the kind of runtime foundation needed for an advanced AI agent:

- plugin-based system architecture
- session-oriented execution
- tool and capability composition
- agent loop structure
- extensibility for new providers and services
- fit for building complex work assistants instead of thin wrappers

This matches the requirement for long-term planning and multi-step reasoning much better than a pure ChatHub-like front-end.

## 5. Why reference ChatHub

ChatHub demonstrates several important product concepts that are valuable here:

- unified chat experience across multiple providers
- model switching in a single conversation
- lightweight user experience around multiple AI backends
- multi-provider compatibility in one interface

The design borrows these ideas, but uses them as a session/UX layer, not as the core runtime. The agent runtime remains DeepSeek Harness.

## 6. High-level architecture

```text
+---------------------------------------------------------------+
|                         User Interface                          |
| - model selector                                               |
| - chat/session display                                         |
| - task plan view                                               |
| - memory view                                                  |
| - provider connection controls                                  |
+---------------------------+-----------------------------------+
                            |
                            v
+---------------------------------------------------------------+
|                     DeepSeek Harness Runtime                    |
| - Session Manager                                              |
| - Agent Loop                                                   |
| - Planner / Replanner                                          |
| - Memory System                                                |
| - Tool Registry                                                |
| - Context Compiler                                             |
| - Model Router                                                 |
+---------------------------+-----------------------------------+
                            |
        +-------------------+-------------------+
        |                                       |
        v                                       v
+--------------------------+       +-------------------------------+
| Web Model Providers      |       | Tool/Capability Providers     |
| - DeepSeek Web          |       | - file system                 |
| - Doubao Web           |       | - shell                       |
| - ChatGPT Web          |       | - browser/search              |
| - Gemini Web           |       | - repo analysis               |
| - Claude Web (optional)|       | - memory backends             |
| - Other web portals    |       | - planning helpers            |
+--------------------------+       +-------------------------------+
```

## 7. Core modules

### 7.1 Session Manager

The session manager owns the lifecycle of the user conversation and keeps a canonical internal state independent of provider.

It stores:

- user messages
- assistant messages
- active goal
- plan states
- milestones
- unresolved questions
- memory references
- model-switch history
- provider-specific metadata

### 7.2 Model Router

The model router decides which provider backend to use for each turn.

It can:

- keep current provider for normal completion
- switch provider for a new subgoal
- use a specialized provider for coding tasks
- prefer a reasoning-oriented model for planning
- route research tasks to a model with stronger web knowledge

### 7.3 Canonical Context Layer

This is the most important conceptual difference from a naive ChatHub-style app.

Instead of storing raw provider-specific messages only, the system stores a canonical context model:

- task summary
- current objective
- reasoning state
- plan status
- work products
- facts extracted
- open questions
- actions already taken

When switching provider, this canonical context is converted into a provider-appropriate prompt. This prevents context loss.

### 7.4 Memory System

The memory system should support at least three layers:

1. Short-term working memory
   - immediate conversation
   - current step
   - tool results

2. Long-term session memory
   - lessons learned
   - project state
   - decisions made
   - unresolved work

3. Cross-session memory
   - user preferences
   - project-specific patterns
   - reusable strategies

This makes the agent more stable for large tasks and multi-session work.

### 7.5 Planning and Replanning Engine

This is required for large project tasks.

The agent should decompose work into steps like:

- problem understanding
- task decomposition
- plan creation
- subgoal execution
- verification
- refinement

The planning layer can monitor:

- whether the objective is still valid
- whether the current plan is stale
- whether a provider is failing or underperforming
- whether a new fact invalidates previous assumptions

### 7.6 Tooling and Capability Layer

The agent should have a strong tool mechanism from DeepSeek Harness, including:

- file reading and editing
- repo search and repo understanding
- shell execution
- git operations
- browser automation
- web fetching
- diagnostics
- diff review
- document generation

This enables the agent to do actual projects instead of only respond in text.

## 8. Free web-model integration strategy

### 8.1 Design goal

Use free web-based model access without paying for API tokens.

### 8.2 Provider adapter model

Each provider implements a common interface:

```ts
interface WebModelProvider {
  id: string
  name: string
  kind: 'web'
  capabilities: {
    reasoning: boolean
    coding: boolean
    vision: boolean
    webAccess: boolean
  }
  login(): Promise<boolean>
  isReady(): Promise<boolean>
  sendMessage(params: SendMessageParams): Promise<MessageResponse>
  streamMessage(params: SendMessageParams): AsyncIterable<StreamChunk>
  switchSession?(sessionKey: string): Promise<void>
  close(): Promise<void>
}
```

### 8.3 Supported providers

Initial providers:

- DeepSeek Chat
- Doubao Chat
- ChatGPT Web
- Gemini Web
- optional: Claude Web, Grok Web, other browser-backed models

### 8.4 Connection approach

The implementation should avoid hard-coded browser-specific hacks where possible. The preferred pattern is:

- provider plugin with browser automation entrypoint
- login/session management via browser profile or ephemeral browser context
- provider-specific selectors and transport adapters
- rate-limit and session health handling

This gives the project a clean pluggable design.

### 8.5 Security and account safety

Because the product relies on browser-authenticated accounts, the system must:

- isolate provider sessions
- keep cookies and tokens inside browser-managed or local secure storage
- not centralize all credentials into a single server secret
- allow the user to revoke access per provider

## 9. Model switching without losing context

This is the most critical feature.

### 9.1 Problem statement

If you simply pass the raw prior chat transcript to a new model, the new model may:

- discard assumptions
- misinterpret earlier reasoning
- drift from the original objective
- fail to preserve the plan structure

### 9.2 Proposed solution: canonical state checkpointing

When the user switches models, the system creates a checkpoint that contains:

```json
{
  "sessionId": "abc123",
  "checkpointId": "cp-2026-10-31-01",
  "objective": "Refactor the repository and fix failing tests",
  "plan": [
    "inspect failing areas",
    "fix root cause",
    "verify with tests"
  ],
  "facts": [
    "project uses pnpm",
    "error originates in file X",
    "current hypothesis is Y"
  ],
  "openQuestions": [
    "whether backend or frontend is responsible"
  ],
  "modelHistory": [
    { "provider": "deepseek-web", "summary": "root cause identified" },
    { "provider": "chatgpt-web", "summary": "reframed plan" }
  ],
  "memoryHighlights": [
    "user prefers minimal patching",
    "project uses TypeScript"
  ]
}
```

The new model receives a summarized but semantically rich context rather than a raw log dump. This is much more stable.

### 9.3 Provider adaptation layer

The provider adapter converts canonical state into a model-appropriate prompt using a strategy per provider:

- for DeepSeek: concise but high-information reasoning context
- for Gemini: structured facts and decision context
- for ChatGPT: well-organized task and constraints
- for Doubao: condensed plan and action summary

This keeps the context intact while adapting to each provider's style.

## 10. Long-term planning and large-project support

### 10.1 Goal

The agent should maintain the ability to reason over big tasks, not just answer one prompt.

### 10.2 Strategy

Use a layered plan system:

- objective layer
- subtask layer
- execution layer
- verification layer
- review/reflection layer

The planner can create tasks like:

- inspect repo structure
- identify likely failure points
- propose fix
- implement fix
- run verification
- summarize change

### 10.3 Reflection loop

The agent should periodically ask:

- are we still solving the original problem?
- what new evidence changed the plan?
- has the task expanded or drifted?
- what assumptions are now unverified?

This matters for long-running, complex work.

## 11. Data model design

### 11.1 Core objects

```ts
interface Session {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  activeGoal: string
  currentModel: string
  modelHistory: ModelSwitchRecord[]
  memory: MemoryEntry[]
  plan: PlanStep[]
  messages: Message[]
}

interface Message {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  provider: string
  content: string
  timestamp: number
  metadata?: Record<string, any>
}

interface PlanStep {
  id: string
  title: string
  status: 'pending' | 'running' | 'done' | 'blocked'
  parentId?: string
  summary: string
  evidence: string[]
}

interface MemoryEntry {
  id: string
  type: 'fact' | 'preference' | 'plan' | 'lesson'
  content: string
  source: string
  importance: number
  createdAt: number
}
```

### 11.2 Model switch record

```ts
interface ModelSwitchRecord {
  from: string
  to: string
  timestamp: number
  checkpointId: string
  reason: string
}
```

## 12. Extensibility design

### 12.1 Registry pattern

The system should use registries for:

- providers
- tools
- memory stores
- session backends
- UI extensions
- evaluation plugins

This allows extension without changing the core agent loop.

### 12.2 Example extension points

- add a new browser-backed model provider
- add a GitHub repository intelligence tool
- add custom memory storage backend
- add new planner strategy
- add project-domain plugin

## 13. Proposed repo structure

```text
packages/
  core/
    session/
    agent/
    memory/
    planner/
  llm/
    provider/
    web/
    router/
  tools/
    repo/
    shell/
    browser/
    web-fetch/
  providers/
    deepseek-web/
    chatgpt-web/
    gemini-web/
    doubao-web/
  ui/
    web/
    chat/
    panels/
  plugins/
    project-analysis/
    task-memory/
    workflow/
```

This matches the DeepSeek Harness philosophy: separate runtime, services, and providers.

## 14. MVP roadmap

### Phase 1: foundation

- adopt DeepSeek Harness session + agent loop
- create provider abstraction for browser-backed LLMs
- implement DeepSeek Web provider adapter
- build model switch checkpointing
- add basic session memory

### Phase 2: multi-provider UX

- support Doubao, ChatGPT, Gemini web providers
- add model selector and session switching UI
- add canonical context assembly
- build provider-specific prompt adaptation layer

### Phase 3: planning and tools

- task planner and replanner
- repo tools for search and inspection
- shell and file tool integration
- memory ranking and summarization

### Phase 4: production polish

- session persistence
- long-context compaction
- model health checks
- user controls for provider login state
- fallback and retry logic

## 15. Risks and mitigations

### 15.1 Free web model instability

Risk: website providers may rate-limit, change UI, or change login flows.

Mitigation:

- isolate provider logic in adapters
- keep browser automation wrappers small and replaceable
- add health checks and provider-specific fallback strategies

### 15.2 Context drift on model switch

Risk: new model loses the thread.

Mitigation:

- maintain canonical session state
- checkpoint before switching
- compute condensed semantic summary
- convert summary into provider-specific prompt format

### 15.3 Long-running task fragility

Risk: long tasks drift or exceed model context.

Mitigation:

- plan decomposition
- memory compaction
- milestone checkpoints
- state serialization after important events

### 15.4 Security concerns from browser sessions

Risk: session tokens and cookies can be exposed.

Mitigation:

- browser-local storage only where possible
- user-controlled provider sessions
- explicit login state visibility
- no vendor-managed central key vault

## 16. Final recommendation

The best approach is not to build a simple Chathub clone on top of DeepSeek Harness, nor to use DeepSeek Harness as a bare runtime without a multi-model UX layer. Instead:

- DeepSeek Harness becomes the core agent runtime
- ChatHub-inspired UX becomes the model-router layer
- browser-backed free LLM providers become pluggable adapters
- canonical memory + planning state becomes the continuity layer

This design is consistent with the target goal:

- deep reasoning
- large project support
- long-term planning
- extensibility
- free multi-model usage without paid API tokens

## 17. MVP target outcome

The first working version should support:

- a single session where the user can switch among DeepSeek, ChatGPT, Gemini, and Doubao web providers
- preserved task state across switches
- a planner that breaks complex work into actionable steps
- repo-aware tools for code and project analysis
- no paid API token required for basic usage

This version gives the product both the conversational flexibility of ChatHub and the planning power of a DeepSeek Harness-style agent.

## 18. Summary

This project is best understood as a hybrid architecture:

- DeepSeek Harness provides the agent brain and extensibility
- ChatHub provides the multi-provider UX and model-switch experience
- browser-based free model providers provide access without API cost
- canonical memory and planning state provide continuity across model changes

This is the right design for a powerful free AI assistant capable of thinking deeply and handling complex work.

## 19. Implementation note

If this design is adopted, the first implementation should keep the architecture deliberately simple:

1. start with one browser-backed provider
2. add the canonical session state layer
3. add model switching checkpointing
4. add the planner
5. add more providers after the runtime is stable

This keeps the initial change set manageable while still preserving the long-term design goals.

---

This document is intended as a working design blueprint for a DeepSeek Harness + ChatHub-inspired free multi-model agent product.














































































































































































































