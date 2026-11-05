---
description: "把已登录的网页对话站点当作只收发文本的工具调用模型路由：每步渲染一段提示、每次回答最多一个工具调用、参数路径受策略约束。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-llm-chathub

[English](README.md) | 中文

## 概述

把一个已登录的网页对话站点变成 harness 智能体循环可以驱动的 LLM 路由。每一步都把系统提示、白名单工具 schema、最近若干轮和验证命令渲染成一段自包含提示，因为站点拒收 tool 消息，也不保留循环可用的历史。回答被解析成展示文本加最多一个已校验的工具调用。工具、权限、压缩与重试仍留在 harness，因此不支持 function calling 的站点也能多步改码。它必须与 ChatHub 宿主层一起挂载，浏览器与登录由宿主层负责；随包发布的 profile 不包含本层。

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

挂载后只注册一条 LLM 提供方路由：默认是 `<site>-chathub`，行内设置 `route` 可改名；显示名为 `ChatHub <site>`，只声明一个模型 id（默认 `web-model`）。站点自己选择背后的大模型，因此这个 id 只是路由标识，不是能力声明：网页回答不返回用量，`token-meter` 只能估算。

### 何时选择它

当任务必须由用户已经付费或已经登录的站点承担——DeepSeek Chat、ChatGPT、Gemini、通义千问或 GLM——而该站点不支持 function calling 时，选择本层。适配器沿用 harness 自己的循环，所以 `read`、`grep`、`glob`、`edit`、`write`、审批、压缩与会话日志的表现与 API 模型完全一致。需要 token 级流式、并行工具调用或图片输入时，改用 [`dsh-llm`](../../llm/llm/README.zh.md) 加一个已配置的 API 提供方。不要用它跑无人值守的 CI：每一步都需要一个已登录的浏览器。

### 组合进 profile

本包提供一个可选启用的层 [`cordis.patch.yml`](cordis.patch.yml)，由清单里的 `dsh.bundle` 块声明，且不在随包 profile 中。它依赖 ChatHub 宿主层——Chromium profile、登录态和按页面的轮次队列都由宿主层拥有——因此一次启动要同时应用两个补丁：

```sh
pnpm dsh web --patch packages/experimental/chathub-host/cordis.patch.yml --patch packages/experimental/llm-chathub/cordis.patch.yml
```

该层插入一行 `llm-chathub`，默认值来自环境变量：`DSH_CHATHUB_LLM_SITE`（默认 `deepseek-web`）、`DSH_CHATHUB_LLM_MODEL`、`DSH_CHATHUB_LLM_ROOT`（默认宿主进程工作目录）、`DSH_CHATHUB_LLM_TOOLS`（默认 `read,grep,glob,edit,write`）、`DSH_CHATHUB_LLM_VERIFY`（默认 `pnpm run typecheck`）。第一个智能体步骤才会打开页面；挂载本身不启动浏览器。

### 配置

```yaml
- name: '@deepseek-ai/dsh-experimental-llm-chathub'
  config:
    site: deepseek-web
    route: deepseek-web-chathub
    model: web-model
    contextWindow: 32000
    maxPromptChars: 48000
    maxToolResultChars: 6000
    maxSystemChars: 4000
    historyTurns: 8
    allowTools: [read, grep, glob, edit, write]
    denyPaths: ['.git', node_modules, '.env']
    verifyCommands: [pnpm run typecheck]
    workspaceRoot: /path/to/project
    maxToolCallsPerTurn: 1
    repairAttempts: 1
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `site` | `deepseek-web` | ChatHub 宿主层随包提供的站点提供方 id |
| `route` | `<site>-chathub` | 本行注册的 LLM 提供方路由 |
| `model` | `web-model` | 该路由声明的模型 id |
| `contextWindow` | `32000` | 声明的 token 容量，harness 压缩按它规划 |
| `maxPromptChars` | `48000` | 一段渲染提示的硬上限 |
| `maxToolResultChars` | `6000` | 提示内单个工具结果的上限 |
| `maxSystemChars` | `4000` | 带入提示的 harness 系统提示上限 |
| `historyTurns` | `8` | 逐字保留的最近对话条目数，更早的条目折叠 |
| `allowTools` | `read, grep, glob, edit, write` | 模型可调用的工具名，其他名字一律判为非法回答 |
| `denyPaths` | `.git, node_modules, .env` | 任何参数都不得指向的路径片段 |
| `verifyCommands` | `pnpm run typecheck` | 提示中声明的完成校验命令，适配器从不执行它们 |
| `workspaceRoot` | 宿主进程工作目录 | 绝对路径参数必须落在此根目录内 |
| `maxToolCallsPerTurn` | `1` | 每次回答接受的调用数，多余的块丢弃并告警 |
| `repairAttempts` | `1` | 被拒回答额外获得的轮数 |
| `auxiliary` | `refuse` | 除压缩以外的辅助调用（会话标题等）是否可以消耗一次站点轮次；压缩始终服务——它的检查点输出就是调用方的结果，拒绝它会让纯 web 挂载下的每次模型切换都失败 |

自动生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-llm-chathub)是全部可接受字段的完整来源。

### 一步的完整流程

| 步骤 | 发生什么 |
|---|---|
| 1 | 循环调用 `stream(options)`，带上系统提示、消息与它可用的工具 schema |
| 2 | `renderRequest` 把它们折成一段提示；条目按从旧到新丢弃，直到不超过 `maxPromptChars` |
| 3 | 适配器先读提供方健康状态，站点未登录时在打开浏览器之前就拒绝 |
| 4 | `transport.open(site, <site>:<n>)` 打开新页面，因此重试不会追加到上一次的会话 |
| 5 | 页面把提示作为一次文本插入并提交，然后轮询到回答不再变化 |
| 6 | `parseAnswer` 返回展示文本加它唯一接受的调用，或返回拒绝原因 |
| 7 | 被拒回答在新页面里获得一轮 `# CORRECTION`；第二次仍被拒则该步以失败结束 |
| 8 | 适配器先产出文本块，再产出工具调用块与 `finish: tool-calls`，由循环自己执行工具 |

### 失败码

| 站点 token | harness 失败码 | 循环反应 |
|---|---|---|
| `chathub-signed-out` | `AUTH` | 停止并提示用户登录，不重试 |
| `chathub-turn-timeout` | `TIMEOUT` | 换新页面重试一次 |
| `chathub-busy` | `RATE_LIMIT` | 退避后重试 |
| `chathub-ui-drift` | `SERVER` | 停止并报告站点 driver 需要更新 |
| `chathub-browser-unavailable`、`chathub-profile-locked` | `SERVER` | 停止 |
| `chathub-network` | `TRANSPORT` | 重试 |
| 自纠预算用尽仍非法 | `MALFORMED_RESPONSE` | 停止，原因里点出出错的块 |
| 无历史可丢仍超预算 | `CONTEXT_WINDOW_EXCEEDED` | 走压缩，不重试同一段文本 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`render.ts` 就是全部上下文契约：`# ROLE`、可选的 `# SYSTEM`、每个白名单 schema 一行紧凑 JSON 的 `# TOOLS`、`# PROTOCOL`、含根目录与校验命令的 `# PROJECT`、`# CONVERSATION`、以及 `# NOW`。渲染是纯函数，因此快照能钉住它的形状。历史从旧到新丢弃并折叠成 `[earlier: N entries omitted]`；当连无历史的提示都超过 `maxPromptChars` 时，`ChatHubPromptOverflowError` 带上 `CONTEXT_WINDOW_EXCEEDED`，让循环去压缩而不是拿同一段文本重试。图片与文件块会变成一行占位说明，不会被发送。

`protocol.ts` 读一段回答：先找 `<<<TOOL_CALL` … `TOOL_CALL>>>` 定界符，再从块体里切出第一个配平的 JSON 对象并容忍前后噪声，然后按本挂载的策略校验。工具名不在 `allowTools` 内、参数不是对象、块没有闭合、JSON 解析失败，或路径参数带 `..`、NUL 字节、被拒片段、或落在 `workspaceRoot` 之外的绝对位置，都属于拒绝——以原因返回，从不抛错。用 Markdown 围栏做载体是最直观的做法，这里刻意不用：站点会重排围栏、加复制按钮、有时保留行号，而未知名 token 会原样存活成普通文本。

`budget.ts` 夹紧单段文本时保留头尾并写明省略字数，因为文件头能说明它是谁、尾部通常正是被审阅的改动；预算小到放不下头、标记与尾时退化成直接截断。

`adapter.ts` 拥有「一步」：声明一个提供方与一个模型、渲染、在自纠预算内反复提问直到回答合法、每步上报一条观测记录，并产出 `block-start`、`text-delta`、`block-end`，随后是 `finish: stop` 或带 `finish: tool-calls` 的工具调用块。每次尝试分配新的页面键，在 `finally` 里关闭页面，并通过调用方的 `AbortSignal` 中止。`index.ts` 把行解析成配置、通过 `ctx.llm.registerAdapter` 注册路由，并按步发出 `chathub-llm/turn`——长度、工具名、拒绝原因、耗时、丢弃条目——从不包含提示或回答原文。

| 文件 | 作用 |
|---|---|
| [`src/types.ts`](src/types.ts) | 配置、传输契约、解析与渲染策略、失败码 |
| [`src/render.ts`](src/render.ts) | `GenerateOptions` 变成一段自包含提示 |
| [`src/protocol.ts`](src/protocol.ts) | 调用块定界符、JSON 提取、白名单与路径校验 |
| [`src/budget.ts`](src/budget.ts) | 保留头尾并写明省略字数的文本夹紧 |
| [`src/adapter.ts`](src/adapter.ts) | `LlmAdapter` 实现、传输轮次、chunk 序列、失败映射 |
| [`src/index.ts`](src/index.ts) | Cordis 插件、配置 schema、路由注册、轮次事件 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [ChatHub 浏览器传输](../chathub-host/README.zh.md) —— 本适配器借用的页面所有权、登录与轮次队列。
- [ChatHub 库](../chathub/README.zh.md) —— 宿主层实现的提供方运行时与传输契约。
- [LLM 适配器](../../llm/llm/README.zh.md) —— 本包实现的适配器接缝与 chunk 契约。
- [实验性包](../README.zh.md) —— 实验状态与可选启用式组合。

-----

<a id="model-experience"></a>
## 模型体验

### 渲染后的单步提示

#### 模型看到什么

每个请求都是适配器拼出的一段提示：固定的 `# ROLE` 文本、被夹到 `maxSystemChars` 的 harness 系统提示、白名单工具 schema（每行一个 JSON 对象，描述夹到 240 字符）、下面这段固定的 `# PROTOCOL`、含工作区根目录与配置校验命令的 `# PROJECT`、最近若干对话条目（工具结果夹到 `maxToolResultChars`）、以及携带最新 user 或 tool 消息的 `# NOW`。循环早先发出的调用呈现为 `[asked for <tool> <arguments>]`，其结果呈现为 `tool(<tool>) -> <result>`，因此模型读到的是普通对话记录，而不是提供方形制的消息列表。

##### 回答必须使用的协议块

```markdown
To act, reply with exactly one block and nothing else inside it:
<<<TOOL_CALL
{"name":"<tool>","arguments":{...}}
TOOL_CALL>>>
Put any explanation outside the block. Never invent tool output: you only see what the tools returned.
When the task is complete, or when you need the user to decide, reply without a block.
```

#### Token 影响

有条件且受上限约束。角色、协议与项目三段文本按挂载固定；工具 schema 每个白名单工具加一行；对话条目最多逐字保留 `historyTurns` 行，更早的条目全部折叠成一行省略说明。每个工具结果夹到 `maxToolResultChars` 并写明省略字数，展示文本每次回答夹到 2000 字符。整段提示必须不超过 `maxPromptChars`，否则请求以 `CONTEXT_WINDOW_EXCEEDED` 被拒，而不是被静默截断。

#### KV Cache 影响

每步独立。每次尝试都打开新的站点会话并发送完整提示，因此跨步骤不会复用任何前缀，本包也不依赖站点侧缓存。一步之内提示只渲染一次；自纠轮会把同一段提示加上 `# CORRECTION` 再发送一次，那是一次新的站点请求，而不是上一次请求的延伸。

### 自纠轮

#### 模型看到什么

只在回答被拒且 `repairAttempts` 仍有余额时出现：同一段渲染提示加上一段 `# CORRECTION`，点明拒绝原因——例如块未闭合、工具名未知、路径被策略禁止——并要求按文档格式重新回答。

#### Token 影响

该步的提示翻倍。预算不变，因此已经接近 `maxPromptChars` 的提示仍能放下，代价是多一次站点轮次。

#### KV Cache 影响

独立：自纠是新的站点会话，被拒尝试里的任何内容都不会被复用。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

- **只处理文本** —— 图片与文件内容块被替换成一行占位说明；适配器从不发送它们，因为网页输入框没有本包可控的附件通道。
- **每次回答一个调用** —— 协议只允许一个调用块，多余的块丢弃并告警，因此一步无法并行多个独立读取。
- **无用量统计** —— 网页回答不返回 token 数，`token-meter` 只能估算，`contextWindow` 是调用方必须保守填写的声明值。
- **轮次内不可取消** —— 传输层没有单轮取消；适配器在两次提问之间检查 `AbortSignal`，并在 finally 里关闭页面，因此进行中的站点轮次会跑到它自己的超时。
- **单一浏览器 profile** —— 智能体步骤与面板对话共用宿主 profile 与队列，面板繁忙会拖慢改码；需要并行时给适配器另一个 profile 目录。
- **词法级路径守卫** —— `..`、被拒片段、NUL 字节与落在 `workspaceRoot` 之外的绝对路径会在调用执行前被拒，但守卫不解析符号链接，相对路径由真正执行它的工具判定。
- **白名单必须与已装工具一致** —— `allowTools` 里写了但没有挂载的工具，其调用会在执行器里失败；循环已发货但白名单没写的工具，模型看不到。
- **站点改版即断链** —— 选择器或布局变化会以 `SERVER` 或 `TRANSPORT` 呈现，恢复方式只有更新 ChatHub 宿主层的 driver。
- **没有完成判定** —— 不带调用块的回答让该步以 `stop` 结束；任务是否真的完成由循环和用户判断，不由本适配器判断。
- **`verifyCommands` 只是提示文本** —— 适配器从不执行它；循环只运行当前会话审批允许的命令。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
