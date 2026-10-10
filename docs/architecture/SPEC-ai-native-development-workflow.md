# agent-infra AI 主导开发工作流 Spec

## 1. 文档目的

本文定义本仓库的本地开发、评审、确定性 CI 和人工合并条件，不改变产品 Platform Worker、
Agent Runtime 或 Connection 的运行职责。

## 2. 基本原则

- 所有开发工作按 `Issue -> 实现与验证 -> PR` 执行。创建任务分支、修改文件或提交代码前，
  必须确认内容完整的 primary Issue；不得事后补建 Issue 或用占位 PR 追认实现。
- 人确认范围与授权，使用本地 Agent 实现、验证和评审。AI 不能代替人工 Approve 或绕过分支保护。
- 维护者可按 [§7.2.1](#721-ci-豁免) 使用 `ci:skip` 明确豁免单个 PR 的 CI；AI 不能自行豁免。
- GitHub Issues、PR、原生 Actions 结果和分支保护是交付事实来源。
- 仓库不运行无人值守开发 Agent；Codex Worker、gh-aw Issue-to-PR、自动 repair、授权周期、
  Blocker Reconciler 和 Workflow Outcome 通知/自动重开 Issue 链路均退役。
- 本地验证、受控 fixture 与真实外部验收分别记录；未执行、失败或跳过不能描述为完成。

## 3. 需求与文档依据

产品范围以 PRD 为准，实现边界以工程 Spec 为准，开发流程以本文为准。Issue、ADR 和本地
Skills 只能细化这些约束。发现需求冲突或验收不明确时，先与负责人确认。

## 4. 身份与配置

- `CODEOWNERS` 使用 `@AgoraIO-Extensions/agent-infra-owners`；人工 Approve 和需要的外部验收
  由 Team 中非 Bot 人员完成。
- Human Validation job 仅使用 membership-only App token 查询 Team；不再 mint Check Publisher
  token。两个基础 Gate 直接使用 GitHub Actions 原生 job 结果，不调用 Check Run 写接口。
- required checks 为 `CI`、`Issue Gate`、`Human Validation Gate`，最终均绑定 GitHub Actions
  App `15368`。保留 CODEOWNER approval、旧批准失效、last-push approval 和 conversation resolution。
- 移除旧 `Issue Readiness Gate` 与 Coverage required context。迁移期间两个基础 Gate 保留旧
  App 绑定；新 YAML 合入后切到 App `15368`，并用后续 PR 验证，不能伪造旧检查成功。
- 删除无人值守开发和旧 Reviewer 专用 Secret、Variable、workflow 与运行配置。PR-Agent
  凭证、Team membership App 凭证及普通 CI/Auto-merge 的必要凭证保留。

## 5. Issue 契约

### 5.1 Issue 创建与确认

Implementation Issue 包含唯一的 `Problem`、`Scope`、`Acceptance criteria`、`Validation` 和
`Blocked by` 二级标题。验收标准使用唯一且稳定的 `AC-N`，写清可观察结果和验证方式。
负责人确认内容后再实现。

### 5.2 实现标签

标签定义见 [Triage Labels](../agents/triage-labels.md)。`ready-for-agent` 表示任务已清晰且适合
本地 Agent 协助；它不触发任何自动执行。`ready-for-human` 用于标记需人工处理或验证的任务。
标签、Issue 编辑和依赖完成均不会自动创建 branch/PR 或修复代码。

### 5.3 依赖

GitHub native issue dependencies 是依赖权威，正文 `Blocked by` 作为投影。负责人和本地 Agent
维护依赖，确认前置任务完成后再开始实现；不再运行后台依赖图协调器或恢复授权。

## 6. 本地实现与验证

使用隔离工作区，遵守产品 PRD、工程 Spec、目录权限和任务范围。按 `AGENTS.md` 执行适用的
验证并记录结果；环境阻碍和未执行项明确列出。开发、重试和修复由人或其监督的本地 Agent
执行，GitHub 不自动生成 Patch、维护 checkpoint 或推送修复。

## 7. Pull Request

### 7.1 PR 内容

PR 正文包含唯一的 `Closes #<primary issue>`，说明问题、最终改动、AC evidence、验证结果和
必要的人工验证。primary Issue 必须在 PR 之前创建且仍为 open。文档和普通代码 PR 使用同一规则。

### 7.2 基础 Gate

| 原生 job / required check | 条件 |
| --- | --- |
| `CI` | 确定性构建、静态检查和测试通过，或按 §7.2.1 明确豁免 |
| `Issue Gate` | 唯一主 Issue 存在、open、非 wontfix，创建时间早于 PR |
| `Human Validation Gate` | 未要求人工验证，或当前提交的人工验证由有效 Team 成员确认 |

两个基础 Gate 在 PR 的 opened、reopened、synchronize、edited、labeled、unlabeled 和
ready_for_review 事件运行。取消 Issue 事件派发、定时巡检和额外汇总 job；关联 Issue 或 Team
成员状态单独变化后，必须重新运行 PR 检查。检查读取实时 PR，若已不是触发时的 head 则失败，
不把旧事件的结果当成新 head 的验证。

#### 7.2.1 CI 豁免

具有 PR 标签管理权限的维护者可添加 `ci:skip`，豁免该 PR 的 `CI` workflow 中的仓库检查与
Workload kind。标签使用 GitHub 原生权限管理；AI 不得自行添加豁免标签。检查以原生 `skipped`
结束并满足 required `CI`，运行摘要明确记录豁免，不作为测试通过的证据。

添加、移除标签及新提交都会重新运行 workflow，执行时回读当前标签；重跑旧事件也不能复用
已撤销的标签。CI 执行中添加标签会取消同一 PR、同一 head 的旧运行，再发布豁免结果。
移除 `ci:skip` 后恢复正常检查，标签保留期间的新提交继续豁免；旧 head 重跑不会取消新 head。
读取失败时运行原有 CI，不能因此豁免。main push、独立 Connection E2E、Issue Gate、
Human Validation Gate、CODEOWNER approval、conversation resolution 与 PR review 不受该标签影响。

### 7.3 Automated PR Review

- PR-Agent 按[官方 GitHub Action 用法](https://docs.pr-agent.ai/installation/github/#run-as-a-github-action)
  直接读取 PR 并发布 `/review` 和 `/improve` 评论，关闭 `/describe`。配置全部保留在 workflow
  YAML 中，使用固定 digest 的官方 Action 镜像，不修改上游 runtime。
- 同仓、非 Bot、open 且非 Draft PR 在 `opened`、`reopened`、`ready_for_review` 自动运行。
  仓库 OWNER、MEMBER 或 COLLABORATOR 可以在 open PR 下发送准确的 `/review` 或 `/improve`
  评论请求重跑；其他命令、参数和 Bot 评论不触发。连续 push 不自动重跑模型。
- 官方 Action 通过 API 获取 PR，不 checkout 或执行 PR 代码，不加载 PR 的配置文件或 wiki
  配置。保留既有模型、API Secret、超时与 context 上限，写权限只用于原生评论和 Review。
- 除 [已合并 Connection PR 的显式复评](#731-已合并-connection-pr-的显式复评) 外，
  PR-Agent 不维护自定义 Analysis/Publisher、primary Issue 输入、增量 scope、receipt、Coverage、
  recorder/shadow、代理或派生镜像。原生 token 裁剪、文件过滤、分块、空结果与失败提示均由
  上游负责；评论存在不代表完整覆盖，也不保证每种超限情况都能发布“请拆分 PR”。
- PR-Agent 是辅助评审，不提供 required Coverage Check。移除分支保护中的
  `Automated Review Coverage` required context，不把失败改写为成功；CI、两个基础 Gate、
  CODEOWNER approval 和 required conversation resolution 保持原样。
- PR-Agent 不 Approve、不 Merge、不修改 branch/label，也不解决自己的线程。PR-Agent
  原生评论由人工处理，不接入自定义 repair 或 Workflow Outcome 通知。
- 迁移时移除旧 required context 并回读剩余 Check 的 App 绑定。工作流替换合入后，用默认分支
  重新启用 `pr-agent-review.yml`，再使用后续测试 PR 核验自动 Review/Suggestions 和两个评论命令。实现 PR 的静态检查不替代
  hosted 发布证据。

#### 7.3.1 已合并 Connection PR 的显式复评

Connection 的 reviewed migration release 要求原 PR 当前 head 的真实 `review` Check。
对同仓库、目标 `connection` 的 merged PR，获授权非 Bot OWNER/MEMBER/COLLABORATOR 可用
准确 `/review` 请求复评；其他 closed PR、fork、其他命令或未经授权 caller 不进入此路径。
可信默认分支控制代码捕获 PR head，官方 Action 完成分析；只有新发布或更新的可信 Bot 原生
Review 输出标明该捕获 head、完整执行成功，且发布前 head 再次核对一致，才由无模型
Publisher 发布该 head 的 `review` Check。失败、跳过、缺少产出、旧 head 或 head 变化均不成功。
此 Check 只证明该次复评执行与 SHA 绑定，不声明 Coverage，不替代 CODEOWNER 或人工验收。

该路径是 §7.3 无自定义 Publisher 原则的受限例外，仅服务上述显式复评。不维护模型代理、
上游补丁、派生镜像或增量覆盖系统。分析步骤不取得 Checks 写权限、不 checkout 或执行 PR
代码；Publisher 无模型，只执行可信默认分支控制代码，保持凭证隔离。不改发布与迁移门禁，
也不将本地报告或历史结果改写为成功 Check。正式部署仍须通过当前代码 head 的 CI。

### 7.4 人工验证

自动化不能覆盖真实环境、视觉、权限或外部系统验收时，在 PR 正文写清内容并添加
`ready-for-human`。完成后由 Team 中非 Bot 人员移除标签，job 回读成员身份与事件。
Bot、非成员或查询失败不能确认验证。新的 commit 会使验证失效并重新要求人工确认。
从未要求人工验证的 PR 直接通过该 Gate。人工测试确认与代码 Approve 各自完成，不能互相替代。

## 8. 失败处理

CI 或评审失败时由负责人、本地 Agent 查看原生日志和评论，修复后重新提交或重跑。
不通过后台 Worker 自动重试、修复、创建 blocker、发布派生终态 Check 或发送专用终态通知。
合入后发现问题由负责人创建或重开 Issue，决定修复或回退，不自动改动 Issue 生命周期。

## 9. 合并

当前 head 的三个 required checks 满足（CI 可按 §7.2.1 豁免）、符合 CODEOWNER 批准要求且所有
讨论解决后，才允许合并。同仓库、目标为默认分支的非 Draft PR 保留 GitHub 原生 Squash Auto-merge enrollment；
它只登记 auto-merge，不直接 Merge、不绕过门禁，也不替人 Approve。

## 10. 安全与验证

- `pull_request_target` 使用默认分支可信代码，不 checkout 或执行 PR head。
- Actions 固定完整 commit SHA，Docker Action 固定 image digest；凭证只传给必要步骤。
- Secret 不写入日志、Summary、评论或 Artifact；产品和生产凭证不进入开发自动化。
- 修改 workflow、凭证或 required-check 来源后，必须在默认分支生效后验证真实 GitHub 行为。
  本地 fixture 与实现 PR 的静态检查不能替代 hosted 验证。
