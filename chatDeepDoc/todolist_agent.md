# DeepSeek Harness 多 Agent 自动化 Todo 管理系统实施方案

你的目标实际上不是简单地安装一个 Todo 插件，而是建立一个 多 Agent 任务管理与自动执行系统（Multi-Agent Task Orchestration System）。

我建议采用：

- 1 个 Manager Agent（总管 Agent）：负责每日任务分析、拆分、分配、监督、验收和最终交付。
- N 个 Worker Agent（执行 Agent）：每个 Agent 独立负责一个任务，独立 Session，独立执行和汇报。
- 1 个共享 Task Board（任务看板）：所有 Agent 共享任务状态，但只有 Manager 有权决定最终状态。
- 1 套质量复核机制（QA）：检查 Worker 的交付物，决定通过、返工或阻塞。
- 1 套持久化机制：保证今天没完成的任务明天继续执行，而不是 Session 关闭后丢失。

我不建议让多个 Agent 直接修改同一份 Todo 列表。应该由 Manager 统一管理状态，Worker 通过任务报告提交结果。

## 一、推荐的整体架构

Manager Agent / 总管 Agent

每日任务分析 · 优先级 · 任务拆分 · Agent 调度 · 质量验收 · 最终交付

Task Dispatch

Worker A

研发任务

独立 Session

Worker B

调研任务

独立 Session

Worker C

测试任务

独立 Session

任务报告 / 执行事件

Shared Task Board

已完成

进行中

待复核 / 返工

阻塞 / 失败

SQLite 持久化 + 任务事件记录 + Manager 统一状态管理

QA / Manager 验收

检查证据 → 验收 → 返工 → 再验收 → 交付

这个设计利用 DeepSeek Harness 的 Cordis 插件体系。它本身支持 Agent、Session、工具注册、事件机制和子 Agent 扩展，不需要修改 Agent Loop 核心。

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub+1



## 二、应该安装哪些插件

我把插件分成三类：核心必装、增强推荐、暂时不装。

### 1. 核心必装

[dsh-dashboard — Workflow plugin for DeepSeek Harness | dshbase](https://images.openai.com/static-rsc-4/Q0ULyybt-XBCZnDby8OOCFrp0S-PWWhKQwTqtMut_ADGCIrG9NKoFJAssk86wv9qFi9wJyFLQsvcLt7mfOjlsCKcqLxmOj3BPgfERIaKA4boZX8pxm7N_UG22Z3YzZqsRcMLSc35XvQujWLDvxK934gpTlKStI0ovYw_WC2T_WU?purpose=inline)

① DSH-taskboard

首选任务管理插件

- SQLite 持久化任务
- 多项目、任务依赖、评论、附件
- 看板和工作流
- Agent 认领、执行、提交复核
- 支持 `in_review`、`blocked` 等状态

安装：`dsh plugin --profile web add @shengsheng/dsh-taskboard`

项目：[GitHub](https://github.com/shengsheng90/DSH-taskboard?utm_source=chatgpt.com)

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub+1

[dsh-agent-teams — 工作流与自动化 DeepSeek Harness 插件](https://images.openai.com/static-rsc-4/UY-sg8gfTHt-3qk9JYKEbPGcf7aSEiwhdW0_fPDdItoQEHYU8x0ONCiNEj6zm8HvOSr-60XK9oBNbHEW4Qusj_Kkrn2_R3fWphysPIHqbs8mF1zW4Ltb4nTLZMca7Qqw265oHfo7Mt9daS3zuPdjb5jWKg2CrWSEfpNFH2w0jzI?purpose=inline)

② 官方 `dsh-agent-team` + `dsh-tool-agent-team`

多 Agent 协作核心

- 一个 Root Agent 组织多个 Subagent
- 所有成员共享 Team Task Board
- 任务认领和所有权比较交换（CAS）
- Agent 之间可以发现和联系
- 多个 Agent 可以共用一个工作区

官方文档：[Agent Team](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/team/agent-team?utm_source=chatgpt.com)

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub+1

[DeepSeek Harness | Explore the limits of intelligence](https://images.openai.com/static-rsc-4/XcJoO_jlITHm8csmCOS5K9ceNBBVF4ONDTmaCcvS4BPsLCDJQnNICTJtpwDNWPh9hax6zcYEycxjSGeZM8s5dI-_wEEqm5ej7Vqv9nw3jizUeYlayYuK5IQcpeOOEJB5hGv7NaEWIDR1ZM7TJ0VFVwOXysxcpIrvjEdmcOvuzSM?purpose=inline)

③ `dsh-background-agents`

推荐增强

- 创建可持续运行的子 Agent
- 后台执行长任务
- Web UI 查看子 Agent 进度
- 可以向子 Agent 发送消息
- 支持中断和继续执行

项目：[GitHub](https://github.com/PerryLink/dsh-background-agents?utm_source=chatgpt.com)

[image](https://www.google.com/s2/favicons?domain=https://dsharness.org\&sz=32)

DSHarness+1

[dsh-dashboard — Workflow plugin for DeepSeek Harness | dshbase](https://images.openai.com/static-rsc-4/EltckXxzlS_dbovqVEX4yf3KYrdUyg0jHZpnv5mBsylKO-1qlEc6s1YWKdLIjwtfsoMomnWIqeya5Z1khaqtuHubsUH_uys3TTakBU4VUEkidAz2KIJP1DaJVE-gSVGa2_DWoj4-8HRbIyboGQU7tyDuMkMUpKD5rmrKb-ywc4g?purpose=inline)

④ `dsh-automation`

推荐增强

- 每天定时启动 Manager Session
- 每天早上生成任务计划
- 定时检查进行中的任务
- 每天下班前生成日报
- 失败后可以重新执行

安装：

```
dsh plugin --profile web add @alpacachen/dsh-automation
```

项目：[GitHub](https://github.com/alpacachen/dsh-automation?utm_source=chatgpt.com)

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub

### 2. 辅助插件

| 插件 / 能力                 | 作用                 | 推荐度 |
| ----------------------- | ------------------ | --- |
| `dsh-tool-todo`         | 单个 Session 内部的计划列表 | 可选  |
| `dsh-flowglass`         | 可视化 Agent 执行流程     | 推荐  |
| `dsh-context`           | 观察 Agent 上下文和执行情况  | 推荐  |
| `dsh-checkpoint-rewind` | 执行失败后回滚工作区         | 推荐  |
| `dsh-interconnect`      | 不同 DSH 实例之间传递消息    | 按需  |

注意：官方 `dsh-tool-todo` 的 Todo 是 Session 所有，不是共享任务板；不能拿它直接代替多 Agent 共享任务管理。

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub+1



### 3. 我的安装优先级

| 优先级 | 插件                    | 建议           |
| --- | --------------------- | ------------ |
| P0  | dsh-agent-team        | 必须           |
| P0  | DSH-taskboard         | 必须，作为持久化任务中心 |
| P1  | dsh-background-agents | 建议           |
| P1  | dsh-automation        | 建议           |
| P2  | dsh-flowglass         | 可选           |
| P2  | dsh-checkpoint-rewind | 可选           |

一个重要的架构区别： DSH-taskboard 当前的 Agent 工具允许 Worker 提交 `in_review`，但只有经过认证的人工 UI 或 CLI 操作才能将任务批准为 `done`。因此，如果你希望 Manager Agent 全自动验收，不能简单地把它的权限当成普通 Worker；需要增加一个受控的 Manager 验收接口，或者采用官方 Team Board 加自定义状态管理插件。

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub+1



## 三、任务状态设计：不能只有 Todo 的三个状态

建议把任务状态设计成完整的工作流。

## 任务生命周期

待规划 / 待执行

Backlog / Todo

已分配 / 进行中

Assigned / In Progress

待复核

In Review

验收通过 / 已完成

Done

异常分支

失败

Failed

阻塞

Blocked

返工

Rework

失败可以重新分配；阻塞需要解决前置条件；返工回到执行阶段。三者不能简单等同。

建议数据库采用以下字段：

| 字段                      | 用途              |
| ----------------------- | --------------- |
| task_id                 | 全局唯一任务编号        |
| title                   | 任务标题            |
| description             | 任务详细描述          |
| priority                | P0/P1/P2/P3     |
| status                  | 当前任务状态          |
| assignee                | 执行 Agent        |
| session_id              | 子 Agent Session |
| dependencies            | 前置任务            |
| acceptance_criteria     | 验收标准            |
| result                  | 执行结果            |
| evidence                | 日志、文件、测试结果      |
| blocker                 | 阻塞原因            |
| retry_count             | 返工/重试次数         |
| created_at / updated_at | 创建和更新时间         |
| due_at                  | 截止时间            |

另外，建议把执行状态和最终任务状态分开：

- `execution_result`：success / failed / blocked。
- `task_status`：todo / in_progress / in_review / done / blocked / rework。

例如：Worker 第一次执行失败，第二次执行成功，任务不应该一直停留在 Failed。

## 四、Manager Agent 的职责设计

Manager 是整个系统最重要的部分。

我建议把它设计成一个长期存在的 Root Session，而不是每天创建一个完全没有上下文的新 Agent。

它负责以下六个阶段。

### 阶段 1：每日任务分析

每天早上 08:30 启动每日规划：

1. 读取昨日未完成任务。
2. 读取今天新增任务。
3. 读取已经阻塞的任务。
4. 分析任务优先级。
5. 分析任务依赖关系。
6. 将复杂任务拆分成子任务。
7. 评估 Worker 数量和并发能力。
8. 生成今天的执行计划。

例如：

| 任务              | 优先级 | 执行 Agent    | 预计时间 |
| --------------- | --- | ----------- | ---- |
| UWB 定位算法优化      | P0  | Agent-UWB   | 3h   |
| RTSP 延迟优化       | P1  | Agent-Video | 2h   |
| SQLite WAL 问题分析 | P1  | Agent-DB    | 1h   |
| 技术方案文档          | P2  | Agent-Doc   | 1h   |

Manager 还需要判断任务是否能够并行。

例如，RTSP 和 SQLite 可以并行；如果两个任务需要修改同一个文件，就应该安排依赖顺序，或者明确文件所有权。

### 阶段 2：创建独立 Worker Session

Manager 根据任务类型创建子 Agent。

我建议先定义以下角色：

Research Agent

技术调研、资料搜索、方案比较

Developer Agent

代码开发、功能实现、Bug 修复

Test Agent

测试、验证、复现问题

Document Agent

技术文档、报告、整理输出

Review Agent

独立复核、代码审查、验收

不需要每天创建全部角色，而是按任务动态创建。

每个 Worker 应具备：

- 独立 Session ID。
- 独立任务目标。
- 明确的输入和输出。
- 对应的工具权限。
- 独立执行记录。
- 可恢复的执行上下文。

注意：独立 Session 不等于独立文件工作区。官方 Agent Team 文档明确说明，Team 成员默认共享一个 checkout，不自动创建独立工作目录。对代码开发任务，如果需要隔离，应另外配置 Git Worktree 或独立 Workspace。

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub+1



### 阶段 3：Worker 执行和汇报

Worker 不能仅仅回复一句「任务完成」。

必须返回结构化报告。

建议统一 JSON 格式：

```
{
  "task_id": "TASK-20261107-001",
  "agent_id": "Agent-UWB",
  "session_id": "session-123",
  "execution_status": "completed",
  "progress": 100,
  "summary": "完成UWB定位算法优化",
  "outputs": [
    "/workspace/uwb/algorithm.cpp",
    "/workspace/uwb/test_report.md"
  ],
  "verification": {
    "tested": true,
    "test_passed": true,
    "evidence": [
      "测试日志",
      "测试数据"
    ]
  },
  "blocker": null,
  "remaining_work": [],
  "next_action": "提交Manager验收"
}
```

五种执行汇报：

| Worker 汇报   | Manager 处理     |
| ----------- | -------------- |
| completed   | 进入待复核          |
| in_progress | 保持进行中          |
| failed      | 分析失败原因         |
| blocked     | 记录阻塞并协调        |
| partial     | 记录部分完成，继续执行或拆分 |

Worker 必须附带证据，尤其是代码修改、测试、文档交付等任务。

### 阶段 4：Manager 统一验收

这是系统和普通多 Agent 系统最大的区别。

Worker 完成不等于任务完成。

Manager 必须根据验收标准检查：

1. 交付物是否存在？
2. 是否符合原始任务要求？
3. 测试是否通过？
4. 是否有测试证据？
5. 是否存在未解决问题？
6. 是否影响其他任务？
7. 是否可以交付？

建议引入独立 Review Agent。

验收决策

验收通过

DONE

更新任务状态为已完成，记录验收证据。

部分不符合要求

REWORK

返回原 Worker 或重新分配，明确需要修复的项目。

缺少依赖或外部条件

BLOCKED

等待条件满足，不能伪装成已完成。

执行失败

FAILED

记录错误、重试次数和是否需要人工介入。

这里我建议建立一个自定义插件：

`dsh-manager-governance`

提供如下工具：

```
manager_plan_day()
manager_create_task()
manager_assign_task()
manager_get_task_reports()
manager_review_task()
manager_approve_delivery()
manager_request_rework()
manager_mark_blocked()
manager_daily_summary()
```

权限设计：

| 操作        | Manager | Worker | Review Agent |
| --------- | ------- | ------ | ------------ |
| 创建任务      | 是       | 否      | 否            |
| 认领任务      | 是       | 是      | 否            |
| 更新进度      | 是       | 是      | 否            |
| 提交完成报告    | 是       | 是      | 是            |
| 申请返工      | 是       | 否      | 是            |
| 最终批准 DONE | 是       | 否      | 否            |
| 修改其他任务    | 是       | 否      | 否            |

这样可以实现你希望的：总管 Agent 决定是否交付，而不是 Worker 自己宣布任务完成。

注意，Manager 的验收权限必须由插件在服务端进行身份和 Session 归属校验，不能只靠 System Prompt 声明。对于付款、删除数据、发布生产等高风险操作，仍然应保留人工审批。

### 阶段 5：任务状态更新和返工

建议采用事件驱动，不要让 Manager 每隔几秒轮询所有 Session。

例如：

```
Worker 完成任务
       |
       v
提交 Task Report
       |
       v
Taskboard 写入 in_review
       |
       v
触发 Manager 任务事件
       |
       v
Manager 获取报告和证据
       |
       v
Review Agent 独立检查
       |
       +---- PASS ------> Manager 批准 DONE
       |
       +---- REWORK ----> 重新分配 Worker
       |
       +---- BLOCKED ---> 等待外部条件
       |
       +---- FAILED ----> 失败记录 / 重试 / 人工处理
```

每次状态改变都应记录：

- 修改前状态。
- 修改后状态。
- 操作 Agent。
- 操作时间。
- 修改原因。
- 相关 Session。
- 验收或失败证据。

这样才能追踪某个任务为什么被返工、谁批准了交付、为什么被阻塞。

### 阶段 6：每日总结和次日规划

每天 18:00，Manager 生成日报。

建议包含：

| 指标   | 内容        |
| ---- | --------- |
| 今日新增 | 新增任务数量    |
| 已完成  | 通过验收的任务   |
| 进行中  | 尚未提交验收的任务 |
| 返工   | 验收不通过的任务  |
| 阻塞   | 等待外部条件的任务 |
| 失败   | 执行失败的任务   |
| 延期   | 超出计划时间的任务 |

同时生成第二天的任务计划。

## 五、DeepSeek Harness 具体实施方式

建议采用三个层次实施，不要一开始就开发大量插件。

### 第一层：安装基础插件

先检查当前环境：

```
dsh --version
node -v
pnpm -v
dsh --profile web --dump-config
```

安装 Taskboard：

```
dsh plugin --profile web add -w @shengsheng/dsh-taskboard
```

Taskboard 官方项目要求 Node.js 22.19+ 或 24+，推荐 Node 24。安装后应检查 Profile 组成并重启 Harness。

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub



### 第二层：启用官方 Agent Team

官方有两套相关包：

```
@deepseek-ai/dsh-agent-team
@deepseek-ai/dsh-tool-agent-team
```

它们分别提供共享任务服务和 Agent 可使用的任务工具。

在已有 `dsh-base`、持久化 Session 和可持续子 Agent 能力的组合上，加入：

```
- name: '@deepseek-ai/dsh-agent-team'
  config:
    defaultEnabled: true

- name: '@deepseek-ai/dsh-tool-agent-team'
```

这只是 Team 插件的配置片段，实际应合并到你当前 Profile 的插件组合中，而不是直接覆盖现有配置。

启动后，在 Root Session 的 Model / Reasoning 菜单中确认启用 Agent Teams。官方标准配置默认关闭 Team 模式。

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub



这里有一个架构选择：

我建议第一版以 DSH-taskboard 为唯一任务状态权威，官方 Agent Team 用于 Agent 协作、任务认领和消息通信时，要做好两套任务板的映射，避免重复维护。

如果不需要双任务板，第一版可以先用 Harness 原生 Subagent + Taskboard，不必同时启用 Team Board。

### 第三层：开发 Manager Governance 插件

这是最关键的定制部分。

建议项目目录：

```
dsh-manager-governance/
├── package.json
├── cordis.patch.yml
├── src/
│   ├── index.ts
│   ├── manager.ts
│   ├── planner.ts
│   ├── dispatcher.ts
│   ├── report-handler.ts
│   ├── review-engine.ts
│   ├── status-machine.ts
│   ├── scheduler.ts
│   └── permission.ts
├── prompts/
│   ├── manager.md
│   ├── worker.md
│   └── reviewer.md
├── schemas/
│   ├── task.schema.json
│   └── report.schema.json
└── tests/
    ├── planner.test.ts
    ├── workflow.test.ts
    ├── permission.test.ts
    └── recovery.test.ts
```

建议职责：

| 模块                | 功能                  |
| ----------------- | ------------------- |
| manager.ts        | 总管 Agent 协调         |
| planner.ts        | 每日任务分析和拆分           |
| dispatcher.ts     | 创建子 Agent、分配任务      |
| report-handler.ts | 接收 Worker 报告        |
| review-engine.ts  | 质量验收                |
| status-machine.ts | 状态转换和权限检查           |
| scheduler.ts      | 定时启动及日报             |
| permission.ts     | Manager/Worker 权限隔离 |

开发时应优先使用 Harness 官方的插件扩展接口：

- `ctx.agents`：Agent 注册、管理和子 Agent 能力。
- `ctx.sessions`：持久化 Session 事件。
- `ctx.tools`：注册 Manager 和 Worker 工具。
- `agent/*`：监听 Agent 执行过程。
- `session/event`：处理持久化事件。

不要直接修改 Agent Loop 源码。Harness 的架构文档明确提供了这些扩展点。

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub+1



### 一个重要的调度建议

每日启动和后台持续执行应分开：

| 机制             | 作用                 |
| -------------- | ------------------ |
| 每日定时任务         | 启动 Manager，分析今天的任务 |
| Worker Session | 独立执行任务             |
| Session 事件     | 记录状态变化和执行结果        |
| 任务事件处理器        | 接收报告，通知 Manager    |
| 定期检查           | 恢复异常任务、发现超时任务      |
| 每日总结任务         | 汇总结果并生成日报          |

关于定时插件，有一个需要特别纠正的地方：之前列出的 `dsh-automation` 项目已于 2026-10-28 归档，作者也明确建议新用户优先使用 DSH 官方 Schedule / scheduled-task 功能。因此我不建议现在新装它。

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub



官方定时功能可以先用来安排每日 Manager 启动和日报，Harness 需要保持运行才能执行无人值守的计划任务。

## 六、Manager Agent 和 Worker Agent 的核心 Prompt

这部分非常重要。建议把它们分别保存为独立 Prompt 文件，后续再封装为 Agent Preset。

### 1. Manager Agent

`prompts/manager.md`

```
# Role: Daily Task Manager

你是系统的总管 Agent，负责管理每日任务和所有 Worker Agent。

## 核心职责

1. 每天读取全部待执行任务。
2. 分析任务优先级、依赖关系和预计工作量。
3. 将复杂任务拆分成可以独立执行的子任务。
4. 为每个子任务创建独立 Worker Session。
5. 监控所有 Worker 的执行进度。
6. 接收并检查 Worker 的任务报告。
7. 必要时创建独立 Review Agent。
8. 决定任务是否通过验收。
9. 更新任务状态。
10. 生成每日总结。

## 任务管理规则

- 每个任务必须有唯一 task_id。
- 每个 Worker 必须有明确的任务边界。
- Worker 不得自行批准最终交付。
- Worker 完成后必须提交证据。
- 未通过验收的任务必须进入返工。
- 存在外部依赖的任务必须标记阻塞。
- 失败任务必须记录失败原因。
- 不允许将没有验证的任务标记为 DONE。

## 交付验收

必须检查：
- 交付物是否存在。
- 是否满足验收标准。
- 是否有可验证证据。
- 是否存在遗留问题。
- 是否可以交付。

只有通过验收后才能调用
manager_approve_delivery。

## 最终目标

保证所有任务都有明确状态，
所有 Worker 都有可追踪的执行记录，
所有交付都有验收依据。
```

### 2. Worker Agent

`prompts/worker.md`

```
# Role: Worker Agent

你是一个独立执行任务的 Agent。

## 工作要求

1. 只处理 Manager 分配的任务。
2. 先理解任务目标和验收标准。
3. 发现任务缺少必要信息时主动询问。
4. 按照任务要求执行。
5. 定期更新任务进度。
6. 遇到无法解决的问题立即报告阻塞。
7. 执行失败时提供错误和日志。
8. 完成后提交交付物和测试证据。

## 禁止行为

- 不允许自行修改其他任务。
- 不允许自行批准交付。
- 不允许隐瞒执行失败。
- 不允许没有证据就宣称完成。
- 不允许覆盖其他 Worker 的工作成果。

## 最终报告

必须提供：
task_id
execution_status
progress
summary
outputs
verification
blocker
remaining_work
next_action
```

### 3. Review Agent

```
# Role: Independent Reviewer

你是独立质量复核 Agent。

你不负责实现任务，只负责判断交付物是否符合要求。

检查：
1. 任务目标是否实现。
2. 验收标准是否满足。
3. 测试是否真实执行。
4. 测试结果是否可信。
5. 是否有遗漏和潜在风险。

返回：
PASS / REWORK / BLOCKED

每个结论必须提供证据和原因。

不得直接批准最终交付。
最终批准权属于 Manager。
```

## 七、推荐的最终部署架构

结合你的需求，我建议最终采用下面这个架构：

## Daily Agent Operating System

Manager Agent

Root Session

规划、调度、监督、复核、交付、日报

Planner

每日计划、任务拆分

Dispatcher

创建 Session、分配任务

Report Handler

执行报告、事件处理

Review Engine

验收、返工、批准

Worker Agent Pool

Research

Developer

Tester

Reviewer

Document

Custom

Task Management Layer

DSH Taskboard

SQLite、任务看板、状态

Session Store

Session、执行历史、事件

Governance

权限、验收、状态机

Scheduler

每日调度、超时检查

每日交付报告

完成任务 · 未完成任务 · 失败 · 阻塞 · 返工 · 明日计划

## 八、分四期实施

| 阶段  | 开发内容                         | 验收目标      |
| --- | ---------------------------- | --------- |
| 第一期 | Taskboard + Manager + Worker | 可以拆分和执行任务 |
| 第二期 | 报告机制 + 状态机                   | 所有任务状态可追踪 |
| 第三期 | Review Agent + Manager 验收    | 实现自动复核和返工 |
| 第四期 | 定时调度 + 日报 + 异常恢复             | 每天自动运行    |

建议第一期先实现 3 个 Worker 并发，不要一开始就创建十几个 Agent。先验证任务分配、Session 生命周期、状态一致性和失败恢复。

## 九、必须注意的五个技术问题

1. Session 持久化：Harness 重启后能够恢复任务和子 Agent 的执行上下文。
2. 任务状态一致性：使用 SQLite 事务、版本号和 CAS，防止多个 Agent 同时覆盖任务状态。
3. 并发控制：限制同时运行的 Worker 数量，代码任务使用独立 Git Worktree。
4. 失败恢复：Worker 超时、进程退出、模型调用失败时，任务不能永久停留在进行中。
5. 交付权限：Worker 只能提交，Manager 才能验收。关键外部操作保留人工审批。

还有一点：Agent Team 的共享任务板和 DSH-taskboard 是两套不同的任务存储。建议只指定一个为最终任务状态权威，避免两个看板出现状态不一致。

## 十、我最终建议的技术选型

# 推荐组合

DeepSeek Harness

运行平台

| 能力       | 选择               |
| -------- | ---------------- |
| 总管 Agent | Root Session     |
| 子 Agent  | Harness Subagent |
| 持久化任务板   | DSH-taskboard    |
| Agent 协作 | Harness 原生消息机制   |
| 并发任务认领   | Agent Team（可选）   |
| 自动验收     | 自定义 Governance   |
| 任务数据库    | SQLite           |
| 后台定时     | DSH 官方 Schedule  |
| 代码隔离     | Git Worktree     |
| 任务汇报     | JSON Report      |
| 质量检查     | Review Agent     |

推荐：先实现核心闭环，再增加自动调度。

我的判断： 你的核心需求不应该依赖某一个现成插件全部实现。现有插件能够提供任务板、Agent 协作和 Session 管理，但 Manager 的决策权、验收状态机、报告协议和异常恢复，最好通过一个专门的 `dsh-manager-governance` 插件统一实现。

这样后续无论增加代码开发 Agent、技术调研 Agent、文档 Agent，还是接入其他模型，都不需要重新设计整个任务管理体系。

下一步最值得做的是直接实现第一版 `dsh-manager-governance`：包含 Cordis 插件骨架、任务状态机、Manager/Worker/Reviewer 三种角色、Session 调度接口和 SQLite 任务报告协议。