# ChatHub 统一 Web 界面实施计划

## Context

ChatHub 已完成库层（provider 抽象、会话编排、语义上下文）与宿主层（`chathub-host`：browser runtime、`WebChatTransport`、`webChat` Remote），但缺少用户可见界面。当前缺口是：

- 无法在 Web 端选择模型
- 无法登录/复用站点会话
- 无法创建会话并发送消息
- 无法在同一会话中切换 provider 并保留上下文

本轮按已确认的选择实现：

- 独立 ChatHub 面板（侧边栏入口 + 主栏聊天页），与现有 dsh 会话并行；
- 最小闭环：创建会话 → 发送一轮 → 切换模型 → 时间线落盘；
- 会话、消息和 checkpoint 使用 Host storage domain 持久化，重启后恢复。

目标产物是一个可体验的 `dsh web` 界面：provider 健康/登录状态、消息流、模型切换都走 Host 的 ChatHub 编排，而不是伪造数据。

## 架构决策

1. Host 编排保留在 `chathub-host` 内，不新建 Host 包。
   - `WebChatTransportService` 负责 browser runtime / registry / transport；
   - `ChatHubController` 负责 session lifecycle / persistence / model switch / remote API；
   - `client-ui-chathub` 仅负责 UI 渲染和远程调用。
   - 这样可以避免把内部实现细节暴露给 UI 层，保持契约稳定。

2. `ChatHubController` 作为 `TypertRemoteService`，namespace 为 `chatHub`。
   - 不新增独立插件 row；
   - 配置入口仍由 `WebChatTransportService` 负责；
   - 对外只暴露 DTO 和远程 API，不暴露内部 registry/transport 对象。

3. 持久化使用 `ctx.storageDomain`。
   - 挂载默认 storage domain；
   - 使用 `$DSH_HOME/storages/chathub.json` 作为数据文件；
   - schema 结构：
     - `sessions`
     - `messages`
     - `timeline`
     - `checkpoints`
     - `providerState`
   - 不自行实现文件读写，避免绕过宿主存储抽象。

4. ChatHub 消息不进入 Harness 会话日志。
   - 这条约束必须明确：消息只存 chathub storage domain；
   - 不注入 Harness 模型请求；
   - 不写入现有会话日志，避免跨层污染。

5. 客户端包是独立包 `packages/experimental/client-ui-chathub`。
   - 通过 `ctx.remote.$mount(chatHubRemote)` 挂载 Remote 客户端；
   - 通过 `sidebar.panellist` + `main` 面板方式接入；
   - 不直接访问 Host 私有对象。

## Host 侧改动

### 1. `packages/experimental/chathub-host/package.json`

新增导出：

```json
"./typert": {
  "types": "./lib/typert.host.d.ts",
  "default": "./lib/typert.host.js"
},
"./remote": {
  "types": "./lib/typert.remote-client.d.ts",
  "default": "./lib/typert.remote-client.js"
}
```

对应产物加入 `files`，否则 `scripts/generate-typert.ts` 生成失败。

### 2. 新增 `src/controller.ts`

`export class ChatHubController extends TypertRemoteService`

职责：

- `super(ctx, 'chatHub', { namespace: 'chatHub' })`
- 依赖注入：`['typert', 'storageDomain']`
- 内部持有：
  - `SessionManager`
  - `registry`
  - `ContextCompiler`
  - `CheckpointService`
  - `SessionTimelineService`
  - storage-backed session/message repository

Remote API（首版非流式）：

- `state(): Promise<ChatHubPanelState>`
- `create(input: { title, goal, provider }): Promise<ChatHubSessionView>`
- `send(sessionId, content): Promise<ChatHubTurnResult>`
- `switch(sessionId, providerId, reason): Promise<ChatHubSwitchResult>`
- `history(sessionId): Promise<ChatMessage[]>`
- `timeline(sessionId): Promise<SessionTimelineEntry[]>`
- `delete(sessionId): Promise<void>`
- `resume(): Promise<ChatHubPanelState>`

错误语义：

- 所有 provider 失败均按稳定错误码返回；
- 不拼接站点原文；
- UI 层只展示 `providerStatus` 和 `lastError`。

### 3. `src/types.ts`

新增 DTO：

- `ChatHubSessionSummary`
- `ChatHubSessionView`
- `ChatHubPanelState`
- `ChatHubTurnResult`
- `ChatHubSwitchResult`

新增状态类型：

```ts
type SessionStatus =
  | 'idle'
  | 'thinking'
  | 'tool-running'
  | 'waiting'
  | 'done'
  | 'failed'

type ProviderStatus =
  | 'not-started'
  | 'ready'
  | 'needs-auth'
  | 'failed'
```

### 4. `cordis.patch.yml`

保留 `chathub-host` 行，新增客户端行：

```yaml
- id: ui-chathub
  name: '@deepseek-ai/dsh-experimental-client-ui-chathub'
```

并在 `chathub-host/package.json` 的 `dependencies` 中声明该客户端包，确保 `verify-cordis-config` 能识别。

## 客户端包 `packages/experimental/client-ui-chathub`

文件骨架：

- `package.json`
- `tsdown.config.ts`
- `tsconfig.json`
- `tsconfig.client.json`
- `src/index.ts`
- `src/client/index.ts`
- `src/client/store.ts`
- `src/client/ChatHubPanel.tsx`
- `src/client/ChatHubPanel.module.css`
- `locale/*.json`

### `src/client/index.ts`

职责：

- `inject = ['remote', 'slots', 'locale', 'layout', 'remote.chatHub', 'remote.webChat']`
- 通过 `ctx.effect` 注册 locale
- 通过 `ctx.remote.$mount(chatHubRemote)` 挂载 remote
- 注册 `main` 面板和 `sidebar.panellist`

### `src/client/store.ts`

状态：

- providers
- session list
- current session
- active messages
- busy
- error
- providerStatus

### `src/client/ChatHubPanel.tsx`

界面结构：

- 顶部：provider selector + 健康徽标
- 侧栏：session 列表 + 新建 session
- 主栏：消息区 + 输入区
- 底部：发送按钮 + 切换模型按钮
- 说明：
  - provider 选择器只列 `ready` / `needs-auth`
  - `not-started` 显示为灰色，不允许发送
  - 切换 provider 前要求确认并显示 checkpoint 摘要

### Locale / docs

- `src/client/locales.ts`：`zh` 为键源
- `locale/*.json`：8 语言（en, zh, ja, es, fr, de, ru, pt）
- README / README.zh.md / README.i18n.yaml 追加说明

## 仓库接入清单

- `tsconfig.base.json`：加入 `@deepseek-ai/dsh-experimental-client-ui-chathub/client` 路径别名
- `tsconfig.client.json`：加入 project reference
- `packages/experimental/README.md` / `README.zh.md`：补两行包说明
- `scripts/verify-package-readme-model-experience.ts`：登记新包 `kind: 'none'`
- README 文档补齐 `Known Limitations`
- `pnpm install` 更新 lock

## 关键契约与状态

### Session 状态机

推荐最终定义：

```ts
type SessionStatus =
  | 'idle'
  | 'thinking'
  | 'tool-running'
  | 'waiting'
  | 'done'
  | 'failed'

type ProviderStatus =
  | 'not-started'
  | 'ready'
  | 'needs-auth'
  | 'failed'
```

### 消息顺序

- 用户消息先落盘
- 再触发 provider.sendMessage
- 若失败，保留 user 消息 + `lastError`
- 不写 assistant 消息
- 切换模型时保留 prior goal / facts / plan

### 切换前置

- `SessionManager.switchProvider()` 仍保留 ready 校验
- UI 依据 `providerStatus` 禁用切换
- 切换时必须：

  1. 先生成 checkpoint
  2. 再创建 canonical context
  3. 再编译 prompt
  4. 再更新 session.currentProvider
  5. 再落盘 timeline

### tool-running 模型切换

必须明确：

- 若 `session.status === 'tool-running'`，新 provider switch 必须保留已完成任务上下文；
- 不丢 `plan`, `facts`, `decisions`, `openQuestions`；
- 切换前要写 `checkpoint`，保证中断后可恢复。

## 验证

自动化：

```sh
pnpm exec vitest run packages/experimental/chathub-host/tests packages/experimental/client-ui-chathub/tests --coverage
pnpm exec tsx scripts/run-oxlint.ts packages/experimental/chathub-host packages/experimental/client-ui-chathub
pnpm run build:artifacts && pnpm run build:check
pnpm run test:docs
pnpm run verify-cordis-config
pnpm run hygiene
```

覆盖点：

- controller：创建 / 发送 / 切换 / 删除 / 重启恢复
- provider 失败不写 assistant
- checkpoint 顺序正确
- tool-running 切换保留上下文
- client：挂载成功与失败回滚，panel 注册成功，provider 列表渲染，发送禁用态

手动：

```sh
DSH_CHATHUB_PROFILE_DIR=/tmp/chathub-web-profile \
  pnpm dsh web --patch packages/experimental/chathub-host/cordis.patch.yml
```

验证步骤：

1. 侧边栏出现 ChatHub 入口，主栏打开 panel
2. provider 列表显示 `not-started`
3. 点击登录 -> Chrome 弹出 -> 扫码 -> provider 变 `ready`
4. 新建会话 -> 发送 “Reply with exactly: ok” -> 显示 `ok`
5. 切换到另一个已登录 provider -> 看到 checkpoint 提示
6. 重启 Host -> 会话和消息还在
7. 退出后 `/tmp/.../chathub.lock` 清理

## 风险与已知限制

- 站点反爬：豆包仍不稳定，登录失败按 `needs-auth` / `failed` 展示，不做强制重试。
- 首版非流式：`send` 使用整轮等待，UI 显示 `thinking`；流式留到下一轮。
- 面板是 opt-in：只建包不会自动出现在浏览器 roster，必须通过 patch 行装载。
- 多窗口共享同一 Host state：切换模型依赖宿主内单例 registry，不跨进程共享。

## 结论

这个方案的方向是正确的：把 UI 设计为独立 ChatHub 面板，并让 Host 负责 provider / session / switch / persistence，能最大化复用现有架构。

但它必须补齐 3 件事：状态机、tool-running 模型切换、持久化 schema。只有完成这三处，它才真正符合“可体验 + 可恢复 + 可维护”的工程要求。