---
name: gen-goal-with-roadmap
description: "从实时 Roadmap 生成一个范围固定的 coordinator Goal。"
---

# 从 Roadmap 生成 Goal

本 Skill 只生成文本。它读取 GitHub 和 Git 状态，输出候选调用或一条可直接使用的
coordinator Goal；不创建 Goal、不修改外部状态、不改变 Git，也不发送企微。

全文固定使用四个术语：

- **snapshot**：生成 Goal 时冻结的 Issue 集合。
- **lane**：一个 primary Issue、worktree、branch、subagent 和 PR 的所有权链。
- **approval-ready**：当前 PR head 的全部 Review thread 已处理，required CI 与自动 Review
  均成功，没有 blocking review decision，只差人工 Approve。
- **terminal proof**：当前回读已经把每条 lane 归入 Delivered 或 Human-retired。

## 1. 读取实时事实

完整读取仓库的 [Agent 规则](../../../AGENTS.md)、[Issue tracker 约定](../../../docs/agents/issue-tracker.md)
和 [AI 主导开发工作流 Spec](../../../docs/architecture/SPEC-ai-native-development-workflow.md)，
从当前 checkout 推断 GitHub 仓库。

只读收集：

- default branch 与远端当前 head；
- open Wayfinder Map 及 sub-issue 层级；
- native Issue dependencies、state reason、labels、assignees 和 Milestone；
- linked/open PR 的 head、Review 与 checks；
- Project Status、Start date、Target date 和 parent/Map 归属；
- 本地/远端 branch 与 linked worktree；
- 当前环境能够可靠关联到 Issue 的执行所有权。

按 Issue tracker 约定解析裸 `#<number>`，再判断它是 Map 还是 implementation Issue。权威信息
不可用或互相矛盾时，返回有界拒绝，不猜测结论。

完成标准：所有选择事实都来自本轮回读，且 Skill 没有产生外部或 Git mutation。

## 2. 选择 Snapshot

### 无 Issue 参数

从 open Map 中构造 implementation Issue 候选。合格 Issue 必须具备仓库要求的 Problem、Scope、
Acceptance criteria、Validation 和 Blocked by 契约。排除 planning、grilling、research、外部资源
准备、closed、not-planned、malformed、blocked、cross-Map、重复或已有可观察执行的工作。

Discovery 优先未分配任务。已分配给当前操作者的 Issue 只有在不存在 active PR、branch、
worktree 或可靠关联的执行时才可入选；其他 assignee 表示已有所有权。父级或 sibling worktree
本身不占用候选 Issue；只有其 Issue scope 或当前 diff 与候选 deliverable 的文件/module ownership
重叠时才排除，并展示证据。环境无法把跨会话 Goal 可靠关联到 Issue 时，明确披露该残余风险，
不宣称不存在重复 Goal。

按以下顺序确定性排序：

1. 本次会话中用户最近一次明确引用的 Map；没有明确引用时跳过；
2. 已逾期或临近的 Milestone；
3. 该候选完成后全部 blockers 都满足、因而新进入 frontier 的下游 Issue 数；
4. 外部人工依赖风险；
5. Target date；
6. Issue number。

最多展示三个候选。每个候选包含 Map、lane Issues、推荐原因、完成形态、主要风险，以及完整的
后续调用，例如：

```text
$gen-goal-with-roadmap #144 #351 #344
```

随后停止。用户需再次显式调用本 Skill；单独回复 `A`、`1` 或标题不会延续 user-invoked Skill。

完成标准：展示零到三个已验证候选；每个候选都有完整后续调用；不输出 Goal 指令，不改变状态。

### 有 Issue 参数

接受一种输入：一个 Map、若干 implementation Issues，或一个 Map 加其 descendant Issues。

- 只有 Map：snapshot 包含该 Map 下当前全部合格 frontier Issues。
- 只有 Issues：所有引用均合格时，snapshot 精确包含这些 Issues。
- Map 加 Issues：所有引用均为合格 descendant 时，snapshot 精确包含这些 Issues。

多个 Map、cross-Map 归属、未收敛 planning ticket 或空结果均拒绝。显式 Issue 集合原子验证：
任何一个引用不合格或存在冲突，整次调用拒绝，不过滤该 Issue 后继续。path 或 branch 能识别 Issue
的 linked worktree 始终表示该 Issue 已被占用，直到 worktree 被清理；clean 或 idle 不是释放信号。

保留 native serial dependencies，只有互相独立的 Issues 才形成并行 lane。冻结最终 Issue numbers；
新发现或新解锁的工作属于下一次调用。

完成标准：得到一个非空、完全分类的 snapshot；每条 lane 只有一个 primary Issue 且没有可观察的
冲突 owner；状态保持不变。

## 3. 输出一个 Coordinator Goal

只输出一条可直接使用的 Goal 指令，并写入本轮回读得到的 repository、Map、snapshot Issues、
remote base head、ownership、Project 和 validation 事实。Goal 必须包含以下契约。

### Objective 与 Ownership

- 只完成 frozen snapshot。
- 每条 lane 保持一个 primary Issue、worktree、branch、subagent 和 PR。
- Root coordinator 独占 DAG 复核、共享集成、Project 写入、WeCom 通知和 terminal proof。
- 使用当前可用 subagent slots 并行互不重叠的 lanes；多余 lane 留在同一固定队列，slot 释放后复用。
- 为每个 worker 明确文件或 module ownership，并说明需要保留其他并行工作。
- 文件或 module ownership 有重叠的 lanes 在同一 Goal 内串行。

### Start Gate 与 Roadmap

编辑前重新读取全部 snapshot Issues、dependencies、assignees、active PRs、branches、worktrees、
Project items 和 default-branch head。变化或冲突的 lane 进入人工干预，不静默删除或替换。

每条可执行 lane 在实现前由 coordinator：

1. 确保 Issue 与相关 ancestors 已进入 Project；
2. 把 selected item 与受影响的 open capability parent/Map 设为 `In Progress`；
3. 写入实际 Start；
4. 缺少 Milestone 或 Target 时从最近的 scheduled capability parent 继承，同时保留已有人工预测；
5. 回读全部有效字段。

Open Target 是人工预测，Start 是实际开始。Delivered 或 Human-retired 时，把 lane Project Status
设为 `Done`，Target 设为实际终止时间。Parent/Map Start 使用有可靠证据的最早 descendant start；
历史时间不可证且现有 Start 仍在未来时，使用当前 Goal 的实际开始，不编造更早历史，也不因此
阻塞 lane。全部 required descendants 终止后，从事实重新计算 ancestor Status，并把 Target 设为
最晚实际终止时间；仍有工作或 retirement 改变依赖路线时保持 ancestor 非终态。每次写入后回读。

### Scope Control

Snapshot 始终固定。只完成现有 Issue contract 内的工作。正确实现需要新 Issue、需求、权限、凭证
或 protected decision 时，暂停对应 lane 并请求人工干预；新解锁工作留给下一次生成。

### Review 与 Approve

每条 lane 执行仓库 validation 和 current-head Review。处理全部 actionable Review threads，并重跑
受影响验证，之后才判断 approval-ready。

单个 PR 达到 approval-ready 后，使用 `$wecom` 通知用户本地私有 alias `me`。先 resolve-only；
每个 `PR + head SHA` 只发送一次，内容包含 Map、Issue、PR、head、已通过 gates 和 Approve 请求，
不包含凭证或源码正文。head 更新后必须重新达到 approval-ready 才能再次通知。其他 lanes 继续。

人工 Approve 是 verified wait。按约 30 秒、60 秒、2 分钟、5 分钟逐步降低轮询频率；审批等待
保持 Goal active，不计入 blocked 条件。

### 人工干预

只有 coordinator 无法在当前 scope 与 authority 内继续时才使用 `$wecom`：requirements conflict、
缺少 permission/credential、必须新增 Issue、repair budget 耗尽、Project 回读持续失败或明确拒绝
Approve。

按 `Goal + stable reason` 去重。通知包含受影响的 Map/Issue/PR/head、稳定原因、已尝试恢复和所需
决定。暂停该 lane，其他独立 lanes 继续。其他 lanes 结束后，同一真实人工 blocker 连续三个
Goal turns 无变化时，将 Goal 标为 blocked 并记录精确恢复条件；人工处理后恢复同一个 Goal。

### Terminal Proof

Snapshot 中每条 lane 必须精确归入一种终态：

- **Delivered**：primary PR 已合并；Issue 以 completed 关闭；合并前 PR-head gates 与 Review
  evidence 已验证；exact merge SHA 的 post-merge CI 成功；按仓库规则委派并验证 merged-PR Git
  cleanup；Project terminal fields 已回读。
- **Human-retired**：用户在当前对话或 durable GitHub state 中明确退役；Issue 为 not-planned 或
  wontfix；结果 dependency state 与 Project terminal fields 已回读。

Agent 不能从失败、无活动或缺少 approval 推断 Human-retired。Terminal proof 覆盖完整 snapshot 后
才能完成 Goal。最终报告分别列出 Delivered 与 Human-retired lanes 及其当前证据。

完成标准：响应只包含一条 Goal 指令；完整覆盖 snapshot、lane ownership、start gate、Roadmap、
scope control、approval-ready、verified waits、人工干预和 terminal proof；不包含 secrets、个人
userid、普通会话正文或无关 Issue prose；生成过程没有外部或 Git mutation。
