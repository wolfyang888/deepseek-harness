---
description: "本地 OpenAI 线协议 HTTP 网关，把已挂载的 ChatHub 站点路由暴露给外部编码 agent，带每站点准入与稳定失败码。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-chathub-gateway

[English](README.md) | 中文

## 概述

把已挂载的 ChatHub 站点路由（`glm-web`、`doubao-web`、`gemini-web`、`chatgpt-web`、`qianwen-web` 等）以 OpenAI 线协议模型的形式服务在本地 HTTP 端口上，让外部编码 agent——Codex、Trae、WorkBuddy，以及任何说 OpenAI 兼容 chat completions 的客户端——通过它们自己的模型选择器列出并使用这些模型。网关不持有浏览器状态、不存储任何东西：它把一次请求翻译成 llm-chathub 层已注册路由上的一次 `ctx.llm` 轮次，并把失败映射成带下一步动作的 OpenAI 线格式错误。出厂 profile 不包含它。

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

网关要挂在 ChatHub 宿主层和 llm-chathub 适配层之后；挂载顺序有影响，因为模型目录读取这两层提供的传输健康状态：

```sh
pnpm dsh web --patch packages/experimental/chathub-host/cordis.patch.yml \
              --patch packages/experimental/llm-chathub/cordis.patch.yml \
              --patch packages/experimental/chathub-gateway/cordis.patch.yml
```

该行默认 `127.0.0.1:8787`，暴露全部已挂载站点，不校验 key。把 OpenAI 兼容的 agent 指过来：

```sh
# Codex (~/.codex/config.toml)
model = "glm-web"
model_provider = "chathub"
[model_providers.chathub]
name = "ChatHub"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "chat"
```

Trae 与 WorkBuddy 用同一个 base URL 添加自定义 OpenAI 兼容 provider；`GET /v1/models` 列出站点模型及其登录状态。Claude Code 需要 Anthropic 线协议，属于后续工作（见下）。

### Configuration

```yaml
- name: '@deepseek-ai/dsh-experimental-chathub-gateway'
  config:
    host: 127.0.0.1
    port: 8787
    apiKey: ''
    sites: []
    maxQueuePerSite: 8
    keepaliveMs: 15000
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `host` | `127.0.0.1` | 绑定地址；回环绑定让网关只在本机可达 |
| `port` | `8787` | 绑定端口 |
| `apiKey` | `''` | 每个请求必须携带的 Bearer key；为空则不校验，只在回环绑定下安全 |
| `sites` | 全部健康已知站点 | 要暴露的已挂载站点 id；配置了但传输不认识的站点直接从目录里去掉，不会标成 needs-auth |
| `maxQueuePerSite` | `8` | 单站点接受的待处理请求数，超出回 429 |
| `keepaliveMs` | `15000` | 站点轮次进行中 SSE keepalive 的写入间隔 |

bundle 层把 `DSH_CHATHUB_GATEWAY_HOST`、`DSH_CHATHUB_GATEWAY_PORT`、`DSH_CHATHUB_GATEWAY_KEY`、`DSH_CHATHUB_GATEWAY_SITES`、`DSH_CHATHUB_GATEWAY_QUEUE`、`DSH_CHATHUB_GATEWAY_KEEPALIVE_MS` 映射到同名字段，站点目录默认取自 `DSH_CHATHUB_LLM_SITES` / `DSH_CHATHUB_LLM_SITE`。

### Failure codes

| 站点状态 | HTTP | 线格式 `error.code` |
|---|---|---|
| 站点已登出 | 401 | `chathub_signed_out`，message 指向 ChatHub 面板 |
| 站点限流 | 429 | `rate_limit_exceeded`，附 `Retry-After` |
| 浏览器不可用或驱动漂移 | 503 | `server_error` |
| 站点不可达 | 502 | `server_error` |
| 修复预算耗尽后仍不合法的回答 | 502 | `server_error` |
| 轮次超时 | 504 | `timeout` |
| 渲染后的提示词超预算 | 400 | `context_length_exceeded` |
| 站点队列已满 | 429 | `rate_limit_exceeded`，附 `Retry-After` |
| 模型未暴露 | 404 | `model_not_found` |

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

`openai-wire.ts` 是唯一的翻译缝：`toGenerateOptions` 把线格式消息（system、user、assistant 文本与 `tool_calls`、tool 结果）折叠成 `GenerateOptions`，并保留适配层签发的调用 id；`toCompletionResponse` / `sseRenderer` 把该轮的 chunk 展开成 completion 对象或逐帧的 SSE 渲染器。第一个文本块和第一个 tool-call 块胜出；适配层不会产出更多。

`server.ts` 拥有 HTTP 面：请求路由、Bearer 校验、请求体大小上限（32 MiB）、SSE 生命周期——响应头加一条 keepalive 注释开流，每个适配层 chunk 落地即刻写成自己的帧，`keepaliveMs` 在站点轮次进行中的帧间隙维持连接，失败的轮次以线格式错误事件呈现而不是断流。模型解析走传输健康状态：`ready` 的站点应答，`needs-auth` 的站点回 401 附面板指引，未列出的模型回 404 附列表指引。

`queue.ts` 按站点统计待处理请求，超过 `maxQueuePerSite` 回 429；站点之间互不计数。`errors.ts` 把 llm runtime 的稳定失败码映射到 HTTP 状态与用户可执行的 message——绝不拼接站点原文。`index.ts` 把行解析成配置，并用 context effect 注册监听器，插件停时端口随之关闭。

| 文件 | 作用 |
|---|---|
| [`src/types.ts`](src/types.ts) | 配置、模型目录行、失败事实 |
| [`src/openai-wire.ts`](src/openai-wire.ts) | 线格式请求折叠与响应/SSE 展开 |
| [`src/server.ts`](src/server.ts) | HTTP 路由、鉴权、SSE 生命周期、模型解析 |
| [`src/queue.ts`](src/queue.ts) | 每站点待处理计数与 429 上限 |
| [`src/errors.ts`](src/errors.ts) | llm 失败码到 HTTP 与线格式错误 |
| [`src/index.ts`](src/index.ts) | Cordis 插件、配置 schema、监听器生命周期 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [LLM chathub adapter](../llm-chathub/README.zh.md) — 本网关转发到的路由，以及塑造返回内容的调用协议。
- [ChatHub browser transport](../chathub-host/README.zh.md) — 模型目录读取的浏览器运行时、登录状态与健康行。
- [ChatHub 设计](../../../chatDeepDoc/model.md) — 覆盖全部四个目标 agent 的网关设计文档。

-----

<a id="model-experience"></a>
## 模型体验

无，因为网关只改表示形式，不改内容：外部 agent 的 system prompt、消息与工具 schema 经线格式折叠原样进入 llm-chathub 适配层，后者渲染站点提示词的方式与 harness 会话步骤完全一致。

#### KV Cache 影响

无直接影响；每个网关请求变成一次适配层轮次，各自打开自己的站点会话，与 harness 会话的步骤一致。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

- **Anthropic 线协议待做** — Claude Code 需要 `/v1/messages` 及其自己的 SSE 事件词汇；OpenAI 线协议先覆盖 Codex、Trae、WorkBuddy。
- **流式即提交** — pinned 路由在站点书写的同时流式转发答案，已交付的 delta 无法再透明修复：非法回答以 `MALFORMED_RESPONSE` 错误呈现而不是重问。聚合路由、压缩轮次与无快照的会话保持整块交付并保留修复。
- **无真实用量统计** — web 回答不带 token 计数，`usage` 只镜像适配层的估算。
- **是队列，不是公平调度** — 每站点准入只给待处理请求设上限，不重排；站点页面上的轮次仍由宿主传输串行化。
- **跨轮次无请求身份** — 网关在两次调用之间不存储任何东西；外部 agent 自己的历史就是会话。
- **Bearer key 是唯一鉴权** — 没有 TLS、没有按客户端的 key；回环绑定就是边界。在非回环地址上绑定而不设 key 是本包不阻止的错误配置。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

网关是第五个 ChatHub 插件：按浏览器模型本地编辑轨道的规则，组合既有四层而不改动它们。真浏览器验证沿用该轨道的 manual-check 模式——项目规模的提示词、同一话题两轮、一次合法工具调用——通过指向该端口的外部 agent 执行。

</details>
