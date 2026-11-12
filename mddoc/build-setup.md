# Chathub 插件打包与安装指南

覆盖 `packages/experimental/` 下的四个 chathub 插件：

| 包 | npm 名 | 说明 |
|---|---|---|
| chathub | `@deepseek-ai/dsh-experimental-chathub` | 多模型会话运行时 |
| client-ui-chathub | `@deepseek-ai/dsh-experimental-client-ui-chathub` | 浏览器侧边栏面板 |
| chathub-host | `@deepseek-ai/dsh-experimental-chathub-host` | 宿主浏览器运行时与 Remote |
| llm-chathub | `@deepseek-ai/dsh-experimental-llm-chathub` | 网页模型 LLM 适配器 |

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

2. 定向打包四个包（保持依赖顺序）：

   ```bash
   pnpm pack --recursive --workspace-concurrency=1 \
     --filter=@deepseek-ai/dsh-experimental-chathub \
     --filter=@deepseek-ai/dsh-experimental-client-ui-chathub \
     --filter=@deepseek-ai/dsh-experimental-chathub-host \
     --filter=@deepseek-ai/dsh-experimental-llm-chathub \
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
  publish-order.txt
```

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
  deepseek-ai-dsh-experimental-client-ui-chathub-0.2.2-alpha.2.tgz
```

实测安装成功（20 个包），四个包可解析：

```bash
node -e "console.log(require.resolve('@deepseek-ai/dsh-experimental-llm-chathub'))"
# .../dist/npm-chathub/node_modules/@deepseek-ai/dsh-experimental-llm-chathub/lib/index.js
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
  /home/ywf/work/code/github/deepseek-harness/dist/npm-chathub/deepseek-ai-dsh-experimental-llm-chathub-0.2.2-alpha.2.tgz
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
    "@deepseek-ai/dsh-experimental-llm-chathub": "file:/ABS/dist/npm-chathub/deepseek-ai-dsh-experimental-llm-chathub-0.2.2-alpha.2.tgz"
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

四个包在源码仓库里就是 workspace 成员，直接带着 patch 启动即可，无需 npm 安装：

```bash
cd /home/ywf/work/code/github/deepseek-harness
pnpm dsh web \
  --patch packages/experimental/chathub-host/cordis.patch.yml \
  --patch packages/experimental/llm-chathub/cordis.patch.yml
```

启动后：

1. 在 ChatHub 面板 `providers` 里登录目标站点，状态变为 `ready`；
2. `pnpm dsh web --dump-config --dump-config-schema | grep chathub` 应能看到
   `chathub-host`、`ui-chathub`、`llm-chathub` 三行；
3. 选 `deepseek-web-chathub` 路由跑一个只读任务（例如「读 package.json 并说出包名」），
   `chathub-llm/turn` 事件出现即链路通。

常用环境变量：`DSH_CHATHUB_LLM_SITE`、`DSH_CHATHUB_LLM_TOOLS`、
`DSH_CHATHUB_LLM_ROOT`、`DSH_CHATHUB_PROXY`（详见两个 patch 文件头部注释）。

## 3. 发布到 npm（可选）

定向打包只产出本地 tarball。正式发布走仓库的发布边界：

```bash
pnpm run release:verify   # 校验版本基线与发布顺序
pnpm run release:pack     # 整族打包（需要官方构建记录）
pnpm run release:publish  # 实际发布（需要凭据，通常由 CI 从 dsh-v* tag 触发）
```

`0.2.2-alpha.2` 是预发布版本，发布后落在 `alpha` dist-tag，不影响 `latest`。
这批实验包的互相依赖要求先发布被依赖者（见 `publish-order.txt`）；registry 上
尚未发布过这些包时，只能整族发布，不能单独先发 `chathub-host`。

## 4. 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| `EUNSUPPORTEDPROTOCOL ... workspace:~` | 在仓库内执行 npm，且遇到 pnpm `workspace:` 协议 | 就地装先在目录补 `package.json`（2.2）；或到仓库外执行（2.3） |
| `404 @deepseek-ai/dsh-experimental-client-ui-chathub` | pnpm 从 registry 解析子依赖 | 在 `pnpm-workspace.yaml` 加 `overrides`（2.4） |
| `Cannot find package '@deepseek-ai/dsh-llm'` | profile 内没有 harness peer | 用 2.5 源码方式，或发布后按版本安装 |
| tarball 缺少 `lib/index.js` | 打包前没跑 `build:artifacts` | 先跑 1.1 的脚本 |
| client 产物非官方档 | 未设置 `DSH_BUILD_CLIENT_PROFILE=official` | 用 1.1 脚本重建 |
