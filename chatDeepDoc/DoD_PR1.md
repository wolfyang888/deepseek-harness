
 可以，下面给你一份可直接作为 PR gate 的“Phase 1 完成判定清单（Definition of Done）”。 
 
 它以你当前时间线为前提： 
 
 runtime core 已经落地 
 provider adapters 已经存在 
 重点在“收口、稳定性、错误语义、完成验收” 
 我建议直接放进 PR 描述或 issue template，作为“Phase 1 完成条件”。 
 
 Phase 1 总体目标 
 Phase 1 的目标不是“多模型 UI 全面完成”，而是： 
 
 建立统一 provider runtime contract 
 让多 web provider 能按同一接口工作 
 能在 provider 切换时保留 task/objective/plan/facts 
 能检测 provider ready / health / offline / auth failure 
 让 adapter 与 runtime 成为稳定边界，便于后续扩展 
 PR Gate：Phase 1 完成判定清单 
 2.1 统一 Provider Contract 已定稿并落地 必须满足： 
 
 IModelProvider 统一接口稳定 
 init / isReady / sendMessage / streamMessage / close 
 允许 provider 带自定义错误映射 
 normalizeError?(error: unknown): ChatHubErrorCode | string 
 每个 adapter 必须实现该接口，并且遵守同一语义 
 发送链路和探测链路都经过统一错误处理 
 Adapter 能明确区分： 
 auth expired 
 site signed out 
 rate limit 
 network broken 
 provider unavailable 
 stream interrupted 
 unsupported capability 
 对外只暴露统一 error code，而不是原始站点 HTML / JS 片段 
 验收证据： 
 
 types.ts 中接口定义已存在 
 each provider implements adapter contract 
 probeProvider / sendMessage / streamMessage 都走统一 error path 
 no provider-specific raw errors leak through runtime 
 拒绝条件： 
 
 某个 adapter 直接抛原生错误并让 runtime 兜底处理 
 provider-specific error semantics 不统一 
 runtime 依赖 adapter 抛出不同字符串导致分支逻辑不可控 
 2.2 Provider Registry 能注册、查询、健康检查、状态展示 必须满足： 
 
 ProviderRegistry 支持： 
 register 
 get 
 list 
 getByKind 
 healthCheck 
 provider identity-safe dispose / cleanup 
 Registry 能按 provider id 稳定唯一解析 
 healthCheck 返回状态，不只是 boolean，而是结构化信息： 
 status 
 message 
 lastCheckedAt 
 failureReason 
 providerId 
 health status 可用于 UI 或 runtime fallback 
 验收证据： 
 
 registry 以 provider id 作为唯一 key 
 getByKind 能返回同 kind 下的 provider list 
 healthCheck 对每个 provider probe 
 status includes both “healthy” and “degraded” / “offline” etc 
 拒绝条件： 
 
 healthCheck 只是简单返回 true/false 
 registry 不可扩展，不允许新增 adapter 
 provider 状态信息不能用于 runtime fallback 
 2.3 SessionManager 能创建、更新、切换 provider，并保留语义状态 必须满足： 
 
 SessionManager 能： 
 create session 
 update session 
 getState 
 setStatus 
 switchProvider 
 build request context 
 switchProvider 行为必须按顺序： 
 检查目标 provider readiness 
 snapshot canonical checkpoint 
 compile target-provider context 
 commit model switch record 
 continue session 
 维护 canonical state，而不是纯 raw transcript 
 每次切换都保留： 
 objective 
 plan 
 facts 
 decisions 
 openQuestions 
 memoryHighlights 
 workingMemory 
 tool results 
 modelSwitchHistory 
 验收证据： 
 
 session-manager.spec.ts 中覆盖 model switch continuity 
 关键用例： 
 switch from DeepSeek to Gemini without dropping objective/plan/facts 
 switch while tool is running or stream is active 
 recover from provider unavailable 
 调用链路中能看到 checkpoint + compile + switch history 
 拒绝条件： 
 
 切换模型后只传 raw previous messages 
 只保留 messages，不保留 semantic context 
 switch 时未 snapshot，导致上下文丢失 
 2.4 Canonical Context Compiler 能生成 provider-specific prompt 必须满足： 
 
 SemanticContext 拥有统一结构 
 objective 
 plan 
 facts 
 decisions 
 openQuestions 
 workingMemory 
 lastToolResults 
 modelSwitchHistory 
 ContextCompiler 能把这些语义结构编译为目标 provider prompt 
 支持不同 provider 的 detail level： 
 full 
 compact 
 detailed 
 编译结果必须是“面向目标模型的提示词”，而不是单纯 raw transcript 无脑拼接 
 同一 session 在不同 provider 间切换，context 稳定 
 验收证据： 
 
 compile() 可输出 provider-specific prompt 
 必有 test 覆盖不同 provider 生成不同 detail level 
 对同一 semantic state，目标 provider prompt 结构稳定且可回放 
 拒绝条件： 
 
 compile 仅是 message 拼接，不做 semantic summarization 
 不区分 provider capability 
 provider-specific prompt 无法复现 
 2.5 Checkpoint / state continuity 已实现并用于切换前保存 必须满足： 
 
 CheckpointService.generate 可快照： 
 sessionId 
 objective 
 plan 
 facts 
 openQuestions 
 decisions 
 memoryHighlights 
 modelHistory 
 switchProvider 前必须先生成 checkpoint 
 checkpoint 可回放 
 session recovery / rehydration logic 可从 checkpoint 恢复状态 
 目标 provider 只拿“语义干净且稳定”的上下文，不依赖站点原始历史 
 验收证据： 
 
 checkpoint file/service exists 
 switchProvider calls checkpoint before compile 
 tests cover “switch preserves objective / plan / facts” 
 checkpoint versioning exists or at least a stable schema 
 拒绝条件： 
 
 checkpoint 没有写入或只写空快照 
 会话切换时根本无快照 
 model switch 后因缺失事实而造成 context drift 
 2.6 Provider Health and Auth Handling 必须满足： 
 
 provider ready check exists 
 signed-out / expired-auth / blocked-site behavior yields structured result 
 runtime knows whether provider is: 
 ready 
 degraded 
 offline 
 blocked 
 reauth-required 
 provider health state is surfaced to runtime and UI 
 when provider is not ready, session manager will not proceed blindly 
 验收证据： 
 
 healthStatus is part of provider registry result 
 auth-related failures produce structured error code 
 switchProvider checks provider health before continuing 
 拒绝条件： 
 
 未处理 provider 失效，直接调用 sendMessage 
 只有 UI 里显示 connect failed，runtime still operates 
 auth 状态不结构化，导致无法恢复 
 2.7 Error Standardization 必须满足： 
 
 所有 adapter 错误经过 normalizeError 映射 
 错误 code 一致： 
 AUTH_REQUIRED 
 PROVIDER_UNAVAILABLE 
 RATE_LIMITED 
 NETWORK_ERROR 
 STREAM_INTERRUPTED 
 UNSUPPORTED_CAPABILITY 
 UNKNOWN 
 runtime 对错误一致响应 
 调用方不再依赖“站点原始错误文本判断” 
 最终 user-facing message 统一生成 
 验收证据： 
 
 errors.ts / ChatHubError / ChatHubErrorCode 存在 
 provider adapter 使用 normalizeError 
 probeProvider / sendMessage / streamMessage 统一处理 error 
 拒绝条件： 
 
 provider-specific error string 繁杂且不可枚举 
 runtime 无标准 error code 
 错误恢复策略依赖 if (message.includes(...)) 这种硬编码 
 2.8 测试必须覆盖 P0 场景，且全部通过 必须满足： 
 
 关键测试项包括： 
 provider contract sweep 
 signed-out site behavior 
 mid-stream interruption preserving emitted deltas 
 model switch while tool-running preserves working context 
 DeepSeek → Gemini objective/plan/facts continuity 
 session manager provider switch 
 provider health / offline detection 
 error normalization 
 必须是自动化测试，且 CI 通过 
 覆盖率高于项目定义的最低门槛，至少达到 P0 目标的全部场景覆盖 
 验收证据： 
 
 test suite pass 
 关键用例 have names / docs 
 no hidden flaky tests 
 logs or artifacts reflect provider switch continuity 
 拒绝条件： 
 
 只有文档说明没有实际自动化测试 
 某些 adapter 分支无测试 
 仅测试“happy path”，不覆盖失败/恢复/切换 
 2.9 文档与代码一致 必须满足： 
 
 README / architecture docs / detail_design.md 与运行时代码一致 
 provider registry / session manager / context compiler / checkpoint / health status 的设计文档都是现状而不是过时方案 
 PR 描述清晰声明： 
 which runtime already landed 
 which phase this PR gates 
 what remains in P1 
 如果有 design doc update，必须同步 commit 
 验收证据： 
 
 doc-sync check pass 
 no stale design mention 
 definition of done documented in repo 
 拒绝条件： 
 
 文档描述“未来计划”，但代码已完全不同 
 PR 提交说明说“Phase 1 完成”，但 gate 还缺关键项 
 最终门槛：Phase 1 是否可以标记完成？ 
 可以标记为 Phase 1 成功完成的前提是，全部下列必须满足： 
 
 provider contract unified 
 registry works and exposes health 
 session manager implements switch continuity 
 context compiler compiles canonical context 
 checkpoint saved before provider switch 
 normalizeError implemented and standardized 
 provider auth / health errors handled structurally 
 P0 test suite passes 
 doc-sync pass 
 PR description explicitly says “Phase 1 complete” only after gate passes 
 Phase 1 完成后，下一步不做什么 在 Phase 1 结束后，不要做这些： 
 直接大规模扩充 provider 数量 
 大量 UI 试验性开发 
 重写 session runtime 
 把 ChatHub 作为主仓库继承 
 在未统一 error 与 health semantics 前做复杂 fallback 
 Phase 1 正确的下一阶段入口 Phase 1 完成后，进入 P1 的正确任务是： 
 adapter config uniformity 
 site-specific failure mapping 
 session timeline 
 re-login flow 
 provider status UI 
 robust retry / degrade fallback 
 long-session memory compaction 
 推荐的 PR 标题 
 建议写成： 
 
 Phase 1 runtime gate: provider contract, continuity, health, and error normalization 或 
 Phase 1 completion: unify provider runtime + model-switch continuity 
 一句话结论 
 这份 Phase 1 判定清单的核心思想是： 
 
 “如果 runtime 已经存在，Phase 1 的价值不是再做一轮从零设计，而是把 provider contract、context continuity、error semantics 和 health 状态收口到一个可以长期扩展的基础层上。”
