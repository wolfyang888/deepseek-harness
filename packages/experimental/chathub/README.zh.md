---
description: "与提供方无关的多模型会话：在切换模型时把任务目标、计划、事实与历史交给下一个提供方。"
kind: "package-library"
---

# @deepseek-ai/dsh-experimental-chathub

[English](README.md) | 中文

## 概述

`dsh-experimental-chathub` 让同一个任务在用户更换模型时保持连贯：它记录任务目标、计划、事实、未解问题与决定，并为下一轮接手的提供方渲染交接内容。把提供方注册到同一个适配接口之后，路由器可以按任务挑选有能力处理的模型、在调用失败时降级，并在每次切换前写入检查点。这是一个库：没有 profile 挂载它，没有 `cordis.yml` 行引用它。它随包提供 DeepSeek Chat 与 ChatGPT 的浏览器适配器，并驱动由宿主提供的已登录浏览器传输。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

### 何时选用

当同一段对话需要在不同提供方之间继续而不丢失任务时选用，例如先用推理模型完成编码,再换到长上下文模型复核。宿主负责浏览器自动化与界面：随包提供的适配器驱动宿主实现的 `WebChatTransport`，其他提供方经同一个 `IModelProvider` 接缝接入。若每个会话只需一个已配置模型，应改用 `dsh-llm` 接缝；本包增加的是跨提供方交接，而不是提供方传输。

### 入口

```ts
import {
  CheckpointService,
  ChatHubError,
  ContextCompiler,
  DeepSeekWebProvider,
  ModelRouter,
  ProviderRegistry,
  SessionManager,
} from '@deepseek-ai/dsh-experimental-chathub'
import type { WebChatTransport } from '@deepseek-ai/dsh-experimental-chathub'
```

宿主按自己的登录与页面隔离方式实现浏览器传输，再注册随包提供的适配器：

```ts
import { DeepSeekWebProvider, ProviderRegistry } from '@deepseek-ai/dsh-experimental-chathub'
import type { WebChatTransport, WebChatTransportSession } from '@deepseek-ai/dsh-experimental-chathub'

declare function yourSignedInPage(providerId: string, sessionKey?: string): Promise<WebChatTransportSession | undefined>

const transport: WebChatTransport = {
  open: (providerId, sessionKey) => yourSignedInPage(providerId, sessionKey),
}
const provider = new DeepSeekWebProvider(transport)
const registry = new ProviderRegistry()
await provider.init()
registry.register(provider)
```

`init` 通过站点登录状态报告就绪：用户仍需登录时 `open` 返回 `undefined`。`webProviderAdapters` 把 `deepseek-web` 与 `chatgpt-web` 映射到构造函数，供按配置构建提供方的宿主使用。

常见路径先注册提供方、创建会话，再把下一轮交给路由器：

```ts
import {
  CheckpointService,
  ContextCompiler,
  ProviderRegistry,
  SessionManager,
} from '@deepseek-ai/dsh-experimental-chathub'
import type { ChatMessage, IModelProvider } from '@deepseek-ai/dsh-experimental-chathub'

declare const deepseekProvider: IModelProvider
declare const geminiProvider: IModelProvider
declare const userMessage: ChatMessage

const registry = new ProviderRegistry()
registry.register(deepseekProvider)
registry.register(geminiProvider)
const manager = new SessionManager({
  registry,
  compiler: new ContextCompiler(),
  checkpoints: new CheckpointService(),
})
const session = manager.create({ title: 'Fix the build', goal: 'fix the build error', provider: 'deepseek-web' })
const request = manager.buildRequest(session, { messages: [userMessage] })
const outcome = await manager.switchProvider(session, 'gemini-web', 'need long-context review')
```

`switchProvider` 先为原提供方写入检查点，再为新提供方编译语义上下文、记录本次切换，并返回渲染好的提示词供调用方发送。`ModelRouter.route` 为 `coding`、`research`、`quick-answer` 三类回合挑选提供方；`ModelRouter.complete` 发送该回合，并在某次提供方调用失败时沿候选顺序降级。`SessionMemoryService` 在会话上记录事实、偏好、计划、决定与未解问题，供上述服务读取。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

会话记录是唯一权威状态：目标、计划、记忆条目、语义上下文、检查点与提供方历史。`ContextCompiler` 从中派生出与提供方无关的上下文，并渲染 `full`、`compact` 或 `detailed` 三档提示词，按提供方选择。`CheckpointService` 在切换前快照同一状态，因此历史不依赖任何提供方自己的对话记忆。`ModelRouter` 的候选顺序为：已配置路由、本轮偏好、能力标记、已配置降级项，最后是注册表中的其余提供方；它就绪检查失败或查找结果为 `undefined` 的候选会被跳过。`WebModelProvider` 是浏览器适配器基类：它合并系统文本、渲染提供方风格的提示词、把传输失败包装为 `provider-call-failed`，并在会话支持时流式输出增量；随包适配器仅在身份、能力与提示词标题上不同。

| 文件 | 作用 |
|---|---|
| [`src/types.ts`](src/types.ts) | 提供方、请求、上下文、检查点、记忆与运行时状态的类型声明 |
| [`src/provider-registry.ts`](src/provider-registry.ts) | 提供方注册、查找与就绪探测 |
| [`src/session-memory.ts`](src/session-memory.ts) | 记忆写入、计划更新与共享的事实/要点派生函数 |
| [`src/context-compiler.ts`](src/context-compiler.ts) | 与提供方无关的上下文派生，以及 full、compact、detailed 三档渲染器 |
| [`src/checkpoint.ts`](src/checkpoint.ts) | 切换前的检查点快照 |
| [`src/model-router.ts`](src/model-router.ts) | 任务路由与降级执行 |
| [`src/providers/web-provider.ts`](src/providers/web-provider.ts) | 浏览器传输接缝、请求归一化、提示词渲染与适配器基类 |
| [`src/providers/deepseek-web.ts`](src/providers/deepseek-web.ts) | DeepSeek Chat 适配器 |
| [`src/providers/chatgpt-web.ts`](src/providers/chatgpt-web.ts) | ChatGPT 适配器 |
| [`src/providers/adapters.ts`](src/providers/adapters.ts) | 按提供方 id 索引的随包适配器构造函数 |
| [`src/session-manager.ts`](src/session-manager.ts) | 会话创建、请求构建、模型切换与运行时状态 |
| [`src/ids.ts`](src/ids.ts) | 带日期的会话、检查点与记忆 id |
| [`src/errors.ts`](src/errors.ts) | 带类型的 `ChatHubError` 错误码 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [实验性包](../README.zh.md) — 实验性状态与发布规则。
- [LLM 适配器](../../llm/llm/README.zh.md) — 本库刻意不替代的进程内模型传输。
- [会话格式状态](../../../docs/session-format-status.zh.md) — 若要持久化这些记录，必须遵循的持久会话兼容策略。

-----

<a id="model-experience"></a>
## 模型体验

间接影响，通过发送渲染后提示词的宿主浏览器传输实现。

#### KV Cache 影响

适配器除渲染出的提示词外不添加内容；当编译出的交接内容在回合之间发生变化时（例如计划被修改、新增事实或追加模型切换），消费方缓存的请求前缀会失效。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

- 不随包提供浏览器传输：宿主用自己的自动化与登录处理实现 `WebChatTransport`，cookie 或令牌不会进入提供方代码、会话状态或日志。
- 浏览器适配器只承载文本：`tool` 消息会以 `unsupported-request` 被拒绝，声明的能力描述的是本适配器发送的载荷，而不是站点的全部能力。
- 会话、记忆与检查点只存在于内存中，不会跨进程重启持久化或重新加载。
- 路由按任务类型使用静态能力标记，不从调用结果中学习。
- 不提供界面；会话展示与提供方选择由宿主消费方负责。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者上下文 — 点击展开</summary>

无。

</details>
