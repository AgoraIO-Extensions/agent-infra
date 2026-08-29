# agent-infra AI 主导开发工作流 Spec

## 1. 文档目的

本文定义 agent-infra 的开发流转、AI Agent 分工、人工检查点、信任边界和自动化恢复规则。
它适用于产品、架构、代码、测试、迁移和 CI 变更，不改变 Agent 平台 M1 的产品范围或运行时
架构。

本文同时定义目标契约和分阶段实施顺序。只有已经合并到默认分支、完成仓库验证并通过真实
GitHub 冒烟的能力，才视为仓库当前能力；标记为配置前置或后续 Stage 的条款不能被描述为
已经上线。

## 2. 基本原则

- 所有开发工作严格按 `Issue -> 实现与验证 -> PR` 执行，并通过一个 primary Issue、一个实现
  PR 完成追踪。不得先创建任务分支、修改文件、提交代码或创建 PR，再补建 Issue。
- AI 负责需求梳理、实现、自检和独立评审；人负责确认授权、必要的真实测试和最终批准。
- GitHub Issue、PR、Check Run、Review、事件时间线和分支保护是流程状态的权威来源。
- 确定性检查优先于模型判断。AI 不能覆盖 CI、人工批准或分支保护结果。
- 所有门禁和确认都绑定明确的 Issue cycle 或 PR head SHA，不能跨版本复用。
- 自动化失败必须有限重试、明确终止或转人工处理，不能静默成功或形成无上界循环。
- 所有人和 AI 创建的 PR 使用相同的合并门禁；Worker 专属检查可以对人工 PR 返回明确的
  `not_applicable`，不能降低通用门禁。
- 仓库只建设本仓库所需的有界 Issue 依赖图、状态决策函数和幂等 Reconciler，不建设通用
  Loop Engine、Graph Engine 或开发调度平台。

### 2.1 Matt Skill 交付路径

默认交付路径是 `triage -> implement`。只有需求需要形成并确认独立 Spec 时才在中间加入
`to-spec`；只有工作无法在一个 fresh context 内完成，或需要多个可独立交付的 vertical slice 时
才继续使用 `to-tickets`。这些阶段是可选的工作量升级，不是每个 Issue 的固定仪式。

`triage` 交给实现阶段的完整结构化 Issue 正文就是 Agent Brief 和 Execution Contract，不再创建
第二份同义文档。`implement` 是实现入口，在预先确认的测试 seam 上按需使用仓库级 `tdd`，完成
验证后使用仓库级 `code-review` 做 Standards 与 Spec 双轴评审，再提交代码。仓库不记录或校验
Skill 调用轨迹；受保护路径、CI、Review thread、CODEOWNER Approve、人工验证和分支保护继续从
外层校验交付结果与安全边界。

## 3. 权威依据

开发工作按以下顺序确定依据：

1. 产品行为以 [Agent 平台 M1 PRD](../prd/PRD-agent-platform-M1.md) 和
   [Connection M1 PRD](../prd/PRD-connection-M1.md) 为准。
2. 运行架构和模块边界以
   [M1 工程架构 Spec](SPEC-agent-infra-M1-engineering-architecture.md) 为准。
3. 开发流转、Agent 权限和自动化边界以本文为准。
4. 已确认的 Issue、ADR 和接口契约只能细化上级文档，不能隐式修改上级结论。
5. `AGENTS.md` 和 Skills 提供执行方法，不是产品、架构或工作流状态事实源。

发现冲突、缺少稳定 AC ID 或无法确定验收结果时，Agent 停止实现并将 Issue 转入
`needs-triage`，不能自行选择有利于继续执行的解释。

## 4. 参与方与权限

### 4.1 身份与职责矩阵

| 参与方 | 可信身份 | 可以执行 | 禁止执行 |
| --- | --- | --- | --- |
| Repository human | GitHub User 及仓库权限 | 创建/编辑/关闭/重开 Issue、选择本地实现、提交 PR、移除标签以暂停执行 | 非 Team 成员不能创建/恢复 Worker 授权或确认验证 |
| CODEOWNERS Team 成员 | Organization Team 中的非 Bot 人员 | 确认 Issue、创建/暂停/恢复/终止 cycle、关闭/重开 triage、Approve、确认人工验证、创建受限基础设施 waiver | 以 Bot 身份替代人工确认、复用已消费 cycle、旧 head 确认或 waiver |
| 本地 Codex | 当前操作者的 GitHub 身份 | 需求 grilling、本地 `implement`、提交人工 PR、协助操作者执行授权动作 | 独立获得人工权限、把本地辅助描述为无人值守授权、绕过 Review |
| authorization recorder | 受策略限制的 GitHub Actions App | 校验 labeled event/Team/hash，记录授权、暂停、恢复、消费和失效 | 生成原始人工意图、替人授权、修改 execution content |
| Codex implement job | 只读 GitHub Token 和隔离工作区 | 读取授权范围、生成受限文本 Patch、AC evidence、implementation blocker proposal 或 human handoff | 获得发布凭证、调用任意 GitHub 写 API、Approve、Merge、创建授权 |
| trusted Publisher | 受策略限制的 GitHub 写身份 | 校验 Artifact、维护 Worker branch/PR、添加 `ready-for-human`、创建未授权 blocker、登记 human handoff、写审计记录 | 扩大模型输出权限、创建 `ready-for-agent`、移除 `ready-for-human`、Approve、直接 Merge |
| Claude | 只读模型步骤及隔离 Publisher | Review Issue/PR、发布 findings、建议人工验证 | 修改代码或标签、创建授权、Approve、Merge、解决自己的阻塞线程 |
| Reconciler | 受策略限制的 GitHub Actions App | 重算派生状态、补偿漏事件、唤醒有效 frontier、写幂等 triage 记录 | 创建或续期授权、确认人工验证、改变产品范围、直接 Merge |
| Check publisher | 选定仓库的专用 GitHub App | 为精确 head 创建/完成门禁 Check Run，记录派生状态 | 读取 Team membership、提交 human Approve、把旧 head 结果复制到新 head、修改 branch protection |
| Auto-merge enrollment | 专用组织身份 | 为合格的同仓库非 Draft PR 启用 GitHub 原生 Squash Auto-merge | 自定义 Merge、管理员绕过、重复实现门禁判断 |
| GitHub 分支保护 | GitHub 托管控制面 | 强制 required checks、CODEOWNER Approve 和 conversation resolution | 接受不绑定当前 head 的外部成功状态 |

### 4.2 配置前置

以下是目标流程的配置前置，不代表当前仓库已经具备：

- Organization Team `@AgoraIO-Extensions/agent-infra-owners` 至少包含两名成员，仓库
  `CODEOWNERS` 指向该 Team。Approve、Worker 授权和人工验证都使用实时 Team
  membership，不维护个人 allowlist。
- 选定仓库的控制 App `agora-agent-infra-team-membership` 具有 Organization
  `members:read` 和仓库 `checks:write`。可信 workflow 分别 mint membership-only token 与
  check-only token；任何单个 token 都不能同时获得两种能力，模型步骤不能获得任一 token。
- `main` 分支保护将 `CI` 绑定 GitHub Actions App `15368`，将四个自定义 Gate 绑定控制
  App `4503079`，不接受同名但来源不明的 Check Run 或 legacy status。
- 开发流程企微机器人使用轮换后的 GitHub Actions Secret `WECOM_BOT_WEBHOOK_URL`。该通知
  通道与产品 PRD 中的企微 Channel 无关。

Team 查询、Check Run 发布或配置读取失败时一律 fail closed。网络 allowlist 和模型配置版本
追踪不属于当前目标流程。

## 5. Issue 契约与授权周期

### 5.1 Issue 创建与 Claude Review

- Implementation Issue 必须包含唯一的 `Problem`、`Scope`、`Acceptance criteria`、`Validation`
  和 `Blocked by` 二级标题。
- 上述结构化正文就是 Agent Brief 和 Execution Contract。`Problem`、`Scope`、稳定 `AC-N` 与
  `Validation` 定义实现义务；`Blocked by` 只投影依赖，不扩大实现范围。
- 每条验收标准使用稳定且唯一的 `AC-N`；编辑顺序时不能复用旧 ID 表达不同要求。
- 上述契约必须在创建任务分支、修改文件或提交代码前明确。人工与 Agent 都不能用后补 Issue
  或占位 PR 追认已经开始的实现。
- 仓库成员创建 Issue 后，Claude 自动进行只读 advisory Review。外部用户创建的 Issue 只有在
  成员添加 `claude` 标签后才调用模型；Issue 中的 `@claude` 可以请求补充分析。
- Claude Issue Review 不修改文件、标签、授权、Issue 状态、branch 或 PR。模型成功结束但未
  发布最终评论时不能被记录为“Review 已完成”。
- 事件先由默认分支的可信步骤回读 actor association 或仓库权限。只有 `triage`、`write`、
  `maintain` 或 `admin` 权限可以触发成员 Review；查询失败时不执行模型步骤。

### 5.2 实现标签

| 标签 | 用于 Issue 时的含义 |
| --- | --- |
| `ready-for-agent` | Issue 已完整并适合 AFK Agent；不选择执行器，也不单独授予执行权限 |
| `ready-for-human` | 该 Issue 由人或本地受监督 Codex 实现，不进入 Worker 自动领取流程 |
| `needs-triage` | 契约、授权、依赖或执行状态需要人处理 |
| `wontfix` | 不再实施，并终止对应自动执行 |
| `claude` | 成员授权 Claude 分析外部用户创建的 Issue |

`ready-for-agent` 是 executor-neutral readiness。AFK 执行还需要 CODEOWNERS Team 中非 Bot 人员
通过受信入口发起一次明确 opt-in；该事件固定 Issue、execution content、操作者和执行方式。
Codex implement job、trusted Publisher、Claude、Reconciler 和其他 Bot 不能创建、续期或代理
该授权。仓库只有一个 AFK 执行方式时直接使用该固定入口，不增加 Dispatcher 或 Adapter 层。

在 `#224` 合并并关闭旧 Worker 的新 Issue intake 前，现有 `codex-worker.yml` 仍会把人工添加
`ready-for-agent` 的事件解释为旧 Worker 授权。因此迁移期内只能由 Team 成员在明确选择旧
Worker 时添加该标签；`#221` 不改变这条触发行为。由人监督的本地 Codex 使用
`ready-for-human`，不借用 AFK readiness。

### 5.3 Canonical execution-content hash

Worker 授权绑定 `execution-content-v1` SHA-256。可信步骤从 GitHub API 回读 Issue 当前标题和正文，
构造以下固定 JSON 字段：

1. `version`：固定值 `execution-content-v1`。
2. `title`。
3. `problem`：唯一 `## Problem` 的内容。
4. `scope`：唯一 `## Scope` 的内容。
5. `acceptance_criteria`：唯一 `## Acceptance criteria` 的内容。
6. `validation`：唯一 `## Validation` 的内容。

规范化只执行 Unicode NFC、CRLF 到 LF、删除行尾空白、删除各字段首尾空行，以及把 AC checkbox
的 `[x]`、`[X]` 归一为 `[ ]`。不折叠内部空行、不改写 Markdown 内容或 AC ID。

Preimage 是字段按上述顺序、使用 RFC 8259 escaping、无额外空白序列化的 JSON UTF-8 bytes；
不包含 BOM 或末尾换行。最终 hash 是这些 bytes 的 SHA-256 小写十六进制表示。Recorder、Worker、
Gate 和 Reconciler 必须复用同一实现和固定 fixture，不能各自重新解释 canonicalization。

`## Blocked by`、标签、评论、assignee 和 checkbox 完成状态不进入 hash。`Blocked by` 是由独立
DAG 规则保护的执行元数据，不能扩大 Problem、Scope、AC 或 Validation；checkbox 只表达进度，
不能改变已授权要求。缺失或重复受保护标题、重复 AC ID 或非法 AC 格式时不能计算有效 hash，
Issue 进入 `needs-triage`。

### 5.4 现有 Worker 授权记录与 cycle（迁移期）

本节记录 `#224` 关闭新 Issue intake 前的旧 Worker 兼容契约，不定义新的通用调度层。目标流程
使用 [§5.2](#52-实现标签) 的独立 opt-in；`#221` 与 `#222` 均保留以下运行时行为。

- 有效 `ready-for-agent` labeled timeline event 是人工授权事实。可信 recorder 校验 actor 的实时
  Team membership，并发布由 GitHub Actions App 创建的审计记录；记录至少包含 Issue、actor、
  timeline event、cycle、execution-content hash 和时间。Recorder 记录授权，不创造授权。
- 每个新的有效授权周期获得单调 `cycle`。Worker branch 使用
  `codex/issue-<number>-cycle-<cycle>`，每个 cycle 最多一个未合并 PR。
- 移除 `ready-for-agent` 会暂停未消费且 hash 未变化的 cycle，保留 branch 和 Draft PR。原授权
  人或其他 Team 成员重新添加标签时，可以显式恢复同一 cycle；execution content 已变化时旧
  cycle 永久失效，必须创建新 cycle、branch 和 PR。
- Issue 关闭或 Worker PR 合并会消费当前 cycle。已完成 Issue 重新打开后，即使遗留标签仍在，
  也不能恢复旧授权、旧 branch 或旧 PR；必须由 Team 成员创建新的有效授权。
- 对存量无审计记录的 `ready-for-agent` Issue fail closed，移除执行资格并进入 `needs-triage`，
  不能自动补写历史授权。

### 5.5 Blocker DAG

GitHub native issue dependencies 是依赖图的权威来源。依赖必须属于同一仓库，不能指向 PR、
自身或形成直接/间接环；查询失败、图超限或更新未原子收敛时 fail closed 并进入
`needs-triage`。`## Blocked by` 只保留为迁移期投影，接受 `None` 或一行一个唯一的
`- #<issue-number>`，不能独立创建、删除或改变依赖边。

Stage 4B 只从 native dependencies 构建 Execution Graph 和 `blockedByHash`。Publisher 先写 native
dependency，再记录 authorization transition，最后更新正文投影；Reconciler 只从可信 proposal
恢复缺失的 native edge，并把 native snapshot 投影到正文。正文缺失、过期或格式错误的 edge
不会创建、删除或覆盖 native dependency。

- Worker 的未完成结果必须显式且互斥地选择一种有界模式：`blocker_proposals` 表达可独立交付
  和验证的 implementation blocker，`human_handoffs` 表达权限、受保护路径、需求冲突、凭证或
  架构决策等需要人工处理的事项。两种列表混用或同时为空时 fail closed；trusted Publisher 不从
  任意 prose 猜测 vertical slice 或人工意图。
- 每个 blocker proposal 必须提供单一 `deliverable`，并满足 Implementation Issue 的固定章节、
  连续唯一 `AC-N` 和有界 validation 契约。trusted Publisher 校验后创建完整 Issue，再以确定性
  格式登记依赖边；该结果不得发布 partial Patch、branch 或 PR。
- 每个 human handoff 只包含唯一 `handoff_id`、有界 `reason` 枚举和 `required_action`。合法 reason
  仅包括 `permission_required`、`protected_path_change`、`requirements_conflict`、
  `credential_required` 和 `architecture_decision`。Publisher 不创建 Issue 或依赖边，只对来源
  Issue 幂等添加 `needs-triage` 和按 reason 映射的固定评论；评论不得插入模型 prose，也不得添加
  `ready-for-agent`、`ready-for-human` 或其他执行授权。
- 新 blocker 不带 `ready-for-agent`、`ready-for-human` 或等价授权。由受信 Publisher 身份创建
  的固定 marker comment 才能触发正常 advisory Claude Issue Review，其他 Bot mention 不得调用
  模型，Review 也不能授予执行权限。因为默认 `GITHUB_TOKEN` 创建的评论不会触发下游 workflow，
  Publisher 在 marker 落盘后发送固定 `repository_dispatch`；Review workflow 必须实时回读不可编辑
  的 App identity、marker 与一次性 acknowledgement，再把只读模型输出交给隔离 Publisher。
- Publisher 登记可信依赖边时同步追加当前 cycle 的 `frontier-updated` 授权审计；Reconciler 只能在
  旧 `blockedByHash` 与移除可信 proposal 后的前缀完全匹配时补写漏失记录，不能借修复扩大授权。
- 可信 proposal 以 `not_planned` 关闭或带有 `wontfix`、已删除对应 native dependency，且更高 cycle
  的有效 Team 授权精确绑定当前 execution content 与 `blockedByHash` 时，视为已由人工退役；
  Reconciler 不恢复该边，也不再因此给来源 Issue 添加 `needs-triage`。同 cycle 的漏边、未关闭
  proposal 或授权不匹配仍按 fail closed 处理。退役判定只使用 identity-audited proposal、GitHub
  API 当前状态与 append-only 授权记录，不读取 blocker prose 或普通评论。
- Publisher 或 Reconciler 使用 blocker 的 GitHub `issue_id` 写 native dependency，再更新正文
  投影。正文与 native dependency 不一致、查询失败或更新失败时进入 `needs-triage`；不得根据正文
  自动删除 native dependency。
- blocker 打开或重新打开时，所有 reverse dependents 立即不再是 frontier；正在执行的 dependent
  停止发布，已存在 branch/Draft PR 保留。
- blocker 以 `state_reason=completed` 关闭时，事件处理器重新计算所有 reverse dependents；仍
  具有有效 cycle 且成为 frontier 的 Issue 自动恢复。
- blocker 以 `state_reason=not_planned` 关闭或带有 `wontfix` 时，不解除 dependent 的执行阻塞，
  而是添加 `needs-triage` 并留下稳定原因。
- 每 15 分钟运行的 Reconciler 与事件处理器复用同一状态决策函数。相同状态签名重复执行不能
  重复创建 Issue、边、评论、标签变化、Worker run 或通知。Reconciler 必须先持久化状态 intent，
  再发送固定 `repository_dispatch`；Worker 以同一状态签名写一次 acknowledgement，缺少 ack 的
  intent 才能重试，重复或乱序 dispatch 不得再次进入模型步骤。

### 5.6 派生执行状态

| 状态 | 判定 | 自动动作 |
| --- | --- | --- |
| Human implementation | `ready-for-human` | Worker 不领取，等待人工 PR |
| Needs triage | `needs-triage`、契约非法、授权失效或依赖异常 | 停止模型和发布，通知责任人 |
| Authorized blocked | 有效 cycle，但存在未完成 blocker | 保留授权和可恢复草稿，不调用模型 |
| Frontier | 有效 cycle、无冲突标签、所有 blocker completed、无当前 Worker run 或活动 PR | 进入 Worker 队列 |
| Executing | 当前 cycle 有唯一活动 Worker run | 受 Issue/cycle 并发和全局模型并发限制 |
| Ready for review | 当前 cycle 有同仓库非 Draft PR | 不启动重复首次实现，只运行当前-head 门禁或 repair |
| Completed | primary PR 合并，Issue 以 completed 关闭 | 消费 cycle，唤醒 dependents |
| Not planned | Issue 以 not planned 关闭或带 `wontfix` | 终止 cycle，dependent 转 triage |

首次执行返回 `no-change` 时不创建空 commit/PR，也不关闭 Issue；系统记录稳定原因并进入
`needs-triage`。已有 Draft PR 的 `no-change` 可以幂等复用该 PR，不生成额外 branch 或 PR。

## 6. 现有 Codex Worker 执行（迁移期）

本节只约束 `#224` 前保留的旧 Worker，实现 #221 时不修改其 trigger、Publisher 或 repair 行为。
`#224` 完成真实 hosted smoke 后，固定 operator、人工 opt-in 的 gh-aw workflow 成为唯一 AFK
Issue-to-PR 路径，旧 Worker 停止领取新 Issue；仓库不为两者建设 Dispatcher 或 legacy Adapter。

### 6.1 执行方式与所有权

- 使用固定完整 commit SHA 的官方 [`openai/codex-action`](https://github.com/openai/codex-action)
  和仓库级 `implement` Skill。
- Actions 使用官方 Action 的非交互执行契约，不依赖 `/goal`、可恢复 session ID 或 Goal DB。
  当前固定 Action 内部使用 `codex exec`，但 workflow 只依赖经策略验证的 Action 输入，不依赖
  可漂移的内部命令行实现。
- `implement` 与 `publish` 在不同 Runner。模型 job 只有 `contents: read`，不保留 checkout
  凭证，不获得 GitHub 写 Token；Publisher 只接受固定 Artifact，不执行 Patch 引入的代码。
- 每个 Issue/cycle 使用唯一并发组、branch 和至多一个未合并 PR。全仓同时进入模型调用阶段的
  Worker 不超过 `2`；Publisher 和纯确定性检查不占模型 slot。
- Worker 首次实现只有在模型返回完整 completed 结果、实现与自检完成且 commit 已 push 后才
  创建 PR。Publisher 可以在代码 push 后短暂创建 Draft PR，以先添加必要标签，再立即转为
  Ready；该 Draft 不是实现入口。已有 PR 的 repair 流程继续复用同一 PR。

### 6.2 Model attempt 与 Patch checkpoint

- 单个 Worker run 最多包含三次 model attempt，即首次 attempt 加最多两次恢复 attempt。
- 后续 attempt 只从上一 attempt 生成且通过可信校验的文本 Patch checkpoint 和剩余 AC 状态
  继续；每次使用干净 Runner 和固定 base checkout。
- checkpoint 只包含有界文本 Patch、base SHA、Issue/cycle/attempt identity、AC 状态和错误分类。
  禁止持久化完整 `CODEX_HOME`、transcript、Goal/session DB、凭证、Git credential 或完整工作区。
- checkpoint 必须校验格式、大小、路径、base SHA、可应用性、受保护路径、binary、secret-like
  内容和身份绑定。校验失败属于不可重试错误，直接转 `needs-triage`。
- 完成结果必须包含完整合格 Patch 且 blocker/handoff 均为空。未完成结果必须输出空 Patch，且只
  能包含非空 blocker proposals 或非空 human handoffs；completed 与任一未完成模式并存、空的
  未完成结果或两种模式混用都属于不可重试的 Schema 失败。
- attempt 在模型调用前持久化并计数；模型已经开始后发生取消或 timeout 仍消费该 attempt。
  下一 attempt 只使用取消前已经持久化且验证成功的 checkpoint，partial/unvalidated Patch 丢弃。
- 容量不足、限流、网关 5xx、模型无完整结果、Runner/Action 基础设施错误或 timeout 属于可恢复
  中断；预算仍有剩余时从最后一个有效 checkpoint（没有时从固定 base）进入下一 attempt。
- Schema/身份/base 不匹配、受保护路径、binary、secret-like 内容、Patch 越界或不可应用属于
  不可重试错误，立即进入 `needs-triage`，不能让另一次模型调用绕过可信校验。
- 因移除授权标签、关闭 Issue、`wontfix` 或 cycle 失效而取消时，停止且不自动 triage；只保留
  取消前的有效 checkpoint。恢复同一 cycle 时继续使用剩余 attempt，不重置预算。
- 三次 attempt 后仍无完整合格结果时进入 `needs-triage`，发布 `attempts_exhausted` 终态并通知
  人工接管。所有成功、失败、取消、timeout 和 Runner 异常路径都必须释放全局模型 slot。

### 6.3 执行环境与 Secret 隔离

- 可信默认分支的 `.codex/config.toml` 定义 `github-worker` permission profile。官方 Action、
  Codex CLI、Artifact Action 和 checkout Action 都固定到完整 commit SHA 或明确版本。
- `CODEX_API_KEY` 只进入 implement job 中固定的官方 Codex Action；模型步骤之后只允许固定
  Artifact 上传，不运行仓库脚本或引入发布凭证。
- `CODEX_GITHUB_TOKEN` 只进入 Publisher 的固定 Git/PR 发布步骤，不进入 job 级环境、模型环境、
  remote URL、命令参数或 Artifact。
- `GH_TOKEN` 只进入 Auto-merge enrollment 的固定步骤。任何新的 Secret 必须在 workflow policy
  中按 workflow、job、step 和用途建立 allowlist，不能允许任意固定 SHA Action 使用。
- Issue/PR 内容只经 `env` 或固定输入文件进入程序，不能组成 `run:`、endpoint、模型、permission
  profile、branch 名、`run-name` 或命令。

### 6.4 Publisher 校验

Publisher 在获得写凭证前，从 GitHub API 重算 Issue、授权、DAG、branch、PR 和 base 状态，并
验证 Artifact：

- Issue/cycle 仍有效且属于当前 execution-content hash，目标 branch/PR 由该 cycle 独占。发布代码
  或 PR 前不存在未完成 blocker 或未关闭 triage；已经发布的 PR 处于 Ready for review 是预期
  状态，不按缺少 Frontier 资格拒绝 current-head gate 或已授权 repair。
- Patch 不超过固定上限，不含二进制、路径穿越、符号链接、gitlink/submodule、可执行位或其他
  文件模式变更。
- Patch 不修改 `.github/`、`.codex/`、`.claude/`、`.agents/skills/`、任意层级的 `AGENTS.md`
  或 `CLAUDE.md`、依赖/lockfile、Markdown policy 文件，以及 `docs/prd/`、`docs/architecture/`
  中的权威文档；这些信任边界只能由人创建的 PR 修改。
- Patch 能在干净工作区完整应用，checkpoint、结果 JSON、字段长度和枚举符合 Schema。
- Publisher preflight 将合法结果归一为 `publish`、`block` 或 `handoff` operation。`handoff` 只可
  使用当前 workflow 的 `github.token` 更新来源 Issue；模型发布 Token 不得进入该步骤，且该路径
  不能创建 branch、commit、PR、blocker Issue 或依赖边。

校验失败时不发布 commit 或 PR，只写固定的 triage 状态和脱敏原因。Publisher 可以添加
`ready-for-human`，不能因为模型输出 `ready_for_human=false` 而移除已存在标签。

### 6.5 Base 更新与暂停

- 默认分支前进时，系统只在能确定性干净更新 Worker branch 的情况下自动更新，并为新 head
  重新运行全部门禁；不 force push。
- 出现冲突时停止自动更新并进入 `needs-triage`，不能让模型猜测或自动解决控制面冲突。
- Issue 关闭、`wontfix`、授权失效或标签暂停会在每次远端写入前被重新检查。已进入 Ready for
  review 的 PR 不重复运行首次实现，只能进入明确授权的 repair 流程。

### 6.6 结果与 PR AC evidence

Worker 结果 Schema 要求根级 `blocker_proposals` 与 `human_handoffs` 始终存在，并对来源 Issue 的
每个 `AC-N` 恰好输出一项：

- `id`：与 Issue 中的稳定 AC ID 完全一致。
- `status`：只允许 `pass` 或 `not_applicable`；`not_applicable` 必须说明为何不需要实现。
- `evidence`：非空、可回读的测试、文件、Check、真实环境结果或限制说明。

缺项、重复项、未知 ID、非法状态或空 evidence 都使发布失败。trusted Publisher 把经校验的结构
渲染到 PR 正文的 `## 验收标准`；PR body 是 Gate 的长期回读来源，临时 Artifact 不是
Gate 的唯一事实源。

## 7. PR 检查与 Review

### 7.1 确定性 CI

PR 首先运行仓库定义的格式、静态检查、测试、构建和 workflow policy。所有结果绑定精确 PR
head SHA。Runner、Action、网关或第三方服务故障属于基础设施失败，不能触发代码修改。

同一 head 的首次 CI failure 只执行一次 no-code retry。只有相同失败在 retry 后仍能确定性复现，
才可以触发 Codex repair；通过 retry 的 flake 不消费 repair round。

### 7.2 Current-head Check Runs

`CI` 由 GitHub Actions App 发布；branch protection 要求的三个自定义 Gate 由 check-only
控制 App token 发布。
所有 Check Run 都绑定精确 head SHA、由 branch protection 锁定来源：

| Check | 适用范围 | 校验内容 |
| --- | --- | --- |
| `CI` | 所有 PR | 确定性仓库检查 |
| `Issue Gate` | 所有 PR | 恰好一个 open primary Issue，不带 `wontfix`，且 Issue `created_at` 严格早于 PR `created_at` |
| `Issue Readiness Gate` | Worker PR；人工 PR 返回 `not_applicable` | cycle、hash、branch/PR 所有权、blocker/triage 状态和 AC evidence |
| `Human Validation Gate` | 所有 PR | 当前 head 的必要人工验证是否完成 |

head 更新后，旧 head 的 Check Run、CODEOWNER Approve、人工验证和确认记录都
不能让新 head 通过。Gate 未创建、pending、运行中、失败、取消或输出未发布时都不能合并。

Worker PR 有活动 PR 时处于 Ready for review，而不是 Frontier；`Issue Readiness Gate` 直接重算
cycle、hash、blocker、triage 和所有权，不能要求该 Issue 同时处于互斥的 Frontier 派生状态。
未关闭的 `needs-triage` 会阻塞 Gate；确定性原因消失后，由 CODEOWNERS Team 成员或只处理系统
派生状态的 Reconciler 记录关闭，不自动消费仍有效的 cycle，也不重置 attempt 或 repair 预算。

### 7.3 Automated PR Review

- repository admin 通过 `PR_REVIEW_PROVIDER` 选择唯一 Automated Reviewer。值为 `claude` 时
  运行 Claude；变量未设置或为其他值时默认运行 PR-Agent。`CLAUDE_REVIEW_ENABLED` 和
  `PR_AGENT_ENABLED` 不再参与选择。
- 每个适用的 PR 只运行选定 Reviewer；较新的 head 取消同一 PR 的 stale run。Claude 在确定性
  CI 成功后启动，PR-Agent 在适用的 PR head 事件上启动。
- 需要阻塞合并的问题必须发布为 Review thread，并通过 GitHub required conversation resolution
  闭环；Review 摘要不阻塞合并。
- Review Coverage Shadow 以 shadow 模式发布 provider-aware 的 `Automated Review Coverage` Check。它只接受所选
  Reviewer 的可信 current-head evidence：PR-Agent 使用当前 workflow run 中 `PR-Agent Analysis` job
  的确定性 token decision log，Claude 复用 dedicated App `Claude Review Gate` 的验证结果。Check 对
  完整覆盖返回 `complete`；token 裁剪、输出缺失或无效、旧 head、provider mismatch、运行失败或
  取消分别返回稳定 reason code。shadow Check 尚不属于 required checks，不改变 merge authority；
  Review Coverage Enforcement 经 hosted smoke 和 branch-protection readback 后才把同一 contract 提升为
  required Gate。
- PR-Agent 的 `config.custom_model_max_tokens` 与 `config.max_model_tokens` 使用同一受控配置，避免
  默认 32k 全局 cap 覆盖部署已批准的模型 context 上限；提高上限不能替代 coverage 判定。不得为
  适配 token budget blanket ignore 生成 Client、OpenAPI、JSON Schema、Fake、测试或其他可评审文本。
- PR-Agent Suggestions 保持多 chunk 的局部 finding 工具，不是 cross-file Review coverage authority；
  Suggestions 成功不能把不完整的 Analysis evidence 改为完整。
- Claude 的结构化输出和可信 Publisher 校验只属于 Claude Adapter 的内部安全机制，不构成
  Automated Reviewer 的统一输出契约。
- 只有选中 Claude 时，其 P0/P1 finding 才能进入现有无人值守 code-repair；PR-Agent finding
  只通过 Review thread 进入正常处理流程，不触发结构化 repair。
- 现有 `Claude Review Gate` Check Run 和基础设施 waiver 仅作为 Claude Adapter 的过渡期
  operational signal，不属于 required checks 或 Automated Reviewer 统一契约。waiver 只接受
  CODEOWNERS Team 中非 Bot 成员对当前 head 的基础设施失败确认，不能覆盖未解决 Review thread、
  CI failure 或其他 Gate；新 commit 使其失效。
- Automated Reviewer 不 Approve、不 Merge、不修改 branch/label，也不解决自己的线程。

### 7.4 人工验证

自动化不能充分覆盖真实环境、视觉、权限或外部系统验证时，PR 必须带 `ready-for-human` 并在
PR 正文列出验证内容。

- Codex 可以添加 `ready-for-human`，不能移除；Claude 只能建议。
- 只有 CODEOWNERS Team 中的非 Bot 人员可以确认完成。可信记录绑定当前 head、actor、时间和
  验证说明；单纯由 Bot 或非成员移除标签不能通过 Gate。
- 新 commit 会使确认失效并自动恢复待验证状态。
- Approve 表示代码评审完成，人工验证表示外部验收完成，两者不能互相替代。

## 8. Repair 循环

- 每个 PR 最多两轮无人值守 code-repair；CI deterministic failure 和选中 Claude 时的 P0/P1
  finding 共享预算。
- 三类预算由可信系统分别持久化，模型不能自报或重置：model attempt 绑定
  `(Issue, cycle, Worker run, base SHA)`；no-code retry 绑定 `(PR, head SHA, failing check fingerprint)`；
  code-repair round 绑定 `(PR, authorization cycle)` 并跨 repair 产生的新 head 累计。
- 基础设施失败、CI flake、P2 finding 和普通评论不触发 code repair。
- 两轮后仍未通过、输出不完整或发生冲突时停止并进入 `needs-triage`，发送终态通知。
- CODEOWNERS Team 成员提交 `Request changes` 或明确使用 `@codex` 是新的人工 repair 授权，
  可以开始新的两轮预算。普通清除 `needs-triage` 不重置预算。
- 人创建的 PR 只有明确使用 `@codex` 才允许 Codex 修改；人直接 push 只重新运行当前-head CI
  和选定 Automated Reviewer。
- Ready for review Worker PR 的 repair 以当前 cycle 和本节授权为前提，不要求来源 Issue 重新
  成为只适用于首次实现排队的 Frontier。
- Codex 不能自行解决 Review thread；thread 由评论者或有权限的人确认处理后解决。

## 9. 合并与 post-merge

所有 PR 必须同时满足：

- 当前 head 的 `CI`、`Issue Gate`、`Issue Readiness Gate` 和 `Human Validation Gate` 通过。
- 至少一名符合 branch protection 的 CODEOWNER 提交 Approve。
- 所有 Review thread 已解决。

同仓库、目标为默认分支的非 Draft PR 自动幂等启用 GitHub 原生 Squash Auto-merge。自动化只
负责 enrollment，不重复判断门禁，不调用直接 Merge 或管理员绕过接口。人工关闭 PR 后，新增
commit 不自动重新启用已明确取消的 auto-merge。

合并后 `main` 检查失败时，系统关联最近合并 PR 和 primary Issue，必要时重新打开 Issue、添加
`needs-triage` 并记录 failing SHA/run。系统发送一次通知但不自动 revert；后续修复必须创建新的
人工授权 cycle，不能复活已消费授权。

## 10. 可观测性与企微通知

### 10.1 Actions 可追溯性

- 每个 workflow 定义顶层 `run-name`，只使用稳定的 Issue/PR 编号、固定操作、event action、
  source run ID 或 branch/reconcile 类型。
- Issue/PR 标题、正文、评论、commit message、模型输出和 Secret 不得进入 `run-name`。
- 每次运行的 Job Summary 提供可点击的 Issue/PR/source run、head SHA、event/action、cycle/attempt、
  terminal outcome 和下一步责任人。只有运行后才能确定的字段不伪装成启动时已知的名称。
- 成功、失败、取消、跳过和重放的运行都必须能从 Actions 列表与 Summary 识别目标和终态。

### 10.2 通知范围

企微只发送可行动或终态事件：

- 新 blocker 等待人工授权。
- blocker `not_planned`/`wontfix` 导致 dependent triage。
- blocker completed 后 dependent 恢复或关闭闭环。
- 当前 head 等待人工验证。
- Worker/repair 最终失败、预算耗尽或输出不完整。
- PR/Issue 完成。
- post-merge `main` failure。

started、queued、attempt 内部 retry、CI 首次 no-code retry 和最终成功前的中间状态不通知。同一
event ID 重放最多发送一次。通知只包含 repo、Issue/PR 编号、状态、稳定原因码和 URL，不包含
正文、diff、日志、prompt、transcript、模型输出或凭证。

每条企微通知最多尝试三次。Secret 未配置、timeout、限流、HTTP 错误或企微非零业务码只记录
脱敏 warning/summary，永远不能改变 Gate、Worker、Reconciler、Auto-merge 或 Issue 状态结果。

## 11. 安全边界

- GitHub Actions 默认使用只读 `GITHUB_TOKEN`，写权限按 job 和固定 step 明确声明。
- 第三方 Actions 固定到完整 commit SHA，不使用浮动 tag。
- `pull_request_target` 只读取默认分支可信代码和 PR 元数据，不 checkout 或执行 PR head。
- 模型分析 job 与持有 GitHub 写凭证的 Publisher 分离；Publisher 不执行模型 Patch 引入的代码。
- 模型输出必须经过 Schema、身份、head/cycle、路径和目标状态校验，不能直接组成任意 GitHub
  API 请求。
- Actions App、Bot 和非 Team 自动化身份不能满足 human Approve、Worker 授权或人工验证。
  GitHub timeline 不区分 Team 成员的网页操作与该成员 PAT；因此无人值守自动化不得持有
  Team 成员凭证，仓库把此类身份事件审计到对应成员。由该成员实时监督的本地 Codex 仍按
  [§5.2](#52-实现标签) 归责于当前操作者。
- Actions 不能修改 branch protection，也不能获取产品或生产凭证。
- Secrets 不写入日志、Summary、Artifact、Issue/PR、Review、测试 fixture 或模型结构化输出。
- 所有跨 actor、跨 Issue/PR、跨 cycle 和跨 branch 的访问都必须有 fail-closed 负向测试。

## 12. 分阶段实施

| Stage | 交付内容 | 配置前置 |
| --- | --- | --- |
| Stage 1 | Issue/PR 模板、基础 Gate、Claude Issue/PR Review、原生 Auto-merge enrollment | 现有 branch protection |
| Stage 2 | 初版 Codex Worker、Artifact/Publisher 隔离、固定 branch、代码 push 后短暂 Draft PR、受保护路径 | Codex 与 Publisher Secret |
| Stage 3A（`#50`） | 本文目标契约、稳定 AC ID、模板与导航同步 | 无外部配置 |
| Stage 3B（`#51`） | App-bound current-head gates、Automated PR Review provider selection、CODEOWNERS Team | Team、CODEOWNERS、branch protection |
| Review Coverage Shadow（`#242`） | provider-aware Automated Review Coverage shadow Check、PR-Agent 有效 context cap | Stage 3B |
| Review Coverage Enforcement（`#243`） | Automated Review Coverage required Gate 与 hosted merge-authority smoke | Review Coverage Shadow |
| Stage 3C（`#52`） | authorization record、cycle branch、execution hash、Issue Readiness/AC evidence | Stage 3B Team identity |
| Stage 3D（`#53`） | blocker proposal、同仓库 DAG、completed/not planned 语义、15 分钟 Reconciler | Stage 3C cycle |
| Stage 3E（`#54`） | 三次 attempt、Patch checkpoint、全局并发 2、CI retry、两轮 repair、base update | Stage 3C cycle |
| Stage 3F（`#55`） | terminal outcome、Actions 可追溯性、企微、post-merge triage | 轮换后的企微 Secret |
| Stage 4A（`#221`） | 对齐 Matt Skill 快照、provenance 与仓库文档契约，不改变运行时 | 无外部配置 |
| Stage 4B（`#222`） | native issue dependencies 成为运行时权威，正文降为迁移投影 | Stage 4A |
| Stage 4C（`#224`） | gh-aw 固定 operator 人工 opt-in 成为唯一 AFK 路径，旧 Worker 停止领取新 Issue | Stage 4B、现有 BYOK 配置 |

每个 Stage 独立通过 PR 评审和真实 GitHub 冒烟。前置 Stage 未合并并稳定运行时，不启用依赖它
的无人值守行为。Stage 3D 和 3E 在依赖图上都只依赖 3C，但因修改同一 Worker 控制面，实施时
优先顺序交付以降低冲突。

## 13. 验收标准

- 新成员 Issue 自动收到最终 Claude 建议；外部用户 Issue 只有成员授权后调用模型。
- `ready-for-agent` 不能单独触发目标 AFK 路径；只有 Team 人员对匹配 execution content 的明确
  opt-in 才能执行。Stage 4C 前的旧 Worker 继续受迁移期 cycle 契约约束。
- GitHub native issue dependencies 是依赖权威；正文 `Blocked by` 只作为迁移投影。
- implementation blocker 是同仓库 DAG；human handoff 只 triage 来源 Issue，不创建伪 blocker；
  blocker completed 唤醒有效 dependent，not planned/wontfix 转人工 triage。
- 同一 Issue/cycle 不产生并发执行或多个活动 PR，全仓模型调用并发不超过 `2`。
- Worker run 最多三次 model attempt；CI 首次失败只 no-code retry；PR 最多两轮 code repair。
- 每个 PR 只有一个创建时间严格早于 PR 的 open primary Issue，并对每个稳定 `AC-N` 提供唯一
  `status/evidence`；等时、晚建或时间缺失时 Issue Gate fail closed。
- 每个 required Check Run 和人工验证都绑定当前 head；旧 SHA 不能满足新 head 门禁。
- 每个适用的 PR 只触发由 `PR_REVIEW_PROVIDER` 选定的 Automated Reviewer；未设置时使用 PR-Agent。
- 所选 Reviewer 的 current-head coverage evidence 产生可审计 shadow Check；裁剪、缺失、旧 head、
  无效输出、provider mismatch、失败或取消不能显示为完整覆盖，且 shadow 阶段不改变 required checks。
- 需要人工验证的 PR 在 Team 人员完成当前-head 确认前不能合并；Approve 与验证互不替代。
- 所有门禁通过后只由 GitHub 原生 Squash Auto-merge 合并；AI 不能 Approve、直接 Merge 或绕过。
- 失败、取消、跳过和异常中断都有可回读 terminal outcome；企微失败永远不阻塞 GitHub 流程。
- Actions 列表能从 `run-name` 识别目标 Issue/PR，Job Summary 能追溯 source run、head、cycle 和
  attempt，且不暴露不可信正文或 Secret。
- post-merge failure 重新进入 triage 并通知，但不自动 revert 或复活旧授权。
- 新增或修改 `pull_request_target`、App Check Run、Team 授权或 Secret 路径后，必须使用合入后
  的默认分支和后续测试对象完成真实 GitHub 冒烟，不能由实现 PR 自证写权限行为。
