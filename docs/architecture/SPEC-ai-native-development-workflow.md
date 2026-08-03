# agent-infra AI 主导开发工作流 Spec

## 1. 文档目的

本文定义 agent-infra 的开发流转、AI Agent 分工、人工检查点和自动化边界。它适用于产品、
架构、代码、测试、迁移和 CI 变更，不改变 Agent 平台 M1 的产品范围或运行时架构。

本文同时描述目标流程和分阶段实施顺序。只有已经合并到默认分支并完成验证的自动化能力，
才视为仓库当前能力。

## 2. 基本原则

- 所有开发工作从 GitHub Issue 开始，并通过一个主要 Issue、一个实现 PR 完成追踪。
- AI 负责需求梳理、实现、自检和独立评审；人负责确认需求、必要的真实测试和最终批准。
- GitHub Issue、PR、Check、Review 和分支保护是流程状态的权威来源。
- 确定性检查优先于模型判断。AI 不能覆盖 CI、人工批准或分支保护结果。
- 自动化失败必须停止或转人工处理，不能无限重试。
- 所有人和 AI 创建的 PR 使用相同的合并门禁。
- 当前不建设独立的 Loop Engine、Graph Engine 或通用开发调度平台。

## 3. 权威依据

开发工作按以下顺序确定依据：

1. 产品行为以 [Agent 平台 M1 PRD](../prd/PRD-agent-platform-M1.md) 和
   [Connection M1 PRD](../prd/PRD-connection-M1.md) 为准。
2. 运行架构和模块边界以
   [M1 工程架构 Spec](SPEC-agent-infra-M1-engineering-architecture.md) 为准。
3. 开发流转和自动化边界以本文为准。
4. 已确认的 Issue、ADR 和接口契约只能细化上级文档，不能隐式修改上级结论。
5. `AGENTS.md` 和 Skills 提供执行方法，不是产品或架构事实源。

发现冲突或验收标准无法确定时，AI 停止实现并在 Issue 中说明需要确认的内容。

## 4. 参与方与职责

### 4.1 人

- 创建或确认 Issue 的目标、范围和验收标准。
- 在本地 Codex 梳理完成后，决定 Issue 是否进入自动实现。
- 评审设计、代码和 AI findings。
- 执行不能由自动化测试充分覆盖的真实环境验证。
- 提交至少一个符合分支保护要求的 Approve。

### 4.2 本地 Codex

- 使用项目 Skills 对 Issue 进行 triage、追问、形成 Agent Brief、Spec 和 tickets。
- 在人确认后，使用当前操作者的 GitHub 身份为 Issue 添加 `ready-for-agent`。
- 不在无人监督的 GitHub Actions 中执行需求 grilling。

### 4.3 GitHub Actions 中的 Codex

- 领取符合条件的 `ready-for-agent` Issue。
- 在独立分支完成实现、自检和 Draft PR 更新。
- 按授权触发修复，不批准或绕过自己的 PR。
- 通过结构化输出向可信发布 job 提供变更摘要和验证结果。

### 4.4 Claude

- 自动给新 Issue 提供需求完整性建议。
- 在确定性 CI 通过后独立 Review PR。
- 可以报告问题和建议人工验证，不能 Approve、Merge、修改代码或直接改变流程标签。

### 4.5 确定性系统

- CI 执行格式、静态检查、测试、构建和工作流策略检查。
- Issue Gate 校验 PR 与来源 Issue 的关系和状态。
- Human Validation Gate 校验是否仍有待完成的人工验证。
- GitHub 分支保护校验 Approve、required checks 和评论解决状态。

## 5. Issue 流程

### 5.1 Issue 创建与 Claude Review

- 仓库成员创建 Issue 后，Claude 自动进行一次只读 Review 并评论建议。
- 外部用户创建的 Issue 不自动调用模型；仓库成员添加 `claude` 标签后才触发 Review。
- Issue 中的 `@claude` 可以请求补充分析。
- Claude Issue Review 只提供建议，不改变 Issue 状态，也不是进入实现的门禁。
- Issue 事件先由默认分支中的可信步骤判断成员身份或 `claude` 标签授权；只有授权通过的
  模型步骤才能读取 Claude Secret。外部 Issue 内容不能参与授权判断或组成可执行命令。
- 新建 Issue 事件未提供可信成员关系时，可信步骤通过 GitHub API 回读作者对仓库的权限。
  只有 `triage`、`write`、`maintain` 或 `admin` 权限可以触发自动 Review；公开仓库默认的
  `read` 权限不属于可信成员。查询失败时不执行模型步骤。查询使用的 GitHub Token 只进入
  可信步骤，且请求目标和授权判断不受 Issue 内容控制。

### 5.2 本地需求梳理

需求梳理由成员在本地 Codex 中完成。优先复用
[mattpocock/skills](https://github.com/mattpocock/skills/tree/2ab958093e83e0ec752e6c1c5932da465bf23e0c)
commit `2ab958093e83e0ec752e6c1c5932da465bf23e0c` 中适用的 `triage`、`grilling`、
Agent Brief、`to-spec` 和 `to-tickets` 能力，不重复建设同类流程。

进入实现前，Issue 至少要明确：

- 要解决的问题和不在范围内的内容。
- 可观察的验收标准。
- 已知依赖和阻塞关系。
- 预期验证方式。

### 5.3 实现标签

| 标签 | 用于 Issue 时的含义 |
| --- | --- |
| `ready-for-agent` | 需求已由人确认，可以由 Codex 自动实现 |
| `ready-for-human` | 该 Issue 由人实现，不进入 Codex 自动领取流程 |
| `needs-triage` | 需要重新梳理需求或处理状态 |
| `wontfix` | 不再实施，并终止对应的自动执行 |
| `claude` | 由成员授权 Claude 分析外部用户创建的 Issue |

`ready-for-agent` 只能由人或由人监督的本地 Codex 添加。无人值守的 GitHub Actions 不能
自行添加该标签。

### 5.4 可执行 Issue

Codex 只领取同时满足以下条件的 Issue：

- Issue 处于打开状态并带有 `ready-for-agent`。
- 不带 `ready-for-human` 或 `wontfix`。
- 所有明确声明的 blocker 已关闭。
- 当前不存在该 Issue 的其他活动执行、活动分支或活动 Draft PR。

满足这些条件的 Issue 称为 frontier Issue。多个互不阻塞的 frontier Issue 可以并行执行。

## 6. Codex 实现流程

### 6.1 执行方式

- 使用官方 [`openai/codex-action`](https://github.com/openai/codex-action)。
- 直接调用项目级 `implement` Skill，不额外包装一套重复的实现方法。
- 每个 Issue 同一时间只有一个活动 branch、一个 Actions run 和一个 Draft PR。
- Codex 开始工作后立即创建或复用该 Issue 的 Draft PR。
- 实现和自检完成后，Codex 更新 PR 内容并将 Draft PR 标记为 Ready for review。

移除 `ready-for-agent` 会取消当前运行，但保留 branch 和 Draft PR。重新添加后继续使用原 PR。
Issue 被关闭或添加 `wontfix` 后，自动关闭未合并的 Draft PR。PR 未合并而被关闭后，来源
Issue 进入 `needs-triage`。

### 6.2 执行环境与权限

- Codex 使用 workspace sandbox、`drop-sudo` 和不受 allowlist 限制的出站网络。
- 模型只获得完成实现所需的代码工作区和工具，不获得用于发布 GitHub 变更的 PAT。
- 模型/API Secret 和 fine-grained GitHub PAT 分开配置。
- Codex Action 是模型 job 的最后一步；commit、push、PR 和标签写入由新的可信 job 完成。
- 可信发布 job 只接受经过 Schema 校验的结构化输出，并使用固定的 GitHub 操作。
- 当前不处理来自外部 fork 的 PR。

### 6.3 PR 内容

可信发布 job 生成固定结构的 PR 正文，至少包含：

- `Closes #<primary-issue>`。
- 变更摘要。
- 验收标准完成情况。
- 已执行测试。
- 是否需要人工验证及验证内容。
- 未执行检查、风险和限制。

每个 PR 必须且只能声明一个 primary Issue。可以引用其他 Issue 作为上下文，但不能再使用
会自动关闭 Issue 的关键字。

## 7. PR 检查与 Claude Review

### 7.1 确定性 CI

PR 首先运行仓库定义的确定性 CI。Claude 只 Review 当前 head 上 CI 已通过的 PR。Runner、
Action 或网关基础设施失败时，不触发 Codex 修改代码。

### 7.2 Issue Gate

Issue Gate 是 required check，并在每个 PR head 上校验：

- PR 只关联一个 primary Issue。
- primary Issue 存在、仍处于打开状态且不带 `wontfix`。
- Codex 创建的 PR 对应的 Issue 仍带有 `ready-for-agent`。

校验失败时阻止合并，不由模型解释或覆盖。

### 7.3 Claude PR Review

- 使用官方
  [`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action)。
- API Key 通过 Actions Secret 配置；Base URL 和模型通过仓库配置传入。
- 自动 Review 只在确定性 CI 通过后执行，也可以由 `claude` 标签或 `@claude` 触发。
- Claude 把 PR 内容、评论、diff 和外部文本视为不可信数据，只进行只读分析。
- `P0`、`P1` findings 创建阻塞性的 Review 线程；`P2` 只进入 Review 摘要。
- `Claude Review` 是 required check。模型调用、输出校验或发布失败时，Check 失败。
- Claude 不提交 Approve、不 Merge、不修改分支，也不自行解决 Review 线程。

`P0` 表示可能造成越权、凭证泄露、数据损坏或大范围不可用的问题；`P1` 表示会导致错误
行为、兼容性破坏或关键测试失真的问题；`P2` 表示影响较小但证据明确的问题。

## 8. 修复循环

- Codex 创建的 PR 出现确定性 CI 失败或 Claude `P0`、`P1` finding 时，可以在原 PR 自动
  修复。
- 每个 PR 最多执行两轮无人值守修复，CI 和 Claude 触发的修复共同计数。
- 两轮后仍未通过时停止自动修复，由人决定下一步。
- 人提交 `Request changes` 或明确使用 `@codex` 时，视为新的人工授权并重置两轮预算。
- Codex 创建的 PR 收到人的 `Request changes` 后自动触发 Codex。
- 人创建的 PR 只有明确使用 `@codex` 才允许 Codex 修改。
- 人直接 push 的修复只重新运行 CI 和 Claude，不自动触发 Codex。
- Codex 不能自行解决 Review 线程；线程由评论者或有权限的人确认处理后解决。

## 9. 人工验证

AI 根据验收标准判断自动化 UT、集成测试或 smoke 是否已经充分覆盖。不能充分覆盖时，PR
必须添加 `ready-for-human` 标签，并在 PR 正文中列出验证内容。

| 标签 | 用于 PR 时的含义 |
| --- | --- |
| `ready-for-human` | 仍有必要的人工验证未完成 |

- Codex 可以添加该标签，不能移除。
- Claude 可以建议添加，不能直接修改标签。
- 只有人完成验证后可以移除该标签。
- 对已经要求人工验证的 PR，出现新 commit 后必须自动重新添加该标签。
- Approve 表示代码评审完成；移除 `ready-for-human` 表示人工验证完成，两者不能互相替代。

Human Validation Gate 是 required check。标签存在时失败，标签不存在时通过。手工移除标签
是允许的人工确认方式，但不会跳过 CI、Claude Review、Approve 或其他分支保护规则。

## 10. 合并规则

所有 PR，不区分由人还是 AI 创建，必须同时满足：

- Issue Gate 通过。
- 当前 head 的确定性 CI 通过。
- 当前 head 的 Claude Review 通过。
- Human Validation Gate 通过。
- 至少一名符合分支保护要求的人提交 Approve。
- 所有阻塞性的 Review 线程已解决。

满足门禁后使用 GitHub 原生 Squash Auto-merge。仓库不实现自定义 Merge job，AI 不能批准
自己的 PR，也不能绕过 required checks 或分支保护。

`main` 分支保护必须将 `Docs CI`、`Issue Gate`、`Claude Review`、
`Human Validation Gate`、至少一名人工 Approve 和评论解决同时设为合并门禁。Auto-merge
自动化只负责为 PR 启用 GitHub 原生 Squash Auto-merge，不重复判断或替代这些门禁。

Auto-merge enrollment 使用独立的 `pull_request_target` workflow，并只处理打开、重新打开或
转为 Ready 的 PR。PR 必须处于打开、非 Draft 状态，目标为默认分支，且 head 属于当前仓库；
PR 作者可以是人、AI 或 Bot。workflow 只 checkout 默认分支，不读取或执行 PR head。已经
启用 auto-merge 时按成功处理；人手工关闭后，后续 commit 不会自动重新启用。Squash 标题和
提交信息沿用仓库默认配置。

## 11. 安全边界

- GitHub Actions 默认使用只读 `GITHUB_TOKEN`，写权限按 job 明确声明。
- 第三方 Actions 固定到完整 commit SHA，不使用浮动 tag。
- `pull_request_target` 只用于默认分支中的元数据门禁，不 checkout 或执行 PR 内容。
- Auto-merge enrollment 使用单独的 PR 级并发组，只获得启用原生 auto-merge 所需的
  `contents: write` 和 `pull-requests: write`，不能调用直接合并或管理员绕过接口。
- required Claude PR Review 的模型分析 job 与持有 GitHub 写凭证的发布 job 分离。
- Issue 建议和 `@claude` 回复复用官方 Action 的评论机制，禁止模型使用文件写入和 Bash，
  只保留官方 Action 对当前评论的受控更新。
- 模型输出必须经过 Schema 和目标状态校验，不能直接组成任意 GitHub API 请求。
- Actions 不能提交 Approve，不能修改分支保护，也不能获取生产凭证。
- Secrets 不写入日志、评论、PR 正文、测试 fixture 或模型结构化输出。

## 12. 分阶段实施

### Stage 1：Issue 与 Review 基线

- 创建标准标签。
- 实现 Issue Gate 和 Human Validation Gate。
- 实现 Claude Issue Review 和 CI 后的 Claude PR Review。
- 将确定性 CI、Issue Gate、Claude Review、Human Validation Gate 和评论解决设为合并门禁。
- 启用 GitHub 原生 Squash Auto-merge enrollment，不新增自定义 Merge 实现。

### Stage 2：Codex Worker

- 以 `ready-for-agent` 驱动 Codex Worker。
- 实现 frontier Issue 选择、单活动执行、Draft PR 和暂停恢复。
- 接入项目级 `implement` Skill。
- 使用结构化输出和可信发布 job 维护 branch、PR 正文与标签。

### Stage 3：修复循环

- 实现 CI 和 Claude finding 驱动的两轮自动修复。
- 实现人工重新授权、失败停止和 Issue/PR 状态回写。

每个 Stage 独立通过 PR 评审和真实 GitHub 冒烟验证。只有前一阶段在默认分支稳定运行后，
才启用下一阶段。

## 13. 验收标准

- 新的成员 Issue 自动收到 Claude 建议；外部用户 Issue 只有成员添加 `claude` 后调用模型。
- 未经人确认的 Issue 不能被无人值守流程标记为 `ready-for-agent`。
- Codex 只领取无未关闭 blocker 的 frontier Issue，同一 Issue 不产生并发执行或多个活动 PR。
- 每个 PR 只有一个有效且打开的 primary Issue，关系异常时 Issue Gate 阻止合并。
- Claude 只 Review CI 通过的当前 PR head，`P0`、`P1` 阻塞合并，`P2` 不阻塞。
- 需要人工验证的 PR 在标签被人移除前不能合并；新增 commit 后标签重新出现。
- 人工 Approve 和人工验证是两个独立门禁，任何标签操作都不能跳过 required checks。
- 无人值守修复最多两轮；人工重新授权后才能开始新的两轮。
- Codex、Claude 和发布 job 均不能 Approve、绕过门禁或直接修改分支保护。
- 同仓库、非 Draft、目标为默认分支的 PR 可以启用原生 Squash Auto-merge；人工关闭后，
  新增 commit 不会自动重新启用。
- 所有门禁通过后，GitHub 原生 Squash Auto-merge 完成合并，并正常触发默认分支 CI。
- 新增或修改 `pull_request_target` workflow 后，使用合入后的默认分支和后续 PR 完成真实
  冒烟验证，不能用实现 PR 自证其写权限行为。
