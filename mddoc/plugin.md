# 跨语言插件（Lua / Python 等）支持设计

## 现状判断

- Cordis Loader 只加载 ESM JavaScript 入口：bundle 行与 patch 行最终都解析为 `import()` 一个 npm 包的默认导出类（见 docs/cordis-primer.md）。Lua / Python 源码无法被直接挂载为原生插件。
- 仓库已有两个跨语言接缝，不需要改 Host 即可使用：
  1. MCP 外部工具（packages/mcp）：任何语言写的 MCP server 都能以工具形式接入，Python 可直接用 FastMCP；
  2. shell / subprocess 工具：外语程序作为命令被调用。
- 若要"一等公民"的外语插件（可注册工具、提供 Remote 服务、拥有自己的 Config 与生命周期），需要实现下述接口：一个薄的 JS 适配插件 + 一个语言无关的子进程线协议。

## 接口一：JS 适配插件（Host 侧，必实现）

外语插件以 npm 包形式发布，包内 JS 适配层负责生命周期与协议桥。

```ts
export default class PythonPluginRunner {
  /** 声明式配置：misconfiguration fails loud at load（schemastery 校验）。 */
  static Config: z<{
    runtime: string          // 解释器命令，如 python3 / lua5.4
    script: string           // 外语入口文件（相对插件包根）
    args: string[]           // 附加解释器参数
    startupTimeoutMs: number // initialize 握手超时
    restartOnCrash: boolean  // 崩溃后是否自动重启
  }>

  // 生命周期（Cordis 约定：一切注册经 ctx.effect()，register 返回 disposer）
  start(ctx: Context): Promise<void>      // spawn 子进程 + initialize 握手 + 协议版本校验
  dispose(): Promise<void>                // 优雅关闭（shutdown 请求 → 超时 kill）

  // 能力注册：把外语侧声明的工具/服务转接进 Cordis
  registerTools(ctx: Context): void       // 经 initialize 的 capabilities 拿到工具清单
}
```

要点：
- 子进程边界必须做 JSON 运行时校验（wire 边界规则），内部类型信任 TS。
- 外语工具进入正常工具注册表后自动获得"模型可见 ⟺ 已记录"的会话日志保障；适配层不得绕过工具注册直连模型。

## 接口二：线协议（stdio，语言无关）

传输：子进程 stdio，一行一个 JSON（NDJSON）。消息只有四类：

```jsonc
// 1. 握手：宿主 → 外语侧；外语侧回 capabilities
{ "type": "initialize", "protocolVersion": 1 }
{ "type": "ready", "protocolVersion": 1, "tools": [{ "name": "sentiment", "schema": { ... } }] }

// 2. 调用：宿主 → 外语侧；外语侧回结果或错误
{ "type": "invoke", "id": "1", "method": "tools/call", "params": { "name": "sentiment", "arguments": { ... } } }
{ "type": "result", "id": "1", "payload": { ... } }          // 单次结果
{ "type": "chunk",  "id": "1", "payload": { ... } }          // 流式片段（可多次）
{ "type": "error",  "id": "1", "code": "TOOL_FAILED", "message": "..." }

// 3. 取消：宿主 → 外语侧，桥接 AbortSignal
{ "type": "cancel", "id": "1" }

// 4. 关闭：宿主 → 外语侧；外语侧确认后退出
{ "type": "shutdown" }
{ "type": "bye" }
```

约定：`id` 由宿主分配且单调；外语侧必须在收到 `cancel` 后停止工作但仍须回一次 `error`（code `CANCELLED`）；协议版本不匹配在握手时 fail loud。

## 接口三：外语侧宿主库（每种语言一个，可选实现）

以 Python 为例（Lua 同构，任何能读写 stdio 的运行时皆可）：

```python
def initialize(protocol_version: int) -> list[Tool]            # 返回工具清单
def invoke(method: str, params: dict, cancelled: Callable[[], bool]) -> Iterator[dict]
def cancel(request_id: str) -> None
def shutdown() -> None
```

主循环：逐行读 stdin → 分发到上述函数 → 写 stdout。Python 参考实现用 asyncio；Lua 可用同步阻塞 + 协程。

## 落地路径建议

1. **优先复用 MCP**（零 Host 改动）：Python 用 FastMCP 写 MCP server，cordis.yml 的 mcp 配置接入；Lua 无现成 MCP SDK 时按上面线协议做桥。
2. **需要深度集成**（自有 Config、Remote 服务、UI 卡片）时，按接口一 + 二实现适配插件；参考 packages/subprocess 的进程管理与崩溃语义、docs/cookbook/adding-a-tool.md 的工具注册。
3. 外语插件包同样走 `dsh plugin add` 安装与版本兼容审批（apps/cli/src/plugin.ts），即"插件包是 npm 包、实现语言不限"。
