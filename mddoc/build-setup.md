# Chathub 插件打包与安装指南

覆盖 `packages/experimental/` 下的五个 chathub 插件：

| 包 | npm 名 | 说明 |
|---|---|---|
| chathub | `@deepseek-ai/dsh-experimental-chathub` | 多模型会话运行时 |
| client-ui-chathub | `@deepseek-ai/dsh-experimental-client-ui-chathub` | 浏览器侧边栏面板 |
| chathub-host | `@deepseek-ai/dsh-experimental-chathub-host` | 宿主浏览器运行时与 Remote |
| llm-chathub | `@deepseek-ai/dsh-experimental-llm-chathub` | 网页模型 LLM 适配器 |
| chathub-gateway | `@deepseek-ai/dsh-experimental-chathub-gateway` | 本地 HTTP 网关：把站点路由暴露成 OpenAI 兼容模型 |

以下命令除特别说明外，都从仓库根目录 `deepseek-harness/` 执行。

## 1. 打包

### 1.1 一键脚本（推荐）

脚本：[pack-chathub.mjs](pack-chathub.mjs)

```bash
node mddoc/pack-chathub.mjs
```

它按顺序做三件事：

1. 以官方 client 档案重建产物，环境变量：

   ```bash
   DSH_BUILD_CLIENT_PROFILE=official \
   DSH_CLIENT_COMMIT_HASH="$(git rev-parse HEAD)" \
   DSH_CLIENT_VERSION="$(node -p "require('./package.json').version")" \
   pnpm run build:artifacts
   ```

   缺少官方档案时 `pnpm pack` 仍会成功，但产出的 client 产物不是官方档
   （`.dsh-build/client-build-environment.json` 里没有 `DSH_CLIENT_TITLE`），
   仓库的发布校验会拒绝这样的包。

2. 定向打包五个包（保持依赖顺序）：

   ```bash
   pnpm pack --recursive --workspace-concurrency=1 \
     --filter=@deepseek-ai/dsh-experimental-chathub \
     --filter=@deepseek-ai/dsh-experimental-client-ui-chathub \
     --filter=@deepseek-ai/dsh-experimental-chathub-host \
     --filter=@deepseek-ai/dsh-experimental-llm-chathub \
     --filter=@deepseek-ai/dsh-experimental-chathub-gateway \
     --pack-destination "$(pwd)/dist/npm-chathub"
   ```

3. 校验 tarball：不允许出现 `package/src/`、`*.js.map`、`*.d.ts.map`，不允许残留
   `workspace:` 版本范围，并写出 `publish-order.txt`。

产物（`dist/` 已被 `.gitignore` 忽略）：

```
dist/npm-chathub/
  deepseek-ai-dsh-experimental-chathub-0.2.2-alpha.2.tgz
  deepseek-ai-dsh-experimental-client-ui-chathub-0.2.2-alpha.2.tgz
  deepseek-ai-dsh-experimental-chathub-host-0.2.2-alpha.2.tgz
  deepseek-ai-dsh-experimental-llm-chathub-0.2.2-alpha.2.tgz
  deepseek-ai-dsh-experimental-chathub-gateway-0.2.2-alpha.2.tgz
  publish-order.txt
```

五个包的版本必须与根 `package.json` 一致（`0.2.2-alpha.2`）：`pack-chathub.mjs`
按这个基线校验每个 tarball 的 `version`，不一致直接失败。gateway 原先是
`0.1.0-alpha.1`，作为仓库内唯一例外已对齐，否则它进不了这套打包流水线。

### 1.2 手工校验（可选）

```bash
cd dist/npm-chathub
for f in *.tgz; do
  echo "=== $f ==="
  tar -tzf "$f" | grep -E '^package/(src/|.*\.(js|d\.ts)\.map$)' && echo "FORBIDDEN" || echo "payload ok"
  tar -xOzf "$f" package/package.json | grep -c 'workspace:' | grep -q '^0$' \
    && echo "ranges ok" || echo "unresolved workspace range"
done
```

## 2. 安装

### 2.1 先看错误：没有 `package.json` 时 npm 会向上找到仓库根

在 `dist/npm-chathub/` 里直接执行：

```bash
npm install deepseek-ai-dsh-experimental-*.tgz
```

会报：

```
npm error code EUNSUPPORTEDPROTOCOL
npm error Unsupported URL Type "workspace:": workspace:~
```

根因有两层：

1. `dist/npm-chathub/` 没有 `package.json`，npm 会向上找到仓库根目录的
   `package.json`，把整个仓库当成一个 npm workspace 项目处理。
2. 仓库里各包的清单使用 pnpm 的 `workspace:` 协议，**npm 不支持该协议**，
   解析依赖时立刻失败。

同理，`npm` 也无法安装这批 tarball 的互相依赖（`chathub-host` 依赖
`chathub@0.2.2-alpha.2`，该版本尚未发布到 npm registry）。

**结论：让 npm 把某个目录当成项目根，安装即可成功。**两种做法：

- 在该目录放一个 `package.json`（本仓库已放好
  `dist/npm-chathub/package.json`，`name: chathub-staging`）；
- 或换到仓库之外的目录执行（见 2.2）。

### 2.2 就地安装到 `dist/npm-chathub`（你刚才那条命令，已验证）

`dist/npm-chathub/package.json` 已存在时，在原目录直接执行即可成功：

```bash
cd /home/ywf/work/code/github/deepseek-harness/dist/npm-chathub
npm install \
  deepseek-ai-dsh-experimental-chathub-0.2.2-alpha.2.tgz \
  deepseek-ai-dsh-experimental-chathub-host-0.2.2-alpha.2.tgz \
  deepseek-ai-dsh-experimental-llm-chathub-0.2.2-alpha.2.tgz \
  deepseek-ai-dsh-experimental-client-ui-chathub-0.2.2-alpha.2.tgz \
  deepseek-ai-dsh-experimental-chathub-gateway-0.2.2-alpha.2.tgz
```

实测安装成功，五个包可解析：

```bash
node -e "console.log(require.resolve('@deepseek-ai/dsh-experimental-llm-chathub'))"
# .../dist/npm-chathub/node_modules/@deepseek-ai/dsh-experimental-llm-chathub/lib/index.js
node -e "console.log(require.resolve('@deepseek-ai/dsh-experimental-chathub-gateway'))"
# .../dist/npm-chathub/node_modules/@deepseek-ai/dsh-experimental-chathub-gateway/lib/index.js
```

若该目录没有 `package.json`（例如重新打包后清空过），先补一个：

```bash
cd /home/ywf/work/code/github/deepseek-harness/dist/npm-chathub
npm init -y    # 或写入 {"name":"chathub-staging","private":true}
```

> `dist/` 已被 `.gitignore` 忽略，这里的 `package.json`、`node_modules`、
> `package-lock.json` 都不会进版本库，也不影响 `pnpm pack`（脚本只挑选 `*.tgz`）。
> 重新打包后 tarball 摘要会变，先 `rm -rf node_modules package-lock.json` 再装，
> 避免 npm 报 integrity 不匹配。

### 2.3 安装到独立项目目录（npm，已验证）

脚本：[install-chathub.sh](install-chathub.sh)

```bash
chmod +x mddoc/install-chathub.sh
./mddoc/install-chathub.sh /tmp/chathub-install-target
```

等价命令：

```bash
mkdir -p /tmp/chathub-install-target
cd /tmp/chathub-install-target
npm init -y
npm install --no-audit --no-fund \
  /home/ywf/work/code/github/deepseek-harness/dist/npm-chathub/deepseek-ai-dsh-experimental-chathub-0.2.2-alpha.2.tgz \
  /home/ywf/work/code/github/deepseek-harness/dist/npm-chathub/deepseek-ai-dsh-experimental-client-ui-chathub-0.2.2-alpha.2.tgz \
  /home/ywf/work/code/github/deepseek-harness/dist/npm-chathub/deepseek-ai-dsh-experimental-chathub-host-0.2.2-alpha.2.tgz \
  /home/ywf/work/code/github/deepseek-harness/dist/npm-chathub/deepseek-ai-dsh-experimental-llm-chathub-0.2.2-alpha.2.tgz \
  /home/ywf/work/code/github/deepseek-harness/dist/npm-chathub/deepseek-ai-dsh-experimental-chathub-gateway-0.2.2-alpha.2.tgz
```

npm 会把 `chathub-host → chathub@0.2.2-alpha.2` 这类依赖去重到同一次安装的
顶层 tarball，因此不需要 registry 上有这些实验包。验证：

```bash
node -e "console.log(require.resolve('@deepseek-ai/dsh-experimental-llm-chathub'))"
# /tmp/chathub-install-target/node_modules/@deepseek-ai/dsh-experimental-llm-chathub/lib/index.js
```

### 2.4 安装到 pnpm 项目 / dsh profile（pnpm + overrides，已验证）

pnpm 不会把子依赖去重到顶层 `file:` 依赖，必须用 `overrides` 把四个包都指向本地
tarball（pnpm 11 起 `overrides` 写在 `pnpm-workspace.yaml`，写在 `package.json`
的 `pnpm` 字段会被忽略）：

`package.json`：

```json
{
  "name": "chathub-profile",
  "private": true,
  "dependencies": {
    "@deepseek-ai/dsh-experimental-chathub": "file:/ABS/dist/npm-chathub/deepseek-ai-dsh-experimental-chathub-0.2.2-alpha.2.tgz",
    "@deepseek-ai/dsh-experimental-client-ui-chathub": "file:/ABS/dist/npm-chathub/deepseek-ai-dsh-experimental-client-ui-chathub-0.2.2-alpha.2.tgz",
    "@deepseek-ai/dsh-experimental-chathub-host": "file:/ABS/dist/npm-chathub/deepseek-ai-dsh-experimental-chathub-host-0.2.2-alpha.2.tgz",
    "@deepseek-ai/dsh-experimental-llm-chathub": "file:/ABS/dist/npm-chathub/deepseek-ai-dsh-experimental-llm-chathub-0.2.2-alpha.2.tgz",
    "@deepseek-ai/dsh-experimental-chathub-gateway": "file:/ABS/dist/npm-chathub/deepseek-ai-dsh-experimental-chathub-gateway-0.2.2-alpha.2.tgz"
  }
}
```

`pnpm-workspace.yaml`：

```yaml
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false

overrides:
  "@deepseek-ai/dsh-experimental-chathub": "file:/ABS/dist/npm-chathub/deepseek-ai-dsh-experimental-chathub-0.2.2-alpha.2.tgz"
  "@deepseek-ai/dsh-experimental-client-ui-chathub": "file:/ABS/dist/npm-chathub/deepseek-ai-dsh-experimental-client-ui-chathub-0.2.2-alpha.2.tgz"
  "@deepseek-ai/dsh-experimental-chathub-host": "file:/ABS/dist/npm-chathub/deepseek-ai-dsh-experimental-chathub-host-0.2.2-alpha.2.tgz"
```

安装：

```bash
pnpm install --no-frozen-lockfile
```

`autoInstallPeers: false` 让 pnpm 不安装 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm`
等 peer：它们应由宿主 harness 提供，装第二份会让 Cordis 服务注册表出现两份实例。

> 注意：dsh 的 profile（`~/.dsh/profiles/<name>`）就是这种 pnpm 工程。把四个包装进
> profile 后，`@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm` 等 peer 在 profile 内
> 并不存在，插件 import 时可能解析失败。**本地 tarball 只适合验证包内容**；要让 dsh
> 真正加载，用 2.5 的源码方式，或先把这些包发布到 registry 再按版本安装。

### 2.5 在 dsh 中启用（源码检出，推荐）

五个包在源码仓库里就是 workspace 成员，`pnpm install` 之后不需要 npm 安装。
**编译要求比想象的小**——实测把五个包的 `lib/` 全部移走再启动：host、llm、gateway
照样挂载（loader 经 tsx 直跑 `src/`），唯一失败的是面板
（`client-hmr` 等待 `clientModules` 服务）。所以：

| 产物 | 是否必须 | 谁产出 |
|---|---|---|
| `client-ui-chathub/lib/client.js` | **必须** | `pnpm --filter @deepseek-ai/dsh-experimental-client-ui-chathub run bundle` |
| 其余四包的 `lib/`、typert、tsdown 产物 | 不需要 | 开发模式全走 `src/` |

一键准备脚本：

```bash
scripts/build-chathub-dev.sh        # pnpm install（如缺）+ 面板 bundle + 产物自检
scripts/build-chathub-dev.sh --skip-install
```

启动（改完 `src/` 直接重启生效，无需重编；只有改了面板客户端才要重跑上面的脚本）：

```bash
cd /d/work/code/github/deepseek-harness
pnpm dsh web \
  --patch packages/experimental/chathub-host/cordis.patch.yml \
  --patch packages/experimental/llm-chathub/cordis.patch.yml \
  --patch packages/experimental/chathub-gateway/cordis.patch.yml \
  --port 8899 --no-open
```

启动后：

1. 在 ChatHub 面板 `providers` 里登录目标站点，状态变为 `ready`；
2. `pnpm dsh web --patch packages/experimental/chathub-gateway/cordis.patch.yml --dump-config | grep -E "chathub-host|ui-chathub|llm-chathub|chathub-gateway"` 应能看到四行；
3. 选 `<site>-chathub` 路由（挂哪些站点由 `DSH_CHATHUB_LLM_SITE` / `DSH_CHATHUB_LLM_SITES` 决定）跑一个只读任务（例如「读 package.json 并说出包名」），`chathub-llm/turn` 事件出现即链路通；有 gateway 时直接 `curl http://127.0.0.1:8787/v1/models` 更快。

常用环境变量：`DSH_CHATHUB_LLM_SITE`、`DSH_CHATHUB_LLM_SITES`、`DSH_CHATHUB_LLM_TOOLS`、
`DSH_CHATHUB_LLM_ROOT`、`DSH_CHATHUB_PROXY`（详见各 patch 文件头部注释）。

### 2.6 启用 gateway（OpenAI 兼容端点）

gateway 是第五个可选层，必须挂在另外两个 patch 之后——它的模型目录要读 host 的登录
健康状态，请求要转发到 llm-chathub 注册的 `ctx.llm` 路由：

```bash
pnpm dsh web \
  --patch packages/experimental/chathub-host/cordis.patch.yml \
  --patch packages/experimental/llm-chathub/cordis.patch.yml \
  --patch packages/experimental/chathub-gateway/cordis.patch.yml
```

默认监听 `127.0.0.1:8787`，暴露全部已挂载站点，不校验 key。可用环境变量或
`cordis.patch.yml` 覆盖：

| 环境变量 | 默认 | 含义 |
|---|---|---|
| `DSH_CHATHUB_GATEWAY_HOST` | `127.0.0.1` | 绑定地址；非回环时务必配 key |
| `DSH_CHATHUB_GATEWAY_PORT` | `8787` | 绑定端口 |
| `DSH_CHATHUB_GATEWAY_KEY` | 空 | 设了之后每个请求必须带 `Authorization: Bearer <key>` |
| `DSH_CHATHUB_GATEWAY_SITES` | 全部已挂载站点 | 逗号分隔的站点 id，裁剪模型目录 |
| `DSH_CHATHUB_GATEWAY_QUEUE` | `8` | 单站点待处理请求上限，超出回 429 |
| `DSH_CHATHUB_GATEWAY_KEEPALIVE_MS` | `15000` | 轮次进行中 SSE keepalive 间隔 |

起来之后先验端点，再配客户端：

```bash
# 模型目录：ready 的站点列出来，needs-auth 带标记
curl -s http://127.0.0.1:8787/v1/models | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  for (const m of JSON.parse(s).data) console.log(m.id, m.chathub?.status ?? '')
})"

# 非流式一轮
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  ${KEY:+-H "authorization: Bearer $KEY"} \
  -d '{"model":"glm-web","messages":[{"role":"user","content":"回答一个字：好"}]}' | head -c 400
```

四个客户端的接入：

**Codex**（`~/.codex/config.toml`）

```toml
model = "glm-web"
model_provider = "chathub"

[model_providers.chathub]
name = "ChatHub"
base_url = "http://127.0.0.1:8787/v1"
env_key = "CHATHUB_API_KEY"   # 与 DSH_CHATHUB_GATEWAY_KEY 同值；未设 key 时随便填非空
wire_api = "chat"
```

**Trae / WorkBuddy**：设置 → 模型 → 自定义模型（WorkBuddy 这一页的字段是
`provider` / `endpoint` / `apiKey` / `modelId` / `maxInputTokens` / `maxOutputTokens`
+ 能力开关）：

| 字段 | 填什么 |
|---|---|
| endpoint | `http://127.0.0.1:8787/v1` |
| apiKey | 与 `DSH_CHATHUB_GATEWAY_KEY` 同值；没设 key 时随便填非空 |
| modelId | **必须等于站点 id**（`glm-web`、`doubao-web`…），gateway 用 `${model}-chathub` 当路由名 |
| maxOutputTokens | 4096 以内，站点回答有自己的预算 |

**endpoint 的拼接规则（踩过坑）。** WorkBuddy 的 `endpoint` 不是 SDK 的 `baseURL`：它把
你填的值去掉尾斜杠后，**直接追加 `/chat/completions`**，并且**不会**自动补 `/v1`
（输入框的 placeholder 就是 `https://api.example.com/v1/chat/completions`）。所以

| 填的值 | 实际请求 | 结果 |
|---|---|---|
| `http://127.0.0.1:8787/v1` | `POST /v1/chat/completions` | 正确 |
| `http://127.0.0.1:8787/v1/chat/completions` | 同上（末尾已有后缀，不重复追加） | 正确 |
| `http://127.0.0.1:8787` | `POST /chat/completions` | 旧版本 404 `No route`；**现版本已兼容** |

网关现在同时接受裸路径 `/models` 与 `/chat/completions`（等价于带 `/v1` 的形式），
所以填根地址也能工作；但**推荐仍填 `/v1`**，与其他 OpenAI 兼容客户端保持一致。
配置落在 `~/.workbuddy/models.json` 的 `url` 字段，改完若未生效需重启 WorkBuddy。

**Claude Code**：需要 Anthropic 线协议（`/v1/messages`），当前版本未实现，先别配
`ANTHROPIC_BASE_URL`。

安全边界：默认只绑回环；`apiKey` 为空时任何本机进程都能用这批模型，绑到非回环地址
却又不设 key 是不受保护的错误配置；网关本身不落 cookie/token，站点登录态仍在
`chathub-host` 的浏览器 profile 里。

### 2.7 启动脚本、登录与限流

`scripts/run-chathub-gateway.sh` 把三条 patch 和端口都固化了，起完自检 `/v1/models`：

```bash
scripts/run-chathub-gateway.sh                       # headless，gateway :8787，面板 :8899
DSH_CHATHUB_LOGIN=true scripts/run-chathub-gateway.sh   # 首次登录：开可见浏览器
DSH_CHATHUB_PACING=responsive DSH_CHATHUB_SMOKE=sse scripts/run-chathub-gateway.sh
```

实跑输出（本机，健康探测未开浏览器时）：

```
gateway : http://127.0.0.1:8787/v1
panel   : http://127.0.0.1:8899/?token=PVzdYvS1...
  glm-web        needs-auth
  doubao-web     needs-auth
  deepseek-web   needs-auth
  qianwen-web    needs-auth
run-chathub-gateway: health probing never opens a browser, so `needs-auth`
  can also mean a signed-in site whose session has not been opened yet.
```

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_CHATHUB_SITES` | `glm-web,doubao-web,deepseek-web,qianwen-web` | 脚本会同时写进 `DSH_CHATHUB_LLM_SITES` 和 `DSH_CHATHUB_GATEWAY_SITES`。**两层的变量名不同**，只设 gateway 那份会让 `/v1/models` 列出没有挂载路由的站点 |
| `DSH_WEB_PORT` | `8899` | dsh web 面板端口 |
| `DSH_CHATHUB_GATEWAY_PORT` | `8787` | 网关端口 |
| `DSH_CHATHUB_LOGIN` | `false` | `true` → `DSH_CHATHUB_HEADLESS=false`，浏览器窗口可见 |
| `DSH_CHATHUB_PACING` | `responsive` | 见下表 |
| `DSH_CHATHUB_SMOKE` | `off` | `off` / `plain` / `sse`，起完发一轮证明线通；发到**无 `/v1` 前缀**的 `/chat/completions`，顺带验证客户端常用的路径别名 |
| `DSH_CHATHUB_SMOKE_MODEL` | 目录里第一个 `ready`，否则第一个站点 | 指定 smoke 用哪个站点；`needs-auth` 的站点也能试 |
| `DSH_CHATHUB_GATEWAY_KEY` | 空 | 设了之后脚本的**自检与 smoke 请求都会自动带上** `Authorization`，否则 `curl -f /v1/models` 会一直吃 401 直到自检超时 |
| `DSH_CHATHUB_LOG` | `./.dsh-chathub-gateway.log` | 日志；面板 token URL 也从这里取 |

**`needs-auth` 不等于未登录。** `/v1/models` 读的是 transport 的健康状态，而健康探测
**不会打开浏览器**；一个 profile 里已经登录、只是本次进程还没开过会话的站点，同样显示
`needs-auth`。实测本机 `~/.dsh/chathub-profile` 里 ChatGLM 已登录（页面直接进主界面、
composer 和历史对话都在），`/v1/models` 却四个站点全 `needs-auth`。因此网关**不会**
拿这个状态提前返回 401，而是照常放行，由 adapter 的 `transport.open()` /
`waitForInput()` 做真正的登录检查；真未登录时抛 `AUTH`，`failureFromError` 仍映射成
`401 chathub_signed_out`。改之前那句提前 401 会让已登录的 profile 永久不可用。

只有确认是「真未登录」时才需要扫码：`DSH_CHATHUB_LOGIN=true` 起一次，打开脚本打印的
`panel` URL 登录，登录态落在 `~/.dsh/chathub-profile`。这个开关直接给 `pnpm dsh web`
也生效（`chathub-host/cordis.patch.yml` 同时认 `DSH_CHATHUB_LOGIN=true` 和
`DSH_CHATHUB_HEADLESS=false`），不必非走脚本。

**工具名大小写：原来的坑，现在已改成默认。** 旧行为是 `allowTools.includes(tool.name)`
精确匹配，默认白名单 `read,grep,glob,edit,write`，而外部 agent（WorkBuddy 等）发来的
是 `Read/Write/Edit/Bash/Glob/Grep`，一个都匹配不上，站点看不到任何工具定义，`# TOOLS`
段于是渲染成 `(no tools are available in this session)`——这正是"列出子目录"被模型照抄
"我无法访问文件系统"拒绝的原因。当时的解法是命令行覆盖：

```bash
DSH_CHATHUB_LLM_TOOLS=Read,Write,Edit,Bash,Glob,Grep scripts/run-chathub-gateway.sh
```

2026-11-14 起这不再是需要记住的操作：白名单比对忽略大小写，默认名单
`read,grep,glob,edit,write,bash`，一份名单同时覆盖 `read` 式与 `Read` 式两种拼写，
不带任何参数就支持上面六个工具。被接受的调用保留调用方的拼写（执行器认那个名字），
`Bash` 的大小写也参与 `verify:` 是否可执行的判定。变量仍可传，但语义变成**收窄**；
写成 `Read,Write,...` 也不会坏，逗号前后空白会被裁掉。

即便如此，工具调用仍依赖站点模型自觉输出 `<<<TOOL_CALL … TOOL_CALL>>>` 文本协议，
`MALFORMED_RESPONSE`（502）就是它没遵守。

**SSE 与非 SSE 的限流差异。** 先说清楚在哪配：**这不是服务端开关**。同一个网关、
同一个端口，每个请求体里的 `"stream": true / false` 决定走哪条路径（`completions`
读 `parsed.stream`）；WorkBuddy 的自定义模型对话框没有这个开关，测试连接一般走
非流式、实际对话走流式，由客户端实现决定。服务端唯一相关的配置是 SSE 心跳间隔
`DSH_CHATHUB_GATEWAY_KEEPALIVE_MS`（默认 15000）和两种模式同样生效的 pacing。
手动验证时用 curl 指定：`-d '{"stream":true,...}'`（SSE）或不带 `stream`（非 SSE）。

两条路径共用同一个单站点准入队列
（`maxQueuePerSite`，超出 429）和同一套 pacing，但**承压方式不同**：

| | SSE（`stream:true`） | 非 SSE |
|---|---|---|
| 首字节 | 立刻 `200` + `: keepalive` | 轮次结束后才有 |
| pacing 阻塞期 | 每 `keepaliveMs`（15s）写一次心跳，连接不被判死 | 静默阻塞，客户端自己的超时先到 |
| 失败载体 | SSE `error` 事件 + `[DONE]` | HTTP 状态码 + JSON |
| 适合 | 长回答、外网/代理、WorkBuddy 这类会等很久的客户端 | 短问答、脚本 |

pacing 预设：`conservative` 20s/轮、40 轮/时、最多等 30s；`balanced` 10s/90/20s；
`responsive` 3s/240/10s；`off` 不限。需要的等待超过 `maxWaitMs` 就抛
`chathub-paced` → 网关 `429` + `retry-after: 30`。

所以先测 SSE：`DSH_CHATHUB_SMOKE=sse` + `responsive`，确认长回答不被卡；确认站点
不反弹再 `off`。非 SSE 只在短问答上用，且客户端超时必须大于
`pacing gap + 站点轮次超时`（`DSH_CHATHUB_TURN_TIMEOUT_MS`）。

### 2.8 源码 `--patch` 与 tgz 装 profile 的区别

| | 源码 + `--patch` | tgz 装进 dsh profile |
|---|---|---|
| 包来自 | 仓库 workspace 软链（`packages/experimental/...`） | `$DSH_HOME/profiles/<name>/node_modules` |
| 依赖解析 | monorepo 内齐全，不查 registry | pnpm 查 registry，缺一个就失败 |
| 生效方式 | `tsx` 直跑 TS，改 `src` 重启即生效 | 必须重新打包、重新安装 |
| 版本门 | 无（同一份仓库同一版本） | `engines.dsh` / dsh peer 版本预检，不匹配直接拒绝，要 `dsh plugin allow-version <pkg>@<ver> --dsh-version <ver> --accept-risk` |
| 路径写法 | `--patch packages/experimental/chathub-gateway/cordis.patch.yml` | 插件由 profile `package.json` 的 `dsh.profile.bundles` + 包内 `dsh.bundle.patch` 自动挂载，不再写 `--patch` |
| 适合 | 开发、调试、本机部署 | 分发给别人 |
| 现状 | ✅ 已验证 | ❌ 目前装不上 |

tgz 装不上不是脚本的问题，是**版本在 registry 上不存在**：

```
ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/@deepseek-ai%2Fdsh-llm: Not Found - 404
```

`pnpm pack` 把 `workspace:*` 改写成实际版本 `0.2.2-alpha.2`，而 registry 上
`@deepseek-ai/dsh-llm` 只有 `0.0.1-rc.1`，四个 `chathub*` 包则完全没发布过
（`npm view` 四个都 404）。所以 tgz 现在只能当**离线归档**，要真正可装必须整族按
`publish-order.txt` 发布后再 `dsh plugin --profile web add <包名>@0.2.2-alpha.2`。

## 3. 发布到 npm（可选）

定向打包只产出本地 tarball。正式发布走仓库的发布边界：

```bash
pnpm run release:verify   # 校验版本基线与发布顺序
pnpm run release:pack     # 整族打包（需要官方构建记录）
pnpm run release:publish  # 实际发布（需要凭据，通常由 CI 从 dsh-v* tag 触发）
```

`0.2.2-alpha.2` 是预发布版本，发布后落在 `alpha` dist-tag，不影响 `latest`。
这批实验包的互相依赖要求先发布被依赖者（见 `publish-order.txt`）；registry 上
尚未发布过这些包时，只能整族发布，不能单独先发 `chathub-host`。gateway 排在最后：
它的 peer 依赖 `chathub-host` 与 `llm-chathub`，两者没上 registry 之前它装不上。

## 4. 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| `EUNSUPPORTEDPROTOCOL ... workspace:~` | 在仓库内执行 npm，且遇到 pnpm `workspace:` 协议 | 就地装先在目录补 `package.json`（2.2）；或到仓库外执行（2.3） |
| `404 @deepseek-ai/dsh-experimental-client-ui-chathub` | pnpm 从 registry 解析子依赖 | 在 `pnpm-workspace.yaml` 加 `overrides`（2.4） |
| `Cannot find package '@deepseek-ai/dsh-llm'` | profile 内没有 harness peer | 用 2.5 源码方式，或发布后按版本安装 |
| tarball 缺少 `lib/index.js` | 打包前没跑 `build:artifacts` | 先跑 1.1 的脚本 |
| client 产物非官方档 | 未设置 `DSH_BUILD_CLIENT_PROFILE=official` | 用 1.1 脚本重建 |
| `packed version 0.1.0-alpha.1 != 0.2.2-alpha.2` | gateway 版本没跟随仓库基线 | 把 gateway 的 `version` 对齐到根 `package.json`（已对齐） |
| `EADDRINUSE 127.0.0.1:8787` | 端口被占（另一个 `dsh web` 还活着） | `scripts/run-chathub-gateway.sh` 会打印占用者 PID：在旧终端 Ctrl-C 或 `kill <pid>`；也可换 `DSH_CHATHUB_GATEWAY_PORT=8788 DSH_WEB_PORT=8898` |
| gateway 返回 401 `chathub_signed_out` | adapter 的 `transport.open()` 真检测到站点未登录（不是 `/v1/models` 的 `needs-auth` 标记） | `DSH_CHATHUB_LOGIN=true` 起可见浏览器，在 ChatHub 面板登录该站点 |
| `/v1/models` 全是 `needs-auth` 但 completion 正常返回 200 | 正常：健康探测不打开浏览器，profile 里其实已登录 | 不用处理；以真实一轮的结果为准，不要按目录状态提前判死 |
| gateway 返回 401 `invalid_api_key` | 设了 `DSH_CHATHUB_GATEWAY_KEY` 但请求没带同值 Bearer | `curl -H 'authorization: Bearer <key>'`，WorkBuddy 的 apiKey 填同值 |
| gateway 返回 404 `model_not_found` | 模型名不在目录里（例如填了 `ywf-web`） | 模型名必须等于站点 id；`GET /v1/models` 是唯一真值来源 |
| gateway 返回 400 `context_length_exceeded` | 客户端的 system prompt + 工具定义 + 本轮消息超过 `maxPromptChars`（默认 48000 字符，`llm-chathub/src/types.ts`）；`render.ts` 会丢最旧历史，任务本身超预算才抛 | 在 `llm-chathub/cordis.patch.yml` 的 `config` 下加 `maxPromptChars: 96000` 后重启；或关掉客户端的部分工具/精简 system prompt。别只调大不验证，站点输入框也有自己的长度上限 |
| 客户端显示「模型不可用」+ `404 No route: POST /chat/completions` | endpoint 填了根地址，客户端追加后缀却没补 `/v1` | 填 `http://127.0.0.1:8787/v1`；新版网关已兼容裸路径，但**要重启 dsh** 才加载新代码 |
| `/v1/models` 有行但 completion 报「未知 provider」 | `GATEWAY_SITES` 列了 `LLM_SITES` 没挂的站点 | 两个列表保持一致（脚本用一份 `DSH_CHATHUB_SITES` 同时写两层） |
| `/v1/models` 是空数组 | transport 没有任何 provider（host 没挂或 `sites` 全是拼错的 id） | 按 host → llm-chathub → gateway 顺序挂载；**没登录不会导致空数组**，行仍会在，只是 `status: needs-auth` |
