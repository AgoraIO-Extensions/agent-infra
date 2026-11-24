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

需要从 Roadmap 或 Map 选择一组可执行 frontier 时，可显式调用仓库级
[`gen-goal-with-roadmap`](../../.agents/skills/gen-goal-with-roadmap/SKILL.md)。该 Skill 只读发现并冻结
snapshot，生成一个 Coordinator Goal；它不创建 Goal、不修改 Issue/Project、不启动执行，也不绑定个人通知流程。
生成的 snapshot 可交给本地协调执行入口继续处理，GitHub Issue、依赖、PR、CI 和 Project 仍是事实源。
已授权范围的多 writer 分派、交接与恢复可使用
[`coordinate-development`](../../.agents/skills/coordinate-development/SKILL.md)，本地记录不替代权威状态或人工门禁。

## 3. 需求与文档依据

产品范围以 PRD 为准，实现边界以工程 Spec 为准，开发流程以本文为准。Issue、ADR 和本地
Skills 只能细化这些约束。发现需求冲突或验收不明确时，先与负责人确认。

## 4. 身份与配置

- `CODEOWNERS` 使用 `@AgoraIO-Extensions/agent-infra-owners`；人工 Approve 和需要的外部验收
  由 Team 中非 Bot 人员完成。
- Issue Gate 直接使用 GitHub Actions 原生 job 结果，不调用 Check Run 写接口。
- required checks 为 `CI` 与 `Issue Gate`，最终均绑定 GitHub Actions App `15368`。保留 CODEOWNER
  approval、旧批准失效、last-push approval 和 conversation resolution。
- 移除旧 `Issue Readiness Gate`、`Human Validation Gate` 与 Coverage required context；迁移期间
  保留 `CI` 与 `Issue Gate` 的 App 绑定，并用后续 PR 验证，不能伪造旧检查成功。
- 删除无人值守开发和旧 Reviewer 专用 Secret、Variable、workflow 与运行配置。PR-Agent
  凭证及普通 CI/Auto-merge 的必要凭证保留。

## 5. Issue 契约

### 5.1 Issue 创建与确认

Implementation Issue 包含唯一的 `Problem`、`Scope`、`Acceptance criteria`、`Validation` 和
`Blocked by` 二级标题。验收标准使用唯一且稳定的 `AC-N`，写清可观察结果和验证方式。
负责人确认内容后再实现。

### 5.2 实现标签

标签定义见 [Triage Labels](../agents/triage-labels.md)。`ready-for-agent` 表示任务已清晰且适合
本地 Agent 协助；它不触发任何自动执行。`ready-for-human` 用于标记需人工处理或验证的任务。
标签、Issue 编辑和依赖完成均不会自动创建 branch/PR 或修复代码。

### 5.3 Issue 认领与交接

Issue 的当前认领会话默认取正文 provenance 块中的 `Agent-Session-ID`。没有 provenance 块的
Issue 初始认领为空；第一条有效交接评论必须使用 `Handoff-From: none`。之后按评论创建时间顺序
应用有效交接，当前认领只有一个会话。会话 ID 逐字比较，不做前缀、大小写或其他归一化。

交接评论必须包含且只能包含一个以下机器可读块，块外写当前状态、在途 PR 和下一步：

```text
<!-- agent-claim:start -->
Claimed-By-Session: <新会话 ID>
Handoff-From: <当前认领会话 ID 或 none>
<!-- agent-claim:end -->
```

交接只有在评论作者获准，评论没有被编辑（`updated_at` 等于 `created_at`），块格式合法且
`Handoff-From` 等于当时认领时才生效。作者获准是指 GitHub API 返回的 `author_association`
为 `OWNER`、`MEMBER` 或 `COLLABORATOR`，或评论与原 Issue 的作者均为 `User` 且 API 返回的
不可变用户 ID 逐值相同；后一种核对不依赖 Actions token 对私有组织成员身份的可见性。
只比较 API 的实际作者身份，不采信评论正文、用户名相似性或自报来源；缺失、非法 ID、Bot 或
其他作者不能凭 `CONTRIBUTOR` / `NONE` 取得交接权。读取身份或评论失败时 fail closed。
无效评论不改变认领；认领会话需要并行拆成 GitHub sub-issue。会话 ID 仅作追踪标识，不得包含
凭证或会话正文。

### 5.4 依赖

GitHub native issue dependencies 是依赖权威，正文 `Blocked by` 作为投影。负责人和本地 Agent
维护依赖，确认前置任务完成后再开始实现；不再运行后台依赖图协调器或恢复授权。

## 6. 本地实现与验证

使用隔离工作区，遵守产品 PRD、工程 Spec、目录权限和任务范围。开发 worktree 必须由
[开发 Harness](../agents/development-harness.md) 在 fetch `origin/main` 后按 immutable SHA 创建，
或由原生 worktree 工具创建后立即用同一 SHA 回读；没有 provenance receipt 不能开始实现。
验证通过 `node scripts/dev-preflight.mjs plan` 选择 required checks，并记录 source SHA、
required、skipped 和 reason；跳过不等于通过。开发、重试和修复由人或其监督的本地 Agent 执行，
GitHub 不自动生成 Patch、维护 checkpoint 或推送修复。

本仓库不适用要求后台 implementer/merger subagent、无人值守修复或自动合并的通用开发 skill。
任何例外必须先更新本 Spec 并取得负责人确认；skill 的默认行为不能改变本仓库的人工监督和
Issue → 实现与验证 → PR 流程。

## 7. Pull Request

### 7.1 PR 内容

PR 正文包含唯一的主 Issue 引用：完整交付并可关闭时使用 `Closes #<primary issue>`；仅交付部分能力、
仍待外部验收时使用 `Refs #<primary issue>`，合并不关闭 Issue。两种写法均通过相同的 Issue Gate，
说明问题、最终改动、AC evidence、验证结果和必要的人工验证。primary Issue 必须在 PR 之前创建；
Issue 可以在 PR 创建前后处于 open 或 closed，
只要它仍是有效的非 `wontfix` Issue。一个 Issue 可以由多个 PR 交付，后续 PR 继续引用同一 primary
Issue。文档和普通代码 PR 使用同一规则。

### 7.2 基础 Gate

| 原生 job / required check | 条件 |
| --- | --- |
| `CI` | 确定性构建、静态检查和测试通过，或按 §7.2.1 明确豁免 |
| `Issue Gate` | 唯一主 Issue 存在、非 wontfix，创建时间早于 PR；带 `agent:*` 标签的 PR 还必须使正文 provenance 的 `Agent-Session-ID` 与主 Issue 当前认领会话逐字一致 |

`ready-for-human` 仅作为需要人工处理或验证的 label，不生成 required check，也不阻塞合并。

Issue Gate 在 PR 的 opened、reopened、synchronize、edited 和 ready_for_review 事件运行；CI
按自身 workflow 事件运行。

Issue Gate 的认领检查读取主 Issue 评论的全部分页；交接评论读取失败时 fail closed。认领不一致时
失败描述说明当前会话和交接方法，并按固定类别计数被忽略的认领评论，不输出评论正文或用户名。
没有 `agent:*` 标签的人工 PR 跳过认领检查。
取消 Issue 事件派发、定时巡检和额外汇总 job。检查读取实时 PR，若已不是触发时的 head 则失败，
不把旧事件的结果当成新 head 的验证。

#### 7.2.1 CI 豁免

具有 PR 标签管理权限的维护者可添加 `ci:skip`，豁免该 PR 的 `CI` workflow 中的仓库检查与
Workload kind。标签使用 GitHub 原生权限管理；AI 不得自行添加豁免标签。被豁免的检查 job 以原生
`skipped` 结束；`CI` 汇总 job 仅报告已豁免并满足 required check，不作为测试通过的证据。

新提交触发 CI 时回读当前标签。添加或移除 `ci:skip` 由独立的 `CI waiver` workflow 处理：它以
`pull_request_target` 运行默认分支代码，不 checkout 或执行 PR head，只对同仓 PR 生效；先取消当前
head 正在执行的 CI，再重跑该 head 最近一次 CI。重跑时 `Check CI exemption` 回读实时标签，因此重跑
旧运行也不能复用已撤销的标签。当前 head 尚无 CI 运行时不处理，由即将开始的运行自行回读。
移除 `ci:skip` 后恢复正常检查，标签保留期间的新提交继续豁免；只操作当前 head 的运行。
读取失败时运行原有 CI，不能因此豁免。main push、独立 Connection E2E、Issue Gate、
CODEOWNER approval、conversation resolution 与 PR review 不受该标签影响。

其他标签的增删不触发 CI workflow。已观察到：标签事件产生的新 CI 运行若不含 `CI` 检查，会让同一
head 上已通过的 `CI` 不再被计入，PR 停在 BLOCKED；重跑旧运行也不能恢复，只有更新的真实运行可以
（#3935）。因此 CI 只订阅 `opened`、`synchronize`、`reopened` 与 main push，汇总 job 固定名为
`CI` 并总是执行，以报告豁免或失败的 lane。`CI waiver` 对其他标签直接结束，不取消、不重跑 CI，
也不发布任何检查。

#### CI runner 选择

同仓 PR 默认使用 GitHub 托管 runner。维护者添加或移除 `ci:self-hosted` 时，
系统对当前 head 的 CI 和 Secret scan 重新调度，并读取实时标签。Fork PR 使用托管 runner。
`ci:skip` 独立控制 CI 豁免。main push 在每次运行时读取仓库变量 `MAIN_CI_RUNNER`，
取值 `self-hosted` 时普通任务进入 ECI，Docker 和 kind 任务使用 GitHub 托管 runner。
`github-hosted` 或未设置时使用托管 runner。机池标签的映射由共享 runner 选择工作流维护。

### 7.3 Automated PR Review

- PR-Agent 按[官方 GitHub Action 用法](https://docs.pr-agent.ai/installation/github/#run-as-a-github-action)
  直接读取 PR 并发布 `/review` 和 `/improve` 评论，关闭 `/describe`。配置全部保留在 workflow
  YAML 中，使用固定 digest 的官方 Action 镜像，不修改上游 runtime。
- 同仓、非 Bot、open 且非 Draft PR 在 `opened`、`reopened`、`ready_for_review` 自动运行。
  仓库 OWNER、MEMBER 或 COLLABORATOR 可以在 open PR 下发送准确的 `/review` 或 `/improve`
  评论请求重跑；其他命令、参数和 Bot 评论不触发。连续 push 不自动重跑模型。
- 官方 Action 通过 API 获取 PR，不 checkout 或执行 PR 代码，不加载 PR 的配置文件或 wiki
  配置。保留既有模型、API Secret、超时与 context 上限，写权限只用于原生评论和 Review。
- PR-Agent 不维护自定义 Analysis/Publisher、primary Issue 输入、增量 scope、receipt、Coverage、
  recorder/shadow、代理或派生镜像。原生 token 裁剪、文件过滤、分块、空结果与失败提示均由
  上游负责；评论存在不代表完整覆盖，也不保证每种超限情况都能发布“请拆分 PR”。
- PR-Agent 是辅助评审，不提供 required Coverage Check。移除分支保护中的
  `Automated Review Coverage` required context，不把失败改写为成功；CI、Issue Gate、
  CODEOWNER approval 和 required conversation resolution 保持原样。
- PR-Agent 不 Approve、不 Merge、不修改 branch/label，也不解决自己的线程。PR-Agent
  原生评论由人工处理，不接入自定义 repair 或 Workflow Outcome 通知。
- 迁移时移除旧 required context 并回读剩余 Check 的 App 绑定。工作流替换合入后，用默认分支
  重新启用 `pr-agent-review.yml`，再使用后续测试 PR 核验自动 Review/Suggestions 和两个评论命令。实现 PR 的静态检查不替代
  hosted 发布证据。

### 7.4 人工处理标记

自动化不能覆盖真实环境、视觉、权限或外部系统验收时，在 PR 正文写清内容并添加
`ready-for-human`。该标签只保留人工处理或验证的可见标记，不触发 workflow，不产生 required
check，也不会因添加、移除或新 commit 阻塞合并。人工测试记录与代码 Approve 各自完成，不能
互相替代。

## 8. 失败处理

CI 或评审失败时由负责人、本地 Agent 查看原生日志和评论，修复后重新提交或重跑。
不通过后台 Worker 自动重试、修复、创建 blocker、发布派生终态 Check 或发送专用终态通知。
合入后发现问题由负责人创建或重开 Issue，决定修复或回退，不自动改动 Issue 生命周期。

## 9. 合并

当前 head 的两个 required checks 满足（CI 可按 §7.2.1 豁免）、符合 CODEOWNER 批准要求且所有
讨论解决后，才允许合并。同仓库、目标为默认分支的非 Draft PR 保留 GitHub 原生 Squash Auto-merge enrollment；
它只登记 auto-merge，不直接 Merge、不绕过门禁，也不替人 Approve。登记前 Harness 通过 GraphQL
回读当前 PR 的 review threads；存在任何未解决 thread 时不登记，并在 review/review-comment 事件
后重新判断；已有 auto-merge request 会先取消。最终合并仍以 GitHub 的 required conversation
resolution 为准。

GitHub 以 `clean` 或 `unstable` 状态拒绝登记时，结果仅表示本次未登记。后续受支持的事件会重新判断。
若重新判断后仍未登记，有合并权限的维护者须确认当前 head 与已评审的提交一致，并独立核实本节要求的
全部合并门禁，包括 required checks、CODEOWNER 批准和 conversation resolution。确认后可按常规流程
执行 Squash，例如 `gh pr merge --squash --match-head-commit <已评审的完整 head SHA>`。
合并仍受 GitHub 分支保护约束。

## 10. 安全与验证

- `pull_request_target` 使用默认分支可信代码，不 checkout 或执行 PR head。
- GitHub 对 public 仓库默认阻断 `pull_request_target`。本仓库用仓库级 Actions 事件策略，只为
  `pr-gates.yml`、`auto-merge.yml`、`ci-waiver.yml` 和 `pr-agent-review.yml` 显式允许
  `pull_request_target`、`pull_request_review`、`pull_request_review_comment` 与 `issue_comment`。
  新增、改名或删除使用这些事件的 workflow 时，同步更新该策略，并用 hosted 运行验证。
- Actions 固定完整 commit SHA，Docker Action 固定 image digest；凭证只传给必要步骤。
- Secret 不写入日志、Summary、评论或 Artifact；产品和生产凭证不进入开发自动化。
- 修改 workflow、凭证或 required-check 来源后，必须在默认分支生效后验证真实 GitHub 行为。
  本地 fixture 与实现 PR 的静态检查不能替代 hosted 验证。

### 10.1 ACK 镜像缓存部署

独立的 `ack-image-cache.yml` 只消费本仓成功的正式 `Publish images` 运行的同 attempt
发布回执，校验不可变镜像引用、架构和 source 后输出缓存计划 artifact。执行代码固定为受保护
默认分支，不执行发布输入所指向的历史代码。计划 job 不取得云身份、Kubernetes 凭据或
registry 拉取凭据，其成功只表示计划生成成功。workflow 不执行缓存创建或退休，不取得集群
kubeconfig、Secret get 权限或 registry 凭据；`kubectl -o jsonpath` 是客户端输出过滤，不能作为
Secret 未离开集群的证明。

受控 ACK 运维机使用既有 kubeconfig 和 Kubernetes RBAC 消费计划，通过 ImageCache CR
创建/复用缓存并等待 Ready；私有 registry 凭据只引用集群内既有 imagePullSecret。写入前由该
运维入口核验 namespace 与 registry Secret 的类型、身份及删除状态，不向 GitHub 传递 Secret。
退休必须显式确认，规则与权限见 [ACK 镜像缓存](../../deploy/ack/IMAGE-CACHE.md#退休旧缓存)。已批准的
Custom 最终镜像与 init 容器组合由原部署入口生成有界不可变计划，不经 GitHub 传递生产材料。
部署入口每次启用镜像前核对冻结发布的 source、架构与不可变 digest，并按精确镜像组在部署回执中
报告 ECI ImageCache 与 ECS 适用节点的覆盖情况，包括未覆盖的消费者与镜像组、缓存 ID、Ready
及到期状态；缓存覆盖的来源不可确认或证据缺失须明确记录，不能用 Pod Ready 或截断库存代替覆盖证据。
未启用严格 ECI 缓存准入时，缓存未完成、失败、过期或覆盖不全不阻止启用新镜像，也不使部署
或验收失败；冷拉如实记录。source/digest 校验不放宽，来源不符或错 digest 仍拒绝采用或判验收失败。
启用严格准入时，仍须按[工程 Spec 的 ECI 缓存准入约束](SPEC-agent-infra-M1-engineering-architecture.md#101-workload-形态)
实时核对精确完整镜像集合、缓存 ID、Ready 与到期时间；缓存未就绪或失效不启用新镜像，
保持 `Never` 且不能回退冷拉，既有 Pod 不受创建准入策略影响。GitHub 发布后尚未执行部署预热时，
不能宣称无人值守预热已完成。

缓存 Ready 不代表 Pod 实际使用缓存。部署后抽样按同 Pod UID 核对 Worker/Session 的期望镜像与
实际 imageID 一致，分别记录缓存 ID、命中证据或冷拉以及启动结果；缺失证据如实标未知，
错 digest 仍算失败。未启用严格准入时不以完全命中作为验收条件；严格准入的失败条件仍按工程 Spec。
缓存不是 Session reserve，不包含用户凭据、会话、PVC 或原生进程状态。

### 10.2 现场 AC 签收与版本回归

现场 AC 只能由非实现验收方在 ACK 生产新 lane（namespace/release 均为 `agent-infra`）验证并签收；
CI、单元测试、本地 Harness、kind 或 fixture 不能代替该现场 AC。
现场 AC 绑定包含所需修复的**具名正式发布版本及其已部署的 Helm revision**签收。验收前回读
正式发布回执和实际部署，确认修复包含关系，记录发布版本标识、不可变 source/image 引用、
目标环境与 Helm revision；逐 AC 关联适用的样本/Execution 标识和可回读证据。`origin/main` 的后续提交
不自动改变该签收目标，不用“最新 main”或“本轮 tuple”等浮动称谓替代固定版本与 revision。

之后的版本只做一次回归冒烟，不因升级重新执行已签收 AC 的整套矩阵。最小冒烟包含：

1. 在该部署通过正式业务验收入口新建 Session，完成一次执行并回读 `completed` 和结果；
   生产 Helm 仓库使用 `deploy.sh prod accept`。
2. 按该 Issue 已批准的场景、权限和样本约束，执行一条关键路径并保存可回读结果。

升级冒烟另记新发布版本、Helm revision、Session/Execution、关键路径和结果，保留原 AC 的
具名版本签收及证据，不把新版本冒烟改写为原矩阵重验。冒烟不代替尚未完成的 AC；失败时按
[失败处理](#8-失败处理)记录回归并安排修复或回退，不宣称该版本冒烟通过。
