# 开发 Harness

开发 worktree 的 source 必须是本次运行前刚刚回读的 `origin/main` exact commit。仓库内的
`dev-preflight` 是开发 source provenance 和验证计划的唯一入口；通用 skill 只能作为说明，不能
覆盖本仓库的门禁。

## 创建 worktree

```bash
node scripts/dev-preflight.mjs worktree /absolute/path/to/worktree fix/3472-example
```

命令会按顺序 fetch `origin/main`、捕获 immutable SHA、从该 SHA 创建 branch/worktree，并回读
worktree `HEAD`。任一步失败都不能进入实现阶段。命令输出的 JSON 是本次 lane 的 provenance
receipt，应和 Issue、branch、PR 一起保存；它不包含凭证或工作区正文。

原生 worktree 工具创建后，必须立即执行：

```bash
node scripts/dev-preflight.mjs verify /absolute/path/to/worktree <source-sha>
```

没有这个回读结果，不能声称 worktree 基于最新 main。

## 验证计划

```bash
node scripts/dev-preflight.mjs plan
```

输出包含 `sourceSha`、`required` 和 `skipped`。`skipped` 每项必须带 reason；跳过不是通过，
receipt 只表示选择结果。命令复用仓库已有检查，不删除安全、类型、测试、构建或部署门禁。

## 适用性

本仓库采用人工监督的本地 Agent 开发。外部要求后台 implementer/merger subagent、无人值守
修复或自动合并的通用 skill 不适用于本仓库，除非负责人另行确认并更新本仓库 workflow Spec。

Auto-merge Enrollment 会回读 PR 的 GraphQL review threads；任何未解决 thread 都会阻止登记，
如果已有 auto-merge request 则先取消它。review 或 review-comment 事件会重新执行检查。这个
日志判断不能替代 GitHub branch protection 的 required conversation resolution。
