# ChatHub 模型选择器设计：把五个 Web 模型接进 Claude Code / Trae / WorkBuddy / Codex

## 1. 目标

让 `glm-web`、`doubao-web`、`gemini-web`、`chatgpt-web`、`qianwen-web` 出现在四个外部编码 agent（Claude Code、Codex、Trae、WorkBuddy）的原生模型选择器里，并被当作普通模型使用：

- 外部 agent 的工具调用、多轮对话、流式输出全部正常工作；
- 登录态、浏览器生命周期、轮次排队仍由 ChatHub 宿主统一管理；
- 不修改四个既有 chathub 插件的任何行为（本轨道规则 1/2：不动主业务流，靠加插件解决）。

非目标：

- 不为四个客户端各写一套 UI 或插件（Claude Code 插件、Trae 插件、VS Code 扩展等）；
- 不做真 token 级流式（见 §6.4，宿主层是「轮询到稳定」语义，首版只做诚实的中转）；
- 不做跨客户端的会话共享（每个客户端自己管理自己的历史，HTTP 本来就是无状态的）。

## 2. 现状：四个插件各提供什么

| 插件 | 职责 | 对本设计的贡献 |
|---|---|---|
| `chathub`（库层） | `IModelProvider`、`ProviderRegistry`、`ContextCompiler`、`CheckpointService`、`ModelRouter`、`SessionManager`、`WebChatTransport` 契约；`webProviderAdapters` 已注册五个站点 | 五个站点 provider 现成，`glm-web` 等 id 就是站点 id |
| `chathub-host`（宿主层） | 浏览器 runtime、每站点 context、登录流程（`loginTimeoutMs`）、轮次队列、`webChat` Remote、storage domain 持久化 | 登录态与页面所有权；gateway 完全不碰浏览器 |
| `llm-chathub`（适配层） | 把站点变成 `LlmAdapter` 路由：`renderRequest` 自包含提示词、`<<<TOOL_CALL` 块协议、`parseAnswer` 校验、修复轮、失败码映射、`resolveModel`（contextWindow + 接受并忽略 reasoning effort） | **核心复用点**：纯文本站点 → 带工具调用的模型这一最难的问题已经解决 |
| `client-ui-chathub`（界面层） | Web 面板：provider 健康/登录、会话、模型切换 | 登录入口；后续可加「接入编码 agent」的帮助卡片（§7） |

结论：缺的不是模型能力，而是一个**线协议出口**。四个客户端都会说 HTTP 方言，但没人说 Cordis。

## 3. 核心决策：双协议网关，而非四套集成

四个客户端的模型选择机制本质相同：指向一个 OpenAI 兼容（或 Anthropic 兼容）端点，模型 id 从端点发现或手工填入。因此：

> 新增第五个插件 `chathub-gateway`：一个本地 HTTP 服务，同时说 OpenAI 方言（`/v1/chat/completions`、`/v1/models`）和 Anthropic 方言（`/v1/messages`），把请求翻译成 `llm-chathub` 的 `LlmAdapter.stream()` 调用。

这样「模型选择器」不需要发明：每个客户端的**原生**选择器直接列出五个模型：

- Trae / WorkBuddy：自定义 OpenAI Compatible provider，可从 `/v1/models` 拉列表；
- Codex：`config.toml` 的 `model_providers` + `model = "glm-web"`；
- Claude Code：`ANTHROPIC_BASE_URL` + `--model glm-web`。

方案对比（为什么不是别的）：

| 备选 | 否决原因 |
|---|---|
| 为每个客户端写插件/扩展 | 四套维护成本，每家 API 变一次全要跟；网关只维护两种线协议 |
| 让客户端直连浏览器 DevTools 协议 | 登录态、排队、页面生命周期无法共享，等于重写 chathub-host |
| 复用 `packages/api` 的 gateway | 那是 dsh Web BFF（Typert 远程流），不是模型线协议；混入会污染主业务流 |

## 4. 协议矩阵

| 客户端 | 配置面 | 线协议 | 模型发现 | 备注 |
|---|---|---|---|---|
| Claude Code | 环境变量 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` + `--model` 或 settings | Anthropic Messages（`/v1/messages`，SSE） | 不发现，显式填 id | system prompt 很大（1–2 万 token），见 §6.2 预算 |
| Codex CLI | `~/.codex/config.toml` 的 `model_providers`（`base_url`/`env_key`/`wire_api`） | OpenAI Chat Completions（`wire_api = "chat"`） | 不发现，显式填 id | 不用 Responses API，`chat` 线协议最稳 |
| Trae | 设置 → 模型 → 添加自定义模型（OpenAI Compatible） | OpenAI Chat Completions | 可拉 `/v1/models` | |
| WorkBuddy | 自定义 OpenAI 兼容 provider | OpenAI Chat Completions | 视版本，可手填 id | |

两种线协议覆盖全部四个客户端。网关内部先归一到统一内部请求模型，再分别出两种线格式——**一个翻译缝，两种方言**，与仓库「能力缝完整」的约定一致。

## 5. 架构与请求流

```text
Claude Code        Codex / Trae / WorkBuddy
    |  Anthropic wire      |  OpenAI wire
    v                       v
+---------------------------------------------+
| chathub-gateway（新插件，opt-in 挂载）        |
|  /v1/messages   /v1/chat/completions        |
|  /v1/models     统一内部请求模型 -> 线格式出   |
|  per-site FIFO 队列 / SSE keepalive / 鉴权    |
+----------------------+----------------------+
                       | ctx.llm（路由 glm-web-chathub 等）
                       v
+---------------------------------------------+
| llm-chathub（不动）                          |
|  renderRequest / <<<TOOL_CALL 块协议 /        |
|  parseAnswer / 修复轮 / 失败码                |
+----------------------+----------------------+
                       | WebChatTransport
                       v
+---------------------------------------------+
| chathub-host（不动）                          |
|  浏览器 runtime / 登录 / 轮次队列 / 持久化      |
+----------------------+----------------------+
                       |
        glm-web doubao-web gemini-web
        chatgpt-web qianwen-web（chathub 库层 provider）
```

一次请求的完整路径：

1. 客户端 POST `/v1/chat/completions`（或 `/v1/messages`），`model: "glm-web"`，带 tools 和完整历史；
2. 网关校验鉴权，把线格式消息归一为 `GenerateOptions`（system、messages、tool schemas）；
3. 网关查 `ctx.llm` 路由表，`glm-web` → provider 路由 `<site>-chathub`（`llm-chathub` 挂载时注册），调 `stream()`；
4. `llm-chathub` 渲染自包含提示词，经 `chathub-host` 在站点页面上完成一轮（每尝试新开页面）；
5. 适配层产出一个 text block 和至多一个 tool call；网关翻译回线格式（`finish_reason: "tool_calls"` / `stop_reason: "tool_use"`）；
6. 流式请求：文字按块以 SSE delta 转发，长轮次期间发 keepalive ping；
7. 客户端执行工具、回填结果、发起下一请求——每次请求都是全新站点会话，历史由客户端重发，与适配层「每步自包含」的设计天然吻合。

## 6. 网关关键设计

### 6.1 模型目录与 id

- 模型 id 直接用站点 id：`glm-web`、`doubao-web`、`gemini-web`、`chatgpt-web`、`qianwen-web`；
- `/v1/models` 只列「已挂载且登录可用」的站点：`ready` 全量列出，`needs-auth` 带标记，`not-started` 不列（与 `client-ui-chathub` 的选择器口径一致）；
- 每个模型声明 `resolveModel` 的 `contextWindow`，不虚标；
- 配置项 `sites`：默认全部五个，可裁剪。

### 6.2 请求映射

| 线格式（OpenAI / Anthropic） | 内部（GenerateOptions） |
|---|---|
| `messages[role=system]` / 顶层 `system` | `system`（单发，受 `maxSystemChars` 钳制） |
| `messages[role=user]` 文本 | user 消息 |
| assistant 消息里的 `tool_calls` / `tool_use` 块 | 历史里的 `[asked for <tool> <args>]` 条目 |
| `role=tool` / `tool_result` 块 | tool result 消息（受 `maxToolResultChars` 钳制，长文件结果带续读 offset） |
| `tools[].function` / `tools[].input_schema` | 工具 schema 白名单 |

注意两点：

1. **system 预算**：Claude Code 的 system prompt 很大。网关启动时对 `llm-chathub` 的 `maxSystemChars`/`maxPromptChars` 做一次配置校验：若低于阈值（建议 24k/96k 字符），在挂载日志里警告并给出 cordis.yml 示例——错配在网关侧显式暴露，而不是静默截断。
2. **历史轮数**：`historyTurns` 钳制会丢老历史，客户端会重发全量，网关不补救（这是适配层既有语义）；网关只在响应头/日志里带上 dropped 条目数（复用 `chathub-llm/turn` 事件的 `droppedEntries`）。

### 6.3 工具调用映射

`llm-chathub` 的块协议已经解决「站点无 function calling」问题，网关只做格式翻译：

- 适配层产出的单个 `ChatHubToolCall` → OpenAI `tool_calls[0]`（`function.arguments` 为 JSON 字符串）/ Anthropic `tool_use` 块（`input` 为对象）；
- `toolCallId`：适配层生成（`chathub-call-N`），网关原样回传，客户端回填时配对；
- **每回复至多一个调用**是硬约束：网关在 OpenAI 侧可设 `parallel_tool_calls: false` 语义（响应里只给一个 call），四个客户端的 agent 循环都兼容串行调用；
- 非法回复（超修复预算）→ `MALFORMED_RESPONSE` → HTTP 502（§6.6）。

### 6.4 流式语义（诚实声明）

宿主层是「提交 → 轮询到答案稳定」语义，没有 token 流，但轮询过程中的每次读取都能拿到答案容器的完整快照。网关按快照做实时转发：

- `stream: true` 请求：建立 SSE，立即发 role 事件；站点书写期间，每次轮询的新增可见文本即刻以 delta 事件转发（`chathub-host` 的 `watch` 快照 → 适配层的 holdback 增量 → 网关逐帧写出）；帧间隙每 15s 发注释行或 ping 事件（Anthropic 线有 `ping` 事件类型，OpenAI 线用 `: keepalive` 注释行），防止客户端空闲超时；
- 增量转发只覆盖 pinned 单站点路由；聚合路由与压缩轮次保持整块交付（轮换与修复机制和增量外泄不兼容）；
- 流式即提交：一旦有 delta 交付，非法回复以 `MALFORMED_RESPONSE` 呈现而不是透明重问（调用方已经看过一半，重问无法透明）；
- 标记 holdback：适配层扣留少量字符，跨快照被拆开的 `<<<TOOL_CALL` / `<<<END` 标记绝不作为答案文本外泄；
- `stream: false` 请求：整轮等待后一次性返回（网关自身的 HTTP 超时要 ≥ 宿主 `turnTimeoutMs` + 余量）；
- 首延迟取决于站点书写节奏（glm-web 实测首个内容帧约 6s，后续 20 帧在约 11s 内陆续到达），这是浏览器免费模型的物理现实，写入文档而非隐藏。

### 6.5 排队与并发

- `chathub-host` 已按站点序列化轮次（同站点一页一队列）；网关侧维护 per-model FIFO：
  - 在队请求全部挂起等 SSE/长轮询，不占浏览器；
  - 队列上限（配置项 `maxQueuePerSite`，默认 8）满时直接回 429 + `Retry-After`；
- 不同站点之间完全并行（五个站点五条队列）；
- `chathub-busy` / `chathub-paced`（站点限流）→ 429，把宿主的退避建议写进 `Retry-After`。

### 6.6 错误码映射

| 站点 token / 适配层结果 | HTTP | OpenAI 线 | Anthropic 线 |
|---|---|---|---|
| `chathub-signed-out` | 401 | `error.code: "chathub_signed_out"`，message 指引打开 ChatHub 面板登录 | `error.type: "authentication_error"` |
| `chathub-busy` / `chathub-paced` | 429 | `rate_limit_exceeded` + Retry-After | `rate_limit_error` |
| `chathub-browser-unavailable` / `chathub-profile-locked` | 503 | `server_error`，可重试 | `api_error` |
| `chathub-ui-drift` | 500 | message 明说「站点驱动需更新」 | `api_error` |
| `chathub-network` | 502 | `server_error` | `api_error` |
| 修复预算耗尽（MALFORMED_RESPONSE） | 502 | message 带拒绝原因 | `api_error` |
| 提示词超预算（CONTEXT_WINDOW_EXCEEDED） | 400 | `context_length_exceeded` | `invalid_request_error`，message 建议 compaction/缩短 |
| 网关鉴权失败 | 401 | `invalid_api_key` | `authentication_error` |

原则：message 里写**用户可执行的下一步**（去哪登录、怎么缩短上下文），不拼站点原文——与 `ChatHubController` 的错误语义一致。

### 6.7 鉴权与登录态

- 网关默认只绑 `127.0.0.1`（配置 `host`）；
- 可选 `apiKey`：配置后校验 `Authorization: Bearer`（OpenAI 客户端）与 `x-api-key`（Claude Code）；未配置则只校验来源地址；
- 站点登录态完全在 `chathub-host` 的浏览器 profile 里：`needs-auth` 的站点在 `/v1/models` 里带标记，调用时返回 401 引导；登录动作发生在 `dsh web` 的 ChatHub 面板（复用 `webChat` Remote），网关不弹窗；
- 网关自身不落任何 cookie/token。

### 6.8 配置面（Config，全部可从 cordis.yml 覆盖）

```yaml
# cordis.patch.yml 里挂载（示例）
- id: chathub-gateway
  name: '@deepseek-ai/dsh-experimental-chathub-gateway'
  config:
    host: 127.0.0.1
    port: 8787
    apiKey: ''            # 空 = 不校验（仅本机绑定）
    sites: [glm-web, doubao-web, gemini-web, chatgpt-web, qianwen-web]
    maxQueuePerSite: 8
    keepaliveMs: 15000
    wires: [openai, anthropic]   # 可只开一种
```

无硬编码可调项；协议常量（SSE 帧格式）除外。

## 7. 四个客户端的接入配置

网关起来后，每个客户端一次配置：

**Claude Code**

```sh
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_AUTH_TOKEN=<apiKey 或任意非空>
claude --model glm-web
```

**Codex**（`~/.codex/config.toml`）

```toml
model = "glm-web"
model_provider = "chathub"

[model_providers.chathub]
name = "ChatHub"
base_url = "http://127.0.0.1:8787/v1"
env_key = "CHATHUB_API_KEY"
wire_api = "chat"
```

**Trae / WorkBuddy**

设置 → 模型 → 添加自定义模型：

- 协议：OpenAI Compatible
- Base URL：`http://127.0.0.1:8787/v1`
- API Key：`<apiKey 或任意非空>`
- 模型：从列表选（`/v1/models` 发现）或手填 `glm-web`

后续增强（进 `client-ui-chathub`，不动网关）：面板加「接入编码 agent」卡片，展示以上四段配置并带一键复制。

## 8. 与四插件的边界

- **零改动**：`chathub`、`chathub-host`、`llm-chathub`、`client-ui-chathub` 四个包的行为与默认值不变；
- 网关是第五个 experimental 插件，opt-in 挂载（不挂就完全没有 HTTP 出口）；
- 网关消费 `ctx.llm`（`llm-chathub` 注册的路由），不直接 import 宿主内部对象，与 `client-ui-chathub` 只走 Remote 的纪律同构；
- 网关不写 Harness 会话日志（它不是 dsh 会话的一部分），自身指标复用 `chathub-llm/turn` 事件流。

## 9. 分期落地与验证

**Phase 1 — OpenAI 线（覆盖 Codex / Trae / WorkBuddy）**

- `chathub-gateway` 包骨架：HTTP 服务、`/v1/models`、`/v1/chat/completions`（非流式 + SSE 实时流式，见 §6.4）、per-site 队列、错误映射、鉴权；
- 单测：线格式 ↔ `GenerateOptions` 互转、tool call 翻译、错误表、队列上限；
- 真浏览器验证（轨道规则 3）：Codex 挂 `glm-web`，项目级 prompt、同一话题两轮、一次合法工具调用，报告每轮站点与失败码。

**Phase 2 — Anthropic 线（覆盖 Claude Code）**

- `/v1/messages` + SSE（content_block_delta、ping）、system/tools 映射、system 预算校验；
- 真浏览器验证：Claude Code + `glm-web`，同样口径。

**Phase 3 — 收尾**

- WorkBuddy 全流程过一遍；keepalive 调优；面板「接入编码 agent」卡片；
- 观测：网关侧请求计数、排队时长、每站点失败码分布（从 `chathub-llm/turn` 聚合）。

**Deferred（明确不做进首版）**

- 每回复多工具调用（块协议单调用约束）；
- 网关侧上下文压缩建议（客户端已有各自机制）。

## 10. 风险与已知限制

| 风险/限制 | 应对 |
|---|---|
| 站点反爬 / UI 漂移 | 失败码如实上报（`chathub-ui-drift` → 500 明示驱动需更新）；适配层修复轮兜底（流式提交后不再兜底，见 §6.4） |
| 首 token 延迟取决于站点书写节奏 | SSE 快照实时转发 + keepalive 防超时；文档如实声明实际到达节奏 |
| Claude Code 大 system prompt | 挂载时预算校验 + 警告；`maxSystemChars`/`maxPromptChars` 在 cordis.yml 调大 |
| 每回复一个工具调用 | `parallel_tool_calls: false` 语义；四个客户端 agent 循环均兼容串行 |
| 站点模型「编造」（配额/进度幻觉） | 既有防线：块协议 + 修复轮 + ROLE 固定块事实行；网关不额外补救，失败如实返回 |
| 多客户端同时打同一站点 | per-site FIFO + 队列上限 + 429；宿主 `settleChains` 串行化已保证不互相杀页面 |
| 免费站点 ToS 风险 | 仅本机绑定、单用户自用；不代理他人、不聚合多账号 |

## 11. 结论

四个 chathub 插件已经把「浏览器里的免费模型」变成了带工具调用、有失败语义、可排队的 `LlmAdapter` 路由；缺的只是一层线协议翻译。新增第五个插件 `chathub-gateway`，用 OpenAI + Anthropic 双方言把这五个模型暴露给任意支持自定义端点的编码 agent，就能让 Claude Code、Codex、Trae、WorkBuddy 的原生模型选择器直接列出 `glm-web` 到 `qianwen-web`——不改四个客户端、不改四个既有插件，网关本身约等于「一个翻译缝 + 一个队列 + 一张错误表」。
