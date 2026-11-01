# 宿主层 WebChatTransport 实现设计

## 1. 范围与目标

本设计描述 ChatHub 浏览器 provider 在**宿主层**的落地方案：由 Host 进程独占浏览器资源，实现 `WebChatTransport`，并把登录、健康检查、重认证通过 Remote 暴露给客户端。

库层已经冻结的契约是 [`WebChatTransport`](../packages/experimental/chathub/src/providers/web-provider.ts)：`open(providerId, sessionKey?)` 返回 `WebChatTransportSession | WebChatTransportClosed | undefined`。库层明确“登录态与页面隔离由宿主提供”，provider 不持有 cookie/token。

目标：

1. 一个宿主服务覆盖 `deepseek-web`、`chatgpt-web`、`gemini-web`、`doubao-web` 四个已注册适配器。
2. 登录、失效、重登录、并发轮次、超时、销毁都有明确语义。
3. 失败信息只以稳定错误码进入 ChatHub，不泄漏站点原文。
4. 浏览器实现可替换：`managed`（宿主拉起 Chrome）与 `cdp`（连接用户已开 Chrome）。

非目标：

- 不实现会话编排 UI（模型选择器属于客户端，单独阶段）。
- 不改动 `ChatRequest` / `ChatResponse` 或 provider 适配器契约。
- 不把该实现挂进默认产品 profile：实验包不得被 release 包或 apps 直接依赖。

## 2. 依赖方向与包位置

新增实验包 `packages/experimental/chathub-host`，npm 名 `@deepseek-ai/dsh-experimental-chathub-host`。

依赖方向：

```
apps / profile (opt-in composition)
        └── @deepseek-ai/dsh-experimental-chathub-host
                ├── @deepseek-ai/dsh-experimental-chathub   (库)
                ├── @deepseek-ai/cordis                     (peer/dev)
                └── playwright-core                         (peer, optional)
```

库不得反向依赖宿主包。浏览器二进制不随包发布：`playwright-core` 只提供 API，Chrome 来自系统安装或 `executablePath` 配置。

仓库接入清单（缺一不可）：

1. `packages/experimental/chathub-host/package.json`（含 `dsh.bundle` 声明）、`tsconfig.json`、`README.md`、`README.zh.md`、`README.i18n.yaml`、`cordis.patch.yml`（可选 bundle 层）；
2. `tsconfig.base.json` 增加 `@deepseek-ai/dsh-experimental-chathub-host` 路径别名；
3. `tsconfig.host.json` 增加 project reference；
4. `scripts/verify-package-readme-model-experience.ts` 登记该包的 Model Experience 形式（服务插件默认按 `package-reference` 校验，无需登记到 library 白名单）；
5. `packages/experimental/README.md` 与 `README.zh.md` 表格新增该包与 ctx key；
6. `pnpm install` 更新 workspace 链接与 lockfile；
7. 文档门禁（doc-sync / doc-standard）与包 README 限制章节。

## 3. 分层结构

| 层 | 职责 | 关键类型 |
|---|---|---|
| `BrowserRuntime` | 独占一个 Chrome 进程或 Context，负责启动、profile、页面获取与销毁 | `BrowserRuntimeConfig` |
| `SiteDriver` | 每个站点的 URL、输入框、答案容器、登录墙、提交策略、完成判定参数 | `SiteDriverConfig` |
| `PlaywrightChatSession` | 实现 `WebChatTransportSession`：提交、读取答案、流式增量、关闭 | `ChatPage` |
| `PlaywrightWebChatTransport` | 实现 `WebChatTransport`：按 provider 复用页面、登录判定、串行化 | `WebChatTransport` |
| `WebChatTransportService` | Cordis 服务 + Typert Remote：`providers` / `login` / `reauthenticate` | `TypertRemoteService` |

会话编排（`ProviderRegistry` + `SessionManager` + `ModelRouter`）不并入连接服务。仓库规则要求新远程能力各自成服务，连接管理与多模型会话属于两条业务边界；第二阶段单独提供 `ChatHubController`。

## 4. 浏览器运行时

### 4.1 模式

`managed`：

```ts
chromium.launchPersistentContext(profileDir, {
  executablePath,
  headless,
  viewport: null,
  args: ['--disable-blink-features=AutomationControlled'],
})
```

`cdp`：

```ts
browser = await chromium.connectOverCDP(cdpEndpoint)
context = browser.contexts()[0] ?? await browser.newContext()
```

CDP 模式复用用户已开的浏览器，支持用户在登录过程中直接操作；其代价是不能通过 `launchPersistentContext` 设参数，选择器等待要使用自己的轮询而不是 `waitForSelector`（现网验证脚本已经踩过该坑）。

### 4.2 单实例与 profile

- 同一 `profileDir` 只允许一个 Host 进程使用：启动前读取 `profileDir/chathub.lock`，存在且进程存活则加载失败，进程已死则接管。
- `profileDir` 没有默认值，必须由宿主显式配置到用户数据目录；目录权限 `0700`。
- cookie/localStorage 只存在于 profile 中，不写入 provider、会话状态、日志或事件。

### 4.3 页面生命周期

- 每个 provider 至多一个活动页面，`open` 时复用；页面被关闭或导航失败则重建。
- 页面创建统一走 `BrowserRuntime.acquire(providerId, driver)`，由 runtime 记录条目，销毁时统一关闭。
- runtime 只由服务持有，不导出到 provider。

## 5. 站点驱动配置

```ts
export interface SiteDriverConfig {
  /** 聊天页面 URL。 */
  url: string
  /** 输入元素选择器（textarea 或 contenteditable）。 */
  input: string
  /** 答案容器选择器；取最后一个匹配元素。 */
  answer: string
  /** 仅在未登录时出现的元素。 */
  loginWall?: string
  /** 匹配登录/登出/会话过期跳转的路径正则，大小写不敏感。 */
  signedOutPath?: string
  /** 提交方式，默认 Enter。 */
  submitKey?: string
  /** 判定答案完成所需的连续稳定轮询次数。 */
  stablePolls?: number
  /** 轮询间隔。 */
  pollMs?: number
}
```

包内为四个 provider 提供默认值，宿主可以按 provider 覆盖任意字段：

```ts
const DEFAULT_SITE_DRIVERS: Record<string, SiteDriverConfig> = {
  'deepseek-web': { url: 'https://chat.deepseek.com/', input: 'textarea', answer: '.ds-markdown' },
  'chatgpt-web': { url: 'https://chatgpt.com/', input: '#prompt-textarea', answer: '[data-message-author-role="assistant"] .markdown', loginWall: '[data-testid="login-button"]' },
  'gemini-web': { url: 'https://gemini.google.com/app', input: '.ql-editor', answer: 'model-response .markdown' },
  'doubao-web': { url: 'https://www.doubao.com/chat', input: '.ProseMirror[contenteditable="true"]', answer: '[class*="markdown"]' },
}
// 四个驱动都带 signedOutPath: 'login|logout|sign_in|signin|expired' 与 submitKey: 'Enter'。
```

选择器属于外部站点事实，会漂移，因此必须可覆盖；超时与轮询参数属于部署选择，全部是受校验的 `Config` 字段，代码中不新增 `DEFAULT_*` 常量作为“配置”。

构造期校验：`drivers` 中出现的 providerId 必须存在于 `webProviderAdapters`，否则加载失败（misconfiguration fails loud）。

## 6. `open()` 语义

```ts
async open(
  providerId: string,
  sessionKey?: string,
): Promise<WebChatTransportSession | WebChatTransportClosed | undefined> {
  const driver = this.drivers[providerId]
  if (driver === undefined) throw new BrowserTransportError('chathub-driver-missing', providerId)
  const key = sessionKey ?? providerId
  const page = await this.runtime.acquire(key, driver)
  const signedIn = await page.waitForInput(
    driver.input,
    driver.loginWall,
    this.config.loginTimeoutMs,
    this.config.pollMs,
  )
  if (!signedIn) {
    await this.runtime.release(key)
    return { closed: true, reason: 'not-signed-in' }
  }
  return new PlaywrightChatSession(key, page, driver, this.config, this.runtime)
}
```

规则：

- 未登录返回 `{ closed: true, reason: 'not-signed-in' }`，**不抛错**。抛错会让 `probeProvider` 记为 `failed`，而不是 `needs-auth`。
- 登录墙元素可见时直接判定未登录，不再等满超时。
- `sessionKey` 用于同一站点多会话（历史对话恢复），映射到独立页面。
- providerId 未注册时抛配置错误，属于加载期错误或调用期不可恢复错误。
- 传输层任何失败都必须抛带稳定 token 的 `BrowserTransportError`，消息形如 `chathub-signed-out: ...`。

## 7. 单轮交互

`PlaywrightChatSession`：

- `send(payload)`：提交 → 等待完成 → 返回完整答案；
- `stream(payload)`：提交 → 按增量 yield；
- `close()`：释放页面。

提交：定位输入框中心 → 真实鼠标点击（激活 ProseMirror）→ `keyboard.type(prompt)` → `keyboard.press(submitKey)`。

完成判定：以 `pollMs` 轮询最后一个答案容器的 `innerText`，文本连续 `stablePolls` 次不变即完成；文本为空或精确等于输入 prompt 视为尚未产生答案。超过 `turnTimeoutMs` 抛 `chathub-turn-timeout`。

流式增量：累计文本以 `emitted` 为前缀时 yield 差量；出现整体替换时 yield 全量。该实现不是 token 级流，只是页面文本轮询。

页面失效识别：

- 页面关闭、`Target page, context or browser has been closed` → `chathub-signed-out`；
- URL 落到登录/登出页 → `chathub-signed-out`；
- 选择器找不到 → `chathub-ui-drift`；
- 网络类错误 → `chathub-network`。

## 8. 失败归一化

传输层错误码与 ChatHub 归一化结果映射：

| 传输 token | ProviderErrorCode | ChatHubErrorCode | UI 含义 |
|---|---|---|---|
| `chathub-signed-out` | `auth-required` | `provider-not-ready` | 需要重新登录 |
| `chathub-driver-missing` | `unsupported-capability` | `unsupported-request` | 配置错误 |
| `chathub-ui-drift` | `provider-unavailable` | `provider-call-failed` | 站点改版，暂时不可用 |
| `chathub-turn-timeout` | `stream-interrupted` | `stream-interrupted` | 本轮超时 |
| `chathub-busy` | `rate-limited` | `rate-limited` | 页面忙 |
| `chathub-network` | `network-error` | `network-error` | 网络问题 |
| `chathub-profile-locked` | `provider-unavailable` | `provider-call-failed` | profile 被其他进程占用 |
| `chathub-browser-unavailable` | `provider-unavailable` | `provider-call-failed` | Chrome 缺失、页面打开失败或运行时已销毁 |

宿主在构造适配器时通过 `WebProviderOverrides.failureRules` 注入：

```ts
const failureRules: readonly ProviderFailureRule[] = [
  { pattern: /chathub-signed-out/, code: 'auth-required' },
  { pattern: /chathub-driver-missing/, code: 'unsupported-capability' },
  { pattern: /chathub-ui-drift/, code: 'provider-unavailable' },
  { pattern: /chathub-turn-timeout/, code: 'stream-interrupted' },
  { pattern: /chathub-busy/, code: 'rate-limited' },
  { pattern: /chathub-network/, code: 'network-error' },
  { pattern: /chathub-profile-locked/, code: 'provider-unavailable' },
  { pattern: /chathub-browser-unavailable/, code: 'provider-unavailable' },
]
```

`failureRules` 是适配器既有扩展点，不新增库接口。站点原文只保留在 `cause` 链中，不进入 `ChatHubError.message` 的稳定部分。

## 9. 登录与重认证

`login(providerId)`：

1. 强制 headful 打开站点页（即使服务配置为 headless）；
2. 轮询输入框出现，最长 `loginTimeoutMs`；
3. 成功后将登录态留在 profile（持久化 profile 自动保存，不显式导出 storageState）；
4. 调用 `registry.reauthenticate(providerId)` 并返回 `ProviderHealth`；
5. 取消信号触发时关闭页面并返回 `needs-auth`。

`reauthenticate(providerId)`：

1. `provider.close()`：库内 `WebModelProvider` 出错时不会自动清空 `#session`，必须先关闭，否则 `healthStatus()` 会持续报 `ready`；
2. `registry.reauthenticate(providerId)`；
3. 返回最新 `ProviderHealth`，失败原因只含稳定 `ProviderErrorCode`。

登录态判定与状态：

| 情况 | transport 返回 | provider 状态 |
|---|---|---|
| 输入框出现 | session | `ready` |
| 输入框未出现且未初始化 | `{ closed, 'not-signed-in' }` | `needs-auth` |
| 页面会话中途失效 | 抛 `chathub-signed-out` | 服务关闭 session 后 `needs-auth` |
| 站点容器被改版 | 抛 `chathub-ui-drift` | `failed` + `provider-unavailable` |

## 10. 并发、取消与超时

- 每个 provider（或 `sessionKey`）同一时刻只允许一个轮次。transport 用 per-key promise 链串行化；排队超过上限时直接抛 `chathub-busy`。
- `WebChatTransportSession` 契约没有取消参数，取消的唯一手段是 `close()`：Remote 的 `AbortSignal` 映射为“关页 + 本轮返回 `stream-interrupted`”，下一次 `open` 重建页面。
- 三层超时：登录等待 `loginTimeoutMs`、单轮 `turnTimeoutMs`、单次页面操作 `actionTimeoutMs`。

## 11. 生命周期与销毁

服务构造时建立 runtime 与 transport，并注册销毁

```ts
constructor(ctx: Context, config: Config) {
  super(ctx, 'webChatTransport', { namespace: 'webChat' })
  const drivers = resolveSiteDrivers(config.drivers)
  assertEveryAdapterHasDriver(drivers)
  this.runtime = new PlaywrightBrowserRuntime(config.browser, timings, lazyChromiumLauncher())
  this.transport = new PlaywrightWebChatTransport(this.runtime, resolved, drivers)
  ctx.effect(() => () => this.shutdown())
}
```

`shutdown()` 必须到达静止，而不是只发出请求：

1. 停止接收新轮次；
2. 等待在飞轮次 settle；
3. 关闭所有页面；
4. 关闭 Context；
5. `managed` 模式下杀掉自拉起的 Chrome 并等待子进程退出；
6. 释放 profile 锁文件。

## 12. Remote 接口

`WebChatTransportService extends TypertRemoteService`，命名空间 `webChat`，ctx key `webChatTransport`。

```ts
export class WebChatTransportService extends TypertRemoteService {
  static inject = ['typert']

  /** 四个已注册 provider 的身份与健康快照。 */
  @Remote
  providers(): Promise<WebChatProviderView[]>

  /** 打开 headful 页面完成人工登录，返回登录后的健康状态。 */
  @Remote
  login(providerId: string, signal: AbortSignal): Promise<ProviderHealth>

  /** 关闭旧会话并按当前登录态重新打开。 */
  @Remote
  reauthenticate(providerId: string): Promise<ProviderHealth>
}
```

`WebChatProviderView` 字段：`id`、`name`、`kind`、`capabilities`、`health`。

第二阶段 `ChatHubController`（独立服务，命名空间 `chatHub`）：

- `@Remote('create')`：创建会话；
- `@Remote('switch')`：切换 provider，返回 checkpoint 与编译后的 prompt；
- `@Remote('send')`：发送一轮；
- `@Remote('timeline')`：读取时间线。

会话编排复用库内 `ProviderRegistry`、`SessionManager`、`ContextCompiler`、`CheckpointService`、`SessionTimelineService`、`ModelRouter`，不复制实现。

## 13. 配置

```ts
export interface Config {
  browser:
    | { mode: 'managed'; profileDir: string; executablePath?: string; headless: boolean }
    | { mode: 'cdp'; profileDir: string; cdpEndpoint: string; headless: boolean }
  loginTimeoutMs: number
  turnTimeoutMs: number
  actionTimeoutMs: number
  pollMs: number
  stablePolls: number
  maxQueuedTurns: number
  typeDelayMs: number
  drivers: Record<string, Partial<SiteDriverConfig>>
}
```

全部字段进入 Cordis `Config` schema 校验，无隐式默认；`profileDir` 必填。`stablePolls`、`pollMs` 与 `typeDelayMs` 作为服务级默认值，可被单个驱动的同名字段覆盖。

## 14. 接线示例

服务在构造期完成注册：为每个随包适配器创建 provider，注入同一个 transport 与 `WEB_TRANSPORT_FAILURE_RULES`，并放入私有 `ProviderRegistry`；挂载即完成，无需额外的 `init()`。

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

服务持有 registry 与 transport。第二阶段 `ChatHubController` 通过 `ctx.webChatTransport` 的 Remote 调用驱动登录与状态，并按需要由服务暴露 registry 访问入口，不自行创建浏览器。

包内随附可选 bundle 层 [`packages/experimental/chathub-host/cordis.patch.yml`](../packages/experimental/chathub-host/cordis.patch.yml)（manifest 的 `dsh.bundle.patch`，`listedByDefault: false`），通过 `dsh web --patch packages/experimental/chathub-host/cordis.patch.yml` 应用；默认值由 `DSH_CHATHUB_*` 环境变量驱动，profile 目录默认 `$DSH_HOME/chathub-profile`。

## 15. 测试与验收

| 层 | 测试 |
|---|---|
| 纯逻辑 | 站点驱动合并与加载期校验、`open` 三种返回、失败 token 映射、元素轮询、完成判定与增量、profile 锁、轮次串行化与队列上限（注入的假页面与假启动器） |
| 服务 | `ctx.plugin(WebChatTransportService, config)` 注册 Remote 与 `ctx.fiber.dispose()` 销毁；`vi.mock('playwright-core')` 注入假启动器，覆盖 managed 与 cdp、登录成功与取消、登录墙、错误重抛 |
| 真站 | 保留 `packages/experimental/chathub/scripts/real-browser/validate.mts` 作为合入前人工门禁 |

测试约束：

- 页面、context 与 Chrome 必须在每个用例后关闭，禁止跨用例共享 profile；
- 依赖外网的用例不进入单测；真实站点验证通过上面的 validate 脚本人工执行，失败时报告具体 provider 与 token；
- provider 归一化测试继续由 `packages/experimental/chathub/tests/web-provider.spec.ts` 覆盖。

## 16. 风险与限制

- 站点反爬与 ToS：CDP 模式与用户自有 profile 更接近真实使用，但仍不保证不被风控。
- 选择器漂移：站点改版会让 `answer`/`input` 失效，错误归为 `provider-unavailable`，需更新默认值或配置覆盖。
- 单 profile 进程锁：同一 profile 不能同时被两个 Host 进程占用。
- 流式保真度：DOM 轮询只能做到段落级增量，不是 token 级。
- 取消粒度：库契约无 per-turn 取消，只能关页重建。
- 打包体积：`playwright-core` 作为 optional peer，避免控制器无关的宿主被迫安装。
- 产品隔离：实验包不得进入 release 包或 apps 依赖；接入只能是显式 opt-in composition。

## 17. 实施顺序

1. 包骨架与仓库接入（package.json、tsconfig、README、别名、reference、doc-standard 登记）。
2. `SiteDriver` 默认值与配置合并、`BrowserTransportError`。
3. `BrowserRuntime`（managed/cdp、profile 锁、页面获取与释放）。
4. `PlaywrightChatSession`（提交、完成判定、增量、失效识别）。
5. `PlaywrightWebChatTransport`（`open` 语义、串行化）。
6. `WebChatTransportService`（Cordis 服务、Remote 生成）。
7. 测试与文档门禁。
8. 第二阶段：`ChatHubController`。
