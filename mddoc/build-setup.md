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

五个包在源码仓库里就是 workspace 成员，直接带着 patch 启动即可，无需 npm 安装：

```bash
cd /home/ywf/work/code/github/deepseek-harness
pnpm dsh web \
  --patch packages/experimental/chathub-host/cordis.patch.yml \
  --patch packages/experimental/llm-chathub/cordis.patch.yml
```

启动后：

1. 在 ChatHub 面板 `providers` 里登录目标站点，状态变为 `ready`；
2. `pnpm dsh web --dump-config | grep -E "chathub-host|ui-chathub|llm-chathub"` 应能看到三行；
3. 选 `<site>-chathub` 路由（默认 `deepseek-web-chathub`，设 `DSH_CHATHUB_LLM_SITE=glm-web` 则为 `glm-web-chathub`）跑一个只读任务（例如「读 package.json 并说出包名」），`chathub-llm/turn` 事件出现即链路通。

常用环境变量：`DSH_CHATHUB_LLM_SITE`、`DSH_CHATHUB_LLM_SITES`、`DSH_CHATHUB_LLM_TOOLS`、
`DSH_CHATHUB_LLM_ROOT`、`DSH_CHATHUB_PROXY`（详见两个 patch 文件头部注释）。

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

**Trae / WorkBuddy**：设置 → 模型 → 添加自定义模型 → OpenAI Compatible，Base URL
`http://127.0.0.1:8787/v1`，API Key 同上，模型从列表选或手填 `glm-web`。

**Claude Code**：需要 Anthropic 线协议（`/v1/messages`），当前版本未实现，先别配
`ANTHROPIC_BASE_URL`。

安全边界：默认只绑回环；`apiKey` 为空时任何本机进程都能用这批模型，绑到非回环地址
却又不设 key 是不受保护的错误配置；网关本身不落 cookie/token，站点登录态仍在
`chathub-host` 的浏览器 profile 里。

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
| `EADDRINUSE 127.0.0.1:8787` | 端口被占（另一个 dsh web 还在跑） | `DSH_CHATHUB_GATEWAY_PORT=8788` 或停掉旧实例 |
| gateway 返回 401 `chathub_signed_out` | 站点未登录 | 在 ChatHub 面板登录该站点，`/v1/models` 里状态变 `ready` |
| gateway 返回 404 `model_not_found` | 该站点没被 llm-chathub 挂载 | 设 `DSH_CHATHUB_LLM_SITE` / `DSH_CHATHUB_LLM_SITES`，或从 `DSH_CHATHUB_GATEWAY_SITES` 里去掉 |
| `/v1/models` 是空数组 | 三个 patch 的挂载顺序不对，或没有站点登录 | 按 host → llm-chathub → gateway 顺序挂载，并先登录站点 |
