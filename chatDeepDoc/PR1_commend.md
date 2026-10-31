基于 chatDeepDoc/detail_design.md 的设计要求，我对 ChatHub Phase 1 实现提交的审查结论是：

结论：该提交大体完成了 design doc 中 Phase 1 的核心目标，且实现方向基本正确；但还没有完全达到“按 detail_design.md 可直接交付”的标准，主要差在协议层、状态语义和重试/降级正确性上。

一、与设计文档的符合度

总体上，commit 已经覆盖了 detail_design.md 里最关键的几部分：

统一 provider abstraction

设计要求：provider registry + web provider base + browser transport seam
实现位置：packages/experimental/chathub/src/provider-registry.ts、src/providers/web-provider.ts、src/providers/adapters.ts
结论：对齐度高
多模型切换与 context continuity

设计要求：checkpoint + semantic context + model switch history
实现位置：src/checkpoint.ts、src/session-manager.ts、src/types.ts
结论：对齐度高
model routing / fallback

设计要求：router selects provider by task type and managed fallbacks
实现位置：src/model-router.ts
结论：整体方向对，但细节还不够稳
login / readiness / recovery

设计要求：needs-auth / expired / failed semantics
实现位置：src/provider-registry.ts、src/providers/web-provider.ts
结论：对齐度较高，属于本次提交最成功的部分之一
session memory and compaction

设计要求：objective/plan/facts/openQuestions/workingMemory
实现位置：src/session-memory.ts
结论：方向正确，但 compaction 逻辑还需要更严格的契约保护
所以，如果按 detail_design.md 的“最小可运行版本”来衡量，该提交基本是在做 Phase 1 的正确实现，而不是走偏路线。

二、与 design doc 的关键偏差

设计文档中的接口规范没有被完全保留 detail_design.md 里有一段“最小改动接口规范”，重点要求：
IProviderRegistry 基础契约应该稳定
IModelProvider 的能力/状态应该抽象
provider health / auth state 应该在 registry 层暴露
但在该提交中：

IProviderRegistry 仍然只定义了 register/get/list/getByKind
但实现里已经出现了 health() 和 reauthenticate()，并把它们当作正式能力使用
这意味着：

设计层和实现层有“接口契约不一致”
代码能跑，但扩展性和类型一致性不完整
这点是最明显的“设计与实现脱节”之一。

Retry semantics 还没有完全满足设计层的失败恢复语义 detail_design.md 的状态恢复流程里，失败恢复是：
provider not ready
prompt login / browser auth
refresh session
fallback provider
而提交里的 ModelRouter.complete() 里重试逻辑是：

在单一 provider 上按 RetryPolicy 重试
然后 fallback
但关键问题在于：

retryable() 只根据 ChatHubError.code 判断
实际很多失败是被 normalizeError() 转成 ProviderErrorCode，再被转换为 ChatHubErrorCode
这会导致“重试策略依赖异常封装层，而不是真实 failure 分类”
在设计 doc 里，failure classification 是很重要的概念；当前实现做得不够稳，因为它是“封装后行为驱动”，而不是“稳定错误语义驱动”。

usedFallback 判断过于弱 detail_design.md 强调的是“provider switch 与 fallback 语义清晰”。但该提交的 usedFallback 计算更偏“猜测式”而非“真实状态式”。
当前逻辑：

candidate.fallback || attempts.some(item => item.providerId !== provider.id)
这个判断不能准确表达：

是否真的发生了 fallback
是否只是单 provider 内重试
是否同 provider 多次失败但最终成功
是否在不同 candidate 间切换过
这会影响 host UI 和 session 语义，尤其在复杂恢复场景里，容易产生误判。

timeline 与 compaction 是增强功能，但尚未完全成为设计文档的正式契约 detail_design.md 并没有将 timeline 作为强约束设计的一部分；它只讨论了：
session memory
checkpoint
context continuity
而新提交加入的 timeline + compaction 是合理增强，但这两者还缺乏设计层的收口：

SessionTimelineService 作为事件日志是否属于 runtime canonical state？
memory compaction 是否会影响 checkpoint fidelity？
compact() 是否应该保留 fact / decision / openQuestion 之外所有内容？
这些是正确的工程方向，不过目前还偏“实现型增强”，而不完全是“design doc 融合后的正式规范”。

三、我对这次提交的最终判断

如果按 chatDeepDoc/detail_design.md 背后的原始设计目标判断：

目标 1：可接入网页端 AI 模型：已实现
目标 2：切换模型不丢上下文：已实现到位
目标 3：无需 API key / token：已实现到位
目标 4：保持最小代码改动，扩展性强：大体达成
所以“方向正确，功能自洽，接近设计目标”这个评价是成立的。

但如果按“detail_design.md 中真正的 contract level 设计来验收”：

还不算完全通过
关键原因是类型契约与失败恢复语义没有完全固化
所以我会给出一个更准确的结论：

评语：基本达成 Phase 1 设计目标，且代码方向正确
结论：不建议直接把它当作最终稳定版合并
理由：协议层和重试/降级语义还需要再收口一轮
四、下一步开发规划（按 design doc 方式落地）

建议按这个顺序推进，不要再继续堆功能：

第一阶段：收口接口契约
在 IProviderRegistry 中补上 health() 与 reauthenticate()
明确 ProviderHealth / RetryPolicy / timeline 的 runtime contract
让设计文档和实现接口保持一一对应
第二阶段：修正 retry / fallback 真正语义
让重试从“异常代码匹配”升级为“稳定 failure code + cause 解析”
明确 single-provider retry 与 candidate fallback 的区分
保证 usedFallback 语义稳定，不依赖猜测
第三阶段：强化设计 doc 中要求的关键测试
provider not ready -> login flow
provider expired -> reauth flow
retry on transient failure
no retry on non-transient failure
memory compaction preserves facts / decisions / blockers
provider switch keeps objective + model history + working memory
第四阶段：host/UI 层接入
接上 provider health status UI
显示 re-login state
显示 timeline / switch history
提示 memory compaction/pressure warnings
五、最终一句话

如果说“该提交是按 detail_design.md 的总体思路在写代码”，那这个判断是对的；如果说“它已经彻底满足 detail_design.md 的设计标准”，那我不认为成立。它已经完成了大部分核心路线，但还差一轮协议收口和语义稳定化，才真正能称为“设计文档中的 Phase 1 完成版”