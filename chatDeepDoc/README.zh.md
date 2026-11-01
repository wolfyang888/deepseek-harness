# chatDeepDoc 验校指南

[English](README.md) | 中文

本目录记录 ChatHub 浏览器方案的设计与实现文档。本文给出宿主层 `WebChatTransport` 实现（[`packages/experimental/chathub-host`](../packages/experimental/chathub-host/README.zh.md)，设计见 [chatHub-web-ui-plan.md](chatHub-web-ui-plan.md)）的手动验校步骤。

## 覆盖范围

| 层 | 能否自动校验 | 手段 |
|---|---|---|
| 驱动合并、`open` 语义、失败 token、完成判定、profile 锁、轮次串行化 | 是 | 单元测试（注入假页面与假启动器） |
| Cordis 服务、Remote 注册、销毁、managed/cdp、登录取消 | 是 | 单元测试（`vi.mock('playwright-core')`） |
| 组合入口（bundle 层、配置 schema、插件解析） | 是 | `--dump-config` / `--dump-config-schema` 与文档门禁 |
| 真实站点登录、真实提问与答案读取 | 否 | 本机 Chrome + 下方脚本 |

## 一、自动校验（无需浏览器）

```sh
pnpm exec vitest run packages/experimental/chathub-host/tests --coverage --coverage.include='packages/experimental/chathub-host/src/**'
pnpm exec tsx scripts/run-oxlint.ts packages/experimental/chathub-host
pnpm run build:artifacts
pnpm run build:check
pnpm run test:docs
pnpm run verify-cordis-config
```

预期结果：

- 7 个测试文件、86 个用例全部通过，`src/` 每个文件行、分支、函数覆盖率为 100%；
- oxlint 对 `packages/experimental/chathub-host` 无输出（0 错误）；
- `test:docs` 21 项全部通过；`verify-cordis-config` 报告所有配置文件通过；
- `build:check` 的 client、host 两个 aggregate 均通过。

其中 `lists every shipped provider as not-started without launching Chrome` 这条用例即证明：挂载服务不会启动浏览器。

## 二、组合入口校验（不启动浏览器）

确认 `cordis.patch.yml` 能被 Loader 正确解析并参与组合：

```sh
pnpm dsh web --dump-config --patch packages/experimental/chathub-host/cordis.patch.yml | tail -20
```

预期末尾出现：

```yaml
- id: chathub-host
  name: '@deepseek-ai/dsh-experimental-chathub-host'
  config:
    browser: !!js ...
```

确认配置经 schemastery 解析出 schema：

```sh
pnpm dsh web --dump-config-schema --patch packages/experimental/chathub-host/cordis.patch.yml 2>/dev/null | grep -A2 '"id": "chathub-host"'
```

预期：

```json
"id": "chathub-host",
"name": "@deepseek-ai/dsh-experimental-chathub-host",
"status": "schema",
```

`status: schema` 表示该行的 `Config` 已被解析成 schema；若写成 `unresolved` 或整行缺失，说明 bundle 层没被应用或插件名未被解析。

## 三、启动 Web 组合（可选）

```sh
DSH_CHATHUB_PROFILE_DIR=/tmp/chathub-web-profile \
  pnpm dsh web --patch packages/experimental/chathub-host/cordis.patch.yml
```

预期：Web 界面正常打开，启动日志无 `chathub-*` 报错；执行 `pgrep -af 'chrome.*chathub-web-profile'` 应为空输出，即挂载只注册四个适配器、未拉起浏览器（浏览器在首次提供方调用或登录时才启动）。退出后在 `/tmp/chathub-web-profile/chathub.lock` 应被清理。

## 四、真实浏览器校验（核心手动步骤）

本阶段还没有客户端模型切换界面，Remote 也不便直接调用，因此用传输层脚本直连真实站点，覆盖提交、登录等待、答案轮询三条链路。

1. 在仓库内新建临时脚本 `packages/experimental/chathub-host/manual-check.mts`（校验完删除，不要提交）。
2. 粘贴以下内容：

```ts
/* Owner-local manual check: real Chrome, real site. Run from the repo root:
   pnpm exec tsx packages/experimental/chathub-host/manual-check.mts [providerId]
   Delete this file and its profile directory when done. */
import { chromium } from 'playwright-core'
import type { WebChatPayload } from '@deepseek-ai/dsh-experimental-chathub'
import { PlaywrightBrowserRuntime } from './src/runtime.ts'
import { PlaywrightWebChatTransport } from './src/transport.ts'
import { resolveSiteDrivers } from './src/drivers.ts'
import type { Config } from './src/types.ts'

const providerId = process.argv[2] ?? 'deepseek-web'
const config: Config = {
  browser: {
    mode: 'managed',
    profileDir: process.env.DSH_CHATHUB_PROFILE_DIR ?? '/tmp/chathub-manual-profile',
    headless: false,
  },
  loginTimeoutMs: 300_000,
  turnTimeoutMs: 180_000,
  actionTimeoutMs: 15_000,
  pollMs: 500,
  stablePolls: 3,
  maxQueuedTurns: 2,
  typeDelayMs: 0,
}
const drivers = resolveSiteDrivers({})
const driver = drivers[providerId]
if (driver === undefined) throw new Error(`no shipped driver: ${providerId}`)
const runtime = new PlaywrightBrowserRuntime(
  config.browser,
  { actionTimeoutMs: config.actionTimeoutMs, pollMs: config.pollMs },
  chromium,
)
const transport = new PlaywrightWebChatTransport(runtime, { ...config, drivers: {} }, drivers)

const signedIn = await runtime.login(providerId, driver, config.loginTimeoutMs, new AbortController().signal)
console.log(`[${providerId}] signed in: ${signedIn}`)

const opened = await transport.open(providerId)
if (opened === undefined) throw new Error('transport.open returned undefined')
if ('closed' in opened) {
  console.log(`[${providerId}] no session: ${opened.reason}`)
} else {
  const payload: WebChatPayload = {
    providerId,
    system: '',
    messages: [],
    prompt: 'Reply with exactly: ok',
    meta: { origin: 'raw-messages' },
  }
  const answer = await opened.send(payload)
  console.log(`[${providerId}] answer: ${answer.content}`)
}

await transport.dispose()
```

3. 运行（四个 id 任选：`deepseek-web`、`chatgpt-web`、`gemini-web`、`doubao-web`）：

```sh
pnpm exec tsx packages/experimental/chathub-host/manual-check.mts deepseek-web
```

4. 首次运行会弹出 Chrome 并停在站点页面，脚本最多等待 `loginTimeoutMs`（默认 5 分钟）。在窗口内完成登录后脚本自动继续，无需重跑。
5. 预期输出：

```
[deepseek-web] signed in: true
[deepseek-web] answer: ok
```

若工作站没有默认 Chrome，可在配置中显式指定二进制（加到 `browser` 内，与 `headless` 同级）：

```ts
executablePath: '/usr/bin/google-chrome',
```

## 五、常见失败与含义

脚本抛出的错误消息以稳定 token 开头，站点原文只保留在 `cause` 中：

| token | 含义 | 处理 |
|---|---|---|
| `chathub-signed-out` | 页面关闭或跳转到登录/登出页 | 重新执行并在窗口内登录 |
| `chathub-turn-timeout` | 一轮超过 `turnTimeoutMs` 未稳定 | 检查站点是否在生成中，必要时调大超时 |
| `chathub-ui-drift` | 输入框或答案容器选择器失效 | 站点改版，更新 `drivers` 覆盖或 `DEFAULT_SITE_DRIVERS` |
| `chathub-profile-locked` | 同一 profile 目录被另一个 Host 进程占用 | 关闭旧进程，或换 `DSH_CHATHUB_PROFILE_DIR` |
| `chathub-browser-unavailable` | Chrome 缺失、启动失败或运行时已销毁 | 安装 Chrome 或配置 `executablePath` |
| `chathub-busy` | 同一 key 排队轮次超过 `maxQueuedTurns` | 等待前一轮结束或调大队列 |
| `chathub-network` | 页面请求网络失败 | 检查网络或代理 |

## 六、清理

```sh
rm packages/experimental/chathub-host/manual-check.mts
rm -rf /tmp/chathub-manual-profile
```

登录态只存在 profile 目录中的 cookie/localStorage，不写入会话状态、日志或事件；删除 profile 即彻底退出登录。

## 七、本阶段未覆盖的部分

- 客户端模型切换与 `ChatHubController`（设计文档第 17 节第 8 步，尚未实现）；
- 通过浏览器端 `/api` Remote 通道调用 `webChat.providers/login/reauthenticate` 的端到端流程，需要客户端界面或带 Peer 身份的直连调用；
- 四个站点的自动化回归仍由 [`packages/experimental/chathub/scripts/real-browser/validate.mts`](../packages/experimental/chathub/scripts/real-browser/validate.mts) 人工执行（站点选择器与 ChatHub 归一化码），与本包脚本验证的是不同层。
