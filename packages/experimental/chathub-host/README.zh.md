---
description: "在宿主内独占 ChatHub 随包浏览器适配器所需的 Chromium 页面，并提供登录 Remote 调用与稳定失败码。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-chathub-host

[English](README.md) | 中文

## 概述

在宿主内运行 ChatHub 的 DeepSeek Chat、ChatGPT、Gemini 与 Doubao 适配器所需的浏览器。挂载服务不会启动任何东西：首次页面请求、登录或健康检查才会打开一个持久化 profile，并按提供方或会话键复用同一个页面。同一键上的轮次按顺序执行，多出的轮次在配置上限内排队，登录始终打开可见窗口。站点原文不会成为提供方错误；传输层只报告稳定 token，由 ChatHub 映射为自身错误码。该包是实验性且需显式启用的，依赖已安装的 Chrome，并把 `playwright-core` 作为可选 peer。

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

`WebChatTransportService` 实现 ChatHub 浏览器适配器接受的 `WebChatTransport`，注册全部四个随包提供方，并通过 `webChat` Remote 命名空间暴露 `providers`、`login` 与 `reauthenticate`。宿主通过 `ctx.webChatTransport` 访问该服务。

### 何时选用

当组合挂载 [`dsh-experimental-chathub`](../chathub/README.zh.md) 浏览器提供方，并需要这些适配器留给宿主的页面归属、持久登录与轮次顺序时选用本服务。若每个会话只需一个已配置 API 模型，应改用 [`dsh-llm`](../../llm/llm/README.zh.md)；本包驱动用户登录的站点，不提供模型路由。`managed` 模式拉起自己的持久化 profile，`cdp` 模式连接用户已运行的 Chrome。

### 组合进 profile

本包随附可选的 bundle 层 [`cordis.patch.yml`](cordis.patch.yml)，通过 manifest 的 `dsh.bundle` 块声明，不进入随包发布的 profile。在源码检出中按如下方式应用：

```sh
pnpm dsh web --patch packages/experimental/chathub-host/cordis.patch.yml
```

该层挂载一行 `chathub-host`，默认值由环境变量驱动：`DSH_CHATHUB_PROFILE_DIR`（默认 `$DSH_HOME/chathub-profile`）、`DSH_CHATHUB_HEADLESS`、`DSH_CHATHUB_CDP_ENDPOINT`、`DSH_CHATHUB_EXECUTABLE_PATH`，以及每个计时字段各一个 `DSH_CHATHUB_*` 变量。挂载仅注册四个适配器，不启动 Chrome；浏览器在首次提供方调用或登录时才启动。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-experimental-chathub-host'
  config:
    browser:
      mode: managed
      profileDir: /path/to/chrome-profile
      headless: true
    loginTimeoutMs: 300000
    turnTimeoutMs: 180000
    actionTimeoutMs: 15000
    pollMs: 500
    stablePolls: 3
    maxQueuedTurns: 2
    typeDelayMs: 0
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `browser.mode` | 必填 | `managed` 拉起持久化 profile；`cdp` 连接已有 Chrome |
| `browser.profileDir` | 必填 | 存放持久化 profile 及其 `chathub.lock` 的目录 |
| `browser.executablePath` | 系统 Chrome | `managed` 启动时使用的 Chrome 二进制 |
| `browser.cdpEndpoint` | `cdp` 下必填 | 要连接的远程调试端点 |
| `browser.headless` | 必填 | `managed` 启动时的窗口模式；`login` 仍会打开可见窗口 |
| `loginTimeoutMs` | 必填 | 登录与 `open` 期间等待输入框的最长时间 |
| `turnTimeoutMs` | 必填 | 一轮提示产生稳定答案的期限 |
| `actionTimeoutMs` | 必填 | 页面操作的默认超时 |
| `pollMs` | 必填 | 输入框、登录墙与答案的轮询间隔 |
| `stablePolls` | 必填 | 判定答案完成所需的连续不变读取次数 |
| `maxQueuedTurns` | 必填 | 同一键在活动轮次之后允许排队的轮次数 |
| `typeDelayMs` | 必填 | 逐字符输入之间的延迟 |
| `drivers` | `{}` | 按提供方覆盖选择器与轮询参数，并合并到随包驱动之上 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-chathub-host)是全部可接受字段的完整来源。`drivers` 的键必须命名随包提供方；空选择器、小于 1 的轮询上限或无法编译的 `signedOutPath` 都会在加载期失败。

即使 `browser.headless` 为 true，`login` 也会打开可见页面，最多等待 `loginTimeoutMs` 直到输入框出现，把 cookie 留在 profile 中，并重新打开提供方。`reauthenticate` 关闭提供方会话，再按当前登录状态重新打开。两者都返回 `ProviderHealth`；取消登录或页面在输入框出现前关闭时，提供方保持 `needs-auth`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

`drivers.ts` 把宿主覆盖合并到四个适配器的随包站点事实，并在任何浏览器操作之前校验合并后的驱动，因此错误的选择器会在加载期而不是轮次中途失败。`runtime.ts` 用进程 id 预留 `profileDir/chathub.lock`，把不可读或进程已退出的持有者视为过期，并拒绝仍被活动进程占用的 profile；它打开一个 context——受管持久启动或 CDP 连接——按键记录一个页面，并通过 promise 链与有界等待队列按键串行化轮次。销毁会等待在飞轮次、关闭页面与自有 context，并移除锁。

`page.ts` 轮询元素可见性与答案文本，而不是使用 `waitForSelector`，因为 CDP 连接与 contenteditable 输入在 Playwright 的选择器等待下并不可靠。它把 Playwright 失败映射为稳定 token：页面关闭或执行上下文销毁报告 `chathub-signed-out`，传输失败报告 `chathub-network`，其余报告 `chathub-ui-drift`。`session.ts` 点击输入框中心、键入提示、按下提交键，并轮询最后一个答案容器，直到其文本连续 `stablePolls` 次不变；`stream` 对增长的答案产出前缀差量，站点整体替换时产出全文，精确等于提示的回显不计为答案。

`transport.ts` 按提供方或会话键打开或复用页面，站点未登录时返回 `{ closed: true, reason: 'not-signed-in' }`，使 ChatHub 探测保持 `needs-auth` 而不记录失败。它还导出每个适配器都会收到的失败规则，让传输 token 在不携带站点原文的情况下转换为提供方错误码：

| 传输 token | 提供方错误码 | 含义 |
|---|---|---|
| `chathub-signed-out` | `auth-required` | 需要重新登录 |
| `chathub-driver-missing` | `unsupported-capability` | 该提供方没有驱动 |
| `chathub-ui-drift` | `provider-unavailable` | 站点改版或容器缺失 |
| `chathub-turn-timeout` | `stream-interrupted` | 答案未在期限内完成 |
| `chathub-busy` | `rate-limited` | 该键的轮次队列已满 |
| `chathub-network` | `network-error` | 请求或页面加载失败 |
| `chathub-profile-locked` | `provider-unavailable` | 另一进程占用该 profile |
| `chathub-browser-unavailable` | `provider-unavailable` | Chrome 缺失、页面打开失败或运行时已销毁 |

`index.ts` 构建运行时与传输层，注册四个适配器，并在首次使用浏览器时才加载 `playwright-core`，因此从不打开浏览器的组合无需安装它。

| 文件 | 职责 |
|---|---|
| [`src/types.ts`](src/types.ts) | 配置、驱动、浏览器与面向传输层的接口 |
| [`src/drivers.ts`](src/drivers.ts) | 随包站点驱动、覆盖合并与加载期校验 |
| [`src/errors.ts`](src/errors.ts) | `BrowserTransportError` 与页面错误分类 |
| [`src/page.ts`](src/page.ts) | 元素轮询、答案读取与页面级错误映射 |
| [`src/session.ts`](src/session.ts) | 单轮提交、完成判定与流式差量 |
| [`src/runtime.ts`](src/runtime.ts) | profile 锁、context 归属、页面复用与轮次串行化 |
| [`src/transport.ts`](src/transport.ts) | `WebChatTransport.open` 与适配器失败规则 |
| [`src/index.ts`](src/index.ts) | `WebChatTransportService` 的 Remote 接口与销毁 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [ChatHub 库](../chathub/README.zh.md) —— 提供方运行时、检查点，以及本包实现的传输契约。
- [实验性包](../README.zh.md) —— 实验状态与显式组合方式。
- [架构](../../../docs/architecture.zh.md) —— 插件组合与服务注册。
- [防御性模式](../../../docs/defensive-patterns/README.zh.md) —— 本包遵循的生命周期、并发与销毁要求。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过随包适配器驱动的浏览器页面。

#### KV Cache 影响

传输层不添加自己的提示文本：它键入 ChatHub 适配器已渲染的提示，并轮询站点的答案容器，因此各站点自己的缓存取决于其自身渲染，本包不重算任何前缀。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

- Chrome 不随包发布；本包依赖已安装的浏览器或 `browser.executablePath`，且 `playwright-core` 是可选 peer。
- DOM 轮询只能产出段落级差量，不是 token 级流式。
- `WebChatTransportSession` 没有单轮取消；关闭页面是停止一轮的唯一方式。
- CDP 模式不能传递启动参数或设置视口，选择器等待只能用轮询而非 Playwright 的选择器等待。
- 站点选择器属于会漂移的外部事实；需要更新随包驱动或按提供方覆盖 `drivers`。
- 一个 profile 目录只属于一个宿主进程；活动锁会拒绝该 profile，过期锁在下次启动时被接管。
- 登录始终需要可见窗口，因此无显示设备的宿主必须使用已登录 profile 或 CDP 模式。
- 本包只负责传输与登录；会话编排、模型切换与提供方界面属于其他服务。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
